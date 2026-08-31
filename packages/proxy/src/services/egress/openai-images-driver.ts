/**
 * OpenAI 兼容 Images API 上游驱动：`/images/generations`（JSON）与 `/images/edits`（multipart）。
 * 首期面向 GPT Image；Gateway 对外保持 OpenAI 形状，日志禁止写入 prompt 原文与 Base64。
 */
import { parseOpenAiImageUsage, resolveProviderUpstreamSecret, resolveUpstreamEndpoint, type ImageTokenUsage } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { EMPTY_USAGE } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import {
	resolveResponseByteLimit,
	responseTextWithinLimit,
	UpstreamResponseBodyTooLargeError,
} from './bounded-response-body';
import {
	sanitizeUpstreamUrlForLog,
	upstreamErrorNameForLog,
} from './upstream-observability';
import { sanitizePublicErrorMessage } from '../openrouter-error-protocol';

/** 与 `ProxyDispatchMeta.imageAbortReason` 对齐；勿从 failover-dispatch 反向 import（避免环依赖）。 */
export type ImageDispatchAbortReason = 'client_abort' | 'gateway_timeout';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
	const number = finiteNonNegative(value);
	return number != null && Number.isSafeInteger(number) ? number : null;
}

/** Accept OpenAI input/output names and OpenRouter prompt/completion aliases without inventing usage. */
function parseImageUsageFromAnyShape(body: unknown): ImageTokenUsage | null {
	if (!isRecord(body) || !isRecord(body.usage)) return null;
	const usage = body.usage;
	return parseOpenAiImageUsage({
		usage: {
			...usage,
			input_tokens: usage.input_tokens ?? usage.prompt_tokens,
			output_tokens: usage.output_tokens ?? usage.completion_tokens,
		},
	});
}

function usageFromStreamFromImage(body: unknown): {
	usagePromise: Promise<UsageFromStream>;
	imageUsage: ImageTokenUsage | null;
} {
	const parsed = parseImageUsageFromAnyShape(body);
	if (!parsed) {
		return { usagePromise: Promise.resolve(EMPTY_USAGE), imageUsage: null };
	}
	const streamUsage: UsageFromStream = {
		input_tokens: parsed.text_tokens,
		output_tokens: parsed.image_output_tokens,
		cache_read_tokens: parsed.cached_text_tokens,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
		total_tokens: parsed.total_tokens,
		raw_usage: parsed.raw_usage,
	};
	return { usagePromise: Promise.resolve(streamUsage), imageUsage: parsed };
}

function inferImageMediaTypeFromBase64(value: string): string | null {
	const trimmed = value.trim();
	const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(trimmed);
	if (dataUrl?.[1]) return dataUrl[1].toLowerCase();
	const raw = dataUrl ? trimmed.slice(dataUrl[0].length) : trimmed;
	const prefix = raw.replace(/\s+/g, '').slice(0, 684);
	if (!prefix) return null;
	try {
		const padded = prefix.padEnd(Math.ceil(prefix.length / 4) * 4, '=');
		const decoded = atob(padded);
		const bytes = Array.from(decoded.slice(0, 16), (char) => char.charCodeAt(0));
		if (bytes.length >= 8 && bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') {
			return 'image/png';
		}
		if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
		if (
			decoded.slice(0, 4) === 'RIFF'
			&& decoded.length >= 12
			&& decoded.slice(8, 12) === 'WEBP'
		) return 'image/webp';
		const textPrefix = decoded.slice(0, 512).replace(/^\uFEFF/, '').trimStart().toLowerCase();
		if (textPrefix.startsWith('<svg') || (textPrefix.startsWith('<?xml') && textPrefix.includes('<svg'))) {
			return 'image/svg+xml';
		}
	} catch {
		return null;
	}
	return null;
}

function normalizeOpenRouterImageUsage(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const normalized: Record<string, unknown> = { ...value };
	const promptTokens = finiteNonNegativeInteger(value.prompt_tokens ?? value.input_tokens);
	const completionTokens = finiteNonNegativeInteger(value.completion_tokens ?? value.output_tokens);
	const explicitTotal = finiteNonNegativeInteger(value.total_tokens);
	if (promptTokens != null) normalized.prompt_tokens = promptTokens;
	if (completionTokens != null) normalized.completion_tokens = completionTokens;
	if (explicitTotal != null) normalized.total_tokens = explicitTotal;
	else if (promptTokens != null && completionTokens != null) {
		normalized.total_tokens = promptTokens + completionTokens;
	}
	const cost = finiteNonNegative(value.cost);
	if (cost != null) normalized.cost = cost;
	else delete normalized.cost;
	return normalized;
}

/** Normalize only fields supported by evidence in the provider response. */
export function normalizeOpenRouterImageResponse(body: unknown): unknown {
	if (!isRecord(body)) return body;
	const normalized: Record<string, unknown> = { ...body };
	if (Array.isArray(body.data)) {
		normalized.data = body.data.map((item) => {
			if (!isRecord(item)) return item;
			const row: Record<string, unknown> = { ...item };
			if (
				typeof row.b64_json === 'string'
				&& (typeof row.media_type !== 'string' || row.media_type.trim() === '')
			) {
				const mediaType = inferImageMediaTypeFromBase64(row.b64_json);
				if (mediaType) row.media_type = mediaType;
			}
			return row;
		});
	}
	const usage = normalizeOpenRouterImageUsage(body.usage);
	if (usage) normalized.usage = usage;
	return normalized;
}

function upstreamSupplierCostTicks(body: unknown): number | null {
	if (!isRecord(body) || !isRecord(body.usage)) return null;
	const ticks = body.usage.cost_in_usd_ticks;
	return typeof ticks === 'number' && Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
}

function imageDispatchMeta(
	body: unknown,
	imageUsage: ImageTokenUsage | null,
	imageAbortReason?: ImageDispatchAbortReason,
	uncertainty?: { upstreamOutcomeUnknown?: boolean; responseBodyTooLarge?: boolean },
): {
	imageUsage: ImageTokenUsage | null;
	parsedBody: unknown;
	imageAbortReason?: ImageDispatchAbortReason;
	upstreamOutcomeUnknown?: boolean;
	responseBodyTooLarge?: boolean;
	failoverForbidden?: boolean;
} {
	const outcomeUnknown = uncertainty?.upstreamOutcomeUnknown === true
		|| uncertainty?.responseBodyTooLarge === true;
	return {
		imageUsage,
		parsedBody: body,
		...(imageAbortReason ? { imageAbortReason } : {}),
		...(outcomeUnknown ? { upstreamOutcomeUnknown: true, failoverForbidden: true } : {}),
		...(uncertainty?.responseBodyTooLarge ? { responseBodyTooLarge: true } : {}),
	};
}

function resolveImageAbortReasonForMeta(
	abortReason: ImageAbortReason,
	requestSignal?: AbortSignal
): ImageDispatchAbortReason | undefined {
	const resolved: ImageAbortReason =
		abortReason === 'none' && requestSignal?.aborted ? 'client_abort' : abortReason;
	return resolved === 'client_abort' || resolved === 'gateway_timeout' ? resolved : undefined;
}

/** Wait for upstream Images API; high-quality / large sizes can take several minutes. */
export const IMAGE_GENERATION_TIMEOUT_MS = 300_000;
export const IMAGE_MAX_PROMPT_CHARS = 4_000;
export const IMAGE_MAX_REFERENCE_COUNT = 5;
export const IMAGE_MAX_BYTES_PER_FILE = 20 * 1024 * 1024;
/** 与文档 5×20MB 对齐的总上传上限，避免 Worker 内存被多图打爆 */
export const IMAGE_MAX_TOTAL_UPLOAD_BYTES = IMAGE_MAX_REFERENCE_COUNT * IMAGE_MAX_BYTES_PER_FILE;
/** One generated image is buffered only long enough to validate JSON and usage. */
export const IMAGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const IMAGE_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export type OpenAiImageDispatchOptions = {
	fetchImpl?: typeof fetch;
	maxResponseBytes?: number;
	/** Token-priced routes must not return an image unless aggregate usage can settle exactly. */
	requireAuthoritativeUsage?: boolean;
};

export type ImageEditUpload = {
	filename: string;
	mimeType: string;
	bytes: Uint8Array;
};

export type NormalizedImageEditRequest = {
	prompt: string;
	n: number;
	size?: string;
	quality?: string;
	background?: string;
	/** OpenAI edits 通常用 `image` / 多图 `image[]`；此处统一为数组 */
	images: ImageEditUpload[];
	/** 透传给上游的其余安全字段（不含 prompt / 文件） */
	extra?: Record<string, unknown>;
};

type ImageAbortReason = 'none' | 'gateway_timeout' | 'client_abort';

function withTimeoutSignal(
	requestSignal: AbortSignal | undefined,
	timeoutMs: number
): {
	signal: AbortSignal;
	clear: () => void;
	getAbortReason: () => ImageAbortReason;
	abortUpstream: (reason?: Exclude<ImageAbortReason, 'none'>) => void;
} {
	const controller = new AbortController();
	let reason: ImageAbortReason = 'none';
	const onClientAbort = () => {
		if (reason === 'none') reason = 'client_abort';
		controller.abort();
	};
	requestSignal?.addEventListener('abort', onClientAbort, { once: true });
	if (requestSignal?.aborted) onClientAbort();
	const timer = setTimeout(() => {
		if (reason === 'none') reason = 'gateway_timeout';
		controller.abort();
	}, timeoutMs);
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			requestSignal?.removeEventListener('abort', onClientAbort);
		},
		getAbortReason: () => reason,
		abortUpstream: (nextReason) => {
			if (nextReason && reason === 'none') reason = nextReason;
			if (!controller.signal.aborted) controller.abort();
		},
	};
}

function imageAbortErrorPayload(
	operation: 'generation' | 'edit',
	abortReason: ImageAbortReason,
	timeoutMs: number
): { message: string; abort_reason: string; timeout_ms: number } {
	const kind = operation === 'generation' ? 'Image generation' : 'Image edit';
	const message =
		abortReason === 'gateway_timeout'
			? `${kind} timed out waiting for upstream after ${timeoutMs}ms`
			: abortReason === 'client_abort'
				? `${kind} was cancelled by the client`
				: `${kind} timed out or was cancelled`;
	return {
		message,
		abort_reason: abortReason === 'none' ? 'aborted' : abortReason,
		timeout_ms: timeoutMs,
	};
}

/** 校验并规范化 generation / edit 公共参数（`n` 接受 number 或数字字符串，如 multipart）。 */
export function normalizeImageCommonParams(input: {
	prompt: unknown;
	n?: unknown;
	size?: unknown;
	quality?: unknown;
	background?: unknown;
}):
	| { ok: true; prompt: string; n: number; size?: string; quality?: string; background?: string }
	| { ok: false; error: string } {
	const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
	if (!prompt) {
		return { ok: false, error: 'prompt is required' };
	}
	if (prompt.length > IMAGE_MAX_PROMPT_CHARS) {
		return { ok: false, error: `prompt must be at most ${IMAGE_MAX_PROMPT_CHARS} characters` };
	}

	let n = 1;
	if (input.n !== undefined && input.n !== null && input.n !== '') {
		const nRaw =
			typeof input.n === 'string' && input.n.trim() !== '' ? Number(input.n) : input.n;
		if (typeof nRaw !== 'number' || !Number.isSafeInteger(nRaw) || nRaw < 1 || nRaw > 10) {
			return { ok: false, error: 'n must be an integer between 1 and 10' };
		}
		n = nRaw;
	}

	const asOptString = (v: unknown, field: string): string | undefined | { error: string } => {
		if (v === undefined || v === null || v === '') {
			return undefined;
		}
		if (typeof v !== 'string') {
			return { error: `${field} must be a string` };
		}
		const t = v.trim();
		return t || undefined;
	};

	const size = asOptString(input.size, 'size');
	if (size && typeof size === 'object') {
		return { ok: false, error: size.error };
	}
	const quality = asOptString(input.quality, 'quality');
	if (quality && typeof quality === 'object') {
		return { ok: false, error: quality.error };
	}
	const background = asOptString(input.background, 'background');
	if (background && typeof background === 'object') {
		return { ok: false, error: background.error };
	}

	return {
		ok: true,
		prompt,
		n,
		size: size as string | undefined,
		quality: quality as string | undefined,
		background: background as string | undefined,
	};
}

export function validateImageUpload(file: ImageEditUpload): string | null {
	if (!file.bytes?.byteLength) {
		return 'image file is empty';
	}
	if (file.bytes.byteLength > IMAGE_MAX_BYTES_PER_FILE) {
		return `each image must be at most ${IMAGE_MAX_BYTES_PER_FILE} bytes`;
	}
	const mime = (file.mimeType || '').trim().toLowerCase();
	if (!IMAGE_ALLOWED_MIME.has(mime)) {
		return 'image mime type must be image/png, image/jpeg, or image/webp';
	}
	return null;
}

/** 统计 OpenAI Images 响应中有效图片数（b64_json 或 url）。 */
export function countValidImageResults(payload: unknown): number {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return 0;
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		return 0;
	}
	let count = 0;
	for (const item of data) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const row = item as Record<string, unknown>;
		const b64 = typeof row.b64_json === 'string' ? row.b64_json.trim() : '';
		const url = typeof row.url === 'string' ? row.url.trim() : '';
		if (b64.length > 0 || url.length > 0) {
			count += 1;
		}
	}
	return count;
}

/** 日志用：去掉 prompt / 图片二进制字段，仅保留摘要。 */
export function redactImageRequestForLog(params: {
	model?: string;
	n?: number;
	size?: string;
	quality?: string;
	background?: string;
	prompt?: string;
	referenceCount?: number;
	operation: 'generations' | 'edits';
}): Record<string, unknown> {
	const prompt = params.prompt ?? '';
	return {
		operation: params.operation,
		model: params.model,
		n: params.n,
		size: params.size,
		quality: params.quality,
		background: params.background,
		prompt_chars: prompt.length,
		reference_count: params.referenceCount ?? 0,
		_redacted: ['prompt', 'image', 'images', 'b64_json'],
	};
}

/**
 * A completed SSE event contains a base64 image and is copied while decoding,
 * parsing, normalizing, and encoding. Keep its hard limit well below the Worker
 * memory ceiling instead of reusing the larger one-shot JSON response limit.
 */
export const IMAGE_MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;

type ImageStreamSettlement = {
	completed: boolean;
	done: boolean;
	cancelled: boolean;
	imageAbortReason?: ImageDispatchAbortReason;
	errorMessage: string | null;
	validImages: number;
	imageUsage: ImageTokenUsage | null;
	upstreamSupplierCostUsdTicks: number | null;
};

function safeImageStreamErrorCode(value: unknown): string {
	return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)
		? value
		: 'server_error';
}

function sseFrame(payload: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const SSE_DONE_FRAME = new TextEncoder().encode('data: [DONE]\n\n');
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(': keep-alive\n\n');

function findSseBoundary(buffer: string): { index: number; length: number } | null {
	const match = /\r?\n\r?\n/.exec(buffer);
	return match?.index == null ? null : { index: match.index, length: match[0].length };
}

/**
 * Validate and normalize one SSE event at a time. The response is never buffered as a whole;
 * cancellation of the downstream reader aborts and cancels the upstream body immediately.
 */
function validatedImageSse(
	response: Response,
	requestedImageCount: number,
	requireAuthoritativeUsage: boolean,
	lifecycle: {
		clear(): void;
		getAbortReason(): ImageAbortReason;
		abortUpstream(reason?: Exclude<ImageAbortReason, 'none'>): void;
	},
	timing?: RequestTimingCollector | null,
): { response: Response; settlement: Promise<ImageStreamSettlement> } {
	const upstreamBody = response.body;
	if (!upstreamBody) {
		lifecycle.clear();
		const settlement = Promise.resolve<ImageStreamSettlement>({
			completed: false,
			done: false,
			cancelled: false,
			errorMessage: 'Image generation stream had no response body',
			validImages: 0,
			imageUsage: null,
			upstreamSupplierCostUsdTicks: null,
		});
		return {
			response: new Response(
				new Blob([
					sseFrame({ type: 'error', error: { message: 'Image generation stream had no response body', code: 'server_error' } }),
					SSE_DONE_FRAME,
				]).stream(),
				{ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } },
			),
			settlement,
		};
	}

	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const output: Uint8Array[] = [];
	let readerCancelled = false;
	const cancelUpstreamReader = async (reason: unknown): Promise<void> => {
		if (readerCancelled) return;
		readerCancelled = true;
		await reader.cancel(reason).catch(() => undefined);
	};
	let buffer = '';
	let sourceEnded = false;
	let stopSource = false;
	let sawDone = false;
	let failed = false;
	let cancelled = false;
	let errorMessage: string | null = null;
	let completedCount = 0;
	let imageUsage: ImageTokenUsage | null = null;
	let supplierCostTicks: number | null = null;
	let terminalAbortReason: ImageDispatchAbortReason | undefined;
	let settled = false;
	let settlePromise!: (value: ImageStreamSettlement) => void;
	const settlement = new Promise<ImageStreamSettlement>((resolve) => {
		settlePromise = resolve;
	});

	const settle = (abortReason?: ImageDispatchAbortReason): void => {
		if (settled) return;
		settled = true;
		lifecycle.clear();
		timing?.markStreamComplete();
		settlePromise({
			completed: !failed && !cancelled && completedCount > 0 && sawDone,
			done: sawDone,
			cancelled,
			...(abortReason ? { imageAbortReason: abortReason } : {}),
			errorMessage,
			validImages: !failed && !cancelled && sawDone ? completedCount : 0,
			imageUsage: !failed && !cancelled && sawDone ? imageUsage : null,
			upstreamSupplierCostUsdTicks:
				!failed && !cancelled && sawDone ? supplierCostTicks : null,
		});
	};

	const pushError = (message: string, code = 'server_error'): void => {
		const safeMessage = sanitizePublicErrorMessage(message, 'Image generation stream failed');
		if (!failed) {
			output.push(sseFrame({ type: 'error', error: { message: safeMessage, code: safeImageStreamErrorCode(code) } }));
		}
		failed = true;
		errorMessage = safeMessage;
	};

	const pushDone = (abortReason?: ImageDispatchAbortReason): void => {
		if (sawDone) return;
		sawDone = true;
		terminalAbortReason = abortReason;
		output.push(SSE_DONE_FRAME);
	};

	const hasAuthoritativeUsage = (): boolean => imageUsage != null && (
		imageUsage.text_tokens > 0
		|| imageUsage.image_input_tokens > 0
		|| imageUsage.image_output_tokens > 0
		|| imageUsage.total_tokens > 0
	);

	const failAndStop = (message: string, code = 'server_error'): void => {
		pushError(message, code);
		pushDone();
		stopSource = true;
		lifecycle.abortUpstream();
	};

	const processEvent = (rawEvent: string): void => {
		const lines = rawEvent.split(/\r?\n/);
		const dataLines: string[] = [];
		let commentOnly = false;
		for (const line of lines) {
			if (line.startsWith(':')) {
				commentOnly = true;
				continue;
			}
			if (line === 'data') dataLines.push('');
			else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
		}
		if (dataLines.length === 0) {
			if (commentOnly) output.push(SSE_KEEPALIVE_FRAME);
			return;
		}
		const data = dataLines.join('\n').trim();
		if (data === '[DONE]') {
			// OpenRouter explicitly permits providers to return fewer than the requested `n`.
			// Require at least one completed image and settle per-image billing by observed count.
			if (!failed && completedCount === 0) {
				pushError('Image generation stream ended without a completed image');
			}
			if (!failed && requireAuthoritativeUsage && !hasAuthoritativeUsage()) {
				pushError('Image generation stream completed without authoritative usage');
			}
			pushDone();
			stopSource = true;
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			failAndStop('Image generation stream contained invalid JSON');
			return;
		}
		if (!isRecord(parsed) || typeof parsed.type !== 'string') {
			failAndStop('Image generation stream contained an invalid event');
			return;
		}

		if (parsed.type === 'image_generation.partial_image') {
			const index = finiteNonNegativeInteger(parsed.partial_image_index);
			if (index == null || typeof parsed.b64_json !== 'string' || parsed.b64_json.trim() === '') {
				failAndStop('Image generation stream contained an invalid partial image event');
				return;
			}
			output.push(sseFrame({
				type: 'image_generation.partial_image',
				partial_image_index: index,
				b64_json: parsed.b64_json,
			}));
			return;
		}

		if (parsed.type === 'image_generation.completed') {
			if (typeof parsed.b64_json !== 'string' || parsed.b64_json.trim() === '') {
				failAndStop('Image generation stream contained an invalid completed event');
				return;
			}
			completedCount += 1;
			if (completedCount > requestedImageCount) {
				failAndStop('Image generation stream exceeded the admitted image count');
				return;
			}
			const completed: Record<string, unknown> = { ...parsed };
			if (typeof completed.media_type !== 'string' || completed.media_type.trim() === '') {
				const mediaType = inferImageMediaTypeFromBase64(parsed.b64_json);
				if (mediaType) completed.media_type = mediaType;
				else delete completed.media_type;
			}
			if (completed.created !== undefined && finiteNonNegativeInteger(completed.created) == null) {
				delete completed.created;
			}
			const normalizedUsage = normalizeOpenRouterImageUsage(parsed.usage);
			if (normalizedUsage) {
				completed.usage = normalizedUsage;
				imageUsage = parseImageUsageFromAnyShape({ usage: normalizedUsage });
			}
			const ticks = upstreamSupplierCostTicks(parsed);
			if (ticks != null) supplierCostTicks = ticks;
			output.push(sseFrame(completed));
			return;
		}

		if (parsed.type === 'error') {
			const upstreamError = isRecord(parsed.error) ? parsed.error : {};
			const message = typeof upstreamError.message === 'string'
				? upstreamError.message
				: 'Image generation stream failed';
			pushError(message, safeImageStreamErrorCode(upstreamError.code));
			pushDone();
			stopSource = true;
			lifecycle.abortUpstream();
			return;
		}

		failAndStop('Image generation stream contained an unsupported event type');
	};

	const finishAtEof = (): void => {
		const tail = `${buffer}${decoder.decode()}`;
		buffer = '';
		if (tail.length > IMAGE_MAX_SSE_EVENT_BYTES) {
			failAndStop('Image generation stream event exceeded the gateway size limit');
		} else if (tail.trim()) {
			processEvent(tail);
		}
		if (!sawDone) {
			if (!failed) pushError('Image generation stream ended before [DONE]');
			pushDone();
		}
		sourceEnded = true;
	};

	const stream = new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			while (output.length === 0 && !sourceEnded) {
				if (stopSource) {
					await cancelUpstreamReader('image_stream_terminal');
					sourceEnded = true;
					break;
				}
				const boundary = findSseBoundary(buffer);
				if (boundary) {
					if (boundary.index > IMAGE_MAX_SSE_EVENT_BYTES) {
						failAndStop('Image generation stream event exceeded the gateway size limit');
						continue;
					}
					const event = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary.length);
					processEvent(event);
					continue;
				}
				if (buffer.length > IMAGE_MAX_SSE_EVENT_BYTES) {
					failAndStop('Image generation stream event exceeded the gateway size limit');
					continue;
				}
				try {
					const next = await reader.read();
					if (next.done) {
						finishAtEof();
						break;
					}
					buffer += decoder.decode(next.value, { stream: true });
				} catch {
					const abortReason = lifecycle.getAbortReason();
					if (abortReason === 'client_abort') {
						cancelled = true;
						errorMessage = 'Image generation was cancelled by the client';
						settle('client_abort');
						sourceEnded = true;
						break;
					}
					if (abortReason === 'gateway_timeout') {
						pushError('Image generation timed out waiting for the upstream stream');
						pushDone('gateway_timeout');
					} else {
						pushError('Image generation upstream stream was interrupted');
						pushDone();
					}
					sourceEnded = true;
				}
			}
			const chunk = output.shift();
			if (chunk) controller.enqueue(chunk);
			else if (sourceEnded) {
				settle(terminalAbortReason);
				controller.close();
			}
		},
		async cancel(reason): Promise<void> {
			cancelled = true;
			errorMessage = 'Image generation was cancelled by the client';
			lifecycle.abortUpstream('client_abort');
			settle('client_abort');
			await cancelUpstreamReader(reason);
		},
	});

	return {
		response: new Response(stream, {
			status: response.status,
			statusText: response.statusText,
			headers: {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache',
			},
		}),
		settlement,
	};
}

async function readJsonResponse(
	response: Response,
	maxBytes: number,
	timing?: RequestTimingCollector | null
): Promise<{ response: Response; body: unknown; jsonValid: boolean }> {
	const text = await responseTextWithinLimit(response, maxBytes);
	timing?.markStreamComplete();
	let body: unknown = null;
	let jsonValid = true;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		jsonValid = false;
		body = { error: { message: text.slice(0, 500) || 'Invalid upstream JSON' } };
	}
	return {
		response: new Response(JSON.stringify(body), {
			status: response.status,
			statusText: response.statusText,
			headers: {
				'Content-Type': 'application/json',
			},
		}),
		body,
		jsonValid,
	};
}

/**
 * `POST …/images/generations`
 */
export async function dispatchOpenAiImageGenerations(
	route: RouteResult,
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: OpenAiImageDispatchOptions = {},
	beforeFetch?: () => Promise<void>,
): Promise<{
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	meta: {
		imageUsage: ImageTokenUsage | null;
		parsedBody: unknown;
		imageStreamSettlement?: Promise<ImageStreamSettlement>;
		imageAbortReason?: ImageDispatchAbortReason;
		upstreamOutcomeUnknown?: boolean;
		responseBodyTooLarge?: boolean;
		failoverForbidden?: boolean;
	};
}> {
	const url = resolveUpstreamEndpoint('openai', 'images.generations', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const upstreamLabel = sanitizeUpstreamUrlForLog(url);
	// 与 chat/messages 一致：每条 failover 路由合并各自 custom_params，用户字段优先
	const requestBody = {
		...buildRouteRequestBody(route, body),
		model: route.providerModelName,
	};
	console.log(JSON.stringify({
		event: 'gateway.images.upstream_start',
		operation: 'generations',
		upstream: upstreamLabel,
		providerId: route.providerId,
		routeTargetId: route.targetId,
		providerModel: route.providerModelName,
	}));
	const startedAt = Date.now();
	const { signal, clear, getAbortReason, abortUpstream } = withTimeoutSignal(
		requestSignal,
		IMAGE_GENERATION_TIMEOUT_MS
	);
	const responseByteLimit = resolveResponseByteLimit(
		options.maxResponseBytes,
		IMAGE_MAX_RESPONSE_BYTES,
	);
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	let observedUpstreamRequestId: string | null = null;
	let streamOwnsLifecycle = false;
	try {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		await beforeFetch?.();
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		dispatchStarted = true;
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`,
			},
			body: JSON.stringify(requestBody),
			signal,
		});
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		observedUpstreamRequestId = upstreamRequestId;
		const streamRequested = body.stream === true;
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
		if (streamRequested && response.ok) {
			if (!contentType.includes('text/event-stream')) {
				await response.body?.cancel('image_stream_content_type_mismatch').catch(() => undefined);
				const errorBody = {
					error: { message: 'Upstream did not return an image generation event stream' },
				};
				return {
					response: new Response(JSON.stringify(errorBody), {
						status: 502,
						headers: { 'Content-Type': 'application/json' },
					}),
					usagePromise: Promise.resolve(EMPTY_USAGE),
					upstreamRequestId,
					meta: imageDispatchMeta(errorBody, null, undefined, { upstreamOutcomeUnknown: true }),
				};
			}
			streamOwnsLifecycle = true;
			const stream = validatedImageSse(
				response,
				typeof body.n === 'number' && Number.isSafeInteger(body.n)
					? body.n
					: 1,
				options.requireAuthoritativeUsage === true,
				{ clear, getAbortReason, abortUpstream },
				timing,
			);
			const usagePromise = stream.settlement.then((settlement): UsageFromStream => ({
				...(settlement.imageUsage
					? {
						input_tokens: settlement.imageUsage.text_tokens,
						output_tokens: settlement.imageUsage.image_output_tokens,
						cache_read_tokens: settlement.imageUsage.cached_text_tokens,
						cache_write_tokens: 0,
						reasoning_tokens: 0,
						total_tokens: settlement.imageUsage.total_tokens,
						raw_usage: settlement.imageUsage.raw_usage,
					}
					: EMPTY_USAGE),
				...(settlement.cancelled ? { cancelled: true } : {}),
				...(!settlement.completed && !settlement.cancelled
					? { stream_error: settlement.errorMessage ?? 'Image generation stream failed' }
					: {}),
			}));
			return {
				response: stream.response,
				usagePromise,
				upstreamRequestId,
				meta: {
					imageUsage: null,
					parsedBody: null,
					imageStreamSettlement: stream.settlement,
					failoverForbidden: true,
				},
			};
		}
		const material = await readJsonResponse(response, responseByteLimit, timing);
		console.log(JSON.stringify({
			event: 'gateway.images.upstream_complete',
			operation: 'generations',
			upstream: upstreamLabel,
			providerId: route.providerId,
			routeTargetId: route.targetId,
			status: response.status,
			elapsedMs: Date.now() - startedAt,
		}));
		const normalizedBody = response.ok
			? normalizeOpenRouterImageResponse(material.body)
			: material.body;
		const normalizedResponse = response.ok
			? new Response(JSON.stringify(normalizedBody), {
					status: material.response.status,
					statusText: material.response.statusText,
					headers: { 'Content-Type': 'application/json' },
				})
			: material.response;
		const { usagePromise, imageUsage } = usageFromStreamFromImage(normalizedBody);
		if (
			response.ok
			&& options.requireAuthoritativeUsage === true
			&& (
				imageUsage == null
				|| (
					imageUsage.text_tokens === 0
					&& imageUsage.image_input_tokens === 0
					&& imageUsage.image_output_tokens === 0
					&& imageUsage.total_tokens === 0
				)
			)
		) {
			const errorBody = { error: { message: 'Image generation completed without authoritative usage' } };
			return {
				response: new Response(JSON.stringify(errorBody), {
					status: 502,
					headers: { 'Content-Type': 'application/json' },
				}),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId,
				meta: imageDispatchMeta(errorBody, null, undefined, { upstreamOutcomeUnknown: true }),
			};
		}
		return {
			response: normalizedResponse,
			usagePromise,
			upstreamRequestId,
			meta: imageDispatchMeta(normalizedBody, imageUsage, undefined, {
				upstreamOutcomeUnknown:
					response.ok
					&& (!material.jsonValid || countValidImageResults(normalizedBody) === 0),
			}),
		};
	} catch (err) {
		timing?.markStreamComplete();
		const abortReason = getAbortReason();
		const aborted =
			abortReason !== 'none' ||
			requestSignal?.aborted ||
			(err instanceof Error && err.name === 'AbortError');
		const resolvedAbort =
			abortReason === 'none' && requestSignal?.aborted ? 'client_abort' : abortReason;
		const imageAbortReason = aborted
			? resolveImageAbortReasonForMeta(resolvedAbort, requestSignal)
			: undefined;
		const explicitNonOk = upstreamStatus != null && (upstreamStatus < 200 || upstreamStatus >= 300);
		const upstreamOutcomeUnknown = dispatchStarted && !explicitNonOk;
		const responseBodyTooLarge =
			err instanceof UpstreamResponseBodyTooLargeError && upstreamOutcomeUnknown;
		const error = aborted
			? imageAbortErrorPayload('generation', resolvedAbort, IMAGE_GENERATION_TIMEOUT_MS)
			: {
					message: 'Image generation upstream failed',
				};
		console.error(JSON.stringify({
			event: 'gateway.images.upstream_error',
			operation: 'generations',
			upstream: upstreamLabel,
			providerId: route.providerId,
			routeTargetId: route.targetId,
			abortReason,
			elapsedMs: Date.now() - startedAt,
			errorName: upstreamErrorNameForLog(err),
		}));
		const errorBody = { error };
		return {
			response: new Response(JSON.stringify(errorBody), {
				status: explicitNonOk
					? upstreamStatus!
					: imageAbortReason === 'gateway_timeout'
						? 504
						: imageAbortReason === 'client_abort'
							? 499
							: 502,
				headers: { 'Content-Type': 'application/json' },
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: observedUpstreamRequestId,
			meta: {
				...imageDispatchMeta(
				errorBody,
				null,
				imageAbortReason,
				{ upstreamOutcomeUnknown, responseBodyTooLarge },
				),
				...(imageAbortReason ? { failoverForbidden: true } : {}),
			},
		};
	} finally {
		if (!streamOwnsLifecycle) clear();
	}
}

/**
 * `POST …/images/edits`（multipart）
 */
export async function dispatchOpenAiImageEdits(
	route: RouteResult,
	edit: NormalizedImageEditRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: OpenAiImageDispatchOptions = {},
	beforeFetch?: () => Promise<void>,
): Promise<{
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	meta: {
		imageUsage: ImageTokenUsage | null;
		parsedBody: unknown;
		imageAbortReason?: ImageDispatchAbortReason;
		upstreamOutcomeUnknown?: boolean;
		responseBodyTooLarge?: boolean;
		failoverForbidden?: boolean;
	};
}> {
	const url = resolveUpstreamEndpoint('openai', 'images.edits', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const upstreamLabel = sanitizeUpstreamUrlForLog(url);
	console.log(JSON.stringify({
		event: 'gateway.images.upstream_start',
		operation: 'edits',
		upstream: upstreamLabel,
		providerId: route.providerId,
		routeTargetId: route.targetId,
		providerModel: route.providerModelName,
	}));
	const form = new FormData();
	// custom_params 作为额外表单字段；用户/规范化字段优先覆盖
	const mergedExtras = buildRouteRequestBody(route, {
		...(edit.extra ?? {}),
		prompt: edit.prompt,
		n: edit.n,
		...(edit.size ? { size: edit.size } : {}),
		...(edit.quality ? { quality: edit.quality } : {}),
		...(edit.background ? { background: edit.background } : {}),
	});
	form.append('model', route.providerModelName);
	for (const [k, v] of Object.entries(mergedExtras)) {
		if (v == null) continue;
		if (k === 'model' || k === 'image' || k === 'images') continue;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			form.append(k, String(v));
		}
	}
	for (const img of edit.images) {
		// 直接用已有 Uint8Array 构造 Blob，避免再 copy 一份驻留内存
		const blob = new Blob([img.bytes], { type: img.mimeType });
		form.append('image', blob, img.filename || 'image.png');
	}

	const startedAt = Date.now();
	const { signal, clear, getAbortReason } = withTimeoutSignal(
		requestSignal,
		IMAGE_GENERATION_TIMEOUT_MS
	);
	const responseByteLimit = resolveResponseByteLimit(
		options.maxResponseBytes,
		IMAGE_MAX_RESPONSE_BYTES,
	);
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	let observedUpstreamRequestId: string | null = null;
	try {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		await beforeFetch?.();
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		dispatchStarted = true;
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
			},
			body: form,
			signal,
		});
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		observedUpstreamRequestId = upstreamRequestId;
		const material = await readJsonResponse(response, responseByteLimit, timing);
		console.log(JSON.stringify({
			event: 'gateway.images.upstream_complete',
			operation: 'edits',
			upstream: upstreamLabel,
			providerId: route.providerId,
			routeTargetId: route.targetId,
			status: response.status,
			elapsedMs: Date.now() - startedAt,
		}));
		const normalizedBody = response.ok
			? normalizeOpenRouterImageResponse(material.body)
			: material.body;
		const normalizedResponse = response.ok
			? new Response(JSON.stringify(normalizedBody), {
					status: material.response.status,
					statusText: material.response.statusText,
					headers: { 'Content-Type': 'application/json' },
				})
			: material.response;
		const { usagePromise, imageUsage } = usageFromStreamFromImage(normalizedBody);
		return {
			response: normalizedResponse,
			usagePromise,
			upstreamRequestId,
			meta: imageDispatchMeta(normalizedBody, imageUsage, undefined, {
				upstreamOutcomeUnknown:
					response.ok
					&& (!material.jsonValid || countValidImageResults(normalizedBody) === 0),
			}),
		};
	} catch (err) {
		timing?.markStreamComplete();
		const abortReason = getAbortReason();
		const aborted =
			abortReason !== 'none' ||
			requestSignal?.aborted ||
			(err instanceof Error && err.name === 'AbortError');
		const resolvedAbort =
			abortReason === 'none' && requestSignal?.aborted ? 'client_abort' : abortReason;
		const imageAbortReason = aborted
			? resolveImageAbortReasonForMeta(resolvedAbort, requestSignal)
			: undefined;
		const explicitNonOk = upstreamStatus != null && (upstreamStatus < 200 || upstreamStatus >= 300);
		const upstreamOutcomeUnknown = dispatchStarted && !explicitNonOk;
		const responseBodyTooLarge =
			err instanceof UpstreamResponseBodyTooLargeError && upstreamOutcomeUnknown;
		const error = aborted
			? imageAbortErrorPayload('edit', resolvedAbort, IMAGE_GENERATION_TIMEOUT_MS)
			: {
					message: 'Image edit upstream failed',
				};
		console.error(JSON.stringify({
			event: 'gateway.images.upstream_error',
			operation: 'edits',
			upstream: upstreamLabel,
			providerId: route.providerId,
			routeTargetId: route.targetId,
			abortReason,
			elapsedMs: Date.now() - startedAt,
			errorName: upstreamErrorNameForLog(err),
		}));
		const errorBody = { error };
		return {
			response: new Response(JSON.stringify(errorBody), {
				status: explicitNonOk
					? upstreamStatus!
					: imageAbortReason === 'gateway_timeout'
						? 504
						: imageAbortReason === 'client_abort'
							? 499
							: 502,
				headers: { 'Content-Type': 'application/json' },
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: observedUpstreamRequestId,
			meta: {
				...imageDispatchMeta(
				errorBody,
				null,
				imageAbortReason,
				{ upstreamOutcomeUnknown, responseBodyTooLarge },
				),
				...(imageAbortReason ? { failoverForbidden: true } : {}),
			},
		};
	} finally {
		clear();
	}
}
