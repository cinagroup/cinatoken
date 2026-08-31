/**
 * DashScope 原生实时音频入口：
 * `GET /v1/dashscope/realtime?model=<gateway-model>&operation=<native-operation>`
 *
 * 下游使用网关 API Key，上游使用路由选中的 DashScope API Key。事件保持 DashScope 原生语义。
 */
import type {
	AudioEndpointPricingOperation,
	GatewayRepositories,
	GuardrailBudgetIntent,
	ModelRow,
} from '@octafuse/core';
import { getBusinessTimezone } from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import {
	DASHSCOPE_REALTIME_OPERATIONS,
	type DashScopeRealtimeOperation,
} from '../../services/egress/dashscope-realtime-driver';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { proxyDashScopeRealtime, type UsageFromStream } from '../../services/proxy';

import {
	audioGuardrailBudgetMicros,
	estimateAudioBudgetPrecheck,
	recordAudioUsage,
} from '../../services/audio-usage-charge';
import {
	buildAffinityKey,
	buildTierKeyPrefix,
} from '../../services/route-strategies';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { parseDashScopeRealtimeAuthProtocol } from '@octafuse/core/realtime-protocol';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import {
	forfeitRequestGuardrailBudgets,
	releaseRequestGuardrailBudgets,
	reserveRequestGuardrailBudgets,
	runRequestGuardrails,
} from '../../services/request-guardrails';
import {
	dashScopeRealtimeCriticalSettlement,
	DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
	DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
	DASHSCOPE_REALTIME_GUARDRAIL_LEASE_MS,
	DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS,
	DASHSCOPE_REALTIME_MAX_CLIENT_BYTES,
	DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
	DASHSCOPE_REALTIME_MAX_SESSION_MS,
} from '../../services/dashscope-realtime-guardrails';
import {
	reserveOrdinaryUserBudget,
	type OrdinaryBudgetLease,
} from '../../services/ordinary-budget-lifecycle';
import {
	markMultimediaBudgetsBeforeDispatch,
	selectConservativeMultimediaBudgetEstimate,
} from '../../services/multimedia-ordinary-budget';
import type { OrdinaryBudgetUsageSettlement } from '../../services/usage-tracker';
import { routeUsesUnsupportedMultimediaEndpointPriceSelection } from '../../services/endpoint-billing-pricing';

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
	return operation === 'audio.transcriptions.realtime.inference'
		|| operation === 'audio.transcriptions.realtime.session'
		? operation
		: null;
}

export function dashScopeRealtimeUnprovableOperationMessage(
	operation: DashScopeRealtimeOperation,
): string | null {
	if (operation === 'audio.speech.realtime.session') {
		return 'DashScope realtime TTS sessions require independent inference pricing; session creation itself is not billable';
	}
	if (operation === 'audio.speech.realtime.inference') {
		return 'DashScope realtime TTS cannot prove an operation-specific Unicode code-point ceiling before upstream dispatch';
	}
	return null;
}

export function dashScopeRealtimePricingCeilingFailureContract(
	estimatedChargedCost: number | null,
): {
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
		typeof params.durationSeconds !== 'number'
		|| !Number.isFinite(params.durationSeconds)
		|| params.durationSeconds < 0
		|| (params.durationSource !== 'upstream'
			&& params.durationSource !== 'media'
			&& params.durationSource !== 'client')
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
	markDispatched(): Promise<void>;
	release(reason: string): Promise<void>;
	forfeit(reason: string): Promise<void>;
};

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

async function terminateRealtimeOrdinaryBudgetSafely(
	lease: OrdinaryBudgetLease,
	reason: string,
): Promise<void> {
	try {
		await lease.terminateUnknown(reason);
	} catch (error) {
		console.error(
			`[Gateway Realtime] ordinary budget cleanup failed requestId=${lease.requestId} state=${lease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function admitRealtimeGuardrailBudget(
	repos: GatewayRepositories,
	params: {
		requestId: string;
		intents: GuardrailBudgetIntent[];
		reservedMicros: number;
	},
): Promise<
	| { ok: true; lease: RealtimeGuardrailBudgetLease }
	| { ok: false; blocked: boolean; reason?: 'gateway_key_limit' | 'workspace_budget' | 'guardrail_budget'; message: string }
> {
	const admission = await reserveRequestGuardrailBudgets(repos, params);
	if (!admission.ok) return admission;

	let dispatched = false;
	let terminal = false;
	let dispatchPromise: Promise<void> | null = null;
	return {
		ok: true,
		lease: {
			requestId: params.requestId,
			reserved: admission.reserved,
			get dispatched(): boolean {
				return dispatched;
			},
			async markDispatched(): Promise<void> {
				if (!admission.reserved || dispatched) return;
				dispatchPromise ??= (async () => {
					const dispatchedAt = new Date();
					const marked = await repos.guardrailBudgets.markDispatched(
						params.requestId,
						dispatchedAt.toISOString(),
						new Date(
							dispatchedAt.getTime() + DASHSCOPE_REALTIME_GUARDRAIL_LEASE_MS,
						).toISOString(),
					);
					if (!marked) {
						throw new Error('Realtime Guardrail budget reservation could not enter dispatched state');
					}
					dispatched = true;
				})();
				await dispatchPromise;
			},
			async release(reason: string): Promise<void> {
				if (!admission.reserved || terminal) return;
				if (dispatched) {
					throw new Error('A dispatched realtime Guardrail reservation cannot be released');
				}
				await releaseRequestGuardrailBudgets(
					repos,
					params.requestId,
					admission.reserved,
					reason,
				);
				terminal = true;
			},
			async forfeit(reason: string): Promise<void> {
				if (!admission.reserved || terminal) return;
				if (!dispatched) {
					await this.release(reason);
					return;
				}
				await forfeitRequestGuardrailBudgets(
					repos,
					params.requestId,
					admission.reserved,
					reason,
				);
				terminal = true;
			},
		},
	};
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
				const durationSource = usage.audio_duration_source === 'client'
					? 'media' as const
					: usage.audio_duration_source;
				// A rejected HTTP handshake is known-zero. Once a WebSocket was
				// upgraded, an incomplete/error stream may already have delivered
				// useful billable output. A successful terminal event must also carry
				// the metric required by the configured billing mode (or a locally
				// verified limiter measurement) before either ledger settles actual.
				const settlementMode = dashScopeRealtimeEndpointSettlementMode({
					operation,
					errorMessage,
					initialHandshakeError: initialErrorMessage != null,
					upstreamOutcomeUnknown:
						proxyResult.meta?.upstreamOutcomeUnknown === true,
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
					circuitEvents:
						proxyResult.circuitEvents.length > 0 ? proxyResult.circuitEvents : undefined,
					suppressErrorAlert: proxyResult.suppressErrorAlert || undefined,
					guardrailBudgetSettlement:
						guardrailBudgetLease.reserved &&
						guardrailBudgetLease.dispatched
						? {
								requestId: guardrailBudgetLease.requestId,
								mode: criticalSettlement.guardrailMode,
								usageUnavailable: criticalSettlement.ordinaryUnknownCost,
							}
						: undefined,
					ordinaryBudgetSettlement:
						ordinaryBudgetLease.state === 'dispatched'
							? realtimeOrdinaryBudgetSettlement(
								ordinaryBudgetLease,
								criticalSettlement.ordinaryUnknownCost,
							)
							: undefined,
				});
				if (guardrailBudgetLease.reserved && !guardrailBudgetLease.dispatched) {
					await guardrailBudgetLease.release('realtime_upstream_dispatch_not_started');
				}
				if (ordinaryBudgetLease.state === 'reserved') {
					await ordinaryBudgetLease.releasePreDispatch('realtime_upstream_dispatch_not_started');
				}
			})
			.catch(async (error) => {
				console.error(
					`[Gateway Realtime] record usage failed modelId=${baseModelId} error=${error instanceof Error ? error.message : String(error)}`
				);
				await (guardrailBudgetLease.dispatched
					? guardrailBudgetLease.forfeit('realtime_usage_settlement_failed')
					: guardrailBudgetLease.release('realtime_usage_write_failed_before_dispatch'))
					.catch((forfeitError: unknown) => {
						console.error(
							`[Gateway Realtime] guardrail forfeit failed requestId=${guardrailBudgetLease.requestId} error=${forfeitError instanceof Error ? forfeitError.message : String(forfeitError)}`,
						);
					});
				await terminateRealtimeOrdinaryBudgetSafely(
					ordinaryBudgetLease,
					'realtime_usage_settlement_failed',
				);
			})
	);
}

dashScopeRealtimeRoutes.get('/', async (c) => {
	const start = Date.now();
	if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
		return gatewayErrorJson(c, {
			status: 426,
			code: GatewayErrorCode.invalidRequest,
			message: 'Expected a WebSocket upgrade request',
		});
	}
	const rawModelId = c.req.query('model')?.trim() ?? '';
	if (!rawModelId) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.missingModel,
			message: 'Missing model query parameter',
		});
	}
	const operationRaw = c.req.query('operation')?.trim() ?? '';
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
			code: guardrail.code === 'guardrail_invalid'
				? GatewayErrorCode.guardrailInvalid
				: GatewayErrorCode.guardrailBlocked,
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
	const {
		model,
		baseModelId,
		effectiveRouteGroup,
		routes,
	} = selectedPlan;
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
	const estimateSelection = selectConservativeMultimediaBudgetEstimate(await Promise.all(
		routes.map((route) => estimateAudioBudgetPrecheck(repos, {
			endpoint: route.endpoint ?? null,
			operation: billingOperation,
			catalogModelId: baseModelId,
			userChargedCostFactorsJson: apiKey.chargedCostFactors,
			fileBytes:
				DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS * 16_000 * 2,
			mimeType: 'audio/pcm',
			verifiedDurationCeilingSeconds:
				DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
			requestStartedAtMs: start,
			businessTimezone,
		}, [route.priceOverrideRaw])),
	));
	if (!estimateSelection) throw new Error('Realtime fallback plan has no billable route estimate');
	const { estimate, estimatedChargedCost } = estimateSelection;
	const pricingCeilingFailure = dashScopeRealtimePricingCeilingFailureContract(
		estimatedChargedCost,
	);
	if (pricingCeilingFailure) return gatewayErrorJson(c, pricingCeilingFailure);
	const sessionLimits = {
		maxSessionMs: DASHSCOPE_REALTIME_MAX_SESSION_MS,
		connectDeadlineAtMs: start + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
		maxAudioDurationSeconds: DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS,
		maxBillableAudioDurationSeconds:
			DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
		// Realtime TTS is rejected before dispatch; no recursive string or UTF-16
		// counter participates in Endpoint billing for the admitted ASR session.
		maxTextCharacters: 0,
		maxClientMessageBytes: DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
		maxClientBytes: DASHSCOPE_REALTIME_MAX_CLIENT_BYTES,
		requirePcmAudio: true,
	};
	const ordinaryAdmission = await reserveOrdinaryUserBudget(repos, {
		requestId: requestCorrelationId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		budgetMax: apiKey.budgetMax,
		expectedBudgetEpoch: apiKey.budgetEpoch,
		estimatedChargedCost,
		now: new Date(start),
	});
	if (!ordinaryAdmission.ok) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: ordinaryAdmission.error.message,
		});
	}
	const ordinaryBudgetLease = ordinaryAdmission.lease;
	let budgetAdmission: Awaited<ReturnType<typeof admitRealtimeGuardrailBudget>>;
	try {
		budgetAdmission = await admitRealtimeGuardrailBudget(repos, {
			requestId: requestCorrelationId,
			intents: guardrail.budgetIntents,
			reservedMicros: audioGuardrailBudgetMicros(estimate.chargedCost),
		});
	} catch (error) {
		await terminateRealtimeOrdinaryBudgetSafely(
			ordinaryBudgetLease,
			'realtime_guardrail_admission_failed',
		);
		throw error;
	}
	if (!budgetAdmission.ok) {
		await terminateRealtimeOrdinaryBudgetSafely(
			ordinaryBudgetLease,
			'realtime_guardrail_admission_rejected',
		);
		if (budgetAdmission.blocked) {
			return gatewayErrorJson(c, {
				status: 403,
				code: budgetAdmission.reason === 'gateway_key_limit' || budgetAdmission.reason === 'workspace_budget' ? GatewayErrorCode.budgetExceeded : GatewayErrorCode.guardrailBlocked,
				message: budgetAdmission.message,
			});
		}
		throw new Error(`Realtime Guardrail budget admission failed: ${budgetAdmission.message}`);
	}
	const guardrailBudgetLease = budgetAdmission.lease;
	const timing = new RequestTimingCollector();
	timing.markGatewayComplete();
	let proxyResult: Awaited<ReturnType<typeof proxyDashScopeRealtime>>;
	try {
		proxyResult = await proxyDashScopeRealtime(
			repos,
			routes,
			operationRaw,
			c.req.raw.signal,
			{
				nodeDispatch: c.env.NODE_REALTIME_DISPATCH,
				responseProtocol: parseDashScopeRealtimeAuthProtocol(
					c.req.header('Sec-WebSocket-Protocol')
				)?.protocol,
				affinityKey: buildAffinityKey(
					apiKey.userId,
					baseModelId,
					effectiveRouteGroup,
					'dashscope'
				),
				tierKeyPrefix: buildTierKeyPrefix(
					baseModelId,
					effectiveRouteGroup,
					'dashscope'
				),
				strategy: selectedPlan.strategy.base,
				tierStrategies: selectedPlan.strategy.tierOverrides,
				timing,
				routePoolId:
					selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
				sticky: selectedPlan.hasProviderPreferences
					? null
					: stickyConfigFromSurface(selectedPlan.surface),
				beforeUpstreamDispatch: () => markMultimediaBudgetsBeforeDispatch({
					markGuardrail: () => guardrailBudgetLease.markDispatched(),
					markOrdinary: () => ordinaryBudgetLease.beforeUpstreamDispatch(),
					terminateOrdinary: () => terminateRealtimeOrdinaryBudgetSafely(
						ordinaryBudgetLease,
						'realtime_dispatch_transition_failed',
					),
					terminateGuardrail: () => guardrailBudgetLease.forfeit(
						'realtime_dispatch_transition_failed',
					),
				}),
				sessionLimits: {
					...sessionLimits,
					connectDeadlineAtMs:
						Date.now() + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
				},
			}
		);
	} catch (error) {
		if (guardrailBudgetLease.dispatched) {
			await guardrailBudgetLease.forfeit('realtime_upstream_dispatch_failed');
		} else {
			await guardrailBudgetLease.release('realtime_upstream_dispatch_not_started');
		}
		await terminateRealtimeOrdinaryBudgetSafely(
			ordinaryBudgetLease,
			'realtime_upstream_dispatch_failed',
		);
		throw error;
	}
	if (!guardrailBudgetLease.dispatched) {
		await guardrailBudgetLease.release('realtime_upstream_dispatch_not_started');
	}
	if (ordinaryBudgetLease.state === 'reserved') {
		await ordinaryBudgetLease.releasePreDispatch('realtime_upstream_dispatch_not_started');
	}
	const nodeUpgrade =
		c.env.NODE_REALTIME_DISPATCH != null &&
		proxyResult.response.headers.get('x-octafuse-realtime-upgrade') === '1';
	if (!nodeUpgrade && (proxyResult.response.status !== 101 || !proxyResult.response.webSocket)) {
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
});
