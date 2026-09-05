import { applyVertexOpenAiModelPrefix, resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import {
  BoundedSseEventFramer,
  parseSseEventData,
  rewriteSseEventData,
  terminateSseEvent,
} from './sse-data-line';
import {
  markUpstreamOutcomeUnknown,
  type ProxyDispatchMeta,
} from '../failover-dispatch';
import { ensureOpenAiStreamIncludesUsage } from './openai-stream-usage-request';
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import {
  buildChatMidstreamErrorEvent,
  sanitizePublicErrorMessage,
} from '../openrouter-error-protocol';
import {
  cancelInvalidTextSuccessResponse,
  invalidTextSuccessResponse,
  preDispatchCancelledTextResponse,
  readBoundedTextJsonObject,
  rebuildTextJsonResponse,
  TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS,
} from './text-json-response';
import {
  normalizeOpenAiResponseServiceTier,
  normalizeResponseTextSpeed,
} from './service-tier-contract';
import {
  normalizeCanonicalFinishReason,
  normalizeNativeFinishReason,
} from './finish-reason-contract';

/**
 * OpenAI 协议流式响应（SSE）在此文件中有两条并行关注点，请勿混为一谈：
 *
 * 1) 网关计费 / 统计（`usage` 对象）
 *    - 从每个 EventSource event 的折叠 `data` 里解析 `usage`，用「最后一次出现的快照」覆盖 `usageFromStream`。
 *    - 与是否转发给客户端无关：即使后面把 event 里的 `usage` 从转发流里删掉，这里仍已解析过。
 *
 * 2) 转发给下游客户端的字节流
 *    - 历史上曾原样转发上游字节；部分上游（如 MiMo）在「非空 choices」的每个 chunk 里都带**累计** usage，
 *      而常见客户端（含 OpenAI SDK）会对每个 chunk 的 `usage` 做累加，导致「上下文用量」被放大数倍。
 *    - 因此这里按完整 event 重组 SSE，在「仍在 delta 阶段」的 event 里去掉 `usage`，保留
 *      「收尾」形态（如 `choices: []` 或带 `finish_reason`）上的 `usage`，与
 *      OpenAI 官方流式行为更接近。
 *
 * Event 缓冲：上游 `read()` 的切分点不一定落在 UTF-8 字符、字段或空行边界，因此只在完整
 * EventSource event 后解析；多条 `data` 字段按标准以换行折叠，并对跨 read 的残留实施严格上限。
 */

const EMPTY_USAGE_LOCAL: UsageFromStream = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  raw_usage: null,
};

/** Bound persistent SSE framing state; provider events above this are invalid. */
export const MAX_OPENAI_SSE_EVENT_CHARS = 256 * 1024;
/** @deprecated Kept for callers that imported the former line-oriented limit. */
export const MAX_OPENAI_SSE_LINE_CHARS = MAX_OPENAI_SSE_EVENT_CHARS;

/** Provider usage object (OpenAI / Claude via OpenAI-compatible API). */
type ProviderUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  speed?: unknown;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    text_tokens?: number;
	image_tokens?: number;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalSafeCount(value: unknown): boolean {
  return value === undefined || nonNegativeSafeInteger(value);
}

function effectiveSafeCount(primary: unknown, fallback: unknown): number | null {
  if (nonNegativeSafeInteger(primary)) return primary;
  return nonNegativeSafeInteger(fallback) ? fallback : null;
}

function validProviderUsage(value: unknown): value is ProviderUsage {
  if (!isPlainObject(value)) return false;
  const prompt = value.prompt_tokens;
  const input = value.input_tokens;
  const completion = value.completion_tokens;
  const output = value.output_tokens;
  if (
    (!nonNegativeSafeInteger(prompt) && !nonNegativeSafeInteger(input))
    || (!nonNegativeSafeInteger(completion) && !nonNegativeSafeInteger(output))
    || !nonNegativeSafeInteger(value.total_tokens)
    || (prompt !== undefined && input !== undefined && prompt !== input)
    || (completion !== undefined && output !== undefined && completion !== output)
  ) return false;

  const promptDetails = value.prompt_tokens_details;
  const completionDetails = value.completion_tokens_details;
  if (promptDetails !== undefined && !isPlainObject(promptDetails)) return false;
  if (completionDetails !== undefined && !isPlainObject(completionDetails)) return false;
  if (
    !optionalSafeCount(promptDetails?.cached_tokens)
    || !optionalSafeCount(promptDetails?.cache_creation_tokens)
    || !optionalSafeCount(completionDetails?.reasoning_tokens)
    || !optionalSafeCount(completionDetails?.text_tokens)
	|| !optionalSafeCount(completionDetails?.image_tokens)
  ) return false;

  const inputCount = effectiveSafeCount(prompt, input);
  const outputCount = effectiveSafeCount(completion, output);
  if (inputCount == null || outputCount == null) return false;
  const cacheRead = nonNegativeSafeInteger(promptDetails?.cached_tokens)
    ? promptDetails.cached_tokens
    : 0;
  const cacheWrite = nonNegativeSafeInteger(promptDetails?.cache_creation_tokens)
    ? promptDetails.cache_creation_tokens
    : 0;
  const cacheCount = cacheRead + cacheWrite;
  const totalCount = value.total_tokens;
  if (
    (!Number.isSafeInteger(inputCount + outputCount)
      || totalCount !== inputCount + outputCount)
    && (!Number.isSafeInteger(inputCount + cacheCount + outputCount)
      || totalCount !== inputCount + cacheCount + outputCount)
  ) return false;
  const reasoning = completionDetails?.reasoning_tokens;
  return reasoning === undefined
    || (nonNegativeSafeInteger(reasoning) && reasoning <= outputCount);
}

function validChatMessage(value: unknown): boolean {
  if (!isPlainObject(value) || value.role !== 'assistant') return false;
  const hasContent = Object.prototype.hasOwnProperty.call(value, 'content');
  const content = value.content;
  const validContent = content === null
    || typeof content === 'string'
    || Array.isArray(content);
  return (hasContent && validContent)
    || Array.isArray(value.tool_calls)
    || isPlainObject(value.function_call)
    || typeof value.refusal === 'string';
}

function validChatSuccessResponse(value: Record<string, unknown>): boolean {
  if (
    value.object !== 'chat.completion'
    || normalizeUpstreamId(value.id) == null
    || typeof value.model !== 'string'
    || !value.model.trim()
    || !nonNegativeSafeInteger(value.created)
    || !Array.isArray(value.choices)
    || value.choices.length === 0
    || value.choices.length > TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS
    || (value.usage !== undefined && !validProviderUsage(value.usage))
  ) return false;

  const indexes = new Set<number>();
  for (const choice of value.choices) {
    if (
      !isPlainObject(choice)
      || !nonNegativeSafeInteger(choice.index)
      || indexes.has(choice.index)
      || !Object.prototype.hasOwnProperty.call(choice, 'finish_reason')
      || (choice.finish_reason !== null && typeof choice.finish_reason !== 'string')
      || !validChatMessage(choice.message)
    ) return false;
    indexes.add(choice.index);
  }
  return true;
}

type SSEState = {
  sawDone: boolean;
  sawFailure: boolean;
  associationId: string | null;
  lastFinishReason: string | null;
  lastNativeFinishReason: string | null;
  serviceTier: ReturnType<typeof normalizeOpenAiResponseServiceTier>;
};

const encoder = new TextEncoder();

/**
 * 不同 OpenAI 兼容供应商对 `prompt_tokens` 口径不一致：
 * - 常见口径（OpenAI）：`prompt_tokens` 已包含 cached/cache_creation。
 * - 兼容口径（部分供应商）：`prompt_tokens` 仅为非缓存输入，cached 单独给出。
 *
 * 网关内部计费公式假设：`input_tokens = regular + cache_read + cache_write`。
 * 因此这里需要把上游口径归一到该语义。
 */
function normalizeInputTokensFromPrompt(args: {
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
}): number {
  const { promptTokens, completionTokens, cacheRead, cacheWrite, totalTokens } = args;
  const cacheTotal = cacheRead + cacheWrite;
  if (cacheTotal <= 0) return promptTokens;

  // prompt 小于 cache 总量时，不可能是「已包含缓存」口径，按「纯输入 + 缓存」兼容处理。
  if (promptTokens < cacheTotal) {
    return promptTokens + cacheTotal;
  }

  // 若上游给了 total_tokens，用其判定哪种口径更贴近。
  if (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens >= 0) {
    const expectedWithIncludedCache = promptTokens + completionTokens;
    const expectedWithPureInputPrompt = promptTokens + cacheTotal + completionTokens;
    const diffIncluded = Math.abs(totalTokens - expectedWithIncludedCache);
    const diffPureInput = Math.abs(totalTokens - expectedWithPureInputPrompt);
    if (diffPureInput < diffIncluded) {
      return promptTokens + cacheTotal;
    }
  }

  // 默认采用 OpenAI 口径：prompt 已包含缓存。
  return promptTokens;
}

function usageFromProvider(u: ProviderUsage): UsageFromStream {
  const promptTokensRaw = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_creation_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  const promptTokens = normalizeInputTokensFromPrompt({
    promptTokens: promptTokensRaw,
    completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens: u.total_tokens,
  });
  const rawJson = JSON.stringify(u);
	const nativePrompt = effectiveSafeCount(u.prompt_tokens, u.input_tokens);
	const nativeCompletion = effectiveSafeCount(u.completion_tokens, u.output_tokens);
	const nativeCached = nonNegativeSafeInteger(u.prompt_tokens_details?.cached_tokens)
		? u.prompt_tokens_details.cached_tokens
		: null;
	const nativeReasoning = nonNegativeSafeInteger(u.completion_tokens_details?.reasoning_tokens)
		? u.completion_tokens_details.reasoning_tokens
		: null;
	const nativeCompletionImages = nonNegativeSafeInteger(u.completion_tokens_details?.image_tokens)
		? u.completion_tokens_details.image_tokens
		: null;
  // 输出单行 SSE 的 usage 日志，比较长，生产中不输出，主要DEBUG 用
  // console.log('[Gateway Proxy] raw usage from provider:', rawJson);
  const usage: UsageFromStream = {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    total_tokens: u.total_tokens ?? promptTokens + completionTokens,
    raw_usage: rawJson,
	native_tokens_prompt: nativePrompt,
	native_tokens_completion: nativeCompletion,
	native_tokens_cached: nativeCached,
	native_tokens_reasoning: nativeReasoning,
	native_tokens_completion_images: nativeCompletionImages,
  };
  if (Object.prototype.hasOwnProperty.call(u, 'speed')) {
    usage.speed = normalizeResponseTextSpeed(u.speed);
  }
  return usage;
}

/**
 * 从单行 SSE `data: {...}` 里解析 `usage`，合并进网关的 `usage`（后出现的覆盖先前的）。
 * 注意：这是**计费侧**用的统计，与 `transformStreamUsageForClient` 是否删字段独立。
 */
export function hasOpenAiReasoningDelta(parsed: {
  choices?: Array<{
    delta?: { reasoning_content?: unknown; thinking?: unknown; reasoning?: unknown };
  }>;
}): boolean {
  for (const choice of parsed.choices ?? []) {
    const delta = choice?.delta;
    if (!delta) continue;
    const rc = delta.reasoning_content;
    if (typeof rc === 'string' && rc.length > 0) return true;
    const th = delta.thinking;
    if (typeof th === 'string' && th.length > 0) return true;
    const r = delta.reasoning;
    if (typeof r === 'string' && r.length > 0) return true;
  }
  return false;
}

export function hasOpenAiContentDelta(parsed: {
  choices?: Array<{
    delta?: { content?: unknown; tool_calls?: unknown; function_call?: unknown };
  }>;
}): boolean {
  for (const choice of parsed.choices ?? []) {
    const delta = choice?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string' && delta.content.length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (delta.function_call != null) return true;
  }
  return false;
}

type ChatStreamChoice = {
  index?: unknown;
  delta?: {
    content?: unknown;
    tool_calls?: unknown;
    function_call?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
    reasoning?: unknown;
    role?: unknown;
  };
  finish_reason?: unknown;
  native_finish_reason?: unknown;
};

type ChatStreamEvent = {
  id?: unknown;
  model?: unknown;
  choices?: ChatStreamChoice[];
  usage?: ProviderUsage;
  service_tier?: unknown;
  error?: { message?: unknown };
};

type ProcessedChatEvent = { wire: string; stop: boolean };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function applyProviderUsage(target: UsageFromStream, providerUsage: ProviderUsage): void {
  const next = usageFromProvider(providerUsage);
  target.input_tokens = next.input_tokens;
  target.output_tokens = next.output_tokens;
  target.cache_read_tokens = next.cache_read_tokens;
  target.cache_write_tokens = next.cache_write_tokens;
  target.reasoning_tokens = next.reasoning_tokens;
  target.total_tokens = next.total_tokens;
  target.raw_usage = next.raw_usage;
	target.native_tokens_prompt = next.native_tokens_prompt;
	target.native_tokens_completion = next.native_tokens_completion;
	target.native_tokens_cached = next.native_tokens_cached;
	target.native_tokens_reasoning = next.native_tokens_reasoning;
	target.native_tokens_completion_images = next.native_tokens_completion_images;
  if (Object.prototype.hasOwnProperty.call(next, 'speed')) target.speed = next.speed;
}

/** Parse, account and normalize one complete Chat Completions SSE event. */
function processChatSseEvent(params: {
  event: string;
  state: SSEState;
  usage: UsageFromStream;
  timing?: RequestTimingCollector | null;
  publicModelId?: string;
  publicProviderName?: string;
}): ProcessedChatEvent {
  const parsedData = parseSseEventData(params.event);
  if (parsedData === null) return { wire: params.event, stop: false };
  const data = parsedData.trim();
  if (!data) return { wire: params.event, stop: false };
  if (data === '[DONE]') {
    params.state.sawDone = true;
    return { wire: params.event, stop: true };
  }

  let parsed: ChatStreamEvent;
  try {
    const candidate = JSON.parse(data) as unknown;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid event');
    parsed = candidate as ChatStreamEvent;
  } catch {
    params.usage.stream_error = params.usage.stream_error ?? 'Malformed OpenAI SSE data event';
    params.state.sawFailure = true;
    return {
      wire: buildChatMidstreamErrorEvent({
        id: params.state.associationId,
        model: params.publicModelId ?? '',
        provider: params.publicProviderName ?? '',
      }),
      stop: true,
    };
  }

  params.timing?.markFirstEvent();
  if (hasOpenAiReasoningDelta(parsed)) params.timing?.markFirstReasoningToken();
  if (hasOpenAiContentDelta(parsed)) params.timing?.markFirstToken();

  const eventId = normalizeUpstreamId(parsed.id);
  if (eventId) {
    params.state.associationId ??= eventId;
    params.usage.upstreamMessageId ??= eventId;
  }
  if (parsed.usage) {
    if (Object.prototype.hasOwnProperty.call(parsed.usage, 'speed')) {
      parsed.usage.speed = normalizeResponseTextSpeed(parsed.usage.speed);
    }
    applyProviderUsage(params.usage, parsed.usage);
  }

  if (parsed.error && typeof parsed.error === 'object') {
    params.usage.stream_error = sanitizePublicErrorMessage(
      nonEmptyString(parsed.error.message) ?? 'Upstream Chat Completions stream failed',
      'Upstream Chat Completions stream failed',
    );
    params.state.sawFailure = true;
    return {
      wire: buildChatMidstreamErrorEvent({
        id: params.state.associationId,
        model: params.publicModelId ?? '',
        provider: params.publicProviderName ?? '',
      }),
      stop: true,
    };
  }

  let changed = false;
	if (Object.prototype.hasOwnProperty.call(parsed, 'service_tier')) {
		params.state.serviceTier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
	}
	parsed.service_tier = params.state.serviceTier;
	params.usage.service_tier = params.state.serviceTier;
	changed = true;
  if (params.state.associationId && parsed.id !== params.state.associationId) {
    parsed.id = params.state.associationId;
    changed = true;
  }
  if (params.publicModelId && Object.prototype.hasOwnProperty.call(parsed, 'model')) {
    parsed.model = params.publicModelId;
    changed = true;
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  let hasTerminalFinish = false;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const finishReason = nonEmptyString(choice.finish_reason);
    const nativeFinishReason = nonEmptyString(choice.native_finish_reason);
    if (finishReason) {
      hasTerminalFinish = true;
      params.state.lastFinishReason = finishReason;
      params.state.lastNativeFinishReason = nativeFinishReason ?? finishReason;
      if (!nativeFinishReason) {
        choice.native_finish_reason = finishReason;
        changed = true;
      }
    } else if (nativeFinishReason) {
      params.state.lastNativeFinishReason = nativeFinishReason;
    }
		if (choice.index === 0) {
			params.usage.finish_reason = normalizeCanonicalFinishReason(choice.finish_reason);
			params.usage.native_finish_reason = normalizeNativeFinishReason(
				choice.native_finish_reason ?? choice.finish_reason,
			);
		}
  }

  // OpenRouter intentionally emits a single content-free choice on the final
  // usage frame because a number of SDKs dereference choices[0].delta.
  if (parsed.usage != null && choices.length === 0) {
    const finishReason =
      params.state.lastFinishReason ?? params.state.lastNativeFinishReason ?? 'stop';
    const nativeFinishReason = params.state.lastNativeFinishReason ?? finishReason;
    parsed.choices = [{
      index: 0,
      delta: { content: '', role: 'assistant' },
      finish_reason: finishReason,
      native_finish_reason: nativeFinishReason,
    }];
    if (!eventId && params.state.associationId) parsed.id = params.state.associationId;
    changed = true;
  } else if (parsed.usage != null && choices.length > 0 && !hasTerminalFinish) {
    // Some compatible providers attach cumulative usage to every delta. Keep
    // accounting locally but expose usage only on terminal accounting frames.
    delete parsed.usage;
    changed = true;
  }

  return {
    wire: changed
      ? rewriteSseEventData(params.event, JSON.stringify(parsed))
      : params.event,
    stop: false,
  };
}

/**
 * 从上游读 SSE 字节流，双路处理：
 * - 每凑齐一个完整 EventSource event，先更新计费统计，再按下游背压写出。
 * - 上游 `read()` 可能截断在半个 UTF-8 字符、字段或 event，残留由有界 framer 保存。
 * - `done === true` 时：若仍有未以空行结束的 event，按 EventSource EOF 语义处理一次。
 *
 * 客户端断开时立即取消上游 body，不会为了末尾 usage 继续生成/计费。
 */
async function pumpWithUsageTracking(
  upstream: ReadableStream<Uint8Array>,
  downstream: WritableStream<Uint8Array>,
  usage: UsageFromStream,
  resolveUsage: (u: UsageFromStream) => void,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  publicModelId?: string,
  publicProviderName?: string,
  publicCorrelationId?: string,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  const writer = downstream.getWriter();
  const state: SSEState = {
    sawDone: false,
    sawFailure: false,
    associationId: normalizeUpstreamId(publicCorrelationId),
    lastFinishReason: null,
    lastNativeFinishReason: null,
    serviceTier: null,
  };
  const framer = new BoundedSseEventFramer(
    MAX_OPENAI_SSE_EVENT_CHARS,
    'OpenAI SSE event exceeded the gateway framing limit',
  );
  let clientDisconnected = requestSignal?.aborted === true;

  const markClientDisconnected = (): void => {
    usage.cancelled = true;
    clientDisconnected = true;
    // The Fetch signal is also wired to the upstream request. Explicit reader
    // cancellation covers downstream writer failures that do not abort it.
    void reader.cancel(requestSignal?.reason).catch(() => undefined);
  };

  const onAbort = (): void => {
    markClientDisconnected();
  };
  if (clientDisconnected) markClientDisconnected();
  else {
    requestSignal?.addEventListener('abort', onAbort, { once: true });
  }

  const writeWire = async (wire: string): Promise<boolean> => {
    if (!wire || clientDisconnected) return !clientDisconnected;
    try {
      await writer.write(encoder.encode(wire));
      return true;
    } catch {
      markClientDisconnected();
      return false;
    }
  };

  const processEvent = (event: string): ProcessedChatEvent => processChatSseEvent({
    event,
    state,
    usage,
    timing,
    publicModelId,
    publicProviderName,
  });

  const handleEvent = async (event: string): Promise<boolean> => {
    const processed = processEvent(event);
    const written = await writeWire(processed.wire);
    return processed.stop || !written || clientDisconnected;
  };

  try {
    while (true) {
      if (clientDisconnected) break;
      const { done, value } = await reader.read();
      if (done) {
        const stopped = await framer.push(decoder.decode(), handleEvent);
        const remainder = stopped ? '' : framer.finish();
        if (remainder.trim() && !clientDisconnected) {
          await handleEvent(terminateSseEvent(remainder));
        }
        if (!state.sawDone && !state.sawFailure && !clientDisconnected) {
          usage.stream_error = usage.stream_error ?? 'Upstream Chat stream ended before data: [DONE]';
          state.sawFailure = true;
          await writeWire(buildChatMidstreamErrorEvent({
            id: state.associationId,
            model: publicModelId ?? '',
            provider: publicProviderName ?? '',
          }));
        }
        break;
      }

      if (value.byteLength > 0) timing?.markFirstByte();
      const stop = await framer.push(decoder.decode(value, { stream: true }), handleEvent);
      if (stop || clientDisconnected) {
        await reader.cancel(stop ? 'Chat SSE terminal event received' : requestSignal?.reason).catch(() => undefined);
        break;
      }
    }
  } catch (err) {
    if (!clientDisconnected) {
      await reader.cancel('Chat SSE processing failed').catch(() => undefined);
      usage.stream_error = usage.stream_error ?? sanitizePublicErrorMessage(
        err instanceof Error ? err.message : String(err),
        'Upstream Chat Completions stream failed',
      );
      console.warn('[Gateway Proxy] pump error', err instanceof Error ? err.message : String(err));
      if (!state.sawFailure) {
        state.sawFailure = true;
        await writeWire(buildChatMidstreamErrorEvent({
          id: state.associationId,
          model: publicModelId ?? '',
          provider: publicProviderName ?? '',
        }));
      }
    }
  } finally {
    requestSignal?.removeEventListener('abort', onAbort);
    timing?.markStreamComplete();
    resolveUsage(usage);
    try {
      await writer.close();
    } catch (err) {
      console.warn(
        '[Gateway Proxy] pump writer.close (non-fatal)',
        err instanceof Error ? err.message : String(err),
        { clientDisconnected, usageCancelled: usage.cancelled }
      );
    }
  }
}

function streamResponseWithUsage(
  response: Response,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  publicModelId?: string,
  publicProviderName?: string,
  publicCorrelationId?: string,
): { response: Response; usagePromise: Promise<UsageFromStream> } {
  let resolveUsage!: (u: UsageFromStream) => void;
  const usagePromise = new Promise<UsageFromStream>((resolve) => {
    resolveUsage = resolve;
  });

  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  pumpWithUsageTracking(
    response.body!,
    writable,
    usage,
    resolveUsage,
    requestSignal,
    timing,
    publicModelId,
    publicProviderName,
    publicCorrelationId,
  ).catch(() => {
    // resolveUsage already called in finally
  });

  return {
    response: new Response(readable, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }),
    usagePromise,
  };
}

async function nonStreamResponseWithUsage(
  response: Response,
  timing?: RequestTimingCollector | null,
  publicModelId?: string,
  publicCorrelationId?: string,
): Promise<{
  response: Response;
  usagePromise: Promise<UsageFromStream>;
  meta?: ProxyDispatchMeta;
}> {
  const materialized = await readBoundedTextJsonObject(response, {
    skin: 'chat',
    requestId: publicCorrelationId,
  });
  timing?.markStreamComplete();
  if (!materialized.ok) {
    return {
      response: materialized.response,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
      meta: materialized.meta,
    };
  }

  const parsed = materialized.value;
  if (!validChatSuccessResponse(parsed)) {
    const invalid = invalidTextSuccessResponse({
      skin: 'chat',
      protocol: 'Chat Completions',
      requestId: publicCorrelationId,
    });
    return {
      ...invalid,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
    };
  }
  const providerUsage = parsed.usage;
  if (providerUsage && Object.prototype.hasOwnProperty.call(providerUsage, 'speed')) {
    (providerUsage as ProviderUsage).speed = normalizeResponseTextSpeed(
      (providerUsage as ProviderUsage).speed,
    );
  }
  let usage = providerUsage != null
    ? usageFromProvider(providerUsage as ProviderUsage)
    : { ...EMPTY_USAGE_LOCAL };
  const msgId = normalizeUpstreamId(parsed.id);
  if (msgId) usage = { ...usage, upstreamMessageId: msgId };
	const primaryChoice = (parsed.choices as Array<Record<string, unknown>>)
		.find((choice) => choice.index === 0)
		?? (parsed.choices as Array<Record<string, unknown>>)[0];
	if (primaryChoice) {
		usage.finish_reason = normalizeCanonicalFinishReason(primaryChoice.finish_reason);
		usage.native_finish_reason = normalizeNativeFinishReason(
			primaryChoice.native_finish_reason ?? primaryChoice.finish_reason,
		);
	}
  const generationId = normalizeUpstreamId(publicCorrelationId);
  if (generationId) parsed.id = generationId;
  if (publicModelId) parsed.model = publicModelId;
	const serviceTier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
	parsed.service_tier = serviceTier;
	usage.service_tier = serviceTier;
  return {
    response: rebuildTextJsonResponse(response, parsed),
    usagePromise: Promise.resolve(usage),
  };
}

/**
 * 向供应商发起 OpenAI 兼容 `POST …/chat/completions`：合并路由默认参数、`model` 换为上游名。
 * 流式响应解析 SSE 中的 usage（含对客户端转发的 usage 裁剪逻辑，见文件头说明）；非 JSON 200 走流处理分支。
 * @param route 已解析的 openai 协议路由（含 providerEndpoints、密钥、providerModelName）
 * @param body 客户端原始 JSON 体
 * @param requestSignal 客户取消会同步中止上游 fetch/body
 * @returns 原样或包装后的 `Response` + 异步解析完成的 `usagePromise`
 */
export async function dispatchOpenAiRoute(
  route: RouteResult,
  body: Record<string, unknown>,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  attempt?: RequestTimingAttempt,
  beforeFetch?: () => Promise<void>,
  publicCorrelationId?: string,
): Promise<{
  response: Response;
  usagePromise: Promise<UsageFromStream>;
  upstreamRequestId: string | null;
  meta?: ProxyDispatchMeta;
}> {
  const url = resolveUpstreamEndpoint('openai', 'chat', route.providerEndpoints, {
    providerId: route.providerId,
  });
  assertTextUpstreamHttpUrl(url);
  const cancelledBeforeDispatch = () => ({
    response: preDispatchCancelledTextResponse('chat', publicCorrelationId),
    usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL, cancelled: true }),
    upstreamRequestId: null,
    meta: {
      failoverForbidden: true,
      gatewayGeneratedError: true,
    } satisfies ProxyDispatchMeta,
  });
  if (requestSignal?.aborted) return cancelledBeforeDispatch();
  const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
  const requestBody = ensureOpenAiStreamIncludesUsage({
    ...buildRouteRequestBody(route, body),
    model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
  });
  const serializedBody = JSON.stringify(requestBody);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secret}`,
  };
  new Headers(headers);

  if (requestSignal?.aborted) return cancelledBeforeDispatch();
  await beforeFetch?.();
  if (requestSignal?.aborted) return cancelledBeforeDispatch();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: serializedBody,
      signal: requestSignal,
    });
  } catch (error) {
    throw markUpstreamOutcomeUnknown(error);
  }
  timing?.markAttemptHeaders(attempt, response.status);
  const upstreamRequestId = extractUpstreamRequestId(response.headers);

  if (response.ok) {
    const contentType = response.headers.get('Content-Type') ?? '';
    const normalizedContentType = contentType.toLowerCase();
    const streamRequested = requestBody.stream === true;
    if (!streamRequested && normalizedContentType.includes('application/json')) {
      const result = await nonStreamResponseWithUsage(
        response,
        timing,
        route.gatewayModelId,
        publicCorrelationId,
      );
      return { ...result, upstreamRequestId };
    }
    if (streamRequested && response.body && normalizedContentType.includes('text/event-stream')) {
      const result = streamResponseWithUsage(
        response,
        requestSignal,
        timing,
        route.gatewayModelId,
        route.providerName,
        publicCorrelationId,
      );
      return { ...result, upstreamRequestId };
    }
    const invalid = await cancelInvalidTextSuccessResponse(response, {
      skin: 'chat',
      protocol: 'Chat Completions',
      requestId: publicCorrelationId,
    });
    timing?.markStreamComplete();
    return {
      ...invalid,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
      upstreamRequestId,
    };
  }

  return {
    response,
    usagePromise: Promise.resolve(EMPTY_USAGE_LOCAL),
    upstreamRequestId,
  };
}
