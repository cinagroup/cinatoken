import { withNativeMediaDispatch, type NativeMediaOptions } from './native-media-lifecycle';
import type { OpenAiImageDispatchOptions } from './openai-images-driver';
import type { PreparedImageAttempt } from '../image-attempt-context';
/**
 * Adapter ID → driver 实现表。
 * Registry 声明能力，本表声明运行时实现；一致性由 dispatch-table.test.ts 焊死。
 */
import { listConversionAdapters, type RouteAdapter } from '@octafuse/core/adapters/registry';
import type { RouteResult } from '../model-router';
import type { ProxyDispatchResult } from '../failover-dispatch';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import {
	dispatchDashScopeAsyncAsr,
	dispatchDashScopeMultimodalPassthrough,
	dispatchDashScopeSyncAsr,
	type DashScopeAsrDispatchOptions,
} from './dashscope-audio-driver';
import {
	dispatchDashScopeJsonPassthrough,
	type DashScopeJsonPassthroughOptions,
	type DashScopePassthroughSurface,
} from './dashscope-json-passthrough';
import {
	dispatchMiniMaxAsrPassthrough,
	dispatchMiniMaxAudioTranscriptions,
	type MiniMaxAsrPassthroughRequest,
} from './minimax-audio-driver';
import {
	dispatchMiniMaxJsonPassthrough,
	type MiniMaxJsonPassthroughOperation,
	type MiniMaxJsonPassthroughOptions,
} from './minimax-json-passthrough';
import {
	dispatchVolcengineJsonPassthrough,
	type VolcengineJsonPassthroughOptions,
} from './volcengine-json-passthrough';
import {
	dispatchGeminiImagePassthrough,
	type GeminiImageAction,
	type GeminiImagePassthroughOptions,
} from './gemini-image-passthrough';
import { dispatchOpenAiAudioTranscriptions, type NormalizedAudioTranscriptionRequest } from './openai-audio-driver';
import {
	dispatchDashScopeMiniMaxTts,
	dispatchDashScopeQwenTts,
	dispatchDashScopeSpeechSynthesizer,
	dispatchOpenAiAudioSpeech,
	type AudioSpeechDispatchOptions,
	type NormalizedAudioSpeechRequest,
} from './audio-speech-driver';
import { dispatchDashScopeImageGenerations } from './dashscope-images-driver';
import { dispatchGeminiOpenAiImage } from './gemini-openai-image-driver';
import { dispatchMiniMaxOpenAiImage, dispatchMiniMaxOpenAiSpeech } from './minimax-openai-driver';
import { dispatchOpenAiImageGenerations } from './openai-images-driver';
import { dispatchVolcengineOpenAiImage } from './volcengine-openai-driver';

type Timing = {
	signal?: AbortSignal;
	timing?: RequestTimingCollector | null;
	attempt?: RequestTimingAttempt;
};

const AUDIO_TRANSCRIPTION_ADAPTERS = [
	'dashscope-asr-qwen-file',
	'dashscope-asr-qwen-audio-file',
	'dashscope-asr-fun-file',
	'dashscope-asr-file-async',
	'minimax-asr-file',
] as const satisfies readonly RouteAdapter[];

const AUDIO_SPEECH_ADAPTERS = [
	'dashscope-tts-speech',
	'dashscope-tts-qwen',
	'dashscope-tts-minimax',
	'minimax-tts',
] as const satisfies readonly RouteAdapter[];

const IMAGE_GENERATION_ADAPTERS = [
	'dashscope-image-qwen',
	'dashscope-image-wan',
	'minimax-image',
	'volcengine-image',
	'gemini-image',
] as const satisfies readonly RouteAdapter[];

export const IMPLEMENTED_CONVERSION_ADAPTERS: readonly RouteAdapter[] = [
	...AUDIO_TRANSCRIPTION_ADAPTERS,
	...AUDIO_SPEECH_ADAPTERS,
	...IMAGE_GENERATION_ADAPTERS,
];

export function implementedConversionAdapterIds(): readonly string[] {
	return IMPLEMENTED_CONVERSION_ADAPTERS;
}

export function registryConversionAdapterIds(): readonly string[] {
	return listConversionAdapters().map((adapter) => adapter.id);
}

export function dispatchAudioTranscriptions(
	route: RouteResult,
	req: NormalizedAudioTranscriptionRequest,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: DashScopeAsrDispatchOptions,
): Promise<ProxyDispatchResult> {
	const ctx: Timing = { signal, timing, attempt };
	if (route.adapter === 'passthrough' && route.upstreamProtocol === 'openai') {
		return dispatchOpenAiAudioTranscriptions(route, req, ctx.signal, ctx.timing, ctx.attempt, options);
	}
	if (
		route.adapter === 'dashscope-asr-qwen-file' ||
		route.adapter === 'dashscope-asr-qwen-audio-file' ||
		route.adapter === 'dashscope-asr-fun-file'
	) {
		return dispatchDashScopeSyncAsr(route, req, ctx.signal, ctx.timing, ctx.attempt, options);
	}
	if (route.adapter === 'dashscope-asr-file-async') {
		return dispatchDashScopeAsyncAsr(route, req, ctx.signal, ctx.timing, ctx.attempt, options);
	}
	if (route.adapter === 'minimax-asr-file') {
		return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
			dispatchMiniMaxAudioTranscriptions(route, req, ownedSignal, timing, attempt, ownedOptions),
		);
	}
	throw new Error(`Unsupported audio transcription adapter: ${route.adapter}`);
}

const SPEECH_DISPATCH = {
	'dashscope-tts-speech': dispatchDashScopeSpeechSynthesizer,
	'dashscope-tts-qwen': dispatchDashScopeQwenTts,
	'dashscope-tts-minimax': dispatchDashScopeMiniMaxTts,
	'minimax-tts': dispatchMiniMaxOpenAiSpeech,
} as const;

export function dispatchAudioSpeech(
	route: RouteResult,
	request: NormalizedAudioSpeechRequest,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: AudioSpeechDispatchOptions,
): Promise<ProxyDispatchResult> {
	if (route.adapter === 'passthrough' && route.upstreamProtocol === 'openai') {
		return dispatchOpenAiAudioSpeech(route, request, signal, timing, attempt, options);
	}
	const dispatch = SPEECH_DISPATCH[route.adapter as keyof typeof SPEECH_DISPATCH];
	if (!dispatch) {
		throw new Error(`Unsupported audio speech adapter: ${route.adapter}`);
	}
	if (route.adapter === 'minimax-tts')
		return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
			dispatch(route, request, ownedSignal, timing, attempt, ownedOptions),
		);
	return dispatch(route, request, signal, timing, attempt, options);
}

export function dispatchImageGenerations(
	route: RouteResult,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: OpenAiImageDispatchOptions,
	beforeFetch?: (prepared?: PreparedImageAttempt) => Promise<void>,
): Promise<ProxyDispatchResult> {
	if (route.adapter === 'passthrough' && route.upstreamProtocol === 'openai') {
		return dispatchOpenAiImageGenerations(route, body, signal, timing, attempt, options, beforeFetch);
	}
	if (route.adapter === 'dashscope-image-qwen' || route.adapter === 'dashscope-image-wan') {
		return withNativeMediaDispatch(
			signal,
			{ ...options, beforeUpstreamDispatch: () => beforeFetch?.() ?? Promise.resolve() },
			(ownedSignal, ownedOptions) =>
				dispatchDashScopeImageGenerations(route, body, ownedSignal, timing, attempt, ownedOptions),
		);
	}
	if (route.adapter === 'minimax-image') {
		return withNativeMediaDispatch(
			signal,
			{ ...options, beforeUpstreamDispatch: () => beforeFetch?.() ?? Promise.resolve() },
			(ownedSignal, ownedOptions) =>
				dispatchMiniMaxOpenAiImage(route, body, ownedSignal, timing, attempt, ownedOptions),
		);
	}
	if (route.adapter === 'volcengine-image') {
		return withNativeMediaDispatch(
			signal,
			{ ...options, beforeUpstreamDispatch: () => beforeFetch?.() ?? Promise.resolve() },
			(ownedSignal, ownedOptions) =>
				dispatchVolcengineOpenAiImage(route, body, ownedSignal, timing, attempt, ownedOptions),
		);
	}
	if (route.adapter === 'gemini-image') {
		return withNativeMediaDispatch(
			signal,
			{ ...options, beforeUpstreamDispatch: () => beforeFetch?.() ?? Promise.resolve() },
			(ownedSignal, ownedOptions) => dispatchGeminiOpenAiImage(route, body, ownedSignal, timing, attempt, ownedOptions),
		);
	}
	throw new Error(`Unsupported image generation adapter: ${route.adapter}`);
}

export function dispatchDashScopeJsonPassthroughRoute(
	route: RouteResult,
	surface: DashScopePassthroughSurface,
	body: Record<string, unknown> | null,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: DashScopeJsonPassthroughOptions,
): Promise<ProxyDispatchResult> {
	if (
		route.adapter !== 'passthrough' ||
		route.upstreamProtocol !== 'dashscope' ||
		route.upstreamOperation !== surface
	) {
		throw new Error(`Unsupported DashScope passthrough adapter: ${route.adapter}`);
	}
	return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
		dispatchDashScopeJsonPassthrough(route, surface, body, ownedSignal, timing, attempt, ownedOptions),
	);
}

export function dispatchMultimodalPassthrough(
	route: RouteResult,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: DashScopeAsrDispatchOptions,
): Promise<ProxyDispatchResult> {
	if (route.adapter !== 'passthrough' || route.upstreamOperation !== 'audio.transcriptions.multimodal') {
		throw new Error(`Unsupported DashScope multimodal adapter: ${route.adapter}`);
	}
	return dispatchDashScopeMultimodalPassthrough(route, body, signal, timing, attempt, options);
}

export function dispatchGeminiImagePassthroughRoute(
	route: RouteResult,
	action: GeminiImageAction,
	body: Record<string, unknown>,
	search: string,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: GeminiImagePassthroughOptions,
): Promise<ProxyDispatchResult> {
	return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
		dispatchGeminiImagePassthrough(route, action, body, search, ownedSignal, timing, attempt, ownedOptions),
	);
}

export function dispatchVolcengineJsonPassthroughRoute(
	route: RouteResult,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: VolcengineJsonPassthroughOptions,
): Promise<ProxyDispatchResult> {
	return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
		dispatchVolcengineJsonPassthrough(route, body, ownedSignal, timing, attempt, ownedOptions),
	);
}

export function dispatchMiniMaxJsonPassthroughRoute(
	route: RouteResult,
	operation: MiniMaxJsonPassthroughOperation,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: MiniMaxJsonPassthroughOptions,
): Promise<ProxyDispatchResult> {
	return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
		dispatchMiniMaxJsonPassthrough(route, operation, body, ownedSignal, timing, attempt, ownedOptions),
	);
}

export function dispatchMiniMaxSpeechPassthrough(
	route: RouteResult,
	request: MiniMaxAsrPassthroughRequest,
	signal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: NativeMediaOptions,
): Promise<ProxyDispatchResult> {
	if (
		route.adapter !== 'passthrough' ||
		route.upstreamProtocol !== 'minimax' ||
		route.upstreamOperation !== 'audio.transcriptions'
	) {
		throw new Error(`Unsupported MiniMax ASR passthrough adapter: ${route.adapter}`);
	}
	return withNativeMediaDispatch(signal, options, (ownedSignal, ownedOptions) =>
		dispatchMiniMaxAsrPassthrough(route, request, ownedSignal, timing, attempt, ownedOptions),
	);
}
