/**
 * 用户路由：`POST /v1/messages`（Anthropic Messages 协议），逻辑与 chat 对称，仅上游 driver 与协议筛选不同。
 */
import { Hono } from 'hono';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import type { RouteResult } from '../../services/model-router';
import {
  buildAffinityKey,
  buildTierKeyPrefix,
} from '../../services/route-strategies';
import { proxyAnthropicMessages, EMPTY_USAGE, type ProxyResult } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { summarizeAnthropicToolsForLog } from '../../services/request-log-tools-summary';
import { buildRouteRequestBody } from '../../services/route-default-params';
import { recordUsage } from '../../services/usage-tracker';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import {
  computeRequestLogStatus,
  formatHttpErrorTextForRequestLog,
  materializeNonOkResponse,
} from '../../services/request-log-record-status';
import {
  maybeBlockUserModelCircuit,
  maybeTriggerUserModelCircuitFromUpstream,
  markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { RequestTimingCollector } from '../../services/request-timing';
import { buildModelFallbackPlan, type ModelFallbackCandidatePlan } from '../../services/model-fallback-plan';
import { dispatchGlobalModelFallback } from '../../services/model-fallback-global-dispatch';
import {
  buildModelFallbackTrace,
  parseAnthropicModelFallbacks,
  type ModelFallbackTraceAttempt,
} from '../../services/model-fallbacks';
import {
  getUserModelCircuitOpen,
} from '../../services/user-model-circuit-breaker';
import { resolveRequestPreset } from '@octafuse/core';
import {
  auditGuardrailOutputDecision,
  filterGuardrailResponse,
  forfeitRequestGuardrailBudgets,
  markRequestGuardrailBudgetsDispatched,
  releaseRequestGuardrailBudgets,
  reserveRequestGuardrailBudgets,
  runRequestGuardrails,
} from '../../services/request-guardrails';
import {
  estimateGuardrailBudgetMicros,
  estimateOrdinaryBudgetChargedCost,
} from '../../services/guardrail-budget-estimate';
import {
  reserveOrdinaryUserBudget,
  type OrdinaryBudgetLease,
} from '../../services/ordinary-budget-lifecycle';
import {
  textUsageCostIsUnknown,
  textUsageWithSafetyTimeout,
} from '../../services/text-usage-settlement';

/** 同 chat：usage Promise 兜底超时，避免永久挂起。 */
const USAGE_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

/** Anthropic Messages：去掉 messages / system 正文；tools 仅保留名称摘要。 */
function anthropicBodyRedactedForLog(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'messages' || k === 'system') {
      continue;
    }
    if (k === 'tools') {
      Object.assign(out, summarizeAnthropicToolsForLog(v));
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(body.messages)) {
    out._messages_count = body.messages.length;
  }
  return out;
}

function anthropicRequestBodyForLog(body: Record<string, unknown>): string | null {
  return finalizeRequestLogJson(anthropicBodyRedactedForLog(body));
}

/** 与 anthropic-driver 一致：`{ ...buildRouteRequestBody, model }` 再脱敏（与 chat 分写，便于日后分叉）。 */
function anthropicUpstreamWireBodyForLog(route: RouteResult, body: Record<string, unknown>): string | null {
  const merged = buildRouteRequestBody(route, body);
  const wire = { ...merged, model: route.providerModelName };
  return finalizeRequestLogJson(anthropicBodyRedactedForLog(wire));
}

/** 与 chat 相同：`apiKey` 在鉴权后必有。 */
type MessagesEnv = Env & { Variables: { apiKey: import('../../middleware/auth').ApiKeyContext } };

export const messagesRoutes = new Hono<MessagesEnv>();

messagesRoutes.use('*', requireApiKey);
messagesRoutes.use('*', assignGenerationId);

/** Anthropic Messages：路由解析、预算与 failover 与 chat 对称，仅上游协议为 `anthropic`。 */
messagesRoutes.post('/', async (c) => {
  const repos = c.get('repositories');
  const apiKey = c.get('apiKey');
  const start = Date.now();
  const requestCorrelationId = c.get('generationId')!;
  const timing = new RequestTimingCollector();

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

  const presetResolution = await resolveRequestPreset(repos, apiKey.workspaceId, apiKey.userId, body, 'messages');
  if (!presetResolution.ok) {
    return gatewayErrorJson(c, {
      status: presetResolution.status,
      code: presetResolution.code === 'preset_not_found'
        ? GatewayErrorCode.presetNotFound
        : presetResolution.code === 'preset_invalid'
          ? GatewayErrorCode.presetInvalid
          : GatewayErrorCode.invalidPresetReference,
      message: presetResolution.message,
    });
  }
  body = presetResolution.body;

  let parsedModels = parseAnthropicModelFallbacks(body);
  if (!parsedModels.ok) {
    return gatewayErrorJson(c, {
      status: 400,
      code: parsedModels.missingModel ? GatewayErrorCode.missingModel : GatewayErrorCode.invalidRequest,
      message: parsedModels.message,
    });
  }

  const guardrail = await runRequestGuardrails(repos, {
    workspaceId: apiKey.workspaceId,
    userId: apiKey.userId,
    apiKeyId: apiKey.keyId,
    modelIds: parsedModels.value.modelIds,
    body,
    correlationId: requestCorrelationId,
	now: new Date(start),
  });
  if (!guardrail.ok) {
    return gatewayErrorJson(c, {
      status: guardrail.status,
      code: guardrail.code === 'guardrail_invalid' ? GatewayErrorCode.guardrailInvalid : GatewayErrorCode.guardrailBlocked,
      message: guardrail.message,
    });
  }
  body = guardrail.body;
  parsedModels = parseAnthropicModelFallbacks(body);
  if (!parsedModels.ok) {
    return gatewayErrorJson(c, { status: 400, code: GatewayErrorCode.invalidRequest, message: parsedModels.message });
  }

  const fallbackPlan = await buildModelFallbackPlan(repos, {
    modelIds: parsedModels.value.modelIds,
    body: parsedModels.value.upstreamBody,
    requestProtocol: 'anthropic',
    requestOperation: 'messages',
    pricingAt: new Date(start),
  });
  if (!fallbackPlan.ok) {
    return gatewayErrorJson(c, {
      status: fallbackPlan.status,
      code: fallbackPlan.code,
      message: fallbackPlan.message,
    });
  }
  const ordinaryEstimate = estimateOrdinaryBudgetChargedCost(
    fallbackPlan.candidates,
    apiKey.chargedCostFactors,
  );
  if (!ordinaryEstimate.ok) {
    return gatewayErrorJson(c, {
      status: 502,
      code: GatewayErrorCode.routeResolutionFailed,
      message: ordinaryEstimate.message,
    });
  }
  const ordinaryAdmission = await reserveOrdinaryUserBudget(repos, {
    requestId: requestCorrelationId,
    userId: apiKey.userId,
    apiKeyId: apiKey.keyId,
    budgetMax: apiKey.budgetMax,
    expectedBudgetEpoch: apiKey.budgetEpoch,
    estimatedChargedCost: ordinaryEstimate.estimatedChargedCost,
    now: new Date(start),
  });
  if (!ordinaryAdmission.ok) {
    return gatewayErrorJson(c, {
      status: 403,
      code: GatewayErrorCode.budgetExceeded,
      message: ordinaryAdmission.error.message,
    });
  }
  const ordinaryBudgetLease: OrdinaryBudgetLease = ordinaryAdmission.lease;
  const terminateOrdinaryBudget = async (reason: string): Promise<void> => {
    try {
      await ordinaryBudgetLease.terminateUnknown(reason);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'ordinary budget cleanup failed',
        request_id: requestCorrelationId,
        state: ordinaryBudgetLease.state,
        reason,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };
  const guardrailBudgetMicros = estimateGuardrailBudgetMicros(
    fallbackPlan.candidates,
    apiKey.chargedCostFactors,
  );
  const requestBodyForLog = anthropicRequestBodyForLog(body as Record<string, unknown>);
  const requestSignal = c.req.raw.signal;
  timing.markGatewayComplete();
  const fallbackAttempts: ModelFallbackTraceAttempt[] = [];
  const accumulatedCircuitEvents: NonNullable<ProxyResult['circuitEvents']> = [];
  let selectedPlan: ModelFallbackCandidatePlan | null = null;
  let proxyResult: ProxyResult | null = null;
  let response: Response | null = null;
  let errorBodyText: string | null = null;
  let upstreamOutcomeUnknownObserved = false;
  let guardrailBudgetAdmissionChecked = false;
  let guardrailBudgetReserved = false;
  let guardrailBudgetDispatched = false;
  const beforeUpstreamDispatch = async (): Promise<void> => {
    if (guardrailBudgetReserved && !guardrailBudgetDispatched) {
      try {
        await markRequestGuardrailBudgetsDispatched(
          repos,
          requestCorrelationId,
          guardrailBudgetReserved,
        );
        guardrailBudgetDispatched = true;
      } catch (dispatchError) {
        await releaseRequestGuardrailBudgets(
          repos,
          requestCorrelationId,
          guardrailBudgetReserved,
          'dispatch_transition_failed',
        ).catch((releaseError: unknown) => {
          console.error(JSON.stringify({
            message: 'guardrail budget release failed after dispatch transition failure',
            request_id: requestCorrelationId,
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          }));
        });
        await terminateOrdinaryBudget('guardrail_dispatch_mark_failed');
        throw dispatchError;
      }
    }
    await ordinaryBudgetLease.beforeUpstreamDispatch();
  };

  if (fallbackPlan.endpointPartition === 'none') {
    let admission: Awaited<ReturnType<typeof reserveRequestGuardrailBudgets>>;
    try {
      admission = await reserveRequestGuardrailBudgets(repos, {
        requestId: requestCorrelationId,
        intents: guardrail.budgetIntents,
        reservedMicros: guardrailBudgetMicros,
      });
    } catch (error) {
      await terminateOrdinaryBudget('guardrail_budget_admission_failed');
      throw error;
    }
    guardrailBudgetAdmissionChecked = true;
    if (!admission.ok) {
      await terminateOrdinaryBudget('guardrail_budget_admission_failed');
      if (admission.blocked) {
        return gatewayErrorJson(c, {
          status: 403,
          code: admission.reason === 'gateway_key_limit' || admission.reason === 'workspace_budget' ? GatewayErrorCode.budgetExceeded : GatewayErrorCode.guardrailBlocked,
          message: admission.message,
        });
      }
      throw new Error(`Guardrail budget admission failed: ${admission.message}`);
    }
    guardrailBudgetReserved = admission.reserved;

    let globalDispatch: Awaited<ReturnType<typeof dispatchGlobalModelFallback>>;
    try {
      globalDispatch = await dispatchGlobalModelFallback({
        repos,
        candidates: fallbackPlan.candidates,
        globalRoutes: fallbackPlan.globalRoutes,
        userId: apiKey.userId,
        requestSignal,
        publicCorrelationId: requestCorrelationId,
        timing,
        beforeUpstreamDispatch,
        proxy: proxyAnthropicMessages,
        affinityKey: buildAffinityKey(apiKey.userId, 'global', 'partition-none', 'anthropic'),
        tierKeyPrefix: buildTierKeyPrefix('global', 'partition-none', 'anthropic'),
      });
    } catch (upstreamError) {
      await forfeitRequestGuardrailBudgets(
        repos,
        requestCorrelationId,
        guardrailBudgetDispatched,
        'upstream_dispatch_failed',
      ).catch(() => undefined);
      await terminateOrdinaryBudget('upstream_dispatch_failed');
      throw upstreamError;
    }
    if (!globalDispatch.ok) {
      const candidate = fallbackPlan.candidates[globalDispatch.blockedCandidateIndex]!;
      const modelNameForCircuit =
        candidate.model.display_name != null && String(candidate.model.display_name).trim() !== ''
          ? String(candidate.model.display_name).trim()
          : candidate.baseModelId;
      const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
        baseModelId: candidate.baseModelId,
        modelNameForLog: modelNameForCircuit,
        requestBodyForLog,
        requestProtocol: 'anthropic',
        startMs: start,
        timing,
        modelFallbackTrace: buildModelFallbackTrace(
          parsedModels.value.modelIds,
          globalDispatch.fallbackAttempts,
        ),
      });
      if (guardrailBudgetReserved) {
        await releaseRequestGuardrailBudgets(
          repos,
          requestCorrelationId,
          guardrailBudgetReserved,
          'upstream_dispatch_not_started',
        );
        guardrailBudgetReserved = false;
      }
      await terminateOrdinaryBudget('model_circuit_terminal');
      if (circuitBlocked) return circuitBlocked;
      throw new Error('All globally sorted model candidates were circuit-open');
    }
    accumulatedCircuitEvents.push(
      ...globalDispatch.result.circuitEvents,
      ...globalDispatch.userModelCircuitEvents,
    );
    let materialized: Awaited<ReturnType<typeof materializeNonOkResponse>>;
    try {
      materialized = await materializeNonOkResponse(globalDispatch.result.response, {
        skin: 'anthropic',
        requestId: requestCorrelationId,
        trustedGatewayError: globalDispatch.result.meta?.gatewayGeneratedError === true,
      });
    } catch (upstreamError) {
      await forfeitRequestGuardrailBudgets(
        repos,
        requestCorrelationId,
        guardrailBudgetDispatched,
        'upstream_response_materialization_failed',
      ).catch(() => undefined);
      await terminateOrdinaryBudget('upstream_response_materialization_failed');
      throw upstreamError;
    }
    fallbackAttempts.push(...globalDispatch.fallbackAttempts);
    selectedPlan = globalDispatch.selectedPlan;
    proxyResult = globalDispatch.result;
    response = materialized.response;
    errorBodyText = materialized.errorBodyText;
    if (response.ok) markUserModelSuccess(apiKey.userId, selectedPlan.baseModelId);
  } else {
  const executionCandidates = fallbackPlan.candidates;
  for (let index = 0; index < executionCandidates.length; index += 1) {
    const candidate = executionCandidates[index]!;
    const isLastCandidate = index === executionCandidates.length - 1;
    const nextCandidate = executionCandidates[index + 1] ?? null;
    const modelNameForCircuit =
      candidate.model.display_name != null && String(candidate.model.display_name).trim() !== ''
        ? String(candidate.model.display_name).trim()
        : candidate.baseModelId;
    const openCircuit = getUserModelCircuitOpen(apiKey.userId, candidate.baseModelId);
    if (openCircuit) {
      fallbackAttempts.push({
        model: candidate.requestedModelId,
        base_model: candidate.baseModelId,
        route_group: candidate.effectiveRouteGroup,
        status: openCircuit.reason === 'client_error' ? 400 : 429,
        outcome: 'circuit_open',
        error_code: openCircuit.reason === 'client_error'
          ? GatewayErrorCode.circuitClientError
          : GatewayErrorCode.circuitSensitiveContent,
      });
      if (!isLastCandidate) {
        timing.markEndpointFallback(nextCandidate?.baseModelId !== candidate.baseModelId, false);
        continue;
      }
      const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
        baseModelId: candidate.baseModelId,
        modelNameForLog: modelNameForCircuit,
        requestBodyForLog,
        requestProtocol: 'anthropic',
        startMs: start,
        timing,
        modelFallbackTrace: buildModelFallbackTrace(parsedModels.value.modelIds, fallbackAttempts),
      });
      if (circuitBlocked) {
        if (guardrailBudgetDispatched) {
          await forfeitRequestGuardrailBudgets(
            repos,
            requestCorrelationId,
            guardrailBudgetReserved,
            'model_circuit_terminal_after_dispatch',
          ).catch((error: unknown) => {
            console.error(JSON.stringify({
              message: 'guardrail budget forfeit failed after terminal model circuit',
              request_id: requestCorrelationId,
              error: error instanceof Error ? error.message : String(error),
            }));
          });
        }
        await terminateOrdinaryBudget('model_circuit_terminal');
        return circuitBlocked;
      }
      fallbackAttempts.pop();
    }

    if (!guardrailBudgetAdmissionChecked) {
      let admission: Awaited<ReturnType<typeof reserveRequestGuardrailBudgets>>;
      try {
        admission = await reserveRequestGuardrailBudgets(repos, {
          requestId: requestCorrelationId,
          intents: guardrail.budgetIntents,
          reservedMicros: guardrailBudgetMicros,
        });
      } catch (error) {
        await terminateOrdinaryBudget('guardrail_budget_admission_failed');
        throw error;
      }
      guardrailBudgetAdmissionChecked = true;
      if (!admission.ok) {
        await terminateOrdinaryBudget('guardrail_budget_admission_failed');
        if (admission.blocked) {
          return gatewayErrorJson(c, {
            status: 403,
            code: admission.reason === 'gateway_key_limit' || admission.reason === 'workspace_budget' ? GatewayErrorCode.budgetExceeded : GatewayErrorCode.guardrailBlocked,
            message: admission.message,
          });
        }
        throw new Error(`Guardrail budget admission failed: ${admission.message}`);
      }
      guardrailBudgetReserved = admission.reserved;
    }

    console.log(
      `[Gateway Messages] forwarding baseModelId=${candidate.baseModelId} clientModel=${candidate.requestedModelId} providerIds=${candidate.routes.map((route) => route.providerId).join(',')} keyId=${apiKey.keyId}`,
    );
    let result: ProxyResult;
    let materialized: Awaited<ReturnType<typeof materializeNonOkResponse>>;
    try {
      result = await proxyAnthropicMessages(
        repos,
        candidate.routes,
        candidate.upstreamBody,
        requestSignal,
        {
          affinityKey: buildAffinityKey(apiKey.userId, candidate.baseModelId, candidate.effectiveRouteGroup, 'anthropic'),
          tierKeyPrefix: buildTierKeyPrefix(candidate.baseModelId, candidate.effectiveRouteGroup, 'anthropic'),
          strategy: candidate.strategy.base,
          tierStrategies: candidate.strategy.tierOverrides,
          timing,
          routePoolId: candidate.surface?.route_pool_id ?? candidate.routes[0]?.routePoolId ?? null,
          sticky: candidate.hasProviderPreferences ? null : stickyConfigFromSurface(candidate.surface),
          deferFinalAttempt: !isLastCandidate,
          beforeUpstreamDispatch,
        },
        requestCorrelationId,
      );
      if (result.stickyMutationPromise) scheduleBackgroundWork(c, result.stickyMutationPromise);
      upstreamOutcomeUnknownObserved ||= result.meta?.upstreamOutcomeUnknown === true;
      if (upstreamOutcomeUnknownObserved) {
        result.meta = { ...(result.meta ?? {}), upstreamOutcomeUnknown: true };
      }
      accumulatedCircuitEvents.push(...result.circuitEvents);
      materialized = await materializeNonOkResponse(result.response, {
        skin: 'anthropic',
        requestId: requestCorrelationId,
        trustedGatewayError: result.meta?.gatewayGeneratedError === true,
      });
    } catch (upstreamError) {
      await forfeitRequestGuardrailBudgets(
        repos,
        requestCorrelationId,
        guardrailBudgetDispatched,
        'upstream_dispatch_failed',
      ).catch((forfeitError: unknown) => {
        console.error(JSON.stringify({
          message: 'guardrail budget forfeit failed after upstream exception',
          request_id: requestCorrelationId,
          error: forfeitError instanceof Error ? forfeitError.message : String(forfeitError),
        }));
      });
      await terminateOrdinaryBudget('upstream_dispatch_failed');
      throw upstreamError;
    }
    const attemptError = materialized.errorBodyText == null
      ? undefined
      : formatHttpErrorTextForRequestLog(
          materialized.response.status,
          materialized.response.headers.get('content-type'),
          materialized.errorBodyText,
        );
    fallbackAttempts.push({
      model: candidate.requestedModelId,
      base_model: candidate.baseModelId,
      route_group: candidate.effectiveRouteGroup,
      status: materialized.response.status,
      outcome: materialized.response.ok ? 'success' : 'error',
      provider_id: result.chosenRoute.providerId,
      route_target_id: result.chosenRoute.targetId,
      ...(materialized.response.headers.get(GATEWAY_ERROR_CODE_HEADER)
        ? { error_code: materialized.response.headers.get(GATEWAY_ERROR_CODE_HEADER)! }
        : {}),
    });
    if (materialized.response.ok) {
      markUserModelSuccess(apiKey.userId, candidate.baseModelId);
      selectedPlan = candidate;
      proxyResult = result;
      response = materialized.response;
      errorBodyText = null;
      break;
    }
    if (materialized.errorBodyText != null) {
      const circuitEvent = maybeTriggerUserModelCircuitFromUpstream(
        apiKey.userId,
        candidate.baseModelId,
        materialized.response.status,
        materialized.response.headers.get('content-type'),
        materialized.errorBodyText,
        attemptError,
      );
      if (circuitEvent) accumulatedCircuitEvents.push(circuitEvent);
    }
    if (!isLastCandidate && result.meta?.failoverForbidden !== true) {
      timing.markEndpointFallback(
        nextCandidate?.baseModelId !== candidate.baseModelId,
        !result.suppressErrorAlert,
      );
      continue;
    }
    selectedPlan = candidate;
    proxyResult = result;
    response = materialized.response;
    errorBodyText = materialized.errorBodyText;
  }
  }

  if (!selectedPlan || !proxyResult || !response) {
	await forfeitRequestGuardrailBudgets(
		repos,
		requestCorrelationId,
		guardrailBudgetDispatched,
		'fallback_exhausted_after_dispatch',
	).catch((forfeitError: unknown) => {
		console.error(JSON.stringify({
			message: 'guardrail budget forfeit failed after fallback exhaustion',
			request_id: requestCorrelationId,
			error: forfeitError instanceof Error ? forfeitError.message : String(forfeitError),
		}));
	});
    await terminateOrdinaryBudget('fallback_exhausted');
    throw new Error('Model fallback planner exhausted without a terminal response');
  }
  if (ordinaryBudgetLease.state === 'reserved') {
    await terminateOrdinaryBudget('upstream_dispatch_not_started');
  }
  if (guardrailBudgetReserved && !guardrailBudgetDispatched) {
    try {
      await releaseRequestGuardrailBudgets(
        repos,
        requestCorrelationId,
        guardrailBudgetReserved,
        'upstream_dispatch_not_started',
      );
      guardrailBudgetReserved = false;
    } catch (error) {
      console.error(JSON.stringify({
        message: 'guardrail budget pre-dispatch release failed',
        request_id: requestCorrelationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  const { model, baseModelId, upstreamBody } = selectedPlan;
  const modelNameForLog =
    model.display_name != null && String(model.display_name).trim() !== ''
      ? String(model.display_name).trim()
      : baseModelId;
  const {
    usagePromise,
    chosenRoute,
    upstreamRequestId,
    suppressErrorAlert,
    stickyTrace,
  } = proxyResult;
  const modelFallbackTrace = buildModelFallbackTrace(parsedModels.value.modelIds, fallbackAttempts);
  const upstreamResponseOk = response.ok;
  let outputGuardrailBlocked = false;
  if (guardrail.outputFilters.length > 0 && response.ok) {
	const filtered = await filterGuardrailResponse(response, guardrail.outputFilters).catch(async (error: unknown) => {
		await forfeitRequestGuardrailBudgets(
			repos,
			requestCorrelationId,
			guardrailBudgetDispatched,
			'output_guardrail_failed_after_dispatch',
		).catch((forfeitError: unknown) => {
			console.error(JSON.stringify({
				message: 'guardrail budget forfeit failed after output Guardrail failure',
				request_id: requestCorrelationId,
				error: forfeitError instanceof Error ? forfeitError.message : String(forfeitError),
			}));
		});
		await terminateOrdinaryBudget('output_guardrail_failed_after_dispatch');
		throw error;
	});
    await auditGuardrailOutputDecision(repos, {
	  workspaceId: apiKey.workspaceId,
      userId: apiKey.userId, apiKeyId: apiKey.keyId, modelIds: parsedModels.value.modelIds,
      trace: guardrail.trace, blockedBy: filtered.blockedBy, redactionCount: filtered.redactionCount,
      correlationId: requestCorrelationId,
    }).catch((error: unknown) => {
      console.warn(JSON.stringify({
        message: 'guardrail output audit failed',
        request_id: requestCorrelationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    if (filtered.blockedBy) {
      outputGuardrailBlocked = true;
      errorBodyText = 'Guardrail blocked response output';
      response = gatewayErrorJson(c, { status: 403, code: GatewayErrorCode.guardrailBlocked, message: 'Response blocked by output guardrail' });
    } else {
      response = filtered.response;
    }
  }

  const usageOrSafety = textUsageWithSafetyTimeout(
    usagePromise,
    USAGE_SAFETY_TIMEOUT_MS,
    EMPTY_USAGE,
  );

  scheduleBackgroundWork(
    c,
    usageOrSafety
      .then(async ({ usage: usageCollected, incomplete, timedOut }) => {
        const latency = Date.now() - start;
        if (timedOut) timing.markStreamComplete();
        const status = computeRequestLogStatus({
          cancelled: Boolean(usageCollected.cancelled),
          responseOk: response.ok,
          incomplete,
          streamError: Boolean(usageCollected.stream_error),
        });
        const costUnknown = textUsageCostIsUnknown({
          upstreamResponseOk,
          usageAvailable: !incomplete,
          cancelled: Boolean(usageCollected.cancelled),
          streamError: Boolean(usageCollected.stream_error),
          upstreamOutcomeUnknown: proxyResult.meta?.upstreamOutcomeUnknown === true,
          responseBodyTooLarge: proxyResult.meta?.responseBodyTooLarge === true,
        });
        let errorMessage: string | undefined;
        if (status === 'success') {
          errorMessage = undefined;
        } else if (status === 'cancelled') {
          errorMessage = 'Client disconnected (e.g. user cancelled)';
        } else if (status === 'incomplete') {
          errorMessage = timedOut
            ? 'Stream usage timeout (no usage within limit)'
            : 'Stream ended before usage available';
        } else if (errorBodyText != null) {
          errorMessage = formatHttpErrorTextForRequestLog(
            response.status,
            response.headers.get('content-type'),
            errorBodyText
          );
        } else {
          errorMessage = usageCollected.stream_error || `HTTP ${response.status}`;
        }
        const upstreamRequestBodyForLog = anthropicUpstreamWireBodyForLog(
          chosenRoute,
		  upstreamBody,
        );
        return recordUsage(repos, {
          api_key_id: apiKey.keyId,
		  workspace_id: apiKey.workspaceId,
          request_log_id: requestCorrelationId,
          user_id: apiKey.userId,
          user_email: apiKey.userEmail,
          model_id: baseModelId,
          provider_id: chosenRoute.providerId,
          provider_model_name: chosenRoute.providerModelName,
          model_name: modelNameForLog,
          provider_name: chosenRoute.providerName,
          request_body: requestBodyForLog,
          upstream_request_body: upstreamRequestBodyForLog,
          request_body_logging_mode: c.get('requestBodyLoggingMode'),
          request_protocol: 'anthropic',
          request_operation: 'messages',
          upstream_protocol: chosenRoute.upstreamProtocol,
          upstream_operation: chosenRoute.upstreamOperation,
          model_surface_id: chosenRoute.modelSurfaceId,
          route_pool_id: chosenRoute.routePoolId,
          route_target_id: chosenRoute.targetId,
          adapter: chosenRoute.adapter,
          sticky_trace: stickyTrace ? await stickyTrace() : null,
          model_fallback_trace: modelFallbackTrace,
          provider_routing_trace: chosenRoute.providerRoutingTrace ?? null,
          usage: usageCollected,
          endpoint_pricing_snapshot: chosenRoute.endpoint ?? null,
          model_pricing_profile: model.pricing_profile ?? null,
          route_price_override_json: chosenRoute.priceOverrideRaw,
          user_charged_cost_factors_json: apiKey.chargedCostFactors,
          route_metered_profile_json: chosenRoute.routeMeteredProfileJson,
          route_charged_profile_json: chosenRoute.routeChargedProfileJson,
          request_started_at_ms: start,
          route_group: chosenRoute.routeGroup,
          status,
          latency_ms: latency,
          timing: timing.snapshot(),
          error_message: errorMessage,
          provider_key_id: chosenRoute.providerKeyId ?? null,
          provider_key_label: chosenRoute.providerKeyLabel ?? null,
          provider_key_fingerprint: chosenRoute.providerKeyFingerprint ?? null,
          upstream_request_id: upstreamRequestId,
          upstream_message_id: usageCollected.upstreamMessageId ?? null,
          circuit_events: accumulatedCircuitEvents.length > 0 ? accumulatedCircuitEvents : undefined,
          suppress_error_alert: suppressErrorAlert || undefined,
          charge_on_error: outputGuardrailBlocked || undefined,
          guardrail_budget_settlement: guardrailBudgetReserved
            ? { requestId: requestCorrelationId, unknownCost: costUnknown }
            : undefined,
          ordinary_budget_settlement:
            ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
              ? {
                  requestId: requestCorrelationId,
                  budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
                  reservedMicros: ordinaryBudgetLease.reservedMicros,
                  unknownCost: costUnknown,
                }
              : undefined,
        });
      })
      .catch(async (error: unknown) => {
        await forfeitRequestGuardrailBudgets(
          repos,
          requestCorrelationId,
          guardrailBudgetDispatched,
          'usage_settlement_failed',
        ).catch((forfeitError: unknown) => {
          console.error(JSON.stringify({
            message: 'guardrail budget forfeit failed after usage settlement failure',
            request_id: requestCorrelationId,
            error: forfeitError instanceof Error ? forfeitError.message : String(forfeitError),
          }));
        });
        await terminateOrdinaryBudget('usage_settlement_failed');
        console.error(JSON.stringify({
          message: 'request usage settlement failed',
          request_id: requestCorrelationId,
          error: error instanceof Error ? error.message : String(error),
        }));
      })
  );

  return response;
});
