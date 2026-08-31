/**
 * DashScope 原生实时音频 WebSocket 驱动：
 * - inference：Fun-ASR / Paraformer / CosyVoice / Sambert 的 run-task 生命周期。
 * - session：Qwen-ASR-Realtime / Qwen-TTS-Realtime 的 session 生命周期。
 *
 * 对外保持 DashScope 原生事件，网关只替换供应商模型名、转发帧并汇总真实 usage。
 */
import { resolveProviderUpstreamSecret } from "@octafuse/core";
import { resolveUpstreamEndpoint } from "@octafuse/core/provider-endpoints";
import {
	markUpstreamOutcomeUnknown,
	type ProxyDispatchResult,
} from "../failover-dispatch";
import type { RouteResult } from "../model-router";
import { EMPTY_USAGE, type UsageFromStream } from "../proxy";
import type {
	RequestTimingAttempt,
	RequestTimingCollector,
} from "../request-timing";
import { buildRouteRequestBody } from "../route-default-params";
import { extractUpstreamRequestId } from "./upstream-request-id";

export const DASHSCOPE_REALTIME_OPERATIONS = [
	"audio.transcriptions.realtime.inference",
	"audio.transcriptions.realtime.session",
	"audio.speech.realtime.inference",
	"audio.speech.realtime.session",
] as const;

export type DashScopeRealtimeOperation =
	(typeof DASHSCOPE_REALTIME_OPERATIONS)[number];

type JsonObject = Record<string, unknown>;

type UsageSnapshot = {
	duration: number;
	hasDuration: boolean;
	characters: number;
	hasCharacters: boolean;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	raw: unknown;
};

export type DashScopeRealtimeDispatchOptions = {
	fetchImpl?: typeof fetch;
	/** 浏览器通过 Sec-WebSocket-Protocol 鉴权时，回写被选中的 token。 */
	responseProtocol?: string;
	/** Node 运行时的 upgrade 适配器；Worker 继续使用 WebSocketPair。 */
	nodeDispatch?: DashScopeRealtimeNodeDispatch;
	/** 有限预算会话的本地硬上界；由入口在预授权后注入。 */
	sessionLimits?: DashScopeRealtimeSessionLimits;
	/** Invoked immediately before the first network attempt; must be idempotent across failover. */
	beforeUpstreamDispatch?: () => Promise<void>;
};

export type DashScopeRealtimeNodeDispatch = (
	route: RouteResult,
	operation: DashScopeRealtimeOperation,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	sessionLimits?: DashScopeRealtimeSessionLimits,
	beforeUpstreamDispatch?: () => Promise<void>,
) => Promise<ProxyDispatchResult>;

export type DashScopeRealtimeSessionLimits = {
	/** The upstream connection deadline is budgeted separately from this wall-clock cap. */
	maxSessionMs: number;
	/** Absolute deadline shared by every failover attempt. */
	connectDeadlineAtMs: number;
	/** Exact PCM input-duration ceiling for ASR operations. */
	maxAudioDurationSeconds: number;
	/** Provider-reported duration must remain inside the amount reserved at admission. */
	maxBillableAudioDurationSeconds: number;
	/** Conservative UTF-16 code-unit ceiling for every client string sent to TTS. */
	maxTextCharacters: number;
	/** A single client frame is rejected before JSON/base64 processing above this bound. */
	maxClientMessageBytes: number;
	/** Cumulative encoded client bytes accepted during the whole session. */
	maxClientBytes: number;
	/** Compressed audio has no locally provable duration bound and is rejected when true. */
	requirePcmAudio: boolean;
};

export type DashScopeRealtimeLimitDecision =
	| { ok: true }
	| { ok: false; reason: string };

export const DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DASHSCOPE_REALTIME_MAX_PROVIDER_BYTES = 32 * 1024 * 1024;

export type DashScopeRealtimeOutputDecision =
	| { ok: true; messageBytes: number }
	| { ok: false; reason: string };

function asObject(value: unknown): JsonObject | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

function eventName(event: JsonObject): string {
	const header = asObject(event.header);
	// DashScope inference 客户端命令使用 header.action，服务端事件使用 header.event。
	if (typeof header?.action === "string") return header.action;
	if (typeof header?.event === "string") return header.event;
	return typeof event.type === "string" ? event.type : "";
}

type ClientEventDiscriminator =
	| { ok: true; name: string }
	| { ok: false; reason: string };

/**
 * DashScope exposes two incompatible client protocols. Inference commands are
 * discriminated only by `header.action`; session commands are discriminated
 * only by the top-level `type`. A best-effort union lets a foreign
 * discriminator mask a billable session event.
 */
function clientEventDiscriminator(
	operation: DashScopeRealtimeOperation,
	event: JsonObject,
): ClientEventDiscriminator {
	const header = asObject(event.header);
	if (isSessionOperation(operation)) {
		if (
			Object.hasOwn(event, "header") &&
			(header == null || Object.hasOwn(header, "action") || Object.hasOwn(header, "event"))
		) {
			return {
				ok: false,
				reason: "Realtime session event contains a conflicting discriminator",
			};
		}
		const name = typeof event.type === "string" ? event.type.trim() : "";
		return name
			? { ok: true, name }
			: { ok: false, reason: "Realtime session event requires a top-level type" };
	}

	if (Object.hasOwn(event, "type") || (header != null && Object.hasOwn(header, "event"))) {
		return {
			ok: false,
			reason: "Realtime inference event contains a conflicting discriminator",
		};
	}
	const name = typeof header?.action === "string" ? header.action.trim() : "";
	return name
		? { ok: true, name }
		: { ok: false, reason: "Realtime inference event requires header.action" };
}

function eventUsage(event: JsonObject): JsonObject | null {
	const payload = asObject(event.payload);
	const response = asObject(event.response);
	return (
		asObject(payload?.usage) ??
		asObject(response?.usage) ??
		asObject(event.usage)
	);
}

function usageKey(event: JsonObject): string {
	const header = asObject(event.header);
	if (typeof header?.task_id === "string" && header.task_id) {
		return `task:${header.task_id}`;
	}
	const response = asObject(event.response);
	if (typeof response?.id === "string" && response.id)
		return `response:${response.id}`;
	if (typeof event.response_id === "string" && event.response_id) {
		return `response:${event.response_id}`;
	}
	return "connection";
}

function eventFailureMessage(event: JsonObject, name: string): string | null {
	if (name !== "task-failed" && name !== "error") return null;
	const header = asObject(event.header);
	const payload = asObject(event.payload);
	const error = asObject(event.error);
	const message =
		(typeof header?.error_message === "string" && header.error_message) ||
		(typeof payload?.message === "string" && payload.message) ||
		(typeof error?.message === "string" && error.message) ||
		(typeof event.message === "string" && event.message);
	return message || `DashScope realtime event ${name}`;
}

/** 从原生服务端事件中按 task/response 累计真实计费 usage。 */
export class DashScopeRealtimeUsageCollector {
	private readonly snapshots = new Map<string, UsageSnapshot>();
	private completed = false;
	private failure: string | null = null;

	/** Any newly forwarded client command makes a previous terminal event stale. */
	observeClientActivity(): void {
		this.completed = false;
	}

	observeServerMessage(message: string): void {
		let event: JsonObject;
		try {
			const parsed = JSON.parse(message) as unknown;
			const object = asObject(parsed);
			if (!object) return;
			event = object;
		} catch {
			return;
		}

		const name = eventName(event);
		if (
			name === "task-finished" ||
			name === "session.finished" ||
			name === "response.done"
		) {
			this.completed = true;
		}
		this.failure = eventFailureMessage(event, name) ?? this.failure;

		const usage = eventUsage(event);
		if (!usage) return;
		this.snapshots.set(usageKey(event), {
			duration: finiteNonNegative(usage.duration),
			hasDuration:
				typeof usage.duration === "number" &&
				Number.isFinite(usage.duration) &&
				usage.duration >= 0,
			characters: finiteNonNegative(usage.characters),
			hasCharacters:
				typeof usage.characters === "number" &&
				Number.isFinite(usage.characters) &&
				usage.characters >= 0,
			inputTokens: finiteNonNegative(usage.input_tokens),
			outputTokens: finiteNonNegative(usage.output_tokens),
			totalTokens: finiteNonNegative(usage.total_tokens),
			raw: usage,
		});
	}

	toUsage(options: {
		clientClosedFirst: boolean;
		transportError?: string | null;
	}): UsageFromStream {
		let duration = 0;
		let hasDuration = this.snapshots.size > 0;
		let characters = 0;
		let hasCharacters = this.snapshots.size > 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let totalTokens = 0;
		const rawSources: unknown[] = [];
		for (const snapshot of this.snapshots.values()) {
			duration += snapshot.duration;
			hasDuration &&= snapshot.hasDuration;
			characters += snapshot.characters;
			hasCharacters &&= snapshot.hasCharacters;
			inputTokens += snapshot.inputTokens;
			outputTokens += snapshot.outputTokens;
			totalTokens += snapshot.totalTokens;
			rawSources.push(snapshot.raw);
		}
		// 上游正常关闭并不等于任务成功；必须收到协议终态，避免把被截断的音频误记为成功。
		const incompleteUpstream =
			!this.completed && !options.clientClosedFirst
				? "Upstream WebSocket closed before a terminal event"
				: undefined;
		const streamError =
			this.failure ?? options.transportError ?? incompleteUpstream;
		return {
			...EMPTY_USAGE,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			total_tokens: totalTokens || inputTokens + outputTokens,
			raw_usage:
				rawSources.length > 0 ? JSON.stringify({ sources: rawSources }) : null,
			...(hasDuration
				? {
						audio_duration_seconds: duration,
						audio_duration_source: "upstream" as const,
					}
				: {}),
			...(hasCharacters ? { audio_characters: characters } : {}),
			cancelled: options.clientClosedFirst && !this.completed && !streamError,
			stream_error: streamError,
		};
	}
}

export function enforceDashScopeRealtimeUsageCeiling(
	operation: DashScopeRealtimeOperation,
	limits: DashScopeRealtimeSessionLimits | undefined,
	usage: UsageFromStream,
): UsageFromStream {
	if (!limits) return usage;
	const exceeded = isTranscriptionOperation(operation)
		? (usage.audio_duration_seconds ?? 0) > limits.maxBillableAudioDurationSeconds
		: (usage.audio_characters ?? 0) > limits.maxTextCharacters;
	if (!exceeded) return usage;
	return {
		...usage,
		cancelled: false,
		stream_error: usage.stream_error ?? "Upstream usage exceeded the reserved realtime ceiling",
	};
}

function isInferenceOperation(operation: DashScopeRealtimeOperation): boolean {
	return operation.endsWith(".inference");
}

function isSessionOperation(operation: DashScopeRealtimeOperation): boolean {
	return operation.endsWith(".session");
}

function isTranscriptionOperation(operation: DashScopeRealtimeOperation): boolean {
	return operation.startsWith("audio.transcriptions.");
}

function clientFrameByteLength(data: unknown): number | null {
	if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	return null;
}

/** Bounds provider-controlled WebSocket output before it is queued to a client. */
export class DashScopeRealtimeOutputLimiter {
	private providerBytes = 0;

	constructor(
		private readonly maxMessageBytes = DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES,
		private readonly maxBytes = DASHSCOPE_REALTIME_MAX_PROVIDER_BYTES,
	) {}

	inspect(data: unknown): DashScopeRealtimeOutputDecision {
		const messageBytes = clientFrameByteLength(data);
		if (messageBytes == null) return { ok: false, reason: 'Unsupported realtime provider frame type' };
		if (messageBytes > this.maxMessageBytes) return { ok: false, reason: 'Realtime provider frame is too large' };
		this.providerBytes += messageBytes;
		if (this.providerBytes > this.maxBytes) return { ok: false, reason: 'Realtime cumulative provider data limit exceeded' };
		return { ok: true, messageBytes };
	}
}

function decodedBase64ByteLength(value: string): number | null {
	if (value.length === 0) return 0;
	if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function countStringCodeUnits(value: unknown, depth = 0): number | null {
	if (depth > 24) return null;
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		let total = 0;
		for (const item of value) {
			const count = countStringCodeUnits(item, depth + 1);
			if (count == null || total > Number.MAX_SAFE_INTEGER - count) return null;
			total += count;
		}
		return total;
	}
	const object = asObject(value);
	if (!object) return 0;
	let total = 0;
	for (const item of Object.values(object)) {
		const count = countStringCodeUnits(item, depth + 1);
		if (count == null || total > Number.MAX_SAFE_INTEGER - count) return null;
		total += count;
	}
	return total;
}

/**
 * Stateful, per-connection limiter. It is deliberately instantiated inside a
 * dispatch, never in module scope. For budgeted ASR it accepts only mono
 * 16-bit PCM, whose duration is exactly bytes / (sample_rate * 2).
 */
export class DashScopeRealtimeSessionLimiter {
	private readonly startedAtMs: number;
	private audioDurationSeconds = 0;
	private textCharacters = 0;
	private clientBytes = 0;
	private audioFormat = "pcm";
	private sampleRate = 16_000;
	private inferenceAudioConfigured = false;
	private inferenceTaskStarted = false;
	private audioStarted = false;

	constructor(
		private readonly operation: DashScopeRealtimeOperation,
		private readonly limits: DashScopeRealtimeSessionLimits,
		nowMs = Date.now(),
		private readonly providerModelName = "",
	) {
		this.startedAtMs = nowMs;
	}

	measuredAudioDurationSeconds(): number {
		return this.audioDurationSeconds;
	}

	/** Conservatively measured UTF-16 code units from client TTS events accepted upstream. */
	measuredTextCharacters(): number {
		return this.textCharacters;
	}

	remainingSessionMs(nowMs = Date.now()): number {
		return Math.max(0, this.limits.maxSessionMs - (nowMs - this.startedAtMs));
	}

	inspect(data: unknown, nowMs = Date.now()): DashScopeRealtimeLimitDecision {
		if (this.remainingSessionMs(nowMs) <= 0) {
			return { ok: false, reason: "Realtime session duration limit exceeded" };
		}
		const frameBytes = clientFrameByteLength(data);
		if (frameBytes == null) {
			return { ok: false, reason: "Unsupported realtime WebSocket frame type" };
		}
		if (frameBytes > this.limits.maxClientMessageBytes) {
			return { ok: false, reason: "Realtime client frame is too large" };
		}
		this.clientBytes += frameBytes;
		if (this.clientBytes > this.limits.maxClientBytes) {
			return { ok: false, reason: "Realtime cumulative client data limit exceeded" };
		}

		if (typeof data !== "string") {
			if (!isTranscriptionOperation(this.operation) || isSessionOperation(this.operation)) {
				return { ok: false, reason: "Binary client frames are not supported for this realtime operation" };
			}
			return this.observePcmBytes(frameBytes);
		}

		let event: JsonObject;
		try {
			const parsed = asObject(JSON.parse(data) as unknown);
			if (!parsed) return { ok: false, reason: "Realtime client events must be JSON objects" };
			event = parsed;
		} catch {
			return { ok: false, reason: "Realtime client event is not valid JSON" };
		}
		const discriminator = clientEventDiscriminator(this.operation, event);
		if (!discriminator.ok) return discriminator;
		const startsInferenceTask =
			isInferenceOperation(this.operation) && discriminator.name === "run-task";
		if (startsInferenceTask) {
			if (this.inferenceTaskStarted) {
				return { ok: false, reason: "Realtime inference allows one task per connection" };
			}
		}

		let decision: DashScopeRealtimeLimitDecision;
		if (!isTranscriptionOperation(this.operation)) {
			const characters = countStringCodeUnits(event);
			if (characters == null) {
				return { ok: false, reason: "Realtime TTS event exceeds the safe scan depth" };
			}
			this.textCharacters += characters;
			if (this.textCharacters > this.limits.maxTextCharacters) {
				return { ok: false, reason: "Realtime text character limit exceeded" };
			}
			decision = { ok: true };
		} else {
			decision = isSessionOperation(this.operation)
				? this.inspectTranscriptionSessionEvent(event, discriminator.name)
				: this.inspectTranscriptionInferenceEvent(event, discriminator.name);
		}
		if (decision.ok && startsInferenceTask) this.inferenceTaskStarted = true;
		return decision;
	}

	private inspectTranscriptionInferenceEvent(
		event: JsonObject,
		name: string,
	): DashScopeRealtimeLimitDecision {
		if (name !== "run-task") return { ok: true };
		const parameters = asObject(asObject(event.payload)?.parameters);
		const format = typeof parameters?.format === "string"
			? parameters.format.trim().toLowerCase()
			: "";
		const sampleRate = finiteNonNegative(parameters?.sample_rate);
		if (this.limits.requirePcmAudio && format !== "pcm") {
			return { ok: false, reason: "Budgeted realtime ASR requires PCM input" };
		}
		if (this.limits.requirePcmAudio && sampleRate <= 0) {
			return { ok: false, reason: "Budgeted realtime ASR requires an explicit sample rate" };
		}
		if (format) this.audioFormat = format;
		if (sampleRate > 0) this.sampleRate = sampleRate;
		if (!Number.isInteger(this.sampleRate) || this.sampleRate < 1_000 || this.sampleRate > 384_000) {
			return { ok: false, reason: "Realtime ASR sample rate is outside the supported billing range" };
		}
		const model = this.providerModelName.trim().toLowerCase();
		const isEightKhzModel = /(?:^|[-_])8k(?:[-_]|$)/u.test(model);
		if (isEightKhzModel && this.sampleRate !== 8_000) {
			return { ok: false, reason: "This realtime ASR model requires an 8000 Hz sample rate" };
		}
		const isParaformerV1 = model.startsWith("paraformer-realtime-v1");
		if (isParaformerV1 && this.sampleRate !== 16_000) {
			return { ok: false, reason: "Paraformer realtime v1 requires a 16000 Hz sample rate" };
		}
		const hasDocumentedArbitrarySampleRate =
			model.startsWith("fun-asr-realtime") ||
			model.startsWith("fun-asr-mtl-realtime") ||
			(model.startsWith("fun-asr-flash-") && !isEightKhzModel) ||
			model.startsWith("paraformer-realtime-v2") ||
			model.startsWith("qwen-audio-3.0-asr-flash-streaming");
		if (
			this.limits.requirePcmAudio &&
			!isEightKhzModel &&
			!isParaformerV1 &&
			!hasDocumentedArbitrarySampleRate
		) {
			return {
				ok: false,
				reason: "Realtime ASR model sample-rate semantics cannot be safely verified",
			};
		}
		this.inferenceAudioConfigured = true;
		return { ok: true };
	}

	private inspectTranscriptionSessionEvent(
		event: JsonObject,
		name: string,
	): DashScopeRealtimeLimitDecision {
		if (name === "session.update") {
			const session = asObject(event.session);
			if (
				session != null &&
				Object.hasOwn(session, "input_audio_format") &&
				typeof session.input_audio_format !== "string"
			) {
				return { ok: false, reason: "Realtime ASR input audio format must be a string" };
			}
			const nextFormat = typeof session?.input_audio_format === "string"
				? session.input_audio_format.trim().toLowerCase()
				: this.audioFormat;
			const requestedRate = finiteNonNegative(session?.sample_rate);
			if (
				session != null &&
				Object.hasOwn(session, "sample_rate") &&
				requestedRate <= 0
			) {
				return { ok: false, reason: "Realtime ASR session sample rate must be a positive number" };
			}
			const nextRate = requestedRate > 0 ? requestedRate : this.sampleRate;
			if (this.limits.requirePcmAudio && nextFormat !== "pcm") {
				return { ok: false, reason: "Budgeted realtime ASR requires PCM input" };
			}
			if (!Number.isInteger(nextRate) || (nextRate !== 8_000 && nextRate !== 16_000)) {
				return { ok: false, reason: "Realtime ASR session sample rate must be 8000 or 16000 Hz" };
			}
			if (this.audioStarted && (nextFormat !== this.audioFormat || nextRate !== this.sampleRate)) {
				return { ok: false, reason: "Realtime ASR audio format cannot change after audio starts" };
			}
			this.audioFormat = nextFormat;
			this.sampleRate = nextRate;
			return { ok: true };
		}
		if (name !== "input_audio_buffer.append") return { ok: true };
		if (this.limits.requirePcmAudio && this.audioFormat !== "pcm") {
			return { ok: false, reason: "Budgeted realtime ASR requires PCM input" };
		}
		if (typeof event.audio !== "string") {
			return { ok: false, reason: "Realtime ASR audio append requires base64 audio" };
		}
		const decodedBytes = decodedBase64ByteLength(event.audio);
		if (decodedBytes == null) {
			return { ok: false, reason: "Realtime ASR audio is not valid base64" };
		}
		this.audioStarted = true;
		return this.observePcmBytes(decodedBytes);
	}

	private observePcmBytes(byteLength: number): DashScopeRealtimeLimitDecision {
		if (this.limits.requirePcmAudio) {
			if (this.audioFormat !== "pcm") {
				return { ok: false, reason: "Budgeted realtime ASR requires PCM input" };
			}
			if (isInferenceOperation(this.operation) && !this.inferenceAudioConfigured) {
				return { ok: false, reason: "Realtime ASR must configure PCM audio before sending binary data" };
			}
		}
		if (byteLength % 2 !== 0) {
			return { ok: false, reason: "Realtime PCM audio must contain complete 16-bit samples" };
		}
		this.audioStarted = true;
		this.audioDurationSeconds += byteLength / (this.sampleRate * 2);
		if (this.audioDurationSeconds > this.limits.maxAudioDurationSeconds + Number.EPSILON) {
			return { ok: false, reason: "Realtime audio duration limit exceeded" };
		}
		return { ok: true };
	}
}

/**
 * Qwen session terminal events do not consistently include duration usage.
 * The limiter has already validated mono 16-bit PCM and its sample rate, so
 * its byte-derived duration is a safe local fallback. A non-zero upstream
 * duration remains authoritative to avoid charging for provider-discarded
 * audio such as silence outside a recognized segment.
 */
export function applyDashScopeRealtimeMeasuredUsage(
	operation: DashScopeRealtimeOperation,
	limiter: DashScopeRealtimeSessionLimiter | null,
	usage: UsageFromStream,
): UsageFromStream {
	if (!limiter) return usage;
	if (isTranscriptionOperation(operation)) {
		if (usage.audio_duration_source === "upstream") return usage;
		const measured = limiter.measuredAudioDurationSeconds();
		if (measured <= 0) return usage;
		return {
			...usage,
			audio_duration_seconds: measured,
			audio_duration_source: "client",
		};
	}
	// Preserve an explicit upstream zero. Only replace a genuinely missing
	// character metric with the bounded count from client frames that passed
	// the per-session limiter and were forwarded to DashScope.
	if (usage.audio_characters != null) return usage;
	const measured = limiter.measuredTextCharacters();
	if (measured <= 0) return usage;
	return {
		...usage,
		audio_characters: measured,
	};
}

/** 仅改写任务启动/会话配置帧；音频二进制帧和其他事件完全透传。 */
export function rewriteDashScopeRealtimeClientMessage(
	route: RouteResult,
	operation: DashScopeRealtimeOperation,
	message: string
): string {
	let event: JsonObject;
	try {
		const parsed = JSON.parse(message) as unknown;
		const object = asObject(parsed);
		if (!object) return message;
		event = object;
	} catch {
		return message;
	}
	const discriminator = clientEventDiscriminator(operation, event);
	if (!discriminator.ok) return message;
	const name = discriminator.name;
	const shouldMerge =
		(isInferenceOperation(operation) && name === "run-task") ||
		(isSessionOperation(operation) && name === "session.update");
	if (!shouldMerge) return message;

	const merged = buildRouteRequestBody(route, event);
	if (name === "run-task") {
		const payload = asObject(merged.payload) ?? {};
		merged.payload = { ...payload, model: route.providerModelName };
	}
	return JSON.stringify(merged);
}

function realtimeCapability(
	operation: DashScopeRealtimeOperation
): "audio.realtime.inference" | "audio.realtime.session" {
	return isInferenceOperation(operation)
		? "audio.realtime.inference"
		: "audio.realtime.session";
}

/** Workers 通过 HTTP(S) Upgrade 建立出站 WebSocket，fetch 不能直接接收 ws(s) URL。 */
export function outboundWebSocketFetchUrl(endpoint: string): URL {
	const url = new URL(endpoint);
	if (url.protocol === "wss:") url.protocol = "https:";
	if (url.protocol === "ws:") url.protocol = "http:";
	return url;
}

function closeSocket(socket: WebSocket, code = 1000, reason = ""): void {
	// Workers' allowHalfOpen sockets remain CLOSING after the peer sends Close;
	// calling close again is required to complete that handshake.
	if (socket.readyState === WebSocket.CLOSED) return;
	socket.close(code, reason.slice(0, 123));
}

function bridgeSockets(params: {
	client: WebSocket;
	server: WebSocket;
	upstream: WebSocket;
	route: RouteResult;
	operation: DashScopeRealtimeOperation;
	timing?: RequestTimingCollector | null;
	sessionLimits?: DashScopeRealtimeSessionLimits;
}): Promise<UsageFromStream> {
	const { client, server, upstream, route, operation, timing, sessionLimits } = params;
	const collector = new DashScopeRealtimeUsageCollector();
	const outputLimiter = new DashScopeRealtimeOutputLimiter();
	const limiter = sessionLimits
		? new DashScopeRealtimeSessionLimiter(
				operation,
				sessionLimits,
				Date.now(),
				route.providerModelName,
			)
		: null;
	let settled = false;
	let clientClosedFirst = false;

	return new Promise<UsageFromStream>((resolve) => {
		let sessionTimer: ReturnType<typeof setTimeout> | null = null;
		const finish = (transportError?: string | null) => {
			if (settled) return;
			settled = true;
			if (sessionTimer != null) clearTimeout(sessionTimer);
			timing?.markStreamComplete();
			resolve(enforceDashScopeRealtimeUsageCeiling(
				operation,
				sessionLimits,
				applyDashScopeRealtimeMeasuredUsage(
					operation,
					limiter,
					collector.toUsage({ clientClosedFirst, transportError }),
				),
			));
		};

		server.binaryType = "arraybuffer";
		server.accept({ allowHalfOpen: true });
		upstream.binaryType = "arraybuffer";
		// fetch 返回的出站 WebSocket 由 Worker 自己消费，必须显式 accept 后才能收发。
		upstream.accept({ allowHalfOpen: true });
		if (limiter) {
			sessionTimer = setTimeout(() => {
				closeSocket(server, 1008, "Realtime session limit exceeded");
				closeSocket(upstream, 1008, "Realtime session limit exceeded");
				finish("Realtime session duration limit exceeded");
			}, limiter.remainingSessionMs());
		}

		server.addEventListener("message", (event) => {
			try {
				const data =
					typeof event.data === "string"
						? rewriteDashScopeRealtimeClientMessage(
								route,
								operation,
								event.data
							  )
							: event.data;
				const decision = limiter?.inspect(data);
				if (decision && !decision.ok) {
					closeSocket(server, 1008, decision.reason);
					closeSocket(upstream, 1008, decision.reason);
					finish(decision.reason);
					return;
				}
				collector.observeClientActivity();
				upstream.send(data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				closeSocket(server, 1011, "Gateway upstream send failed");
				closeSocket(upstream, 1011, "Gateway upstream send failed");
				finish(message);
			}
		});

		upstream.addEventListener("message", (event) => {
			try {
				const decision = outputLimiter.inspect(event.data);
				if (!decision.ok) {
					closeSocket(server, 1009, decision.reason);
					closeSocket(upstream, 1009, decision.reason);
					finish(decision.reason);
					return;
				}
				if (typeof event.data === "string")
					collector.observeServerMessage(event.data);
				server.send(event.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				closeSocket(server, 1011, "Gateway client send failed");
				closeSocket(upstream, 1011, "Gateway client send failed");
				finish(message);
			}
		});

		server.addEventListener("close", (event) => {
			clientClosedFirst = true;
			closeSocket(upstream, event.code, event.reason);
			// `server.accept({ allowHalfOpen: true })` leaves this side in CLOSING.
			// Complete the client close handshake before recording usage.
			closeSocket(server, event.code, event.reason);
			finish();
		});
		upstream.addEventListener("close", (event) => {
			closeSocket(server, event.code, event.reason);
			finish(
				event.code === 1000
					? null
					: `Upstream WebSocket closed with code ${event.code}`
			);
		});
		server.addEventListener("error", () => {
			clientClosedFirst = true;
			closeSocket(upstream, 1011, "Client WebSocket error");
			finish("Client WebSocket transport error");
		});
		upstream.addEventListener("error", () => {
			closeSocket(server, 1011, "Upstream WebSocket error");
			finish("Upstream WebSocket transport error");
		});
	});
}

function requestSignalWithDeadline(
	requestSignal: AbortSignal | undefined,
	deadlineAtMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup(): void } {
	if (deadlineAtMs == null) return { signal: requestSignal, cleanup() {} };
	const controller = new AbortController();
	const abortFromRequest = () => controller.abort(requestSignal?.reason);
	if (requestSignal?.aborted) abortFromRequest();
	else requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
	const remaining = Math.max(0, deadlineAtMs - Date.now());
	if (remaining === 0) {
		controller.abort(new Error("Realtime upstream connection deadline exceeded"));
	}
	const timer = remaining === 0
		? null
		: setTimeout(
				() => controller.abort(new Error("Realtime upstream connection deadline exceeded")),
				remaining,
			);
	return {
		signal: controller.signal,
		cleanup() {
			if (timer != null) clearTimeout(timer);
			requestSignal?.removeEventListener("abort", abortFromRequest);
		},
	};
}

/** 使用 Workers outbound WebSocket fetch 建立上游，再通过 WebSocketPair 对外暴露本地连接。 */
export async function dispatchDashScopeRealtime(
	route: RouteResult,
	operation: DashScopeRealtimeOperation,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options: DashScopeRealtimeDispatchOptions = {}
): Promise<ProxyDispatchResult> {
	if (options.nodeDispatch) {
		return options.nodeDispatch(
			route,
			operation,
			requestSignal,
			timing,
			attempt,
			options.sessionLimits,
			options.beforeUpstreamDispatch,
		);
	}
	if (typeof WebSocketPair === "undefined") {
		return {
			response: new Response(
				JSON.stringify({
					error: {
						message:
							"DashScope realtime requires the Cloudflare Workers runtime",
					},
				}),
				{ status: 501, headers: { "Content-Type": "application/json" } }
			),
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId: null,
		};
	}

	const capability = realtimeCapability(operation);
	const endpoint = resolveUpstreamEndpoint(
		"dashscope",
		capability,
		route.providerEndpoints,
		{
			providerId: route.providerId,
		}
	);
	const url = outboundWebSocketFetchUrl(endpoint);
	if (isSessionOperation(operation))
		url.searchParams.set("model", route.providerModelName);

	const { secret } = await resolveProviderUpstreamSecret(route.providerApiKey);
	const boundedSignal = requestSignalWithDeadline(
		requestSignal,
		options.sessionLimits?.connectDeadlineAtMs,
	);
	let upstreamResponse: Response;
	try {
		if (boundedSignal.signal?.aborted) {
			throw new Error("Realtime upstream connection aborted before dispatch");
		}
		await options.beforeUpstreamDispatch?.();
		try {
			upstreamResponse = await (options.fetchImpl ?? fetch)(url.toString(), {
				headers: {
					Authorization: `Bearer ${secret}`,
					Upgrade: "websocket",
				},
				signal: boundedSignal.signal,
			});
		} catch (error) {
			throw markUpstreamOutcomeUnknown(error);
		}
	} finally {
		boundedSignal.cleanup();
	}
	timing?.markAttemptHeaders(attempt, upstreamResponse.status);
	const upstreamRequestId = extractUpstreamRequestId(upstreamResponse.headers);
	const upstream = upstreamResponse.webSocket;
	if (upstreamResponse.status !== 101 || !upstream) {
		return {
			response: upstreamResponse,
			usagePromise: Promise.resolve(EMPTY_USAGE),
			upstreamRequestId,
		};
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	const usagePromise = bridgeSockets({
		client,
		server,
		upstream,
		route,
		operation,
		timing,
		sessionLimits: options.sessionLimits,
	});
	return {
		response: new Response(null, {
			status: 101,
			webSocket: client,
			headers: {
				"X-Octafuse-Realtime-Protocol": "dashscope",
				...(options.responseProtocol
					? { "Sec-WebSocket-Protocol": options.responseProtocol }
					: {}),
			},
		}),
		usagePromise,
		upstreamRequestId,
	};
}
