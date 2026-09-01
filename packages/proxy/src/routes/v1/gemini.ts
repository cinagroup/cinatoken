/**
 * 用户路由：`POST /v1beta/models/{model}:{generateContent|streamGenerateContent}`（Gemini 风格路径）。
 */
import { GEMINI_GENERATE_OPERATION } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import type { RouteResult } from '../../services/model-router';
import {
  buildAffinityKey,
  buildTierKeyPrefix,
} from '../../services/route-strategies';
import { proxyGeminiContent, EMPTY_USAGE } from '../../services/proxy';
import { buildRouteRequestBody } from '../../services/route-default-params';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { summarizeGeminiToolsForLog } from '../../services/request-log-tools-summary';
import { resolveGeminiLoggedRequestId } from '../../services/egress/upstream-request-id';
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
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { RequestTimingCollector } from '../../services/request-timing';
import { buildModelFallbackPlan } from '../../services/model-fallback-plan';
import {
  auditGuardrailOutputDecision,
  filterGuardrailResponse,
  forfeitRequestGuardrailBudgets,
  markRequestGuardrailBudgetsDispatched,
  releaseRequestGuardrailBudgets,
  reserveRequestGuardrailBudgets,
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
  geminiBodyForBudgetEstimate,
  runGeminiRequestGuardrails,
} from '../../services/gemini-request-guardrails';
import {
  textUsageCostIsUnknown,
  textUsageWithSafetyTimeout,
} from '../../services/text-usage-settlement';

/** usage Promise 兜底超时（与 OpenAI/Anthropic 路由一致）。 */
const USAGE_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

/** Gemini generateContent：去掉 contents / systemInstruction；tools 仅保留名称摘要；并记录 action。 */
function geminiBodyRedactedForLog(
  body: Record<string, unknown>,
  action?: 'generateContent' | 'streamGenerateContent'
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'contents' || k === 'systemInstruction' || k === 'system_instruction') {
      continue;
    }
    if (k === 'tools') {
      Object.assign(out, summarizeGeminiToolsForLog(v));
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(body.contents)) {
    out._contents_count = body.contents.length;
  }
  if (action) {
    out._gemini_action = action;
  }
  return out;
}

function geminiRequestBodyForLog(
  body: Record<string, unknown>,
  action: 'generateContent' | 'streamGenerateContent'
): string | null {
  return finalizeRequestLogJson(geminiBodyRedactedForLog(body, action));
}

/** 与 gemini-driver 一致：仅 `buildRouteRequestBody`（模型在 URL）。 */
function geminiUpstreamWireBodyForLog(
  route: RouteResult,
  body: Record<string, unknown>,
  action: 'generateContent' | 'streamGenerateContent'
): string | null {
  const merged = buildRouteRequestBody(route, body) as Record<string, unknown>;
  return finalizeRequestLogJson(geminiBodyRedactedForLog(merged, action));
}

/** 与 chat/messages 相同：`Variables.apiKey` 在鉴权后注入。 */
type GeminiEnv = Env & { Variables: { apiKey: import('../../middleware/auth').ApiKeyContext } };

/**
 * 解析路径参数 `modelAction`：`{modelId}:{generateContent|streamGenerateContent}`（以最后一个 `:` 分隔）。
 * @returns 非法格式或 action 名不对时 null
 */
function parseGeminiAction(
  modelAction: string
): { modelId: string; action: 'generateContent' | 'streamGenerateContent' } | null {
  const idx = modelAction.lastIndexOf(':');
  if (idx <= 0 || idx >= modelAction.length - 1) {
    return null;
  }
  const modelId = modelAction.slice(0, idx).trim();
  const actionRaw = modelAction.slice(idx + 1).trim();
  if (!modelId) return null;
  if (actionRaw !== 'generateContent' && actionRaw !== 'streamGenerateContent') {
    return null;
  }
  return { modelId, action: actionRaw };
}

export const geminiRoutes = new Hono<GeminiEnv>();

geminiRoutes.use('*', requireApiKey);
geminiRoutes.use('*', assignGenerationId);

/** `modelAction` 形如 `{modelId}:{generateContent|streamGenerateContent}`（见 `parseGeminiAction`）。 */
geminiRoutes.post('/models/:modelAction', async (c) => {
  const repos = c.get('repositories');
  const apiKey = c.get('apiKey');
  const start = Date.now();
  const requestCorrelationId = c.get('generationId')!;
  const timing = new RequestTimingCollector();
  const parsedAction = parseGeminiAction(c.req.param('modelAction'));
  if (!parsedAction) {
    return gatewayErrorJson(c, {
      status: 400,
      code: GatewayErrorCode.invalidRequest,
      message:
        'Invalid Gemini path, expected /v1beta/models/{model}:{generateContent|streamGenerateContent}',
    });
  }

  const { modelId: pathModelId, action } = parsedAction;
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return gatewayErrorJson(c, {
      status: 400,
      code: GatewayErrorCode.invalidJson,
      message: 'Invalid JSON body',
    });
  }

  const guardrail = await runGeminiRequestGuardrails(repos, {
    workspaceId: apiKey.workspaceId,
    userId: apiKey.userId,
    apiKeyId: apiKey.keyId,
    modelId: pathModelId,
    body,
    action,
    correlationId: requestCorrelationId,
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

  const fallbackPlan = await buildModelFallbackPlan(repos, {
    modelIds: [pathModelId],
    body,
    requestProtocol: 'gemini',
    requestOperation: GEMINI_GENERATE_OPERATION,
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
  const { model, baseModelId, effectiveRouteGroup, routes, upstreamBody } = selectedPlan;

  const modelNameForLog =
    model.display_name != null && String(model.display_name).trim() !== ''
      ? String(model.display_name).trim()
      : baseModelId;
  const requestBodyForLog = geminiRequestBodyForLog(body, action);

  const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
    baseModelId,
    modelNameForLog,
    requestBodyForLog,
    requestProtocol: 'gemini',
    startMs: start,
    timing,
  });
  if (circuitBlocked) {
    return circuitBlocked;
  }

  const requestSignal = c.req.raw.signal;
  const budgetEstimatePlan = [
    { ...selectedPlan, upstreamBody: geminiBodyForBudgetEstimate(upstreamBody) },
  ];
  const ordinaryEstimate = estimateOrdinaryBudgetChargedCost(
    budgetEstimatePlan,
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
      console.error(
        `[Gateway Gemini] ordinary budget cleanup failed requestId=${requestCorrelationId} state=${ordinaryBudgetLease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const guardrailBudgetMicros = estimateGuardrailBudgetMicros(
    budgetEstimatePlan,
    apiKey.chargedCostFactors,
  );
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
  let guardrailBudgetReserved = admission.reserved;
  let guardrailBudgetDispatched = false;
  let guardrailBudgetForfeited = false;
  const forfeitGuardrailBudget = async (reason: string): Promise<void> => {
    if (!guardrailBudgetDispatched || guardrailBudgetForfeited) return;
    try {
      await forfeitRequestGuardrailBudgets(
        repos,
        requestCorrelationId,
        guardrailBudgetReserved,
        reason,
      );
      guardrailBudgetForfeited = true;
    } catch (error) {
      console.error(
        `[Gateway Gemini] guardrail budget forfeit failed requestId=${requestCorrelationId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const beforeUpstreamDispatch = async (): Promise<void> => {
    if (guardrailBudgetReserved && !guardrailBudgetDispatched) {
      try {
        await markRequestGuardrailBudgetsDispatched(
          repos,
          requestCorrelationId,
          guardrailBudgetReserved,
        );
        guardrailBudgetDispatched = true;
      } catch (error) {
        await releaseRequestGuardrailBudgets(
          repos,
          requestCorrelationId,
          guardrailBudgetReserved,
          'dispatch_transition_failed',
        ).catch((releaseError: unknown) => {
          console.error(
            `[Gateway Gemini] guardrail budget release failed requestId=${requestCorrelationId} error=${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        });
        await terminateOrdinaryBudget('guardrail_dispatch_mark_failed');
        throw error;
      }
    }
    await ordinaryBudgetLease.beforeUpstreamDispatch();
  };
  const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'gemini');
  const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'gemini');
  timing.markGatewayComplete();
  let proxyResult: Awaited<ReturnType<typeof proxyGeminiContent>>;
  try {
    proxyResult = await proxyGeminiContent(
      repos,
      routes,
      action,
      upstreamBody,
      c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : '',
      requestSignal,
      {
        affinityKey,
        tierKeyPrefix,
        strategy: selectedPlan.strategy.base,
        tierStrategies: selectedPlan.strategy.tierOverrides,
        timing,
        routePoolId: selectedPlan.surface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
        sticky: selectedPlan.hasProviderPreferences ? null : stickyConfigFromSurface(selectedPlan.surface),
        beforeUpstreamDispatch,
      }
    );
  } catch (error) {
    await forfeitGuardrailBudget('upstream_dispatch_failed');
    await terminateOrdinaryBudget('upstream_dispatch_failed');
    throw error;
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
      console.error(
        `[Gateway Gemini] guardrail budget pre-dispatch release failed requestId=${requestCorrelationId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const {
    usagePromise,
    chosenRoute,
    upstreamRequestId,
    circuitEvents,
    suppressErrorAlert,
    stickyTrace,
    stickyMutationPromise,
  } = proxyResult;
  if (stickyMutationPromise) {
    scheduleBackgroundWork(c, stickyMutationPromise);
  }
  let { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response).catch(
    async (error: unknown) => {
      await forfeitGuardrailBudget('upstream_response_materialization_failed');
      await terminateOrdinaryBudget('upstream_response_materialization_failed');
      throw error;
    },
  );

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
      formatHttpErrorTextForRequestLog(
        response.status,
        response.headers.get('content-type'),
        errorBodyText
      )
    );
  }

  const alertCircuitEvents = userModelCircuitEvent
    ? [...circuitEvents, userModelCircuitEvent]
    : circuitEvents;

  const upstreamResponseOk = response.ok;
  let outputGuardrailBlocked = false;
  if (guardrail.outputFilters.length > 0 && response.ok) {
    const filtered = await filterGuardrailResponse(response, guardrail.outputFilters).catch(
      async (error: unknown) => {
        await forfeitGuardrailBudget('output_guardrail_failed_after_dispatch');
        await terminateOrdinaryBudget('output_guardrail_failed_after_dispatch');
        throw error;
      },
    );
    await auditGuardrailOutputDecision(repos, {
	  workspaceId: apiKey.workspaceId,
      userId: apiKey.userId,
      apiKeyId: apiKey.keyId,
      modelIds: [pathModelId],
      trace: guardrail.trace,
      blockedBy: filtered.blockedBy,
      redactionCount: filtered.redactionCount,
      correlationId: requestCorrelationId,
    }).catch((error: unknown) => {
      console.warn(
        `[Gateway Gemini] output guardrail audit failed requestId=${requestCorrelationId} error=${error instanceof Error ? error.message : String(error)}`,
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
          errorMessage = `HTTP ${response.status}`;
        }
        const upstreamRequestBodyForLog = geminiUpstreamWireBodyForLog(chosenRoute, upstreamBody, action);
        const loggedRequestId = resolveGeminiLoggedRequestId({
          headerRequestId: upstreamRequestId,
          bodyRequestId: usageCollected.upstreamBodyRequestId ?? null,
        });
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
		  request_origin: new URL(c.req.url).origin,
		  response_streamed: action === 'streamGenerateContent',
          request_protocol: 'gemini',
          request_operation: GEMINI_GENERATE_OPERATION,
          upstream_protocol: chosenRoute.upstreamProtocol,
          upstream_operation: chosenRoute.upstreamOperation,
          model_surface_id: chosenRoute.modelSurfaceId,
          route_pool_id: chosenRoute.routePoolId,
          route_target_id: chosenRoute.targetId,
          adapter: chosenRoute.adapter,
          gemini_wire_action: action,
          sticky_trace: stickyTrace ? await stickyTrace() : null,
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
          upstream_request_id: loggedRequestId,
          upstream_message_id: usageCollected.upstreamMessageId ?? null,
          circuit_events: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
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
        console.error(
          `[Gateway Gemini] recordUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} error=${error instanceof Error ? error.message : String(error)}`,
        );
        await forfeitGuardrailBudget('request_usage_settlement_failed');
        await terminateOrdinaryBudget('request_usage_settlement_failed');
      })
  );

  return response;
});
