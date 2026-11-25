import { responseTextWithinLimit } from './bounded-response-body';
import {createAudioRequestLifecycle} from './audio-request-lifecycle';
/**
 * OpenAI 入口 → ElevenLabs 官方端点。
 * `elevenlabs-tts`：`POST /v1/audio/speech` → `POST {base}/text-to-speech/{voice_id}[/stream]`。
 *   `stream_format=sse` 走上游 `/stream`，把音频块重新封装成 OpenAI speech SSE。
 * `elevenlabs-asr-file`：`POST /v1/audio/transcriptions` → `POST {base}/speech-to-text`，
 *   固定请求词级时间戳，网关本地生成 segments、srt / vtt 和 diarized_json。
 * TTS 计费字符先看上游 `x-character-count`，缺失时用输入文本长度。
 */
import { applyRouteExtraHeaders, resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import {
	ELEVENLABS_ASR_DROPPED_FORM_KEYS,
	ElevenLabsOpenAiClientError,
	assertElevenLabsAsrNotWebhook,
	buildElevenLabsTtsRequestFromOpenAi,
	elevenLabsTranscriptToClient,
	resolveElevenLabsAsrMapping,
	splitElevenLabsTtsQuery,
} from '@octafuse/core/elevenlabs-openai';
import { readElevenLabsCharacterCount } from '@octafuse/core/elevenlabs-native';
import {
	applyUpstreamExtraFields,
	formExtraFieldText,
	protectedUpstreamPathsForRoute,
} from '@octafuse/core/upstream-extra-fields';
import type { RouteResult } from '../model-router';
import { EMPTY_USAGE, type UsageFromStream } from '../proxy';
import type { ProxyDispatchResult } from '../failover-dispatch';
import { buildRouteRequestBody } from '../route-default-params';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import type { AudioSpeechDispatchOptions, NormalizedAudioSpeechRequest } from './audio-speech-driver';
import {
	AUDIO_TRANSCRIPTION_TIMEOUT_MS,
	buildAudioTranscriptionClientResponse,
	validateAudioUpload,
	withTimeoutSignal,
	type NormalizedAudioTranscriptionRequest,
} from './openai-audio-driver';
import {
	ELEVENLABS_JSON_TIMEOUT_MS,
	buildElevenLabsSttForm,
	elevenLabsJsonError,
	elevenLabsTrackedStream,
	elevenLabsTransportError,
	elevenLabsUpstreamErrorResult,
	resolveElevenLabsSttBilling,
	resolveElevenLabsTtsUrl,
	type FetchLike,
} from './elevenlabs-passthrough';
import { extractUpstreamRequestId } from './upstream-request-id';

export type ElevenLabsOpenAiDispatchOptions = AudioSpeechDispatchOptions & {
	timeoutMs?: number;
};

function voiceId(voice:unknown):string {
 if(typeof voice==='string' && voice.trim())return voice;
 if(voice && typeof voice==='object' && 'id' in voice && typeof voice.id==='string' && voice.id.trim())return voice.id;
 throw new Error('Missing voice');
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
	}
	return btoa(binary);
}

function sseFrame(payload: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 上游 `/stream` 的音频块 → OpenAI speech SSE（`speech.audio.delta` + `speech.audio.done`）。 */


export async function dispatchElevenLabsOpenAiSpeech(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: ElevenLabsOpenAiDispatchOptions,
): Promise<ProxyDispatchResult> {
	const sse = request.streamFormat === 'sse';
	let built: ReturnType<typeof buildElevenLabsTtsRequestFromOpenAi>;
	let upstreamBody: Record<string, unknown>;
	let query: Record<string, string>;
	let restoredUpstreamPaths: string[] = [];
	try {
		built = buildElevenLabsTtsRequestFromOpenAi({
			model: route.providerModelName,
			text: request.input,
			voiceId: voiceId(request.voice),
			responseFormat: request.responseFormat,
			speed: request.speed,
			stream: sse,
			instructions: request.instructions,
		});
		const applied = applyUpstreamExtraFields({
			built: built.body,
			customParams: route.customParams,
			extras: request.extraFields,
			protectedPaths: protectedUpstreamPathsForRoute(route),
		});
		const split = splitElevenLabsTtsQuery(applied.body);
		upstreamBody = { ...split.body, model_id: route.providerModelName };
		query = { ...split.query, ...built.query };
		restoredUpstreamPaths = applied.restoredPaths;
	} catch (error) {
		if (error instanceof ElevenLabsOpenAiClientError) return elevenLabsJsonError(400, error.message);
		if (error instanceof Error && error.name === 'UpstreamExtraFieldsError') {
			return elevenLabsJsonError(400, error.message);
		}
		throw error;
	}

	const audioLifecycle=createAudioRequestLifecycle(requestSignal,options?.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS,options ?? {});
 const fetchImpl: FetchLike = (url,init)=>audioLifecycle.dispatch(String(url),init ?? {});
 let streamOwnsLifecycle=false;
	const timeoutMs = options?.timeoutMs ?? ELEVENLABS_JSON_TIMEOUT_MS;
	const timeoutController = new AbortController();
	const state = { timedOut: false, clientAborted: false };
	const timer = setTimeout(() => {
		state.timedOut = true;
		timeoutController.abort();
	}, timeoutMs);
	const onClientAbort = () => {
		state.clientAborted = true;
		timeoutController.abort();
	};
	requestSignal?.addEventListener('abort', onClientAbort, { once: true });
	try {
		const url = resolveElevenLabsTtsUrl(route, built.voiceId, built.pathSuffix, query);
		const { secret } = await audioLifecycle.wait(()=>resolveProviderUpstreamSecret(route.providerApiKey,{signal:audioLifecycle.signal,auxiliaryAuth:options?.auxiliaryAuth}));
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: applyRouteExtraHeaders(
				{ 'xi-api-key': secret, 'Content-Type': 'application/json' },
				route.customParams,
			),
			body: JSON.stringify(upstreamBody),
			signal: timeoutController.signal,
		});
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		if (!response.ok) return await elevenLabsUpstreamErrorResult(response, upstreamRequestId, timing, audioLifecycle.signal);
		const characters =
			readElevenLabsCharacterCount(response.headers) ?? Array.from(request.input).length;
		const result = elevenLabsTrackedStream(response, {
   characters, upstreamRequestId, timing, lifecycle:audioLifecycle, sse,
   headers:new Headers({'Content-Type':sse ? 'text/event-stream' : built.contentType}),
  });
  streamOwnsLifecycle=true;
		return { ...result, meta: { ...result.meta, restoredUpstreamPaths } };
	} catch (error) {
		timing?.markStreamComplete();
		if(audioLifecycle.admissionFailed)throw error;
 const result=elevenLabsTransportError(error,{timedOut:audioLifecycle.getAbortReason()==='gateway_timeout',clientAborted:audioLifecycle.getAbortReason()==='client_abort'},'ElevenLabs speech');
 if(audioLifecycle.dispatchStarted)result.meta={...result.meta,upstreamOutcomeUnknown:true,failoverForbidden:true};return result;
	} finally {
 if(!streamOwnsLifecycle) audioLifecycle.clear();
		clearTimeout(timer);
		requestSignal?.removeEventListener('abort', onClientAbort);
	}
}

/** 这些键由网关固定或转换，不从额外表单字段原样转发。 */
const ASR_FORM_SKIP_KEYS = new Set<string>([
	'model_id',
	'file',
	'duration_seconds',
	'webhook',
	'timestamps_granularity',
	'language_code',
	...ELEVENLABS_ASR_DROPPED_FORM_KEYS,
]);

export async function dispatchElevenLabsAudioTranscriptions(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: ElevenLabsOpenAiDispatchOptions,
): Promise<ProxyDispatchResult> {
	const file = req.file;
	if (!file) {
		throw new Error('Audio transcription requires a multipart file for this route');
	}
	const uploadError = validateAudioUpload(file);
	if (uploadError) {
		throw new Error(uploadError);
	}
	const mapped = resolveElevenLabsAsrMapping(req.clientResponseFormat);
	const merged = buildRouteRequestBody(route, { ...(req.extra ?? {}) });
	try {
		assertElevenLabsAsrNotWebhook(merged.webhook);
	} catch (error) {
		if (error instanceof ElevenLabsOpenAiClientError) return elevenLabsJsonError(400, error.message);
		throw error;
	}
	const languageFromRoute =
		typeof merged.language_code === 'string'
			? merged.language_code
			: typeof merged.language === 'string'
				? merged.language
				: undefined;
	const language = (req.language ?? languageFromRoute)?.trim();
	const fields: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(merged)) {
		if (value == null || ASR_FORM_SKIP_KEYS.has(key)) continue;
		const text = formExtraFieldText(value);
		if (text != null) fields.push([key, text]);
	}
	const forced: Record<string, string> = { timestamps_granularity: mapped.timestampsGranularity };
	if (language) forced.language_code = language;
	if (mapped.diarize) forced.diarize = 'true';

	const url = resolveUpstreamEndpoint('elevenlabs', 'audio.transcriptions', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const audioLifecycle=createAudioRequestLifecycle(requestSignal,options?.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS,options ?? {});
 const fetchImpl: FetchLike = (url,init)=>audioLifecycle.dispatch(String(url),init ?? {});
	const form = buildElevenLabsSttForm(route.providerModelName, file, fields, forced);
	const { signal, clear, getAbortReason } = withTimeoutSignal(
		requestSignal,
		options?.timeoutMs ?? AUDIO_TRANSCRIPTION_TIMEOUT_MS,
	);
	try {
		const { secret } = await audioLifecycle.wait(()=>resolveProviderUpstreamSecret(route.providerApiKey,{signal:audioLifecycle.signal,auxiliaryAuth:options?.auxiliaryAuth}));
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
		let upstreamBody: unknown = null;
		try {
			upstreamBody = text ? JSON.parse(text) : null;
		} catch {
			return { ...elevenLabsJsonError(502, 'ElevenLabs transcription returned invalid JSON'), upstreamRequestId };
		}
		const resolved = resolveElevenLabsSttBilling(upstreamBody, file, req.clientDurationSeconds);
		return {
			response: buildAudioTranscriptionClientResponse(
				req.clientResponseFormat,
				elevenLabsTranscriptToClient(upstreamBody, mapped.clientShape),
				response.status,
				response.statusText,
			),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId,
			meta: {
				parsedBody: upstreamBody,
				audioDurationSeconds: resolved.seconds,
				audioDurationSource: resolved.source,
				audioFileBytes: file.bytes.byteLength,
				audioTokenUsage: null,
			},
		};
	} catch (error) {
		timing?.markStreamComplete();
		if(audioLifecycle.admissionFailed)throw error;
 const reason = getAbortReason();
 const result = elevenLabsTransportError(
			error,
			{
				timedOut: reason === 'gateway_timeout',
				clientAborted: reason === 'client_abort' || requestSignal?.aborted === true,
			},
			'ElevenLabs transcription',
		);
 if(audioLifecycle.dispatchStarted)result.meta={...result.meta,upstreamOutcomeUnknown:true,failoverForbidden:true};return result;
	} finally {
 audioLifecycle.clear();
		clear();
	}
}
