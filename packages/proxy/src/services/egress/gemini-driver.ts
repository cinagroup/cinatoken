/**
 * Gemini generateContent / streamGenerateContent 出站：按 `providers.endpoints.gemini` 解析 URL、解析 JSON 或 SSE 中的 usageMetadata。
 */
import type { ResourceCompletion, ResourceCompletionOutcome } from '../resource-completion';
import { ownUpstreamResponse } from './owned-upstream-response';
import { withOwnedJsonUpload } from './with-owned-json-upload';
import { captureTextRouteIdentity, createPreparedTextAttempt, type PreparedTextAttempt } from './prepared-text-attempt';
import {
  GEMINI_GENERATE_OPERATION,
  prepareGeminiUpstreamFetch,
  resolveGeminiAuthForUpstreamSecret,
  resolveProviderUpstreamSecret,
  resolveUpstreamEndpoint,
} from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { RequestAuxiliaryAuthBudget } from '@octafuse/core';
import type { UsageFromStream } from '../proxy';
import { markTextStreamCancellation } from '../request-deadline';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { markUpstreamOutcomeUnknown, type ProxyDispatchMeta, type ProxyDispatchResult } from '../failover-dispatch';
import { parseSseDataLine } from './sse-data-line';
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import { ambiguousDispatchedStatusMeta } from './ambiguous-upstream-status';
import { readBoundedTextJsonObject, rebuildTextJsonResponse, preDispatchCancelledTextResponse } from './text-json-response';

const EMPTY_USAGE_LOCAL: UsageFromStream = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  raw_usage: null,
};

/** @deprecated Historical exported limit only; cancellation no longer drains upstream. */
export const GEMINI_POST_DISCONNECT_DRAIN_MS = 25_000;
export const GEMINI_SSE_MAX_LINE_CHARS = 256 * 1024;

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  /** Thinking / internal reasoning tokens (Gemini thinking models); see ai.google.dev/gemini-api/docs/thinking */
  thoughtsTokenCount?: number;
  thoughts_token_count?: number;
};

type SSEState = { lineBuffer: string; decoder: TextDecoder };

function safeNativeCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function thoughtsTokenCountFromGemini(u: GeminiUsageMetadata): number {
  const n = u.thoughtsTokenCount ?? u.thoughts_token_count;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function usageFromGemini(u: GeminiUsageMetadata): UsageFromStream {
  const inputTokens = u.promptTokenCount ?? 0;
  const candidatesTokens = u.candidatesTokenCount ?? 0;
  const cacheRead = u.cachedContentTokenCount ?? 0;
  const reasoningTokens = thoughtsTokenCountFromGemini(u);
  /** 与 Google 输出侧计费一致：`output_tokens` = candidates + thoughts（`reasoning_tokens` 仍为 thoughts 分列）。 */
  const outputTokens = candidatesTokens + reasoningTokens;
  /** `totalTokenCount` 文档为 prompt + candidates，可能不含 thoughts；取与 explicit 和的上界避免少记。 */
  const explicitSum = inputTokens + outputTokens;
  const total =
    u.totalTokenCount != null ? Math.max(u.totalTokenCount, explicitSum) : explicitSum;
  const rawJson = JSON.stringify(u);
	const nativePrompt = safeNativeCount(u.promptTokenCount);
	const nativeCandidates = safeNativeCount(u.candidatesTokenCount);
	const nativeReasoning = safeNativeCount(u.thoughtsTokenCount ?? u.thoughts_token_count);
	const nativeCompletion = nativeCandidates != null
		&& (nativeReasoning == null || Number.isSafeInteger(nativeCandidates + nativeReasoning))
		? nativeCandidates + (nativeReasoning ?? 0)
		: null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
    reasoning_tokens: reasoningTokens,
    total_tokens: total,
    raw_usage: rawJson,
	native_tokens_prompt: nativePrompt,
	native_tokens_completion: nativeCompletion,
	native_tokens_cached: safeNativeCount(u.cachedContentTokenCount),
	native_tokens_reasoning: nativeReasoning,
	native_tokens_completion_images: null,
  };
}

function applyUsage(target: UsageFromStream, next: UsageFromStream): void {
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
}

export function hasGeminiReasoningPart(parsed: {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: unknown; thought?: unknown }>;
    };
  }>;
}): boolean {
  for (const candidate of parsed.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) return true;
    }
  }
  return false;
}

export function hasGeminiContentPart(parsed: {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: unknown; thought?: unknown; functionCall?: unknown; function_call?: unknown }>;
    };
  }>;
}): boolean {
  for (const candidate of parsed.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.thought === true) continue;
      if (typeof part.text === 'string' && part.text.length > 0) return true;
      if (part.functionCall != null || part.function_call != null) return true;
    }
  }
  return false;
}

function applyParsedGeminiUsage(parsed: Record<string, unknown>, usage: UsageFromStream, timing?: RequestTimingCollector | null): void {
  try {
    const value = parsed as {
      usageMetadata?: GeminiUsageMetadata;
      candidates?: Array<{
        usageMetadata?: GeminiUsageMetadata;
        content?: {
          parts?: Array<{ text?: unknown; thought?: unknown; functionCall?: unknown; function_call?: unknown }>;
        };
      }>;
      responseId?: string;
      requestId?: string;
      request_id?: string;
    };
    timing?.markFirstEvent();
    if (hasGeminiReasoningPart(value)) timing?.markFirstReasoningToken();
    if (hasGeminiContentPart(value)) timing?.markFirstToken();
    // message id 为 Gemini 顶层 `responseId`（流式每个 chunk 亦带），取首个。
    if (!usage.upstreamMessageId) {
      const msgId = normalizeUpstreamId(value.responseId);
      if (msgId) usage.upstreamMessageId = msgId;
    }
    // 部分 Gemini 代理在 body 追加 requestId；与 responseId 区分，供日志 request id 解析。
    if (!usage.upstreamBodyRequestId) {
      const reqId = normalizeUpstreamId(value.requestId ?? value.request_id);
      if (reqId) usage.upstreamBodyRequestId = reqId;
    }
    if (value.usageMetadata) {
      applyUsage(usage, usageFromGemini(value.usageMetadata));
      return;
    }
    for (const c of value.candidates ?? []) {
      if (c.usageMetadata) {
        applyUsage(usage, usageFromGemini(c.usageMetadata));
      }
    }
  } catch {
    usage.stream_error = usage.stream_error ?? 'Malformed Gemini response data';
  }
}

function parseJsonUsage(text: string, usage: UsageFromStream, timing?: RequestTimingCollector | null): void {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Gemini response data must be an object');
    }
    applyParsedGeminiUsage(parsed as Record<string, unknown>, usage, timing);
  } catch {
    usage.stream_error = usage.stream_error ?? 'Malformed Gemini response data';
  }
}

function assertGeminiSseLineWithinLimit(line: string): void {
  if (line.length > GEMINI_SSE_MAX_LINE_CHARS) {
    throw new Error('Gemini SSE line exceeds the gateway limit');
  }
}

function parseSSEChunk(
  chunk: Uint8Array,
  state: SSEState,
  usage: UsageFromStream,
  timing?: RequestTimingCollector | null
): void {
  state.lineBuffer += state.decoder.decode(chunk, { stream: true });
  const lines = state.lineBuffer.split('\n');
  state.lineBuffer = lines.pop() ?? '';
  for (const line of lines) {
    assertGeminiSseLineWithinLimit(line);
    const parsedData = parseSseDataLine(line);
    if (parsedData === null) continue;
    const data = parsedData.trim();
    if (!data || data === '[DONE]') continue;
    parseJsonUsage(data, usage, timing);
  }
  assertGeminiSseLineWithinLimit(state.lineBuffer);
}

function processRemainingLineBuffer(
  state: SSEState,
  usage: UsageFromStream,
  timing?: RequestTimingCollector | null
): void {
  state.lineBuffer += state.decoder.decode();
  assertGeminiSseLineWithinLimit(state.lineBuffer);
  const line = state.lineBuffer.trim();
  const parsedData = parseSseDataLine(line);
  if (parsedData === null) return;
  const data = parsedData.trim();
  if (!data || data === '[DONE]') return;
  parseJsonUsage(data, usage, timing);
}

async function pumpWithUsageTracking(
  upstream: ReadableStream<Uint8Array>,
  downstream: WritableStream<Uint8Array>,
  usage: UsageFromStream,
  resolveUsage: (u: UsageFromStream) => void,
  stopDownstream: () => void,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null
): Promise<ResourceCompletionOutcome> {
  const reader = upstream.getReader();
  const writer = downstream.getWriter();
  const state: SSEState = {
    lineBuffer: '',
    decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
  };
  let clientDisconnected = false;
  let finished = false;
  let cleanupConfirmed = true;
  let cancellation: Promise<void> | undefined;
  const cancelUpstream = (reason?: unknown): void => {
cancellation ??= reader.cancel(reason).catch(() => { cleanupConfirmed = false; });
  };

  const markClientDisconnected = (): void => {
    if (finished || clientDisconnected) return;
    markTextStreamCancellation(usage, requestSignal);
    clientDisconnected = true;
    cancelUpstream(requestSignal?.reason);
    // Also unblock a write when the caller aborted but has not read/cancelled
    // its downstream body. Cancelling the upstream reader alone cannot do it.
    stopDownstream();
  };
  const onAbort = (): void => {
    markClientDisconnected();
  };
  if (requestSignal?.aborted) {
    onAbort();
  } else {
    requestSignal?.addEventListener('abort', onAbort, { once: true });
  }
  // A silent upstream has no next write at which downstream cancellation could
  // otherwise be observed. This promise is owned by this pump, not a global.
  void writer.closed.catch(markClientDisconnected);

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) {
        if (!clientDisconnected) processRemainingLineBuffer(state, usage, timing);
        break;
      }
      if (clientDisconnected) break;

      if (value.byteLength > 0) timing?.markFirstByte();
      parseSSEChunk(value, state, usage, timing);

      if (!clientDisconnected) {
        try {
          await writer.write(value);
        } catch {
          markClientDisconnected();
        }
      }

    }
  } catch (error) {
    if (!clientDisconnected) usage.stream_error = error instanceof Error ? error.message : String(error);
    cancelUpstream('gemini_sse_invalid_or_too_large');
  } finally {
    // Usage/financial facts cannot depend on an untrusted cancel ACK.
    // Keep abandoned reader ownership in the pump until cleanup settles below.
    finished = true;
    requestSignal?.removeEventListener('abort', onAbort);
    if (!cancellation) reader.releaseLock();
    timing?.markStreamComplete();
    resolveUsage(usage);
    try {
      await writer.close();
    } catch {
      console.warn(JSON.stringify({
        event: 'gateway.gemini.writer_close_failed',
        clientDisconnected, usageCancelled: usage.cancelled === true,
      }));
    }
    if (cancellation) {
      await cancellation;
      reader.releaseLock();
    }
  }
  return cleanupConfirmed ? 'confirmed' : 'unconfirmed';
}

function streamResponseWithUsage(
  response: Response,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null
): { response: Response; usagePromise: Promise<UsageFromStream>; resourceCompletion: ResourceCompletion } {
  let resolveUsage!: (u: UsageFromStream) => void;
  const usagePromise = new Promise<UsageFromStream>((resolve) => {
    resolveUsage = resolve;
  });
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  let stopDownstream!: () => void;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { stopDownstream = () => controller.terminate(); },
  });
  const resourceCompletion = pumpWithUsageTracking(response.body!, writable, usage, resolveUsage, stopDownstream, requestSignal, timing).catch(() => 'unconfirmed' as const);

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
    resourceCompletion,
  };
}

async function nonStreamResponseWithUsage(
  response: Response,
  timing?: RequestTimingCollector | null,
  requestSignal?: AbortSignal,
): Promise<{ response: Response; usagePromise: Promise<UsageFromStream>; meta?: ProxyDispatchMeta }> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    return {
      response,
      usagePromise: Promise.resolve(EMPTY_USAGE_LOCAL),
    };
  }
  const parsed = await readBoundedTextJsonObject(response, { skin: 'chat', signal: requestSignal });
  if (!parsed.ok) {
    timing?.markStreamComplete();
    return { ...parsed, usagePromise: Promise.resolve(EMPTY_USAGE_LOCAL) };
  }
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  applyParsedGeminiUsage(parsed.value, usage, timing);
  timing?.markStreamComplete();
  return {
    response: rebuildTextJsonResponse(response, parsed.value),
    usagePromise: Promise.resolve(usage),
  };
}

/**
 * 调用 Gemini `{base}/{model}:{action}`（`endpoints.gemini.base` 须含完整路径前缀）：URL 查询串可与客户端 `search` 合并；
 * 官方上游缺省追加 `?key=`；`endpoints.gemini.auth` 为 `bearer` 时改用 `Authorization: Bearer`。
 * `streamGenerateContent` 走 SSE 解析（上游强制 `alt=sse`）；`generateContent` 单次 JSON 用 `usageMetadata`。
 * @param search 原始 query 字符串（可含或不含 `?`），会与上游所需参数合并
 */
export async function dispatchGeminiRoute(
  route: RouteResult,
  body: Record<string, unknown>,
  action: 'generateContent' | 'streamGenerateContent',
  search: string,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  attempt?: RequestTimingAttempt,
  beforeFetch?: (prepared: PreparedTextAttempt) => Promise<void>,
  auxiliaryAuth?: RequestAuxiliaryAuthBudget,
): Promise<ProxyDispatchResult> {
  const cancelledBeforeDispatch = (): ProxyDispatchResult => ({
    response: preDispatchCancelledTextResponse('chat'),
    usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL, cancelled: true }),
    upstreamRequestId: null,
    meta: { failoverForbidden: true, gatewayGeneratedError: true },
  });
  if (requestSignal?.aborted) return cancelledBeforeDispatch();
  const resolvedUrl = resolveUpstreamEndpoint(
    'gemini',
    GEMINI_GENERATE_OPERATION,
    route.providerEndpoints,
    {
      model: route.providerModelName,
      action,
      providerId: route.providerId,
    }
  );
  const routeIdentity = beforeFetch ? captureTextRouteIdentity(route) : null;
  const requestBody = buildRouteRequestBody(route, body);
  return withOwnedJsonUpload(requestBody, requestSignal, async upload => {
    const resolved = await resolveProviderUpstreamSecret(route.providerApiKey, { signal: requestSignal, auxiliaryAuth });
    const { url, headers } = prepareGeminiUpstreamFetch({
      resolvedUrl,
      modelName: route.providerModelName,
      action,
      apiKey: resolved.secret,
      search,
      auth: resolveGeminiAuthForUpstreamSecret(
        route.providerEndpoints.gemini?.auth,
        resolved.isServiceAccount
      ),
    });
    const fetchUrl = url.toString();
    assertTextUpstreamHttpUrl(fetchUrl);
    headers['Content-Length'] = String(upload.contentLength);
    new Headers(headers);

    if (requestSignal?.aborted) return cancelledBeforeDispatch();
    if (beforeFetch) {
      const prepared = createPreparedTextAttempt({
        routeIdentity: routeIdentity!, url: fetchUrl, method: 'POST', headers,
        outboundBodySha256: await upload.digestSha256(),
        outboundBodyBytes: upload.contentLength,
      });
      await beforeFetch(prepared);
    }
    if (requestSignal?.aborted) return cancelledBeforeDispatch();
    let response: Response;
    try {
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        // A redirect is another unbudgeted dispatch and may forward credentials.
        redirect: 'manual',
        headers,
        body: upload.body,
        duplex: 'half',
        signal: requestSignal,
      };
      response = await fetch(fetchUrl, init);
    } catch (error) {
      throw markUpstreamOutcomeUnknown(error);
    }
    timing?.markAttemptHeaders(attempt, response.status);
    const upstreamRequestId = extractUpstreamRequestId(response.headers);

    const nonStreamJson = (response.headers.get('Content-Type') ?? '').includes('application/json')
      && action === 'generateContent';
    if (response.ok && response.body && !nonStreamJson) {
      // Retain Gemini's existing response classification and SSE pump ownership.
      const result = streamResponseWithUsage(response, requestSignal, timing);
      return { ...result, upstreamRequestId };
    }
    const owned = ownUpstreamResponse(response, requestSignal);
    response = owned.response;
    if (response.ok && response.body && nonStreamJson) {
      const result = await nonStreamResponseWithUsage(response, timing, requestSignal);
      return { ...result, upstreamRequestId, resourceCompletion: owned.resourceCompletion };
    }

    return {
      response,
      usagePromise: Promise.resolve(EMPTY_USAGE_LOCAL),
      upstreamRequestId,
      resourceCompletion: owned.resourceCompletion,
      meta: ambiguousDispatchedStatusMeta(response.status),
    };
  });
}
