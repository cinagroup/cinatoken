/** OpenRouter-compatible rerank ingress. */
import { isRerankModel } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import {
	BoundedJsonRequestError,
	readBoundedJsonObject,
} from '../../services/egress/bounded-json-request';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { generationRequestLogContext } from '../../services/generation-request-context';
import {
	estimateRerankGatewayKeyByokBudgetMicros,
	estimateRerankGuardrailBudgetMicros,
	estimateRerankOrdinaryBudgetChargedCost,
} from '../../services/guardrail-budget-estimate';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import type { RouteResult } from '../../services/model-router';
import { parseOpenRouterSessionHeader } from '../../services/openrouter-session-routing';
import { privateByokContextForApiKey } from '../../services/byok-key-pool';
import { proxyRerank, EMPTY_USAGE } from '../../services/proxy';
import { createRouteAwareBudgetAdmission } from '../../services/request-budget-admission';
import { runRequestGuardrails } from '../../services/request-guardrails';
import {
	computeRequestLogStatus,
	formatHttpErrorTextForRequestLog,
	materializeNonOkResponse,
} from '../../services/request-log-record-status';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { RequestTimingCollector } from '../../services/request-timing';
import { buildRouteRequestBody } from '../../services/route-default-params';
import { buildAffinityKey, buildTierKeyPrefix } from '../../services/route-strategies';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import {
	textUsageCostIsUnknown,
	textUsageWithSafetyTimeout,
} from '../../services/text-usage-settlement';
import { recordUsage } from '../../services/usage-tracker';
import {
	markUserModelSuccess,
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
} from '../../services/user-model-circuit-route';

const USAGE_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
export const RERANK_REQUEST_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_RERANK_DOCUMENTS = 2_048;
const MAX_MODEL_ID_LENGTH = 240;
const ALLOWED_BODY_KEYS = new Set(['model', 'query', 'documents', 'provider', 'top_n']);

type RerankEnv = Env & {
	Variables: { apiKey: import('../../middleware/auth').ApiKeyContext };
};

export const rerankRoutes = new Hono<RerankEnv>();
rerankRoutes.use('*', requireApiKey);
rerankRoutes.use('*', assignGenerationId);

export type RerankDocument = string | { text?: string; image?: string };

export type RerankBodyValidation =
	| {
		ok: true;
		modelId: string;
		documentCount: number;
		documentKinds: Array<'text' | 'image' | 'multimodal'>;
	}
	| {
		ok: false;
		code: typeof GatewayErrorCode.invalidRequest | typeof GatewayErrorCode.missingModel;
		message: string;
	};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function validImageReference(value: string): boolean {
	if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/iu.test(value)) return true;
	try {
		const url = new URL(value);
		return (url.protocol === 'https:' || url.protocol === 'http:')
			&& !url.username
			&& !url.password;
	} catch {
		return false;
	}
}

function validateDocument(value: unknown):
	| { ok: true; kind: 'text' | 'image' | 'multimodal' }
	| { ok: false; message: string } {
	if (typeof value === 'string') return { ok: true, kind: 'text' };
	if (!isPlainObject(value)) {
		return { ok: false, message: 'each document must be a string or a text/image object' };
	}
	const unsupported = Object.keys(value).filter((key) => key !== 'text' && key !== 'image');
	if (unsupported.length > 0) {
		return { ok: false, message: `document contains unsupported field: ${unsupported[0]}` };
	}
	const hasText = Object.prototype.hasOwnProperty.call(value, 'text');
	const hasImage = Object.prototype.hasOwnProperty.call(value, 'image');
	if (!hasText && !hasImage) {
		return { ok: false, message: 'each document object must contain text or image' };
	}
	if (hasText && typeof value.text !== 'string') {
		return { ok: false, message: 'document.text must be a string' };
	}
	if (hasImage && (typeof value.image !== 'string' || !validImageReference(value.image))) {
		return { ok: false, message: 'document.image must be an HTTP(S) URL or base64 image data URI' };
	}
	return { ok: true, kind: hasText && hasImage ? 'multimodal' : hasImage ? 'image' : 'text' };
}

export function validateRerankBody(body: Record<string, unknown>): RerankBodyValidation {
	const modelId = typeof body.model === 'string' ? body.model.trim() : '';
	if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) {
		return {
			ok: false,
			code: GatewayErrorCode.missingModel,
			message: `model must be a non-empty ID of at most ${MAX_MODEL_ID_LENGTH} characters`,
		};
	}
	if (Object.prototype.hasOwnProperty.call(body, 'session_id')) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: 'session_id is not supported in a rerank body; use x-session-id',
		};
	}
	if (Object.prototype.hasOwnProperty.call(body, 'stream')) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: 'streaming rerank requests are not supported',
		};
	}
	if (
		Object.prototype.hasOwnProperty.call(body, 'models')
		|| Object.prototype.hasOwnProperty.call(body, 'fallbacks')
	) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: 'models and fallbacks are not supported for rerank',
		};
	}
	const unsupported = Object.keys(body).filter((key) => !ALLOWED_BODY_KEYS.has(key));
	if (unsupported.length > 0) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: `Unsupported rerank field: ${unsupported[0]}`,
		};
	}
	if (typeof body.query !== 'string') {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'query must be a string' };
	}
	if (
		!Array.isArray(body.documents)
		|| body.documents.length === 0
		|| body.documents.length > MAX_RERANK_DOCUMENTS
	) {
		return {
			ok: false,
			code: GatewayErrorCode.invalidRequest,
			message: `documents must contain 1-${MAX_RERANK_DOCUMENTS} items`,
		};
	}
	const documentKinds: Array<'text' | 'image' | 'multimodal'> = [];
	for (const document of body.documents) {
		const validation = validateDocument(document);
		if (!validation.ok) {
			return { ok: false, code: GatewayErrorCode.invalidRequest, message: validation.message };
		}
		documentKinds.push(validation.kind);
	}
	if (body.top_n !== undefined && (
		typeof body.top_n !== 'number'
		|| !Number.isSafeInteger(body.top_n)
		|| body.top_n < 1
	)) {
		return { ok: false, code: GatewayErrorCode.invalidRequest, message: 'top_n must be a positive integer' };
	}
	return {
		ok: true,
		modelId,
		documentCount: body.documents.length,
		documentKinds,
	};
}

function rerankBodyForLog(
	body: Record<string, unknown>,
	validation: Extract<RerankBodyValidation, { ok: true }>,
): string | null {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (key === 'query' || key === 'documents') continue;
		out[key] = value;
	}
	out._document_count = validation.documentCount;
	out._document_kinds = validation.documentKinds.reduce<Record<string, number>>((counts, kind) => {
		counts[kind] = (counts[kind] ?? 0) + 1;
		return counts;
	}, {});
	return finalizeRequestLogJson(out);
}

function upstreamRerankBodyForLog(
	body: Record<string, unknown>,
	validation: Extract<RerankBodyValidation, { ok: true }>,
	route: RouteResult,
): string | null {
	return rerankBodyForLog(
		buildRouteRequestBody(route, { ...body, model: route.providerModelName }),
		validation,
	);
}

rerankRoutes.post('/', async (c) => {
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
		body = await readBoundedJsonObject(c.req.raw, {
			maxBytes: RERANK_REQUEST_MAX_BYTES,
			label: 'Rerank request',
		});
	} catch (error) {
		if (error instanceof BoundedJsonRequestError) {
			return gatewayErrorJson(c, {
				status: error.kind === 'payload_too_large' ? 413 : 400,
				code: error.kind === 'payload_too_large'
					? GatewayErrorCode.payloadTooLarge
					: error.kind === 'invalid_json'
						? GatewayErrorCode.invalidJson
						: GatewayErrorCode.invalidRequest,
				message: error.message,
			});
		}
		throw error;
	}
	let validation = validateRerankBody(body);
	if (!validation.ok) {
		return gatewayErrorJson(c, { status: 400, code: validation.code, message: validation.message });
	}
	// OpenRouter declares provider as object | null; null has the same routing
	// semantics as omission and must not reach the shared object-only parser.
	if (body.provider === null) {
		body = { ...body };
		delete body.provider;
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
	validation = validateRerankBody(body);
	if (!validation.ok) {
		return gatewayErrorJson(c, { status: 400, code: validation.code, message: validation.message });
	}

	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [validation.modelId],
		body,
		requestProtocol: 'openai',
		requestOperation: 'rerank',
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
	if (!isRerankModel(candidate.model)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: `Model "${candidate.baseModelId}" is not a rerank model`,
		});
	}
	const modelNameForLog = candidate.model.display_name?.trim() || candidate.baseModelId;
	const requestBodyForLog = rerankBodyForLog(body, validation);
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

	const ordinaryEstimate = estimateRerankOrdinaryBudgetChargedCost(
		fallbackPlan.candidates,
		validation.documentCount,
		apiKey.chargedCostFactors,
	);
	if (!ordinaryEstimate.ok) {
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: ordinaryEstimate.message,
		});
	}
	const guardrailMicros = estimateRerankGuardrailBudgetMicros(
		fallbackPlan.candidates,
		validation.documentCount,
		apiKey.chargedCostFactors,
	);
	const byokGatewayKeyBudgetMicros = Math.max(
		guardrailMicros,
		estimateRerankGatewayKeyByokBudgetMicros(
			fallbackPlan.candidates,
			validation.documentCount,
		),
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
			console.error('[Gateway Rerank] ordinary budget cleanup failed', {
				requestId, reason, error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const forfeitGuardrail = async (reason: string): Promise<void> => {
		if (!budgetAdmission.guardrailDispatched || budgetAdmission.guardrailTerminal) return;
		try {
			await budgetAdmission.forfeitGuardrailPostDispatch(reason);
		} catch (error) {
			console.error('[Gateway Rerank] guardrail budget forfeit failed', {
				requestId, reason, error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const beforeUpstreamDispatch = (route: RouteResult): Promise<void> =>
		budgetAdmission.beforeUpstreamDispatch(route);

	timing.markGatewayComplete();
	let proxyResult: Awaited<ReturnType<typeof proxyRerank>>;
	try {
		proxyResult = await proxyRerank(
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
			console.error('[Gateway Rerank] guardrail budget release failed', {
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
			? 'Rerank usage timeout'
			: 'Upstream rerank response did not include usage';
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
			upstream_request_body: upstreamRerankBodyForLog(
				candidate.upstreamBody,
				validation,
				proxyResult.chosenRoute,
			),
			request_body_logging_mode: c.get('requestBodyLoggingMode'),
			request_origin: new URL(c.req.url).origin,
			...generationRequestLogContext(c.req.raw.headers),
			session_id: sessionId,
			response_streamed: false,
			request_protocol: 'openai',
			request_operation: 'rerank',
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
		console.error('[Gateway Rerank] usage settlement failed', {
			requestId, error: error instanceof Error ? error.message : String(error),
		});
		await forfeitGuardrail('request_usage_settlement_failed');
		await terminateOrdinary('request_usage_settlement_failed');
	}));

	return response;
});
