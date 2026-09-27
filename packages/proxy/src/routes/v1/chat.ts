/**
 * 用户路由：`POST /v1/chat/completions`（OpenAI 协议）。
 * 流程：鉴权 → 解析 model 与 route_group → 预算校验 → 按协议筛选路由并 proxy 故障转移 → 异步记账。
 */
import { scheduleResourceCompletion } from '../../runtime/schedule-resource-completion';
import { Hono, type Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import type { RouteResult } from '../../services/model-router';
import {
  buildAffinityKey,
  buildTierKeyPrefix,
} from '../../services/route-strategies';
import { proxyChatCompletions, EMPTY_USAGE, type ProxyResult } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { generationRequestLogContext } from '../../services/generation-request-context';
import { summarizeOpenAiToolsForLog } from '../../services/request-log-tools-summary';
import { buildRouteRequestBody } from '../../services/route-default-params';
import {
  hasPotentiallyBillableUnknownSharedKeyAttempt,
  recordUsage,
} from '../../services/usage-tracker';
import { parseSharedKeyId } from '../../services/shared-key-pool';
import {
  createConfiguredSharedKeyQuoteAttemptCapture,
  type SharedKeyQuoteAttemptCapture,
  type SharedKeyQuoteAttemptHandoff,
  type SharedKeyQuoteAttemptReference,
} from '../../services/shared-key-quote-attempt';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
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
  parseOpenAiModelFallbacks,
  type ModelFallbackTraceAttempt,
} from '../../services/model-fallbacks';
import {
  getUserModelCircuitOpen,
} from '../../services/user-model-circuit-breaker';
import { resolveRequestPreset } from '@octafuse/core';
import {
  auditGuardrailOutputDecision,
  filterGuardrailResponse,
  runRequestGuardrails,
} from '../../services/request-guardrails';
import {
  estimateGuardrailBudgetMicros,
	estimateGatewayKeyByokBudgetMicros,
  estimateOrdinaryBudgetChargedCost,
} from '../../services/guardrail-budget-estimate';
import {
  createRouteAwareBudgetAdmission,
  RequestBudgetAdmissionError,
  type RouteAwareBudgetAdmission,
} from '../../services/request-budget-admission';
import {
	AuthenticatedChatBudgetProofError,
	createAuthenticatedChatBudgetProof,
} from '../../services/authenticated-chat-budget-proof';
import { createRequestDispatchBudget } from '../../services/request-dispatch-budget';
import { assertTextRequestActive, textRequestFailureResponse, waitForTextRequestRead } from '../../middleware/text-request-lifecycle';
import {
  textUsageCostIsUnknown,
  textUsageWithSafetyTimeout,
} from '../../services/text-usage-settlement';
import { ensureOpenAiStreamIncludesUsage } from '../../services/egress/openai-stream-usage-request';
import {
  attachOpenRouterMetadata,
  openRouterMetadataRequested,
  routerMetadataGuardrailStage,
  type RouterMetadataPipelineStage,
} from '../../services/openrouter-router-metadata';
import {
  adaptChatResponseToLegacyCompletion,
  adaptLegacyCompletionRequest,
  refreshLegacyCompletionEchoOptions,
  type LegacyCompletionResponseOptions,
} from '../../services/legacy-completions-compat';
import { resolveServiceTierBillingRoute } from '../../services/service-tier-billing';
import {
  buildOpenRouterSessionAffinityKey,
  openRouterSessionDispatchOptions,
  prepareOpenRouterSessionRouting,
  resolveOpenRouterStickyRouting,
} from '../../services/openrouter-session-routing';
import { privateByokContextForApiKey } from '../../services/byok-key-pool';
import {
  openPostgresChatBudgetRequestOwner,
  type PostgresChatBudgetRequestOwner,
} from '../../services/postgres-chat-budget-request-owner';
import { chatBudgetOwnerResourceCompletion } from '../../services/chat-budget-owner-lifecycle';
import {
  createFinalChatQuoteInput,
  FinalChatQuoteInputError,
  originalChatBodySha256,
  type FinalChatQuoteInput,
} from '../../services/chat-final-quote-input';
import { preparedTextAttemptMatchesRoute } from '../../services/egress/prepared-text-attempt';

/** 流若长期不结束（上游挂死），超过此时长仍无 usage 则按 incomplete 记账；正常/取消场景通常很快结束。 */
const USAGE_SAFETY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

/** OpenAI Chat Completions：去掉消息与内嵌多模态 data，保留采样/工具等元数据。 */
function openAiBodyRedactedForLog(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'messages' || k === 'input' || k === 'prompt' || k === 'data' || k === 'prompt_cache_key') {
      continue;
    }
    if (k === 'tools') {
      Object.assign(out, summarizeOpenAiToolsForLog(v));
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(body.messages)) {
    out._messages_count = body.messages.length;
  }
  return out;
}

function openAiRequestBodyForLog(body: Record<string, unknown>): string | null {
  return finalizeRequestLogJson(openAiBodyRedactedForLog(body));
}

/** 与 openai-driver 一致：`{ ...buildRouteRequestBody, model }` 再脱敏（与 messages 分写，便于日后分叉）。 */
function openAiUpstreamWireBodyForLog(route: RouteResult, body: Record<string, unknown>): string | null {
  const merged = buildRouteRequestBody(route, body);
  const wire = ensureOpenAiStreamIncludesUsage({ ...merged, model: route.providerModelName });
  return finalizeRequestLogJson(openAiBodyRedactedForLog(wire));
}

/** 本路由在根 `Env` 上收窄 `Variables.apiKey` 为必填。 */
export type ChatEnv = Env & { Variables: { apiKey: import('../../middleware/auth').ApiKeyContext } };

export type ChatRequestMode = 'chat' | 'legacy-completions';

export const chatRoutes = new Hono<ChatEnv>();

chatRoutes.use('*', requireApiKey);
chatRoutes.use('*', assignGenerationId);

/** body 须含 `model`；流式结束时异步记账，含 usage 兜底超时。 */
export async function handleChatCompletion(
  c: Context<ChatEnv>,
  mode: ChatRequestMode = 'chat',
): Promise<Response> {
  const repos = c.get('repositories');
  const apiKey = c.get('apiKey');
  const start = Date.now();
  const requestCorrelationId = c.get('generationId')!;
  let quoteAttemptCapture: SharedKeyQuoteAttemptCapture | null;
  try {
    quoteAttemptCapture = createConfiguredSharedKeyQuoteAttemptCapture({
      activation: c.env.SHARED_KEY_QUOTE_ATTEMPTS_ENABLED,
      connectionString: c.env.QUOTE_ATTEMPT_HYPERDRIVE?.connectionString,
      databaseDriver: repos.client.driver,
      requestLogId: requestCorrelationId,
    });
  } catch {
    return gatewayErrorJson(c, {
      status: 503,
      code: GatewayErrorCode.capacityUnavailable,
      message: 'Shared-key quote attempt producer is not ready',
    });
  }
  const economicProducer = c.get('sharedKeyEconomicProducer');
  // A quote reference alone cannot replace the current mutable-price seller
  // settlement. No opt-in route may send until a typed economic writer owns it.
  if (quoteAttemptCapture && !economicProducer) {
    return gatewayErrorJson(c, {
      status: 503,
      code: GatewayErrorCode.capacityUnavailable,
      message: 'Shared-key economic producer is not ready',
    });
  }
  if (economicProducer && !quoteAttemptCapture) {
    return gatewayErrorJson(c, {
      status: 503,
      code: GatewayErrorCode.capacityUnavailable,
      message: 'Shared-key quote attempt producer is not ready',
    });
  }
  if (quoteAttemptCapture && c.env.AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED !== 'reviewed-v1') {
    return gatewayErrorJson(c, {
      status: 503,
      code: GatewayErrorCode.capacityUnavailable,
      message: 'Aggregate Chat budget proof is not ready',
    });
  }
  const recordQuotedUsage = (
    usage: Parameters<typeof recordUsage>[1],
    selectedReference: SharedKeyQuoteAttemptReference | null,
    handoff: SharedKeyQuoteAttemptHandoff | null,
  ): Promise<void> => {
    if (quoteAttemptCapture && handoff?.quoteAttempts.length === 0
      && parseSharedKeyId(usage.provider_key_id) !== null) {
      throw new Error('Selected shared key has no quote attempt');
    }
    return handoff && handoff.quoteAttempts.length > 0
      ? economicProducer!.recordUsageAndOutbox(repos, usage, handoff, selectedReference)
      : recordUsage(repos, usage);
  };
  const timing = new RequestTimingCollector();
  const dispatchBudget = c.get('textRequestLifecycle')?.dispatchBudget ?? createRequestDispatchBudget();
  const routerMetadataEnabled = openRouterMetadataRequested(c.req.raw.headers);
  const routerMetadataProtocol = mode === 'legacy-completions' ? 'completions' : 'chat';
  let legacyResponseOptions: LegacyCompletionResponseOptions | null = null;
  let legacyAdaptationFailure = Promise.resolve<string | null>(null);

  let body: { model?: string; [k: string]: unknown };
  let originalBodySha256: string | null = null;
  try {
    if (c.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED === 'reviewed-v1') {
      // Clone only in the explicit review path. The ingress middleware already
      // bounds the source stream; this hashes its original bytes before any
      // preset, Guardrail or model-list transformation can change the body.
      originalBodySha256 = await originalChatBodySha256(await c.req.raw.clone().arrayBuffer());
      assertTextRequestActive(c);
    }
    body = await c.req.json();
  } catch (error) {
    const failure = textRequestFailureResponse(error, c);
    if (failure) return failure;
    if (error instanceof FinalChatQuoteInputError) {
      return gatewayErrorJson(c, {
        status: 413,
        code: GatewayErrorCode.payloadTooLarge,
        message: error.message,
      });
    }
    return gatewayErrorJson(c, {
      status: 400,
      code: GatewayErrorCode.invalidJson,
      message: 'Invalid JSON body',
    });
  }

  const preparedSession = prepareOpenRouterSessionRouting(body, c.req.raw.headers);
  if (!preparedSession.ok) {
    return gatewayErrorJson(c, {
      status: 400,
      code: GatewayErrorCode.invalidRequest,
      message: preparedSession.message,
    });
  }
  body = preparedSession.body;
  let sessionRouting = preparedSession.routing;

  if (mode === 'legacy-completions') {
    const adapted = adaptLegacyCompletionRequest(body);
    if (!adapted.ok) {
      return gatewayErrorJson(c, {
        status: 400,
        code: GatewayErrorCode.invalidRequest,
        message: adapted.message,
      });
    }
    body = adapted.chatBody;
    legacyResponseOptions = {
      ...adapted.responseOptions,
      requestId: requestCorrelationId,
    };
  }

  assertTextRequestActive(c);
  const presetResolution = await waitForTextRequestRead(c, resolveRequestPreset, repos, apiKey.workspaceId, apiKey.userId, body, 'chat');
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

  let parsedModels = parseOpenAiModelFallbacks(body);
  if (!parsedModels.ok) {
    return gatewayErrorJson(c, {
      status: 400,
      code: parsedModels.missingModel ? GatewayErrorCode.missingModel : GatewayErrorCode.invalidRequest,
      message: parsedModels.message,
    });
  }
  const preGuardrailModelIds = [...parsedModels.value.modelIds];

  assertTextRequestActive(c);
  const guardrail = await runRequestGuardrails(repos, {
    workspaceId: apiKey.workspaceId,
    userId: apiKey.userId,
    apiKeyId: apiKey.keyId,
    modelIds: parsedModels.value.modelIds,
    body,
    correlationId: requestCorrelationId,
	now: new Date(start),
  });
  assertTextRequestActive(c);
  if (!guardrail.ok) {
    const guardrailResponse = gatewayErrorJson(c, {
      status: guardrail.status,
      code: guardrail.code === 'guardrail_invalid' ? GatewayErrorCode.guardrailInvalid : GatewayErrorCode.guardrailBlocked,
      message: guardrail.message,
    });
    const diagnosticPlan = routerMetadataEnabled
      ? await waitForTextRequestRead(c, buildModelFallbackPlan, repos, {
          control: c.get('textRequestLifecycle')?.deadline,
          modelIds: preGuardrailModelIds,
          body: parsedModels.value.upstreamBody,
          requestProtocol: 'openai',
          requestOperation: 'chat',
          pricingAt: new Date(start),
        })
      : null;
    return attachOpenRouterMetadata(guardrailResponse, {
      enabled: routerMetadataEnabled,
      protocol: routerMetadataProtocol,
      requestHeaders: c.req.raw.headers,
      requestedModelIds: preGuardrailModelIds,
      candidates: diagnosticPlan?.ok ? diagnosticPlan.candidates : [],
      timing,
      pipeline: guardrail.code === 'guardrail_blocked'
        ? [routerMetadataGuardrailStage('request', 'blocked', 1)]
        : [],
    });
  }
  body = guardrail.body;
  if (legacyResponseOptions) {
    const refreshedEcho = refreshLegacyCompletionEchoOptions(legacyResponseOptions, body);
    if (!refreshedEcho.ok) {
      return gatewayErrorJson(c, {
        status: 400,
        code: GatewayErrorCode.invalidRequest,
        message: refreshedEcho.message,
      });
    }
    legacyResponseOptions = refreshedEcho.options;
  }
  parsedModels = parseOpenAiModelFallbacks(body);
  if (!parsedModels.ok) {
    return attachOpenRouterMetadata(
      gatewayErrorJson(c, { status: 400, code: GatewayErrorCode.invalidRequest, message: parsedModels.message }),
      {
        enabled: routerMetadataEnabled,
        protocol: routerMetadataProtocol,
        requestHeaders: c.req.raw.headers,
        requestedModelIds: preGuardrailModelIds,
        candidates: [],
        timing,
      },
    );
  }
  const finalParsedModels = parsedModels.value;
  sessionRouting = resolveOpenRouterStickyRouting(sessionRouting, body, 'chat');
  const requestedModelIds = [...parsedModels.value.modelIds];
  const routerMetadataPipeline: RouterMetadataPipelineStage[] = [];
  if (guardrail.flagCount > 0) routerMetadataPipeline.push(routerMetadataGuardrailStage('request', 'flagged', guardrail.flagCount));
  if (guardrail.redactionCount > 0) routerMetadataPipeline.push(routerMetadataGuardrailStage('request', 'redacted', guardrail.redactionCount));

  const fallbackPlan = await waitForTextRequestRead(c, buildModelFallbackPlan, repos, {
    control: c.get('textRequestLifecycle')?.deadline,
    modelIds: parsedModels.value.modelIds,
    body: parsedModels.value.upstreamBody,
    requestProtocol: 'openai',
    requestOperation: 'chat',
    pricingAt: new Date(start),
  });
  if (!fallbackPlan.ok) {
    return attachOpenRouterMetadata(
      gatewayErrorJson(c, {
        status: fallbackPlan.status,
        code: fallbackPlan.code,
        message: fallbackPlan.message,
      }),
      {
        enabled: routerMetadataEnabled,
        protocol: routerMetadataProtocol,
        requestHeaders: c.req.raw.headers,
        requestedModelIds,
        candidates: [],
        timing,
        pipeline: routerMetadataPipeline,
      },
    );
  }
  const attachRoutedMetadata = (
    routedResponse: Response,
    chosenRoute: RouteResult | null = null,
  ): Promise<Response> => attachOpenRouterMetadata(routedResponse, {
    enabled: routerMetadataEnabled,
    protocol: routerMetadataProtocol,
    requestHeaders: c.req.raw.headers,
    requestedModelIds,
    candidates: fallbackPlan.candidates,
    timing,
    chosenRoute,
    pipeline: routerMetadataPipeline,
  });

  let finalQuoteInput: FinalChatQuoteInput | null = null;
  if (c.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED === 'reviewed-v1') {
    if (mode !== 'chat' || originalBodySha256 === null) {
      return attachRoutedMetadata(gatewayErrorJson(c, {
        status: 503,
        code: GatewayErrorCode.capacityUnavailable,
        message: 'Final Chat quote input is not available for this operation',
      }));
    }
    try {
      finalQuoteInput = await createFinalChatQuoteInput({
        requestId: requestCorrelationId,
        originalBodySha256,
        finalBody: body,
        parsed: finalParsedModels,
        plan: fallbackPlan,
      });
    } catch (error) {
      return attachRoutedMetadata(gatewayErrorJson(c, {
        status: 503,
        code: GatewayErrorCode.capacityUnavailable,
        message: error instanceof Error ? error.message : 'Final Chat quote input is invalid',
      }));
    }
  }

  const requestBodyForLog = openAiRequestBodyForLog(body as Record<string, unknown>);
  const requestSignal = c.req.raw.signal;
  const ordinaryEstimate = estimateOrdinaryBudgetChargedCost(
    fallbackPlan.candidates,
    apiKey.chargedCostFactors,
  );
  if (!ordinaryEstimate.ok) {
    return attachRoutedMetadata(gatewayErrorJson(c, {
      status: 502,
      code: GatewayErrorCode.routeResolutionFailed,
      message: ordinaryEstimate.message,
    }));
  }
  const guardrailBudgetMicros = estimateGuardrailBudgetMicros(
    fallbackPlan.candidates,
    apiKey.chargedCostFactors,
  );
	const byokGatewayKeyBudgetMicros = Math.max(
		guardrailBudgetMicros,
		estimateGatewayKeyByokBudgetMicros(fallbackPlan.candidates),
	);
  assertTextRequestActive(c);
  let budgetAdmission!: RouteAwareBudgetAdmission;
  let budgetAdmissionOpened = false;
  let postgresBudgetOwner: PostgresChatBudgetRequestOwner | null = null;
  let usageSettlementTask: Promise<void> | null = null;
  try {
  if (c.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED !== undefined
    && c.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED !== 'reviewed-v1') {
    return attachRoutedMetadata(gatewayErrorJson(c, {
      status: 503,
      code: GatewayErrorCode.capacityUnavailable,
      message: 'PostgreSQL Chat budget owner activation invalid',
    }));
  }
  if (c.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED === 'reviewed-v1') {
    const runtimeConnectionString = c.env.HYPERDRIVE?.connectionString;
    const admissionConnectionString = c.env.BUDGET_ADMISSION_HYPERDRIVE?.connectionString;
    const recoveryConnectionString = c.env.BUDGET_RECOVERY_HYPERDRIVE?.connectionString;
    if (c.env.AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED !== 'reviewed-v1'
      || repos.client.driver !== 'postgres'
      || !runtimeConnectionString || !admissionConnectionString || !recoveryConnectionString) {
      return attachRoutedMetadata(gatewayErrorJson(c, {
        status: 503,
        code: GatewayErrorCode.capacityUnavailable,
        message: 'PostgreSQL Chat budget owner is not configured',
      }));
    }
    try {
      postgresBudgetOwner = await (c.get('chatBudgetRequestOwnerFactory')
        ?? openPostgresChatBudgetRequestOwner)({
          runtimeClient: repos.client,
          runtimeConnectionString,
          admissionConnectionString,
          recoveryConnectionString,
          finalQuoteInput: finalQuoteInput!,
          identity: {
            requestId: requestCorrelationId,
            userId: apiKey.userId,
            apiKeyId: apiKey.keyId,
            expectedBudgetEpoch: apiKey.budgetEpoch,
          },
        });
    } catch (error) {
      // An opener can fail after one direct LOGIN was created. Its cleanup
      // receipt is not available to this route, so hold numeric capacity.
      scheduleResourceCompletion(c, Promise.resolve('unconfirmed'));
      throw error;
    }
    if (!postgresBudgetOwner || typeof postgresBudgetOwner.close !== 'function'
      || !postgresBudgetOwner.ordinaryBudgetRepositories
      || !postgresBudgetOwner.guardrailBudgetRequestPort) {
      scheduleResourceCompletion(c, Promise.resolve('unconfirmed'));
      throw new TypeError('PostgreSQL Chat budget owner did not provide both request ports and close receipt');
    }
    assertTextRequestActive(c);
  }
  let authenticatedBudgetProof: ReturnType<typeof createAuthenticatedChatBudgetProof> | null = null;
  if (c.env.AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED === 'reviewed-v1') {
    try {
      authenticatedBudgetProof = createAuthenticatedChatBudgetProof({
        requestId: requestCorrelationId,
        authenticatedKey: apiKey,
        plan: fallbackPlan,
        budgetIntents: guardrail.budgetIntents,
        now: postgresBudgetOwner ? new Date() : new Date(start),
      });
      budgetAdmission = await authenticatedBudgetProof.open(repos, postgresBudgetOwner
        ? {
            ordinaryBudgetRepositories: postgresBudgetOwner.ordinaryBudgetRepositories,
            ordinaryRecoveryFailureMode: 'fail_closed',
            guardrailBudgetRequestPort: postgresBudgetOwner.guardrailBudgetRequestPort,
          }
        : undefined);
      budgetAdmissionOpened = true;
    } catch (error) {
      if (!(error instanceof AuthenticatedChatBudgetProofError)) throw error;
      return attachRoutedMetadata(gatewayErrorJson(c, {
        status: 502,
        code: GatewayErrorCode.routeResolutionFailed,
        message: error.message,
      }));
    }
  } else if (c.env.AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED !== undefined) {
    return attachRoutedMetadata(gatewayErrorJson(c, {
      status: 503,
      code: GatewayErrorCode.routeResolutionFailed,
      message: 'Authenticated Chat budget proof activation invalid',
    }));
  } else budgetAdmission = await createRouteAwareBudgetAdmission(repos, {
    ordinary: {
      requestId: requestCorrelationId,
      userId: apiKey.userId,
      apiKeyId: apiKey.keyId,
      budgetMax: apiKey.budgetMax,
      expectedBudgetEpoch: apiKey.budgetEpoch,
      estimatedChargedCost: ordinaryEstimate.estimatedChargedCost,
      now: new Date(start),
    },
    guardrail: {
      intents: guardrail.budgetIntents,
      reservedMicros: guardrailBudgetMicros,
      now: new Date(start),
    },
		privateByokGatewayKey: {
			includeInLimit: apiKey.includeByokInLimit === true,
			reservedMicros: byokGatewayKeyBudgetMicros,
		},
  });
  budgetAdmissionOpened = true;
  assertTextRequestActive(c);
  const ordinaryBudgetLease = budgetAdmission.ordinaryLease;
  const terminateOrdinaryBudget = async (reason: string): Promise<void> => {
    try {
      await ordinaryBudgetLease.terminateUnknown(reason);
    } catch (error) {
      console.error(
        `[Gateway Chat] ordinary budget cleanup failed requestId=${requestCorrelationId} state=${ordinaryBudgetLease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const forfeitGuardrailBudget = async (reason: string): Promise<void> => {
    if (!budgetAdmission.guardrailDispatched || budgetAdmission.guardrailTerminal) return;
    try {
      await budgetAdmission.forfeitGuardrailPostDispatch(reason);
    } catch (error) {
      console.error(
        `[Gateway Chat] guardrail budget forfeit failed requestId=${requestCorrelationId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  let optInDispatchGrantUsed = false;
  const beforeUpstreamDispatch = async (route: RouteResult, preparedAttempt?: unknown): Promise<void> => {
    finalQuoteInput?.assertCurrent(body, finalParsedModels, fallbackPlan);
    assertTextRequestActive(c);
    if (postgresBudgetOwner && !preparedTextAttemptMatchesRoute(preparedAttempt, route)) {
      throw new RequestBudgetAdmissionError({
        code: GatewayErrorCode.permissionDenied,
        message: 'Text dispatch identity could not be verified',
      });
    }
    if (postgresBudgetOwner && optInDispatchGrantUsed) {
      throw new RequestBudgetAdmissionError({
        code: GatewayErrorCode.budgetExceeded,
        message: 'Chat request dispatch grant has already been consumed',
      });
    }
    // A failed DB acknowledgement may still have committed. Never enter the
    // privileged dispatch boundary twice in this review-only mode.
    if (postgresBudgetOwner) optInDispatchGrantUsed = true;
    const quotedSharedKey = quoteAttemptCapture && parseSharedKeyId(route.providerKeyId) !== null;
    if (quotedSharedKey && (apiKey.budgetMax === null
      || ordinaryEstimate.estimatedChargedCost <= 0)) {
      throw new RequestBudgetAdmissionError({
        code: GatewayErrorCode.budgetExceeded,
        message: 'Quoted shared-key dispatch requires a finite ordinary budget hold',
      });
    }
    await budgetAdmission.beforeUpstreamDispatch(route);
    assertTextRequestActive(c);
    if (quotedSharedKey
      && (!ordinaryBudgetLease.reserved || ordinaryBudgetLease.state !== 'dispatched')) {
      throw new RequestBudgetAdmissionError({
        code: GatewayErrorCode.budgetExceeded,
        message: 'Quoted shared-key dispatch requires a finite ordinary budget hold',
      });
    }
  };
  timing.markGatewayComplete();
  const fallbackAttempts: ModelFallbackTraceAttempt[] = [];
  const accumulatedCircuitEvents: NonNullable<ProxyResult['circuitEvents']> = [];
  let selectedPlan: ModelFallbackCandidatePlan | null = null;
  let proxyResult: ProxyResult | null = null;
  let response: Response | null = null;
  let errorBodyText: string | null = null;
  let upstreamOutcomeUnknownObserved = false;
  let userModelCircuitEvent: ReturnType<typeof maybeTriggerUserModelCircuitFromUpstream> = null;

  if (fallbackPlan.endpointPartition === 'none') {
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
        quoteAttemptCapture: quoteAttemptCapture ?? undefined,
        requirePreparedTextAttemptIdentity: postgresBudgetOwner !== null,
        stopAfterFirstGrantedDispatch: postgresBudgetOwner !== null,
        dispatchBudget,
        registerResourceCompletion: task => scheduleResourceCompletion(c, task),
        proxy: proxyChatCompletions,
        affinityKey: sessionRouting.stickyKeyDigest != null && sessionRouting.stickySource != null
          ? buildOpenRouterSessionAffinityKey({
              userId: apiKey.userId,
              workspaceId: apiKey.workspaceId,
              stickyKeyDigest: sessionRouting.stickyKeyDigest,
              stickySource: sessionRouting.stickySource,
              baseModelId: 'global',
            })
          : buildAffinityKey(apiKey.userId, 'global', 'partition-none', 'openai'),
        tierKeyPrefix: buildTierKeyPrefix('global', 'partition-none', 'openai'),
        byok: privateByokContextForApiKey(apiKey),
      });
    } catch (error) {
      await forfeitGuardrailBudget('upstream_dispatch_failed');
      await terminateOrdinaryBudget('upstream_dispatch_failed');
      throw error;
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
        requestProtocol: 'openai',
        startMs: start,
        timing,
        modelFallbackTrace: buildModelFallbackTrace(
          parsedModels.value.modelIds,
          globalDispatch.fallbackAttempts,
        ),
      });
      if (budgetAdmission.guardrailReserved && !budgetAdmission.guardrailDispatched) {
        await budgetAdmission.releaseGuardrailPreDispatch('upstream_dispatch_not_started');
      }
      await terminateOrdinaryBudget('circuit_open_before_dispatch');
      if (circuitBlocked) return attachRoutedMetadata(circuitBlocked);
      throw new Error('All globally sorted model candidates were circuit-open');
    }
    accumulatedCircuitEvents.push(
      ...globalDispatch.result.circuitEvents,
      ...globalDispatch.userModelCircuitEvents,
    );
    const materialized = await materializeNonOkResponse(globalDispatch.result.response, {
      trustedGatewayError: globalDispatch.result.meta?.gatewayGeneratedError === true,
    }).catch(
      async (error: unknown) => {
        await forfeitGuardrailBudget('upstream_response_materialization_failed');
        await terminateOrdinaryBudget('upstream_response_materialization_failed');
        throw error;
      },
    );
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
        requestProtocol: 'openai',
        startMs: start,
        timing,
        modelFallbackTrace: buildModelFallbackTrace(parsedModels.value.modelIds, fallbackAttempts),
      });
      if (circuitBlocked) {
        await forfeitGuardrailBudget('circuit_open_after_upstream_dispatch');
        await terminateOrdinaryBudget('circuit_open_before_terminal_response');
        return attachRoutedMetadata(circuitBlocked);
      }
      fallbackAttempts.pop();
    }

    console.log(
      `[Gateway Chat] forwarding baseModelId=${candidate.baseModelId} clientModel=${candidate.requestedModelId} providerIds=${candidate.routes.map((route) => route.providerId).join(',')} keyId=${apiKey.keyId}`
    );
    const sessionDispatch = openRouterSessionDispatchOptions({
      routing: sessionRouting,
      userId: apiKey.userId,
      workspaceId: apiKey.workspaceId,
      baseModelId: candidate.baseModelId,
      routeGroup: candidate.effectiveRouteGroup,
      protocol: 'openai',
      surface: candidate.surface,
      hasProviderPreferences: candidate.hasProviderPreferences,
      routingPreferences: candidate.routingPreferences,
    });
    let result: ProxyResult;
    try {
      result = await proxyChatCompletions(
        repos,
        candidate.routes,
        candidate.upstreamBody,
        requestSignal,
        {
          affinityKey: sessionDispatch.affinityKey,
          tierKeyPrefix: buildTierKeyPrefix(candidate.baseModelId, candidate.effectiveRouteGroup, 'openai'),
          strategy: candidate.strategy.base,
          tierStrategies: candidate.strategy.tierOverrides,
          timing,
          routePoolId: candidate.surface?.route_pool_id ?? candidate.routes[0]?.routePoolId ?? null,
          sticky: sessionDispatch.sticky,
          stickySuccessPolicy: sessionDispatch.stickySuccessPolicy,
          stickyRouteEligible: sessionDispatch.stickyRouteEligible,
          deferFinalAttempt: !isLastCandidate,
          beforeUpstreamDispatch,
          quoteAttemptCapture: quoteAttemptCapture ?? undefined,
          requirePreparedTextAttemptIdentity: postgresBudgetOwner !== null,
          stopAfterFirstGrantedDispatch: postgresBudgetOwner !== null,
          dispatchBudget,
          registerResourceCompletion: task => scheduleResourceCompletion(c, task),
          byok: privateByokContextForApiKey(apiKey),
        },
        requestCorrelationId,
      );
    } catch (error) {
      await forfeitGuardrailBudget('upstream_dispatch_failed');
      await terminateOrdinaryBudget('upstream_dispatch_failed');
      throw error;
    }
    if (result.stickyMutationPromise) {
      scheduleBackgroundWork(c, result.stickyMutationPromise);
    }
    upstreamOutcomeUnknownObserved ||= result.meta?.upstreamOutcomeUnknown === true;
    if (upstreamOutcomeUnknownObserved) {
      result.meta = { ...(result.meta ?? {}), upstreamOutcomeUnknown: true };
    }
    accumulatedCircuitEvents.push(...result.circuitEvents);
    const materialized = await materializeNonOkResponse(result.response, {
      trustedGatewayError: result.meta?.gatewayGeneratedError === true,
    }).catch(async (error: unknown) => {
      await forfeitGuardrailBudget('upstream_response_materialization_failed');
      await terminateOrdinaryBudget('upstream_response_materialization_failed');
      throw error;
    });
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
      ...(result.meta?.admissionDeniedPreDispatch === true
        ? {}
        : {
            provider_id: result.chosenRoute.providerId,
            route_target_id: result.chosenRoute.targetId,
          }),
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
    if (materialized.errorBodyText != null && result.meta?.gatewayGeneratedError !== true) {
      userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
        apiKey.userId,
        candidate.baseModelId,
        materialized.response.status,
        materialized.response.headers.get('content-type'),
        materialized.errorBodyText,
        attemptError,
      );
      if (userModelCircuitEvent) accumulatedCircuitEvents.push(userModelCircuitEvent);
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
    // A terminal denial/unknown outcome must also stop the outer model loop.
    break;
  }
  }

  if (!selectedPlan || !proxyResult || !response) {
	await forfeitGuardrailBudget('fallback_exhausted_after_dispatch');
    await terminateOrdinaryBudget('fallback_exhausted');
    throw new Error('Model fallback planner exhausted without a terminal response');
  }
  if (ordinaryBudgetLease.state === 'reserved') {
    await terminateOrdinaryBudget('upstream_dispatch_not_started');
  }
  if (budgetAdmission.guardrailReserved && !budgetAdmission.guardrailDispatched) {
    try {
      await budgetAdmission.releaseGuardrailPreDispatch('upstream_dispatch_not_started');
    } catch (error) {
      console.error(
        `[Gateway Chat] guardrail budget pre-dispatch release failed requestId=${requestCorrelationId} error=${error instanceof Error ? error.message : String(error)}`,
      );
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
		await forfeitGuardrailBudget('output_guardrail_failed_after_dispatch');
		await terminateOrdinaryBudget('output_guardrail_failed_after_dispatch');
		throw error;
	});
    try {
      await auditGuardrailOutputDecision(repos, {
		workspaceId: apiKey.workspaceId,
        userId: apiKey.userId, apiKeyId: apiKey.keyId, modelIds: parsedModels.value.modelIds,
        trace: guardrail.trace, blockedBy: filtered.blockedBy, redactionCount: filtered.redactionCount,
        correlationId: requestCorrelationId,
      });
    } catch (error) {
      console.error(
        `[Gateway Chat] output guardrail audit failed requestId=${requestCorrelationId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (filtered.blockedBy) {
      outputGuardrailBlocked = true;
      routerMetadataPipeline.push(routerMetadataGuardrailStage('response', 'blocked', 1));
      errorBodyText = 'Guardrail blocked response output';
      response = gatewayErrorJson(c, {
        status: 403, code: GatewayErrorCode.guardrailBlocked, message: 'Response blocked by output guardrail',
      });
    } else {
      if (filtered.redactionCount > 0) {
        routerMetadataPipeline.push(routerMetadataGuardrailStage('response', 'redacted', filtered.redactionCount));
      }
      response = filtered.response;
    }
  }

  if (legacyResponseOptions && response.ok) {
    let settleLegacyAdaptation!: (failure: string | null) => void;
    legacyAdaptationFailure = new Promise((resolve) => {
      settleLegacyAdaptation = resolve;
    });
    response = await adaptChatResponseToLegacyCompletion(response, {
      ...legacyResponseOptions,
      onSettled: settleLegacyAdaptation,
    });
  }

  response = await attachRoutedMetadata(response, chosenRoute);

  const usageOrSafety = textUsageWithSafetyTimeout(
    usagePromise,
    USAGE_SAFETY_TIMEOUT_MS,
    EMPTY_USAGE,
  );

  usageSettlementTask = usageOrSafety
      .then(async ({ usage: usageCollected, incomplete, timedOut }) => {
        // A hung upstream is already bounded by the existing usage safety timer;
        // do not let the compatibility observer extend that background lifetime.
        const adaptationFailure = timedOut ? null : await legacyAdaptationFailure;
        const latency = Date.now() - start;
        if (timedOut) timing.markStreamComplete();
		timing.finalizeSelectedAttemptAvailability({
		  clientCancelled: Boolean(usageCollected.cancelled) && adaptationFailure == null,
		  invalidResponse: Boolean(usageCollected.stream_error)
			|| (proxyResult.meta?.gatewayGeneratedError === true && !upstreamResponseOk),
		});
        const status = computeRequestLogStatus({
          cancelled: Boolean(usageCollected.cancelled) && adaptationFailure == null,
          responseOk: response.ok,
          incomplete,
          streamError: Boolean(usageCollected.stream_error) || adaptationFailure != null,
        });
        const serviceTierBilling = resolveServiceTierBillingRoute(
          chosenRoute,
          selectedPlan.routes,
          usageCollected.service_tier,
        );
        const pricingRoute = serviceTierBilling.pricingRoute;
        const costUnknown = textUsageCostIsUnknown({
          upstreamResponseOk,
          usageAvailable: !incomplete,
          cancelled: Boolean(usageCollected.cancelled),
          streamError: Boolean(usageCollected.stream_error) || adaptationFailure != null,
          upstreamOutcomeUnknown: proxyResult.meta?.upstreamOutcomeUnknown === true,
          responseBodyTooLarge: proxyResult.meta?.responseBodyTooLarge === true,
          serviceTierPricingUnknown: !serviceTierBilling.exact,
        });
        let errorMessage: string | undefined;
        if (adaptationFailure != null) {
          errorMessage = adaptationFailure;
        } else if (status === 'success') {
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
        const upstreamRequestBodyForLog = openAiUpstreamWireBodyForLog(chosenRoute, upstreamBody);
		// The selected result carries its own quote reference. Earlier attempts
		// retain unknown facts, and a timed-out usage placeholder is never evidence.
		if (quoteAttemptCapture && proxyResult.quoteAttemptReference && !timedOut) {
			await quoteAttemptCapture.observeProviderUsage(
				proxyResult.quoteAttemptReference, usageCollected,
			);
		}
		const settledStickyTrace = stickyTrace ? await stickyTrace() : null;
		authenticatedBudgetProof?.assertSettlementSnapshot(chosenRoute, pricingRoute);
		finalQuoteInput?.assertCurrent(body, finalParsedModels, fallbackPlan);
		const chargedKey = authenticatedBudgetProof?.authenticatedKeySnapshot ?? apiKey;
        const economicHandoff = quoteAttemptCapture?.handoff() ?? null;
        const requestCostUnknown = costUnknown || (economicHandoff !== null
          && hasPotentiallyBillableUnknownSharedKeyAttempt(economicHandoff));
        return recordQuotedUsage({
		  api_key_id: chargedKey.keyId,
		  workspace_id: chargedKey.workspaceId,
          request_log_id: requestCorrelationId,
		  user_id: chargedKey.userId,
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
		  ...generationRequestLogContext(c.req.raw.headers),
		  response_streamed: body.stream === true,
          session_id: sessionRouting.sessionId,
          request_protocol: 'openai',
          request_operation: mode === 'legacy-completions' ? 'completions' : 'chat',
          upstream_protocol: chosenRoute.upstreamProtocol,
          upstream_operation: chosenRoute.upstreamOperation,
          model_surface_id: chosenRoute.modelSurfaceId,
          route_pool_id: chosenRoute.routePoolId,
          route_target_id: chosenRoute.targetId,
          adapter: chosenRoute.adapter,
          sticky_trace: settledStickyTrace,
          model_fallback_trace: modelFallbackTrace,
          provider_routing_trace: chosenRoute.providerRoutingTrace ?? null,
          usage: usageCollected,
          endpoint_pricing_snapshot: pricingRoute.endpoint ?? null,
          model_pricing_profile: model.pricing_profile ?? null,
          route_price_override_json: pricingRoute.priceOverrideRaw,
          user_charged_cost_factors_json: chargedKey.chargedCostFactors,
          route_metered_profile_json: pricingRoute.routeMeteredProfileJson,
          route_charged_profile_json: pricingRoute.routeChargedProfileJson,
          request_started_at_ms: start,
          route_group: chosenRoute.routeGroup,
          status,
          latency_ms: latency,
          timing: timing.snapshot(usageCollected.upstreamMessageId),
          error_message: errorMessage,
          provider_key_id: chosenRoute.providerKeyId ?? null,
          provider_key_label: chosenRoute.providerKeyLabel ?? null,
          provider_key_fingerprint: chosenRoute.providerKeyFingerprint ?? null,
          upstream_request_id: upstreamRequestId,
          upstream_message_id: usageCollected.upstreamMessageId ?? null,
          circuit_events: accumulatedCircuitEvents.length > 0 ? accumulatedCircuitEvents : undefined,
          suppress_error_alert: suppressErrorAlert || undefined,
          charge_on_error: outputGuardrailBlocked || adaptationFailure != null || undefined,
          guardrail_budget_settlement: budgetAdmission.guardrailReserved
            ? { requestId: requestCorrelationId, unknownCost: requestCostUnknown }
            : undefined,
          ordinary_budget_settlement:
            ordinaryBudgetLease.reserved && ordinaryBudgetLease.state === 'dispatched'
              ? {
                  requestId: requestCorrelationId,
                  budgetEpoch: ordinaryBudgetLease.budgetEpoch!,
                  reservedMicros: ordinaryBudgetLease.reservedMicros,
                  unknownCost: requestCostUnknown,
                }
              : undefined,
        }, proxyResult.quoteAttemptReference ?? null, economicHandoff);
      })
      .catch(async (err) => {
        console.error(
          `[Gateway Chat] recordUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} error=${err instanceof Error ? err.message : String(err)}`
        );
        if (postgresBudgetOwner) {
          const cleanup = await Promise.allSettled([
            budgetAdmission.terminateGuardrailUnknown('request_usage_settlement_failed'),
            ordinaryBudgetLease.terminateUnknown('request_usage_settlement_failed'),
          ]);
          const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
          throw failures.length > 0
            ? new AggregateError([err, ...failures], 'Chat usage settlement and budget cleanup failed')
            : err;
        }
        await forfeitGuardrailBudget('request_usage_settlement_failed');
        await terminateOrdinaryBudget('request_usage_settlement_failed');
      });
  scheduleBackgroundWork(c, usageSettlementTask);

  return response;
  } finally {
    if (postgresBudgetOwner) {
      scheduleResourceCompletion(c, chatBudgetOwnerResourceCompletion(
        postgresBudgetOwner,
        budgetAdmissionOpened ? budgetAdmission : null,
        usageSettlementTask,
      ));
    }
  }
}

chatRoutes.post('/', (c) => handleChatCompletion(c));
