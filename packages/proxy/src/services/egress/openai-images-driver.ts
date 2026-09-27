/**
 * OpenAI 兼容 Images API 上游驱动：`/images/generations`（JSON）与 `/images/edits`（multipart）。
 * 首期面向 GPT Image；Gateway 对外保持 OpenAI 形状，日志禁止写入 prompt 原文与 Base64。
 */
import {
	resolveProviderUpstreamSecret, resolveUpstreamEndpoint,
	RequestAuxiliaryAuthLimitError, type RequestAuxiliaryAuthBudget, type ImageTokenUsage,
} from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { EMPTY_USAGE } from '../proxy';
import {
	buildImageEditUpstreamFields, buildImageGenerationUpstreamBody, captureImageAttemptRouteFacts,
	createPreparedImageEditAttempt, createPreparedImageGenerationAttempt, imageEditUpstreamFileMetadata,
	type PreparedImageAttempt,
} from '../image-attempt-context';
import { extractUpstreamRequestId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import {
	resolveResponseByteLimit,
	UpstreamResponseBodyTooLargeError,
} from './bounded-response-body';
import {
	sanitizeUpstreamUrlForLog,
	upstreamErrorNameForLog,
} from './upstream-observability';
import { buildOpenRouterErrorBody, sanitizePublicErrorMessage } from '../openrouter-error-protocol';
import { createRequestDeadline, RequestExecutionStoppedError } from '../request-deadline';
import { GatewayErrorCode } from '../gateway-error-codes';
import type { MultipartFile } from '../streaming-multipart-body';
import { createMultipartUploadBody } from './multipart-upload-body';
import { createJsonUploadBody } from './json-upload-body';
import { IMAGE_JSON_ADMISSION_LIMITS, IMAGE_JSON_STRUCTURE_LIMITS, JsonStructureBudget, JsonStructureLimitError } from '../json-structure-budget';
import { streamJsonResponse } from './stream-json-body';
import { segmentedJsonResponseWithinLimit } from './segmented-json-response';
import { hasJsonStringContent, isJsonString, jsonStringChunks, JsonStringPages } from './json-string-pages';
import { ImageUsageLimitError, parseImageUsageFromAnyShape } from './image-response-usage';

/** 与 `ProxyDispatchMeta.imageAbortReason` 对齐；勿从 failover-dispatch 反向 import（避免环依赖）。 */
export type ImageDispatchAbortReason = 'client_abort' | 'gateway_timeout';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonStringPages);
}

function validateImageUpstreamUrl(value: string): void {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error('Invalid image upstream URL'); }
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Image upstream must use HTTP(S)');
}

// A redirect or gateway/server timeout can be generated after image work has
// been accepted. Its HTTP status alone cannot authorize another paid send.
function imageStatusMayHideAcceptedWork(status: number): boolean {
	return (status >= 300 && status < 400) || status >= 500 || status === 408 || status === 499;
}

function finiteNonNegative(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
	const number = finiteNonNegative(value);
	return number != null && Number.isSafeInteger(number) ? number : null;
}

function usageFromStreamFromImage(body: unknown, checkActive?: () => void): {
	usagePromise: Promise<UsageFromStream>;
	imageUsage: ImageTokenUsage | null;
} {
	const parsed = parseImageUsageFromAnyShape(body, checkActive);
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

function inferImageMediaTypeFromBase64(value: string | JsonStringPages): string | null {
	// Only infer bounded metadata. Never trim/replace the complete base64 string
	// or duplicate an arbitrarily large data-URL MIME label into the response.
	let rawPrefix = '', prefix = '', started = false;
	for (let chunk of jsonStringChunks(value)) {
		if (!started) {
			let first = 0;
			while (first < chunk.length && /\s/.test(chunk[first]!)) first++;
			if (first === chunk.length) continue;
			chunk = chunk.slice(first); started = true;
		}
		if (rawPrefix.length < 1024) rawPrefix += chunk.slice(0, 1024 - rawPrefix.length);
		for (let i = 0; i < chunk.length && prefix.length < 684; i++) {
			if (!/\s/.test(chunk[i]!)) prefix += chunk[i];
		}
		if (rawPrefix.length === 1024 && prefix.length === 684) break;
	}
	// Legacy RegExp statics may retain their last input. Make this <=1024-char
	// label independent of a substring backed by an entire native image string.
	const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(rawPrefix.split('').join(''));
	if (dataUrl?.[1]) return dataUrl[1].toLowerCase();
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
				isJsonString(row.b64_json)
				&& !hasJsonStringContent(row.media_type)
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
/** Driver reference ceiling; public ingress also enforces 50 MiB including multipart framing. */
export const IMAGE_MAX_TOTAL_UPLOAD_BYTES = IMAGE_MAX_REFERENCE_COUNT * IMAGE_MAX_BYTES_PER_FILE;
/** Upstream wire-byte ceiling; UTF-8 replacement/normalization may expand downstream JSON. */
export const IMAGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Normalization may add media_type per data row and aggregate usage aliases.
// This internal traversal bound allows that expansion; the wire admission stays unchanged.
const NORMALIZED_IMAGE_JSON_LIMITS = Object.freeze({
	maxDepth: IMAGE_JSON_STRUCTURE_LIMITS.maxDepth,
	maxNodes: 3 * IMAGE_JSON_STRUCTURE_LIMITS.maxNodes + 16,
});
export const IMAGE_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export type OpenAiImageDispatchOptions = {
	fetchImpl?: typeof fetch;
	/** Trusted gateway correlation ID, not a provider or client-supplied identifier. */
	requestId?: string | null;
	maxResponseBytes?: number;
	/** Owned by the logical request, never reset for another credential or route. */
	auxiliaryAuth?: RequestAuxiliaryAuthBudget;
	/** Internal absolute dispatch ceiling; cannot extend the driver's hard limit. */
	deadlineAtMs?: number;
	/** Token-priced routes must not return an image unless aggregate usage can settle exactly. */
	requireAuthoritativeUsage?: boolean;
};

export type ImageEditUpload = {
	filename: string;
	mimeType: string;
} & ({ bytes: Uint8Array; blob?: never; upload?: never } | { blob: Blob; bytes?: never; upload?: never }
	| { upload: MultipartFile; bytes?: never; blob?: never });

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
	/** Request owner only: release replay storage once 2xx prevents replay AND upload has ended. */
	releaseAcceptedUpload?: () => void;
};

type ImageAbortReason = 'none' | 'gateway_timeout' | 'client_abort';

function withTimeoutSignal(
	requestSignal: AbortSignal | undefined,
	timeoutMs: number,
	deadlineAtMs?: number,
) {
	const controller = new AbortController();
	const owner = createRequestDeadline(Math.min(deadlineAtMs ?? Infinity, Date.now() + timeoutMs), controller.signal);
	let reason: ImageAbortReason = 'none';
	const getAbortReason = (): ImageAbortReason => {
		if (owner.signal.reason instanceof RequestExecutionStoppedError
			&& owner.signal.reason.reason === 'deadline_exceeded') return 'gateway_timeout';
		return reason;
	};
	const onClientAbort = () => {
		if (reason === 'none') reason = requestSignal?.reason instanceof RequestExecutionStoppedError
			&& requestSignal.reason.reason === 'deadline_exceeded' ? 'gateway_timeout' : 'client_abort';
		controller.abort();
	};
	requestSignal?.addEventListener('abort', onClientAbort, { once: true });
	if (requestSignal?.aborted) onClientAbort();
	return {
		signal: owner.signal,
		wait: owner.wait,
		checkActive: owner.throwIfStopped,
		clear: () => {
			owner.dispose();
			requestSignal?.removeEventListener('abort', onClientAbort);
		},
		getAbortReason,
		abortUpstream: (nextReason?: Exclude<ImageAbortReason, 'none'>) => {
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

/** Cancellation uses the established local 499 contract, not provider HTTP normalization. */
function imageAbortResponse(reason: ImageDispatchAbortReason, message: string): Response {
	const status = reason === 'client_abort' ? 499 : 504;
	const code = reason === 'client_abort' ? GatewayErrorCode.requestCancelled : GatewayErrorCode.requestDeadlineExceeded;
	return new Response(JSON.stringify(buildOpenRouterErrorBody({
		skin: 'chat', status, legacyCode: code, message,
		errorType: reason === 'client_abort' ? 'provider_unavailable' : 'timeout',
		metadata: { abort_reason: reason, timeout_ms: IMAGE_GENERATION_TIMEOUT_MS },
	})), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', 'X-OctaFuse-Error-Code': code } });
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
	const size = file.upload?.size ?? file.blob?.size ?? file.bytes?.byteLength ?? 0;
	if (!size) {
		return 'image file is empty';
	}
	if (size > IMAGE_MAX_BYTES_PER_FILE) {
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
		if (hasJsonStringContent(row.b64_json) || hasJsonStringContent(row.url)) {
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
	/** Local capacity rejection after 2xx is not proof of zero supplier cost. */
	upstreamOutcomeUnknown?: boolean;
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
		signal: AbortSignal;
		wait<T>(operation: () => Promise<T>): Promise<T>;
		clear(): void;
		getAbortReason(): ImageAbortReason;
		abortUpstream(reason?: Exclude<ImageAbortReason, 'none'>): void;
	},
	timing?: RequestTimingCollector | null,
	requestId?: string | null,
): { response: Response; settlement: Promise<ImageStreamSettlement> } {
	const publicRequestId = typeof requestId === 'string' && requestId.length <= 200
		? sanitizePublicErrorMessage(requestId, '') : '';
	// Public retry guidance is deliberately separate from the existing financial
	// capacity-uncertainty flag. An error/zero buyer charge never proves replay safe.
	const errorFrame = (message: string, code = 'server_error', outcomeUnknown = true) => sseFrame({
		type: 'error',
		error: {
			message: sanitizePublicErrorMessage(message, 'Image generation stream failed'),
			code: safeImageStreamErrorCode(code),
			metadata: {
				retry_safe: false,
				...(outcomeUnknown ? { outcome_unknown: true } : {}),
				...(publicRequestId ? { request_id: publicRequestId } : {}),
			},
		},
	});
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
					errorFrame('Image generation stream had no response body'),
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
	let queuedErrorFrame: Uint8Array | undefined;
	let errorEnqueued = false;
	let doneEnqueued = false;
	let readerCancelled = false;
	let readerReleased = false;
	const releaseReader = (): void => {
		if (readerReleased) return;
		readerReleased = true;
		reader.releaseLock();
	};
	const cancelUpstreamReader = (reason: unknown): void => {
		if (readerCancelled) return;
		readerCancelled = true;
		// A stalled transport/tee must not hold the request or settlement open.
		void reader.cancel(reason).catch(() => undefined);
		releaseReader();
	};
	let buffer = '';
	let sourceEnded = false;
	let stopSource = false;
	let sawDone = false;
	let failed = false;
	let cancelled = false;
	let errorMessage: string | null = null;
	let completedCount = 0;
	let observedImageOutput = false;
	let imageUsage: ImageTokenUsage | null = null;
	let upstreamOutcomeUnknown = false;
	let supplierCostTicks: number | null = null;
	let terminalAbortReason: ImageDispatchAbortReason | undefined;
	let settled = false;
	let downstreamClosed = false;
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	let settlePromise!: (value: ImageStreamSettlement) => void;
	const settlement = new Promise<ImageStreamSettlement>((resolve) => {
		settlePromise = resolve;
	});

	const settle = (abortReason?: ImageDispatchAbortReason): void => {
		if (settled) return;
		settled = true;
		lifecycle.signal.removeEventListener('abort', onAbort);
		lifecycle.clear();
		timing?.markStreamComplete();
		settlePromise({
			completed: !failed && !cancelled && completedCount > 0 && sawDone,
			done: sawDone,
			cancelled,
			...(upstreamOutcomeUnknown ? { upstreamOutcomeUnknown: true } : {}),
			...(abortReason ? { imageAbortReason: abortReason } : {}),
			errorMessage,
			validImages: !failed && !cancelled && sawDone ? completedCount : 0,
			imageUsage: !failed && !cancelled && sawDone ? imageUsage : null,
			upstreamSupplierCostUsdTicks:
				!failed && !cancelled && sawDone ? supplierCostTicks : null,
		});
	};

	const pushError = (message: string, code = 'server_error', outcomeUnknown = true): void => {
		const safeMessage = sanitizePublicErrorMessage(message, 'Image generation stream failed');
		if (!failed) {
			queuedErrorFrame = errorFrame(safeMessage, code, outcomeUnknown);
			output.push(queuedErrorFrame);
		}
		failed = true;
		errorMessage = safeMessage;
	};

	const pushDone = (abortReason?: ImageDispatchAbortReason): void => {
		if (sawDone) return;
		sawDone = true;
		terminalAbortReason = abortReason;
		output.push(SSE_DONE_FRAME);
		// User-approved financial boundary: valid completed + upstream DONE is
		// irreversible. Error-generated DONE already has failed=true. Neither
		// downstream queueing, EOF nor a later client cancellation owns billing.
		settle(abortReason);
	};

	const hasAuthoritativeUsage = (): boolean => imageUsage != null && (
		imageUsage.text_tokens > 0
		|| imageUsage.image_input_tokens > 0
		|| imageUsage.image_output_tokens > 0
		|| imageUsage.total_tokens > 0
	);

	const failAndStop = (message: string, code = 'server_error', outcomeUnknown = true): void => {
		pushError(message, code, outcomeUnknown);
		pushDone();
		stopSource = true;
		lifecycle.abortUpstream();
		cancelUpstreamReader('image_stream_protocol_error');
		// Invalid streams are already non-billable under the image contract;
		// their settlement cannot depend on delivery of the queued error frames.
		settle();
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
			new JsonStructureBudget(IMAGE_JSON_ADMISSION_LIMITS).write(data);
			parsed = JSON.parse(data);
		} catch (error) {
			if (error instanceof JsonStructureLimitError && error.dimension === 'property name characters') upstreamOutcomeUnknown = true;
			failAndStop(error instanceof JsonStructureLimitError
				? 'Image generation stream JSON exceeded the gateway structure limit'
				: 'Image generation stream contained invalid JSON');
			return;
		}
		if (!isRecord(parsed) || typeof parsed.type !== 'string') {
			failAndStop('Image generation stream contained an invalid event');
			return;
		}

		if (parsed.type === 'image_generation.partial_image') {
			const index = finiteNonNegativeInteger(parsed.partial_image_index);
			if (index == null || typeof parsed.b64_json !== 'string' || !/\S/.test(parsed.b64_json)) {
				failAndStop('Image generation stream contained an invalid partial image event');
				return;
			}
			observedImageOutput = true;
			output.push(sseFrame({
				type: 'image_generation.partial_image',
				partial_image_index: index,
				b64_json: parsed.b64_json,
			}));
			return;
		}

		if (parsed.type === 'image_generation.completed') {
			if (typeof parsed.b64_json !== 'string' || !/\S/.test(parsed.b64_json)) {
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
				try { imageUsage = parseImageUsageFromAnyShape({ usage: normalizedUsage }); }
				catch (error) {
					if (!(error instanceof ImageUsageLimitError)) throw error;
					upstreamOutcomeUnknown = true;
					failAndStop(error.message, 'image_usage_too_large');
					return;
				}
			}
			const ticks = upstreamSupplierCostTicks(parsed);
			if (ticks != null) supplierCostTicks = ticks;
			observedImageOutput = true;
			output.push(sseFrame(completed));
			return;
		}

		if (parsed.type === 'error') {
			const upstreamError = isRecord(parsed.error) ? parsed.error : {};
			const message = typeof upstreamError.message === 'string'
				? upstreamError.message
				: 'Image generation stream failed';
			// A well-formed provider error before any image output is an explicit
			// failure, not a local loss of outcome. Omission is not a retry promise.
			const explicitFailure = typeof upstreamError.message === 'string' && upstreamError.message.trim() !== '';
			failAndStop(message, safeImageStreamErrorCode(upstreamError.code), observedImageOutput || !explicitFailure);
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

	const onAbort = (): void => {
		const abortReason = lifecycle.getAbortReason();
		// Protocol errors also abort the upstream; their already-queued error +
		// DONE must still be delivered. Only deadline/client abort owns this path.
		if (downstreamClosed || settled || abortReason === 'none') return;
		downstreamClosed = true;
		sourceEnded = true;
		stopSource = true;
		output.length = 0;
		buffer = '';
		cancelled = abortReason === 'client_abort';
		failed = true;
		errorMessage = cancelled
			? 'Image generation was cancelled by the client'
			: 'Image generation timed out waiting for the upstream stream';
		cancelUpstreamReader(abortReason);
		// Settle even if downstream never pulls again. This is an error/cancel,
		// never proof of a completed image delivered to the buyer.
		settle(abortReason);
		// Backpressure may leave error/DONE in the native stream queue while the
		// caller is idle. Never append another terminal sequence after those bytes.
		// This tracks enqueue, not client receipt; settlement policy is unchanged.
		if (!cancelled && !doneEnqueued) {
			if (!errorEnqueued) {
				streamController.enqueue(errorFrame(errorMessage));
				errorEnqueued = true;
			}
			streamController.enqueue(SSE_DONE_FRAME);
			doneEnqueued = true;
		}
		streamController.close();
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
			lifecycle.signal.addEventListener('abort', onAbort, { once: true });
			if (lifecycle.signal.aborted) onAbort();
		},
		async pull(controller): Promise<void> {
			if (downstreamClosed) return;
			while (output.length === 0 && !sourceEnded) {
				if (stopSource) {
					cancelUpstreamReader('image_stream_terminal');
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
					const next = await lifecycle.wait(() => reader.read());
					if (downstreamClosed) return;
					if (next.done) {
						finishAtEof();
						break;
					}
					buffer += decoder.decode(next.value, { stream: true });
				} catch {
					if (downstreamClosed) return;
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
			if (chunk) {
				controller.enqueue(chunk);
				if (chunk === queuedErrorFrame) errorEnqueued = true;
				if (chunk === SSE_DONE_FRAME) doneEnqueued = true;
			}
			else if (sourceEnded) {
				downstreamClosed = true;
				settle(terminalAbortReason);
				releaseReader();
				controller.close();
			}
		},
		cancel(reason): void {
			downstreamClosed = true;
			sourceEnded = true;
			output.length = 0;
			buffer = '';
			cancelled = true;
			errorMessage = 'Image generation was cancelled by the client';
			lifecycle.abortUpstream('client_abort');
			settle('client_abort');
			cancelUpstreamReader(reason);
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
	timing?: RequestTimingCollector | null,
	signal?: AbortSignal,
): Promise<{ body: unknown; jsonValid: boolean }> {
	// Audit serialization is separately capped at 64 KiB; it no longer needs
	// an uncompressed-page exception for the whole upstream usage subtree.
	const material = await segmentedJsonResponseWithinLimit(response, maxBytes, IMAGE_JSON_ADMISSION_LIMITS, signal, {
		retainStringPages: true,
	});
	timing?.markStreamComplete();
	return material;
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
	beforeFetch?: (prepared: PreparedImageAttempt) => Promise<void>,
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
		admissionDeniedPreDispatch?: boolean;
		gatewayGeneratedError?: boolean;
	};
}> {
	const url = resolveUpstreamEndpoint('openai', 'images.generations', route.providerEndpoints, {
		providerId: route.providerId,
	});
	validateImageUpstreamUrl(url);
	const attemptRouteFacts = captureImageAttemptRouteFacts(route, 'images.generations', url);
	const upstreamLabel = sanitizeUpstreamUrlForLog(url);
	// 与 chat/messages 一致：每条 failover 路由合并各自 custom_params，用户字段优先
	const requestBody = buildImageGenerationUpstreamBody(route, body);
	const streamRequested = body.stream === true;
	const requestedCount = typeof body.n === 'number' && Number.isSafeInteger(body.n) ? body.n : 1;
	console.log(JSON.stringify({
		event: 'gateway.images.upstream_start',
		operation: 'generations',
		upstream: upstreamLabel,
		providerId: route.providerId,
		routeTargetId: route.targetId,
		providerModel: route.providerModelName,
	}));
	const startedAt = Date.now();
	const { signal, clear, getAbortReason, abortUpstream, wait, checkActive } = withTimeoutSignal(
		requestSignal,
		IMAGE_GENERATION_TIMEOUT_MS,
		options.deadlineAtMs,
	);
	const responseByteLimit = resolveResponseByteLimit(
		options.maxResponseBytes,
		IMAGE_MAX_RESPONSE_BYTES,
	);
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	let observedUpstreamRequestId: string | null = null;
	let streamOwnsLifecycle = false;
	let admissionBoundaryFailed = false;
	let uploadBody: ReturnType<typeof createJsonUploadBody> | undefined;
	const finishOwned = () => { uploadBody?.dispose(); uploadBody = undefined; clear(); };
	try {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey, {
			signal, auxiliaryAuth: options.auxiliaryAuth,
		});
		uploadBody = createJsonUploadBody(requestBody, signal, checkActive);
		const preparedAttempt = createPreparedImageGenerationAttempt(attemptRouteFacts, uploadBody.preparedSnapshot);
		const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` });
		headers.set('Content-Length', String(uploadBody.contentLength));
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		try { await beforeFetch?.(preparedAttempt); } catch (error) { admissionBoundaryFailed = true; throw error; }
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const response = await wait(() => {
			dispatchStarted = true;
			const init = { method: 'POST', headers, body: uploadBody!.body, signal, redirect: 'manual' as const, duplex: 'half' };
			return (options.fetchImpl ?? fetch)(url, init);
		}, (late) => { void late.body?.cancel('image_request_stopped').catch(() => undefined); });
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		observedUpstreamRequestId = upstreamRequestId;
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
		if (streamRequested && response.ok) {
			if (!contentType.includes('text/event-stream')) {
				void response.body?.cancel('image_stream_content_type_mismatch').catch(() => undefined);
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
			const stream = validatedImageSse(
				response,
				requestedCount,
				options.requireAuthoritativeUsage === true,
				{ signal, wait, clear: finishOwned, getAbortReason, abortUpstream },
				timing,
				options.requestId,
			);
			streamOwnsLifecycle = true;
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
		const material = await readJsonResponse(response, responseByteLimit, timing, signal);
		// Early response headers may race a duplex upload. Stop any residual
		// encoder only after the response is fully read, not at header arrival.
		uploadBody.dispose(); uploadBody = undefined;
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
		const { usagePromise, imageUsage } = usageFromStreamFromImage(normalizedBody, checkActive);
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
		const clientResponse = streamJsonResponse(normalizedBody, NORMALIZED_IMAGE_JSON_LIMITS, {
			status: response.status, statusText: response.statusText,
			headers: { 'Content-Type': 'application/json' },
		}, { signal, checkActive, onFinished: clear });
		streamOwnsLifecycle = true;
		return {
			response: clientResponse,
			usagePromise,
			upstreamRequestId,
			meta: imageDispatchMeta(normalizedBody, imageUsage, undefined, {
				upstreamOutcomeUnknown:
					imageStatusMayHideAcceptedWork(response.status)
					|| (response.ok && (!material.jsonValid || countValidImageResults(normalizedBody) === 0)),
			}),
		};
	} catch (err) {
		// Preserve local stop/control errors so the dispatcher cannot replay a
		// failed durable admission or reset the request-wide authentication budget.
		if (admissionBoundaryFailed || err instanceof RequestAuxiliaryAuthLimitError) throw err;
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
		const upstreamOutcomeUnknown = dispatchStarted
			&& (!explicitNonOk || imageStatusMayHideAcceptedWork(upstreamStatus!));
		// This driver returns errors as responses, so the dispatcher's
		// thrown-error path cannot record this attempt. Do not invent pre-send
		// I/O or overwrite a supplier's already observed explicit rejection.
		if (dispatchStarted && !explicitNonOk && imageAbortReason === 'client_abort') {
			timing?.markAttemptClientCancelled(attempt);
		} else if (dispatchStarted && upstreamStatus === null) {
			// No HTTP status was observed. Record the actual transport/deadline
			// failure so durable settlement can match the claimed dispatch.
			timing?.markAttemptError(attempt, err);
		}
		const responseBodyTooLarge =
			err instanceof UpstreamResponseBodyTooLargeError && upstreamOutcomeUnknown;
		const error = aborted
			? imageAbortErrorPayload('generation', resolvedAbort, IMAGE_GENERATION_TIMEOUT_MS)
			: {
					message: err instanceof ImageUsageLimitError || err instanceof JsonStructureLimitError ? err.message : 'Image generation upstream failed',
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
		const gatewayAbort = !explicitNonOk && imageAbortReason != null;
		return {
			response: gatewayAbort ? imageAbortResponse(imageAbortReason, error.message) : new Response(JSON.stringify(errorBody), {
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
				...(!dispatchStarted ? { admissionDeniedPreDispatch: true } : {}),
				...(gatewayAbort ? { gatewayGeneratedError: true } : {}),
			},
		};
	} finally {
		if (!streamOwnsLifecycle) finishOwned();
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
	beforeFetch?: (prepared: PreparedImageAttempt) => Promise<void>,
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
		admissionDeniedPreDispatch?: boolean;
		gatewayGeneratedError?: boolean;
	};
}> {
	const url = resolveUpstreamEndpoint('openai', 'images.edits', route.providerEndpoints, {
		providerId: route.providerId,
	});
	validateImageUpstreamUrl(url);
	const attemptRouteFacts = captureImageAttemptRouteFacts(route, 'images.edits', url);
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
	// The digest and driver share the exact scalar-field projection.
	const fields = buildImageEditUpstreamFields(route, edit);
	for (const [key, value] of fields) form.append(key, value);
	const pagedUpload = edit.images.some(img => img.upload !== undefined);
	const files = edit.images.map(img => ({
		...imageEditUpstreamFileMetadata(img),
		payload: img.upload ?? img.blob ?? new Blob(img.bytes ? [img.bytes] : [], { type: img.mimeType }),
	}));
	for (const file of pagedUpload ? [] : files) {
		// Legacy internal callers only. Public multipart uploads use request-owned
		// pages; a Blob constructed from a Uint8Array would copy the full file.
		if (file.payload instanceof Blob) form.append('image', file.payload, file.filename);
		else throw new TypeError('Unexpected paged image upload');
	}
	const preparedAttempt = createPreparedImageEditAttempt(attemptRouteFacts, fields, files);

	const startedAt = Date.now();
	const { signal, clear, getAbortReason, wait, checkActive } = withTimeoutSignal(
		requestSignal,
		IMAGE_GENERATION_TIMEOUT_MS,
		options.deadlineAtMs,
	);
	let uploadBody: ReturnType<typeof createMultipartUploadBody> | undefined;
	let streamOwnsLifecycle = false;
	let uploadFinished = false, accepted = false, uploadReleased = false;
	const releaseAcceptedUpload = () => {
		if (!accepted || !uploadFinished || uploadReleased) return;
		uploadReleased = true;
		edit.releaseAcceptedUpload?.();
	};
	const responseByteLimit = resolveResponseByteLimit(
		options.maxResponseBytes,
		IMAGE_MAX_RESPONSE_BYTES,
	);
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	let observedUpstreamRequestId: string | null = null;
	let admissionBoundaryFailed = false;
	try {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey, {
			signal, auxiliaryAuth: options.auxiliaryAuth,
		});
		const headers = new Headers({ Authorization: `Bearer ${secret}` });
		if (pagedUpload) {
			uploadBody = createMultipartUploadBody(form, files, signal,
				() => { uploadFinished = true; releaseAcceptedUpload(); });
			headers.set('Content-Type', uploadBody.contentType);
			headers.set('Content-Length', String(uploadBody.contentLength));
		}
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		try { await beforeFetch?.(preparedAttempt); } catch (error) { admissionBoundaryFailed = true; throw error; }
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const response = await wait(() => {
			dispatchStarted = true;
			const init = { method: 'POST', headers, body: uploadBody?.body ?? form, signal, redirect: 'manual' as const, duplex: 'half' };
			return (options.fetchImpl ?? fetch)(url, init);
		}, (late) => { void late.body?.cancel('image_request_stopped').catch(() => undefined); });
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		observedUpstreamRequestId = upstreamRequestId;
		// A 2xx is terminal for replay even if its later body is malformed or lost.
		// An early response may race duplex upload; release only after both facts.
		accepted = response.ok;
		releaseAcceptedUpload();
		const material = await readJsonResponse(response, responseByteLimit, timing, signal);
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
		const { usagePromise, imageUsage } = usageFromStreamFromImage(normalizedBody, checkActive);
		const clientResponse = streamJsonResponse(normalizedBody, NORMALIZED_IMAGE_JSON_LIMITS, {
			status: response.status, statusText: response.statusText,
			headers: { 'Content-Type': 'application/json' },
		}, { signal, checkActive, onFinished: clear });
		streamOwnsLifecycle = true;
		return {
			response: clientResponse,
			usagePromise,
			upstreamRequestId,
			meta: imageDispatchMeta(normalizedBody, imageUsage, undefined, {
				upstreamOutcomeUnknown:
					imageStatusMayHideAcceptedWork(response.status)
					|| (response.ok && (!material.jsonValid || countValidImageResults(normalizedBody) === 0)),
			}),
		};
	} catch (err) {
		if (admissionBoundaryFailed || err instanceof RequestAuxiliaryAuthLimitError) throw err;
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
		const upstreamOutcomeUnknown = dispatchStarted
			&& (!explicitNonOk || imageStatusMayHideAcceptedWork(upstreamStatus!));
		if (dispatchStarted && !explicitNonOk && imageAbortReason === 'client_abort') {
			timing?.markAttemptClientCancelled(attempt);
		} else if (dispatchStarted && upstreamStatus === null) {
			timing?.markAttemptError(attempt, err);
		}
		const responseBodyTooLarge =
			err instanceof UpstreamResponseBodyTooLargeError && upstreamOutcomeUnknown;
		const error = aborted
			? imageAbortErrorPayload('edit', resolvedAbort, IMAGE_GENERATION_TIMEOUT_MS)
			: {
					message: err instanceof ImageUsageLimitError || err instanceof JsonStructureLimitError ? err.message : 'Image edit upstream failed',
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
		const gatewayAbort = !explicitNonOk && imageAbortReason != null;
		return {
			response: gatewayAbort ? imageAbortResponse(imageAbortReason, error.message) : new Response(JSON.stringify(errorBody), {
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
				...(!dispatchStarted ? { admissionDeniedPreDispatch: true } : {}),
				...(gatewayAbort ? { gatewayGeneratedError: true } : {}),
			},
		};
	} finally {
		uploadBody?.dispose();
		if (!streamOwnsLifecycle) clear();
	}
}
