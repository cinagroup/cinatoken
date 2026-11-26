import { resolveModelKind } from '@octafuse/core';

import { resolveRoutesForSurface } from '../../services/model-router';
import { EMPTY_USAGE, proxyDashScopeRealtimeDeferred } from '../../services/proxy';

import {
	DashScopeRealtimeClientSession,
	dashScopeInferenceOperationForTask,
	type DeferredRealtimeRuntime,
} from '../../services/egress/dashscope-realtime-session';
import { createWorkersDeferredRealtime } from '../../services/egress/dashscope-realtime-driver';

import { resolveModelRouting } from '../../services/resolve-model-route-group';
import { resolveRouteStrategyPlan } from '../../services/route-strategies';
/**
 * DashScope 原生实时音频入口：
 * `GET /v1/dashscope/realtime?model=<gateway-model>&operation=<native-operation>`
 *
 * 下游使用网关 API Key，上游使用路由选中的 DashScope API Key。事件保持 DashScope 原生语义。
 */
import type { AudioEndpointPricingOperation, GatewayRepositories, ModelRow } from '@octafuse/core';
import { getBusinessTimezone } from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import {
	DASHSCOPE_REALTIME_OPERATIONS,
	type DashScopeRealtimeOperation,
} from '../../services/egress/dashscope-realtime-driver';
import { GatewayErrorCode, NO_AVAILABLE_ROUTE_MESSAGE } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { proxyDashScopeRealtime, type UsageFromStream } from '../../services/proxy';

import {
	audioGuardrailBudgetMicros,
	estimateAudioBudgetPrecheck,
	recordAudioUsage,
} from '../../services/audio-usage-charge';
import { buildAffinityKey, buildTierKeyPrefix } from '../../services/route-strategies';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { parseDashScopeRealtimeAuthProtocol } from '@octafuse/core/realtime-protocol';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import { runRequestGuardrails } from '../../services/request-guardrails';
import {
	dashScopeRealtimeCriticalSettlement,
	DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
	DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
	DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS,
	DASHSCOPE_REALTIME_MAX_CLIENT_BYTES,
	DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
	DASHSCOPE_REALTIME_MAX_SESSION_MS,
} from '../../services/dashscope-realtime-guardrails';
import type { OrdinaryBudgetLease } from '../../services/ordinary-budget-lifecycle';
import { selectConservativeMultimediaBudgetEstimate } from '../../services/multimedia-ordinary-budget';
import type { OrdinaryBudgetUsageSettlement } from '../../services/usage-tracker';
import { routeUsesUnsupportedMultimediaEndpointPriceSelection } from '../../services/endpoint-billing-pricing';
import { generationRequestContext } from '../../services/generation-request-context';
import { privateByokContextForApiKey } from '../../services/byok-key-pool';
import {
	createRouteAwareBudgetAdmission,
	type RouteAwareBudgetAdmission,
} from '../../services/request-budget-admission';

type RealtimeEnv = Env & { Variables: { apiKey: ApiKeyContext } };
type RealtimeContext = Context<RealtimeEnv>;

export const dashScopeRealtimeRoutes = new Hono<RealtimeEnv>();

dashScopeRealtimeRoutes.use('*', requireApiKey);

function isRealtimeOperation(value: string): value is DashScopeRealtimeOperation {
	return (DASHSCOPE_REALTIME_OPERATIONS as readonly string[]).includes(value);
}

export function dashScopeRealtimeProvableBillingOperation(
	operation: DashScopeRealtimeOperation,
): AudioEndpointPricingOperation | null {
	return operation === 'audio.transcriptions.realtime.inference' ||
		operation === 'audio.transcriptions.realtime.session'
		? operation
		: null;
}

export function dashScopeRealtimeUnprovableOperationMessage(operation: DashScopeRealtimeOperation): string | null {
	if (operation === 'audio.speech.realtime.session') {
		return 'DashScope realtime TTS sessions require independent inference pricing; session creation itself is not billable';
	}
	if (operation === 'audio.speech.realtime.inference') {
		return 'DashScope realtime TTS cannot prove an operation-specific Unicode code-point ceiling before upstream dispatch';
	}
	return null;
}

export function dashScopeRealtimePricingCeilingFailureContract(estimatedChargedCost: number | null): {
	status: 502;
	code: typeof GatewayErrorCode.routeResolutionFailed;
	message: string;
} | null {
	return estimatedChargedCost === null
		? {
				status: 502,
				code: GatewayErrorCode.routeResolutionFailed,
				message: 'DashScope realtime pricing cannot prove a finite charged-cost ceiling for every eligible route',
			}
		: null;
}

export function dashScopeRealtimeEndpointSettlementMode(params: {
	operation: DashScopeRealtimeOperation;
	errorMessage: string | null;
	initialHandshakeError: boolean;
	upstreamOutcomeUnknown: boolean;
	durationSeconds: number | null | undefined;
	durationSource?: 'upstream' | 'media' | 'client' | 'estimated' | 'precheck';
}): 'actual' | 'known_zero' | 'forfeit' {
	if (params.upstreamOutcomeUnknown) return 'forfeit';
	if (params.errorMessage && params.initialHandshakeError) return 'known_zero';
	if (params.errorMessage || params.initialHandshakeError) return 'forfeit';
	if (dashScopeRealtimeProvableBillingOperation(params.operation) == null) return 'forfeit';
	if (
		typeof params.durationSeconds !== 'number' ||
		!Number.isFinite(params.durationSeconds) ||
		params.durationSeconds < 0 ||
		(params.durationSource !== 'upstream' && params.durationSource !== 'media' && params.durationSource !== 'client')
	) {
		return 'forfeit';
	}
	return 'actual';
}

function realtimeErrorMessage(usage: UsageFromStream): string | null {
	if (usage.stream_error) return `Realtime stream failed: ${usage.stream_error}`;
	if (usage.cancelled) return 'Client disconnected before realtime audio completed';
	return null;
}

function modelDisplayName(model: { display_name?: string | null }, baseModelId: string): string {
	const displayName = model.display_name == null ? '' : String(model.display_name).trim();
	return displayName || baseModelId;
}

type RealtimeGuardrailBudgetLease = {
	requestId: string;
	reserved: boolean;
	readonly dispatched: boolean;
	release(reason: string): Promise<void>;
	forfeit(reason: string): Promise<void>;
};

function routeAwareRealtimeGuardrailLease(admission: RouteAwareBudgetAdmission): RealtimeGuardrailBudgetLease {
	return {
		requestId: admission.ordinaryLease.requestId,
		get reserved() {
			return admission.guardrailReserved;
		},
		get dispatched() {
			return admission.guardrailDispatched;
		},
		release: (reason) => admission.releaseGuardrailPreDispatch(reason),
		forfeit: (reason) => admission.terminateGuardrailUnknown(reason),
	};
}

function realtimeOrdinaryBudgetSettlement(
	lease: OrdinaryBudgetLease,
	unknownCost: boolean,
): OrdinaryBudgetUsageSettlement | undefined {
	if (!lease.reserved) return undefined;
	if (lease.budgetEpoch == null || lease.reservedMicros <= 0) {
		throw new Error('Realtime ordinary budget lease is missing settlement metadata');
	}
	return {
		requestId: lease.requestId,
		budgetEpoch: lease.budgetEpoch,
		reservedMicros: lease.reservedMicros,
		unknownCost,
	};
}

async function cleanupRealtimeBudgets(
	ordinary: OrdinaryBudgetLease,
	guardrail: RealtimeGuardrailBudgetLease,
	reason: string,
	preDispatchOnly = false,
): Promise<void> {
	// Each ledger owns independent durable work. A rejected write in one must
	// neither skip its sibling nor orphan the usage promise after an Upgrade.
	const actions = [
		{
			ledger: 'guardrail',
			run: async () => {
				if (!guardrail.dispatched) await guardrail.release(reason);
				else if (!preDispatchOnly) await guardrail.forfeit(reason);
			},
		},
		{
			ledger: 'ordinary',
			run: async () => {
				if (ordinary.state === 'reserved') await ordinary.releasePreDispatch(reason);
				else if (!preDispatchOnly) await ordinary.terminateUnknown(reason);
			},
		},
	];
	const results = await Promise.allSettled(actions.map((action) => action.run()));
	for (const [index, result] of results.entries()) {
		if (result.status !== 'rejected') continue;
		// Persistence exceptions can contain SQL bindings. Retain the durable
		// reservation for recovery and log only request/ledger/fixed reason.
		console.error(
			JSON.stringify({
				message: 'realtime budget cleanup failed',
				requestId: ordinary.requestId,
				ledger: actions[index]!.ledger,
				reason,
			}),
		);
	}
}

function recordRealtimeUsage(params: {
	c: RealtimeContext;
	repos: GatewayRepositories;
	apiKey: ApiKeyContext;
	model: ModelRow;
	baseModelId: string;
	effectiveRouteGroup: string;
	operation: DashScopeRealtimeOperation;
	billingOperation: AudioEndpointPricingOperation;
	businessTimezone: string;
	start: number;
	timing: RequestTimingCollector;
	proxyResult: Awaited<ReturnType<typeof proxyDashScopeRealtime>>;
	guardrailBudgetLease: RealtimeGuardrailBudgetLease;
	ordinaryBudgetLease: OrdinaryBudgetLease;
	initialErrorMessage?: string | null;
}): void {
	const {
		c,
		repos,
		apiKey,
		model,
		baseModelId,
		effectiveRouteGroup,
		operation,
		billingOperation,
		businessTimezone,
		start,
		timing,
		proxyResult,
		guardrailBudgetLease,
		ordinaryBudgetLease,
		initialErrorMessage,
	} = params;
	const route = proxyResult.chosenRoute;
	scheduleBackgroundWork(
		c,
		proxyResult.usagePromise
			.then(async (usage) => {
				const errorMessage = initialErrorMessage ?? realtimeErrorMessage(usage);
				const status: 'success' | 'error' = errorMessage ? 'error' : 'success';
				const durationSeconds = usage.audio_duration_seconds ?? 0;
				// The driver emits "client" only for mono 16-bit PCM that its
				// per-session limiter measured locally. The shared audio settlement
				// contract names that trusted local-media evidence "media".
				const durationSource =
					usage.audio_duration_source === 'client' ? ('media' as const) : usage.audio_duration_source;
				// A rejected HTTP handshake is known-zero. Once a WebSocket was
				// upgraded, an incomplete/error stream may already have delivered
				// useful billable output. A successful terminal event must also carry
				// the metric required by the configured billing mode (or a locally
				// verified limiter measurement) before either ledger settles actual.
				const settlementMode = dashScopeRealtimeEndpointSettlementMode({
					operation,
					errorMessage,
					initialHandshakeError: initialErrorMessage != null,
					upstreamOutcomeUnknown: proxyResult.meta?.upstreamOutcomeUnknown === true,
					durationSeconds: usage.audio_duration_seconds,
					durationSource,
				});
				const criticalSettlement = dashScopeRealtimeCriticalSettlement(settlementMode);
				await recordAudioUsage({
					repos,
					requestLogId: guardrailBudgetLease.requestId,
					apiKeyId: apiKey.keyId,
					workspaceId: apiKey.workspaceId,
					userId: apiKey.userId,
					userEmail: apiKey.userEmail,
					ingressHost: apiKey.ingressHost,
					modelId: baseModelId,
					providerId: route.providerId,
					providerModelName: route.providerModelName,
					modelName: modelDisplayName(model, baseModelId),
					providerName: route.providerName,
					requestBody: JSON.stringify({
						kind: 'dashscope_realtime',
						operation,
					}),
					requestBodyLoggingMode: c.get('requestBodyLoggingMode'),
					requestOrigin: new URL(c.req.url).origin,
					...generationRequestContext(c.req.raw.headers),
					responseStreamed: true,
					requestProtocol: 'dashscope',
					requestOperation: operation,
					upstreamProtocol: route.upstreamProtocol,
					upstreamOperation: route.upstreamOperation,
					modelSurfaceId: route.modelSurfaceId,
					routePoolId: route.routePoolId,
					routeTargetId: route.targetId,
					adapter: route.adapter,
					routeGroup: effectiveRouteGroup,
					status,
					latencyMs: Date.now() - start,
					errorMessage,
					billing: {
						endpoint: route.endpoint ?? null,
						operation: billingOperation,
						catalogModelId: baseModelId,
						userChargedCostFactorsJson: apiKey.chargedCostFactors,
						routeGroup: effectiveRouteGroup,
						routePriceOverrideJson: route.priceOverrideRaw,
						durationSeconds,
						durationSource,
						requestStartedAtMs: start,
						businessTimezone,
					},
					providerKeyId: route.providerKeyId ?? null,
					providerKeyLabel: route.providerKeyLabel ?? null,
					providerKeyFingerprint: route.providerKeyFingerprint ?? null,
					upstreamRequestId: proxyResult.upstreamRequestId,
					timing: timing.snapshot(),
					circuitEvents: proxyResult.circuitEvents.length > 0 ? proxyResult.circuitEvents : undefined,
					suppressErrorAlert: proxyResult.suppressErrorAlert || undefined,
					guardrailBudgetSettlement:
						guardrailBudgetLease.reserved && guardrailBudgetLease.dispatched
							? {
									requestId: guardrailBudgetLease.requestId,
									mode: criticalSettlement.guardrailMode,
									usageUnavailable: criticalSettlement.ordinaryUnknownCost,
								}
							: undefined,
					ordinaryBudgetSettlement:
						ordinaryBudgetLease.state === 'dispatched'
							? realtimeOrdinaryBudgetSettlement(ordinaryBudgetLease, criticalSettlement.ordinaryUnknownCost)
							: undefined,
				});
				await cleanupRealtimeBudgets(
					ordinaryBudgetLease,
					guardrailBudgetLease,
					'realtime_upstream_dispatch_not_started',
					true,
				);
			})
			.catch(async () => {
				console.error(
					JSON.stringify({ message: 'realtime usage settlement failed', requestId: ordinaryBudgetLease.requestId }),
				);
				await cleanupRealtimeBudgets(ordinaryBudgetLease, guardrailBudgetLease, 'realtime_usage_settlement_failed');
			}),
	);
}

async function handleGuardedRealtime(c: RealtimeContext, input?: {model: string; operation: DashScopeRealtimeOperation; dispatch?: import('../../services/egress/dashscope-realtime-driver').DashScopeRealtimeNodeDispatch}): Promise<Response> {
	const start = Date.now();
	if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
		return gatewayErrorJson(c, {
			status: 426,
			code: GatewayErrorCode.invalidRequest,
			message: 'Expected a WebSocket upgrade request',
		});
	}
	const rawModelId = input?.model ?? c.req.query('model')?.trim() ?? '';
	if (!rawModelId) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.missingModel,
			message: 'Missing model query parameter',
		});
	}
	const operationRaw = input?.operation ?? c.req.query('operation')?.trim() ?? '';
	if (!isRealtimeOperation(operationRaw)) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: `Unsupported realtime operation: ${operationRaw || '(empty)'}`,
		});
	}

	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const requestCorrelationId = crypto.randomUUID();
	const guardrail = await runRequestGuardrails(repos, {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelIds: [rawModelId],
		body: { model: rawModelId, stream: true },
		correlationId: requestCorrelationId,
		now: new Date(start),
		// User text/audio arrives in later WebSocket frames. Until those frames can
		// be filtered through a pinned streaming policy, assigned input filters
		// must reject the upgrade instead of silently scanning an empty body.
		inputFilterSupport: 'unsupported',
	});
	if (!guardrail.ok) {
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code:
				guardrail.code === 'guardrail_invalid' ? GatewayErrorCode.guardrailInvalid : GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	}

	// Using the guarded body here is what makes allowed_providers and require_zdr
	// effective; the planner filters provider routes and verifies ZDR evidence.
	const fallbackPlan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body: guardrail.body,
		requestProtocol: 'dashscope',
		requestOperation: operationRaw,
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
			message: 'provider.max_price and provider.sort=price are unavailable for DashScope realtime audio',
		});
	}
	const unprovableOperation = dashScopeRealtimeUnprovableOperationMessage(operationRaw);
	const billingOperation = dashScopeRealtimeProvableBillingOperation(operationRaw);
	if (unprovableOperation || !billingOperation) {
		return gatewayErrorJson(c, {
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: unprovableOperation ?? 'DashScope realtime operation has no provable endpoint pricing contract',
		});
	}
	const businessTimezone = await getBusinessTimezone(repos);
	const estimateSelection = selectConservativeMultimediaBudgetEstimate(
		await Promise.all(
			routes.map((route) =>
				estimateAudioBudgetPrecheck(
					repos,
					{
						endpoint: route.endpoint ?? null,
						operation: billingOperation,
						catalogModelId: baseModelId,
						userChargedCostFactorsJson: apiKey.chargedCostFactors,
						fileBytes: DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS * 16_000 * 2,
						mimeType: 'audio/pcm',
						verifiedDurationCeilingSeconds: DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
						requestStartedAtMs: start,
						businessTimezone,
					},
					[route.priceOverrideRaw],
				),
			),
		),
	);
	if (!estimateSelection) throw new Error('Realtime fallback plan has no billable route estimate');
	const { estimate, estimatedChargedCost, estimatedStandardCost } = estimateSelection;
	const pricingCeilingFailure = dashScopeRealtimePricingCeilingFailureContract(estimatedChargedCost);
	if (pricingCeilingFailure) return gatewayErrorJson(c, pricingCeilingFailure);
	const sessionLimits = {
		maxSessionMs: DASHSCOPE_REALTIME_MAX_SESSION_MS,
		connectDeadlineAtMs: start + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
		maxAudioDurationSeconds: DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS,
		maxBillableAudioDurationSeconds: DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
		// Realtime TTS is rejected before dispatch; no recursive string or UTF-16
		// counter participates in Endpoint billing for the admitted ASR session.
		maxTextCharacters: 0,
		maxClientMessageBytes: DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
		maxClientBytes: DASHSCOPE_REALTIME_MAX_CLIENT_BYTES,
		requirePcmAudio: true,
	};
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
	const guardrailBudgetLease = routeAwareRealtimeGuardrailLease(budgetAdmission);
	const timing = new RequestTimingCollector();
	timing.markGatewayComplete();
	let proxyResult: Awaited<ReturnType<typeof proxyDashScopeRealtime>>;
	try {
		proxyResult = await proxyDashScopeRealtime(repos, routes, operationRaw, c.req.raw.signal, {
			nodeDispatch: input?.dispatch ?? c.env.NODE_REALTIME_DISPATCH,
			inboundHeaders: c.req.raw.headers,
			responseProtocol: parseDashScopeRealtimeAuthProtocol(c.req.header('Sec-WebSocket-Protocol'))?.protocol,
			affinityKey: buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'dashscope'),
			tierKeyPrefix: buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'dashscope'),
			strategy: selectedPlan.strategy.base,
			tierStrategies: selectedPlan.strategy.tierOverrides,
			timing,
			routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
			sticky: selectedPlan.hasProviderPreferences ? null : stickyConfigFromSurface(selectedPlan.surface),
			beforeUpstreamDispatch: (route) => budgetAdmission.beforeUpstreamDispatch(route),
			sessionLimits,
			byok: privateByokContextForApiKey(apiKey),
		});
	} catch (error) {
		await cleanupRealtimeBudgets(ordinaryBudgetLease, guardrailBudgetLease, 'realtime_upstream_dispatch_failed');
		throw error;
	}
	await cleanupRealtimeBudgets(
		ordinaryBudgetLease,
		guardrailBudgetLease,
		'realtime_upstream_dispatch_not_started',
		true,
	);
	const nodeUpgrade =
		(input?.dispatch ?? c.env.NODE_REALTIME_DISPATCH) != null && proxyResult.response.headers.get('x-octafuse-realtime-upgrade') === '1';
	if (
		!nodeUpgrade &&
		(proxyResult.response.status !== 101 || !('webSocket' in proxyResult.response) || !proxyResult.response.webSocket)
	) {
		recordRealtimeUsage({
			c,
			repos,
			apiKey,
			model,
			baseModelId,
			effectiveRouteGroup,
			operation: operationRaw,
			billingOperation,
			businessTimezone,
			start,
			timing,
			proxyResult,
			guardrailBudgetLease,
			ordinaryBudgetLease,
			initialErrorMessage: `Realtime upstream handshake failed: HTTP ${proxyResult.response.status}`,
		});
		return proxyResult.response;
	}

	recordRealtimeUsage({
		c,
		repos,
		apiKey,
		model,
		baseModelId,
		effectiveRouteGroup,
		operation: operationRaw,
		billingOperation,
		businessTimezone,
		start,
		timing,
		proxyResult,
		guardrailBudgetLease,
		ordinaryBudgetLease,
	});
	return proxyResult.response;
}

dashScopeRealtimeRoutes.get('/', c => handleGuardedRealtime(c));

/** 官方 session 协议入口：`/dashscope/api-ws/v1/realtime?model=`。 */
export const dashScopeRealtimeSessionRoutes = new Hono<RealtimeEnv>();

/** 官方 run-task 协议入口：`/dashscope/api-ws/v1/inference`，延迟连接上游。 */
export const dashScopeRealtimeInferenceRoutes = new Hono<RealtimeEnv>();


function isSpeechOperation(operation: DashScopeRealtimeOperation): boolean {
	return operation.startsWith('audio.speech.');
}


function requireWebSocketUpgrade(c: RealtimeContext): Response | null {
	if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') return null;
	return gatewayErrorJson(c, {
		status: 426,
		code: GatewayErrorCode.invalidRequest,
		message: 'Expected a WebSocket upgrade request',
	});
}


function failoverOptionsFor(params: {
	apiKey: ApiKeyContext;
	baseModelId: string;
	effectiveRouteGroup: string;
	strategyPlan: Awaited<ReturnType<typeof resolveRouteStrategyPlan>>;
	timing: RequestTimingCollector;
	inboundHeaders: Headers;
}) {
	const { apiKey, baseModelId, effectiveRouteGroup, strategyPlan, timing, inboundHeaders } = params;
	return {
		affinityKey: buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'dashscope'),
		tierKeyPrefix: buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'dashscope'),
		strategy: strategyPlan.base,
		tierStrategies: strategyPlan.tierOverrides,
		timing,
		inboundHeaders,
	};
}


/**
 * 升级前选路由并连上游（旧入口与 session 入口共用）。
 * `pickOperation` 在模型解析之后决定 operation；返回 `Response` 表示直接用它拒绝请求。
 */
async function connectUpfront(
	c: RealtimeContext,
	start: number,
	rawModelId: string,
	pickOperation: (model: ModelRow) => DashScopeRealtimeOperation | Response
): Promise<Response> {
 const resolved = await resolveModelRouting(c.get('repositories'), rawModelId);
 if (!resolved) return gatewayErrorJson(c,{status:404,code:GatewayErrorCode.modelNotFound,message:'Model not found'});
 const operation = pickOperation(resolved.model);
 if (operation instanceof Response) return operation;
 return handleGuardedRealtime(c, {model:rawModelId,operation});
}


/** 上游连不上时从 failover 的最后一个响应里取 `task-failed` 的 code / message。 */
async function describeFailedResponse(
	response: Response
): Promise<{ code: string; message: string }> {
	const headerCode = response.headers.get('X-OctaFuse-Error-Code');
	let message = '';
	let bodyCode = '';
	try {
		const body = (await response.clone().json()) as {
			code?: unknown;
			error?: unknown;
			message?: unknown;
		};
		if (typeof body.code === 'string') bodyCode = body.code;
		if (typeof body.error === 'string') message = body.error;
		else if (body.error && typeof body.error === 'object') {
			const nested = (body.error as { message?: unknown }).message;
			if (typeof nested === 'string') message = nested;
		}
		if (!message && typeof body.message === 'string') message = body.message;
	} catch {
		// 非 JSON 响应体，退回状态码
	}
	return {
		code: headerCode || bodyCode || GatewayErrorCode.upstreamRequestFailed,
		message: message || `Upstream request failed (HTTP ${response.status})`,
	};
}


/**
 * inference 入口的会话：下游升级已完成，等 run-task 之后选路由、连上游、桥接。
 * 升级之后不能再回 HTTP 错误码，所有失败都按 DashScope 格式回 `task-failed` 再关闭。
 */
async function runDeferredInferenceSession(params: {
	c: RealtimeContext;
	runtime: DeferredRealtimeRuntime;
	repos: GatewayRepositories;
	apiKey: ApiKeyContext;
	start: number;
	inboundHeaders: Headers;
}): Promise<void> {
	const { c, runtime, repos, apiKey, start, inboundHeaders } = params;
	const session = new DashScopeRealtimeClientSession(runtime.client);
	const waited = await session.waitForRunTask();
	if (!waited.ok) return;
	const request = waited.request;
	const fail = (code: string, message: string) => {
		session.failAndClose(request.taskId, code, message);
	};

	const operation = dashScopeInferenceOperationForTask(request.task);
	if (!operation) {
		return fail(
			'InvalidParameter',
			`Unsupported payload.task: ${request.task || '(empty)'}; expected "asr" or "tts"`
		);
	}
	if (!request.model) {
		return fail('InvalidParameter', 'Missing payload.model in run-task');
	}
 const dispatch: import('../../services/egress/dashscope-realtime-driver').DashScopeRealtimeNodeDispatch = async (
  route, selectedOperation, signal, timing, attempt, limits, beforeDispatch,
 ) => {
  await beforeDispatch?.();
  signal?.throwIfAborted();
  const opened = await runtime.connectUpstream(route, selectedOperation, signal, timing, attempt);
  if ('response' in opened) return {response:opened.response,usagePromise:Promise.resolve(EMPTY_USAGE),upstreamRequestId:opened.requestId};
  if (session.isClientClosed) { opened.socket.close(1000,'Client closed'); return {response:new Response(null,{status:499}),usagePromise:Promise.resolve(EMPTY_USAGE),upstreamRequestId:opened.requestId,meta:{upstreamOutcomeUnknown:true,failoverForbidden:true}}; }
  return {response:new Response(null,{headers:{'X-Octafuse-Realtime-Upgrade':'1'}}),usagePromise:session.bridge({upstream:opened.socket,route,operation:selectedOperation,model:request.model,timing,sessionLimits:limits}),upstreamRequestId:opened.requestId};
 };
 try {
  const response = await handleGuardedRealtime(c, {model:request.model,operation,dispatch});
  if (response.headers.get('X-Octafuse-Realtime-Upgrade') !== '1') {
   const failure = await describeFailedResponse(response);
   fail(failure.code,failure.message);
  }
 } catch { fail(GatewayErrorCode.upstreamRequestFailed,'Realtime session failed'); }
}

// Both official surfaces retain authentication before accepting a WebSocket.
dashScopeRealtimeSessionRoutes.use('*', requireApiKey);
dashScopeRealtimeInferenceRoutes.use('*', requireApiKey);
dashScopeRealtimeSessionRoutes.get('/', async c => {
 const invalid = requireWebSocketUpgrade(c); if (invalid) return invalid;
 const model = c.req.query('model')?.trim() ?? '';
 if (!model) return gatewayErrorJson(c,{status:400,code:GatewayErrorCode.missingModel,message:'Missing model query parameter'});
 return connectUpfront(c,Date.now(),model, row => resolveModelKind(row) === 'tts' ? 'audio.speech.realtime.session' : 'audio.transcriptions.realtime.session');
});
dashScopeRealtimeInferenceRoutes.get('/', async c => {
 const invalid = requireWebSocketUpgrade(c); if (invalid) return invalid;
 const nodeRuntime = await c.env.NODE_REALTIME_DEFERRED?.();
 const worker = nodeRuntime ? null : createWorkersDeferredRealtime({responseProtocol:parseDashScopeRealtimeAuthProtocol(c.req.header('Sec-WebSocket-Protocol'))?.protocol});
 const runtime = nodeRuntime ?? worker?.runtime;
 if (!runtime) return gatewayErrorJson(c,{status:501,code:GatewayErrorCode.invalidRequest,message:'Realtime runtime unavailable'});
 scheduleBackgroundWork(c,runDeferredInferenceSession({c,runtime,repos:c.get('repositories'),apiKey:c.get('apiKey'),start:Date.now(),inboundHeaders:c.req.raw.headers}));
 return worker?.response ?? new Response(null,{headers:{'X-Octafuse-Realtime-Upgrade':'1'}});
});
