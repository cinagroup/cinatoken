import { applyVertexOpenAiModelPrefix, resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import {
	BoundedSseEventFramer,
	parseSseDataLine,
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
	buildResponsesFailedEvent,
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
export const MAX_RESPONSES_SSE_EVENT_CHARS = 256 * 1024;
/** @deprecated Kept for callers that imported the former line-oriented limit. */
export const MAX_RESPONSES_SSE_LINE_CHARS = MAX_RESPONSES_SSE_EVENT_CHARS;

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
	speed?: unknown;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_creation_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
		image_tokens?: number;
	};
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_creation_tokens?: number;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
		image_tokens?: number;
	};
};

const RESPONSE_STATUSES = new Set([
	'cancelled',
	'completed',
	'failed',
	'in_progress',
	'incomplete',
	'queued',
]);

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

function validResponsesUsage(value: unknown): value is ResponsesUsage {
	if (!isPlainObject(value)) return false;
	const input = value.input_tokens;
	const prompt = value.prompt_tokens;
	const output = value.output_tokens;
	const completion = value.completion_tokens;
	if (
		(!nonNegativeSafeInteger(input) && !nonNegativeSafeInteger(prompt))
		|| (!nonNegativeSafeInteger(output) && !nonNegativeSafeInteger(completion))
		|| !nonNegativeSafeInteger(value.total_tokens)
		|| (input !== undefined && prompt !== undefined && input !== prompt)
		|| (output !== undefined && completion !== undefined && output !== completion)
	) return false;

	const inputDetails = value.input_tokens_details;
	const promptDetails = value.prompt_tokens_details;
	const outputDetails = value.output_tokens_details;
	const completionDetails = value.completion_tokens_details;
	for (const details of [inputDetails, promptDetails, outputDetails, completionDetails]) {
		if (details !== undefined && !isPlainObject(details)) return false;
	}
	const inputDetailsObject = isPlainObject(inputDetails) ? inputDetails : undefined;
	const promptDetailsObject = isPlainObject(promptDetails) ? promptDetails : undefined;
	const outputDetailsObject = isPlainObject(outputDetails) ? outputDetails : undefined;
	const completionDetailsObject = isPlainObject(completionDetails) ? completionDetails : undefined;
	if (
		!optionalSafeCount(inputDetailsObject?.cached_tokens)
		|| !optionalSafeCount(inputDetailsObject?.cache_creation_tokens)
		|| !optionalSafeCount(promptDetailsObject?.cached_tokens)
		|| !optionalSafeCount(promptDetailsObject?.cache_creation_tokens)
		|| !optionalSafeCount(outputDetailsObject?.reasoning_tokens)
		|| !optionalSafeCount(outputDetailsObject?.image_tokens)
		|| !optionalSafeCount(completionDetailsObject?.reasoning_tokens)
		|| !optionalSafeCount(completionDetailsObject?.image_tokens)
		|| (
			inputDetailsObject?.cached_tokens !== undefined
			&& promptDetailsObject?.cached_tokens !== undefined
			&& inputDetailsObject.cached_tokens !== promptDetailsObject.cached_tokens
		)
		|| (
			outputDetailsObject?.reasoning_tokens !== undefined
			&& completionDetailsObject?.reasoning_tokens !== undefined
			&& outputDetailsObject.reasoning_tokens !== completionDetailsObject.reasoning_tokens
		)
		|| (
			outputDetailsObject?.image_tokens !== undefined
			&& completionDetailsObject?.image_tokens !== undefined
			&& outputDetailsObject.image_tokens !== completionDetailsObject.image_tokens
		)
	) return false;

	const inputCount = effectiveSafeCount(input, prompt);
	const outputCount = effectiveSafeCount(output, completion);
	if (inputCount == null || outputCount == null) return false;
	const cachedValue = inputDetailsObject?.cached_tokens ?? promptDetailsObject?.cached_tokens;
	const reasoningValue = outputDetailsObject?.reasoning_tokens
		?? completionDetailsObject?.reasoning_tokens;
	const cached = nonNegativeSafeInteger(cachedValue) ? cachedValue : 0;
	const reasoning = nonNegativeSafeInteger(reasoningValue) ? reasoningValue : 0;
	return Number.isSafeInteger(inputCount + outputCount)
		&& value.total_tokens === inputCount + outputCount
		&& cached <= inputCount
		&& reasoning <= outputCount;
}

function validResponsesError(value: unknown): boolean {
	return value === null || (
		isPlainObject(value)
		&& typeof value.code === 'string'
		&& value.code.trim().length > 0
		&& typeof value.message === 'string'
		&& value.message.trim().length > 0
	);
}

function validResponsesSuccessResponse(value: Record<string, unknown>): boolean {
	if (
		value.object !== 'response'
		|| normalizeUpstreamId(value.id) == null
		|| typeof value.model !== 'string'
		|| !value.model.trim()
		|| !nonNegativeSafeInteger(value.created_at)
		|| (value.completed_at !== null && !nonNegativeSafeInteger(value.completed_at))
		|| typeof value.status !== 'string'
		|| !RESPONSE_STATUSES.has(value.status)
		|| !Array.isArray(value.output)
		|| value.output.length > TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS
		|| (value.error !== undefined && !validResponsesError(value.error))
		|| (value.usage !== undefined && value.usage !== null && !validResponsesUsage(value.usage))
	) return false;
	if (value.status === 'failed' && !isPlainObject(value.error)) return false;
	return value.output.every((item) => isPlainObject(item)
		&& typeof item.type === 'string'
		&& item.type.trim().length > 0);
}

type ResponsesEvent = {
	type?: string;
	id?: string;
	model?: unknown;
	delta?: unknown;
	usage?: ResponsesUsage;
	service_tier?: unknown;
	response?: {
		id?: string;
		model?: unknown;
		status?: string;
		usage?: ResponsesUsage;
		service_tier?: unknown;
		error?: { message?: string; code?: string };
	};
	error?: { message?: string; code?: string };
};

type SSEState = {
	sawTerminal: boolean;
	sawFailure: boolean;
	associationId: string | null;
	serviceTier: ReturnType<typeof normalizeOpenAiResponseServiceTier>;
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
	const nativePrompt = effectiveSafeCount(u.input_tokens, u.prompt_tokens);
	const nativeCompletion = effectiveSafeCount(u.output_tokens, u.completion_tokens);
	const nativeCachedValue = u.input_tokens_details?.cached_tokens
		?? u.prompt_tokens_details?.cached_tokens;
	const nativeReasoningValue = u.output_tokens_details?.reasoning_tokens
		?? u.completion_tokens_details?.reasoning_tokens;
	const nativeCompletionImagesValue = u.output_tokens_details?.image_tokens
		?? u.completion_tokens_details?.image_tokens;
	const usage: UsageFromStream = {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_read_tokens: cacheRead,
		cache_write_tokens: cacheWrite,
		reasoning_tokens: reasoning,
		total_tokens: numberOrZero(u.total_tokens) || inputTokens + outputTokens,
		raw_usage: JSON.stringify(u),
		native_tokens_prompt: nativePrompt,
		native_tokens_completion: nativeCompletion,
		native_tokens_cached: nonNegativeSafeInteger(nativeCachedValue) ? nativeCachedValue : null,
		native_tokens_reasoning: nonNegativeSafeInteger(nativeReasoningValue) ? nativeReasoningValue : null,
		native_tokens_completion_images: nonNegativeSafeInteger(nativeCompletionImagesValue)
			? nativeCompletionImagesValue
			: null,
	};
	if (Object.prototype.hasOwnProperty.call(u, 'speed')) {
		usage.speed = normalizeResponseTextSpeed(u.speed);
	}
	return usage;
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
	target.native_tokens_prompt = next.native_tokens_prompt;
	target.native_tokens_completion = next.native_tokens_completion;
	target.native_tokens_cached = next.native_tokens_cached;
	target.native_tokens_reasoning = next.native_tokens_reasoning;
	target.native_tokens_completion_images = next.native_tokens_completion_images;
	if (Object.prototype.hasOwnProperty.call(next, 'speed')) target.speed = next.speed;
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
	if (usageObj && Object.prototype.hasOwnProperty.call(usageObj, 'speed')) {
		usageObj.speed = normalizeResponseTextSpeed(usageObj.speed);
	}
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

function rewriteResponsesPublicFieldsInSseEvent(
	event: string,
	publicModelId?: string,
	serviceTier: ReturnType<typeof normalizeOpenAiResponseServiceTier> = null,
): string {
	const parsedData = parseSseEventData(event);
	if (parsedData === null) return event;
	const data = parsedData.trim();
	if (!data || data === '[DONE]') return event;
	try {
		const parsed = JSON.parse(data) as ResponsesEvent;
		let changed = false;
		if (publicModelId && Object.prototype.hasOwnProperty.call(parsed, 'model')) {
			parsed.model = publicModelId;
			changed = true;
		}
		if (publicModelId && parsed.response && Object.prototype.hasOwnProperty.call(parsed.response, 'model')) {
			parsed.response.model = publicModelId;
			changed = true;
		}
		if (Object.prototype.hasOwnProperty.call(parsed, 'service_tier')) {
			parsed.service_tier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
			changed = true;
		}
		if (parsed.response) {
			parsed.response.service_tier = Object.prototype.hasOwnProperty.call(parsed.response, 'service_tier')
				? normalizeOpenAiResponseServiceTier(parsed.response.service_tier)
				: serviceTier;
			changed = true;
		}
		for (const usage of [parsed.usage, parsed.response?.usage]) {
			if (usage && Object.prototype.hasOwnProperty.call(usage, 'speed')) {
				usage.speed = normalizeResponseTextSpeed(usage.speed);
				changed = true;
			}
		}
		return changed ? rewriteSseEventData(event, JSON.stringify(parsed)) : event;
	} catch {
		return event;
	}
}

type ProcessedResponsesEvent = { wire: string; stop: boolean };

function processResponsesSseEvent(params: {
	event: string;
	state: SSEState;
	usage: UsageFromStream;
	timing?: RequestTimingCollector | null;
	publicModelId?: string;
}): ProcessedResponsesEvent {
	const parsedData = parseSseEventData(params.event);
	if (parsedData === null) return { wire: params.event, stop: false };
	const data = parsedData.trim();
	if (!data) return { wire: params.event, stop: false };
	if (data === '[DONE]') {
		if (params.state.sawTerminal) return { wire: params.event, stop: true };
		params.usage.stream_error =
			params.usage.stream_error ?? 'Responses stream ended before a typed terminal event';
		params.state.sawFailure = true;
		params.state.sawTerminal = true;
		return {
			wire: `${buildResponsesFailedEvent({
				id: params.state.associationId,
				model: params.publicModelId,
			})}${params.event}`,
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
	if (Object.prototype.hasOwnProperty.call(parsed, 'service_tier')) {
		params.state.serviceTier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
	}
	if (parsed.response && Object.prototype.hasOwnProperty.call(parsed.response, 'service_tier')) {
		params.state.serviceTier = normalizeOpenAiResponseServiceTier(parsed.response.service_tier);
	}
	params.usage.service_tier = params.state.serviceTier;
	params.state.sawTerminal ||= terminal;
	params.state.sawFailure ||= failed;
	return {
		wire: rewriteResponsesPublicFieldsInSseEvent(
			params.event,
			params.publicModelId,
			params.state.serviceTier,
		),
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
		sawTerminal: false,
		sawFailure: false,
		associationId: normalizeUpstreamId(publicCorrelationId),
		serviceTier: null,
	};
	const framer = new BoundedSseEventFramer(
		MAX_RESPONSES_SSE_EVENT_CHARS,
		'Responses SSE event exceeded the gateway framing limit',
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

	const writeChunk = async (text: string): Promise<void> => {
		if (!text || clientDisconnected) return;
		try {
			await writer.write(encoder.encode(text));
		} catch {
			markClientDisconnected();
			console.log('[Gateway Responses] client disconnected; upstream stream cancelled');
		}
	};
	const processEvent = (event: string): ProcessedResponsesEvent => processResponsesSseEvent({
		event,
		state,
		usage,
		timing,
		publicModelId,
	});
	const handleEvent = async (event: string): Promise<boolean> => {
		const processed = processEvent(event);
		await writeChunk(processed.wire);
		return processed.stop || clientDisconnected;
	};

	try {
		while (true) {
			if (clientDisconnected) break;
			const { done, value } = await reader.read();
			if (done) {
				const stopped = await framer.push(decoder.decode(), handleEvent);
				const remainder = stopped ? '' : framer.finish();
				if (remainder.trim()) {
					await handleEvent(terminateSseEvent(remainder));
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
			const stop = await framer.push(decoder.decode(value, { stream: true }), handleEvent);
			if (stop || clientDisconnected) {
				await reader.cancel(stop ? 'Responses SSE terminal error/marker received' : requestSignal?.reason).catch(() => undefined);
				break;
			}
		}
	} catch (err) {
		if (!clientDisconnected) {
			await reader.cancel('Responses SSE processing failed').catch(() => undefined);
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
	if (usageObj && Object.prototype.hasOwnProperty.call(usageObj, 'speed')) {
		usageObj.speed = normalizeResponseTextSpeed(usageObj.speed);
	}
	let usage: UsageFromStream = usageObj ? usageFromResponses(usageObj) : { ...EMPTY_USAGE_LOCAL };
	usage.service_tier = normalizeOpenAiResponseServiceTier(
		responseObject?.service_tier ?? parsed.service_tier,
	);
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
	if (!validResponsesSuccessResponse(parsed)) {
		const invalid = invalidTextSuccessResponse({
			skin: 'responses',
			protocol: 'Responses',
			requestId: publicCorrelationId,
		});
		return {
			...invalid,
			usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
		};
	}
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
	parsed.service_tier = normalizeOpenAiResponseServiceTier(parsed.service_tier);
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
	const requestBody: Record<string, unknown> = {
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
			skin: 'responses',
			protocol: 'Responses',
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
