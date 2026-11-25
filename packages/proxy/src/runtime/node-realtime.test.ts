
import { Readable } from 'node:stream';
import { createNodeDashScopeDeferredRuntime, createNodeElevenLabsRealtimeDispatch } from './node-realtime';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { RouteResult } from '../services/model-router';
import type { DashScopeRealtimeSessionLimits } from '../services/egress/dashscope-realtime-driver';
import {
	createNodeDashScopeRealtimeDispatch,
	createNodeWebSocketServer,
	type NodeWebSocket,
	type NodeWebSocketConstructor,
} from './node-realtime';
import { DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES } from '../services/dashscope-realtime-guardrails';
import { DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES } from '../services/egress/dashscope-realtime-driver';

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'route-1',
		modelSurfaceId: 'surface-1',
		routePoolId: 'pool-1',
		providerId: 'dashscope',
		providerName: 'DashScope',
		providerModelName: 'fun-asr-realtime',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.transcriptions.realtime.inference',
		adapter: 'passthrough',
		providerEndpoints: {
			dashscope: { base: 'https://dashscope.aliyuncs.com/api/v1' },
		},
		providerApiKey: 'secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
		...overrides,
	};
}

type MessageListener = (data: Buffer, isBinary: boolean) => void;
type CloseListener = (code: number, reason: Buffer) => void;
type ErrorListener = (error: Error) => void;
type SocketEvent = 'message' | 'close' | 'error';
type SocketListener = MessageListener | CloseListener | ErrorListener;

function isValidWsCloseCode(code: number): boolean {
	return (
		(code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
	);
}

const testSockets:FakeSocket[]=[];
afterEach(()=>{for(const socket of testSockets.splice(0))socket.emitClose();});

class FakeSocket implements NodeWebSocket {
 constructor(){testSockets.push(this);}
	readyState = 1;
	bufferedAmount = 0;
	binaryType = '';
	sent: Array<string | Buffer> = [];
	closeCodes: number[] = [];
	private paused = false;
	private readonly queuedMessages: Array<{ data: Buffer; isBinary: boolean }> = [];
	private readonly messageListeners: MessageListener[] = [];
	private readonly closeListeners: CloseListener[] = [];
	private readonly errorListeners: ErrorListener[] = [];
	private readonly openListeners: Array<() => void> = [];
	private readonly rejectionListeners: Array<(request: IncomingMessage, response: IncomingMessage) => void> = [];

	on(event: 'open', _listener: () => void): this;
	on(event: 'upgrade', _listener: (_response: IncomingMessage) => void): this;
	on(event: 'unexpected-response', _listener: (_request: IncomingMessage, response: IncomingMessage) => void): this;
	on(event: 'message', listener: MessageListener): this;
	on(event: 'close', listener: CloseListener): this;
	on(event: 'error', listener: ErrorListener): this;
	on(
		event: SocketEvent | 'open' | 'upgrade' | 'unexpected-response',
		listener:
			| SocketListener
			| (() => void)
			| ((_response: IncomingMessage) => void)
			| ((_request: IncomingMessage, response: IncomingMessage) => void),
	): this {
		if (event === 'open') this.openListeners.push(listener as () => void);
		if (event === 'unexpected-response')
			this.rejectionListeners.push(listener as (request: IncomingMessage, response: IncomingMessage) => void);
		if (event === 'message') this.messageListeners.push(listener as MessageListener);
		if (event === 'close') this.closeListeners.push(listener as CloseListener);
		if (event === 'error') this.errorListeners.push(listener as ErrorListener);
		return this;
	}

	off(event: 'message', listener: MessageListener): this;
	off(event: 'close', listener: CloseListener): this;
	off(event: 'error', listener: ErrorListener): this;
	off(event: 'open', listener: () => void): this;
	off(event: 'upgrade', listener: (_response: IncomingMessage) => void): this;
	off(event: 'unexpected-response', listener: (_request: IncomingMessage, response: IncomingMessage) => void): this;
	off(
		event: SocketEvent | 'open' | 'upgrade' | 'unexpected-response',
		listener:
			| SocketListener
			| (() => void)
			| ((_response: IncomingMessage) => void)
			| ((_request: IncomingMessage, response: IncomingMessage) => void),
	): this {
		if (event === 'open') {
			const index = this.openListeners.indexOf(listener as () => void);
			if (index >= 0) this.openListeners.splice(index, 1);
			return this;
		}
		if (event === 'unexpected-response') {
			const index = this.rejectionListeners.indexOf(
				listener as (request: IncomingMessage, response: IncomingMessage) => void,
			);
			if (index >= 0) this.rejectionListeners.splice(index, 1);
			return this;
		}
		if (event === 'upgrade') return this;
		const listeners =
			event === 'message' ? this.messageListeners : event === 'close' ? this.closeListeners : this.errorListeners;
		const index = listeners.indexOf(listener as never);
		if (index >= 0) listeners.splice(index, 1);
		return this;
	}

	send(data: string | Buffer): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ''): void {
		if (typeof code !== 'number' || !isValidWsCloseCode(code)) {
			throw new TypeError('First argument must be a valid error code number');
		}
		this.closeCodes.push(code);
		if (this.readyState === 3) return;
		this.readyState = 3;
		for (const listener of [...this.closeListeners]) listener(code, Buffer.from(reason));
	}

	terminate(): void {
		this.close();
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		for (const queued of this.queuedMessages.splice(0)) {
			this.dispatchMessage(queued.data, queued.isBinary);
		}
	}

	emitOpen(): void {
		for (const listener of [...this.openListeners]) listener();
	}


	emitUnexpectedResponse(status: number, body: string, headers: Record<string, string>): void {
		const response = Readable.from([Buffer.from(body)]) as IncomingMessage;
		response.statusCode = status;
		response.headers = headers;
		for (const listener of [...this.rejectionListeners]) listener(response, response);
	}

	rejectHandshake(): void {
		const response = new IncomingMessage(new Socket());
		response.statusCode = 503;
		for (const listener of [...this.rejectionListeners]) listener(response, response);
	}

	emitMessage(data: string | Buffer, isBinary = typeof data !== 'string'): void {
		const buffer = typeof data === 'string' ? Buffer.from(data) : data;
		if (this.paused) {
			this.queuedMessages.push({ data: buffer, isBinary });
			return;
		}
		this.dispatchMessage(buffer, isBinary);
	}

	emitUpstreamMessage(data: string | Buffer, isBinary = typeof data !== 'string'): void {
		this.emitMessage(data, isBinary);
	}

	emitPeerClose(code = 1000, reason = ''): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		for (const listener of [...this.closeListeners]) listener(code, Buffer.from(reason));
	}

	emitClose(code = 1000, reason = ''): void {
		this.close(code, reason);
	}

	private dispatchMessage(data: Buffer, isBinary: boolean): void {
		for (const listener of [...this.messageListeners]) listener(data, isBinary);
	}
}

describe('Node DashScope realtime adapter', () => {
	for (const mode of [
		'gap_frames',
		'invalid_candidate',
		'gap_overflow',
		'gap_frame_count',
		'rewritten_overflow',
	] as const) {
		it(`owns original unsent frames across candidate gaps: ${mode}`, async () => {
			const client = new FakeSocket();
			const upstreams: FakeSocket[] = [];
			class Upstream extends FakeSocket {
				constructor(_url: string) {
					super();
					upstreams.push(this);
					queueMicrotask(() => (upstreams.length === 1 ? this.rejectHandshake() : this.emitOpen()));
				}
			}
			const dispatch = createNodeDashScopeRealtimeDispatch(client, Upstream);
			const limits: DashScopeRealtimeSessionLimits = {
				maxSessionMs: 10_000,
				connectDeadlineAtMs: Date.now() + 2_000,
				maxAudioDurationSeconds: 2,
				maxBillableAudioDurationSeconds: 3,
				maxTextCharacters: 0,
				maxClientMessageBytes: 8 * 1024 * 1024,
				maxClientBytes: 16 * 1024 * 1024,
				requirePcmAudio: true,
			};
			// Even frames delivered before the first dispatch callback have an owner.
			client.emitMessage(
				JSON.stringify({
					header: { action: 'run-task' },
					payload: {
						model: 'public-model',
						parameters: { format: 'pcm', sample_rate: 16_000 },
					},
				}),
			);
			assert.equal(
				(await dispatch(route(), 'audio.transcriptions.realtime.inference', undefined, undefined, undefined, limits))
					.response.status,
				503,
			);
			client.emitMessage(Buffer.alloc(mode === 'gap_overflow' ? 4 * 1024 * 1024 : 32_000));
			if (mode === 'gap_frame_count') for (let index = 0; index < 1_024; index++) client.emitMessage(Buffer.alloc(0));
			const fallback = route({
				providerModelName:
					mode === 'invalid_candidate'
						? 'unsupported-pcm-model'
						: mode === 'rewritten_overflow'
							? `fun-asr-realtime-${'x'.repeat(4 * 1024 * 1024)}`
							: 'paraformer-realtime-v2',
			});
			const result = await dispatch(
				fallback,
				'audio.transcriptions.realtime.inference',
				undefined,
				undefined,
				undefined,
				limits,
			);
			assert.equal(upstreams[0]!.sent.length, 0);
			if (mode !== 'gap_frames') {
				assert.equal(client.readyState, 3);
				assert.equal(upstreams.length, 1, 'revalidation/overflow must stop before a second constructor');
				assert.equal(result.meta?.upstreamOutcomeUnknown, false);
				return;
			}
			assert.equal(upstreams[1]!.sent.length, 2);
			assert.equal(JSON.parse(String(upstreams[1]!.sent[0])).payload.model, 'paraformer-realtime-v2');
			assert.equal((upstreams[1]!.sent[1] as Buffer).byteLength, 32_000);
			upstreams[1]!.emitMessage(JSON.stringify({ header: { event: 'task-finished' }, payload: {} }));
			upstreams[1]!.close();
			const usage = await result.usagePromise;
			assert.equal(usage.audio_duration_seconds, 1, 'candidate revalidation must not double-count PCM');
		});
	}
	it('configures native ws payload ceilings before message assembly', () => {
		const server = createNodeWebSocketServer() as unknown as { options: { maxPayload: number } };
		assert.equal(server.options.maxPayload, DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES);
	});

	it('rejects an expired absolute connection deadline before opening a socket', async () => {
		const client = new FakeSocket();
		let constructed = false;
		const WebSocketCtor = function (): NodeWebSocket {
			constructed = true;
			return new FakeSocket();
		} as unknown as NodeWebSocketConstructor;
		const limits: DashScopeRealtimeSessionLimits = {
			maxSessionMs: 10_000,
			connectDeadlineAtMs: Date.now() - 1,
			maxAudioDurationSeconds: 10,
			maxBillableAudioDurationSeconds: 11,
			maxTextCharacters: 1_000,
			maxClientMessageBytes: 1_024,
			maxClientBytes: 2_048,
			requirePcmAudio: true,
		};
		const dispatch = createNodeDashScopeRealtimeDispatch(client, WebSocketCtor);
		const result = await dispatch(
			route(),
			'audio.transcriptions.realtime.inference',
			undefined,
			undefined,
			undefined,
			limits,
		);
		assert.equal(result.response.status, 504);
		assert.equal(result.meta?.admissionDeniedPreDispatch, true);
		assert.equal(result.meta?.upstreamOutcomeUnknown, false);
		assert.match(await result.response.text(), /connection deadline exceeded/i);
		assert.equal(constructed, false);
	});

	it('bridges text and binary frames while keeping the routed model and usage', async () => {
		const client = new FakeSocket();
		const holder: { upstream: FakeSocket | null } = { upstream: null };
		let upstreamUrl = '';
		let dispatchMarked = false;
		let providerMaxPayload = 0;
		const WebSocketCtor = function (url: string, options?: { maxPayload?: number }): NodeWebSocket {
			assert.equal(dispatchMarked, true);
			upstreamUrl = url;
			providerMaxPayload = options?.maxPayload ?? 0;
			holder.upstream = new FakeSocket();
			queueMicrotask(() => holder.upstream?.emitOpen());
			return holder.upstream;
		} as unknown as NodeWebSocketConstructor;

		const dispatch = createNodeDashScopeRealtimeDispatch(client, WebSocketCtor);
		const resultPromise = dispatch(
			route({ providerModelName: 'fun-asr-realtime-v2' }),
			'audio.transcriptions.realtime.inference',
			undefined,
			undefined,
			undefined,
			undefined,
			async () => {
				dispatchMarked = true;
			},
		);
		const result = await resultPromise;
		assert.ok(holder.upstream);

		assert.match(upstreamUrl, /wss:\/\/dashscope/);
		assert.equal(providerMaxPayload, DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES);
		assert.equal(result.response.headers.get('x-octafuse-realtime-upgrade'), '1');
		client.emitMessage(
			JSON.stringify({
				header: { action: 'run-task' },
				payload: { model: 'gateway-model' },
			}),
			false,
		);
		assert.equal(typeof holder.upstream!.sent[0], 'string');
		assert.equal(JSON.parse(String(holder.upstream!.sent[0])).payload.model, 'fun-asr-realtime-v2');

		holder.upstream!.emitUpstreamMessage(
			JSON.stringify({
				header: { event: 'task-finished', task_id: 'task-1' },
				payload: { usage: { duration: 1.5 } },
			}),
			false,
		);
		holder.upstream!.emitClose();
		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 1.5);
	});

	it('closes both sockets when provider output exceeds client backpressure capacity', async () => {
		const client = new FakeSocket();
		client.bufferedAmount = 4 * 1024 * 1024;
		const holder: { upstream: FakeSocket | null } = { upstream: null };
		const WebSocketCtor = function (): NodeWebSocket {
			holder.upstream = new FakeSocket();
			queueMicrotask(() => holder.upstream?.emitOpen());
			return holder.upstream;
		} as unknown as NodeWebSocketConstructor;
		const result = await createNodeDashScopeRealtimeDispatch(client, WebSocketCtor)(
			route(),
			'audio.transcriptions.realtime.inference',
		);
		holder.upstream!.emitUpstreamMessage('{"header":{"event":"task-started"}}', false);
		const usage = await result.usagePromise;
		assert.match(usage.stream_error ?? '', /backpressure/i);
		assert.equal(client.readyState, 3);
		assert.equal(holder.upstream!.readyState, 3);
	});

	it('bills verified Qwen session PCM when the terminal event omits usage', async () => {
		const client = new FakeSocket();
		const holder: { upstream: FakeSocket | null } = { upstream: null };
		const WebSocketCtor = function (): NodeWebSocket {
			holder.upstream = new FakeSocket();
			queueMicrotask(() => holder.upstream?.emitOpen());
			return holder.upstream;
		} as unknown as NodeWebSocketConstructor;
		const limits: DashScopeRealtimeSessionLimits = {
			maxSessionMs: 10_000,
			connectDeadlineAtMs: Date.now() + 1_000,
			maxAudioDurationSeconds: 2,
			maxBillableAudioDurationSeconds: 3,
			maxTextCharacters: 1_000,
			maxClientMessageBytes: 64 * 1024,
			maxClientBytes: 128 * 1024,
			requirePcmAudio: true,
		};

		const dispatch = createNodeDashScopeRealtimeDispatch(client, WebSocketCtor);
		const resultPromise = dispatch(
			route({
				providerModelName: 'qwen3-asr-flash-realtime',
				upstreamOperation: 'audio.transcriptions.realtime.session',
			}),
			'audio.transcriptions.realtime.session',
			undefined,
			undefined,
			undefined,
			limits,
		);
		const result = await resultPromise;
		assert.ok(holder.upstream);

		client.emitMessage(
			JSON.stringify({
				type: 'session.update',
				session: { input_audio_format: 'pcm', sample_rate: 8_000 },
			}),
			false,
		);
		client.emitMessage(
			JSON.stringify({
				type: 'input_audio_buffer.append',
				audio: Buffer.alloc(16_000).toString('base64'),
			}),
			false,
		);
		holder.upstream!.emitUpstreamMessage(JSON.stringify({ type: 'session.finished' }), false);
		holder.upstream!.emitClose();

		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 1);
		assert.equal(usage.audio_duration_source, 'client');
		assert.equal(usage.stream_error, undefined);
	});

	it('still records usage when the client closes with reserved code 1005', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;

		const dispatch = createNodeDashScopeRealtimeDispatch(client, WebSocketCtor);
		const resultPromise = dispatch(route(), 'audio.transcriptions.realtime.inference');
		const result = await resultPromise;
		assert.ok(upstream);

		upstream!.emitUpstreamMessage(
			JSON.stringify({
				header: { event: 'task-finished', task_id: 'task-1' },
				payload: { usage: { duration: 1.5 } },
			}),
			false,
		);
		assert.doesNotThrow(() => client.emitPeerClose(1005));
		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 1.5);
		assert.equal(upstream!.closeCodes[0], 1000);
	});

	it('forwards messages queued while the client socket is paused', async () => {
		const client = new FakeSocket();
		client.pause();
		client.emitMessage(
			JSON.stringify({
				header: { action: 'run-task' },
				payload: { model: 'gateway-model' },
			}),
			false,
		);

		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;

		const dispatch = createNodeDashScopeRealtimeDispatch(client, WebSocketCtor);
		const resultPromise = dispatch(
			route({ providerModelName: 'fun-asr-realtime-v2' }),
			'audio.transcriptions.realtime.inference',
		);
		await resultPromise;
		assert.ok(upstream);

		assert.equal(upstream!.sent.length, 0);
		client.resume();
		assert.equal(typeof upstream!.sent[0], 'string');
		assert.equal(JSON.parse(String(upstream!.sent[0])).payload.model, 'fun-asr-realtime-v2');
	});
});


describe('Node DashScope deferred realtime runtime', () => {
	it('queues downstream frames from construction and relays them once connected upstream', async () => {
		const client = new FakeSocket();
		const received: Array<string | ArrayBuffer | Uint8Array> = [];
		let upstream: FakeSocket | null = null;
		let upstreamUrl = '';
		const WebSocketCtor = function (url: string): NodeWebSocket {
			upstreamUrl = url;
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;

		const runtime = createNodeDashScopeDeferredRuntime(client, WebSocketCtor);
		// 监听器注册之前到达的 run-task 帧要先排队
		client.emitMessage(JSON.stringify({ header: { action: 'run-task' }, payload: { model: 'm', task: 'asr' } }), false);
		runtime.client.onMessage((data) => received.push(data));
		assert.equal(typeof received[0], 'string');

		const opened = await runtime.connectUpstream(
			route({ providerModelName: 'fun-asr-realtime-v2' }),
			'audio.transcriptions.realtime.inference'
		);
		assert.ok('socket' in opened);
		assert.match(upstreamUrl, /wss:\/\/dashscope/);

		const upstreamFrames: Array<string | ArrayBuffer | Uint8Array> = [];
		opened.socket.onMessage((data) => upstreamFrames.push(data));
		upstream!.emitUpstreamMessage(JSON.stringify({ header: { event: 'task-started' } }), false);
		assert.equal(typeof upstreamFrames[0], 'string');

		runtime.client.send(JSON.stringify({ header: { event: 'task-started' } }));
		assert.equal(typeof client.sent[0], 'string');
		runtime.client.close(1000, 'done');
		assert.equal(client.closeCodes[0], 1000);
	});

	it('aborts a pending upstream connection when the session signal fires', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			upstream = new FakeSocket();
			return upstream;
		} as unknown as NodeWebSocketConstructor;
		const runtime = createNodeDashScopeDeferredRuntime(client, WebSocketCtor);
		const controller = new AbortController();
		const pending = runtime.connectUpstream(
			route(),
			'audio.transcriptions.realtime.inference',
			controller.signal
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending, {name: 'RequestExecutionStoppedError'});
		assert.equal(upstream!.closeCodes[0], 1000);
	});
});


describe('Node ElevenLabs realtime adapter', () => {
	const elevenRoute = (overrides: Partial<RouteResult> = {}) =>
		route({
			providerId: 'elevenlabs',
			providerName: 'ElevenLabs',
			providerModelName: 'eleven_flash_v2_5',
			upstreamProtocol: 'elevenlabs',
			upstreamOperation: 'audio.speech.realtime',
			providerEndpoints: { elevenlabs: { base: 'https://api.elevenlabs.io/v1' } },
			...overrides,
		});

	it('connects with xi-api-key, bridges frames and reports TTS usage', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		let upstreamUrl = '';
		let upstreamHeaders: Record<string, string> = {};
		const WebSocketCtor = function (url: string, options?: { headers?: Record<string, string> }): NodeWebSocket {
			upstreamUrl = url;
			upstreamHeaders = options?.headers ?? {};
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;

		const dispatch = createNodeElevenLabsRealtimeDispatch(client, WebSocketCtor);
		const result = await dispatch(elevenRoute(), {
			operation: 'audio.speech.realtime',
			voiceId: 'voice_1',
			query: { model_id: 'gateway-model', output_format: 'pcm_16000' },
		});

		const url = new URL(upstreamUrl);
		assert.equal(url.protocol, 'wss:');
		assert.equal(url.pathname, '/v1/text-to-speech/voice_1/stream-input');
		assert.equal(url.searchParams.get('model_id'), 'eleven_flash_v2_5');
		assert.equal(upstreamHeaders['xi-api-key'], 'secret');
		assert.equal(result.response.headers.get('x-octafuse-realtime-upgrade'), '1');
		assert.equal(result.response.headers.get('x-octafuse-realtime-protocol'), 'elevenlabs');

		client.emitMessage(JSON.stringify({ text: ' ', xi_api_key: 'sk-client' }), false);
		client.emitMessage(JSON.stringify({ text: 'Hello' }), false);
		assert.equal(upstream!.sent.length, 2);
		assert.ok(!String(upstream!.sent[0]).includes('sk-client'));

		upstream!.emitUpstreamMessage(JSON.stringify({ audio: 'AAAA' }), false);
		upstream!.emitUpstreamMessage(JSON.stringify({ isFinal: true }), false);
		assert.equal(client.sent.length, 2);
		upstream!.emitClose();
		const usage = await result.usagePromise;
		assert.equal(usage.audio_characters, 5);
		assert.equal(usage.stream_error, undefined);
	});

	it('forwards messages the client sent before the upstream finished connecting', async () => {
		const client = new FakeSocket();
		client.pause();
		client.emitMessage(JSON.stringify({ text: ' ' }), false);
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;
		const dispatch = createNodeElevenLabsRealtimeDispatch(client, WebSocketCtor);
		await dispatch(elevenRoute(), { operation: 'audio.speech.realtime', voiceId: 'voice_1', query: {} });
		assert.equal(upstream!.sent.length, 0);
		client.resume();
		assert.equal(upstream!.sent.length, 1);
	});

	it('forwards an upstream first frame sent in the same tick as open (session_started)', async () => {
		const client = new FakeSocket();
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			const upstream = new FakeSocket();
			queueMicrotask(() => {
				upstream.emitOpen();
				upstream.emitUpstreamMessage(JSON.stringify({ message_type: 'session_started' }), false);
			});
			return upstream;
		} as unknown as NodeWebSocketConstructor;
		const dispatch = createNodeElevenLabsRealtimeDispatch(client, WebSocketCtor);
		await dispatch(
			elevenRoute({ upstreamOperation: 'audio.transcriptions.realtime' }),
			{ operation: 'audio.transcriptions.realtime', query: { audio_format: 'pcm_16000' } },
		);
		assert.equal(client.sent.length, 1);
		assert.equal(JSON.parse(String(client.sent[0])).message_type, 'session_started');
	});

	it('returns the upstream handshake rejection, rewriting quota_exceeded to 402', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() =>
				upstream?.emitUnexpectedResponse(
					401,
					JSON.stringify({ detail: { status: 'quota_exceeded', message: 'out of credits' } }),
					{ 'content-type': 'application/json' }
				)
			);
			return upstream;
		} as unknown as NodeWebSocketConstructor;
		const dispatch = createNodeElevenLabsRealtimeDispatch(client, WebSocketCtor);
		const result = await dispatch(elevenRoute(), {
			operation: 'audio.speech.realtime',
			voiceId: 'voice_1',
			query: {},
		});
		assert.equal(result.response.status, 402);
		assert.equal(result.response.headers.get('x-octafuse-realtime-upgrade'), null);
		assert.match(await result.response.text(), /out of credits/);
		// 握手失败时下游不能被关闭，留给 failover 重试下一条路由
		assert.equal(client.closeCodes.length, 0);
	});

	it('bills STT audio bytes using the query audio_format', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (_url: string): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;
		const dispatch = createNodeElevenLabsRealtimeDispatch(client, WebSocketCtor);
		const result = await dispatch(
			elevenRoute({ providerModelName: 'scribe_v2_realtime', upstreamOperation: 'audio.transcriptions.realtime' }),
			{ operation: 'audio.transcriptions.realtime', query: { audio_format: 'pcm_16000' } }
		);
		client.emitMessage(
			JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.alloc(64_000).toString('base64') }),
			false
		);
		client.emitPeerClose(1000, 'done');
		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 2);
	});
});
