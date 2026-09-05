/**
 * OpenAI `/audio/speech` 与 DashScope TTS 的协议驱动。
 * DashScope 统一使用 SSE 上游，以便边转发音频边读取最终真实 usage；不会用输入长度伪造最终用量。
 */
import { resolveProviderUpstreamSecret, resolveUpstreamEndpoint } from '@octafuse/core';
import { audioEndpointSpeechRequestCapabilities } from '@octafuse/core/model-endpoint-catalog';
import type { RouteResult } from '../model-router';
import { EMPTY_USAGE, type UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { extractUpstreamRequestId } from './upstream-request-id';
import {
	sanitizeUpstreamUrlForLog,
	upstreamErrorNameForLog,
} from './upstream-observability';
import {
	resolveAudioProviderOptionsForRoute,
	type AudioProviderOptions,
} from './audio-provider-options';

export type AudioSpeechResponseFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
export type AudioSpeechStreamFormat = 'audio' | 'sse';
export type AudioSpeechVoice = string;

export type AudioSpeechInputReferencePart =
	| {
			type: 'input_audio';
			inputAudio: {
				bytes: Uint8Array;
				encoding: { kind: 'raw_base64' } | { kind: 'data_uri'; mediaType: string };
			};
	  }
	| { type: 'text'; text: string };

export type NormalizedAudioSpeechRequest = {
	input: string;
	voice?: AudioSpeechVoice;
	responseFormat: AudioSpeechResponseFormat;
	speed: number;
	streamFormat: AudioSpeechStreamFormat;
	instructions?: string;
	inputReferences?: readonly AudioSpeechInputReferencePart[];
	/** OpenRouter `provider.options.<provider>`; resolved per concrete attempt. */
	providerOptions?: AudioProviderOptions;
};

type SpeechDispatchMeta = {
	upstreamOutcomeUnknown?: boolean;
	failoverForbidden?: boolean;
};

type SpeechDispatchResult = {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	upstreamRequestId: string | null;
	meta?: SpeechDispatchMeta;
};

export type AudioSpeechDispatchOptions = {
	fetchImpl?: typeof fetch;
};

type DashScopeTtsKind = 'speech' | 'qwen' | 'minimax';

type ParsedTtsEvent = {
	audioBase64: string | null;
	characters: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	terminal: boolean;
	requestId: string | null;
	rawUsage: unknown;
	error: string | null;
};

const AUDIO_CONTENT_TYPES: Record<AudioSpeechResponseFormat, string> = {
	mp3: 'audio/mpeg',
	opus: 'audio/ogg',
	aac: 'audio/aac',
	flac: 'audio/flac',
	wav: 'audio/wav',
	pcm: 'audio/pcm',
};

export function speechResponseContentType(
	request: Pick<NormalizedAudioSpeechRequest, 'responseFormat' | 'streamFormat'>,
): string {
	return request.streamFormat === 'sse'
		? 'text/event-stream; charset=utf-8'
		: AUDIO_CONTENT_TYPES[request.responseFormat];
}

function isExpectedOpenAiSpeechContentType(
	contentType: string | null,
	request: Pick<NormalizedAudioSpeechRequest, 'responseFormat' | 'streamFormat'>,
): boolean {
	const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (request.streamFormat === 'sse') return mediaType === 'text/event-stream';
	if (mediaType === 'application/octet-stream') return true;
	if (request.responseFormat === 'mp3') {
		return mediaType === 'audio/mpeg' || mediaType === 'audio/mp3';
	}
	return mediaType === AUDIO_CONTENT_TYPES[request.responseFormat];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((field) => allowed.has(field));
}

function finiteNumberInRange(value: unknown, minimum: number, maximum: number): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function integerInSet(value: unknown, allowed: ReadonlySet<number>): boolean {
	return typeof value === 'number' && Number.isInteger(value) && allowed.has(value);
}

const QWEN_TTS_LANGUAGES = new Set([
	'Auto', 'Chinese', 'English', 'German', 'Italian', 'Portuguese', 'Spanish',
	'Japanese', 'Korean', 'French', 'Russian',
]);
const MINIMAX_TTS_EMOTIONS = new Set([
	'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'whisper',
]);
const MINIMAX_TTS_SOUND_EFFECTS = new Set([
	'spacious_echo', 'auditorium_echo', 'lofi_telephone', 'robotic',
]);
const MINIMAX_TTS_LANGUAGE_BOOSTS = new Set([
	'Chinese', 'Chinese,Yue', 'English', 'Arabic', 'Russian', 'Spanish', 'French',
	'Portuguese', 'German', 'Turkish', 'Dutch', 'Ukrainian', 'Vietnamese',
	'Indonesian', 'Japanese', 'Italian', 'Korean', 'Thai', 'Polish', 'Romanian',
	'Greek', 'Czech', 'Finnish', 'Hindi', 'Bulgarian', 'Danish', 'Hebrew', 'Malay',
	'Persian', 'Slovak', 'Swedish', 'Croatian', 'Filipino', 'Hungarian', 'Norwegian',
	'Slovenian', 'Catalan', 'Nynorsk', 'Tamil', 'Afrikaans', 'auto',
]);

function validateDashScopeSpeechOptions(
	options: Readonly<Record<string, unknown>>,
	request: NormalizedAudioSpeechRequest,
): boolean {
	if (!hasOnlyFields(options, new Set([
		'sample_rate', 'volume', 'bit_rate', 'pitch', 'enable_ssml',
		'word_timestamp_enabled', 'seed',
	]))) return false;
	if (options.sample_rate !== undefined && !integerInSet(
		options.sample_rate,
		new Set([8_000, 16_000, 22_050, 24_000, 44_100, 48_000]),
	)) return false;
	if (options.volume !== undefined && (
		!Number.isInteger(options.volume) || !finiteNumberInRange(options.volume, 0, 100)
	)) return false;
	if (options.bit_rate !== undefined && (
		!Number.isInteger(options.bit_rate)
		|| !finiteNumberInRange(options.bit_rate, 6, 510)
		|| request.responseFormat !== 'opus'
	)) return false;
	if (options.pitch !== undefined && !finiteNumberInRange(options.pitch, 0.5, 2)) return false;
	for (const field of ['enable_ssml', 'word_timestamp_enabled'] as const) {
		if (options[field] !== undefined && typeof options[field] !== 'boolean') return false;
	}
	return options.seed === undefined
		|| (typeof options.seed === 'number' && Number.isSafeInteger(options.seed));
}

function validateDashScopeQwenOptions(options: Readonly<Record<string, unknown>>): boolean {
	if (!hasOnlyFields(options, new Set(['language_type', 'optimize_instructions']))) return false;
	if (options.language_type !== undefined && (
		typeof options.language_type !== 'string' || !QWEN_TTS_LANGUAGES.has(options.language_type)
	)) return false;
	return options.optimize_instructions === undefined || typeof options.optimize_instructions === 'boolean';
}

function validateMiniMaxNestedOptions(
	options: Readonly<Record<string, unknown>>,
	request: NormalizedAudioSpeechRequest,
): boolean {
	if (!hasOnlyFields(options, new Set([
		'voice_setting', 'audio_setting', 'pronunciation_dict', 'language_boost',
		'voice_modify', 'text_normalization', 'latex_read', 'subtitle_enable', 'aigc_watermark',
	]))) return false;

	if (options.voice_setting !== undefined) {
		if (!isObject(options.voice_setting) || !hasOnlyFields(
			options.voice_setting,
			new Set(['vol', 'pitch', 'emotion']),
		)) return false;
		if (options.voice_setting.vol !== undefined && !(
			finiteNumberInRange(options.voice_setting.vol, Number.MIN_VALUE, 10)
		)) return false;
		if (options.voice_setting.pitch !== undefined && (
			!Number.isInteger(options.voice_setting.pitch)
			|| !finiteNumberInRange(options.voice_setting.pitch, -12, 12)
		)) return false;
		if (options.voice_setting.emotion !== undefined && (
			typeof options.voice_setting.emotion !== 'string'
			|| !MINIMAX_TTS_EMOTIONS.has(options.voice_setting.emotion)
		)) return false;
	}

	if (options.audio_setting !== undefined) {
		if (!isObject(options.audio_setting) || !hasOnlyFields(
			options.audio_setting,
			new Set(['sample_rate', 'bitrate', 'channel', 'force_cbr']),
		)) return false;
		if (options.audio_setting.sample_rate !== undefined && !integerInSet(
			options.audio_setting.sample_rate,
			new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100]),
		)) return false;
		if (options.audio_setting.bitrate !== undefined && (
			!integerInSet(options.audio_setting.bitrate, new Set([32_000, 64_000, 128_000, 256_000]))
			|| request.responseFormat !== 'mp3'
		)) return false;
		if (options.audio_setting.channel !== undefined
			&& !integerInSet(options.audio_setting.channel, new Set([1, 2]))) return false;
		if (options.audio_setting.force_cbr !== undefined
			&& (
				typeof options.audio_setting.force_cbr !== 'boolean'
				|| request.responseFormat !== 'mp3'
			)) return false;
	}

	if (options.pronunciation_dict !== undefined) {
		if (!isObject(options.pronunciation_dict)
			|| !hasOnlyFields(options.pronunciation_dict, new Set(['tone']))) return false;
		const tone = options.pronunciation_dict.tone;
		if (tone !== undefined && (
			!Array.isArray(tone)
			|| tone.length > 16
			|| !tone.every((item) => typeof item === 'string' && item.length <= 256)
		)) return false;
	}

	if (options.voice_modify !== undefined) {
		if (request.responseFormat !== 'mp3') return false;
		if (!isObject(options.voice_modify) || !hasOnlyFields(
			options.voice_modify,
			new Set(['pitch', 'intensity', 'timbre', 'sound_effects']),
		)) return false;
		for (const field of ['pitch', 'intensity', 'timbre'] as const) {
			const value = options.voice_modify[field];
			if (value !== undefined && (
				!Number.isInteger(value) || !finiteNumberInRange(value, -100, 100)
			)) return false;
		}
		if (options.voice_modify.sound_effects !== undefined && (
			typeof options.voice_modify.sound_effects !== 'string'
			|| !MINIMAX_TTS_SOUND_EFFECTS.has(options.voice_modify.sound_effects)
		)) return false;
	}

	if (options.language_boost !== undefined && (
		typeof options.language_boost !== 'string'
		|| !MINIMAX_TTS_LANGUAGE_BOOSTS.has(options.language_boost)
	)) return false;
	for (const field of ['text_normalization', 'latex_read'] as const) {
		if (options[field] !== undefined && typeof options[field] !== 'boolean') return false;
	}
	// The adapter always uses upstream SSE, where these non-streaming-only
	// controls are not supported by MiniMax.
	if (options.subtitle_enable !== undefined || options.aigc_watermark !== undefined) return false;
	return true;
}

function validateDashScopeProviderOptions(
	kind: DashScopeTtsKind,
	route: Pick<RouteResult, 'providerId' | 'providerName' | 'endpoint'>,
	request: NormalizedAudioSpeechRequest,
): boolean {
	const options = resolveAudioProviderOptionsForRoute(request.providerOptions, route);
	if (Object.keys(options).length === 0) return true;
	if (kind === 'speech') return validateDashScopeSpeechOptions(options, request);
	if (kind === 'qwen') return validateDashScopeQwenOptions(options);
	return validateMiniMaxNestedOptions(options, request);
}

function voiceId(voice: AudioSpeechVoice | undefined): string | null {
	return voice ?? null;
}

function requiredVoiceId(voice: AudioSpeechVoice | undefined): string {
	if (!voice) throw new Error('The selected TTS adapter requires an explicit voice');
	return voice;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let index = 0; index < bytes.byteLength; index += 0x2000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x2000));
	}
	return btoa(binary);
}

function buildStreamingOpenAiSpeechBody(
	body: Record<string, unknown>,
	parts: readonly AudioSpeechInputReferencePart[],
): ReadableStream<Uint8Array> {
	const audio = parts.find((part) => part.type === 'input_audio');
	if (audio?.type !== 'input_audio') {
		throw new Error('Stateless voice cloning requires one reference audio part');
	}
	const marker = `__cinatoken_speech_audio_${crypto.randomUUID()}__`;
	const serializedReferences = parts.map((part) => part.type === 'text'
		? { type: 'text', text: part.text }
		: { type: 'input_audio', input_audio: { data: marker } });
	const serialized = JSON.stringify({ ...body, input_references: serializedReferences });
	const quotedMarker = JSON.stringify(marker);
	const markerIndex = serialized.indexOf(quotedMarker);
	if (markerIndex < 0 || serialized.indexOf(quotedMarker, markerIndex + quotedMarker.length) >= 0) {
		throw new Error('Could not isolate the stateless voice-cloning payload');
	}
	const dataUriPrefix = audio.inputAudio.encoding.kind === 'data_uri'
		? `data:${audio.inputAudio.encoding.mediaType};base64,`
		: '';
	const prefix = `${serialized.slice(0, markerIndex + 1)}${dataUriPrefix}`;
	const suffix = serialized.slice(markerIndex + quotedMarker.length - 1);
	const encoder = new TextEncoder();
	const bytes = audio.inputAudio.bytes;
	// Divisible by three so every non-final chunk has no Base64 padding.
	const chunkSize = 0x6000;
	let phase: 'prefix' | 'audio' | 'suffix' | 'done' = 'prefix';
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (phase === 'prefix') {
				phase = 'audio';
				controller.enqueue(encoder.encode(prefix));
				return;
			}
			if (phase === 'audio' && offset < bytes.byteLength) {
				const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
				offset += chunk.byteLength;
				controller.enqueue(encoder.encode(bytesToBase64(chunk)));
				return;
			}
			if (phase === 'audio') phase = 'suffix';
			if (phase === 'suffix') {
				phase = 'done';
				controller.enqueue(encoder.encode(suffix));
				return;
			}
			controller.close();
		},
		cancel() {
			phase = 'done';
			offset = bytes.byteLength;
		},
	});
}

function copyResponseHeaders(headers: Headers): Headers {
	const copied = new Headers(headers);
	copied.delete('content-length');
	copied.delete('content-encoding');
	return copied;
}

function forbidSpeechFailover(meta: SpeechDispatchMeta): void {
	meta.upstreamOutcomeUnknown = true;
	meta.failoverForbidden = true;
}

function unknownSpeechFailure(params: {
	operation: 'openai.speech' | 'dashscope.tts';
	providerId: string;
	routeTargetId: string;
	upstreamLabel: string;
	error: unknown;
	meta: SpeechDispatchMeta;
	upstreamRequestId: string | null;
}): SpeechDispatchResult {
	forbidSpeechFailover(params.meta);
	console.error(JSON.stringify({
		event: 'gateway.audio_speech.upstream_error',
		operation: params.operation,
		upstream: params.upstreamLabel,
		providerId: params.providerId,
		routeTargetId: params.routeTargetId,
		errorName: upstreamErrorNameForLog(params.error),
	}));
	return {
		response: new Response(JSON.stringify({
			error: { message: 'Audio speech upstream outcome could not be verified' },
		}), {
			status: 502,
			headers: { 'Content-Type': 'application/json' },
		}),
		usagePromise: Promise.resolve(EMPTY_USAGE),
		upstreamRequestId: params.upstreamRequestId,
		meta: params.meta,
	};
}

/** SSE 帧只读取 `data:`；DashScope 与 OpenAI speech 均以 JSON data 帧传输。 */
export const SPEECH_SSE_MAX_EVENT_CHARS = 8 * 1024 * 1024;

function nextSpeechSseBoundary(value: string): { index: number; length: number } | null {
	let selected: { index: number; length: number } | null = null;
	for (const delimiter of ['\r\n\r\n', '\n\n', '\r\r']) {
		const index = value.indexOf(delimiter);
		if (index >= 0 && (selected == null || index < selected.index)) {
			selected = { index, length: delimiter.length };
		}
	}
	return selected;
}

export class SpeechSseParser {
	private buffer = '';
	private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

	push(chunk: Uint8Array, final = false): unknown[] {
		this.buffer += this.decoder.decode(chunk, { stream: !final });
		const parts: string[] = [];
		while (true) {
			const boundary = nextSpeechSseBoundary(this.buffer);
			if (!boundary) break;
			if (boundary.index > SPEECH_SSE_MAX_EVENT_CHARS) {
				throw new Error('Speech SSE event exceeds the gateway limit');
			}
			parts.push(this.buffer.slice(0, boundary.index));
			this.buffer = this.buffer.slice(boundary.index + boundary.length);
		}
		if (this.buffer.length > SPEECH_SSE_MAX_EVENT_CHARS) {
			throw new Error('Speech SSE event exceeds the gateway limit');
		}
		if (final && this.buffer.trim() !== '') {
			parts.push(this.buffer);
			this.buffer = '';
		}

		const events: unknown[] = [];
		for (const frame of parts) {
			const data = frame
				.split(/\r\n|\n|\r/u)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n');
			if (!data || data === '[DONE]') continue;
			events.push(JSON.parse(data));
		}
		return events;
	}
}

function hexToBase64(hex: string): string {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
		throw new Error('DashScope MiniMax returned invalid hex audio data');
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function parseDashScopeTtsEvent(value: unknown, kind: DashScopeTtsKind): ParsedTtsEvent {
	if (!isObject(value)) {
		throw new Error('DashScope TTS returned a non-object SSE event');
	}
	const output = isObject(value.output) ? value.output : {};
	const usage = isObject(value.usage) ? value.usage : null;
	const requestId = typeof value.request_id === 'string' ? value.request_id : null;

	let error: string | null = null;
	if (typeof value.code === 'string' && value.code.trim() !== '') {
		error = `${value.code}: ${typeof value.message === 'string' ? value.message : 'DashScope TTS failed'}`;
	}
	if (typeof value.status_code === 'number' && value.status_code >= 400) {
		error = typeof value.message === 'string' ? value.message : `DashScope status ${value.status_code}`;
	}

	let audioBase64: string | null = null;
	let terminal = false;
	if (kind === 'minimax') {
		const baseResponse = isObject(output.base_resp) ? output.base_resp : null;
		const statusCode = baseResponse ? finiteInteger(baseResponse.status_code) : null;
		if (statusCode != null && statusCode !== 0) {
			error = typeof baseResponse?.status_msg === 'string'
				? baseResponse.status_msg
				: `MiniMax status ${statusCode}`;
		}
		const data = isObject(output.data) ? output.data : null;
		const hex = data && typeof data.audio === 'string' ? data.audio : '';
		if (hex) audioBase64 = hexToBase64(hex);
		terminal = data?.status === 2;
	} else {
		const audio = isObject(output.audio) ? output.audio : null;
		const data = audio && typeof audio.data === 'string' ? audio.data : '';
		if (data) audioBase64 = data;
		terminal = output.finish_reason === 'stop';
	}

	return {
		audioBase64,
		characters: usage ? finiteInteger(usage.characters) : null,
		inputTokens: usage ? finiteInteger(usage.input_tokens) : null,
		outputTokens: usage ? finiteInteger(usage.output_tokens) : null,
		totalTokens: usage ? finiteInteger(usage.total_tokens) : null,
		terminal,
		requestId,
		rawUsage: usage,
		error,
	};
}

function speechDoneEvent(usage: UsageFromStream): Uint8Array {
	return new TextEncoder().encode(
		`data: ${JSON.stringify({
			type: 'speech.audio.done',
			usage: {
				input_tokens: usage.input_tokens,
				output_tokens: usage.output_tokens,
				total_tokens: usage.total_tokens,
			},
		})}\n\n`
	);
}

function speechDeltaEvent(audioBase64: string): Uint8Array {
	return new TextEncoder().encode(
		`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: audioBase64 })}\n\n`
	);
}

function updateUsageFromTtsEvent(usage: UsageFromStream, event: ParsedTtsEvent): void {
	if (event.characters != null) usage.audio_characters = event.characters;
	if (event.inputTokens != null) usage.input_tokens = event.inputTokens;
	if (event.outputTokens != null) usage.output_tokens = event.outputTokens;
	if (event.totalTokens != null) usage.total_tokens = event.totalTokens;
	if (event.rawUsage != null) usage.raw_usage = JSON.stringify(event.rawUsage);
	if (event.requestId) usage.upstreamBodyRequestId = event.requestId;
}

function dashScopeStreamResponse(options: {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	parser: SpeechSseParser;
	initialEvents: unknown[];
	kind: DashScopeTtsKind;
	request: NormalizedAudioSpeechRequest;
	timing?: RequestTimingCollector | null;
	markUpstreamOutcomeUnknown?: () => void;
}): { response: Response; usagePromise: Promise<UsageFromStream> } {
	const usage: UsageFromStream = { ...EMPTY_USAGE };
	let resolveUsage!: (value: UsageFromStream) => void;
	const usagePromise = new Promise<UsageFromStream>((resolve) => {
		resolveUsage = resolve;
	});
	let settled = false;
	let terminal = false;
	let emittedAudio = false;
	const pending = [...options.initialEvents];
	const finishUsage = (cancelled = false, streamError?: unknown) => {
		if (settled) return;
		settled = true;
		if (cancelled) usage.cancelled = true;
		if (streamError != null) {
			usage.stream_error = streamError instanceof Error ? streamError.message : String(streamError);
		}
		options.timing?.markStreamComplete();
		resolveUsage({ ...usage });
	};

	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				while (!terminal) {
					if (pending.length === 0) {
						const next = await options.reader.read();
						if (next.done) {
							pending.push(...options.parser.push(new Uint8Array(), true));
							if (pending.length === 0) {
								throw new Error('DashScope TTS stream ended before a terminal event');
							}
						} else {
							pending.push(...options.parser.push(next.value));
						}
					}
					const raw = pending.shift();
					if (raw === undefined) continue;
					const event = parseDashScopeTtsEvent(raw, options.kind);
					if (event.error) throw new Error(event.error);
					updateUsageFromTtsEvent(usage, event);
					if (event.audioBase64) {
						emittedAudio = true;
						options.timing?.markFirstByte();
						controller.enqueue(
							options.request.streamFormat === 'sse'
								? speechDeltaEvent(event.audioBase64)
								: base64ToBytes(event.audioBase64)
						);
					}
					if (event.terminal) {
						if (!emittedAudio) throw new Error('DashScope TTS completed without audio data');
						terminal = true;
						if (options.request.streamFormat === 'sse') controller.enqueue(speechDoneEvent(usage));
						controller.close();
						finishUsage(false);
						void options.reader.cancel();
						return;
					}
					if (event.audioBase64) return;
				}
			} catch (error) {
				options.markUpstreamOutcomeUnknown?.();
				finishUsage(false, error);
				await options.reader.cancel('speech_sse_invalid_or_too_large').catch(() => undefined);
				controller.error(error);
			}
		},
		async cancel() {
			finishUsage(true);
			await options.reader.cancel();
		},
	});

	return {
		response: new Response(body, {
			headers: {
				'Content-Type': speechResponseContentType(options.request),
				'Cache-Control': 'no-cache',
			},
		}),
		usagePromise,
	};
}

async function firstDashScopeEvents(
	response: Response,
	kind: DashScopeTtsKind
): Promise<{
	reader: ReadableStreamDefaultReader<Uint8Array>;
	parser: SpeechSseParser;
	events: unknown[];
	requestId: string | null;
	error: string | null;
}> {
	if (!response.body) throw new Error('DashScope TTS returned an empty response body');
	const reader = response.body.getReader();
	const parser = new SpeechSseParser();
	try {
		while (true) {
			const next = await reader.read();
			const events = parser.push(next.value ?? new Uint8Array(), next.done);
			if (events.length > 0) {
				let requestId: string | null = null;
				let error: string | null = null;
				for (const raw of events) {
					const parsed = parseDashScopeTtsEvent(raw, kind);
					requestId ??= parsed.requestId;
					error ??= parsed.error;
				}
				return { reader, parser, events, requestId, error };
			}
			if (next.done) throw new Error('DashScope TTS returned no SSE event');
		}
	} catch (error) {
		await reader.cancel('speech_sse_invalid_or_too_large').catch(() => undefined);
		throw error;
	}
}

function validateDashScopeRequest(
	kind: DashScopeTtsKind,
	request: NormalizedAudioSpeechRequest
): string | null {
	if (request.inputReferences) {
		return 'DashScope TTS adapters do not support OpenRouter stateless voice cloning';
	}
	if (!request.voice) return 'DashScope TTS adapters require an explicit voice';
	if (kind === 'speech') {
		if (!['mp3', 'opus', 'wav', 'pcm'].includes(request.responseFormat)) {
			return `DashScope SpeechSynthesizer does not support response_format=${request.responseFormat}`;
		}
		if (request.speed < 0.5 || request.speed > 2) {
			return 'DashScope SpeechSynthesizer speed must be between 0.5 and 2.0';
		}
		return null;
	}
	if (kind === 'qwen') {
		if (request.responseFormat !== 'wav') return 'DashScope Qwen-TTS only returns wav audio';
		return null;
	}
	if (!['mp3', 'pcm', 'flac', 'wav'].includes(request.responseFormat)) {
		return `DashScope MiniMax does not support response_format=${request.responseFormat}`;
	}
	if (request.instructions) return 'DashScope MiniMax does not support OpenAI instructions';
	if (request.speed < 0.5 || request.speed > 2) {
		return 'DashScope MiniMax speed must be between 0.5 and 2.0';
	}
	return null;
}

/**
 * Keep adapter-specific request validation ahead of pricing admission and
 * dispatch. A false result means the route cannot faithfully serve this
 * already-normalized public request.
 */
export function audioSpeechRouteCanDispatch(
	route: Pick<
		RouteResult,
		'adapter' | 'upstreamProtocol' | 'endpoint' | 'providerId' | 'providerName'
	>,
	request: NormalizedAudioSpeechRequest,
): boolean {
	if (route.adapter === 'passthrough' && route.upstreamProtocol === 'openai') {
		const speechCapabilities = route.endpoint?.audioCapabilities
			? audioEndpointSpeechRequestCapabilities(route.endpoint.audioCapabilities)
			: null;
		if (request.inputReferences) {
			if (
				route.endpoint?.capabilities.voice_cloning !== true ||
				!speechCapabilities
			) {
				return false;
			}
			const audio = request.inputReferences.find(
				(part) => part.type === 'input_audio',
			);
			if (audio?.type !== 'input_audio') return false;
			const mediaType = audio.inputAudio.encoding.kind === 'data_uri'
				? audio.inputAudio.encoding.mediaType.toLowerCase()
				: speechCapabilities.reference_audio_default_media_type;
			return mediaType !== null
				&& speechCapabilities.reference_audio_media_types.includes(mediaType);
		}
		return request.voice != null
			|| speechCapabilities?.supports_default_voice === true;
	}
	if (route.upstreamProtocol !== 'dashscope') return false;
	if (route.adapter === 'dashscope-tts-speech') {
		return validateDashScopeRequest('speech', request) === null
			&& validateDashScopeProviderOptions('speech', route, request);
	}
	if (route.adapter === 'dashscope-tts-qwen') {
		return validateDashScopeRequest('qwen', request) === null
			&& validateDashScopeProviderOptions('qwen', route, request);
	}
	if (route.adapter === 'dashscope-tts-minimax') {
		return validateDashScopeRequest('minimax', request) === null
			&& validateDashScopeProviderOptions('minimax', route, request);
	}
	return false;
}

/** 显式 adapter 决定请求形状，避免按模型名称猜测 MiniMax 与 Qwen 协议。 */
export function buildDashScopeTtsBody(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	kind: DashScopeTtsKind
): Record<string, unknown> {
	const voice = requiredVoiceId(request.voice);
	const providerOptions = resolveAudioProviderOptionsForRoute(request.providerOptions, route);
	if (kind === 'speech') {
		return buildRouteRequestBody(route, {
			model: route.providerModelName,
			input: {
				...providerOptions,
				text: request.input,
				voice,
				format: request.responseFormat,
				rate: request.speed,
				...(request.instructions ? { instruction: request.instructions } : {}),
			},
		});
	}
	if (kind === 'qwen') {
		return buildRouteRequestBody(route, {
			model: route.providerModelName,
			input: {
				...providerOptions,
				text: request.input,
				voice,
				...(request.instructions ? { instructions: request.instructions } : {}),
			},
		});
	}
	const providerVoiceSetting = isObject(providerOptions.voice_setting)
		? providerOptions.voice_setting
		: {};
	const providerAudioSetting = isObject(providerOptions.audio_setting)
		? providerOptions.audio_setting
		: {};
	const providerStreamOptions = isObject(providerOptions.stream_options)
		? providerOptions.stream_options
		: {};
	return buildRouteRequestBody(route, {
		model: route.providerModelName,
		input: {
			...providerOptions,
			text: request.input,
			voice_setting: {
				...providerVoiceSetting,
				voice_id: voice,
				speed: request.speed,
			},
			audio_setting: {
				...providerAudioSetting,
				format: request.responseFormat,
			},
			// MiniMax 尾帧默认重复完整 hex；关闭聚合避免客户端收到重复音频。
			stream_options: {
				...providerStreamOptions,
				exclude_aggregated_audio: true,
			},
		},
	});
}

async function dispatchDashScopeTts(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	kind: DashScopeTtsKind,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: AudioSpeechDispatchOptions
): Promise<SpeechDispatchResult> {
	const validationError = validateDashScopeRequest(kind, request);
	if (validationError) {
		return {
			response: new Response(JSON.stringify({ error: { message: validationError } }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			}),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		};
	}
	const capability = kind === 'speech' ? 'audio.speech' : 'audio.speech.multimodal';
	const url = resolveUpstreamEndpoint('dashscope', capability, route.providerEndpoints, {
		providerId: route.providerId,
	});
	const upstreamLabel = sanitizeUpstreamUrlForLog(url);
	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
	const serializedBody = JSON.stringify(buildDashScopeTtsBody(route, request, kind));
	const meta: SpeechDispatchMeta = {};
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	let observedUpstreamRequestId: string | null = null;
	try {
		dispatchStarted = true;
		const response = await (options?.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
				'X-DashScope-SSE': 'enable',
			},
			body: serializedBody,
			signal: requestSignal,
		});
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const headerRequestId = extractUpstreamRequestId(response.headers);
		observedUpstreamRequestId = headerRequestId;
		if (!response.ok) {
			return {
				response,
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: headerRequestId,
				meta,
			};
		}

		const first = await firstDashScopeEvents(response, kind);
		if (first.error) {
			await first.reader.cancel();
			forbidSpeechFailover(meta);
			return {
				response: new Response(JSON.stringify({ error: { message: first.error } }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' },
				}),
				usagePromise: Promise.resolve(EMPTY_USAGE),
				upstreamRequestId: first.requestId ?? headerRequestId,
				meta,
			};
		}
		const streamed = dashScopeStreamResponse({
			reader: first.reader,
			parser: first.parser,
			initialEvents: first.events,
			kind,
			request,
			timing,
			markUpstreamOutcomeUnknown: () => {
				forbidSpeechFailover(meta);
			},
		});
		return {
			...streamed,
			upstreamRequestId: first.requestId ?? headerRequestId,
			meta,
		};
	} catch (error) {
		if (dispatchStarted && (upstreamStatus == null || (upstreamStatus >= 200 && upstreamStatus < 300))) {
			return unknownSpeechFailure({
				operation: 'dashscope.tts',
				providerId: route.providerId,
				routeTargetId: route.targetId,
				upstreamLabel,
				error,
				meta,
				upstreamRequestId: observedUpstreamRequestId,
			});
		}
		throw error;
	}
}

function parseOpenAiSpeechUsage(event: unknown, usage: UsageFromStream): boolean {
	if (!isObject(event) || event.type !== 'speech.audio.done' || !isObject(event.usage)) return false;
	usage.input_tokens = finiteInteger(event.usage.input_tokens) ?? 0;
	usage.output_tokens = finiteInteger(event.usage.output_tokens) ?? 0;
	usage.total_tokens = finiteInteger(event.usage.total_tokens) ?? 0;
	usage.raw_usage = JSON.stringify(event.usage);
	return true;
}

function wrapOpenAiSpeechBody(
	body: ReadableStream<Uint8Array>,
	streamFormat: AudioSpeechStreamFormat,
	timing?: RequestTimingCollector | null,
	markOutcomeUnknown?: () => void,
): { body: ReadableStream<Uint8Array>; usagePromise: Promise<UsageFromStream> } {
	const reader = body.getReader();
	const parser = streamFormat === 'sse' ? new SpeechSseParser() : null;
	const usage: UsageFromStream = { ...EMPTY_USAGE };
	let resolveUsage!: (value: UsageFromStream) => void;
	const usagePromise = new Promise<UsageFromStream>((resolve) => {
		resolveUsage = resolve;
	});
	let settled = false;
	let sawTerminal = false;
	let emittedBytes = false;
	const finish = (cancelled = false, streamError?: unknown) => {
		if (settled) return;
		settled = true;
		if (cancelled) usage.cancelled = true;
		if (streamError != null) {
			usage.stream_error = streamError instanceof Error ? streamError.message : String(streamError);
		}
		timing?.markStreamComplete();
		resolveUsage({ ...usage });
	};
	return {
		body: new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) {
						for (const event of parser?.push(new Uint8Array(), true) ?? []) {
							sawTerminal ||= parseOpenAiSpeechUsage(event, usage);
						}
						if (streamFormat === 'sse' && !sawTerminal) {
							throw new Error('OpenAI speech SSE ended before speech.audio.done');
						}
						if (streamFormat === 'audio' && !emittedBytes) {
							throw new Error('OpenAI speech stream ended without audio data');
						}
						finish(false);
						controller.close();
						return;
					}
					timing?.markFirstByte();
					emittedBytes ||= next.value.byteLength > 0;
					for (const event of parser?.push(next.value) ?? []) {
						sawTerminal ||= parseOpenAiSpeechUsage(event, usage);
					}
					controller.enqueue(next.value);
				} catch (error) {
					markOutcomeUnknown?.();
					finish(false, error);
					await reader.cancel('speech_sse_invalid_or_too_large').catch(() => undefined);
					controller.error(error);
				}
			},
			async cancel() {
				finish(true);
				await reader.cancel();
			},
		}),
		usagePromise,
	};
}

export async function dispatchOpenAiAudioSpeech(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: AudioSpeechDispatchOptions
): Promise<SpeechDispatchResult> {
	const url = resolveUpstreamEndpoint('openai', 'audio.speech', route.providerEndpoints, {
		providerId: route.providerId,
	});
	const upstreamLabel = sanitizeUpstreamUrlForLog(url);
	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
	const providerOptions = resolveAudioProviderOptionsForRoute(request.providerOptions, route);
	const upstreamBody = buildRouteRequestBody(route, {
			...providerOptions,
			model: route.providerModelName,
			input: request.input,
			...(request.voice ? { voice: request.voice } : {}),
			response_format: request.responseFormat,
			speed: request.speed,
			stream_format: request.streamFormat,
			...(request.instructions ? { instructions: request.instructions } : {}),
	});
	// Reference audio is a request-scoped, Guardrail-projected capability. Route
	// defaults must never synthesize it outside the verified cloning gate.
	delete upstreamBody.input_references;
	const serializedBody: BodyInit = request.inputReferences
		? buildStreamingOpenAiSpeechBody(upstreamBody, request.inputReferences)
		: JSON.stringify(upstreamBody);
	const meta: SpeechDispatchMeta = {};
	let dispatchStarted = false;
	let upstreamStatus: number | null = null;
	let observedUpstreamRequestId: string | null = null;
	try {
		dispatchStarted = true;
		const fetchInit: RequestInit & { duplex?: 'half' } = {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
			},
			body: serializedBody,
			signal: requestSignal,
			...(request.inputReferences ? { duplex: 'half' as const } : {}),
		};
		const response = await (options?.fetchImpl ?? fetch)(url, fetchInit);
		upstreamStatus = response.status;
		timing?.markAttemptHeaders(attempt, response.status);
		const upstreamRequestId = extractUpstreamRequestId(response.headers);
		observedUpstreamRequestId = upstreamRequestId;
		if (!response.ok) {
			return { response, usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId, meta };
		}
		if (!response.body) {
			return unknownSpeechFailure({
				operation: 'openai.speech',
				providerId: route.providerId,
				routeTargetId: route.targetId,
				upstreamLabel,
				error: new Error('OpenAI speech returned an empty response body'),
				meta,
				upstreamRequestId,
			});
		}
		if (!isExpectedOpenAiSpeechContentType(response.headers.get('content-type'), request)) {
			await response.body.cancel('speech_unexpected_content_type').catch(() => undefined);
			return unknownSpeechFailure({
				operation: 'openai.speech',
				providerId: route.providerId,
				routeTargetId: route.targetId,
				upstreamLabel,
				error: new Error('OpenAI speech returned an unexpected Content-Type'),
				meta,
				upstreamRequestId,
			});
		}
		const wrapped = wrapOpenAiSpeechBody(response.body, request.streamFormat, timing, () => {
			forbidSpeechFailover(meta);
		});
		const responseHeaders = copyResponseHeaders(response.headers);
		responseHeaders.set('Content-Type', speechResponseContentType(request));
		return {
			response: new Response(wrapped.body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			}),
			usagePromise: wrapped.usagePromise,
			upstreamRequestId,
			meta,
		};
	} catch (error) {
		if (dispatchStarted && (upstreamStatus == null || (upstreamStatus >= 200 && upstreamStatus < 300))) {
			return unknownSpeechFailure({
				operation: 'openai.speech',
				providerId: route.providerId,
				routeTargetId: route.targetId,
				upstreamLabel,
				error,
				meta,
				upstreamRequestId: observedUpstreamRequestId,
			});
		}
		throw error;
	}
}

export function dispatchDashScopeSpeechSynthesizer(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: AudioSpeechDispatchOptions
): Promise<SpeechDispatchResult> {
	return dispatchDashScopeTts(route, request, 'speech', requestSignal, timing, attempt, options);
}

export function dispatchDashScopeQwenTts(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: AudioSpeechDispatchOptions
): Promise<SpeechDispatchResult> {
	return dispatchDashScopeTts(route, request, 'qwen', requestSignal, timing, attempt, options);
}

export function dispatchDashScopeMiniMaxTts(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: AudioSpeechDispatchOptions
): Promise<SpeechDispatchResult> {
	return dispatchDashScopeTts(route, request, 'minimax', requestSignal, timing, attempt, options);
}

export function redactAudioSpeechRequestForLog(
	model: string,
	request: NormalizedAudioSpeechRequest
): Record<string, unknown> {
	const inputAudio = request.inputReferences?.find((part) => part.type === 'input_audio');
	return {
		model,
		input_characters: Array.from(request.input).length,
		voice: voiceId(request.voice),
		response_format: request.responseFormat,
		speed: request.speed,
		stream_format: request.streamFormat,
		has_instructions: Boolean(request.instructions),
		has_provider_options: request.providerOptions != null,
		input_reference_count: request.inputReferences?.length ?? 0,
		reference_audio_bytes: inputAudio?.type === 'input_audio'
			? inputAudio.inputAudio.bytes.byteLength
			: 0,
		has_reference_transcript: request.inputReferences?.some((part) => part.type === 'text') ?? false,
	};
}
