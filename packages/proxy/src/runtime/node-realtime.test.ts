import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

class FakeSocket implements NodeWebSocket {
	readyState = 1;
	bufferedAmount = 0;
	binaryType = '';
	sent: Array<string | Buffer> = [];
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
	on(event: SocketEvent | 'open' | 'upgrade' | 'unexpected-response', listener: SocketListener | (() => void) | ((_response: IncomingMessage) => void) | ((_request: IncomingMessage, response: IncomingMessage) => void)): this {
		if (event === 'open') this.openListeners.push(listener as () => void);
		if (event === 'unexpected-response') this.rejectionListeners.push(listener as (request: IncomingMessage, response: IncomingMessage) => void);
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
			const index = this.rejectionListeners.indexOf(listener as (request: IncomingMessage, response: IncomingMessage) => void);
			if (index >= 0) this.rejectionListeners.splice(index, 1);
			return this;
		}
		if (event === 'upgrade') return this;
		const listeners = event === 'message'
			? this.messageListeners
			: event === 'close'
				? this.closeListeners
				: this.errorListeners;
		const index = listeners.indexOf(listener as never);
		if (index >= 0) listeners.splice(index, 1);
		return this;
	}

	send(data: string | Buffer): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ''): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		for (const listener of [...this.closeListeners]) listener(code, Buffer.from(reason));
	}

	terminate(): void { this.close(); }

	emitOpen(): void {
		for (const listener of [...this.openListeners]) listener();
	}

	rejectHandshake(): void {
		const response = new IncomingMessage(new Socket());
		response.statusCode = 503;
		for (const listener of [...this.rejectionListeners]) listener(response, response);
	}

	emitMessage(data: string | Buffer, isBinary = typeof data !== 'string'): void {
		const buffer = typeof data === 'string' ? Buffer.from(data) : data;
		for (const listener of [...this.messageListeners]) listener(buffer, isBinary);
	}

	emitUpstreamMessage(data: string | Buffer, isBinary = typeof data !== 'string'): void {
		this.emitMessage(data, isBinary);
	}

	emitClose(code = 1000, reason = ''): void {
		this.close(code, reason);
	}
}

describe('Node DashScope realtime adapter', () => {
	for (const mode of ['gap_frames', 'invalid_candidate', 'gap_overflow', 'gap_frame_count', 'rewritten_overflow'] as const) {
		it(`owns original unsent frames across candidate gaps: ${mode}`, async () => {
			const client = new FakeSocket();
			const upstreams: FakeSocket[] = [];
			class Upstream extends FakeSocket {
				constructor(_url: string) {
					super(); upstreams.push(this);
					queueMicrotask(() => upstreams.length === 1 ? this.rejectHandshake() : this.emitOpen());
				}
			}
			const dispatch = createNodeDashScopeRealtimeDispatch(client, Upstream);
			const limits: DashScopeRealtimeSessionLimits = {
				maxSessionMs: 10_000, connectDeadlineAtMs: Date.now() + 2_000,
				maxAudioDurationSeconds: 2, maxBillableAudioDurationSeconds: 3,
				maxTextCharacters: 0, maxClientMessageBytes: 8 * 1024 * 1024,
				maxClientBytes: 16 * 1024 * 1024, requirePcmAudio: true,
			};
			// Even frames delivered before the first dispatch callback have an owner.
			client.emitMessage(JSON.stringify({ header: { action: 'run-task' }, payload: {
				model: 'public-model', parameters: { format: 'pcm', sample_rate: 16_000 },
			} }));
			assert.equal((await dispatch(route(), 'audio.transcriptions.realtime.inference', undefined, undefined, undefined, limits)).response.status, 503);
			client.emitMessage(Buffer.alloc(mode === 'gap_overflow' ? 4 * 1024 * 1024 : 32_000));
			if (mode === 'gap_frame_count') for (let index = 0; index < 1_024; index++) client.emitMessage(Buffer.alloc(0));
			const fallback = route({ providerModelName: mode === 'invalid_candidate' ? 'unsupported-pcm-model'
				: mode === 'rewritten_overflow' ? `fun-asr-realtime-${'x'.repeat(4 * 1024 * 1024)}` : 'paraformer-realtime-v2' });
			const result = await dispatch(fallback, 'audio.transcriptions.realtime.inference', undefined, undefined, undefined, limits);
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
		const result = await dispatch(route(), 'audio.transcriptions.realtime.inference', undefined, undefined, undefined, limits);
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
		client.emitMessage(JSON.stringify({
			header: { action: 'run-task' },
			payload: { model: 'gateway-model' },
		}), false);
		assert.equal(typeof holder.upstream!.sent[0], 'string');
		assert.equal(JSON.parse(String(holder.upstream!.sent[0])).payload.model, 'fun-asr-realtime-v2');

		holder.upstream!.emitUpstreamMessage(JSON.stringify({
			header: { event: 'task-finished', task_id: 'task-1' },
			payload: { usage: { duration: 1.5 } },
		}), false);
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
			route(), 'audio.transcriptions.realtime.inference',
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

		client.emitMessage(JSON.stringify({
			type: 'session.update',
			session: { input_audio_format: 'pcm', sample_rate: 8_000 },
		}), false);
		client.emitMessage(JSON.stringify({
			type: 'input_audio_buffer.append',
			audio: Buffer.alloc(16_000).toString('base64'),
		}), false);
		holder.upstream!.emitUpstreamMessage(JSON.stringify({ type: 'session.finished' }), false);
		holder.upstream!.emitClose();

		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 1);
		assert.equal(usage.audio_duration_source, 'client');
		assert.equal(usage.stream_error, undefined);
	});
});
