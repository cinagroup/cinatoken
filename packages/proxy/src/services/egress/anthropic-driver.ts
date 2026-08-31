/**
 * Anthropic Messages 协议出站：组装 URL、合并路由默认参数、流式 SSE 解析 usage，并在断连后立即取消上游。
 */
import { resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
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
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import {
  buildAnthropicMidstreamErrorEvent,
  sanitizePublicErrorMessage,
} from '../openrouter-error-protocol';
import {
  preDispatchCancelledTextResponse,
  readBoundedTextJsonObject,
  rebuildTextJsonResponse,
} from './text-json-response';

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
export const MAX_ANTHROPIC_SSE_LINE_CHARS = 256 * 1024;
const encoder = new TextEncoder();

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type SSEState = {
  lineBuffer: string;
  sawMessageStop: boolean;
  sawFailure: boolean;
  associationId: string | null;
};

function usageFromAnthropic(u: AnthropicUsage): UsageFromStream {
  const netInputAfterBreakpoint = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  // Anthropic: `input_tokens` is only tokens after the last cache breakpoint; cache_* are separate additive buckets.
  // Total input = net + cache_read + cache_creation (see Anthropic prompt caching docs).
  // `computeMeteredCost` expects OpenAI-like semantics: `input_tokens` = total prompt, then
  // regular = input_tokens - cache_read - cache_write.
  const inputTokensTotal = netInputAfterBreakpoint + cacheRead + cacheWrite;
  const rawJson = JSON.stringify(u);
  return {
    input_tokens: inputTokensTotal,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: 0,
    total_tokens: inputTokensTotal + outputTokens,
    raw_usage: rawJson,
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
}

export function hasAnthropicReasoningDelta(parsed: {
  type?: string;
  delta?: { type?: unknown; thinking?: unknown };
}): boolean {
  if (parsed.type !== 'content_block_delta') return false;
  const delta = parsed.delta;
  if (!delta) return false;
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
    return true;
  }
  return false;
}

export function hasAnthropicContentDelta(parsed: {
  type?: string;
  delta?: { type?: unknown; text?: unknown; partial_json?: unknown };
}): boolean {
  if (parsed.type !== 'content_block_delta' && parsed.type !== 'message_delta') return false;
  const delta = parsed.delta;
  if (!delta) return false;
  if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) return true;
  if (typeof delta.text === 'string' && delta.text.length > 0) return true;
  if (typeof delta.partial_json === 'string' && delta.partial_json.length > 0) return true;
  return false;
}

type AnthropicStreamEvent = {
  type?: string;
  model?: unknown;
  delta?: { type?: unknown; text?: unknown; partial_json?: unknown; thinking?: unknown };
  usage?: AnthropicUsage;
  message?: { id?: string; model?: unknown; usage?: AnthropicUsage };
  error?: { type?: unknown; message?: unknown; error_type?: unknown };
  request_id?: unknown;
};

type ProcessedAnthropicLine = { wire: string; stop: boolean };

function canonicalAnthropicErrorType(nativeType: unknown): string {
  switch (nativeType) {
    case 'overloaded_error': return 'provider_overloaded';
    case 'rate_limit_error': return 'rate_limit_exceeded';
    case 'timeout_error': return 'timeout';
    case 'permission_error': return 'permission_denied';
    case 'billing_error': return 'payment_required';
    case 'invalid_request_error': return 'invalid_request';
    case 'not_found_error': return 'not_found';
    default: return 'provider_unavailable';
  }
}

function processAnthropicSseLine(params: {
  line: string;
  state: SSEState;
  usage: UsageFromStream;
  timing?: RequestTimingCollector | null;
  publicModelId?: string;
}): ProcessedAnthropicLine {
  const parsedData = parseSseDataLine(params.line);
  if (parsedData === null) return { wire: `${params.line}\n`, stop: false };
  const data = parsedData.trim();
  if (!data) return { wire: `${params.line}\n`, stop: false };
  if (data === '[DONE]') {
    params.usage.stream_error = params.usage.stream_error ?? 'Anthropic stream ended without message_stop';
    params.state.sawFailure = true;
    return {
      wire: buildAnthropicMidstreamErrorEvent({ requestId: params.state.associationId }),
      stop: true,
    };
  }

  let parsed: AnthropicStreamEvent;
  try {
    const candidate = JSON.parse(data) as unknown;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid event');
    parsed = candidate as AnthropicStreamEvent;
  } catch {
    params.usage.stream_error = params.usage.stream_error ?? 'Malformed Anthropic SSE data event';
    params.state.sawFailure = true;
    return {
      wire: buildAnthropicMidstreamErrorEvent({ requestId: params.state.associationId }),
      stop: true,
    };
  }

  params.timing?.markFirstEvent();
  if (hasAnthropicReasoningDelta(parsed)) params.timing?.markFirstReasoningToken();
  if (hasAnthropicContentDelta(parsed)) params.timing?.markFirstToken();
  const messageId = normalizeUpstreamId(parsed.message?.id);
  if (messageId) {
    // Prefer the protocol-native message id after message_start; the request
    // generation id is only a fallback before a message exists.
    params.state.associationId = messageId;
    params.usage.upstreamMessageId ??= messageId;
  }
  const usageSnapshot = parsed.usage ?? parsed.message?.usage;
  if (usageSnapshot) applyUsage(params.usage, usageFromAnthropic(usageSnapshot));

  let changed = false;
  if (params.publicModelId && Object.prototype.hasOwnProperty.call(parsed, 'model')) {
    parsed.model = params.publicModelId;
    changed = true;
  }
  if (params.publicModelId && parsed.message && Object.prototype.hasOwnProperty.call(parsed.message, 'model')) {
    parsed.message.model = params.publicModelId;
    changed = true;
  }

  if (parsed.type === 'error') {
    const nativeType = typeof parsed.error?.type === 'string' && parsed.error.type.trim()
      ? parsed.error.type.trim()
      : 'api_error';
    const errorType = typeof parsed.error?.error_type === 'string' && parsed.error.error_type.trim()
      ? parsed.error.error_type.trim()
      : canonicalAnthropicErrorType(nativeType);
    const rawMessage = typeof parsed.error?.message === 'string' && parsed.error.message.trim()
      ? parsed.error.message
      : 'Upstream provider stream interrupted';
    params.usage.stream_error = sanitizePublicErrorMessage(
      rawMessage,
      'Upstream provider stream interrupted',
    );
    params.state.sawFailure = true;
    parsed.error = {
      type: nativeType,
      message: sanitizePublicErrorMessage(rawMessage),
      error_type: errorType,
    };
    if (params.state.associationId) parsed.request_id = params.state.associationId;
    changed = true;
  } else if (parsed.type === 'message_stop') {
    params.state.sawMessageStop = true;
  }

  return {
    wire: `${changed ? `data: ${JSON.stringify(parsed)}` : params.line}\n`,
    stop: parsed.type === 'error' || parsed.type === 'message_stop',
  };
}

async function pumpWithUsageTracking(
  upstream: ReadableStream<Uint8Array>,
  downstream: WritableStream<Uint8Array>,
  usage: UsageFromStream,
  resolveUsage: (u: UsageFromStream) => void,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  publicModelId?: string,
  publicCorrelationId?: string,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  const writer = downstream.getWriter();
  const state: SSEState = {
    lineBuffer: '',
    sawMessageStop: false,
    sawFailure: false,
    associationId: normalizeUpstreamId(publicCorrelationId),
  };
  let clientDisconnected = requestSignal?.aborted === true;

  const markClientDisconnected = (): void => {
    usage.cancelled = true;
    clientDisconnected = true;
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
  const processLine = (line: string): ProcessedAnthropicLine => processAnthropicSseLine({
    line,
    state,
    usage,
    timing,
    publicModelId,
  });

  try {
    while (true) {
      if (clientDisconnected) break;
      const { done, value } = await reader.read();
      if (done) {
        state.lineBuffer += decoder.decode();
        if (state.lineBuffer.length > MAX_ANTHROPIC_SSE_LINE_CHARS) {
          throw new Error('Anthropic SSE event exceeded the gateway framing limit');
        }
        if (!clientDisconnected && state.lineBuffer.trim()) {
          const processed = processLine(state.lineBuffer);
          state.lineBuffer = '';
          await writeWire(processed.wire);
        }
        if (!state.sawMessageStop && !state.sawFailure && !clientDisconnected) {
          usage.stream_error = usage.stream_error ?? 'Upstream Anthropic stream ended before message_stop';
          state.sawFailure = true;
          await writeWire(buildAnthropicMidstreamErrorEvent({ requestId: state.associationId }));
        }
        break;
      }

      if (value.byteLength > 0) timing?.markFirstByte();
      state.lineBuffer += decoder.decode(value, { stream: true });
      if (state.lineBuffer.length > MAX_ANTHROPIC_SSE_LINE_CHARS && !state.lineBuffer.includes('\n')) {
        throw new Error('Anthropic SSE event exceeded the gateway framing limit');
      }
      const lines = state.lineBuffer.split('\n');
      state.lineBuffer = lines.pop() ?? '';
      if (state.lineBuffer.length > MAX_ANTHROPIC_SSE_LINE_CHARS) {
        throw new Error('Anthropic SSE event exceeded the gateway framing limit');
      }
      let forward = '';
      let stop = false;
      for (const line of lines) {
        if (line.length > MAX_ANTHROPIC_SSE_LINE_CHARS) {
          throw new Error('Anthropic SSE event exceeded the gateway framing limit');
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
        await reader.cancel(stop ? 'Anthropic SSE terminal event received' : requestSignal?.reason).catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    if (!clientDisconnected) {
      usage.stream_error = usage.stream_error ?? sanitizePublicErrorMessage(
        error instanceof Error ? error.message : String(error),
        'Upstream provider stream interrupted',
      );
      if (!state.sawFailure) {
        state.sawFailure = true;
        await writeWire(buildAnthropicMidstreamErrorEvent({ requestId: state.associationId }));
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
        '[Gateway Proxy] anthropic pump writer.close (non-fatal)',
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
    publicCorrelationId,
  ).catch(() => {
    // resolveUsage in finally
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
    skin: 'anthropic',
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
  const usageCandidate = parsed.usage;
  const usage = usageCandidate != null
    && typeof usageCandidate === 'object'
    && !Array.isArray(usageCandidate)
    ? usageFromAnthropic(usageCandidate as AnthropicUsage)
    : { ...EMPTY_USAGE_LOCAL };
  const msgId = normalizeUpstreamId(parsed.id);
  if (msgId) usage.upstreamMessageId = msgId;
  if (publicModelId) parsed.model = publicModelId;
  return {
    response: rebuildTextJsonResponse(response, parsed),
    usagePromise: Promise.resolve(usage),
  };
}

/**
 * 调用 Anthropic Messages API（`x-api-key` + `anthropic-version`），请求体合并路由默认参数并替换 `model`。
 * 流式为 SSE，`usagePromise` 在协议终态、异常 EOF 或取消后解析；非流 JSON 从根对象 `usage` 取数。
 * @param requestSignal 客户取消会同步中止上游 fetch/body
 */
export async function dispatchAnthropicRoute(
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
  const url = resolveUpstreamEndpoint('anthropic', 'messages', route.providerEndpoints, {
    providerId: route.providerId,
  });
  assertTextUpstreamHttpUrl(url);
  const cancelledBeforeDispatch = () => ({
    response: preDispatchCancelledTextResponse('anthropic', publicCorrelationId),
    usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL, cancelled: true }),
    upstreamRequestId: null,
    meta: {
      failoverForbidden: true,
      gatewayGeneratedError: true,
    } satisfies ProxyDispatchMeta,
  });
  if (requestSignal?.aborted) return cancelledBeforeDispatch();
  const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
  const requestBody = {
    ...buildRouteRequestBody(route, body),
    model: route.providerModelName,
  };
  const serializedBody = JSON.stringify(requestBody);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': secret,
    'anthropic-version': '2023-06-01',
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
