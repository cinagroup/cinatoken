import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RouteResult } from "../model-router";
import { EMPTY_USAGE } from "../proxy";
import {
	applyDashScopeRealtimeMeasuredUsage,
	DashScopeRealtimeOutputLimiter,
	DashScopeRealtimeSessionLimiter,
	DashScopeRealtimeUsageCollector,
	dispatchDashScopeRealtime,
	enforceDashScopeRealtimeUsageCeiling,
	outboundWebSocketFetchUrl,
	rewriteDashScopeRealtimeClientMessage,
	type DashScopeRealtimeSessionLimits,
} from "./dashscope-realtime-driver";

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: "route-1",
		modelSurfaceId: "surface-1",
		routePoolId: "pool-1",
		providerId: "dashscope",
		providerName: "DashScope",
		providerModelName: "fun-asr-realtime",
		upstreamProtocol: "dashscope",
		upstreamOperation: "audio.transcriptions.realtime.inference",
		adapter: "passthrough",
		providerEndpoints: {},
		providerApiKey: "secret",
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: "default",
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
		...overrides,
	};
}

function sessionLimits(
	overrides: Partial<DashScopeRealtimeSessionLimits> = {},
): DashScopeRealtimeSessionLimits {
	return {
		maxSessionMs: 10_000,
		connectDeadlineAtMs: Date.now() + 1_000,
		maxAudioDurationSeconds: 1,
		maxBillableAudioDurationSeconds: 2,
		maxTextCharacters: 200,
		maxClientMessageBytes: 1024 * 1024,
		maxClientBytes: 2 * 1024 * 1024,
		requirePcmAudio: true,
		...overrides,
	};
}

describe("DashScope realtime bounded-session policy", () => {
	it("rejects compressed inference audio and enforces exact PCM duration", () => {
		const compressed = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits(),
			0,
		);
		assert.equal(compressed.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "opus", sample_rate: 16_000 } },
		}), 1).ok, false);

		const pcm = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits(),
			0,
			"fun-asr-realtime",
		);
		assert.equal(pcm.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 8_000 } },
		}), 1).ok, true);
		assert.equal(pcm.inspect(new Uint8Array(16_000), 2).ok, true);
		const over = pcm.inspect(new Uint8Array(2), 3);
		assert.equal(over.ok, false);
		if (!over.ok) assert.match(over.reason, /duration limit/i);
		const secondTask = pcm.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 8_000 } },
		}), 4);
		assert.equal(secondTask.ok, false);
		if (!secondTask.ok) assert.match(secondTask.reason, /one task/i);
	});

	it("uses the operation-specific discriminator and rejects conflicting fields", () => {
		const session = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.session",
			sessionLimits({ maxAudioDurationSeconds: 10 }),
			0,
			"qwen3-asr-flash-realtime",
		);
		const disguisedAppend = session.inspect(JSON.stringify({
			type: "input_audio_buffer.append",
			header: { action: "ignore-billable-audio" },
			audio: Buffer.alloc(16).toString("base64"),
		}), 1);
		assert.equal(disguisedAppend.ok, false);
		if (!disguisedAppend.ok) assert.match(disguisedAppend.reason, /conflicting discriminator/i);

		assert.equal(session.inspect(JSON.stringify({
			type: "session.update",
			session: { input_audio_format: "pcm", sample_rate: 8_000 },
		}), 2).ok, true);
		assert.equal(session.inspect(JSON.stringify({
			type: "input_audio_buffer.append",
			audio: Buffer.alloc(16).toString("base64"),
		}), 3).ok, true);

		const inference = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits({ maxAudioDurationSeconds: 10 }),
			0,
			"fun-asr-realtime",
		);
		assert.equal(inference.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 16_000 } },
		}), 1).ok, true);
		assert.equal(inference.inspect(JSON.stringify({
			header: { action: "continue-task" },
			payload: {},
		}), 2).ok, true);
		const conflictingInference = inference.inspect(JSON.stringify({
			type: "input_audio_buffer.append",
			header: { action: "continue-task" },
		}), 3);
		assert.equal(conflictingInference.ok, false);
		if (!conflictingInference.ok) {
			assert.match(conflictingInference.reason, /conflicting discriminator/i);
		}
	});

	it("rejects the thirteenth 800,000-byte PCM frame above the 600-second ceiling", () => {
		const limiter = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.session",
			sessionLimits({
				maxAudioDurationSeconds: 600,
				maxClientMessageBytes: 2 * 1024 * 1024,
				maxClientBytes: 20 * 1024 * 1024,
			}),
			0,
			"qwen3-asr-flash-realtime",
		);
		assert.equal(limiter.inspect(JSON.stringify({
			type: "session.update",
			session: { input_audio_format: "pcm", sample_rate: 8_000 },
		}), 1).ok, true);
		const frame = JSON.stringify({
			type: "input_audio_buffer.append",
			audio: Buffer.alloc(800_000).toString("base64"),
		});
		for (let index = 0; index < 12; index += 1) {
			assert.equal(limiter.inspect(frame, index + 2).ok, true);
		}
		const over = limiter.inspect(frame, 14);
		assert.equal(over.ok, false);
		if (!over.ok) assert.match(over.reason, /duration limit/i);
	});

	it("uses documented inference model sample-rate semantics without trusting unknown models", () => {
		const arbitraryRate = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits({ maxAudioDurationSeconds: 1 }),
			0,
			"fun-asr-realtime-2026-02-28",
		);
		assert.equal(arbitraryRate.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 48_000 } },
		}), 1).ok, true);
		assert.equal(arbitraryRate.inspect(new Uint8Array(96_000), 2).ok, true);
		assert.equal(arbitraryRate.inspect(new Uint8Array(2), 3).ok, false);

		const eightKhz = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits(),
			0,
			"fun-asr-flash-8k-realtime",
		);
		const wrongEightKhzRate = eightKhz.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 16_000 } },
		}), 1);
		assert.equal(wrongEightKhzRate.ok, false);
		if (!wrongEightKhzRate.ok) assert.match(wrongEightKhzRate.reason, /8000 Hz/i);

		const paraformerV1 = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits(),
			0,
			"paraformer-realtime-v1",
		);
		const wrongParaformerV1Rate = paraformerV1.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 48_000 } },
		}), 1);
		assert.equal(wrongParaformerV1Rate.ok, false);
		if (!wrongParaformerV1Rate.ok) assert.match(wrongParaformerV1Rate.reason, /16000 Hz/i);

		const paraformerV1At16Khz = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits(),
			0,
			"paraformer-realtime-v1",
		);
		assert.equal(paraformerV1At16Khz.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 16_000 } },
		}), 1).ok, true);

		for (const providerModelName of [
			"paraformer-realtime-v2",
			"fun-asr-mtl-realtime-2026-08-01",
		]) {
			const documentedArbitraryRate = new DashScopeRealtimeSessionLimiter(
				"audio.transcriptions.realtime.inference",
				sessionLimits(),
				0,
				providerModelName,
			);
			assert.equal(documentedArbitraryRate.inspect(JSON.stringify({
				header: { action: "run-task" },
				payload: { parameters: { format: "pcm", sample_rate: 48_000 } },
			}), 1).ok, true);
		}

		const unknown = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.inference",
			sessionLimits(),
			0,
			"vendor-model-with-unknown-rate-semantics",
		);
		const unknownDecision = unknown.inspect(JSON.stringify({
			header: { action: "run-task" },
			payload: { parameters: { format: "pcm", sample_rate: 384_000 } },
		}), 1);
		assert.equal(unknownDecision.ok, false);
		if (!unknownDecision.ok) assert.match(unknownDecision.reason, /cannot be safely verified/i);
	});

	it("measures session PCM from base64 and forbids format changes after audio starts", () => {
		const limiter = new DashScopeRealtimeSessionLimiter(
			"audio.transcriptions.realtime.session",
			sessionLimits({ maxAudioDurationSeconds: 0.001 }),
			0,
		);
		const audio = Buffer.alloc(16).toString("base64");
		assert.equal(limiter.inspect(JSON.stringify({
			type: "session.update",
			session: { input_audio_format: "pcm", sample_rate: 8_000 },
		}), 1).ok, true);
		assert.equal(limiter.inspect(JSON.stringify({
			type: "input_audio_buffer.append",
			audio,
		}), 2).ok, true);
		const changed = limiter.inspect(JSON.stringify({
			type: "session.update",
			session: { input_audio_format: "pcm", sample_rate: 16_000 },
		}), 3);
		assert.equal(changed.ok, false);
	});

	it("caps all TTS client strings and the connection wall clock", () => {
		const limiter = new DashScopeRealtimeSessionLimiter(
			"audio.speech.realtime.session",
			sessionLimits({ maxSessionMs: 50, maxTextCharacters: 80 }),
			100,
		);
		assert.equal(limiter.inspect(JSON.stringify({
			type: "input_text_buffer.append",
			text: "hello",
		}), 110).ok, true);
		const over = limiter.inspect(JSON.stringify({
			type: "input_text_buffer.append",
			text: "x".repeat(80),
		}), 120);
		assert.equal(over.ok, false);
		const expired = new DashScopeRealtimeSessionLimiter(
			"audio.speech.realtime.session",
			sessionLimits({ maxSessionMs: 5 }),
			100,
		).inspect("{}", 106);
		assert.equal(expired.ok, false);

		let nested: unknown = "billable text";
		for (let depth = 0; depth < 30; depth += 1) nested = { value: nested };
		const deeplyNested = new DashScopeRealtimeSessionLimiter(
			"audio.speech.realtime.session",
			sessionLimits(),
			100,
		).inspect(JSON.stringify({ type: "input_text_buffer.append", payload: nested }), 101);
		assert.equal(deeplyNested.ok, false);
		if (!deeplyNested.ok) assert.match(deeplyNested.reason, /scan depth/i);
	});

	it("exposes accepted TTS characters as a local fallback without replacing upstream zero", () => {
		const limiter = new DashScopeRealtimeSessionLimiter(
			"audio.speech.realtime.session",
			sessionLimits({ maxTextCharacters: 200 }),
			0,
		);
		assert.equal(limiter.inspect(JSON.stringify({
			type: "input_text_buffer.append",
			text: "hello",
		}), 1).ok, true);
		assert.ok(limiter.measuredTextCharacters() > 0);

		const measured = applyDashScopeRealtimeMeasuredUsage(
			"audio.speech.realtime.session",
			limiter,
			{ ...EMPTY_USAGE },
		);
		assert.equal(measured.audio_characters, limiter.measuredTextCharacters());

		const upstreamZero = applyDashScopeRealtimeMeasuredUsage(
			"audio.speech.realtime.session",
			limiter,
			{ ...EMPTY_USAGE, audio_characters: 0 },
		);
		assert.equal(upstreamZero.audio_characters, 0);
	});

	it("caps cumulative encoded client bytes across individually valid frames", () => {
		const frame = JSON.stringify({ type: "ping" });
		const limiter = new DashScopeRealtimeSessionLimiter(
			"audio.speech.realtime.session",
			sessionLimits({
				maxClientMessageBytes: 100,
				maxClientBytes: Buffer.byteLength(frame) * 2 - 1,
			}),
			0,
		);
		assert.equal(limiter.inspect(frame, 1).ok, true);
		const over = limiter.inspect(frame, 2);
		assert.equal(over.ok, false);
		if (!over.ok) assert.match(over.reason, /cumulative client data/i);
	});
});

describe("DashScope realtime provider output policy", () => {
	it("accepts exact UTF-8 and cumulative boundaries and rejects the next byte", () => {
		const limiter = new DashScopeRealtimeOutputLimiter(4, 6);
		assert.deepEqual(limiter.inspect("éé"), { ok: true, messageBytes: 4 });
		assert.deepEqual(limiter.inspect(new Uint8Array(2)), { ok: true, messageBytes: 2 });
		const over = limiter.inspect("x");
		assert.equal(over.ok, false);
		if (!over.ok) assert.match(over.reason, /cumulative provider data/i);
	});

	it("rejects one provider frame before it can exceed the message ceiling", () => {
		const limiter = new DashScopeRealtimeOutputLimiter(4, 16);
		const over = limiter.inspect(new Uint8Array(5));
		assert.equal(over.ok, false);
		if (!over.ok) assert.match(over.reason, /frame is too large/i);
	});
});

describe("DashScope realtime client event rewrite", () => {
	it("converts WSS endpoints to the HTTPS Upgrade URL required by Workers fetch", () => {
		assert.equal(
			outboundWebSocketFetchUrl(
				"wss://dashscope.aliyuncs.com/api-ws/v1/inference"
			).toString(),
			"https://dashscope.aliyuncs.com/api-ws/v1/inference"
		);
	});

	it("injects the routed provider model into inference run-task and preserves user overrides", () => {
		const result = JSON.parse(
			rewriteDashScopeRealtimeClientMessage(
				route({
					providerModelName: "fun-asr-realtime-2026",
					customParams: {
						payload: { parameters: { format: "pcm", sample_rate: 8000 } },
					},
				}),
				"audio.transcriptions.realtime.inference",
				JSON.stringify({
					// 官方客户端命令字段是 action；event 只用于服务端事件。
					header: { action: "run-task", task_id: "task-1" },
					payload: {
						model: "gateway-alias",
						parameters: { sample_rate: 16000 },
					},
				})
			)
		) as Record<string, any>;
		assert.equal(result.payload.model, "fun-asr-realtime-2026");
		assert.equal(result.payload.parameters.format, "pcm");
		assert.equal(result.payload.parameters.sample_rate, 16000);
	});

	it("merges route defaults only into session.update", () => {
		const configured = JSON.parse(
			rewriteDashScopeRealtimeClientMessage(
				route({
					customParams: { session: { sample_rate: 24000, voice: "Cherry" } },
				}),
				"audio.speech.realtime.session",
				JSON.stringify({ type: "session.update", session: { voice: "Serena" } })
			)
		) as Record<string, any>;
		assert.equal(configured.session.sample_rate, 24000);
		assert.equal(configured.session.voice, "Serena");

		const untouched = JSON.stringify({
			type: "input_text_buffer.append",
			text: "hello",
		});
		assert.equal(
			rewriteDashScopeRealtimeClientMessage(
				route({ customParams: { session: { voice: "Cherry" } } }),
				"audio.speech.realtime.session",
				untouched
			),
			untouched
		);
	});
});

describe("DashScope realtime usage collection", () => {
	it("replaces cumulative usage within a task and sums separate tasks", () => {
		const collector = new DashScopeRealtimeUsageCollector();
		collector.observeServerMessage(
			JSON.stringify({
				header: { event: "result-generated", task_id: "task-1" },
				payload: { usage: { duration: 2 } },
			})
		);
		collector.observeServerMessage(
			JSON.stringify({
				header: { event: "result-generated", task_id: "task-1" },
				payload: { usage: { duration: 3 } },
			})
		);
		collector.observeServerMessage(
			JSON.stringify({
				header: { event: "task-finished", task_id: "task-2" },
				payload: { usage: { duration: 1 } },
			})
		);
		const usage = collector.toUsage({ clientClosedFirst: true });
		assert.equal(usage.audio_duration_seconds, 4);
		assert.equal(usage.cancelled, false);
	});

	it("captures Qwen realtime character/token usage without deriving missing characters", () => {
		const collector = new DashScopeRealtimeUsageCollector();
		collector.observeServerMessage(
			JSON.stringify({
				type: "response.done",
				response: {
					id: "response-1",
					usage: {
						characters: 25,
						input_tokens: 3,
						output_tokens: 64,
						total_tokens: 67,
					},
				},
			})
		);
		const usage = collector.toUsage({ clientClosedFirst: false });
		assert.equal(usage.audio_characters, 25);
		assert.equal(usage.input_tokens, 3);
		assert.equal(usage.output_tokens, 64);
		assert.equal(usage.total_tokens, 67);
		assert.equal(usage.stream_error, undefined);
	});

	it("keeps absent duration and character metrics distinguishable from explicit zero", () => {
		const missing = new DashScopeRealtimeUsageCollector();
		missing.observeServerMessage(JSON.stringify({
			type: "response.done",
			response: { id: "response-1", usage: { total_tokens: 0 } },
		}));
		const missingUsage = missing.toUsage({ clientClosedFirst: false });
		assert.equal(missingUsage.audio_duration_seconds, undefined);
		assert.equal(missingUsage.audio_characters, undefined);

		const partiallyReported = new DashScopeRealtimeUsageCollector();
		partiallyReported.observeServerMessage(JSON.stringify({
			header: { event: "result-generated", task_id: "task-1" },
			payload: { usage: { duration: 1 } },
		}));
		partiallyReported.observeServerMessage(JSON.stringify({
			header: { event: "task-finished", task_id: "task-2" },
			payload: { usage: { total_tokens: 2 } },
		}));
		assert.equal(
			partiallyReported.toUsage({ clientClosedFirst: false }).audio_duration_seconds,
			undefined,
		);

		const explicitZero = new DashScopeRealtimeUsageCollector();
		explicitZero.observeServerMessage(JSON.stringify({
			type: "response.done",
			response: {
				id: "response-2",
				usage: { duration: 0, characters: 0 },
			},
		}));
		const zeroUsage = explicitZero.toUsage({ clientClosedFirst: false });
		assert.equal(zeroUsage.audio_duration_seconds, 0);
		assert.equal(zeroUsage.audio_characters, 0);
	});

	it("marks native failure events and unfinished client disconnects explicitly", () => {
		const failed = new DashScopeRealtimeUsageCollector();
		failed.observeServerMessage(
			JSON.stringify({
				header: {
					event: "task-failed",
					task_id: "task-1",
					error_code: "CLIENT_ERROR",
					error_message: "invalid audio format",
				},
				payload: {},
			})
		);
		assert.equal(
			failed.toUsage({ clientClosedFirst: false }).stream_error,
			"invalid audio format"
		);

		const unfinished = new DashScopeRealtimeUsageCollector();
		assert.equal(
			unfinished.toUsage({ clientClosedFirst: true }).cancelled,
			true
		);
		assert.equal(
			unfinished.toUsage({ clientClosedFirst: false }).stream_error,
			"Upstream WebSocket closed before a terminal event"
		);
	});

	it("does not let an earlier terminal event hide later client activity or over-ceiling usage", () => {
		const collector = new DashScopeRealtimeUsageCollector();
		collector.observeServerMessage(JSON.stringify({
			header: { event: "task-finished", task_id: "task-1" },
			payload: { usage: { duration: 3 } },
		}));
		collector.observeClientActivity();
		const incomplete = collector.toUsage({ clientClosedFirst: false });
		assert.match(incomplete.stream_error ?? "", /before a terminal event/i);

		const bounded = enforceDashScopeRealtimeUsageCeiling(
			"audio.transcriptions.realtime.inference",
			sessionLimits({ maxBillableAudioDurationSeconds: 2 }),
			incomplete,
		);
		assert.match(bounded.stream_error ?? "", /before a terminal event|reserved realtime ceiling/i);
		const completed = new DashScopeRealtimeUsageCollector();
		completed.observeServerMessage(JSON.stringify({
			header: { event: "task-finished", task_id: "task-2" },
			payload: { usage: { duration: 3 } },
		}));
		const exceeded = enforceDashScopeRealtimeUsageCeiling(
			"audio.transcriptions.realtime.inference",
			sessionLimits({ maxBillableAudioDurationSeconds: 2 }),
			completed.toUsage({ clientClosedFirst: false }),
		);
		assert.match(exceeded.stream_error ?? "", /reserved realtime ceiling/i);
	});
});

class FakeSocket extends EventTarget {
	public readyState = 1;
	public binaryType = "blob";
	public acceptOptions: unknown;
	public binaryTypeAtAccept = "";
	public closeCalls: Array<{ code: number; reason: string }> = [];
	public sent: unknown[] = [];

	accept(options?: unknown): void {
		this.acceptOptions = options;
		this.binaryTypeAtAccept = this.binaryType;
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		this.closeCalls.push({ code, reason });
		this.readyState = 3;
	}
}

function dispatchClose(socket: FakeSocket, code: number, reason: string): void {
	socket.readyState = 2;
	const event = new Event("close");
	Object.defineProperties(event, {
		code: { value: code },
		reason: { value: reason },
	});
	socket.dispatchEvent(event);
}

describe("DashScope realtime bridge lifecycle", () => {
	it("completes a client close after task-finished without marking usage as an error", async () => {
		const client = new FakeSocket();
		const server = new FakeSocket();
		const upstream = new FakeSocket();
		const previousWebSocket = globalThis.WebSocket;
		const previousResponse = globalThis.Response;
		const previousWebSocketPair = (globalThis as typeof globalThis & {
			WebSocketPair?: unknown;
		}).WebSocketPair;
		(globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = {
			CLOSING: 2,
			CLOSED: 3,
		};
		(globalThis as typeof globalThis & { WebSocketPair: unknown }).WebSocketPair =
			class {
				0 = client;
				1 = server;
			};
		// Node 的 Response 禁止构造 101；Workers Upgrade Response 允许该状态，测试用最小替身模拟运行时。
		(globalThis as typeof globalThis & { Response: unknown }).Response = class {
			readonly status = 101;
			readonly webSocket = client;
			constructor(
				_body: unknown,
				_init: { status: number; webSocket: WebSocket; headers: Headers }
			) {}
		} as unknown as typeof Response;

		try {
			const result = await dispatchDashScopeRealtime(
			{
				...route({
					providerEndpoints: {
						dashscope: { base: "https://dashscope.aliyuncs.com/api/v1" },
					},
				}),
			},
			"audio.transcriptions.realtime.inference",
			undefined,
			undefined,
			undefined,
			{ fetchImpl: (async () => ({
				status: 101,
				headers: new Headers(),
				webSocket: upstream,
			})) as typeof fetch }
			);

			assert.equal(result.response.status, 101);
			assert.deepEqual(server.acceptOptions, { allowHalfOpen: true });
			assert.deepEqual(upstream.acceptOptions, { allowHalfOpen: true });
			upstream.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						header: { event: "task-finished", task_id: "task-1" },
						payload: { usage: { duration: 5 } },
					}),
				})
			);

			dispatchClose(server, 1000, "client finished");
			const usage = await result.usagePromise;
			assert.equal(usage.audio_duration_seconds, 5);
			assert.equal(usage.stream_error, undefined);
			assert.equal(usage.cancelled, false);
			assert.equal(server.closeCalls.length, 1);
			assert.equal(upstream.closeCalls.length, 1);
		} finally {
			if (previousWebSocket === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
			else (globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = previousWebSocket;
			(globalThis as typeof globalThis & { Response: typeof Response }).Response = previousResponse;
			if (previousWebSocketPair === undefined) {
				delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
			} else {
				(globalThis as typeof globalThis & { WebSocketPair: unknown }).WebSocketPair = previousWebSocketPair;
			}
		}
	});

	it("sets the Worker server binary type before accept and forwards ArrayBuffer PCM", async () => {
		const dispatchOrder: string[] = [];
		const client = new FakeSocket();
		const server = new FakeSocket();
		const upstream = new FakeSocket();
		const previousWebSocket = globalThis.WebSocket;
		const previousResponse = globalThis.Response;
		const previousWebSocketPair = (globalThis as typeof globalThis & {
			WebSocketPair?: unknown;
		}).WebSocketPair;
		(globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = {
			CLOSING: 2,
			CLOSED: 3,
		};
		(globalThis as typeof globalThis & { WebSocketPair: unknown }).WebSocketPair =
			class {
				0 = client;
				1 = server;
			};
		(globalThis as typeof globalThis & { Response: unknown }).Response = class {
			readonly status = 101;
			readonly webSocket = client;
			constructor(
				_body: unknown,
				_init: { status: number; webSocket: WebSocket; headers: Headers },
			) {}
		} as unknown as typeof Response;

		try {
			const result = await dispatchDashScopeRealtime(
				route({
					providerEndpoints: {
						dashscope: { base: "https://dashscope.aliyuncs.com/api/v1" },
					},
				}),
				"audio.transcriptions.realtime.inference",
				undefined,
				undefined,
				undefined,
				{
					beforeUpstreamDispatch: async () => {
						dispatchOrder.push("dispatched");
					},
					fetchImpl: (async () => {
						dispatchOrder.push("fetch");
						return {
							status: 101,
							headers: new Headers(),
							webSocket: upstream,
						};
					}) as typeof fetch,
					sessionLimits: sessionLimits({
						maxAudioDurationSeconds: 2,
						maxBillableAudioDurationSeconds: 3,
						connectDeadlineAtMs: Date.now() + 1_000,
					}),
				},
			);
			assert.deepEqual(dispatchOrder, ["dispatched", "fetch"]);
			assert.equal(server.binaryTypeAtAccept, "arraybuffer");
			assert.equal(upstream.binaryTypeAtAccept, "arraybuffer");

			server.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
				header: { action: "run-task" },
				payload: { parameters: { format: "pcm", sample_rate: 8_000 } },
			}) }));
			const pcm = new ArrayBuffer(16_000);
			server.dispatchEvent(new MessageEvent("message", { data: pcm }));
			assert.equal(upstream.sent.length, 2);
			assert.equal(upstream.sent[1], pcm);

			upstream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
				header: { event: "task-finished", task_id: "task-1" },
				payload: { usage: { duration: 1 } },
			}) }));
			dispatchClose(upstream, 1000, "done");
			assert.equal((await result.usagePromise).audio_duration_seconds, 1);
		} finally {
			if (previousWebSocket === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
			else (globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = previousWebSocket;
			(globalThis as typeof globalThis & { Response: typeof Response }).Response = previousResponse;
			if (previousWebSocketPair === undefined) {
				delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
			} else {
				(globalThis as typeof globalThis & { WebSocketPair: unknown }).WebSocketPair = previousWebSocketPair;
			}
		}
	});

	it("uses verified Qwen session PCM duration when terminal usage is absent", async () => {
		const client = new FakeSocket();
		const server = new FakeSocket();
		const upstream = new FakeSocket();
		const previousWebSocket = globalThis.WebSocket;
		const previousResponse = globalThis.Response;
		const previousWebSocketPair = (globalThis as typeof globalThis & {
			WebSocketPair?: unknown;
		}).WebSocketPair;
		(globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = {
			CLOSING: 2,
			CLOSED: 3,
		};
		(globalThis as typeof globalThis & { WebSocketPair: unknown }).WebSocketPair =
			class {
				0 = client;
				1 = server;
			};
		(globalThis as typeof globalThis & { Response: unknown }).Response = class {
			readonly status = 101;
			readonly webSocket = client;
			constructor(
				_body: unknown,
				_init: { status: number; webSocket: WebSocket; headers: Headers },
			) {}
		} as unknown as typeof Response;

		try {
			const result = await dispatchDashScopeRealtime(
				route({
					providerModelName: "qwen3-asr-flash-realtime",
					upstreamOperation: "audio.transcriptions.realtime.session",
					providerEndpoints: {
						dashscope: { base: "https://dashscope.aliyuncs.com/api/v1" },
					},
				}),
				"audio.transcriptions.realtime.session",
				undefined,
				undefined,
				undefined,
				{
					fetchImpl: (async () => ({
						status: 101,
						headers: new Headers(),
						webSocket: upstream,
					})) as typeof fetch,
					sessionLimits: sessionLimits({
						maxAudioDurationSeconds: 2,
						maxBillableAudioDurationSeconds: 3,
						connectDeadlineAtMs: Date.now() + 1_000,
					}),
				},
			);
			server.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
				type: "session.update",
				session: { input_audio_format: "pcm", sample_rate: 8_000 },
			}) }));
			server.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
				type: "input_audio_buffer.append",
				audio: Buffer.alloc(16_000).toString("base64"),
			}) }));
			upstream.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
				type: "session.finished",
			}) }));
			dispatchClose(upstream, 1000, "done");
			const usage = await result.usagePromise;
			assert.equal(usage.audio_duration_seconds, 1);
			assert.equal(usage.audio_duration_source, "client");
			assert.equal(usage.stream_error, undefined);
		} finally {
			if (previousWebSocket === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
			else (globalThis as typeof globalThis & { WebSocket: unknown }).WebSocket = previousWebSocket;
			(globalThis as typeof globalThis & { Response: typeof Response }).Response = previousResponse;
			if (previousWebSocketPair === undefined) {
				delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
			} else {
				(globalThis as typeof globalThis & { WebSocketPair: unknown }).WebSocketPair = previousWebSocketPair;
			}
		}
	});
});
