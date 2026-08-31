import { applyVertexOpenAiModelPrefix, resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { parseSseDataLine } from './sse-data-line';
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
  preDispatchCancelledTextResponse,
  readBoundedTextJsonObject,
  rebuildTextJsonResponse,
} from './text-json-response';

/**
 * OpenAI 协议流式响应（SSE）在此文件中有两条并行关注点，请勿混为一谈：
 *
 * 1) 网关计费 / 统计（`usage` 对象）
 *    - 从每条 `data: {...}` 里解析 `usage`，用「最后一次出现的快照」覆盖 `usageFromStream`。
 *    - 与是否转发给客户端无关：即使后面把某行里的 `usage` 从转发流里删掉，这里仍已按行解析过。
 *
 * 2) 转发给下游客户端的字节流
 *    - 历史上曾原样转发上游字节；部分上游（如 MiMo）在「非空 choices」的每个 chunk 里都带**累计** usage，
 *      而常见客户端（含 OpenAI SDK）会对每个 chunk 的 `usage` 做累加，导致「上下文用量」被放大数倍。
 *    - 因此这里按行重组 SSE，并对 **转发内容** 调用 `transformStreamUsageForClient`，在「仍在 delta 阶段」
 *      的行里去掉 `usage`，保留「收尾」形态（如 `choices: []` 或带 `finish_reason`）上的 `usage`，与
 *      OpenAI 官方流式行为更接近。
 *
 * 行缓冲：上游 `read()` 的切分点不一定落在换行符上，因此用 `lineBuffer` 拼完整行后再解析与转发。
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
export const MAX_OPENAI_SSE_LINE_CHARS = 256 * 1024;

/** Provider usage object (OpenAI / Claude via OpenAI-compatible API). */
type ProviderUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    text_tokens?: number;
  };
};

type SSEState = {
  lineBuffer: string;
  sawDone: boolean;
  sawFailure: boolean;
  associationId: string | null;
  lastFinishReason: string | null;
  lastNativeFinishReason: string | null;
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
  // 输出单行 SSE 的 usage 日志，比较长，生产中不输出，主要DEBUG 用
  // console.log('[Gateway Proxy] raw usage from provider:', rawJson);
  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    total_tokens: u.total_tokens ?? promptTokens + completionTokens,
    raw_usage: rawJson,
  };
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
  error?: { message?: unknown };
};

type ProcessedChatLine = { wire: string; stop: boolean };

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
}

/** Parse, account and normalize one complete Chat Completions SSE line. */
function processChatSseLine(params: {
  line: string;
  state: SSEState;
  usage: UsageFromStream;
  timing?: RequestTimingCollector | null;
  publicModelId?: string;
  publicProviderName?: string;
}): ProcessedChatLine {
  const parsedData = parseSseDataLine(params.line);
  if (parsedData === null) return { wire: `${params.line}\n`, stop: false };
  const data = parsedData.trim();
  if (!data) return { wire: `${params.line}\n`, stop: false };
  if (data === '[DONE]') {
    params.state.sawDone = true;
    return { wire: `${params.line}\n`, stop: true };
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
  if (parsed.usage) applyProviderUsage(params.usage, parsed.usage);

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
    wire: `${changed ? `data: ${JSON.stringify(parsed)}` : params.line}\n`,
    stop: false,
  };
}

/**
 * 从上游读 SSE 字节流，双路处理：
 * - 每凑齐一行完整行：先 `processUsageFromDataLine` 更新计费统计；
 *   再 `transformStreamUsageForClient` 得到发给客户端的文本，拼成 `forward` 写出。
 * - 上游 `read()` 可能截断在半个 UTF-8 字符或半行，剩余留在 `state.lineBuffer`。
 * - `done === true` 时：若缓冲区里还有未以换行结尾的残留，按「最后一行」再处理一次（与旧 `processRemainingLineBuffer` 等价）。
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
    lineBuffer: '',
    sawDone: false,
    sawFailure: false,
    associationId: normalizeUpstreamId(publicCorrelationId),
    lastFinishReason: null,
    lastNativeFinishReason: null,
  };
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

  const processLine = (line: string): ProcessedChatLine => processChatSseLine({
    line,
    state,
    usage,
    timing,
    publicModelId,
    publicProviderName,
  });

  try {
    while (true) {
      if (clientDisconnected) break;
      const { done, value } = await reader.read();
      if (done) {
        state.lineBuffer += decoder.decode();
        if (state.lineBuffer.length > MAX_OPENAI_SSE_LINE_CHARS) {
          throw new Error('OpenAI SSE event exceeded the gateway framing limit');
        }
        if (state.lineBuffer.trim() && !clientDisconnected) {
          const processed = processLine(state.lineBuffer);
          state.lineBuffer = '';
          await writeWire(processed.wire);
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
      state.lineBuffer += decoder.decode(value, { stream: true });
      if (state.lineBuffer.length > MAX_OPENAI_SSE_LINE_CHARS && !state.lineBuffer.includes('\n')) {
        throw new Error('OpenAI SSE event exceeded the gateway framing limit');
      }
      const lines = state.lineBuffer.split('\n');
      state.lineBuffer = lines.pop() ?? '';
      if (state.lineBuffer.length > MAX_OPENAI_SSE_LINE_CHARS) {
        throw new Error('OpenAI SSE event exceeded the gateway framing limit');
      }

      let forward = '';
      let stop = false;
      for (const line of lines) {
        if (line.length > MAX_OPENAI_SSE_LINE_CHARS) {
          throw new Error('OpenAI SSE event exceeded the gateway framing limit');
        }
        const processed = processLine(line);
        forward += processed.wire;
        if (processed.stop) {
          stop = true;
          break;
        }
      }

      await writeWire(forward);
      if (stop || clientDisconnected) {
        await reader.cancel(stop ? 'Chat SSE terminal event received' : requestSignal?.reason).catch(() => undefined);
        break;
      }
    }
  } catch (err) {
    if (!clientDisconnected) {
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
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      response,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
    };
  }
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
  const providerUsage = parsed.usage;
  let usage = providerUsage != null && typeof providerUsage === 'object' && !Array.isArray(providerUsage)
    ? usageFromProvider(providerUsage as ProviderUsage)
    : { ...EMPTY_USAGE_LOCAL };
  const msgId = normalizeUpstreamId(parsed.id);
  if (msgId) usage = { ...usage, upstreamMessageId: msgId };
  if (publicModelId) parsed.model = publicModelId;
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
    if (contentType.toLowerCase().includes('application/json')) {
      const result = await nonStreamResponseWithUsage(
        response,
        timing,
        route.gatewayModelId,
        publicCorrelationId,
      );
      return { ...result, upstreamRequestId };
    }
    if (response.body) {
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
  }

  return {
    response,
    usagePromise: Promise.resolve(EMPTY_USAGE_LOCAL),
    upstreamRequestId,
  };
}
