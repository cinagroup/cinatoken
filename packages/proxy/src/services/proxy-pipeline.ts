import { runRequestGuardrails } from './request-guardrails';
import { runGeminiRequestGuardrails } from './gemini-request-guardrails';
import { buildModelFallbackPlan } from './model-fallback-plan';
import { createRouteAwareBudgetAdmission } from './request-budget-admission';
import {
	estimateOrdinaryBudgetChargedCost,
	estimateGuardrailBudgetMicros,
	estimateGatewayKeyByokBudgetMicros,
} from './guardrail-budget-estimate';
import { privateByokContextForApiKey } from './byok-key-pool';
import { scheduleResourceCompletion } from '../runtime/schedule-resource-completion';
/**
 * Ingress 公共流水线：鉴权上下文之后的模型解析、预算、选路、策略、熔断、failover 与异步记账。
 * 各端点只提供协议相关的 parse / dispatch，以及 accounting.describeOutcome（解读口径 + 脱敏）。
 * 记账路径：dispatch → outcome → buildAccountingEvent → sink.flush（默认直接 recordUsage）。
 */
import type { Context } from 'hono';
import {
	hasPositiveTotalBalance,
	type GatewayRepositories,
	type ModelRow,
	type ResolvedModelSurfaceRow,
	type UpstreamProtocol,
} from '@octafuse/core';
import type { Env } from '../app';
import type { ApiKeyContext } from '../middleware/auth';
import { scheduleBackgroundWork } from '../runtime/schedule-background-work';
import {
	allocateRequestLogId,
	buildAccountingEvent,
	createDirectFlushAccountingSink,
	defaultHasUsage,
	type ProxyEndpointAccounting,
} from './accounting';
import { GatewayErrorCode, NO_AVAILABLE_ROUTE_MESSAGE } from './gateway-error-codes';
import { gatewayErrorJson, withGatewayRequestIdHeader } from './gateway-error-response';
import { resolveModelRouting } from './resolve-model-route-group';
import { resolveRoutesForSurface, type RouteResult } from './model-router';
import { buildAffinityKey, buildTierKeyPrefix, resolveRouteStrategyPlan } from './route-strategies';
import { stickyConfigFromSurface } from './provider-sticky-routing';
import { formatHttpErrorTextForRequestLog, materializeNonOkResponse } from './request-log-record-status';
import {
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
	markUserModelSuccess,
} from './user-model-circuit-route';
import { EMPTY_USAGE, type ProxyResult } from './proxy';
import type { FailoverDispatchOptions } from './failover-dispatch';
import { RequestTimingCollector } from './request-timing';
import { DEFAULT_USAGE_SAFETY_TIMEOUT_MS, resolveStreamTimeouts } from './stream-timeout-env';

/** `usagePromise` 未 resolve 的绝对上限（代码默认）。部署可用 `USAGE_SAFETY_TIMEOUT_MS` 覆盖。 */
export const USAGE_SAFETY_TIMEOUT_MS = DEFAULT_USAGE_SAFETY_TIMEOUT_MS;

export type AuthedEnv = Env & { Variables: { apiKey: ApiKeyContext } };

export type PipelineParseResult<TBody> = {
	body: TBody;
	rawModelId: string;
};

export type PipelineDispatchContext<TBody> = {
	repos: GatewayRepositories;
	routes: RouteResult[];
	body: TBody;
	requestSignal: AbortSignal;
	options: FailoverDispatchOptions;
	context: Context<AuthedEnv>;
};

export interface ProxyEndpointSpec<TBody> {
	requestProtocol: Extract<UpstreamProtocol, 'openai' | 'anthropic' | 'gemini'>;
	requestOperation: string;
	strategyCapability: string;
	logTag: string;
	parseRequest: (c: Context<AuthedEnv>) => Promise<PipelineParseResult<TBody> | Response>;
	dispatch: (ctx: PipelineDispatchContext<TBody>) => Promise<ProxyResult>;
	accounting: ProxyEndpointAccounting<TBody>;
	afterRoutesResolved?: (
		c: Context<AuthedEnv>,
		input: { routes: RouteResult[]; body: TBody; rawModelId: string },
	) => Response | null;
	logForward?: boolean;
	logRouteResolutionError?: boolean;
	logEmptyRoutes?: boolean;
	logRecordUsageError?: boolean;
}

export type LoadedProxyRoutes = {
	routes: RouteResult[];
	poolStrategy: string | null;
	poolTierStrategies: string | null;
	stickySurface: ResolvedModelSurfaceRow | null;
};

export type ResolvedProxySurface = {
	model: ModelRow;
	baseModelId: string;
	effectiveRouteGroup: string;
	routes: RouteResult[];
	poolStrategy: string | null;
	poolTierStrategies: string | null;
	stickySurface: ResolvedModelSurfaceRow | null;
};

/** 仅解析 Surface 路由池；调用方已完成模型解析。 */
export async function loadProxyRouteSurface(
	repos: GatewayRepositories,
	input: {
		modelId: string;
		routeGroup: string;
		requestProtocol: UpstreamProtocol;
		requestOperation: string;
	},
): Promise<{ ok: true; loaded: LoadedProxyRoutes } | { ok: false; message: string; cause: unknown }> {
	try {
		const resolvedSurface = await resolveRoutesForSurface(repos, {
			modelId: input.modelId,
			routeGroup: input.routeGroup,
			requestProtocol: input.requestProtocol,
			requestOperation: input.requestOperation,
		});
		return {
			ok: true,
			loaded: {
				routes: resolvedSurface.routes,
				poolStrategy: resolvedSurface.surface?.pool_strategy ?? null,
				poolTierStrategies: resolvedSurface.surface?.pool_tier_strategies ?? null,
				stickySurface: resolvedSurface.surface,
			},
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : 'Model route resolution failed',
			cause: err,
		};
	}
}

/** 模型解析 + Surface 选路；images / audio 与 LLM 流水线共用。 */
export async function resolveProxySurface(
	repos: GatewayRepositories,
	input: {
		rawModelId: string;
		requestProtocol: UpstreamProtocol;
		requestOperation: string;
	},
): Promise<
	| { ok: true; surface: ResolvedProxySurface }
	| { ok: false; status: 404 | 502; message: string; cause?: unknown; baseModelId?: string }
> {
	const resolved = await resolveModelRouting(repos, input.rawModelId);
	if (!resolved) {
		return { ok: false, status: 404, message: 'Model not found' };
	}
	const { model, baseModelId, explicitGroup } = resolved;
	const effectiveRouteGroup = explicitGroup?.trim() || 'default';
	const loaded = await loadProxyRouteSurface(repos, {
		modelId: baseModelId,
		routeGroup: effectiveRouteGroup,
		requestProtocol: input.requestProtocol,
		requestOperation: input.requestOperation,
	});
	if (!loaded.ok) {
		return {
			ok: false,
			status: 502,
			message: loaded.message,
			cause: loaded.cause,
			baseModelId,
		};
	}
	return {
		ok: true,
		surface: {
			model,
			baseModelId,
			effectiveRouteGroup,
			...loaded.loaded,
		},
	};
}

export async function buildProxyFailoverOptions(input: {
	repos: GatewayRepositories;
	apiKey: ApiKeyContext;
	model: Pick<ModelRow, 'route_policy'>;
	baseModelId: string;
	effectiveRouteGroup: string;
	protocol: UpstreamProtocol;
	capability: string;
	poolStrategy: string | null;
	poolTierStrategies: string | null;
	stickySurface: ResolvedModelSurfaceRow | null;
	routes: RouteResult[];
	timing: RequestTimingCollector;
	/** 默认启用；audio.speech 历史路径未挂 sticky，保持原行为。 */
	includeSticky?: boolean;
	inboundHeaders?: Headers;
}): Promise<FailoverDispatchOptions> {
	const strategyPlan = await resolveRouteStrategyPlan({
		routePolicyRaw: input.model.route_policy ?? null,
		poolStrategy: input.poolStrategy,
		poolTierStrategies: input.poolTierStrategies,
		protocol: input.protocol,
		capability: input.capability,
		routeGroup: input.effectiveRouteGroup,
		repos: input.repos,
	});
	return {
		affinityKey: buildAffinityKey(input.apiKey.userId, input.baseModelId, input.effectiveRouteGroup, input.protocol),
		tierKeyPrefix: buildTierKeyPrefix(input.baseModelId, input.effectiveRouteGroup, input.protocol),
		strategy: strategyPlan.base,
		tierStrategies: strategyPlan.tierOverrides,
		timing: input.timing,
		inboundHeaders: input.inboundHeaders,
		...(input.includeSticky === false
			? {}
			: {
					routePoolId: input.stickySurface?.route_pool_id ?? input.routes[0]?.routePoolId ?? null,
					sticky: stickyConfigFromSurface(input.stickySurface),
				}),
	};
}

export { defaultHasUsage };

export function modelDisplayName(model: Pick<ModelRow, 'display_name'>, baseModelId: string): string {
	return model.display_name != null && String(model.display_name).trim() !== ''
		? String(model.display_name).trim()
		: baseModelId;
}

export async function runProxyPipeline<TBody>(
	c: Context<AuthedEnv>,
	spec: ProxyEndpointSpec<TBody>,
): Promise<Response> {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const timing = new RequestTimingCollector();

	const parsed = await spec.parseRequest(c);
	if (parsed instanceof Response) return parsed;

	let { body, rawModelId } = parsed;
	const requestLogId = allocateRequestLogId();
	const resolved = await resolveModelRouting(repos, rawModelId);
	if (!resolved) {
		return gatewayErrorJson(c, {
			status: 404,
			code: GatewayErrorCode.modelNotFound,
			message: 'Model not found',
		});
	}
	const { model, baseModelId, explicitGroup } = resolved;
	const effectiveRouteGroup = explicitGroup?.trim() || 'default';

	if (!hasPositiveTotalBalance(apiKey.budgetMax, apiKey.budgetSpent, apiKey.walletGranted, apiKey.walletSpent)) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: 'Budget exceeded',
		});
	}

	if (!body || typeof body !== 'object' || Array.isArray(body))
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'JSON body must be an object',
		});
	const guardrailInput = {
		workspaceId: apiKey.workspaceId,
		userId: apiKey.userId,
		apiKeyId: apiKey.keyId,
		modelId: rawModelId,
		modelIds: [rawModelId],
		body: body as Record<string, unknown>,
		correlationId: requestLogId,
		now: new Date(start),
	};
	const guardrail =
		spec.requestProtocol === 'gemini'
			? await runGeminiRequestGuardrails(repos, {
					...guardrailInput,
					action: spec.requestOperation === 'streamGenerateContent' ? 'streamGenerateContent' : 'generateContent',
				})
			: await runRequestGuardrails(repos, guardrailInput);
	if (!guardrail.ok)
		return gatewayErrorJson(c, {
			status: guardrail.status,
			code:
				guardrail.code === 'guardrail_invalid' ? GatewayErrorCode.guardrailInvalid : GatewayErrorCode.guardrailBlocked,
			message: guardrail.message,
		});
	if (guardrail.outputFilters.length)
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.guardrailBlocked,
			message: 'This pipeline cannot safely enforce configured output guardrails',
		});
	const plan = await buildModelFallbackPlan(repos, {
		modelIds: [rawModelId],
		body: guardrail.body,
		requestProtocol: spec.requestProtocol,
		requestOperation: spec.requestOperation,
		pricingAt: new Date(start),
	});
	if (!plan.ok) return gatewayErrorJson(c, { status: plan.status, code: plan.code, message: plan.message });
	const selected = plan.candidates[0]!;
	body = selected.upstreamBody as TBody;
	const routes = selected.routes;
	const stickySurface = selected.surface;
	const poolStrategy = stickySurface?.pool_strategy ?? null;
	const poolTierStrategies = stickySurface?.pool_tier_strategies ?? null;

	const blockedAfterRoutes = spec.afterRoutesResolved?.(c, { routes, body, rawModelId });
	if (blockedAfterRoutes) return blockedAfterRoutes;

	if (spec.logForward) {
		console.log(
			`[Gateway ${spec.logTag}] forwarding baseModelId=${baseModelId} clientModel=${rawModelId} providerIds=${routes.map((r) => r.providerId).join(',')} keyId=${apiKey.keyId}`,
		);
	}

	const nameForLog = modelDisplayName(model, baseModelId);
	const requestBodyForLog = spec.accounting.requestBodyForLog(body);
	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog: nameForLog,
		requestBodyForLog,
		requestProtocol: spec.requestProtocol,
		startMs: start,
		timing,
	});
	if (circuitBlocked) return circuitBlocked;

	const streamTimeouts = resolveStreamTimeouts(c.env);
	const estimate = estimateOrdinaryBudgetChargedCost([selected], apiKey.chargedCostFactors);
	const admission = await createRouteAwareBudgetAdmission(repos, {
		ordinary: {
			requestId: requestLogId,
			userId: apiKey.userId,
			apiKeyId: apiKey.keyId,
			budgetMax: apiKey.budgetMax,
			expectedBudgetEpoch: apiKey.budgetEpoch,
			estimatedChargedCost: estimate.ok ? estimate.estimatedChargedCost : null,
			now: new Date(start),
		},
		guardrail: {
			intents: guardrail.budgetIntents,
			reservedMicros: estimateGuardrailBudgetMicros([selected], apiKey.chargedCostFactors),
			now: new Date(start),
		},
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: estimateGatewayKeyByokBudgetMicros([selected]),
		},
	});
	const terminateUnknown = (reason: string) =>
		Promise.all([admission.terminateGuardrailUnknown(reason), admission.ordinaryLease.terminateUnknown(reason)]);
	const failoverOptions = {
		...(await buildProxyFailoverOptions({
			repos,
			apiKey,
			model,
			baseModelId,
			effectiveRouteGroup,
			protocol: spec.requestProtocol,
			capability: spec.strategyCapability,
			poolStrategy,
			poolTierStrategies,
			stickySurface,
			routes,
			timing,
			inboundHeaders: c.req.raw.headers,
		})),
		beforeUpstreamDispatch: (route: RouteResult) => admission.beforeUpstreamDispatch(route),
		registerResourceCompletion: (task: import('./resource-completion').ResourceCompletion) =>
			scheduleResourceCompletion(c, task),
		byok: privateByokContextForApiKey(apiKey),
		firstChunkTimeoutMs: streamTimeouts.firstChunkTimeoutMs,
		idleTimeoutMs: streamTimeouts.idleTimeoutMs,
	};
	timing.markGatewayComplete();
	const proxyResult = await spec
		.dispatch({
			repos,
			routes,
			body,
			requestSignal: c.req.raw.signal,
			options: failoverOptions,
			context: c,
		})
		.catch(async (error) => {
			await terminateUnknown('pipeline_dispatch_failed');
			throw error;
		});
	if (admission.ordinaryLease.state === 'reserved')
		await admission.ordinaryLease.releasePreDispatch('pipeline_not_dispatched');
	if (!admission.guardrailDispatched) await admission.releaseGuardrailPreDispatch('pipeline_not_dispatched');
	if (proxyResult.stickyMutationPromise) {
		scheduleBackgroundWork(c, proxyResult.stickyMutationPromise);
	}
	const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response).catch(async (error) => {
		await terminateUnknown('pipeline_response_failed');
		throw error;
	});

	let userModelCircuitEvent = null;
	if (response.ok) {
		markUserModelSuccess(apiKey.userId, baseModelId);
	} else if (errorBodyText != null) {
		userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(response.status, response.headers.get('content-type'), errorBodyText),
		);
	}

	const alertCircuitEvents = userModelCircuitEvent
		? [...proxyResult.circuitEvents, userModelCircuitEvent]
		: proxyResult.circuitEvents;
	let safetyTimer: ReturnType<typeof setTimeout> | undefined;
	const usageOrSafety = Promise.race([
		proxyResult.usagePromise.then((usage) => ({ usage, timedOut: false as const })),
		new Promise<{ usage: typeof EMPTY_USAGE; timedOut: true }>((resolve) => {
			safetyTimer = setTimeout(
				() => resolve({ usage: EMPTY_USAGE, timedOut: true }),
				streamTimeouts.usageSafetyTimeoutMs,
			);
		}),
	]).finally(() => {
		if (safetyTimer) clearTimeout(safetyTimer);
	});

	const accountingSink = createDirectFlushAccountingSink(repos);

	scheduleBackgroundWork(
		c,
		usageOrSafety
			.then(async ({ usage: usageCollected, timedOut }) => {
				const latencyMs = Date.now() - start;
				if (timedOut) timing.markStreamComplete();
				const described = spec.accounting.describeOutcome({
					body,
					usage: usageCollected,
					timedOut,
					headerRequestId: proxyResult.upstreamRequestId,
					httpStatus: response.status,
				});
				const stickyTrace = proxyResult.stickyTrace ? await proxyResult.stickyTrace() : null;
				const event = buildAccountingEvent({
					requestLogId,
					apiKey,
					described,
					usage: usageCollected,
					responseOk: response.ok,
					errorBodyText,
					responseStatus: response.status,
					responseContentType: response.headers.get('content-type'),
					baseModelId,
					modelName: nameForLog,
					modelPricingProfile: model.pricing_profile ?? null,
					requestProtocol: spec.requestProtocol,
					requestOperation: spec.requestOperation,
					requestBodyForLog,
					upstreamRequestBody: spec.accounting.upstreamWireBodyForLog(proxyResult.chosenRoute, body),
					chosenRoute: proxyResult.chosenRoute,
					stickyTrace,
					requestStartedAtMs: start,
					latencyMs,
					timing: timing.snapshot(),
					circuitEvents: alertCircuitEvents,
					suppressErrorAlert: proxyResult.suppressErrorAlert,
				});
				const unknownCost =
					timedOut ||
					!described.hasUsage ||
					Boolean(usageCollected.stream_error) ||
					proxyResult.meta?.upstreamOutcomeUnknown === true;
				event.guardrail_budget_settlement = admission.guardrailReserved
					? { requestId: requestLogId, unknownCost }
					: undefined;
				event.ordinary_budget_settlement =
					admission.ordinaryLease.reserved && admission.ordinaryLease.state === 'dispatched'
						? {
								requestId: requestLogId,
								budgetEpoch: admission.ordinaryLease.budgetEpoch!,
								reservedMicros: admission.ordinaryLease.reservedMicros,
								unknownCost,
							}
						: undefined;
				await accountingSink.flush(event);
			})
			.catch(async (err) => {
				await terminateUnknown('pipeline_usage_settlement_failed');
				if (spec.logRecordUsageError) {
					console.error(
						`[Gateway ${spec.logTag}] recordUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} error=${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}),
	);

	return withGatewayRequestIdHeader(response, requestLogId);
}

export async function parseJsonModelBody(
	c: Context<AuthedEnv>,
): Promise<PipelineParseResult<Record<string, unknown>> | Response> {
	let body: { model?: string; [k: string]: unknown };
	try {
		body = await c.req.json();
	} catch {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidJson,
			message: 'Invalid JSON body',
		});
	}
	const rawModelId = typeof body.model === 'string' ? body.model.trim() : '';
	if (!rawModelId) {
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.missingModel,
			message: 'Missing model',
		});
	}
	return { body, rawModelId };
}
