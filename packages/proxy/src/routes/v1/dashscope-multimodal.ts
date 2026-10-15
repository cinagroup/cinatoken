import {
	prepareNativeMediaPolicy,
	admitNativeMediaRequest,
	readNativeMediaJson,
} from '../../services/native-media-request-context';
import { estimateAudioSpeechBudgetPrecheck } from '../../services/audio-usage-charge';
/**
 * DashScope 同步多模态 ASR HTTP 透传：
 * `POST /v1/dashscope/services/aigc/multimodal-generation/generation`
 *
 * 请求/上游都是 dashscope + audio.transcriptions.multimodal，adapter 必须是 passthrough。
 * 返回原生 JSON，按 usage.duration / usage.seconds 计 audio_per_second。
 */
import type { GatewayRepositories, GuardrailPreflightResult } from '@octafuse/core';
import { getBusinessTimezone } from '@octafuse/core';
import {
	isAudioSpeechModel,
	isImageGenerationModel,
	type ModelRow,
	type ResolvedModelSurfaceRow,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import { buildAffinityKey, buildTierKeyPrefix } from '../../services/route-strategies';
import { proxyDashScopeMultimodalPassthrough, type ProxyResult } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { generationRequestContext } from '../../services/generation-request-context';
import {
	audioGuardrailBudgetMicros,
	audioGuardrailSettlementMode,
	estimateAudioBudgetPrecheck,
	recordAudioUsage,
} from '../../services/audio-usage-charge';
import { resolveModelRouting } from '../../services/resolve-model-route-group';
import { proxyDashScopeJsonPassthrough } from '../../services/proxy';
import type { DashScopePassthroughSurface } from '../../services/egress/dashscope-json-passthrough';
import {
	canAffordImageCost,
	estimateImageBudgetPrecheck,
	createImagePricingContext,
	type ImagePricingContext,
	recordImageUsage,
} from '../../services/image-usage-charge';
import { formatHttpErrorTextForRequestLog, materializeNonOkResponse } from '../../services/request-log-record-status';
import {
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
	markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import {
	GatewayErrorCode,
	NO_AVAILABLE_ROUTE_MESSAGE,
	type GatewayErrorCodeValue,
} from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { scheduleResourceCompletion } from '../../runtime/schedule-resource-completion';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import {
	auditGuardrailOutputDecision,
	filterGuardrailResponse,
	GUARDRAIL_MAX_RESPONSE_BYTES,
} from '../../services/request-guardrails';
import {
	redactDashScopeMultimodalBodyForLog,
	runDashScopeMultimodalRequestGuardrails,
} from '../../services/audio-request-guardrails';
import { MAX_AUDIO_DURATION_SECONDS } from '../../services/egress/audio-duration';
import type { OrdinaryBudgetLease } from '../../services/ordinary-budget-lifecycle';
import { selectConservativeMultimediaBudgetEstimate } from '../../services/multimedia-ordinary-budget';
import { routeUsesUnsupportedMultimediaEndpointPriceSelection } from '../../services/endpoint-billing-pricing';
import { privateByokContextForApiKey } from '../../services/byok-key-pool';
import {
	createRouteAwareBudgetAdmission,
	type RouteAwareBudgetAdmission,
} from '../../services/request-budget-admission';

type MultimodalEnv = Env & { Variables: { apiKey: ApiKeyContext } };
type MultimodalContext = Context<MultimodalEnv>;

export const dashScopeMultimodalRoutes = new Hono<MultimodalEnv>();

dashScopeMultimodalRoutes.use('*', requireApiKey);
dashScopeMultimodalRoutes.use('*', assignGenerationId);

/** Fail closed when any eligible route lacks a provable finite debit ceiling. */
export function dashScopeMultimodalPricingCeilingFailureContract(estimatedChargedCost: number | null): {
	status: 502;
	code: typeof GatewayErrorCode.routeResolutionFailed;
	message: string;
} | null {
	return estimatedChargedCost === null
		? {
				status: 502,
				code: GatewayErrorCode.routeResolutionFailed,
				message: 'DashScope multimodal pricing cannot prove a finite charged-cost ceiling for every eligible route',
			}
		: null;
}

export function dashScopeMultimodalUsageUnavailable(params: {
	upstreamResponseOk: boolean;
	usagePromiseUnavailable: boolean;
	responseBodyTooLarge: boolean;
	upstreamOutcomeUnknown: boolean;
	durationSeconds: number;
	durationSource?: 'upstream' | 'media' | 'client' | 'estimated' | 'precheck';
}): boolean {
	// A synthetic non-2xx response cannot turn a post-dispatch network ambiguity
	// into known zero. Preserve the reservation before applying normal status
	// semantics to provider responses that were actually observed.
	if (params.upstreamOutcomeUnknown) return true;
	const transportOrBodyUsageUnavailable =
		params.upstreamResponseOk && (params.usagePromiseUnavailable || params.responseBodyTooLarge);
	return (
		audioGuardrailSettlementMode({
			status: params.upstreamResponseOk ? 'success' : 'error',
			billingMode: 'per_second',
			durationSeconds: params.durationSeconds,
			durationSource: params.durationSource,
			tokenUsage: null,
			characters: null,
			usageUnavailable: transportOrBodyUsageUnavailable,
		}) === 'reserved'
	);
}

/** 同一条多模态路径按模型类型选择透传 operation，转写模型保持原来的 ASR 入口。 */
export function dashScopeMultimodalOperation(
	model: ModelRow,
): DashScopePassthroughSurface | 'audio.transcriptions.multimodal' {
	if (isImageGenerationModel(model)) return 'images.generations.multimodal';
	if (isAudioSpeechModel(model)) return 'audio.speech.multimodal';
	return 'audio.transcriptions.multimodal';
}

function modelDisplayName(model: { display_name?: string | null }, baseModelId: string): string {
	return model.display_name != null && String(model.display_name).trim() !== ''
		? String(model.display_name).trim()
		: baseModelId;
}

type MultimodalGuardrailBudgetLease = {
	requestId: string;
	reserved: boolean;
	dispatched: boolean;
	terminal: boolean;
	release(reason: string): Promise<void>;
	forfeit(reason: string): Promise<void>;
};

function routeAwareMultimodalGuardrailLease(admission: RouteAwareBudgetAdmission): MultimodalGuardrailBudgetLease {
	return {
		requestId: admission.ordinaryLease.requestId,
		get reserved() {
			return admission.guardrailReserved;
		},
		get dispatched() {
			return admission.guardrailDispatched;
		},
		get terminal() {
			return admission.guardrailTerminal;
		},
		release: (reason) => admission.releaseGuardrailPreDispatch(reason),
		forfeit: (reason) => admission.terminateGuardrailUnknown(reason),
	};
}

async function terminateMultimodalOrdinaryBudget(
	lease: OrdinaryBudgetLease,
	requestId: string,
	reason: string,
): Promise<void> {
	try {
		await lease.terminateUnknown(reason);
	} catch (error) {
		console.error(
			`[Gateway Audio] DashScope multimodal ordinary budget cleanup failed requestId=${requestId} state=${lease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function terminateMultimodalGuardrailBudget(
	lease: MultimodalGuardrailBudgetLease,
	reason: string,
): Promise<void> {
	try {
		if (lease.dispatched) await lease.forfeit(reason);
		else await lease.release(reason);
	} catch (error) {
		console.error(
			`[Gateway Audio] DashScope multimodal Guardrail budget cleanup failed requestId=${lease.requestId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

dashScopeMultimodalRoutes.post('/', async (c) => {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const requestCorrelationId = c.get('generationId')!;
	const timing = new RequestTimingCollector();
	let body: unknown;
	try {
		body = await readNativeMediaJson(c);
	} catch {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidJson,
			message: 'Invalid JSON body',
		});
	}
	if (body == null || typeof body !== 'object' || Array.isArray(body)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'JSON body must be an object',
		});
	}
	const requestBody = body as Record<string, unknown>;
	const rawModelId = typeof requestBody.model === 'string' ? requestBody.model.trim() : '';
	if (!rawModelId) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'Missing model',
		});
	}

	const preview = await resolveModelRouting(repos, rawModelId);
	if (!preview) {
		return gatewayErrorJson(c, {
			status: 404,
			code: GatewayErrorCode.modelNotFound,
			message: `Model not found: ${rawModelId.trim().slice(0, 200)}`,
		});
	}
	const requestOperation = dashScopeMultimodalOperation(preview.model);
	if (requestOperation !== 'audio.transcriptions.multimodal')
		return forwardNativeMultimodal(c, rawModelId, requestBody, requestOperation, start, timing);
	const guardrail = await runDashScopeMultimodalRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelId: rawModelId,
		body: requestBody,
		correlationId: requestCorrelationId,
		now: new Date(start),
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code:
				guardrail.code === 'guardrail_invalid' ? GatewayErrorCode.guardrailInvalid : GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}

	// The fallback planner consumes Guardrail-injected provider.only / provider.zdr,
	// filters route data policies, and strips gateway-only provider controls before dispatch.
	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body: guardrail.body,
		requestProtocol: 'dashscope',
		requestOperation,
		pricingAt: new Date(start),
	});
	if (!fallbackPlan.ok) {
		return gatewayErrorJson(c, {
			status: fallbackPlan.status,
			code: fallbackPlan.code,
			message: fallbackPlan.message,
		});
	}
	const selectedPlan = fallbackPlan.candidates[0]!;
	const { model, baseModelId, effectiveRouteGroup, routes } = selectedPlan;
	if (routes.some(routeUsesUnsupportedMultimediaEndpointPriceSelection)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'provider.max_price and provider.sort=price are unavailable for DashScope multimodal audio',
		});
	}
	const guardedRequestBody = selectedPlan.upstreamBody;
	const modelNameForLog = modelDisplayName(model, baseModelId);
	const businessTimezone = await getBusinessTimezone(repos);
	const estimateSelection = selectConservativeMultimediaBudgetEstimate(
		await Promise.all(
			routes.map((route) =>
				estimateAudioBudgetPrecheck(
					repos,
					{
						endpoint: route.endpoint ?? null,
						operation: 'audio.transcriptions.multimodal',
						catalogModelId: baseModelId,
						userChargedCostFactorsJson: apiKey.chargedCostFactors,
						fileBytes: 0,
						// The egress billing adapter clamps authoritative provider duration to
						// this same ceiling before settlement, including URL-only inputs.
						verifiedDurationCeilingSeconds: MAX_AUDIO_DURATION_SECONDS,
						requestStartedAtMs: start,
						businessTimezone,
					},
					[route.priceOverrideRaw],
				),
			),
		),
	);
	if (!estimateSelection) throw new Error('Multimodal fallback plan has no billable route estimate');
	const { estimate, estimatedChargedCost, estimatedStandardCost } = estimateSelection;
	const pricingCeilingFailure = dashScopeMultimodalPricingCeilingFailureContract(estimatedChargedCost);
	if (pricingCeilingFailure) return gatewayErrorJson(c, pricingCeilingFailure);

	const requestBodyForLog = finalizeRequestLogJson(redactDashScopeMultimodalBodyForLog(guardedRequestBody));
	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'dashscope',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
	});
	if (circuitBlocked) return circuitBlocked;

	const budgetAdmission = await createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId: requestCorrelationId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			budgetMax: apiKey.budgetMax,
			expectedBudgetEpoch: apiKey.budgetEpoch,
			estimatedChargedCost,
			now: new Date(start),
		},
		guardrail: {
			intents: guardrail.budgetIntents,
			reservedMicros: audioGuardrailBudgetMicros(estimate.chargedCost),
			now: new Date(start),
		},
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: Math.max(
				audioGuardrailBudgetMicros(estimate.chargedCost),
				audioGuardrailBudgetMicros(estimatedStandardCost ?? Number.POSITIVE_INFINITY),
			),
		},
	});
	const ordinaryBudgetLease = budgetAdmission.ordinaryLease;
	const guardrailBudgetLease = routeAwareMultimodalGuardrailLease(budgetAdmission);
	timing.markGatewayComplete();
	let proxyResult: ProxyResult;
	try {
		proxyResult = await proxyDashScopeMultimodalPassthrough(repos, routes, guardedRequestBody, c.req.raw.signal, {
			registerResourceCompletion: (task) => scheduleResourceCompletion(c, task),
			affinityKey: buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'dashscope'),
			errorContext: { skin: 'chat', requestId: requestCorrelationId },
			tierKeyPrefix: buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'dashscope'),
			strategy: selectedPlan.strategy.base,
			tierStrategies: selectedPlan.strategy.tierOverrides,
			timing,
			routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
			sticky: selectedPlan.hasProviderPreferences ? null : stickyConfigFromSurface(selectedPlan.surface),
			beforeUpstreamDispatch: (route) => budgetAdmission.beforeUpstreamDispatch(route),
			dashScope: {
				...(guardrail.outputFilters.length > 0
					? {
							maxResponseBytes: GUARDRAIL_MAX_RESPONSE_BYTES,
						}
					: {}),
			},
			byok: privateByokContextForApiKey(apiKey),
		});
	} catch (error) {
		await terminateMultimodalGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_failed');
		await terminateMultimodalOrdinaryBudget(ordinaryBudgetLease, requestCorrelationId, 'upstream_dispatch_failed');
		throw error;
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await terminateMultimodalOrdinaryBudget(ordinaryBudgetLease, requestCorrelationId, 'upstream_dispatch_not_started');
	}
	if (!guardrailBudgetLease.dispatched) {
		await terminateMultimodalGuardrailBudget(guardrailBudgetLease, 'upstream_dispatch_not_started');
	}
	return finalizeMultimodalResponse({
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		businessTimezone,
		start,
		timing,
		guardrail,
		requestedModelId: rawModelId,
		requestCorrelationId,
		guardrailBudgetLease,
		ordinaryBudgetLease,
		requestOperation,
	});
});

async function finalizeMultimodalResponse(params: {
	c: MultimodalContext;
	proxyResult: ProxyResult;
	apiKey: ApiKeyContext;
	repos: GatewayRepositories;
	baseModelId: string;
	effectiveRouteGroup: string;
	modelNameForLog: string;
	requestBodyForLog: string | null;
	businessTimezone: string;
	start: number;
	timing: RequestTimingCollector;
	guardrail: Extract<GuardrailPreflightResult, { ok: true }>;
	requestedModelId: string;
	requestCorrelationId: string;
	guardrailBudgetLease: MultimodalGuardrailBudgetLease;
	ordinaryBudgetLease: OrdinaryBudgetLease;
	requestOperation: string;
	modelPricingProfileJson?: string | null;
	imagePricingContext?: ImagePricingContext;
}): Promise<Response> {
	const {
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		businessTimezone,
		start,
		timing,
		guardrail,
		requestedModelId,
		requestCorrelationId,
		guardrailBudgetLease,
		ordinaryBudgetLease,
		requestOperation,
		modelPricingProfileJson,
		imagePricingContext,
	} = params;
	const { chosenRoute, upstreamRequestId, circuitEvents, suppressErrorAlert, stickyTrace, stickyMutationPromise } =
		proxyResult;
	if (stickyMutationPromise) {
		scheduleBackgroundWork(c, stickyMutationPromise);
	}
	let { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response, {
		requestId: requestCorrelationId,
		trustedGatewayError: proxyResult.meta?.gatewayGeneratedError === true,
	}).catch(async (error: unknown) => {
		await terminateMultimodalGuardrailBudget(guardrailBudgetLease, 'upstream_response_materialization_failed');
		await terminateMultimodalOrdinaryBudget(
			ordinaryBudgetLease,
			requestCorrelationId,
			'upstream_response_materialization_failed',
		);
		throw error;
	});
	const usagePromiseUnavailable = await proxyResult.usagePromise.then(
		() => false,
		() => true,
	);
	const upstreamResponseOk = response.ok;
	const outputResponseTooLarge = proxyResult.meta?.responseBodyTooLarge === true;
	const upstreamOutcomeUnknown = proxyResult.meta?.upstreamOutcomeUnknown === true;
	const meta = proxyResult.meta;
	const durationSeconds = upstreamResponseOk ? (meta?.audioDurationSeconds ?? 0) : 0;
	const durationSource = upstreamResponseOk && meta?.audioDurationSource ? meta.audioDurationSource : 'estimated';
	// A known non-2xx response commits zero user debit even if its diagnostic
	// body was truncated. Preserve the ceiling only for an unknown final network
	// outcome or a consumed 2xx whose required duration could not be recovered.
	const usageUnavailable =
		requestOperation !== 'audio.transcriptions.multimodal'
			? upstreamOutcomeUnknown ||
				outputResponseTooLarge ||
				usagePromiseUnavailable ||
				(upstreamResponseOk &&
					(requestOperation === 'images.generations.multimodal'
						? !Number.isFinite(meta?.imageCount)
						: meta?.audioCharacters == null))
			: dashScopeMultimodalUsageUnavailable({
					upstreamResponseOk,
					usagePromiseUnavailable,
					responseBodyTooLarge: outputResponseTooLarge,
					upstreamOutcomeUnknown,
					durationSeconds,
					durationSource,
				});

	let userModelCircuitEvent = null;
	if (upstreamResponseOk) {
		markUserModelSuccess(apiKey.userId, baseModelId);
	} else if (
		errorBodyText != null &&
		meta?.gatewayGeneratedError !== true &&
		meta?.admissionDeniedPreDispatch !== true
	) {
		userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(response.status, response.headers.get('content-type'), errorBodyText),
			{ clientErrorCircuitEnabled: false },
		);
	}
	const alertCircuitEvents = userModelCircuitEvent ? [...circuitEvents, userModelCircuitEvent] : circuitEvents;
	let outputGuardrailBlocked = false;
	if (guardrail.outputFilters.length > 0 && upstreamResponseOk) {
		const filtered = outputResponseTooLarge
			? { response, blockedBy: 'response_too_large', redactionCount: 0 }
			: await filterGuardrailResponse(response, guardrail.outputFilters).catch(async (error: unknown) => {
					await terminateMultimodalGuardrailBudget(guardrailBudgetLease, 'output_guardrail_failed_after_dispatch');
					await terminateMultimodalOrdinaryBudget(
						ordinaryBudgetLease,
						requestCorrelationId,
						'output_guardrail_failed_after_dispatch',
					);
					throw error;
				});
		await auditGuardrailOutputDecision(repos, {
			workspaceId: apiKey.workspaceId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			modelIds: [requestedModelId],
			trace: guardrail.trace,
			blockedBy: filtered.blockedBy,
			redactionCount: filtered.redactionCount,
			correlationId: requestCorrelationId,
		}).catch((error: unknown) => {
			console.warn(
				`[Gateway Audio] DashScope multimodal output guardrail audit failed requestId=${requestCorrelationId} error=${error instanceof Error ? error.message : String(error)}`,
			);
		});
		if (filtered.blockedBy) {
			outputGuardrailBlocked = true;
			errorBodyText = 'Guardrail blocked response output';
			response = gatewayErrorJson(c, {
				status: 403,
				code: GatewayErrorCode.guardrailBlocked,
				message: 'Response blocked by output guardrail',
			});
		} else {
			response = filtered.response;
		}
	}
	if (outputResponseTooLarge && upstreamResponseOk && guardrail.outputFilters.length === 0) {
		errorBodyText = 'DashScope response body exceeds the configured limit';
		response = gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: errorBodyText,
		});
	}

	// Log the response the client actually received. A normal output-policy 403
	// can still charge known upstream usage; a bounded-away body keeps the lease
	// ceiling because no exact committed debit can be derived.
	const status: 'success' | 'error' = response.ok ? 'success' : 'error';
	const chargeOnError = status === 'error' && upstreamResponseOk && !outputResponseTooLarge;
	const errorMessage = outputGuardrailBlocked
		? 'Response blocked by output guardrail'
		: status === 'error'
			? errorBodyText != null
				? formatHttpErrorTextForRequestLog(response.status, response.headers.get('content-type'), errorBodyText)
				: `HTTP ${response.status}`
			: undefined;

	scheduleBackgroundWork(
		c,
		(async () => {
			const stickyTraceSnapshot = stickyTrace ? await stickyTrace() : null;
			if (requestOperation === 'images.generations.multimodal') {
				await recordImageUsage({
					requestLogId: requestCorrelationId,
					budgetAccountedAt: new Date(start).toISOString(),
					guardrailBudgetSettlement: guardrailBudgetLease.reserved
						? {
								requestId: requestCorrelationId,
								mode: upstreamOutcomeUnknown || outputResponseTooLarge ? 'reserved' : 'actual',
							}
						: undefined,
					ordinaryBudgetSettlement:
						ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
							? {
									requestId: requestCorrelationId,
									budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
									reservedMicros: ordinaryBudgetLease.reservedMicros,
									unknownCost: upstreamOutcomeUnknown || outputResponseTooLarge,
								}
							: undefined,
					repos,
					workspaceId: apiKey.workspaceId,
					apiKeyId: apiKey.keyId,
					userId: apiKey.userId,
					userEmail: apiKey.userEmail,
					ingressHost: apiKey.ingressHost,
					modelId: baseModelId,
					providerId: chosenRoute.providerId,
					providerModelName: chosenRoute.providerModelName,
					modelName: modelNameForLog,
					providerName: chosenRoute.providerName,
					requestBody: requestBodyForLog,
					requestProtocol: 'dashscope',
					requestOperation,
					upstreamProtocol: chosenRoute.upstreamProtocol,
					upstreamOperation: chosenRoute.upstreamOperation,
					modelSurfaceId: chosenRoute.modelSurfaceId,
					routePoolId: chosenRoute.routePoolId,
					routeTargetId: chosenRoute.targetId,
					adapter: chosenRoute.adapter,
					stickyTrace: stickyTraceSnapshot,
					routeGroup: effectiveRouteGroup,
					status,
					latencyMs: Date.now() - start,
					errorMessage,
					billing: {
						pricingContext: imagePricingContext,
						modelPricingProfileJson,
						catalogModelId: baseModelId,
						userChargedCostFactorsJson: apiKey.chargedCostFactors,
						routeGroup: effectiveRouteGroup,
						routePriceOverrideJson: chosenRoute.priceOverrideRaw,
						imageCount: response.ok ? (meta?.imageCount ?? 0) : 0,
					},
					effectiveImageCount: response.ok ? (meta?.imageCount ?? 0) : 0,
					resultConfirmed: response.ok && (meta?.imageCount ?? 0) > 0,
					providerKeyId: chosenRoute.providerKeyId ?? null,
					providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
					providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
					upstreamRequestId,
					timing: timing.snapshot(),
					circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
					suppressErrorAlert: suppressErrorAlert || undefined,
				});
				return;
			}
			const usage = await proxyResult.usagePromise.catch(() => null);
			await recordAudioUsage({
				repos,
				requestLogId: guardrailBudgetLease.requestId,
				apiKeyId: apiKey.keyId,
				workspaceId: apiKey.workspaceId,
				userId: apiKey.userId,
				userEmail: apiKey.userEmail,
				ingressHost: apiKey.ingressHost,
				modelId: baseModelId,
				providerId: chosenRoute.providerId,
				providerModelName: chosenRoute.providerModelName,
				modelName: modelNameForLog,
				providerName: chosenRoute.providerName,
				requestBody: requestBodyForLog,
				requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
				requestOrigin: new URL(c.req.url).origin,
				...generationRequestContext(c.req.raw.headers),
				responseStreamed: true,
				requestProtocol: 'dashscope',
				requestOperation,
				upstreamProtocol: chosenRoute.upstreamProtocol,
				upstreamOperation: chosenRoute.upstreamOperation,
				modelSurfaceId: chosenRoute.modelSurfaceId,
				routePoolId: chosenRoute.routePoolId,
				routeTargetId: chosenRoute.targetId,
				adapter: chosenRoute.adapter,
				stickyTrace: stickyTraceSnapshot,
				routeGroup: effectiveRouteGroup,
				status,
				chargeOnError,
				latencyMs: Date.now() - start,
				errorMessage,
				billing: {
					endpoint: chosenRoute.endpoint ?? null,
					operation:
						requestOperation === 'audio.speech.multimodal'
							? 'audio.speech.multimodal'
							: 'audio.transcriptions.multimodal',
					modelPricingProfileJson,
					catalogModelId: baseModelId,
					userChargedCostFactorsJson: apiKey.chargedCostFactors,
					routeGroup: effectiveRouteGroup,
					routePriceOverrideJson: chosenRoute.priceOverrideRaw,
					durationSeconds,
					durationSource,
					fileBytes: 0,
					characters: response.ok ? (meta?.audioCharacters ?? usage?.audio_characters ?? null) : null,
					requestStartedAtMs: start,
					businessTimezone,
				},
				providerKeyId: chosenRoute.providerKeyId ?? null,
				providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
				providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
				upstreamRequestId,
				timing: timing.snapshot(),
				circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
				suppressErrorAlert: suppressErrorAlert || undefined,
				guardrailBudgetSettlement:
					guardrailBudgetLease.reserved && !guardrailBudgetLease.terminal
						? {
								requestId: guardrailBudgetLease.requestId,
								usageUnavailable,
								...(usageUnavailable ? { mode: 'reserved' as const } : {}),
							}
						: undefined,
				ordinaryBudgetSettlement:
					ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
						? {
								requestId: requestCorrelationId,
								budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
								reservedMicros: ordinaryBudgetLease.reservedMicros,
								unknownCost: usageUnavailable,
							}
						: undefined,
			});
		})().catch(async (error) => {
			console.error(
				`[Gateway Audio] record DashScope multimodal usage failed baseModelId=${baseModelId} error=${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			await terminateMultimodalGuardrailBudget(guardrailBudgetLease, 'request_usage_settlement_failed');
			await terminateMultimodalOrdinaryBudget(
				ordinaryBudgetLease,
				requestCorrelationId,
				'request_usage_settlement_failed',
			);
		}),
	);
	return response;
}

async function forwardNativeMultimodal(
	c: MultimodalContext,
	rawModelId: string,
	body: Record<string, unknown>,
	operation: string,
	start: number,
	timing: RequestTimingCollector,
): Promise<Response> {
	const policy = await prepareNativeMediaPolicy(c, { rawModelId, body, protocol: 'dashscope', operation, start });
	if (policy instanceof Response) return policy;
	const apiKey = c.get('apiKey');
	const repos = c.get('repositories');
	const selected = policy.selected;
	const model = selected.model;
	const image = operation === 'images.generations.multimodal';
	const imagePricingContext = image ? await createImagePricingContext(repos, start) : undefined;
	const businessTimezone = imagePricingContext?.businessTimezone ?? (await getBusinessTimezone(repos));
	const parameters = policy.body.parameters as Record<string, unknown> | undefined;
	const count = parameters?.n ?? 1;
	if (image && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 15))
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'parameters.n must be an integer between 1 and 15',
		});
	const input = policy.body.input as Record<string, unknown> | undefined;
	const characters = typeof input?.text === 'string' ? Array.from(input.text).length : 0;
	const billing = {
		modelPricingProfileJson: model.pricing_profile ?? null,
		catalogModelId: selected.baseModelId,
		userChargedCostFactorsJson: apiKey.chargedCostFactors,
		routeGroup: selected.effectiveRouteGroup,
		requestStartedAtMs: start,
		businessTimezone,
	};
	const estimate = image
		? await estimateImageBudgetPrecheck(
				repos,
				{ ...billing, pricingContext: imagePricingContext, imageCount: count as number },
				selected.routes.map((route) => route.priceOverrideRaw),
			)
		: await estimateAudioSpeechBudgetPrecheck(
				repos,
				{ ...billing, inputCharacters: characters },
				selected.routes.map((route) => route.priceOverrideRaw),
			);
	const native = await admitNativeMediaRequest(c, policy, estimate);
	const result = await native.dispatch(() =>
		proxyDashScopeJsonPassthrough(
			repos,
			selected.routes,
			operation as DashScopePassthroughSurface,
			policy.body,
			c.req.raw.signal,
			{
				...native.options,
				affinityKey: buildAffinityKey(apiKey.userId, selected.baseModelId, selected.effectiveRouteGroup, 'dashscope'),
				tierKeyPrefix: buildTierKeyPrefix(selected.baseModelId, selected.effectiveRouteGroup, 'dashscope'),
				strategy: selected.strategy.base,
				tierStrategies: selected.strategy.tierOverrides,
				timing,
				sticky: selected.hasProviderPreferences ? null : stickyConfigFromSurface(selected.surface),
				inboundHeaders: c.req.raw.headers,
				dashScopeJson: { sse: c.req.header('X-DashScope-SSE') },
			},
		),
	);
	return finalizeMultimodalResponse({
		c,
		proxyResult: result,
		apiKey,
		repos,
		baseModelId: selected.baseModelId,
		effectiveRouteGroup: selected.effectiveRouteGroup,
		modelNameForLog: modelDisplayName(model, selected.baseModelId),
		requestBodyForLog: finalizeRequestLogJson(redactDashScopeMultimodalBodyForLog(policy.body)),
		businessTimezone,
		start,
		timing,
		guardrail: policy.guardrail,
		requestedModelId: rawModelId,
		requestCorrelationId: policy.requestId,
		guardrailBudgetLease: routeAwareMultimodalGuardrailLease(native.admission),
		ordinaryBudgetLease: native.admission.ordinaryLease,
		requestOperation: operation,
		modelPricingProfileJson: model.pricing_profile ?? null,
		imagePricingContext,
	});
}
