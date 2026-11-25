import { createAudioRequestLifecycle, validateAudioUpstreamUrl } from './audio-request-lifecycle';
import { createSpeechStreamLifecycle, SpeechProtocolError } from './audio-speech-stream-lifecycle';
/**
 * ElevenLabs 原生透传。
 * `audio.speech` → `POST {base}/text-to-speech/{voice_id}[/stream][/with-timestamps]`，JSON body，音频 / NDJSON 原样转发。
 * `audio.transcriptions` → `POST {base}/speech-to-text`，multipart 原样转发。
 * 只替换 `model_id`；鉴权用 `xi-api-key`。上游错误按 `detail.status` 改写状态码，让额度用尽和并发限流触发故障转移。
 * 本文件的小工具（URL、错误响应、流记账）同时被 OpenAI 兼容驱动复用。
 */
import { applyRouteExtraHeaders, resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import {
	elevenLabsErrorHttpStatus,
	elevenLabsTtsVariantSuffix,
	readElevenLabsCharacterCount,
	readElevenLabsError,
	type ElevenLabsTtsVariant,
} from '@octafuse/core/elevenlabs-native';
import { elevenLabsUpstreamDurationSeconds } from '@octafuse/core/elevenlabs-openai';
import type { RouteResult } from '../model-router';
import { EMPTY_USAGE, type UsageFromStream } from '../proxy';
import type { ProxyDispatchResult } from '../failover-dispatch';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { resolveAudioBillingDuration } from './audio-duration';
import {
	AUDIO_TRANSCRIPTION_TIMEOUT_MS,
	resolveAudioUploadFilename,
	validateAudioUpload,
	withTimeoutSignal,
} from './openai-audio-driver';
import { responseTextWithinLimit } from './bounded-response-body';
import { extractUpstreamRequestId } from './upstream-request-id';

export const ELEVENLABS_JSON_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ElevenLabsPassthroughOptions = {
	fetchImpl?: FetchLike;
	timeoutMs?: number;
 beforeUpstreamDispatch?: () => Promise<void>;
 auxiliaryAuth?: import('@octafuse/core').RequestAuxiliaryAuthBudget;
 deadlineAtMs?: number;
 trackResourceCompletion?: import('./audio-request-lifecycle').AudioRequestLifecycleOptions['trackResourceCompletion'];
};

const STREAM_HEADER_BLOCKLIST = new Set([
	'content-length',
	'content-encoding',
	'transfer-encoding',
	'connection',
	'set-cookie',
]);

/** 重新封装的流不能沿用上游的长度和压缩头。 */
export function elevenLabsStreamHeaders(source: Headers): Headers {
	const headers = new Headers();
	source.forEach((value, key) => {
		if (STREAM_HEADER_BLOCKLIST.has(key.toLowerCase())) return;
		headers.append(key, value);
	});
	return headers;
}

/** 构造上游 TTS URL：音色填进模板，变体后缀接在路径末尾，query 逐项覆盖。 */
export function resolveElevenLabsTtsUrl(
	route: RouteResult,
	voiceId: string,
	pathSuffix: string,
	query: Record<string, string>,
): string {
	const base = resolveUpstreamEndpoint('elevenlabs', 'audio.speech', route.providerEndpoints, {
		providerId: route.providerId,
		voiceId,
	});
	const url = new URL(base);
	url.pathname = url.pathname.replace(/\/+$/, '') + pathSuffix;
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return url.toString();
}

export function elevenLabsJsonError(
	status: number,
	message: string,
	code?: string,
): ProxyDispatchResult {
	const body = {
		error: {
			message,
			type: status >= 500 ? 'upstream_error' : 'invalid_request_error',
			...(code ? { code } : {}),
		},
	};
	return {
		response: new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		}),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId: null,
		meta: { parsedBody: body, audioCharacters: null },
	};
}

/** 上游非 2xx：保留原错误体，只改写状态码。 */
export async function elevenLabsUpstreamErrorResult(
	response: Response,
	upstreamRequestId: string | null,
	timing?: RequestTimingCollector | null,
 signal?: AbortSignal,
): Promise<ProxyDispatchResult> {
	const text = await responseTextWithinLimit(response,8*1024*1024,signal);
	timing?.markStreamComplete();
	let parsed: unknown = text;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	const info = readElevenLabsError(parsed);
	const status = elevenLabsErrorHttpStatus(response.status, info.status);
	return {
		response: new Response(text, {
			status,
			headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
		}),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId,
		meta: { parsedBody: parsed, audioCharacters: null },
	};
}

/** 超时 / 取消 / 网络错误统一成网关错误响应。 */
export function elevenLabsTransportError(
	error: unknown,
	state: { timedOut: boolean; clientAborted: boolean },
	label: string,
): ProxyDispatchResult {
	const message = state.timedOut
		? `${label} timed out`
		: state.clientAborted
			? `${label} was cancelled by the client`
			: `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
	return elevenLabsJsonError(state.timedOut ? 504 : state.clientAborted ? 499 : 502, message);
}

/**
 * 成功响应整体流式转发，同时在结束 / 取消 / 出错时结算字符数。
 * 计费字符先看上游 `x-character-count`，缺失时用输入文本长度。
 */
export function elevenLabsTrackedStream(
 response: Response,
 options: {
  characters: number;
  upstreamRequestId: string | null;
  timing?: RequestTimingCollector | null;
  headers?: Headers;
  lifecycle?: ReturnType<typeof createAudioRequestLifecycle>;
  sse?: boolean;
 },
): ProxyDispatchResult {
 const lifecycle = options.lifecycle ?? createAudioRequestLifecycle(undefined, ELEVENLABS_JSON_TIMEOUT_MS, {});
 if (!response.body) {
  lifecycle.clear();
  return {...elevenLabsJsonError(502, 'ElevenLabs speech returned no audio body'), upstreamRequestId: options.upstreamRequestId};
 }
 const usage: UsageFromStream = {...EMPTY_USAGE, audio_characters: options.characters};
 const meta: NonNullable<ProxyDispatchResult['meta']> = {audioCharacters: options.characters};
 const owned = createSpeechStreamLifecycle(response.body.getReader(), lifecycle, usage, () => {
  usage.audio_characters = undefined;
  meta.upstreamOutcomeUnknown = true;
  meta.failoverForbidden = true;
 }, options.timing);
 lifecycle.trackResourceCompletion(owned.resourceCompletion);
 let bytes = 0;
 const frame = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
 const stream = new ReadableStream<Uint8Array>({
  start: owned.start,
  async pull(controller) {
   if (owned.closed) return;
   try {
    while (!owned.closed) {
     const chunk = await owned.read();
     if (owned.closed) return;
     if (chunk.done) {
      if (!bytes) throw new SpeechProtocolError('ElevenLabs speech completed without audio data');
      if (options.sse) controller.enqueue(frame({type:'speech.audio.done',usage:{input_tokens:0,output_tokens:0,total_tokens:0}}));
      owned.complete(true);
      return;
     }
     if (!chunk.value.byteLength) continue;
     if (bytes + chunk.value.byteLength > 64 * 1024 * 1024) throw new SpeechProtocolError('ElevenLabs speech response exceeds the byte limit');
     if (!bytes) options.timing?.markFirstByte();
     bytes += chunk.value.byteLength;
     if (options.sse) {
      let binary = '';
      for (let offset=0;offset<chunk.value.byteLength;offset+=0x8000) binary += String.fromCharCode(...chunk.value.subarray(offset,offset+0x8000));
      controller.enqueue(frame({type:'speech.audio.delta',audio:btoa(binary)}));
     } else controller.enqueue(chunk.value);
     return;
    }
   } catch (error) { owned.fail(error); }
  },
  cancel: owned.cancel,
 }, {highWaterMark: 0});
 const headers = options.headers ?? elevenLabsStreamHeaders(response.headers);
 if (options.sse) headers.set('Content-Type','text/event-stream');
 return {response:new Response(stream,{status:response.status,headers}),usagePromise:owned.usagePromise,upstreamRequestId:options.upstreamRequestId,meta};
}

export type ElevenLabsTtsPassthroughRequest = {
	voiceId: string;
	variant: ElevenLabsTtsVariant;
	/** 原样转发的 query（output_format、enable_logging 等）。 */
	query: Record<string, string>;
	body: Record<string, unknown>;
	/** 输入文本字符数，上游缺少 `x-character-count` 时用它计费。 */
	inputCharacters: number;
};

/** 原生 TTS 透传：四种变体共用 `audio.speech`。 */
export async function dispatchElevenLabsTtsPassthrough(
	route: RouteResult,
	request: ElevenLabsTtsPassthroughRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: ElevenLabsPassthroughOptions = {},
): Promise<ProxyDispatchResult> {
	if (
		route.adapter !== 'passthrough' ||
		route.upstreamProtocol !== 'elevenlabs' ||
		route.upstreamOperation !== 'audio.speech'
	) {
		throw new Error(`Unsupported ElevenLabs speech passthrough adapter: ${route.adapter}`);
	}
	const audioLifecycle=createAudioRequestLifecycle(requestSignal,options.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS,options);
 const fetchImpl:FetchLike=(url,init)=>audioLifecycle.dispatch(String(url),init ?? {});
	const url = resolveElevenLabsTtsUrl(
		route,
		request.voiceId,
		elevenLabsTtsVariantSuffix(request.variant),
		request.query,
	);
	let streamOwnsLifecycle = false;
	const timeoutController = new AbortController();
	const state = { timedOut: false, clientAborted: false };
	const timer = setTimeout(() => {
		state.timedOut = true;
		timeoutController.abort();
	}, options.timeoutMs ?? ELEVENLABS_JSON_TIMEOUT_MS);
	const onClientAbort = () => {
		state.clientAborted = true;
		timeoutController.abort();
	};
	requestSignal?.addEventListener('abort', onClientAbort, { once: true });
	try {
  validateAudioUpstreamUrl(url);
  const {secret}=await audioLifecycle.wait(()=>resolveProviderUpstreamSecret(route.providerApiKey,{signal:audioLifecycle.signal,auxiliaryAuth:options.auxiliaryAuth}));
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: applyRouteExtraHeaders(
				{
					'xi-api-key': secret,
					'Content-Type': 'application/json',
				},
				route.customParams,
			),
			body: JSON.stringify({ ...request.body, model_id: route.providerModelName }),
			signal: timeoutController.signal,
		});
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		if (!response.ok) return await elevenLabsUpstreamErrorResult(response, upstreamRequestId, timing, audioLifecycle.signal);
		const characters =
			readElevenLabsCharacterCount(response.headers) ?? Math.max(0, Math.floor(request.inputCharacters));
		const result=elevenLabsTrackedStream(response, {characters,upstreamRequestId,timing,lifecycle:audioLifecycle});
  streamOwnsLifecycle=true;
  return result;
	} catch (error) {
		if (audioLifecycle.admissionFailed) throw error;
 timing?.markStreamComplete();
 const result = elevenLabsTransportError(error,{timedOut:audioLifecycle.getAbortReason()==='gateway_timeout',clientAborted:audioLifecycle.getAbortReason()==='client_abort'},'ElevenLabs speech passthrough');
 if (audioLifecycle.dispatchStarted) result.meta = {...result.meta,upstreamOutcomeUnknown:true,failoverForbidden:true};
 return result;
	} finally {
 if (!streamOwnsLifecycle) audioLifecycle.clear();
		clearTimeout(timer);
		requestSignal?.removeEventListener('abort', onClientAbort);
	}
}

export type ElevenLabsSttPassthroughRequest = {
	/** 文件上传；用 `cloud_storage_url` / `source_url` 时为空。 */
	file: { filename: string; mimeType: string; bytes: Uint8Array } | null;
	/** 除 `model_id` / `file` 外的表单字段；允许同名重复（如 keyterms）。 */
	fields: Array<[string, string]>;
};

const STT_FORM_SKIP_KEYS = new Set(['model_id', 'file']);

export function buildElevenLabsSttForm(
	modelId: string,
	file: ElevenLabsSttPassthroughRequest['file'],
	fields: Array<[string, string]>,
	forced: Record<string, string> = {},
): FormData {
	const form = new FormData();
	form.append('model_id', modelId);
	for (const [key, value] of fields) {
		if (STT_FORM_SKIP_KEYS.has(key) || key in forced || value === '') continue;
		form.append(key, value);
	}
	for (const [key, value] of Object.entries(forced)) form.append(key, value);
	if (file) {
		const blob = new Blob([new Uint8Array(file.bytes)], {
			type: file.mimeType || 'application/octet-stream',
		});
		form.append('file', blob, resolveAudioUploadFilename(file.filename || '', file.mimeType || ''));
	}
	return form;
}

/** 转写响应 → 计费时长。上游 `audio_duration_secs` 优先，其次词表、媒体解析、字节估算。 */
export function resolveElevenLabsSttBilling(
	upstreamBody: unknown,
	file: ElevenLabsSttPassthroughRequest['file'],
	clientSeconds?: number | null,
) {
	return resolveAudioBillingDuration({
		upstreamSeconds: elevenLabsUpstreamDurationSeconds(upstreamBody),
		fileBytes: file?.bytes.byteLength ?? 0,
		mimeType: file?.mimeType ?? 'application/octet-stream',
		fileBytesForParse: file?.bytes,
		clientSeconds,
	});
}

/** 原生 STT 透传：替换 model_id，其余表单字段与响应体保持原样。 */
export async function dispatchElevenLabsSttPassthrough(
	route: RouteResult,
	request: ElevenLabsSttPassthroughRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: ElevenLabsPassthroughOptions = {},
): Promise<ProxyDispatchResult> {
	if (
		route.adapter !== 'passthrough' ||
		route.upstreamProtocol !== 'elevenlabs' ||
		route.upstreamOperation !== 'audio.transcriptions'
	) {
		throw new Error(`Unsupported ElevenLabs STT passthrough adapter: ${route.adapter}`);
	}
	if (request.file) {
		const uploadError = validateAudioUpload(request.file);
		if (uploadError) throw new Error(uploadError);
	}
	const fileBytes = request.file?.bytes.byteLength ?? 0;
	const audioLifecycle=createAudioRequestLifecycle(requestSignal,options.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS,options);
 const fetchImpl:FetchLike=(url,init)=>audioLifecycle.dispatch(String(url),init ?? {});
	const url = resolveUpstreamEndpoint('elevenlabs', 'audio.transcriptions', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const form = buildElevenLabsSttForm(route.providerModelName, request.file, request.fields);
	const { signal, clear, getAbortReason } = withTimeoutSignal(
		requestSignal,
		options.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS,
	);
	try {
  validateAudioUpstreamUrl(url);
		const { secret } = await audioLifecycle.wait(()=>resolveProviderUpstreamSecret(route.providerApiKey,{signal:audioLifecycle.signal,auxiliaryAuth:options.auxiliaryAuth}));
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: applyRouteExtraHeaders({ 'xi-api-key': secret }, route.customParams),
			body: form,
			signal,
		});
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		if (!response.ok) return await elevenLabsUpstreamErrorResult(response, upstreamRequestId, timing, audioLifecycle.signal);
		const text = await responseTextWithinLimit(response,8*1024*1024,audioLifecycle.signal);
		timing?.markStreamComplete();
		let upstreamBody: unknown = text;
		try {
			upstreamBody = text ? JSON.parse(text) : null;
		} catch {
			upstreamBody = text;
		}
		const resolved = resolveElevenLabsSttBilling(upstreamBody, request.file);
		return {
			response: new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId,
			meta: {
				parsedBody: upstreamBody,
				audioDurationSeconds: resolved.seconds,
				audioDurationSource: resolved.source,
				audioFileBytes: fileBytes,
				audioTokenUsage: null,
			},
		};
	} catch (error) {
		timing?.markStreamComplete();
		if (audioLifecycle.admissionFailed) throw error;
 const reason = getAbortReason();
 const result = elevenLabsTransportError(
			error,
			{
				timedOut: reason === 'gateway_timeout',
				clientAborted: reason === 'client_abort' || requestSignal?.aborted === true,
			},
			'ElevenLabs transcription passthrough',
		);
 if (audioLifecycle.dispatchStarted) result.meta = {...result.meta,upstreamOutcomeUnknown:true,failoverForbidden:true};
 return result;
	} finally {
 audioLifecycle.clear();
		clear();
	}
}
