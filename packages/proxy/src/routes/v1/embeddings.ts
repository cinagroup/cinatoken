/** OpenAI/OpenRouter-compatible embeddings ingress and model discovery. */
import {
	isEmbeddingModel,
	parseModelModalitiesJson,
	parsePricingProfile,
} from '@octafuse/core';
import { MAX_CALLABLE_EMBEDDING_MODELS } from '@octafuse/core/db/model-modalities';
import { toPublicModelSlug } from '@octafuse/core/lib/public-model-slug';
import { Hono } from 'hono';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import { parseMetadata, parseTags } from '../../lib/model-list-parse';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import type { RouteResult } from '../../services/model-router';
import { buildAffinityKey, buildTierKeyPrefix } from '../../services/route-strategies';
import { proxyEmbeddings, EMPTY_USAGE } from '../../services/proxy';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { RequestTimingCollector } from '../../services/request-timing';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { generationRequestLogContext } from '../../services/generation-request-context';
import { buildRouteRequestBody } from '../../services/route-default-params';
import {
	computeRequestLogStatus,
	formatHttpErrorTextForRequestLog,
	materializeNonOkResponse,
} from '../../services/request-log-record-status';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import {
	markUserModelSuccess,
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
} from '../../services/user-model-circuit-route';
import {
	runRequestGuardrails,
} from '../../services/request-guardrails';
import {
	estimateEmbeddingGuardrailBudgetMicros,
	estimateEmbeddingGatewayKeyByokBudgetMicros,
	estimateEmbeddingOrdinaryBudgetChargedCost,
} from '../../services/guardrail-budget-estimate';
import { createRouteAwareBudgetAdmission } from '../../services/request-budget-admission';
import {
	textUsageCostIsUnknown,
	textUsageWithSafetyTimeout,
} from '../../services/text-usage-settlement';
import { recordUsage } from '../../services/usage-tracker';
import { parseOpenRouterSessionHeader } from '../../services/openrouter-session-routing';
import { privateByokContextForApiKey } from '../../services/byok-key-pool';

const USAGE_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_EMBEDDING_INPUT_ITEMS = 2_048;
const MAX_MODEL_ID_LENGTH = 240;

type EmbeddingsEnv = Env & {
	Variables: { apiKey: import('../../middleware/auth').ApiKeyContext };
};

export const embeddingsRoutes = new Hono<EmbeddingsEnv>();
embeddingsRoutes.use('*', requireApiKey);
embeddingsRoutes.use('*', assignGenerationId);

export type EmbeddingInputShape = {
	count: number;
	kind: 'text' | 'text_batch' | 'tokens' | 'token_batch' | 'object_batch';
};

export type EmbeddingInputValidation =
	| { ok: true; value: EmbeddingInputShape }
	| { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function tokenId(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validate all documented OpenRouter input container variants without inspecting content. */
export function validateEmbeddingInput(input: unknown): EmbeddingInputValidation {
	if (nonEmptyText(input)) return { ok: true, value: { count: 1, kind: 'text' } };
	if (!Array.isArray(input) || input.length === 0 || input.length > MAX_EMBEDDING_INPUT_ITEMS) {
		return {
			ok: false,
			message: `input must be non-empty and contain at most ${MAX_EMBEDDING_INPUT_ITEMS} items`,
		};
	}
	if (input.every(tokenId)) {
		return { ok: true, value: { count: 1, kind: 'tokens' } };
	}
	if (input.every(nonEmptyText)) {
		return { ok: true, value: { count: input.length, kind: 'text_batch' } };
	}
	if (input.every((item) => Array.isArray(item) && item.length > 0 && item.every(tokenId))) {
		return { ok: true, value: { count: input.length, kind: 'token_batch' } };
	}
	if (input.every(isPlainObject)) {
		return { ok: true, value: { count: input.length, kind: 'object_batch' } };
	}
	return { ok: false, message: 'input contains mixed or unsupported embedding items' };
}

export function validateEmbeddingsBody(body: Record<string, unknown>):
	| { ok: true; modelId: string; input: EmbeddingInputShape }
	| { ok: false; code: typeof GatewayErrorCode.invalidRequest | typeof GatewayErrorCode.missingModel; message: string } {
	const modelId = typeof body.model === 'string' ? body.model.trim() : '';
	if (Object.prototype.hasOwnProperty.call(body, 'session_id')) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: 'session_id is not supported in an embeddings body; use x-session-id',
		};
	}
	if (
		Object.prototype.hasOwnProperty.call(body, 'models')
		|| Object.prototype.hasOwnProperty.call(body, 'fallbacks')
	) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: 'models and fallbacks are not supported for embeddings',
		};
	}
	if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) {
		return {
			ok: false,
			code: GatewayErrorCode.missingModel,
			message: `model must be a non-empty ID of at most ${MAX_MODEL_ID_LENGTH} characters`,
		};
	}
	const input = validateEmbeddingInput(body.input);
	if (!input.ok) return { ok: false, code: GatewayErrorCode.invalidRequest, message: input.message };
	if (body.dimensions !== undefined && (
		typeof body.dimensions !== 'number'
		|| !Number.isSafeInteger(body.dimensions)
		|| body.dimensions < 1
	)) {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'dimensions must be a positive integer' };
	}
	if (body.encoding_format !== undefined && body.encoding_format !== 'float' && body.encoding_format !== 'base64') {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'encoding_format must be "float" or "base64"' };
	}
	if (body.input_type !== undefined && (
		typeof body.input_type !== 'string'
		|| !body.input_type.trim()
		|| body.input_type.length > 128
	)) {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'input_type must contain 1-128 characters' };
	}
	if (body.user !== undefined && (typeof body.user !== 'string' || body.user.length > 512)) {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'user must be a string of at most 512 characters' };
	}
	if (body.stream === true) {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'streaming embeddings are not supported' };
	}
	return { ok: true, modelId, input: input.value };
}

function embeddingsBodyForLog(
	body: Record<string, unknown>,
	input: EmbeddingInputShape,
): string | null {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (key === 'input' || key === 'user' || key === 'data') continue;
		out[key] = value;
	}
	out._input_count = input.count;
	out._input_kind = input.kind;
	return finalizeRequestLogJson(out);
}

function upstreamEmbeddingsBodyForLog(
	body: Record<string, unknown>,
	input: EmbeddingInputShape,
	route: RouteResult,
): string | null {
	return embeddingsBodyForLog(
		buildRouteRequestBody(route, {
			...body,
			model: route.providerModelName,
		}),
		input,
	);
}

type RouteSurface = {
	request_protocol?: unknown;
	request_operation?: unknown;
	status?: unknown;
};

export function routeExposesEmbeddings(route: {
	status: string;
	pool_status?: string | null;
	upstream_protocol: string;
	upstream_operation: string;
	surfaces: string | null;
}): boolean {
	if (route.status !== 'active' || route.pool_status === 'disabled') return false;
	let surfaces: RouteSurface[] = [];
	if (route.surfaces) {
		try {
			const parsed = JSON.parse(route.surfaces) as unknown;
			if (Array.isArray(parsed)) surfaces = parsed.filter(isPlainObject);
		} catch {
			return false;
		}
	}
	if (surfaces.length > 0) {
		return surfaces.some((surface) =>
			surface.status !== 'disabled'
			&& surface.request_protocol === 'openai'
			&& (surface.request_operation === 'embeddings' || surface.request_operation === '*')
		);
	}
	return route.upstream_protocol === 'openai'
		&& (route.upstream_operation === 'embeddings' || route.upstream_operation === '*');
}

function decimalPerToken(pricePerMillion: number | null): string {
	if (pricePerMillion == null || !Number.isFinite(pricePerMillion) || pricePerMillion < 0) return '0';
	const value = pricePerMillion / 1_000_000;
	return value === 0 ? '0' : value.toFixed(15).replace(/0+$/, '').replace(/\.$/, '');
}

function embeddingHeadlineInputPrice(pricingProfile: string | null): number | null {
	const profile = parsePricingProfile(pricingProfile ?? undefined);
	if (!profile || profile.tiers.length === 0) return null;
	return Math.min(...profile.tiers.map((tier) => tier.input_price));
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 64)
		: [];
}

/** `GET /v1/embeddings/models` — only models with a callable embeddings surface. */
embeddingsRoutes.get('/models', async (c) => {
	const repos = c.get('repositories');
	const models = await repos.modelRouting.listCallableEmbeddingModelCandidates();
	if (models.length > MAX_CALLABLE_EMBEDDING_MODELS) {
		return c.json({
			error: {
				code: 'embedding_model_catalog_too_large',
				message: 'Embedding model catalog is temporarily unavailable',
			},
		}, 503, {
			'Cache-Control': 'private, no-store',
			'Retry-After': '60',
		});
	}
	const data = models
		// Repository SQL is a bounded prefilter. Re-parse legacy JSON here so
		// malformed or non-array modality payloads always fail closed.
		.filter(isEmbeddingModel)
		.map((model) => {
			const metadata = parseMetadata(model.metadata);
			const releasedAt = model.released_at ? Date.parse(`${model.released_at}T00:00:00Z`) : Number.NaN;
			const inputModalities = parseModelModalitiesJson(model.input_modalities) ?? ['text'];
			const outputModalities = parseModelModalitiesJson(model.output_modalities) ?? ['embeddings'];
			const tokenizer = typeof metadata?.tokenizer === 'string' ? metadata.tokenizer : null;
			const instructType = typeof metadata?.instruct_type === 'string' ? metadata.instruct_type : null;
			const supportedParameters = stringArray(metadata?.supported_parameters);
			return {
				id: model.id,
				canonical_slug: model.id,
				name: model.display_name ?? model.id,
				created: Number.isFinite(releasedAt) ? Math.floor(releasedAt / 1_000) : 0,
				description: model.description,
				context_length: model.context_window,
				architecture: {
					input_modalities: inputModalities,
					output_modalities: outputModalities,
					modality: `${inputModalities.join('+')}->embeddings`,
					instruct_type: instructType,
					tokenizer,
				},
				pricing: {
					prompt: decimalPerToken(embeddingHeadlineInputPrice(model.pricing_profile)),
					completion: '0', image: '0', request: '0',
				},
				supported_parameters: supportedParameters,
				default_parameters: isPlainObject(metadata?.default_parameters)
					? metadata.default_parameters
					: null,
				per_request_limits: null,
				supported_voices: null,
				top_provider: {
					is_moderated: metadata?.is_moderated === true,
					context_length: model.context_window,
					max_completion_tokens: null,
				},
				links: {
					details: `/models/${encodeURIComponent(model.vendor || 'other')}/${toPublicModelSlug(model.id)}`,
				},
				tags: parseTags(model.tags),
				expiration_date: null,
				knowledge_cutoff: null,
			};
		});
	return c.json({ data });
});

embeddingsRoutes.post('/', async (c) => {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const requestId = c.get('generationId')!;
	const timing = new RequestTimingCollector();
	const parsedSession = parseOpenRouterSessionHeader(c.req.raw.headers);
	if (!parsedSession.ok) {
		return gatewayErrorJson(c, {
			status: 400, code: GatewayErrorCode.invalidRequest, message: parsedSession.message,
		});
	}
	const sessionId = parsedSession.sessionId;

	let body: Record<string, unknown>;
	try {
		body = await c.req.json<Record<string, unknown>>();
	} catch {
		return gatewayErrorJson(c, {
			status: 400, code: GatewayErrorCode.invalidJson, message: 'Invalid JSON body',
		});
	}
	if (!isPlainObject(body)) {
		return gatewayErrorJson(c, {
			status: 400, code: GatewayErrorCode.invalidRequest, message: 'Request body must be a JSON object',
		});
	}
	let validation = validateEmbeddingsBody(body);
	if (!validation.ok) {
		return gatewayErrorJson(c, { status: 400, code: validation.code, message: validation.message });
	}

	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [validation.modelId],
		body,
		correlationId: requestId,
		now: new Date(start),
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code: guardrail.code === 'guardrail_invalid'
				? GatewayErrorCode.guardrailInvalid
				: GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}
	body = guardrail.body;
	validation = validateEmbeddingsBody(body);
	if (!validation.ok) {
		return gatewayErrorJson(c, { status: 400, code: validation.code, message: validation.message });
	}

	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [validation.modelId],
		body,
		requestProtocol: 'openai',
		requestOperation: 'embeddings',
		pricingAt: new Date(start),
	});
	if (!fallbackPlan.ok) {
		return gatewayErrorJson(c, {
			status: fallbackPlan.status,
			code: fallbackPlan.code,
			message: fallbackPlan.message,
		});
	}
	const candidate = fallbackPlan.candidates[0]!;
	const modelNameForLog = candidate.model.display_name?.trim() || candidate.baseModelId;
	const requestBodyForLog = embeddingsBodyForLog(body, validation.input);
	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId: candidate.baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'openai',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
		sessionId,
	});
	if (circuitBlocked) return circuitBlocked;

	const ordinaryEstimate = estimateEmbeddingOrdinaryBudgetChargedCost(
		fallbackPlan.candidates,
		validation.input.count,
		apiKey.chargedCostFactors,
	);
	if (!ordinaryEstimate.ok) {
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: ordinaryEstimate.message,
		});
	}
	const guardrailMicros = estimateEmbeddingGuardrailBudgetMicros(
		fallbackPlan.candidates,
		validation.input.count,
		apiKey.chargedCostFactors,
	);
	const byokGatewayKeyBudgetMicros = Math.max(
		guardrailMicros,
		estimateEmbeddingGatewayKeyByokBudgetMicros(fallbackPlan.candidates, validation.input.count),
	);
	const budgetAdmission = await createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			budgetMax: apiKey.budgetMax,
			expectedBudgetEpoch: apiKey.budgetEpoch,
			estimatedChargedCost: ordinaryEstimate.estimatedChargedCost,
			now: new Date(start),
		},
		guardrail: {
			intents: guardrail.budgetIntents,
			reservedMicros: guardrailMicros,
			now: new Date(start),
		},
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: byokGatewayKeyBudgetMicros,
		},
	});
	const ordinaryLease = budgetAdmission.ordinaryLease;
	const terminateOrdinary = async (reason: string): Promise<void> => {
		try {
			await ordinaryLease.terminateUnknown(reason);
		} catch (error) {
			console.error('[Gateway Embeddings] ordinary budget cleanup failed', {
				requestId, reason, error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const forfeitGuardrail = async (reason: string): Promise<void> => {
		if (!budgetAdmission.guardrailDispatched || budgetAdmission.guardrailTerminal) return;
		try {
			await budgetAdmission.forfeitGuardrailPostDispatch(reason);
		} catch (error) {
			console.error('[Gateway Embeddings] guardrail budget forfeit failed', {
				requestId, reason, error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const beforeUpstreamDispatch = (route: RouteResult): Promise<void> =>
		budgetAdmission.beforeUpstreamDispatch(route);

	timing.markGatewayComplete();
	let proxyResult: Awaited<ReturnType<typeof proxyEmbeddings>>;
	try {
		proxyResult = await proxyEmbeddings(
			repos,
			candidate.routes,
			candidate.upstreamBody,
			c.req.raw.signal,
			{
				affinityKey: buildAffinityKey(
					apiKey.userId, candidate.baseModelId, candidate.effectiveRouteGroup, 'openai',
				),
				tierKeyPrefix: buildTierKeyPrefix(
					candidate.baseModelId, candidate.effectiveRouteGroup, 'openai',
				),
				strategy: candidate.strategy.base,
				tierStrategies: candidate.strategy.tierOverrides,
				timing,
				routePoolId: candidate.surface?.route_pool_id ?? candidate.routes[0]?.routePoolId ?? null,
				sticky: candidate.hasProviderPreferences ? null : stickyConfigFromSurface(candidate.surface),
				beforeUpstreamDispatch,
				byok: privateByokContextForApiKey(apiKey),
			},
			requestId,
		);
	} catch (error) {
		await forfeitGuardrail('upstream_dispatch_failed');
		await terminateOrdinary('upstream_dispatch_failed');
		throw error;
	}
	if (proxyResult.stickyMutationPromise) {
		scheduleBackgroundWork(c, proxyResult.stickyMutationPromise);
	}
	if (ordinaryLease.state === 'reserved') await terminateOrdinary('upstream_dispatch_not_started');
	if (budgetAdmission.guardrailReserved && !budgetAdmission.guardrailDispatched) {
		try {
			await budgetAdmission.releaseGuardrailPreDispatch('upstream_dispatch_not_started');
		} catch (error) {
			console.error('[Gateway Embeddings] guardrail budget release failed', {
				requestId, error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const materialized = await materializeNonOkResponse(proxyResult.response, {
		requestId,
		trustedGatewayError: proxyResult.meta?.gatewayGeneratedError === true,
	}).catch(async (error: unknown) => {
		await forfeitGuardrail('upstream_response_materialization_failed');
		await terminateOrdinary('upstream_response_materialization_failed');
		throw error;
	});
	const response = materialized.response;
	const errorBodyText = materialized.errorBodyText;
	const acceptedUpstreamResponse = response.ok
		|| proxyResult.meta?.responseBodyTooLarge === true
		|| proxyResult.meta?.failoverForbidden === true;
	const circuitEvents = [...proxyResult.circuitEvents];
	if (response.ok) {
		markUserModelSuccess(apiKey.userId, candidate.baseModelId);
	} else if (errorBodyText != null && proxyResult.meta?.gatewayGeneratedError !== true) {
		const event = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			candidate.baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(
				response.status, response.headers.get('content-type'), errorBodyText,
			),
			{ clientErrorCircuitEnabled: false },
		);
		if (event) circuitEvents.push(event);
	}

	const usageOrSafety = textUsageWithSafetyTimeout(
		proxyResult.usagePromise,
		USAGE_SAFETY_TIMEOUT_MS,
		EMPTY_USAGE,
	);
	scheduleBackgroundWork(c, usageOrSafety.then(async ({ usage, incomplete, timedOut }) => {
		if (timedOut) timing.markStreamComplete();
		timing.finalizeSelectedAttemptAvailability({
			clientCancelled: Boolean(usage.cancelled),
			invalidResponse: Boolean(usage.stream_error)
				|| (proxyResult.meta?.gatewayGeneratedError === true && !response.ok),
		});
		const status = computeRequestLogStatus({
			cancelled: Boolean(usage.cancelled),
			responseOk: response.ok,
			incomplete,
		});
		const unknownCost = textUsageCostIsUnknown({
			upstreamResponseOk: acceptedUpstreamResponse,
			usageAvailable: !incomplete,
			cancelled: Boolean(usage.cancelled),
			streamError: Boolean(usage.stream_error),
			upstreamOutcomeUnknown: proxyResult.meta?.upstreamOutcomeUnknown === true,
			responseBodyTooLarge: proxyResult.meta?.responseBodyTooLarge === true,
		});
		let errorMessage: string | undefined;
		if (status === 'success') errorMessage = undefined;
		else if (status === 'cancelled') errorMessage = 'Client disconnected';
		else if (status === 'incomplete') errorMessage = timedOut
			? 'Embeddings usage timeout'
			: 'Upstream embeddings response did not include usage';
		else if (errorBodyText != null) errorMessage = formatHttpErrorTextForRequestLog(
			response.status, response.headers.get('content-type'), errorBodyText,
		);
		else errorMessage = `HTTP ${response.status}`;

		return recordUsage(repos, {
			api_key_id: apiKey.keyId,
			workspace_id: apiKey.workspaceId,
			request_log_id: requestId,
			user_id: apiKey.userId,
			user_email: apiKey.userEmail,
			model_id: candidate.baseModelId,
			provider_id: proxyResult.chosenRoute.providerId,
			provider_model_name: proxyResult.chosenRoute.providerModelName,
			model_name: modelNameForLog,
			provider_name: proxyResult.chosenRoute.providerName,
			request_body: requestBodyForLog,
			upstream_request_body: upstreamEmbeddingsBodyForLog(
				candidate.upstreamBody,
				validation.input,
				proxyResult.chosenRoute,
			),
			request_body_logging_mode: c.get('requestBodyLoggingMode'),
			request_origin: new URL(c.req.url).origin,
			...generationRequestLogContext(c.req.raw.headers),
			session_id: sessionId,
			response_streamed: false,
			request_protocol: 'openai',
			request_operation: 'embeddings',
			upstream_protocol: proxyResult.chosenRoute.upstreamProtocol,
			upstream_operation: proxyResult.chosenRoute.upstreamOperation,
			model_surface_id: proxyResult.chosenRoute.modelSurfaceId,
			route_pool_id: proxyResult.chosenRoute.routePoolId,
			route_target_id: proxyResult.chosenRoute.targetId,
			adapter: proxyResult.chosenRoute.adapter,
			sticky_trace: proxyResult.stickyTrace ? await proxyResult.stickyTrace() : null,
			provider_routing_trace: proxyResult.chosenRoute.providerRoutingTrace ?? null,
			usage,
			endpoint_pricing_snapshot: proxyResult.chosenRoute.endpoint ?? null,
			model_pricing_profile: candidate.model.pricing_profile ?? null,
			route_price_override_json: proxyResult.chosenRoute.priceOverrideRaw,
			user_charged_cost_factors_json: apiKey.chargedCostFactors,
			route_metered_profile_json: proxyResult.chosenRoute.routeMeteredProfileJson,
			route_charged_profile_json: proxyResult.chosenRoute.routeChargedProfileJson,
			request_started_at_ms: start,
			route_group: proxyResult.chosenRoute.routeGroup,
			status,
			latency_ms: Date.now() - start,
			timing: timing.snapshot(usage.upstreamMessageId),
			error_message: errorMessage,
			provider_key_id: proxyResult.chosenRoute.providerKeyId ?? null,
			provider_key_label: proxyResult.chosenRoute.providerKeyLabel ?? null,
			provider_key_fingerprint: proxyResult.chosenRoute.providerKeyFingerprint ?? null,
			upstream_request_id: proxyResult.upstreamRequestId,
			upstream_message_id: usage.upstreamMessageId ?? null,
			circuit_events: circuitEvents.length > 0 ? circuitEvents : undefined,
			suppress_error_alert: proxyResult.suppressErrorAlert || undefined,
			guardrail_budget_settlement: budgetAdmission.guardrailReserved
				? { requestId, unknownCost }
				: undefined,
			ordinary_budget_settlement:
				ordinaryLease.reserved && ordinaryLease.state === 'dispatched'
					? {
						requestId,
						budgetEpoch: ordinaryLease.budgetEpoch!,
						reservedMicros: ordinaryLease.reservedMicros,
						unknownCost,
					}
					: undefined,
		});
	}).catch(async (error) => {
		console.error('[Gateway Embeddings] usage settlement failed', {
			requestId, error: error instanceof Error ? error.message : String(error),
		});
		await forfeitGuardrail('request_usage_settlement_failed');
		await terminateOrdinary('request_usage_settlement_failed');
	}));

	return response;
});
