/**
 * Anthropic Messages 协议出站：组装 URL、合并路由默认参数、流式 SSE 解析 usage，并在断连后立即取消上游。
 */
import { resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
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
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import {
  buildAnthropicMidstreamErrorEvent,
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
  normalizeAnthropicResponseServiceTier,
  normalizeOpenAiResponseServiceTier,
  normalizeResponseTextSpeed,
} from './service-tier-contract';
import { finishReasonsFromAnthropicStopReason } from './finish-reason-contract';

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
export const MAX_ANTHROPIC_SSE_EVENT_CHARS = 256 * 1024;
/** @deprecated Kept for callers that imported the former line-oriented limit. */
export const MAX_ANTHROPIC_SSE_LINE_CHARS = MAX_ANTHROPIC_SSE_EVENT_CHARS;
const encoder = new TextEncoder();

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: unknown;
  speed?: unknown;
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

function validAnthropicUsage(value: unknown): value is AnthropicUsage {
  if (
    !isPlainObject(value)
    || !nonNegativeSafeInteger(value.input_tokens)
    || !nonNegativeSafeInteger(value.output_tokens)
    || !optionalSafeCount(value.cache_read_input_tokens)
    || !optionalSafeCount(value.cache_creation_input_tokens)
  ) return false;
  const cacheRead = nonNegativeSafeInteger(value.cache_read_input_tokens)
    ? value.cache_read_input_tokens
    : 0;
  const cacheWrite = nonNegativeSafeInteger(value.cache_creation_input_tokens)
    ? value.cache_creation_input_tokens
    : 0;
  return Number.isSafeInteger(
    value.input_tokens
      + value.output_tokens
      + cacheRead
      + cacheWrite,
  );
}

function validAnthropicSuccessResponse(value: Record<string, unknown>): boolean {
  if (
    value.type !== 'message'
    || value.role !== 'assistant'
    || normalizeUpstreamId(value.id) == null
    || typeof value.model !== 'string'
    || !value.model.trim()
    || !Array.isArray(value.content)
    || value.content.length > TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS
    || !Object.prototype.hasOwnProperty.call(value, 'stop_reason')
    || (value.stop_reason !== null && (
      typeof value.stop_reason !== 'string' || !value.stop_reason.trim()
    ))
    || !Object.prototype.hasOwnProperty.call(value, 'stop_sequence')
    || (value.stop_sequence !== null && typeof value.stop_sequence !== 'string')
    || !validAnthropicUsage(value.usage)
  ) return false;
  return value.content.every((block) => isPlainObject(block)
    && typeof block.type === 'string'
    && block.type.trim().length > 0);
}

type SSEState = {
  sawMessageStop: boolean;
  sawFailure: boolean;
  associationId: string | null;
  serviceTier: ReturnType<typeof normalizeAnthropicResponseServiceTier>;
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
	const hasNativeUsage = validAnthropicUsage(u);
  const usage: UsageFromStream = {
    input_tokens: inputTokensTotal,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: 0,
    total_tokens: inputTokensTotal + outputTokens,
    raw_usage: rawJson,
    service_tier: normalizeOpenAiResponseServiceTier(u.service_tier),
	native_tokens_prompt: hasNativeUsage ? inputTokensTotal : null,
	native_tokens_completion: hasNativeUsage ? outputTokens : null,
	native_tokens_cached: hasNativeUsage ? cacheRead : null,
	native_tokens_reasoning: null,
	native_tokens_completion_images: null,
  };
  if (Object.prototype.hasOwnProperty.call(u, 'speed')) {
    usage.speed = normalizeResponseTextSpeed(u.speed);
  }
  return usage;
}

function applyUsage(target: UsageFromStream, next: UsageFromStream): void {
  target.input_tokens = next.input_tokens;
  target.output_tokens = next.output_tokens;
  target.cache_read_tokens = next.cache_read_tokens;
  target.cache_write_tokens = next.cache_write_tokens;
  target.reasoning_tokens = next.reasoning_tokens;
  target.total_tokens = next.total_tokens;
  target.raw_usage = next.raw_usage;
  target.service_tier = next.service_tier;
	target.native_tokens_prompt = next.native_tokens_prompt;
	target.native_tokens_completion = next.native_tokens_completion;
	target.native_tokens_cached = next.native_tokens_cached;
	target.native_tokens_reasoning = next.native_tokens_reasoning;
	target.native_tokens_completion_images = next.native_tokens_completion_images;
  if (Object.prototype.hasOwnProperty.call(next, 'speed')) target.speed = next.speed;
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
  delta?: {
    type?: unknown;
    text?: unknown;
    partial_json?: unknown;
    thinking?: unknown;
    stop_reason?: unknown;
  };
  usage?: AnthropicUsage;
  message?: { id?: string; model?: unknown; usage?: AnthropicUsage };
  error?: { type?: unknown; message?: unknown; error_type?: unknown };
  request_id?: unknown;
};

type ProcessedAnthropicEvent = { wire: string; stop: boolean };

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

function processAnthropicSseEvent(params: {
  event: string;
  state: SSEState;
  usage: UsageFromStream;
  timing?: RequestTimingCollector | null;
  publicModelId?: string;
}): ProcessedAnthropicEvent {
  const parsedData = parseSseEventData(params.event);
  if (parsedData === null) return { wire: params.event, stop: false };
  const data = parsedData.trim();
  if (!data) return { wire: params.event, stop: false };
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
  let changed = false;
	if (parsed.usage) {
		if (Object.prototype.hasOwnProperty.call(parsed.usage, 'service_tier')) {
			params.state.serviceTier = normalizeAnthropicResponseServiceTier(parsed.usage.service_tier);
		}
		parsed.usage.service_tier = params.state.serviceTier;
		if (Object.prototype.hasOwnProperty.call(parsed.usage, 'speed')) {
			parsed.usage.speed = normalizeResponseTextSpeed(parsed.usage.speed);
		}
		changed = true;
	}
	if (parsed.message?.usage) {
		if (Object.prototype.hasOwnProperty.call(parsed.message.usage, 'service_tier')) {
			params.state.serviceTier = normalizeAnthropicResponseServiceTier(parsed.message.usage.service_tier);
		}
		parsed.message.usage.service_tier = params.state.serviceTier;
		if (Object.prototype.hasOwnProperty.call(parsed.message.usage, 'speed')) {
			parsed.message.usage.speed = normalizeResponseTextSpeed(parsed.message.usage.speed);
		}
		changed = true;
	}
	const usageSnapshot = parsed.usage ?? parsed.message?.usage;
	if (usageSnapshot) applyUsage(params.usage, usageFromAnthropic(usageSnapshot));
	if (parsed.type === 'message_delta' && Object.prototype.hasOwnProperty.call(parsed.delta ?? {}, 'stop_reason')) {
		const reasons = finishReasonsFromAnthropicStopReason(parsed.delta?.stop_reason);
		params.usage.finish_reason = reasons.finishReason;
		params.usage.native_finish_reason = reasons.nativeFinishReason;
	}
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
    wire: changed
      ? rewriteSseEventData(params.event, JSON.stringify(parsed))
      : params.event,
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
    sawMessageStop: false,
    sawFailure: false,
    associationId: normalizeUpstreamId(publicCorrelationId),
    serviceTier: null,
  };
  const framer = new BoundedSseEventFramer(
    MAX_ANTHROPIC_SSE_EVENT_CHARS,
    'Anthropic SSE event exceeded the gateway framing limit',
  );
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
  const processEvent = (event: string): ProcessedAnthropicEvent => processAnthropicSseEvent({
    event,
    state,
    usage,
    timing,
    publicModelId,
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
        if (!clientDisconnected && remainder.trim()) {
          await handleEvent(terminateSseEvent(remainder));
        }
        if (!state.sawMessageStop && !state.sawFailure && !clientDisconnected) {
          usage.stream_error = usage.stream_error ?? 'Upstream Anthropic stream ended before message_stop';
          state.sawFailure = true;
          await writeWire(buildAnthropicMidstreamErrorEvent({ requestId: state.associationId }));
        }
        break;
      }

      if (value.byteLength > 0) timing?.markFirstByte();
      const stop = await framer.push(decoder.decode(value, { stream: true }), handleEvent);
      if (stop || clientDisconnected) {
        await reader.cancel(stop ? 'Anthropic SSE terminal event received' : requestSignal?.reason).catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    if (!clientDisconnected) {
      await reader.cancel('Anthropic SSE processing failed').catch(() => undefined);
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
  if (!validAnthropicSuccessResponse(parsed)) {
    const invalid = invalidTextSuccessResponse({
      skin: 'anthropic',
      protocol: 'Anthropic Messages',
      requestId: publicCorrelationId,
    });
    return {
      ...invalid,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
    };
  }
  const usageCandidate = parsed.usage;
	(usageCandidate as AnthropicUsage).service_tier = normalizeAnthropicResponseServiceTier(
		(usageCandidate as AnthropicUsage).service_tier,
	);
  if (Object.prototype.hasOwnProperty.call(usageCandidate as AnthropicUsage, 'speed')) {
    (usageCandidate as AnthropicUsage).speed = normalizeResponseTextSpeed(
      (usageCandidate as AnthropicUsage).speed,
    );
  }
  const usage = usageFromAnthropic(usageCandidate as AnthropicUsage);
	const reasons = finishReasonsFromAnthropicStopReason(parsed.stop_reason);
	usage.finish_reason = reasons.finishReason;
	usage.native_finish_reason = reasons.nativeFinishReason;
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
  const requestBody: Record<string, unknown> = {
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
        publicCorrelationId,
      );
      return { ...result, upstreamRequestId };
    }
    const invalid = await cancelInvalidTextSuccessResponse(response, {
      skin: 'anthropic',
      protocol: 'Anthropic Messages',
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
