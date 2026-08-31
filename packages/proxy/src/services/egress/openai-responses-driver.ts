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
import { assertTextUpstreamHttpUrl } from './text-upstream-url';
import {
	buildResponsesFailedEvent,
	sanitizePublicErrorMessage,
} from '../openrouter-error-protocol';
import {
	preDispatchCancelledTextResponse,
	readBoundedTextJsonObject,
	rebuildTextJsonResponse,
} from './text-json-response';

/**
 * OpenAI Responses API 透传：
 * - 非流式 JSON 从终态 `usage` 记账
 * - SSE 识别 typed events，usage 通常在 `response.completed` / `response.incomplete`
 * - 原样转发事件；上游静默 EOF 时补一条关联原 response id 的 `response.failed`
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
export const MAX_RESPONSES_SSE_LINE_CHARS = 256 * 1024;

const TERMINAL_EVENT_TYPES = new Set([
	'response.completed',
	'response.failed',
	'response.incomplete',
	'response.error',
	'error',
]);

const REASONING_DELTA_TYPES = new Set([
	'response.reasoning_text.delta',
	'response.reasoning_summary_text.delta',
]);

const OUTPUT_DELTA_TYPES = new Set([
	'response.output_text.delta',
	'response.function_call_arguments.delta',
]);

type ResponsesUsage = {
	input_tokens?: number;
	output_tokens?: number;
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_creation_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
	};
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_creation_tokens?: number;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
	};
};

type ResponsesEvent = {
	type?: string;
	id?: string;
	model?: unknown;
	delta?: unknown;
	usage?: ResponsesUsage;
	response?: {
		id?: string;
		model?: unknown;
		status?: string;
		usage?: ResponsesUsage;
		error?: { message?: string; code?: string };
	};
	error?: { message?: string; code?: string };
};

type SSEState = {
	lineBuffer: string;
	sawTerminal: boolean;
	sawFailure: boolean;
	associationId: string | null;
};

const encoder = new TextEncoder();

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function usageFromResponses(u: ResponsesUsage): UsageFromStream {
	const inputTokens = numberOrZero(u.input_tokens ?? u.prompt_tokens);
	const outputTokens = numberOrZero(u.output_tokens ?? u.completion_tokens);
	const cacheRead = numberOrZero(
		u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens,
	);
	const cacheWrite = numberOrZero(
		u.input_tokens_details?.cache_creation_tokens ?? u.prompt_tokens_details?.cache_creation_tokens,
	);
	const reasoning = numberOrZero(
		u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens,
	);
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_read_tokens: cacheRead,
		cache_write_tokens: cacheWrite,
		reasoning_tokens: reasoning,
		total_tokens: numberOrZero(u.total_tokens) || inputTokens + outputTokens,
		raw_usage: JSON.stringify(u),
	};
}

export function applyResponsesUsage(target: UsageFromStream, usage: ResponsesUsage): void {
	const next = usageFromResponses(usage);
	target.input_tokens = next.input_tokens;
	target.output_tokens = next.output_tokens;
	target.cache_read_tokens = next.cache_read_tokens;
	target.cache_write_tokens = next.cache_write_tokens;
	target.reasoning_tokens = next.reasoning_tokens;
	target.total_tokens = next.total_tokens;
	target.raw_usage = next.raw_usage;
}

export function isResponsesTerminalEventType(type: string | undefined): boolean {
	return Boolean(type && TERMINAL_EVENT_TYPES.has(type));
}

function applyResponsesEvent(
	parsed: ResponsesEvent,
	usage: UsageFromStream,
	timing?: RequestTimingCollector | null,
): { terminal: boolean } {
	const type = typeof parsed.type === 'string' ? parsed.type : '';
	timing?.markFirstEvent();
	if (REASONING_DELTA_TYPES.has(type)) timing?.markFirstReasoningToken();
	if (OUTPUT_DELTA_TYPES.has(type)) timing?.markFirstToken();

	const responseId = normalizeUpstreamId(parsed.response?.id ?? parsed.id);
	if (responseId && !usage.upstreamMessageId) {
		usage.upstreamMessageId = responseId;
	}

	const usageObj = parsed.response?.usage ?? parsed.usage;
	if (usageObj) applyResponsesUsage(usage, usageObj);

	if (type === 'response.failed' || type === 'response.error' || type === 'error') {
		const message =
			(typeof parsed.error?.message === 'string' && parsed.error.message.trim()) ||
			(typeof parsed.response?.error?.message === 'string' && parsed.response.error.message.trim()) ||
			(typeof parsed.response?.status === 'string' ? `Responses ${parsed.response.status}` : '') ||
			'Upstream Responses stream failed';
		usage.stream_error = sanitizePublicErrorMessage(
			message,
			'Upstream Responses stream failed',
		);
	}

	return { terminal: isResponsesTerminalEventType(type) };
}

export function processResponsesDataLine(
	line: string,
	usage: UsageFromStream,
	timing?: RequestTimingCollector | null,
): boolean {
	const parsedData = parseSseDataLine(line);
	if (parsedData === null) return false;
	const data = parsedData.trim();
	// `[DONE]` is framing only. A typed Responses terminal event must precede it.
	if (!data || data === '[DONE]') return false;
	try {
		const parsed = JSON.parse(data) as ResponsesEvent;
		return applyResponsesEvent(parsed, usage, timing).terminal;
	} catch {
		usage.stream_error = usage.stream_error ?? 'Malformed OpenAI Responses SSE data event';
		return false;
	}
}

function rewriteResponsesModelInDataLine(line: string, publicModelId?: string): string {
	if (!publicModelId) return line;
	const parsedData = parseSseDataLine(line);
	if (parsedData === null) return line;
	const data = parsedData.trim();
	if (!data || data === '[DONE]') return line;
	try {
		const parsed = JSON.parse(data) as ResponsesEvent;
		let changed = false;
		if (Object.prototype.hasOwnProperty.call(parsed, 'model')) {
			parsed.model = publicModelId;
			changed = true;
		}
		if (parsed.response && Object.prototype.hasOwnProperty.call(parsed.response, 'model')) {
			parsed.response.model = publicModelId;
			changed = true;
		}
		return changed ? `data: ${JSON.stringify(parsed)}` : line;
	} catch {
		return line;
	}
}

type ProcessedResponsesLine = { wire: string; stop: boolean };

function processResponsesSseLine(params: {
	line: string;
	state: SSEState;
	usage: UsageFromStream;
	timing?: RequestTimingCollector | null;
	publicModelId?: string;
}): ProcessedResponsesLine {
	const parsedData = parseSseDataLine(params.line);
	if (parsedData === null) return { wire: `${params.line}\n`, stop: false };
	const data = parsedData.trim();
	if (!data) return { wire: `${params.line}\n`, stop: false };
	if (data === '[DONE]') {
		if (params.state.sawTerminal) return { wire: `${params.line}\n`, stop: true };
		params.usage.stream_error =
			params.usage.stream_error ?? 'Responses stream ended before a typed terminal event';
		params.state.sawFailure = true;
		params.state.sawTerminal = true;
		return {
			wire: `${buildResponsesFailedEvent({
				id: params.state.associationId,
				model: params.publicModelId,
			})}${params.line}\n`,
			stop: true,
		};
	}

	let parsed: ResponsesEvent;
	try {
		const candidate = JSON.parse(data) as unknown;
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid event');
		parsed = candidate as ResponsesEvent;
	} catch {
		params.usage.stream_error = params.usage.stream_error ?? 'Malformed OpenAI Responses SSE data event';
		params.state.sawFailure = true;
		params.state.sawTerminal = true;
		return {
			wire: buildResponsesFailedEvent({
				id: params.state.associationId,
				model: params.publicModelId,
			}),
			stop: true,
		};
	}

	const { terminal } = applyResponsesEvent(parsed, params.usage, params.timing);
	const responseId = normalizeUpstreamId(parsed.response?.id ?? parsed.id);
	// A native Responses id is the strongest association once emitted; the
	// request generation id remains only a pre-event fallback.
	if (responseId) params.state.associationId = responseId;
	const type = typeof parsed.type === 'string' ? parsed.type : '';
	const failed = type === 'response.failed' || type === 'response.error' || type === 'error';
	params.state.sawTerminal ||= terminal;
	params.state.sawFailure ||= failed;
	return {
		wire: `${rewriteResponsesModelInDataLine(params.line, params.publicModelId)}\n`,
		// Error events are terminal and must not be followed by a second,
		// unrelated synthesized response id.
		stop: failed,
	};
}

async function pumpResponsesWithUsageTracking(
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
		sawTerminal: false,
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

	const writeChunk = async (text: string): Promise<void> => {
		if (!text || clientDisconnected) return;
		try {
			await writer.write(encoder.encode(text));
		} catch {
			markClientDisconnected();
			console.log('[Gateway Responses] client disconnected; upstream stream cancelled');
		}
	};
	const processLine = (line: string): ProcessedResponsesLine => processResponsesSseLine({
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
				if (state.lineBuffer.length > MAX_RESPONSES_SSE_LINE_CHARS) {
					throw new Error('Responses SSE event exceeded the gateway framing limit');
				}
				if (state.lineBuffer.trim()) {
					const line = state.lineBuffer;
					state.lineBuffer = '';
					const processed = processLine(line);
					await writeChunk(processed.wire);
				}
				if (!state.sawTerminal && !clientDisconnected) {
					usage.stream_error =
						usage.stream_error ?? 'Upstream stream ended without a terminal Responses event';
					state.sawFailure = true;
					state.sawTerminal = true;
					await writeChunk(buildResponsesFailedEvent({
						id: state.associationId,
						model: publicModelId,
					}));
				}
				break;
			}

			if (value.byteLength > 0) timing?.markFirstByte();
			state.lineBuffer += decoder.decode(value, { stream: true });
			if (state.lineBuffer.length > MAX_RESPONSES_SSE_LINE_CHARS && !state.lineBuffer.includes('\n')) {
				throw new Error('Responses SSE event exceeded the gateway framing limit');
			}
			const lines = state.lineBuffer.split('\n');
			state.lineBuffer = lines.pop() ?? '';
			if (state.lineBuffer.length > MAX_RESPONSES_SSE_LINE_CHARS) {
				throw new Error('Responses SSE event exceeded the gateway framing limit');
			}

			let forward = '';
			let stop = false;
			for (const line of lines) {
				if (line.length > MAX_RESPONSES_SSE_LINE_CHARS) {
					throw new Error('Responses SSE event exceeded the gateway framing limit');
				}
				const processed = processLine(line);
				forward += processed.wire;
				if (processed.stop) {
					stop = true;
					break;
				}
			}
			await writeChunk(forward);
			if (stop || clientDisconnected) {
				await reader.cancel(stop ? 'Responses SSE terminal error/marker received' : requestSignal?.reason).catch(() => undefined);
				break;
			}
		}
	} catch (err) {
		if (!clientDisconnected) {
			console.warn('[Gateway Responses] pump error', err instanceof Error ? err.message : String(err));
			usage.stream_error = usage.stream_error ?? sanitizePublicErrorMessage(
				err instanceof Error ? err.message : String(err),
				'Upstream Responses stream failed',
			);
			if (!state.sawFailure) {
				state.sawFailure = true;
				state.sawTerminal = true;
				await writeChunk(buildResponsesFailedEvent({
					id: state.associationId,
					model: publicModelId,
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
				'[Gateway Responses] pump writer.close (non-fatal)',
				err instanceof Error ? err.message : String(err),
				{ clientDisconnected, usageCancelled: usage.cancelled },
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

	pumpResponsesWithUsageTracking(
		response.body!,
		writable,
		usage,
		resolveUsage,
		requestSignal,
		timing,
		publicModelId,
		publicCorrelationId,
	).catch(
		() => {
			// resolveUsage already called in finally
		},
	);

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

function extractUsageFromResponsesObject(parsed: Record<string, unknown>): UsageFromStream {
	const responseObject = parsed.response != null
		&& typeof parsed.response === 'object'
		&& !Array.isArray(parsed.response)
		? parsed.response as Record<string, unknown>
		: null;
	const usageCandidate = responseObject?.usage ?? parsed.usage;
	const usageObj = usageCandidate != null
		&& typeof usageCandidate === 'object'
		&& !Array.isArray(usageCandidate)
		? usageCandidate as ResponsesUsage
		: null;
	let usage: UsageFromStream = usageObj ? usageFromResponses(usageObj) : { ...EMPTY_USAGE_LOCAL };
	const msgId = normalizeUpstreamId(parsed.id ?? responseObject?.id);
	if (msgId) usage = { ...usage, upstreamMessageId: msgId };
	return usage;
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
		skin: 'responses',
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
	if (publicModelId) {
		parsed.model = publicModelId;
		const responseObject = parsed.response != null
			&& typeof parsed.response === 'object'
			&& !Array.isArray(parsed.response)
			? parsed.response as Record<string, unknown>
			: null;
		if (responseObject && Object.prototype.hasOwnProperty.call(responseObject, 'model')) {
			responseObject.model = publicModelId;
		}
	}
	return {
		response: rebuildTextJsonResponse(response, parsed),
		usagePromise: Promise.resolve(extractUsageFromResponsesObject(parsed)),
	};
}

/**
 * 向供应商发起 OpenAI 兼容 `POST …/responses`。
 * 未知字段原样透传；仅把 `model` 换成路由上的上游模型名。
 */
export async function dispatchOpenAiResponsesRoute(
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
	const url = resolveUpstreamEndpoint('openai', 'responses', route.providerEndpoints, {
		providerId: route.providerId,
	});
	assertTextUpstreamHttpUrl(url);
	const cancelledBeforeDispatch = () => ({
		response: preDispatchCancelledTextResponse('responses', publicCorrelationId),
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
		model: applyVertexOpenAiModelPrefix(url, route.providerModelName),
	};
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
