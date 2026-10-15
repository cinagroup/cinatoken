import { createRequestDeadline, preparationRead } from '@octafuse/core';
import { createResourceCompletionGroup } from './resource-completion';
import { dispatchOpenAiAudioTranscriptions } from "./egress/openai-audio-driver";
import { dispatchDashScopeAsyncAsr, dispatchDashScopeMultimodalPassthrough, dispatchDashScopeSyncAsr } from "./egress/dashscope-audio-driver";
import { dispatchDashScopeMiniMaxTts, dispatchDashScopeQwenTts, dispatchDashScopeSpeechSynthesizer, dispatchOpenAiAudioSpeech } from "./egress/audio-speech-driver";
/**
 * 上游 HTTP 代理与故障转移：按协议分发到 openai/anthropic/gemini driver，并在流开始前按路由顺序重试。
 * 返回的 `usagePromise` 在流结束后解析 token 用量，供 `usage-tracker` 记账。
 */
import type { GatewayRepositories, RequestAuxiliaryAuthBudget } from '@octafuse/core';
import { DEFAULT_ROUTE_STRATEGY } from '@octafuse/core';
import type { RequestDispatchBudgetSnapshot } from './request-dispatch-budget';
import { TEXT_REQUEST_DEADLINE_MS } from './request-deadline';
import { DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS } from './dashscope-realtime-guardrails';
import type { RouteResult } from './model-router';
import { dispatchOpenAiRoute } from './egress/openai-driver';
import { dispatchOpenAiResponsesRoute } from './egress/openai-responses-driver';
import { dispatchOpenAiEmbeddingsRoute } from './egress/openai-embeddings-driver';
import { dispatchOpenAiRerankRoute } from './egress/openai-rerank-driver';
import {
	loadFirstEventTimeoutConfig,
	resolveFirstEventTimeoutMs,
	type FirstEventTimeoutOptions,
} from './stream-first-event-timeout';
import type { StreamIdleClockOptions } from './egress/stream-idle-timeout';
import { dispatchOpenAiImageEdits, dispatchOpenAiImageGenerations, IMAGE_GENERATION_TIMEOUT_MS, type NormalizedImageEditRequest } from './egress/openai-images-driver';
import { AUDIO_TRANSCRIPTION_TIMEOUT_MS, type NormalizedAudioTranscriptionRequest } from './egress/openai-audio-driver';
import type { DashScopeAsrDispatchOptions } from './egress/dashscope-audio-driver';
import {
	dispatchAudioSpeech,
	dispatchAudioTranscriptions,
	dispatchImageGenerations,
	dispatchDashScopeJsonPassthroughRoute,
	dispatchMiniMaxJsonPassthroughRoute,
	dispatchGeminiImagePassthroughRoute,
	dispatchVolcengineJsonPassthroughRoute,
	dispatchMiniMaxSpeechPassthrough,
	dispatchMultimodalPassthrough,
} from './egress/dispatch-table';
import type { DashScopeJsonPassthroughOptions, DashScopePassthroughSurface } from './egress/dashscope-json-passthrough';
import type { MiniMaxAsrPassthroughRequest } from './egress/minimax-audio-driver';
import type { MiniMaxJsonPassthroughOperation, MiniMaxJsonPassthroughOptions } from './egress/minimax-json-passthrough';
import type { VolcengineJsonPassthroughOptions } from './egress/volcengine-json-passthrough';
import type { GeminiImageAction, GeminiImagePassthroughOptions } from './egress/gemini-image-passthrough';
import { AUDIO_SPEECH_TIMEOUT_MS, type AudioSpeechDispatchOptions, type NormalizedAudioSpeechRequest } from './egress/audio-speech-driver';
import {
	dispatchDashScopeRealtime,
	type DashScopeRealtimeDispatchOptions,
	type DashScopeRealtimeOperation,
} from './egress/dashscope-realtime-driver';
import { dispatchAnthropicRoute } from './egress/anthropic-driver';
import { dispatchGeminiRoute } from './egress/gemini-driver';
import {
	failoverDispatch,
	type FailoverDispatchOptions,
	type ProxyDispatchAttemptTrace,
	type ProxyDispatchMeta,
} from './failover-dispatch';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import type { StickyTraceSnapshot } from './provider-sticky-routing';
import type { RequestTimingAttempt, RequestTimingCollector } from './request-timing';

export type { FailoverDispatchOptions, ProxyDispatchMeta } from './failover-dispatch';

/** 各协议 driver 从上游响应/stream 汇总出的用量（供 `usage-tracker` 计价）。 */
export interface UsageFromStream {
	/** 输入侧常规 token（含逻辑输入；具体口径见各 driver） */
	input_tokens: number;
	/** 按 `output_price` 计费的输出 token（Gemini：`candidatesTokenCount`+`thoughtsTokenCount`；OpenAI：completion 总量） */
	output_tokens: number;
	/** 缓存命中等按上游 usage 拆出的只读类 token */
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** 推理/thinking 分列（Gemini：thoughts，为计入 `output_tokens` 的子集；OpenAI：completion 内 reasoning 子集） */
	reasoning_tokens: number;
	total_tokens: number;
	/** Provider-reported counters; absent/null means no authoritative upstream evidence. */
	native_tokens_prompt?: number | null;
	native_tokens_completion?: number | null;
	native_tokens_cached?: number | null;
	native_tokens_reasoning?: number | null;
	native_tokens_completion_images?: number | null;
	/** 上游 usage 对象 JSON 字符串快照，便于审计 */
	raw_usage: string | null;
	/** Canonical tier reported by the upstream response; null means unavailable. */
	service_tier?: 'default' | 'flex' | 'priority' | null;
	/** OpenRouter-normalized reason the primary generation choice terminated. */
	finish_reason?: 'tool_calls' | 'stop' | 'length' | 'content_filter' | 'error' | null;
	/** Bounded provider-native reason for the same primary generation choice. */
	native_finish_reason?: string | null;
	/** Canonical text-generation speed reported by the upstream usage object. */
	speed?: 'fast' | 'standard' | null;
	/** TTS 上游返回的真实计费字符数；缺失时不按输入长度补算。 */
	audio_characters?: number;
	/** 实时 ASR 上游返回的真实计费时长（秒）。 */
	audio_duration_seconds?: number;
	/** 实时时长取自上游 usage，或网关验证过的 16-bit mono PCM 字节累计。 */
	audio_duration_source?: 'upstream' | 'client';
	/** 客户端在流结束前断开（如用户取消）时置位 */
	cancelled?: boolean;
	/** 上游流在终止事件前失败；用于把已返回 2xx headers 的半截流记为失败。 */
	stream_error?: string;
	/**
	 * 上游响应 body 里的「生成结果」id（OpenAI `chatcmpl-*` / Embeddings `embd-*` /
	 * Anthropic `msg_*` / Gemini `responseId`）。
	 * 与 header 侧 `upstreamRequestId` 语义不同：这是应用层 message id，穿透聚合商/CDN，随 usage 一起解析。
	 */
	upstreamMessageId?: string | null;
	/** Gemini 等上游 body 内非标准的 request id 字段（`requestId` / `request_id`），与 message id 区分 */
	upstreamBodyRequestId?: string | null;
}

export interface ProxyResult {
	/** Selected attempt's exact quote claim, available only on the opt-in Chat path. */
	quoteAttemptReference?: import('./shared-key-quote-attempt').SharedKeyQuoteAttemptReference | null;
	/** Registered upstream cleanup, independent from usage/accounting completion. */
	resourceCompletion?: import('./resource-completion').ResourceCompletion;
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	/** 上游响应头中的 provider 追踪 id（如 x-request-id） */
	upstreamRequestId: string | null;
	/** 实际选用或最后尝试的路由（用于日志）；若全部失败则为最后一次尝试 */
	chosenRoute: RouteResult;
	/** 本次请求触发的熔断事件（provider / user+model） */
	circuitEvents: GatewayCircuitAlertEvent[];
	/** 因已有熔断短路、无需重复 webhook 告警 */
	suppressErrorAlert: boolean;
	/** Images 等协议透传已解析字段，避免 route 侧重复 parse */
	meta?: ProxyDispatchMeta;
	/** Sticky routing observation for `route_trace` */
	stickyTrace?: (() => Promise<StickyTraceSnapshot>) | undefined;
	/** Background bind/touch mutations (schedule via waitUntil) */
	stickyMutationPromise?: Promise<unknown> | null;
	/** Sanitized request-level endpoint attempts, populated by failoverDispatch. */
	dispatchAttempts?: ProxyDispatchAttemptTrace[];
	dispatchBudget?: RequestDispatchBudgetSnapshot;
}

/** 无用量或解析失败时的零值占位（避免 undefined 传播）。 */
export const EMPTY_USAGE: UsageFromStream = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	reasoning_tokens: 0,
	total_tokens: 0,
	raw_usage: null,
};

function firstEventTimeoutMsFor(config: { timeoutMs: number; groups: string[] | '*' }, routeGroup: string): number {
	return resolveFirstEventTimeoutMs(config.timeoutMs, config.groups, routeGroup);
}

function textStreamDispatchOptions(
	firstEvent: { timeoutMs: number; groups: string[] | '*' },
	routeGroup: string,
	options?: FailoverDispatchOptions,
): FirstEventTimeoutOptions & StreamIdleClockOptions {
	return {
		firstEventTimeoutMs: firstEventTimeoutMsFor(firstEvent, routeGroup),
		firstChunkTimeoutMs: options?.firstChunkTimeoutMs,
		idleTimeoutMs: options?.idleTimeoutMs,
	};
}

export type AudioTranscriptionProxyOptions = FailoverDispatchOptions & {
	dashScope?: DashScopeAsrDispatchOptions;
};

export type AudioSpeechProxyOptions = FailoverDispatchOptions &
	Omit<AudioSpeechDispatchOptions, 'beforeUpstreamDispatch'>;
export type DashScopeRealtimeProxyOptions = FailoverDispatchOptions &
	Omit<DashScopeRealtimeDispatchOptions, 'beforeUpstreamDispatch'>;
export type ImageGenerationProxyOptions = FailoverDispatchOptions & {
	image?: { requireAuthoritativeUsage?: boolean; fetchImpl?: typeof fetch };
};

export type RouteRequestBody = Record<string, unknown> | ((route: RouteResult) => Record<string, unknown>);

function requestBodyForRoute(body: RouteRequestBody, route: RouteResult): Record<string, unknown> {
	return typeof body === 'function' ? body(route) : body;
}

/** Fetch-boundary counting is required even without a financial admission hook. */
function delegatedDispatchOptions(options?: FailoverDispatchOptions): FailoverDispatchOptions {
	return {
		affinityKey: '',
		tierKeyPrefix: '',
		strategy: DEFAULT_ROUTE_STRATEGY,
		...options,
		delegateBeforeUpstreamDispatchToDriver: true,
	};
}

/** Text model loops share the original timestamp; vector calls use the same dispatch ceiling. */
function textDispatchOptions(
	options: FailoverDispatchOptions | undefined,
	errorContext: NonNullable<FailoverDispatchOptions['errorContext']>,
): FailoverDispatchOptions {
	const deadlineAtMs = (options?.dispatchBudget?.createdAtMs ?? Date.now()) + TEXT_REQUEST_DEADLINE_MS;
	return {
		...delegatedDispatchOptions(options),
		errorContext,
		// Internal callers may tighten this ceiling, never extend it. This is
		// not populated from a client-controlled timeout/header.
		requestDeadlineAtMs: Math.min(options?.requestDeadlineAtMs ?? deadlineAtMs, deadlineAtMs),
	};
}

/** Optional stream configuration belongs to the same absolute preparation deadline. */
async function withTextStreamConfiguration(
 repos: GatewayRepositories, routes: readonly RouteResult[], requestSignal: AbortSignal | undefined,
 options: FailoverDispatchOptions | undefined,
 errorContext: NonNullable<FailoverDispatchOptions['errorContext']>,
 execute: (config: { timeoutMs: number; groups: string[] | '*' }, dispatchOptions: FailoverDispatchOptions) => Promise<ProxyResult>,
): Promise<ProxyResult> {
 const dispatchOptions = textDispatchOptions(options, errorContext);
 const resources = createResourceCompletionGroup();
 const signals = [requestSignal, options?.preparationControl?.signal].filter((signal): signal is AbortSignal => signal !== undefined);
 const parent = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
 const owner = createRequestDeadline(dispatchOptions.requestDeadlineAtMs!, parent, undefined, completion => {
  const task = completion.then(() => 'confirmed' as const, () => 'unconfirmed' as const);
  resources.track(task);
  options?.registerResourceCompletion?.(task);
 });
 let config: { timeoutMs: number; groups: string[] | '*' } = { timeoutMs: 0, groups: ['default'] };
 try {
  if (routes.length) config = await preparationRead(owner, () => loadFirstEventTimeoutConfig(repos));
 } catch {
  // Cancellation/deadline is revalidated by dispatchOptions before any dispatch.
 } finally { owner.dispose(); resources.seal(); }
 const result = await execute(config, dispatchOptions);
 return { ...result, resourceCompletion: Promise.all([result.resourceCompletion ?? Promise.resolve('confirmed' as const), resources.completion]).then(values => values.every(value => value === 'confirmed') ? 'confirmed' : 'unconfirmed') };
}

/**
 * 代理 OpenAI Chat Completions：外层 provider 优先级 + 层内 route strategy failover。
 */
export async function proxyChatCompletions(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: RouteRequestBody,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	publicCorrelationId?: string,
): Promise<ProxyResult> {
	return withTextStreamConfiguration(repos, routes, requestSignal, options, { skin: 'chat', requestId: publicCorrelationId }, async (firstEvent, dispatchOptions) => {
	const result = await failoverDispatch(
		repos,
		routes,
		'openai',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
			upstreamHeadersObserved?: (status: number) => void,
		) =>
			dispatchOpenAiRoute(
				route,
				requestBodyForRoute(body, route),
				signal,
				timing,
				attempt,
				beforeFetch,
				publicCorrelationId,
				auxiliaryAuth,
				upstreamHeadersObserved,
				textStreamDispatchOptions(firstEvent, route.routeGroup, options),
			),
		requestSignal,
		dispatchOptions,
	);
	return result;
	});
}

/**
 * 代理 OpenAI Responses API。
 */
export async function proxyResponses(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: RouteRequestBody,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	publicCorrelationId?: string,
): Promise<ProxyResult> {
	return withTextStreamConfiguration(repos, routes, requestSignal, options, { skin: 'responses', requestId: publicCorrelationId }, async (firstEvent, dispatchOptions) => {
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) =>
			dispatchOpenAiResponsesRoute(
				route,
				requestBodyForRoute(body, route),
				signal,
				timing,
				attempt,
				beforeFetch,
				publicCorrelationId,
				auxiliaryAuth,
				textStreamDispatchOptions(firstEvent, route.routeGroup, options),
			),
		requestSignal,
		dispatchOptions,
	);
	});
}

/** Proxy OpenAI-compatible embeddings with provider failover before a paid response is accepted. */
export async function proxyEmbeddings(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	publicCorrelationId?: string,
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing, attempt, beforeFetch, auxiliaryAuth) =>
			dispatchOpenAiEmbeddingsRoute(
				route,
				body,
				signal,
				timing,
				attempt,
				beforeFetch,
				publicCorrelationId,
				auxiliaryAuth,
			),
		requestSignal,
		textDispatchOptions(options, { skin: 'chat', requestId: publicCorrelationId }),
	);
}

/** Proxy OpenRouter-compatible rerank requests with pre-response provider failover. */
export async function proxyRerank(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	publicCorrelationId?: string,
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing, attempt, beforeFetch, auxiliaryAuth) =>
			dispatchOpenAiRerankRoute(route, body, signal, timing, attempt, beforeFetch, publicCorrelationId, auxiliaryAuth),
		requestSignal,
		textDispatchOptions(options, { skin: 'chat', requestId: publicCorrelationId }),
	);
}

/**
 * 代理 Anthropic Messages API。
 */
export async function proxyAnthropicMessages(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: RouteRequestBody,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
	publicCorrelationId?: string,
): Promise<ProxyResult> {
	return withTextStreamConfiguration(repos, routes, requestSignal, options, { skin: 'anthropic', requestId: publicCorrelationId }, async (firstEvent, dispatchOptions) => {
	return failoverDispatch(
		repos,
		routes,
		'anthropic',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) =>
			dispatchAnthropicRoute(
				route,
				requestBodyForRoute(body, route),
				signal,
				timing,
				attempt,
				beforeFetch,
				publicCorrelationId,
				auxiliaryAuth,
				textStreamDispatchOptions(firstEvent, route.routeGroup, options),
			),
		requestSignal,
		dispatchOptions,
	);
	});
}

/**
 * 代理 OpenAI Images Generations。
 */
export async function proxyImageGenerations(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: ImageGenerationProxyOptions,
): Promise<ProxyResult> {
	const deadlineAtMs = (options?.dispatchBudget?.createdAtMs ?? Date.now()) + IMAGE_GENERATION_TIMEOUT_MS;
	// Images owns its SSE/cancellation settlement. Do not install the text
	// response wrapper, which would discard the image-specific abort reason.
	const { requestDeadlineAtMs, ...dispatchOptions } = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		['openai', 'dashscope', 'minimax', 'volcengine', 'gemini'],
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: (preparedAttempt?: unknown) => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) =>
			dispatchImageGenerations(
				route,
				body,
				signal,
				timing,
				attempt,
				{
					fetchImpl: options?.image?.fetchImpl,
					requireAuthoritativeUsage: options?.image?.requireAuthoritativeUsage,
					requestId: options?.errorContext?.requestId,
					auxiliaryAuth,
					deadlineAtMs: Math.min(requestDeadlineAtMs ?? deadlineAtMs, deadlineAtMs),
				},
				beforeFetch,
			),
		requestSignal,
		dispatchOptions,
	);
}

/**
 * 代理 OpenAI Images Edits（multipart；每次 attempt 重建 FormData）。
 */
export async function proxyImageEdits(
	repos: GatewayRepositories,
	routes: RouteResult[],
	edit: NormalizedImageEditRequest,
	requestSignal?: AbortSignal,
	options?: ImageGenerationProxyOptions,
): Promise<ProxyResult> {
	const deadlineAtMs = (options?.dispatchBudget?.createdAtMs ?? Date.now()) + IMAGE_GENERATION_TIMEOUT_MS;
	const { requestDeadlineAtMs, ...dispatchOptions } = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: (preparedAttempt?: unknown) => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) =>
			dispatchOpenAiImageEdits(
				route,
				edit,
				signal,
				timing,
				attempt,
				{
					fetchImpl: options?.image?.fetchImpl,
					auxiliaryAuth,
					deadlineAtMs: Math.min(requestDeadlineAtMs ?? deadlineAtMs, deadlineAtMs),
				},
				beforeFetch,
			),
		requestSignal,
		dispatchOptions,
	);
}

/**
 * 代理 OpenAI Audio Transcriptions（multipart；每次 attempt 重建 FormData）。
 */
export async function proxyAudioTranscriptions(
	repos: GatewayRepositories,
	routes: RouteResult[],
	req: NormalizedAudioTranscriptionRequest,
	requestSignal?: AbortSignal,
	options?: AudioTranscriptionProxyOptions,
): Promise<ProxyResult> {
	const deadlineAtMs = (options?.dispatchBudget?.createdAtMs ?? Date.now()) + AUDIO_TRANSCRIPTION_TIMEOUT_MS;
	const { requestDeadlineAtMs, ...dispatchOptions } = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		['openai', 'dashscope', 'minimax'],
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) => {
			const asrOptions: DashScopeAsrDispatchOptions = {
				...options?.dashScope,
				beforeUpstreamDispatch: beforeFetch,
				auxiliaryAuth,
				deadlineAtMs: Math.min(requestDeadlineAtMs ?? deadlineAtMs, deadlineAtMs),
			};
			if (route.adapter === 'passthrough' && route.upstreamProtocol === 'openai') {
				return dispatchOpenAiAudioTranscriptions(route, req, signal, timing, attempt, {
					auxiliaryAuth,
					beforeUpstreamDispatch: beforeFetch,
					deadlineAtMs: asrOptions.deadlineAtMs,
				});
			}
			if (
				route.adapter === 'dashscope-asr-qwen-file' ||
				route.adapter === 'dashscope-asr-qwen-audio-file' ||
				route.adapter === 'dashscope-asr-fun-file'
			) {
				return dispatchDashScopeSyncAsr(route, req, signal, timing, attempt, asrOptions);
			}
			if (route.adapter === 'dashscope-asr-file-async') {
				return dispatchDashScopeAsyncAsr(route, req, signal, timing, attempt, asrOptions);
			}
			return dispatchAudioTranscriptions(route, req, signal, timing, attempt, asrOptions);
		},
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 OpenAI Audio Speech，并按显式 adapter 转到 DashScope 或 MiniMax 官方语音合成。 */
export async function proxyAudioSpeech(
	repos: GatewayRepositories,
	routes: RouteResult[],
	request: NormalizedAudioSpeechRequest,
	requestSignal?: AbortSignal,
	options?: AudioSpeechProxyOptions,
): Promise<ProxyResult> {
	const deadlineAtMs = (options?.dispatchBudget?.createdAtMs ?? Date.now()) + AUDIO_SPEECH_TIMEOUT_MS;
	const { requestDeadlineAtMs, ...dispatchOptions } = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		['openai', 'dashscope', 'minimax'],
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) => {
			const speechOptions: AudioSpeechDispatchOptions = {
				...options,
				beforeUpstreamDispatch: beforeFetch,
				auxiliaryAuth,
				deadlineAtMs: Math.min(options?.deadlineAtMs ?? Infinity, requestDeadlineAtMs ?? deadlineAtMs, deadlineAtMs),
			};
			if (route.adapter === 'passthrough' && route.upstreamProtocol === 'openai') {
				return dispatchOpenAiAudioSpeech(route, request, signal, timing, attempt, speechOptions);
			}
			if (route.adapter === 'dashscope-tts-speech') {
				return dispatchDashScopeSpeechSynthesizer(route, request, signal, timing, attempt, speechOptions);
			}
			if (route.adapter === 'dashscope-tts-qwen') {
				return dispatchDashScopeQwenTts(route, request, signal, timing, attempt, speechOptions);
			}
			if (route.adapter === 'dashscope-tts-minimax') {
				return dispatchDashScopeMiniMaxTts(route, request, signal, timing, attempt, speechOptions);
			}
			return dispatchAudioSpeech(route, request, signal, timing, attempt, speechOptions);
		},
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 DashScope 同步多模态 ASR HTTP 透传（原生 JSON，不转 OpenAI transcriptions）。 */
export async function proxyDashScopeMultimodalPassthrough(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: AudioTranscriptionProxyOptions,
): Promise<ProxyResult> {
	const deadlineAtMs = (options?.dispatchBudget?.createdAtMs ?? Date.now()) + AUDIO_TRANSCRIPTION_TIMEOUT_MS;
	const { requestDeadlineAtMs, ...dispatchOptions } = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'dashscope',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) => {
			const asrOptions: DashScopeAsrDispatchOptions = {
				...options?.dashScope,
				beforeUpstreamDispatch: beforeFetch,
				auxiliaryAuth,
				deadlineAtMs: Math.min(requestDeadlineAtMs ?? deadlineAtMs, deadlineAtMs),
			};
			if (route.adapter !== 'passthrough' || route.upstreamOperation !== 'audio.transcriptions.multimodal') {
				throw new Error(`Unsupported DashScope multimodal adapter: ${route.adapter}`);
			}
			return dispatchDashScopeMultimodalPassthrough(route, body, signal, timing, attempt, asrOptions);
		},
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 DashScope 原生 JSON / SSE 透传（语音合成、生图、异步转写）。 */
export async function proxyDashScopeJsonPassthrough(
	repos: GatewayRepositories,
	routes: RouteResult[],
	surface: DashScopePassthroughSurface,
	body: Record<string, unknown> | null,
	requestSignal?: AbortSignal,
	options?: AudioTranscriptionProxyOptions & { dashScopeJson?: DashScopeJsonPassthroughOptions },
): Promise<ProxyResult> {
	const dispatchOptions = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'dashscope',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt, beforeFetch?: () => Promise<void>, auxiliaryAuth?: RequestAuxiliaryAuthBudget) =>
			dispatchDashScopeJsonPassthroughRoute(route, surface, body, signal, timing, attempt, { ...options?.dashScopeJson, beforeUpstreamDispatch: beforeFetch, auxiliaryAuth, deadlineAtMs: options?.requestDeadlineAtMs }),
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 Gemini 原生图片模型（generateContent / streamGenerateContent）。 */
export async function proxyGeminiImagePassthrough(
	repos: GatewayRepositories,
	routes: RouteResult[],
	action: GeminiImageAction,
	body: Record<string, unknown>,
	search: string,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions & { geminiImage?: GeminiImagePassthroughOptions },
): Promise<ProxyResult> {
	const dispatchOptions = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'gemini',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt, beforeFetch?: () => Promise<void>, auxiliaryAuth?: RequestAuxiliaryAuthBudget) =>
			dispatchGeminiImagePassthroughRoute(route, action, body, search, signal, timing, attempt, { ...options?.geminiImage, beforeUpstreamDispatch: beforeFetch, auxiliaryAuth, deadlineAtMs: options?.requestDeadlineAtMs }),
		requestSignal,
		dispatchOptions,
	);
}

/** 代理火山方舟 / BytePlus Seedream 生图透传（JSON 或 SSE）。 */
export async function proxyVolcengineJsonPassthrough(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: AudioTranscriptionProxyOptions & { volcengineJson?: VolcengineJsonPassthroughOptions },
): Promise<ProxyResult> {
	const dispatchOptions = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'volcengine',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt, beforeFetch?: () => Promise<void>, auxiliaryAuth?: RequestAuxiliaryAuthBudget) =>
			dispatchVolcengineJsonPassthroughRoute(route, body, signal, timing, attempt, { ...options?.volcengineJson, beforeUpstreamDispatch: beforeFetch, auxiliaryAuth, deadlineAtMs: options?.requestDeadlineAtMs }),
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 MiniMax 原生 JSON / SSE 透传（语音合成、生图）。 */
export async function proxyMiniMaxJsonPassthrough(
	repos: GatewayRepositories,
	routes: RouteResult[],
	operation: MiniMaxJsonPassthroughOperation,
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: AudioTranscriptionProxyOptions & { miniMaxJson?: MiniMaxJsonPassthroughOptions },
): Promise<ProxyResult> {
	const dispatchOptions = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'minimax',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt, beforeFetch?: () => Promise<void>, auxiliaryAuth?: RequestAuxiliaryAuthBudget) =>
			dispatchMiniMaxJsonPassthroughRoute(route, operation, body, signal, timing, attempt, { ...options?.miniMaxJson, beforeUpstreamDispatch: beforeFetch, auxiliaryAuth, deadlineAtMs: options?.requestDeadlineAtMs }),
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 MiniMax 原生 ASR 透传（multipart，不转 OpenAI transcriptions）。 */
export async function proxyMiniMaxAsrPassthrough(
	repos: GatewayRepositories,
	routes: RouteResult[],
	request: MiniMaxAsrPassthroughRequest,
	requestSignal?: AbortSignal,
	options?: AudioTranscriptionProxyOptions,
): Promise<ProxyResult> {
	const dispatchOptions = delegatedDispatchOptions(options);
	return failoverDispatch(
		repos,
		routes,
		'minimax',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt, beforeFetch?: () => Promise<void>, auxiliaryAuth?: RequestAuxiliaryAuthBudget) =>
			dispatchMiniMaxSpeechPassthrough(route, request, signal, timing, attempt, { beforeUpstreamDispatch: beforeFetch, auxiliaryAuth, deadlineAtMs: options?.requestDeadlineAtMs }),
		requestSignal,
		dispatchOptions,
	);
}

/** 代理 DashScope 原生实时音频 WebSocket，建连失败时按普通路由规则切换供应商。 */
export async function proxyDashScopeRealtime(
	repos: GatewayRepositories,
	routes: RouteResult[],
	operation: DashScopeRealtimeOperation,
	requestSignal?: AbortSignal,
	options?: DashScopeRealtimeProxyOptions,
): Promise<ProxyResult> {
	// This is a connection-only ceiling. The generic HTTP owner cannot clone
	// or materialize a Workers 101 response; session lifetime has its own owner.
	const { requestDeadlineAtMs, ...dispatchOptions } = delegatedDispatchOptions(options);
	const connectDeadlineAtMs = Math.min(
		options?.connectDeadlineAtMs ?? Infinity,
		options?.sessionLimits?.connectDeadlineAtMs ?? Infinity,
		requestDeadlineAtMs ?? Infinity,
		(options?.dispatchBudget?.createdAtMs ?? Date.now()) + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
	);
	return failoverDispatch(
		repos,
		routes,
		'dashscope',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) =>
			dispatchDashScopeRealtime(route, operation, signal, timing, attempt, {
				...options,
				connectDeadlineAtMs,
				auxiliaryAuth,
				beforeUpstreamDispatch: beforeFetch,
			}),
		requestSignal,
		dispatchOptions,
	);
}

/**
 * 代理 Gemini `generateContent` / `streamGenerateContent`。
 */
export async function proxyGeminiContent(
	repos: GatewayRepositories,
	routes: RouteResult[],
	action: 'generateContent' | 'streamGenerateContent',
	body: Record<string, unknown>,
	search: string,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions,
): Promise<ProxyResult> {
	return withTextStreamConfiguration(repos, routes, requestSignal, options, options?.errorContext ?? { skin: 'chat' }, async (firstEvent, dispatchOptions) => {
	return failoverDispatch(
		repos,
		routes,
		'gemini',
		(
			route,
			signal,
			timing?: RequestTimingCollector | null,
			attempt?: RequestTimingAttempt,
			beforeFetch?: () => Promise<void>,
			auxiliaryAuth?: RequestAuxiliaryAuthBudget,
		) => dispatchGeminiRoute(route, body, action, search, signal, timing, attempt, beforeFetch, auxiliaryAuth, textStreamDispatchOptions(firstEvent, route.routeGroup, options)),
		requestSignal,
		dispatchOptions,
	);
	});
}
