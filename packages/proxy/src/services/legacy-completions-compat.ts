import { GatewayErrorCode } from './gateway-error-codes';
import { gatewayErrorResponse } from './gateway-error-response';
import { buildCompletionsMidstreamErrorEvent } from './openrouter-error-protocol';
import {
	BoundedSseEventFramer,
	parseSseEventData,
	rewriteSseEventData,
	terminateSseEvent,
} from './egress/sse-data-line';
import {
	readBoundedTextJsonObject,
	rebuildTextJsonResponse,
	TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS,
} from './egress/text-json-response';

const MAX_COMPLETIONS_SSE_EVENT_CHARS = 1024 * 1024;
const MAX_COMPLETIONS_SSE_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETIONS_SSE_QUEUED_EVENTS = 256;
/** Bound prompt replay across every requested choice before any upstream call. */
export const MAX_LEGACY_ECHO_TOTAL_BYTES = 256 * 1024;

type LegacyRequestResult =
	| {
		ok: true;
		chatBody: Record<string, unknown>;
		responseOptions: LegacyCompletionResponseOptions;
	}
	| { ok: false; message: string };

export type LegacyCompletionResponseOptions = {
	logprobsRequested: boolean;
	/** Exact public prompt to prepend once per choice; null means echo was not requested. */
	echoPrompt: string | null;
	requestId?: string | null;
	/** Per-request settlement hook used to classify gateway-side stream adaptation failures. */
	onSettled?: (failure: string | null) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function unsupportedWhenPresent(
	body: Record<string, unknown>,
	field: string,
): string | null {
	return hasOwn(body, field) && body[field] != null
		? `${field} is not supported by the legacy Completions compatibility adapter`
		: null;
}

/**
 * Translate the explicitly supported subset of OpenAI's legacy text-completion
 * request to Chat Completions. Parameters whose semantics cannot be preserved
 * fail closed instead of being silently ignored or billed with different behavior.
 */
export function adaptLegacyCompletionRequest(body: unknown): LegacyRequestResult {
	if (!isRecord(body)) return { ok: false, message: 'Request body must be a JSON object' };
	if (hasOwn(body, 'messages')) {
		return { ok: false, message: 'messages is not accepted by the legacy Completions endpoint; use prompt' };
	}

	const prompt = body.prompt;
	if (prompt != null && typeof prompt !== 'string') {
		return {
			ok: false,
			message: 'prompt must be a string or null; batched and token-array prompts are not supported',
		};
	}
	if (hasOwn(body, 'stream') && typeof body.stream !== 'boolean') {
		return { ok: false, message: 'stream must be a boolean' };
	}
	if (hasOwn(body, 'n')) {
		if (!Number.isSafeInteger(body.n) || (body.n as number) < 1 || (body.n as number) > 128) {
			return { ok: false, message: 'n must be an integer between 1 and 128' };
		}
	}

	let requestedLogprobs: number | null = null;
	if (hasOwn(body, 'logprobs') && body.logprobs != null) {
		if (
			!Number.isSafeInteger(body.logprobs)
			|| (body.logprobs as number) < 0
			|| (body.logprobs as number) > 5
		) {
			return { ok: false, message: 'logprobs must be an integer between 0 and 5 or null' };
		}
		requestedLogprobs = body.logprobs as number;
	}
	if (hasOwn(body, 'top_logprobs')) {
		return { ok: false, message: 'top_logprobs is not a legacy Completions request parameter; use logprobs' };
	}

	if (hasOwn(body, 'echo') && body.echo != null && typeof body.echo !== 'boolean') {
		return { ok: false, message: 'echo must be a boolean or null' };
	}
	const echoRequested = body.echo === true;
	if (echoRequested && requestedLogprobs != null) {
		return {
			ok: false,
			message: 'echo=true cannot be combined with logprobs because prompt token logprobs are unavailable',
		};
	}
	if (echoRequested) {
		const choiceCount = hasOwn(body, 'n') ? body.n as number : 1;
		const promptBytes = new TextEncoder().encode(prompt ?? '').byteLength;
		if (promptBytes * choiceCount > MAX_LEGACY_ECHO_TOTAL_BYTES) {
			return {
				ok: false,
				message: `echo prompt expansion exceeds the ${MAX_LEGACY_ECHO_TOTAL_BYTES}-byte gateway limit`,
			};
		}
	}
	if (hasOwn(body, 'suffix') && body.suffix != null) {
		return { ok: false, message: 'suffix is not supported by the legacy Completions compatibility adapter' };
	}
	if (hasOwn(body, 'best_of') && body.best_of != null && body.best_of !== 1) {
		return { ok: false, message: 'best_of values other than 1 are not supported by the legacy Completions compatibility adapter' };
	}

	for (const field of ['tools', 'tool_choice', 'functions', 'function_call', 'modalities', 'audio']) {
		const message = unsupportedWhenPresent(body, field);
		if (message) return { ok: false, message };
	}

	const chatBody: Record<string, unknown> = { ...body };
	delete chatBody.prompt;
	delete chatBody.echo;
	delete chatBody.suffix;
	delete chatBody.best_of;
	delete chatBody.logprobs;
	chatBody.messages = [{ role: 'user', content: prompt ?? '' }];
	if (requestedLogprobs != null) {
		chatBody.logprobs = true;
		chatBody.top_logprobs = requestedLogprobs;
	}

	return {
		ok: true,
		chatBody,
		responseOptions: {
			logprobsRequested: requestedLogprobs != null,
			echoPrompt: echoRequested ? prompt ?? '' : null,
		},
	};
}

/**
 * Refresh echo from the post-Preset, post-Guardrail Chat body. This prevents a
 * redacted client prompt from being reintroduced by the response adapter.
 */
export function refreshLegacyCompletionEchoOptions(
	options: LegacyCompletionResponseOptions,
	body: Record<string, unknown>,
): { ok: true; options: LegacyCompletionResponseOptions } | { ok: false; message: string } {
	if (options.echoPrompt === null) return { ok: true, options };
	if (!Array.isArray(body.messages)) {
		return { ok: false, message: 'Guardrail-adjusted echo prompt is unavailable' };
	}
	const userMessage = body.messages.find((value) =>
		isRecord(value) && value.role === 'user');
	const prompt = isRecord(userMessage) ? textContent(userMessage.content) : null;
	if (prompt == null) {
		return { ok: false, message: 'Guardrail-adjusted echo prompt is unavailable' };
	}
	const choiceCount = Number.isSafeInteger(body.n) && (body.n as number) >= 1
		? body.n as number
		: 1;
	if (new TextEncoder().encode(prompt).byteLength * choiceCount > MAX_LEGACY_ECHO_TOTAL_BYTES) {
		return {
			ok: false,
			message: `Guardrail-adjusted echo prompt expansion exceeds the ${MAX_LEGACY_ECHO_TOTAL_BYTES}-byte gateway limit`,
		};
	}
	return { ok: true, options: { ...options, echoPrompt: prompt } };
}

type LegacyLogprobs = {
	tokens: string[];
	token_logprobs: Array<number | null>;
	top_logprobs: Array<Record<string, number> | null>;
	text_offset: number[];
};

function textContent(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (value == null) return '';
	if (!Array.isArray(value)) return null;
	let text = '';
	for (const part of value) {
		if (!isRecord(part) || typeof part.text !== 'string') return null;
		text += part.text;
	}
	return text;
}

function unicodeScalarLength(value: string): number {
	return Array.from(value).length;
}

function legacyLogprobs(
	value: unknown,
	startOffset: number,
): { value: LegacyLogprobs | null; nextOffset: number } {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		return { value: null, nextOffset: startOffset };
	}
	const result: LegacyLogprobs = {
		tokens: [],
		token_logprobs: [],
		top_logprobs: [],
		text_offset: [],
	};
	let offset = startOffset;
	for (const item of value.content) {
		if (!isRecord(item) || typeof item.token !== 'string') {
			return { value: null, nextOffset: startOffset };
		}
		result.tokens.push(item.token);
		result.token_logprobs.push(
			typeof item.logprob === 'number' && Number.isFinite(item.logprob)
				? item.logprob
				: null,
		);
		result.text_offset.push(offset);
		offset += unicodeScalarLength(item.token);

		if (!Array.isArray(item.top_logprobs)) {
			result.top_logprobs.push(null);
			continue;
		}
		const alternatives: Record<string, number> = {};
		for (const alternative of item.top_logprobs) {
			if (
				isRecord(alternative)
				&& typeof alternative.token === 'string'
				&& typeof alternative.logprob === 'number'
				&& Number.isFinite(alternative.logprob)
			) {
				alternatives[alternative.token] = alternative.logprob;
			}
		}
		result.top_logprobs.push(alternatives);
	}
	return { value: result, nextOffset: offset };
}

function adaptChatCompletionObject(
	value: Record<string, unknown>,
	options: LegacyCompletionResponseOptions,
	streaming: boolean,
	offsets: Map<number, number>,
): Record<string, unknown> | null {
	if (options.echoPrompt !== null && options.logprobsRequested) return null;
	if (!Array.isArray(value.choices) || value.choices.length > TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS) {
		return null;
	}
	const choices: Record<string, unknown>[] = [];
	for (const rawChoice of value.choices) {
		if (!isRecord(rawChoice) || !Number.isSafeInteger(rawChoice.index)) return null;
		const index = rawChoice.index as number;
		const source = rawChoice[streaming ? 'delta' : 'message'];
		if (!isRecord(source)) return null;
		const completionText = textContent(source.content);
		if (completionText == null) return null;
		const echoPrefix = options.echoPrompt !== null && !offsets.has(index)
			? options.echoPrompt
			: '';
		const text = `${echoPrefix}${completionText}`;
		const startOffset = offsets.get(index) ?? 0;
		const convertedLogprobs = options.logprobsRequested
			? legacyLogprobs(rawChoice.logprobs, startOffset)
			: { value: null, nextOffset: startOffset + unicodeScalarLength(text) };
		const nextOffset = convertedLogprobs.value == null
			? startOffset + unicodeScalarLength(text)
			: convertedLogprobs.nextOffset;
		offsets.set(index, nextOffset);
		const choice: Record<string, unknown> = {
			...rawChoice,
			text,
			logprobs: convertedLogprobs.value,
		};
		delete choice.message;
		delete choice.delta;
		choices.push(choice);
	}
	return { ...value, object: 'text_completion', choices };
}

function invalidAdaptedResponse(requestId?: string | null): Response {
	return gatewayErrorResponse({
		status: 502,
		code: GatewayErrorCode.upstreamRequestFailed,
		message: 'Upstream provider returned a Chat response that cannot be represented as a legacy Completion',
		skin: 'chat',
		requestId,
	});
}

class CompletionSseQueueLimitError extends Error {}

function adaptCompletionStream(
	response: Response,
	options: LegacyCompletionResponseOptions,
): Response {
	const source = response.body!;
	const reader = source.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const framer = new BoundedSseEventFramer(
		MAX_COMPLETIONS_SSE_EVENT_CHARS,
		'Legacy Completions SSE event exceeded the gateway framing limit',
	);
	const output: Uint8Array[] = [];
	const offsets = new Map<number, number>();
	let outputBytes = 0;
	let sourceDone = false;
	let readerReleased = false;
	let associationId = options.requestId ?? null;
	let publicModel = '';
	let publicProvider = '';
	let settled = false;
	const settle = (failure: string | null): void => {
		if (settled) return;
		settled = true;
		options.onSettled?.(failure);
	};

	const releaseReader = (): void => {
		if (readerReleased) return;
		readerReleased = true;
		reader.releaseLock();
	};
	const cancelReader = async (reason: unknown): Promise<void> => {
		if (readerReleased) return;
		try {
			await reader.cancel(reason).catch(() => undefined);
		} finally {
			releaseReader();
		}
	};
	const enqueue = (wire: string): void => {
		const bytes = encoder.encode(wire);
		if (
			output.length + 1 > MAX_COMPLETIONS_SSE_QUEUED_EVENTS
			|| outputBytes + bytes.byteLength > MAX_COMPLETIONS_SSE_QUEUED_BYTES
		) throw new CompletionSseQueueLimitError();
		output.push(bytes);
		outputBytes += bytes.byteLength;
	};
	const handleEvent = (event: string): boolean => {
		const data = parseSseEventData(event);
		if (data == null || !data.trim()) {
			enqueue(terminateSseEvent(event));
			return false;
		}
		if (data.trim() === '[DONE]') {
			enqueue(rewriteSseEventData(event, '[DONE]'));
			return true;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new Error('Legacy Completions adapter received malformed SSE JSON');
		}
		if (!isRecord(parsed)) throw new Error('Legacy Completions adapter received a non-object SSE event');
		if (typeof parsed.id === 'string' && parsed.id) associationId = parsed.id;
		if (typeof parsed.model === 'string') publicModel = parsed.model;
		if (typeof parsed.provider === 'string') publicProvider = parsed.provider;
		const adapted = adaptChatCompletionObject(parsed, options, true, offsets);
		if (!adapted) throw new Error('Legacy Completions adapter received an incompatible Chat SSE event');
		enqueue(rewriteSseEventData(event, JSON.stringify(adapted)));
		return false;
	};

	const headers = new Headers(response.headers);
	headers.delete('Content-Length');
	headers.delete('Content-Encoding');
	headers.delete('Transfer-Encoding');
	return new Response(new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (output.length === 0 && !sourceDone) {
					const next = await reader.read();
					if (next.done) {
						const stopped = await framer.push(decoder.decode(), handleEvent);
						const remainder = stopped ? '' : framer.finish();
						if (remainder.trim()) handleEvent(terminateSseEvent(remainder));
						sourceDone = true;
						releaseReader();
						settle(null);
						break;
					}
					const stopped = await framer.push(decoder.decode(next.value, { stream: true }), handleEvent);
					if (stopped) {
						sourceDone = true;
						// The Chat driver stops producing after [DONE]. Releasing without
						// cancelling avoids classifying a normal terminal frame as a client abort.
						releaseReader();
						settle(null);
					}
				}
				while (output.length > 0 && (controller.desiredSize ?? 1) > 0) {
					const bytes = output.shift()!;
					outputBytes -= bytes.byteLength;
					controller.enqueue(bytes);
				}
				if (sourceDone && output.length === 0) controller.close();
			} catch (error) {
				output.length = 0;
				outputBytes = 0;
				sourceDone = true;
				await cancelReader(
					error instanceof CompletionSseQueueLimitError
						? 'legacy_completions_stream_queue_limit'
						: 'legacy_completions_stream_adaptation_failed',
				);
				const failure = error instanceof CompletionSseQueueLimitError
					? 'Legacy Completions stream exceeded the gateway buffering limit'
					: 'Legacy Completions stream adaptation failed';
				settle(failure);
				controller.enqueue(encoder.encode(buildCompletionsMidstreamErrorEvent({
					id: associationId,
					model: publicModel,
					provider: publicProvider,
					message: failure,
				})));
				controller.close();
			}
		},
		async cancel(reason) {
			sourceDone = true;
			output.length = 0;
			outputBytes = 0;
			await cancelReader(reason);
			settle(null);
		},
	}), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Convert a successful, already-validated Chat response into legacy shape. */
export async function adaptChatResponseToLegacyCompletion(
	response: Response,
	options: LegacyCompletionResponseOptions,
): Promise<Response> {
	if (!response.ok || response.body == null) {
		options.onSettled?.(null);
		return response;
	}
	const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
	if (contentType.includes('text/event-stream')) return adaptCompletionStream(response, options);
	if (!contentType.includes('application/json')) {
		options.onSettled?.('Legacy Completions response adaptation failed');
		return invalidAdaptedResponse(options.requestId);
	}

	const materialized = await readBoundedTextJsonObject(response, {
		skin: 'chat',
		requestId: options.requestId,
	});
	if (!materialized.ok) {
		options.onSettled?.('Legacy Completions response adaptation failed');
		return materialized.response;
	}
	const adapted = adaptChatCompletionObject(
		materialized.value,
		options,
		false,
		new Map<number, number>(),
	);
	if (!adapted) {
		options.onSettled?.('Legacy Completions response adaptation failed');
		return invalidAdaptedResponse(options.requestId);
	}
	options.onSettled?.(null);
	return rebuildTextJsonResponse(response, adapted);
}
