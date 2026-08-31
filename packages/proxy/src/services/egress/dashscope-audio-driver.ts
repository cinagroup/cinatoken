/**
 * DashScope 原生文件 ASR adapter：
 * - 同步 Qwen3-ASR：多模态接口，`content.audio` + `asr_options`；
 * - 同步 Qwen-Audio-3.0：同一端点，官方 `input_audio` + `format` / `language_hints`；
 * - 同步 Fun-ASR-Realtime：同一多模态端点，但请求参数与响应结构独立；
 * - 异步 Qwen-Audio-3.0-ASR-Flash-Filetrans/Fun-ASR：提交公网 file_urls，轮询 task，再读取结果 JSON。
 */
import { resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import { fetchWithSafeRedirects } from '@octafuse/tool-engines/web-fetch';
import type { RouteResult } from '../model-router';
import { EMPTY_USAGE, type UsageFromStream } from '../proxy';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { GatewayErrorCode } from '../gateway-error-codes';
import { gatewayErrorResponse } from '../gateway-error-response';
import {
	AUDIO_TRANSCRIPTION_TIMEOUT_MS,
	buildAudioTranscriptionClientResponse,
	extensionFromAudioMime,
	resolveAudioProviderOptionsForRoute,
	reshapeTranscriptionForClient,
	type AudioUpload,
	type NormalizedAudioTranscriptionRequest,
} from './openai-audio-driver';
import { resolveAudioBillingDuration, type AudioDurationSource } from './audio-duration';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';

/** 官方同步接口的 Base64 Data URL 请求上限为 10MB。 */
export const DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
export const DASHSCOPE_ASYNC_POLL_INTERVAL_MS = 1_000;
/** Native multimodal JSON is always bounded, even for non-2xx provider errors. */
export const DASHSCOPE_MULTIMODAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DashScopeAsrDispatchOptions = {
	fetchImpl?: FetchLike;
	pollIntervalMs?: number;
	timeoutMs?: number;
	/** Called after request construction/secret resolution and immediately before the first network write. */
	beforeUpstreamDispatch?: () => Promise<void>;
	/** Optional hard cap used before buffering a native multimodal JSON response. */
	maxResponseBytes?: number;
};

type DashScopeAudioDispatchResult = {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	meta: {
		parsedBody: unknown;
		audioDurationSeconds: number | null;
		audioDurationSource: AudioDurationSource | null;
		audioFileBytes: number;
		audioTokenUsage: null;
		upstreamOutcomeUnknown?: boolean;
		responseBodyTooLarge?: boolean;
		failoverForbidden?: boolean;
	};
};

function asObject(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
	const number = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Worker 与 Node 共用的无 Buffer Base64 编码。 */
export function audioUploadToDataUrl(file: AudioUpload): string {
	const prefix = `data:${file.mimeType || 'application/octet-stream'};base64,`;
	const encodedLength = Math.ceil(file.bytes.byteLength / 3) * 4;
	if (prefix.length + encodedLength > DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES) {
		throw new Error(
			`DashScope synchronous ASR Data URL must be at most ${DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES} bytes`,
		);
	}
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < file.bytes.byteLength; offset += chunkSize) {
		const chunk = file.bytes.subarray(offset, Math.min(offset + chunkSize, file.bytes.byteLength));
		binary += String.fromCharCode(...chunk);
	}
	return `${prefix}${btoa(binary)}`;
}

function normalizedAsrOptions(route: RouteResult, req: NormalizedAudioTranscriptionRequest): Record<string, unknown> {
	const configured = route.customParams?.asr_options;
	if (configured != null && asObject(configured) == null) {
		throw new Error('DashScope route custom_params.asr_options must be an object');
	}
	return {
		...(asObject(configured) ?? {}),
		...(req.language ? { language: req.language } : {}),
	};
}

/** 构造 Qwen-ASR DashScope 同步多模态请求。 */
export function buildDashScopeSyncAsrBody(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
): Record<string, unknown> {
	if (!req.file) throw new Error('DashScope synchronous ASR requires a multipart file');
	const messages: Array<Record<string, unknown>> = [];
	if (req.prompt) {
		messages.push({ role: 'system', content: [{ text: req.prompt }] });
	}
	messages.push({
		role: 'user',
		content: [{ audio: audioUploadToDataUrl(req.file) }],
	});
	return {
		model: route.providerModelName,
		input: { messages },
		parameters: {
			...(route.customParams ?? {}),
			asr_options: normalizedAsrOptions(route, req),
		},
	};
}

const QWEN_AUDIO_ASR_FILE_FORMATS = new Set([
	'aac',
	'amr',
	'avi',
	'flac',
	'flv',
	'm4a',
	'mkv',
	'mov',
	'mp3',
	'mp4',
	'mpeg',
	'ogg',
	'opus',
	'wav',
	'webm',
	'wma',
	'wmv',
]);

/** Qwen-Audio-3.0 / Fun-ASR 同步 HTTP 都要求与音频内容一致的 format。 */
export function resolveDashScopeAudioFileFormat(
	file: AudioUpload,
	label: string,
	allowed: ReadonlySet<string> = QWEN_AUDIO_ASR_FILE_FORMATS,
): string {
	const mimeFormat = extensionFromAudioMime(file.mimeType);
	if (allowed.has(mimeFormat)) return mimeFormat;
	const filenameFormat = file.filename.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? '';
	if (allowed.has(filenameFormat)) return filenameFormat;
	throw new Error(
		`DashScope ${label} file format cannot be derived from MIME ${JSON.stringify(
			file.mimeType,
		)} and filename ${JSON.stringify(file.filename)}`,
	);
}

function normalizedLanguageHints(language: string | undefined): string[] | undefined {
	const hint = language?.trim();
	if (!hint) return undefined;
	return [hint].slice(0, 4);
}

/** 构造 Qwen-Audio-3.0 同步非实时 ASR 请求（官方 `input_audio` + 必填 `format`）。 */
export function buildDashScopeQwenAudioAsrBody(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
): Record<string, unknown> {
	if (!req.file) throw new Error('DashScope synchronous ASR requires a multipart file');
	const content: Array<Record<string, unknown>> = [];
	if (req.prompt) {
		content.push({ type: 'input_text', text: req.prompt });
	}
	content.push({
		type: 'input_audio',
		input_audio: { data: audioUploadToDataUrl(req.file) },
	});
	const parameters: Record<string, unknown> = {
		...(route.customParams ?? {}),
		format: resolveDashScopeAudioFileFormat(req.file, 'Qwen-Audio ASR'),
	};
	const languageHints = normalizedLanguageHints(req.language);
	if (languageHints) parameters.language_hints = languageHints;
	return {
		model: route.providerModelName,
		input: {
			messages: [{ role: 'user', content }],
		},
		parameters,
	};
}

const FUN_ASR_FILE_FORMATS = new Set([
	'aac',
	'amr',
	'avi',
	'flac',
	'flv',
	'm4a',
	'mkv',
	'mov',
	'mp3',
	'mp4',
	'mpeg',
	'ogg',
	'opus',
	'wav',
	'webm',
	'wma',
	'wmv',
]);

/** Fun-ASR-Realtime 的 HTTP 文件接口强制要求与音频内容一致的 format。 */
export function resolveDashScopeFunAsrFormat(file: AudioUpload): string {
	return resolveDashScopeAudioFileFormat(file, 'Fun-ASR', FUN_ASR_FILE_FORMATS);
}

/** 构造 Fun-ASR-Realtime 非实时 Base64 请求；禁止悄悄丢弃 OpenAI 可选字段。 */
export function buildDashScopeFunAsrBody(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
): Record<string, unknown> {
	if (!req.file) throw new Error('DashScope synchronous ASR requires a multipart file');
	if (req.language) {
		throw new Error('DashScope Fun-ASR file API does not support the OpenAI language field');
	}
	if (req.prompt) {
		throw new Error('DashScope Fun-ASR file API does not support the OpenAI prompt field');
	}
	return {
		model: route.providerModelName,
		input: {
			messages: [
				{
					role: 'user',
					content: [{ audio: audioUploadToDataUrl(req.file) }],
				},
			],
		},
		parameters: {
			...(route.customParams ?? {}),
			format: resolveDashScopeFunAsrFormat(req.file),
		},
		resources: [],
	};
}

/**
 * 构造 DashScope 异步文件识别提交请求。
 * 官方 filetrans 契约：`input.file_urls` + `parameters.language_hints`（可选 context / 其它自定义参数）。
 */
export function buildDashScopeAsyncAsrBody(
	route: RouteResult,
	fileUrl: string,
	req: NormalizedAudioTranscriptionRequest,
): Record<string, unknown> {
	const parameters = { ...(route.customParams ?? {}) };
	delete parameters.asr_options;
	return {
		model: route.providerModelName,
		input: {
			file_urls: [fileUrl],
			...(req.prompt
				? {
						context: [
							{
								role: 'user',
								content: [{ type: 'input_text', text: req.prompt }],
							},
						],
				  }
				: {}),
		},
		parameters: {
			...parameters,
			...(req.language ? { language_hints: [req.language] } : {}),
		},
	};
}

function firstArrayObject(value: unknown): Record<string, unknown> | null {
	return Array.isArray(value) ? asObject(value[0]) : null;
}

/** DashScope 同步结果 → OpenAI transcription 中间形状。 */
export function normalizeDashScopeSyncAsrResult(body: unknown): Record<string, unknown> {
	const root = asObject(body);
	const output = asObject(root?.output);
	const choice = firstArrayObject(output?.choices);
	const message = asObject(choice?.message);
	const content = firstArrayObject(message?.content);
	const text = typeof content?.text === 'string' ? content.text : '';
	const annotations = Array.isArray(message?.annotations) ? message.annotations : [];
	const annotation = asObject(annotations[0]);
	const seconds = asFiniteNonNegativeNumber(asObject(root?.usage)?.seconds);
	return {
		text,
		...(seconds != null ? { duration: seconds } : {}),
		...(typeof annotation?.language === 'string' ? { language: annotation.language } : {}),
		...(typeof annotation?.emotion === 'string' ? { emotion: annotation.emotion } : {}),
		usage: seconds == null ? root?.usage ?? null : { type: 'duration', seconds },
		dashscope: body,
	};
}

/** Qwen-Audio-3.0 / Fun-ASR 同步结果共用 `output.text` 与 `usage.duration`。 */
function normalizeDashScopeDurationAsrResult(body: unknown): Record<string, unknown> {
	const root = asObject(body);
	const output = asObject(root?.output);
	const sentence = asObject(output?.sentence);
	const text = typeof output?.text === 'string' ? output.text : typeof sentence?.text === 'string' ? sentence.text : '';
	const seconds = asFiniteNonNegativeNumber(asObject(root?.usage)?.duration);
	const beginMs = asFiniteNonNegativeNumber(sentence?.begin_time);
	const endMs = asFiniteNonNegativeNumber(sentence?.end_time);
	const segments = sentence
		? [
				{
					id: sentence.sentence_id ?? 0,
					start: (beginMs ?? 0) / 1_000,
					end: (endMs ?? beginMs ?? 0) / 1_000,
					text: typeof sentence.text === 'string' ? sentence.text : text,
					channel: sentence.channel_id ?? 0,
					...(Array.isArray(sentence.words) ? { words: sentence.words } : {}),
				},
		  ]
		: [];
	return {
		text,
		...(seconds != null ? { duration: seconds } : {}),
		segments,
		usage: seconds == null ? root?.usage ?? null : { type: 'duration', seconds },
		dashscope: body,
	};
}

/** Qwen-Audio-3.0 同步结果 → OpenAI transcription 中间形状。 */
export function normalizeDashScopeQwenAudioAsrResult(body: unknown): Record<string, unknown> {
	return normalizeDashScopeDurationAsrResult(body);
}

/** Fun-ASR-Realtime 非实时结果 → OpenAI transcription 中间形状。 */
export function normalizeDashScopeFunAsrResult(body: unknown): Record<string, unknown> {
	return normalizeDashScopeDurationAsrResult(body);
}

/** DashScope 异步结果文件 → OpenAI verbose transcription 中间形状。 */
export function normalizeDashScopeAsyncAsrResult(resultFile: unknown, taskBody: unknown): Record<string, unknown> {
	const result = asObject(resultFile);
	const transcripts = Array.isArray(result?.transcripts) ? result.transcripts : [];
	const texts: string[] = [];
	const segments: Array<Record<string, unknown>> = [];
	let language: string | null = null;
	for (const transcriptRaw of transcripts) {
		const transcript = asObject(transcriptRaw);
		if (!transcript) continue;
		if (typeof transcript.text === 'string' && transcript.text.trim()) {
			texts.push(transcript.text.trim());
		}
		const sentences = Array.isArray(transcript.sentences) ? transcript.sentences : [];
		for (const sentenceRaw of sentences) {
			const sentence = asObject(sentenceRaw);
			if (!sentence) continue;
			if (!language && typeof sentence.language === 'string') language = sentence.language;
			segments.push({
				id: sentence.sentence_id ?? segments.length,
				start: (asFiniteNonNegativeNumber(sentence.begin_time) ?? 0) / 1_000,
				end: (asFiniteNonNegativeNumber(sentence.end_time) ?? 0) / 1_000,
				text: typeof sentence.text === 'string' ? sentence.text : '',
				channel: transcript.channel_id ?? 0,
				...(typeof sentence.emotion === 'string' ? { emotion: sentence.emotion } : {}),
			});
		}
	}
	const task = asObject(taskBody);
	const usage = asObject(task?.usage);
	const seconds =
		asFiniteNonNegativeNumber(usage?.seconds) ?? asFiniteNonNegativeNumber(usage?.duration);
	return {
		text: texts.join('\n'),
		...(seconds != null ? { duration: seconds } : {}),
		...(language ? { language } : {}),
		segments,
		usage: seconds == null ? null : { type: 'duration', seconds },
		dashscope: { task: taskBody, result: resultFile },
	};
}

class DashScopeResponseBodyTooLargeError extends Error {
	constructor(readonly upstreamStatus: number) {
		super('DashScope response body exceeds the configured limit');
		this.name = 'DashScopeResponseBodyTooLargeError';
	}
}

async function responseTextWithinLimit(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel('dashscope_response_too_large').catch(() => undefined);
		throw new DashScopeResponseBodyTooLargeError(response.status);
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel('dashscope_response_too_large').catch(() => undefined);
				throw new DashScopeResponseBodyTooLargeError(response.status);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function parseJsonResponse(response: Response, maxBytes?: number): Promise<unknown> {
	const text = maxBytes == null ? await response.text() : await responseTextWithinLimit(response, maxBytes);
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return {
			error: { message: text.slice(0, 500) || 'Invalid upstream JSON' },
		};
	}
}

function resolveDashScopeResponseLimit(options: DashScopeAsrDispatchOptions): number {
	return typeof options.maxResponseBytes === 'number'
		&& Number.isFinite(options.maxResponseBytes)
		&& options.maxResponseBytes > 0
		? Math.min(DASHSCOPE_MULTIMODAL_MAX_RESPONSE_BYTES, Math.floor(options.maxResponseBytes))
		: DASHSCOPE_MULTIMODAL_MAX_RESPONSE_BYTES;
}

function bodyRequestId(body: unknown): string | null {
	return normalizeUpstreamId(asObject(body)?.request_id);
}

function clientResult(
	req: NormalizedAudioTranscriptionRequest,
	upstreamResponse: Response,
	parsedBody: unknown,
	fileBytes: number,
	duration: { seconds: number; source: AudioDurationSource } | null,
	requestId: string | null,
	metaOverrides: Pick<
		DashScopeAudioDispatchResult['meta'],
		'upstreamOutcomeUnknown' | 'responseBodyTooLarge' | 'failoverForbidden'
	> = {},
): DashScopeAudioDispatchResult {
	const clientBody = upstreamResponse.ok
		? reshapeTranscriptionForClient(parsedBody, req.clientResponseFormat)
		: parsedBody;
	return {
		response: buildAudioTranscriptionClientResponse(
			req.clientResponseFormat,
			clientBody,
			upstreamResponse.status,
			upstreamResponse.statusText,
		),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId: requestId,
		meta: {
			parsedBody,
			audioDurationSeconds: duration?.seconds ?? null,
			audioDurationSource: duration?.source ?? null,
			audioFileBytes: fileBytes,
			audioTokenUsage: null,
			...metaOverrides,
		},
	};
}

function resolveDashScopeDuration(
	req: NormalizedAudioTranscriptionRequest,
	upstreamSeconds: number | null,
): { seconds: number; source: AudioDurationSource } {
	return resolveAudioBillingDuration({
		upstreamSeconds,
		fileBytes: req.file?.bytes.byteLength ?? 0,
		mimeType: req.file?.mimeType ?? 'application/octet-stream',
		fileBytesForParse: req.file?.bytes,
		clientSeconds: req.clientDurationSeconds,
	});
}

function withTimeout(
	requestSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; clear: () => void; timedOut: () => boolean } {
	const controller = new AbortController();
	let timeoutReached = false;
	const onAbort = () => controller.abort();
	requestSignal?.addEventListener('abort', onAbort, { once: true });
	if (requestSignal?.aborted) onAbort();
	const timer = setTimeout(() => {
		timeoutReached = true;
		controller.abort();
	}, timeoutMs);
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			requestSignal?.removeEventListener('abort', onAbort);
		},
		timedOut: () => timeoutReached,
	};
}

function errorDispatchResult(
	req: NormalizedAudioTranscriptionRequest,
	status: number,
	message: string,
	metaOverrides: Pick<
		DashScopeAudioDispatchResult['meta'],
		'upstreamOutcomeUnknown' | 'responseBodyTooLarge' | 'failoverForbidden'
	> = {},
): DashScopeAudioDispatchResult {
	const body = { error: { message } };
	return clientResult(
		req,
		new Response(null, { status }),
		body,
		req.file?.bytes.byteLength ?? 0,
		null,
		null,
		metaOverrides,
	);
}

type DashScopeSyncAsrFamily = 'qwen3' | 'qwen-audio' | 'fun';

function syncAsrFamily(adapter: string): DashScopeSyncAsrFamily | null {
	if (adapter === 'dashscope-asr-qwen-file') return 'qwen3';
	if (adapter === 'dashscope-asr-qwen-audio-file') return 'qwen-audio';
	if (adapter === 'dashscope-asr-fun-file') return 'fun';
	return null;
}

function buildSyncAsrBody(
	family: DashScopeSyncAsrFamily,
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
): Record<string, unknown> {
	if (family === 'qwen-audio') return buildDashScopeQwenAudioAsrBody(route, req);
	if (family === 'fun') return buildDashScopeFunAsrBody(route, req);
	return buildDashScopeSyncAsrBody(route, req);
}

function normalizeSyncAsrResult(family: DashScopeSyncAsrFamily, body: unknown): Record<string, unknown> {
	if (family === 'qwen-audio') return normalizeDashScopeQwenAudioAsrResult(body);
	if (family === 'fun') return normalizeDashScopeFunAsrResult(body);
	return normalizeDashScopeSyncAsrResult(body);
}

function isUsableSyncAsrResult(family: DashScopeSyncAsrFamily, body: unknown): boolean {
	const output = asObject(asObject(body)?.output);
	if (!output) return false;
	if (family !== 'qwen3') {
		return typeof output.text === 'string' || typeof asObject(output.sentence)?.text === 'string';
	}
	const choice = firstArrayObject(output.choices);
	const message = asObject(choice?.message);
	const content = firstArrayObject(message?.content);
	return typeof content?.text === 'string';
}

function invalidSuccessfulResult(
	req: NormalizedAudioTranscriptionRequest,
	requestId: string | null,
	fileBytes: number,
): DashScopeAudioDispatchResult {
	return {
		response: gatewayErrorResponse({
			status: 502,
			code: GatewayErrorCode.upstreamRequestFailed,
			message: 'Audio transcription upstream returned an invalid response',
		}),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId: requestId,
		meta: {
			parsedBody: null,
			audioDurationSeconds: null,
			audioDurationSource: null,
			audioFileBytes: fileBytes,
			audioTokenUsage: null,
			upstreamOutcomeUnknown: true,
			failoverForbidden: true,
		},
	};
}

/** 按显式 adapter 分发 Qwen3 / Qwen-Audio-3.0 / Fun-ASR 的同步文件调用。 */
export async function dispatchDashScopeSyncAsr(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: DashScopeAsrDispatchOptions = {},
): Promise<DashScopeAudioDispatchResult> {
	if (!req.file) throw new Error('DashScope synchronous ASR requires a multipart file');
	const family = syncAsrFamily(route.adapter);
	if (!family) {
		throw new Error(`Unsupported DashScope synchronous ASR adapter: ${route.adapter}`);
	}
	if (Object.keys(resolveAudioProviderOptionsForRoute(req, route)).length > 0) {
		return errorDispatchResult(
			req,
			400,
			`provider.options for ${route.providerName} cannot be safely mapped to this DashScope ASR adapter`,
		);
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = resolveUpstreamEndpoint('dashscope', 'audio.transcriptions.multimodal', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const timeout = withTimeout(requestSignal, options.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS);
	const responseByteLimit = resolveDashScopeResponseLimit(options);
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	try {
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		dispatchStarted = true;
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
				...(family !== 'qwen3' ? { 'X-DashScope-SSE': 'disable' } : {}),
			},
			body: JSON.stringify(buildSyncAsrBody(family, route, req)),
			signal: timeout.signal,
		});
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const headerRequestId = extractUpstreamRequestId(response.headers);
		const upstreamBody = await parseJsonResponse(response, responseByteLimit);
		timing?.markStreamComplete();
		if (!response.ok) {
			return clientResult(
				req,
				response,
				upstreamBody,
				req.file.bytes.byteLength,
				null,
				headerRequestId ?? bodyRequestId(upstreamBody),
			);
		}
		const requestId = headerRequestId ?? bodyRequestId(upstreamBody);
		if (!isUsableSyncAsrResult(family, upstreamBody)) {
			return invalidSuccessfulResult(req, requestId, req.file.bytes.byteLength);
		}
		const normalized = normalizeSyncAsrResult(family, upstreamBody);
		const seconds = asFiniteNonNegativeNumber(asObject(normalized.usage)?.seconds);
		return clientResult(
			req,
			response,
			normalized,
			req.file.bytes.byteLength,
			resolveDashScopeDuration(req, seconds),
			requestId,
		);
	} catch (error) {
		timing?.markStreamComplete();
		const aborted = timeout.signal.aborted;
		const explicitNonOk = upstreamStatus != null && (upstreamStatus < 200 || upstreamStatus >= 300);
		const upstreamOutcomeUnknown = dispatchStarted && !explicitNonOk;
		return errorDispatchResult(
			req,
			explicitNonOk ? upstreamStatus! : aborted ? (timeout.timedOut() ? 504 : 499) : 502,
			aborted
				? timeout.timedOut()
					? 'DashScope synchronous ASR timed out'
					: 'DashScope synchronous ASR was cancelled by the client'
				: `DashScope synchronous ASR failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				...(upstreamOutcomeUnknown
					? { upstreamOutcomeUnknown: true, failoverForbidden: true }
					: {}),
				...(error instanceof DashScopeResponseBodyTooLargeError
					? { responseBodyTooLarge: true }
					: {}),
			},
		);
	} finally {
		timeout.clear();
	}
}

function taskOutput(body: unknown): Record<string, unknown> | null {
	return asObject(asObject(body)?.output);
}

async function waitForPoll(signal: AbortSignal, ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			reject(new DOMException('Aborted', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/** DashScope 异步文件任务：提交、轮询、下载结果后一次性返回 OpenAI transcription。 */
export async function dispatchDashScopeAsyncAsr(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: DashScopeAsrDispatchOptions = {},
): Promise<DashScopeAudioDispatchResult> {
	if (Object.keys(resolveAudioProviderOptionsForRoute(req, route)).length > 0) {
		return errorDispatchResult(
			req,
			400,
			`provider.options for ${route.providerName} cannot be safely mapped to this DashScope ASR adapter`,
		);
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeout = withTimeout(requestSignal, options.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS);
	const responseByteLimit = resolveDashScopeResponseLimit(options);
	let dispatchStarted = false;
	let submitAccepted = false;
	let upstreamStatus: number | null = null;
	try {
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const fileUrl = req.fileSourceUrl;
		if (!fileUrl) {
			throw new Error('DashScope asynchronous ASR requires a client-provided file_url');
		}
		const submitUrl = resolveUpstreamEndpoint('dashscope', 'audio.transcriptions', route.providerEndpoints, {
			providerId: route.providerId,
		});
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		dispatchStarted = true;
		const submitResponse = await fetchImpl(submitUrl, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
				'X-DashScope-Async': 'enable',
			},
			body: JSON.stringify(buildDashScopeAsyncAsrBody(route, fileUrl, req)),
			signal: timeout.signal,
		});
		upstreamStatus = submitResponse.status;
		timing?.markAttemptHeaders(attempt, submitResponse.status);
		if (submitResponse.ok) submitAccepted = true;
		const submitBody = await parseJsonResponse(submitResponse, responseByteLimit);
		const submitRequestId = extractUpstreamRequestId(submitResponse.headers) ?? bodyRequestId(submitBody);
		if (!submitResponse.ok) {
			timing?.markStreamComplete();
			return clientResult(req, submitResponse, submitBody, req.file?.bytes.byteLength ?? 0, null, submitRequestId);
		}
		const taskId = taskOutput(submitBody)?.task_id;
		if (typeof taskId !== 'string' || !taskId.trim()) {
			throw new Error('DashScope asynchronous ASR response has no task_id');
		}
		const queryUrl = resolveUpstreamEndpoint('dashscope', 'audio.transcriptions.tasks', route.providerEndpoints, {
			providerId: route.providerId,
			taskId,
		});
		for (;;) {
			await waitForPoll(timeout.signal, options.pollIntervalMs ?? DASHSCOPE_ASYNC_POLL_INTERVAL_MS);
			const queryResponse = await fetchImpl(queryUrl, {
				method: 'GET',
				headers: { Authorization: `Bearer ${secret}` },
				signal: timeout.signal,
			});
			const queryBody = await parseJsonResponse(queryResponse, responseByteLimit);
			const requestId = extractUpstreamRequestId(queryResponse.headers) ?? bodyRequestId(queryBody) ?? submitRequestId;
			if (!queryResponse.ok) {
				timing?.markStreamComplete();
				return clientResult(
					req,
					queryResponse,
					queryBody,
					req.file?.bytes.byteLength ?? 0,
					null,
					requestId,
					{ upstreamOutcomeUnknown: true, failoverForbidden: true },
				);
			}
			const output = taskOutput(queryBody);
			if (!output) {
				throw new Error('DashScope asynchronous ASR task response has no output');
			}
			const status = typeof output.task_status === 'string' ? output.task_status : '';
			if (status === 'PENDING' || status === 'RUNNING') continue;
			if (status !== 'SUCCEEDED') {
				timing?.markStreamComplete();
				return clientResult(
					req,
					new Response(null, { status: 502 }),
					{
						error: {
							message:
								typeof output.message === 'string'
									? output.message
									: `DashScope asynchronous ASR task ended with status ${status || 'UNKNOWN'}`,
							code: output.code ?? null,
						},
						dashscope: queryBody,
					},
					req.file?.bytes.byteLength ?? 0,
					null,
					requestId,
				);
			}
			const results = output.results;
			const result = Array.isArray(results) ? asObject(results[0]) : null;
			if (!result) {
				throw new Error('DashScope asynchronous ASR task response has no results');
			}
			const subtaskStatus = typeof result.subtask_status === 'string' ? result.subtask_status : '';
			if (subtaskStatus && subtaskStatus !== 'SUCCEEDED') {
				timing?.markStreamComplete();
				return clientResult(
					req,
					new Response(null, { status: 502 }),
					{
						error: {
							message:
								typeof result.message === 'string'
									? result.message
									: `DashScope asynchronous ASR subtask ended with status ${subtaskStatus}`,
							code: result.code ?? null,
						},
						dashscope: queryBody,
					},
					req.file?.bytes.byteLength ?? 0,
					null,
					requestId,
				);
			}
			const transcriptionUrl = result.transcription_url;
			if (typeof transcriptionUrl !== 'string' || !transcriptionUrl) {
				throw new Error('DashScope asynchronous ASR result has no transcription_url');
			}
			const { response: resultResponse } = await fetchWithSafeRedirects(transcriptionUrl, {
				fetchImpl: fetchImpl as typeof fetch,
				init: { signal: timeout.signal },
				requireHttps: true,
				allowIpLiterals: false,
			});
			const resultBody = await parseJsonResponse(resultResponse, responseByteLimit);
			if (!resultResponse.ok) {
				timing?.markStreamComplete();
				return clientResult(
					req,
					resultResponse,
					resultBody,
					req.file?.bytes.byteLength ?? 0,
					null,
					requestId,
					{ upstreamOutcomeUnknown: true, failoverForbidden: true },
				);
			}
			if (!Array.isArray(asObject(resultBody)?.transcripts)) {
				timing?.markStreamComplete();
				return invalidSuccessfulResult(req, requestId, req.file?.bytes.byteLength ?? 0);
			}
			const normalized = normalizeDashScopeAsyncAsrResult(resultBody, queryBody);
			const seconds = asFiniteNonNegativeNumber(asObject(normalized.usage)?.seconds);
			timing?.markStreamComplete();
			return clientResult(
				req,
				queryResponse,
				normalized,
				req.file?.bytes.byteLength ?? 0,
				resolveDashScopeDuration(req, seconds),
				requestId,
			);
		}
	} catch (error) {
		timing?.markStreamComplete();
		const aborted = timeout.signal.aborted;
		const explicitSubmitNonOk = upstreamStatus != null
			&& (upstreamStatus < 200 || upstreamStatus >= 300)
			&& !submitAccepted;
		const upstreamOutcomeUnknown = submitAccepted || (dispatchStarted && !explicitSubmitNonOk);
		return errorDispatchResult(
			req,
			explicitSubmitNonOk ? upstreamStatus! : aborted ? (timeout.timedOut() ? 504 : 499) : 502,
			aborted
				? timeout.timedOut()
					? 'DashScope asynchronous ASR timed out'
					: 'DashScope asynchronous ASR was cancelled by the client'
				: `DashScope asynchronous ASR failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				...(upstreamOutcomeUnknown
					? { upstreamOutcomeUnknown: true, failoverForbidden: true }
					: {}),
				...(error instanceof DashScopeResponseBodyTooLargeError
					? { responseBodyTooLarge: true }
					: {}),
			},
		);
	} finally {
		timeout.clear();
	}
}

export function extractDashScopeMultimodalDurationSeconds(body: unknown): number | null {
	const usage = asObject(asObject(body)?.usage);
	return asFiniteNonNegativeNumber(usage?.duration) ?? asFiniteNonNegativeNumber(usage?.seconds);
}

function isUsableMultimodalPassthroughResult(body: unknown): boolean {
	const output = asObject(asObject(body)?.output);
	if (!output) return false;
	if (typeof output.text === 'string') return true;
	const choice = firstArrayObject(output.choices);
	const content = asObject(choice?.message)?.content;
	return Array.isArray(content) && content.some((part) => typeof asObject(part)?.text === 'string');
}

/** 透传 DashScope 同步多模态 JSON：替换 model，返回原生响应，按 usage.duration/seconds 计费。 */
export async function dispatchDashScopeMultimodalPassthrough(
	route: RouteResult,
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: DashScopeAsrDispatchOptions = {},
): Promise<DashScopeAudioDispatchResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = resolveUpstreamEndpoint('dashscope', 'audio.transcriptions.multimodal', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const upstreamBody = {
		...body,
		model: route.providerModelName,
	};
	const serializedBody = JSON.stringify(upstreamBody);
	const timeout = withTimeout(requestSignal, options.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS);
	const responseByteLimit = typeof options.maxResponseBytes === 'number'
		&& Number.isFinite(options.maxResponseBytes)
		&& options.maxResponseBytes > 0
		? Math.min(DASHSCOPE_MULTIMODAL_MAX_RESPONSE_BYTES, Math.floor(options.maxResponseBytes))
		: DASHSCOPE_MULTIMODAL_MAX_RESPONSE_BYTES;
	let dispatchStarted = false;
	try {
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		await options.beforeUpstreamDispatch?.();
		if (timeout.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		dispatchStarted = true;
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
				'X-DashScope-SSE': 'disable',
			},
			body: serializedBody,
			signal: timeout.signal,
		});
		timing?.markAttemptHeaders(attempt, response.status);
		const headerRequestId = extractUpstreamRequestId(response.headers);
		const parsedBody = await parseJsonResponse(response, responseByteLimit);
		timing?.markStreamComplete();
		const requestId = headerRequestId ?? bodyRequestId(parsedBody);
		if (response.ok && !isUsableMultimodalPassthroughResult(parsedBody)) {
			return {
				response: gatewayErrorResponse({
					status: 502,
					code: GatewayErrorCode.upstreamRequestFailed,
					message: 'DashScope multimodal upstream returned an invalid response',
				}),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: requestId,
				meta: {
					parsedBody: null,
					audioDurationSeconds: null,
					audioDurationSource: null,
					audioFileBytes: 0,
					audioTokenUsage: null,
					upstreamOutcomeUnknown: true,
					failoverForbidden: true,
				},
			};
		}
		const seconds = response.ok ? extractDashScopeMultimodalDurationSeconds(parsedBody) : null;
		const duration =
			seconds == null
				? null
				: resolveAudioBillingDuration({
						upstreamSeconds: seconds,
						fileBytes: 0,
						mimeType: 'application/octet-stream',
						clientSeconds: null,
					});
		return {
			response: new Response(JSON.stringify(parsedBody), {
				status: response.status,
				statusText: response.statusText,
				headers: { 'Content-Type': 'application/json' },
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: requestId,
			meta: {
				parsedBody,
				audioDurationSeconds: duration?.seconds ?? null,
				audioDurationSource: duration?.source ?? null,
				audioFileBytes: 0,
				audioTokenUsage: null,
			},
		};
	} catch (error) {
		if (error instanceof DashScopeResponseBodyTooLargeError) {
			timing?.markStreamComplete();
			const parsedBody = { error: { message: error.message } };
			const upstreamOutcomeUnknown = error.upstreamStatus >= 200 && error.upstreamStatus < 300;
			return {
				response: new Response(JSON.stringify(parsedBody), {
					status: error.upstreamStatus,
					headers: { 'Content-Type': 'application/json' },
				}),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: null,
				meta: {
					parsedBody,
					audioDurationSeconds: null,
					audioDurationSource: null,
					audioFileBytes: 0,
					audioTokenUsage: null,
					responseBodyTooLarge: true,
					...(upstreamOutcomeUnknown
						? { upstreamOutcomeUnknown: true, failoverForbidden: true }
						: {}),
				},
			};
		}
		timing?.markStreamComplete();
		const aborted = timeout.signal.aborted;
		const message = aborted
			? timeout.timedOut()
				? 'DashScope multimodal ASR timed out'
				: 'DashScope multimodal ASR was cancelled by the client'
			: `DashScope multimodal ASR failed: ${error instanceof Error ? error.message : String(error)}`;
		const parsedBody = { error: { message } };
		return {
			response: new Response(JSON.stringify(parsedBody), {
				status: aborted ? (timeout.timedOut() ? 504 : 499) : 502,
				headers: { 'Content-Type': 'application/json' },
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
			meta: {
				parsedBody,
				audioDurationSeconds: null,
				audioDurationSource: null,
				audioFileBytes: 0,
				audioTokenUsage: null,
				upstreamOutcomeUnknown: dispatchStarted || undefined,
				failoverForbidden: dispatchStarted || undefined,
			},
		};
	} finally {
		timeout.clear();
	}
}
