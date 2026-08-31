import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';
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

	on(event: 'open', _listener: () => void): this;
	on(event: 'upgrade', _listener: (_response: IncomingMessage) => void): this;
	on(event: 'unexpected-response', _listener: (_request: IncomingMessage, response: IncomingMessage) => void): this;
	on(event: 'message', listener: MessageListener): this;
	on(event: 'close', listener: CloseListener): this;
	on(event: 'error', listener: ErrorListener): this;
	on(event: SocketEvent | 'open' | 'upgrade' | 'unexpected-response', listener: SocketListener | (() => void) | ((_response: IncomingMessage) => void) | ((_request: IncomingMessage, response: IncomingMessage) => void)): this {
		if (event === 'open') this.openListeners.push(listener as () => void);
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
		if (event === 'upgrade' || event === 'unexpected-response') return this;
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

	emitOpen(): void {
		for (const listener of [...this.openListeners]) listener();
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
		await assert.rejects(
			dispatch(
				route(),
				'audio.transcriptions.realtime.inference',
				undefined,
				undefined,
				undefined,
				limits,
			),
			/connection deadline exceeded/i,
		);
		assert.equal(constructed, false);
	});

	it('bridges text and binary frames while keeping the routed model and usage', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		let upstreamUrl = '';
		let dispatchMarked = false;
		let providerMaxPayload = 0;
		const WebSocketCtor = function (url: string, options?: { maxPayload?: number }): NodeWebSocket {
			assert.equal(dispatchMarked, true);
			upstreamUrl = url;
			providerMaxPayload = options?.maxPayload ?? 0;
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
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
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.ok(upstream);
		const result = await resultPromise;

		assert.match(upstreamUrl, /wss:\/\/dashscope/);
		assert.equal(providerMaxPayload, DASHSCOPE_REALTIME_MAX_PROVIDER_MESSAGE_BYTES);
		assert.equal(result.response.headers.get('x-octafuse-realtime-upgrade'), '1');
		client.emitMessage(JSON.stringify({
			header: { action: 'run-task' },
			payload: { model: 'gateway-model' },
		}), false);
		assert.equal(typeof upstream!.sent[0], 'string');
		assert.equal(JSON.parse(String(upstream!.sent[0])).payload.model, 'fun-asr-realtime-v2');

		upstream!.emitUpstreamMessage(JSON.stringify({
			header: { event: 'task-finished', task_id: 'task-1' },
			payload: { usage: { duration: 1.5 } },
		}), false);
		upstream!.emitClose();
		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 1.5);
	});

	it('closes both sockets when provider output exceeds client backpressure capacity', async () => {
		const client = new FakeSocket();
		client.bufferedAmount = 4 * 1024 * 1024;
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
		} as unknown as NodeWebSocketConstructor;
		const result = await createNodeDashScopeRealtimeDispatch(client, WebSocketCtor)(
			route(), 'audio.transcriptions.realtime.inference',
		);
		upstream!.emitUpstreamMessage('{"header":{"event":"task-started"}}', false);
		const usage = await result.usagePromise;
		assert.match(usage.stream_error ?? '', /backpressure/i);
		assert.equal(client.readyState, 3);
		assert.equal(upstream!.readyState, 3);
	});

	it('bills verified Qwen session PCM when the terminal event omits usage', async () => {
		const client = new FakeSocket();
		let upstream: FakeSocket | null = null;
		const WebSocketCtor = function (): NodeWebSocket {
			upstream = new FakeSocket();
			queueMicrotask(() => upstream?.emitOpen());
			return upstream;
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
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.ok(upstream);
		const result = await resultPromise;

		client.emitMessage(JSON.stringify({
			type: 'session.update',
			session: { input_audio_format: 'pcm', sample_rate: 8_000 },
		}), false);
		client.emitMessage(JSON.stringify({
			type: 'input_audio_buffer.append',
			audio: Buffer.alloc(16_000).toString('base64'),
		}), false);
		upstream!.emitUpstreamMessage(JSON.stringify({ type: 'session.finished' }), false);
		upstream!.emitClose();

		const usage = await result.usagePromise;
		assert.equal(usage.audio_duration_seconds, 1);
		assert.equal(usage.audio_duration_source, 'client');
		assert.equal(usage.stream_error, undefined);
	});
});
