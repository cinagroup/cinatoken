import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { beforeEach, it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import {
	clearGcpServiceAccountTokenCache, createD1StorageContext, GCP_OAUTH_TOKEN_URL,
	resolveProviderUpstreamSecret,
} from '@octafuse/core';
import { createNodeDashScopeRealtimeDispatch, type NodeWebSocket, type NodeWebSocketConstructor } from '../../runtime/node-realtime';
import { proxyDashScopeRealtime, type DashScopeRealtimeProxyOptions } from '../proxy';
import { createRequestDispatchBudget } from '../request-dispatch-budget';
import { GatewayErrorCode } from '../gateway-error-codes';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';
import type { RouteResult } from '../model-router';
import { DASHSCOPE_REALTIME_OPERATIONS, dispatchDashScopeRealtime, type DashScopeRealtimeOperation, type DashScopeRealtimeDispatchOptions } from './dashscope-realtime-driver';
import { realtimeCloseParameters, realtimeRejectedResponse } from './realtime-connection-lifecycle';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const credential = (id = 'test') => JSON.stringify({ type: 'service_account', client_email: `${id}@example.invalid`, private_key: privateKey });
const common = { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority' } as const;
const NativeResponse = globalThis.Response;
function deferred<T>() {
	let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function until(check: () => boolean) {
	const expires = performance.now() + 2_000;
	while (!check() && performance.now() < expires) await nextTurn();
	assert.equal(check(), true, 'expected local lifecycle boundary was reached');
}
function repositories() {
	const unexpected = (): never => { throw new Error('Unexpected database operation'); };
	const db: D1Database = { prepare: unexpected, batch: unexpected, exec: unexpected, withSession: unexpected, dump: unexpected };
	return createD1StorageContext(db).repositories;
}
function route(operation: DashScopeRealtimeOperation, index = 0, key = 'synthetic-key'): RouteResult {
	return {
		targetId: `target-${index}`, modelSurfaceId: null, routePoolId: null, providerId: `provider-${index}`,
		providerName: 'Synthetic', providerModelName: operation.endsWith('.session') ? 'qwen3-asr-flash-realtime' : 'fun-asr-realtime',
		upstreamProtocol: 'dashscope', upstreamOperation: operation, adapter: 'passthrough',
		providerEndpoints: { dashscope: { base: 'https://upstream.example.invalid/api/v1' } }, providerApiKey: key, providerSharedChannelType: null,
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null,
		routeGroup: 'default', routePriority: 100 - index, routeWeight: 1,
	};
}
type NodeEvents = {
	open: []; upgrade: [IncomingMessage]; 'unexpected-response': [IncomingMessage, IncomingMessage];
	message: [Buffer, boolean]; close: [number, Buffer]; error: [Error];
};
class NodeSocket extends EventEmitter<NodeEvents> implements NodeWebSocket {
	readyState = 1; bufferedAmount = 0; binaryType = ''; sent: Array<string | Buffer> = [];
	closeCalls: Array<{ code: number; reason: string }> = []; terminated = 0;
	closeHangs = false;
	send(data: string | Buffer) { this.sent.push(data); }
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		assert.notEqual(code, 1006); assert.ok(Buffer.byteLength(reason) <= 123);
		this.closeCalls.push({ code, reason }); this.readyState = this.closeHangs ? 2 : 3;
		if (!this.closeHangs) this.emit('close', code, Buffer.from(reason));
	}
	terminate() {
		if (this.readyState === 3) return;
		this.terminated++;
		const connecting = this.readyState === 0;
		this.readyState = 2;
		queueMicrotask(() => {
			if (connecting) this.emit('error', new Error('Synthetic asynchronous ws termination'));
			this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0));
		});
	}
	open() { this.readyState = 1; this.emit('open'); }
}
class WorkerSocket extends EventTarget {
	readyState = 1; binaryType = 'blob'; accepted = 0;
	sent: unknown[] = []; closeCalls: Array<{ code: number; reason: string }> = []; closeHangs = false;
	accept() { this.accepted++; }
	send(data: unknown) { this.sent.push(data); }
	close(code = 1000, reason = '') {
		if (this.readyState === 3) return;
		assert.notEqual(code, 1006); assert.ok(Buffer.byteLength(reason) <= 123);
		this.closeCalls.push({ code, reason }); this.readyState = this.closeHangs ? 2 : 3;
	}
}
function replaceGlobal(t: TestContext, name: string, value: unknown) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
}
function workerUpgrade(socket: WorkerSocket): Response {
	const response = new NativeResponse(null);
	// Explicit Node fixture for Workers-only 101, not runtime acceptance evidence.
	Object.defineProperties(response, { status: { value: 101 }, ok: { value: false }, webSocket: { value: socket } });
	return response;
}
function fixture(t: TestContext, runtime: 'node' | 'worker', operation: DashScopeRealtimeOperation) {
	const client = new NodeSocket(); const server = new WorkerSocket(); const workerUpstream = new WorkerSocket();
	const sockets: NodeSocket[] = []; const transports: RequestInit[] = [];
	let onNodeConnect = (socket: NodeSocket) => socket.open();
	let onWorkerConnect = async () => workerUpgrade(workerUpstream);
	let authCalls = 0; let transportCalls = 0;
	let onAuth = async () => NativeResponse.json({ access_token: 'synthetic', expires_in: 3600 });
	class Upstream extends NodeSocket {
		constructor(_url: string, options?: ConstructorParameters<NodeWebSocketConstructor>[1]) {
			super(); this.readyState = 0; sockets.push(this); transportCalls++;
			assert.equal(options?.followRedirects, false);
			queueMicrotask(() => onNodeConnect(this));
		}
	}
	if (runtime === 'worker') {
		replaceGlobal(t, 'WebSocketPair', class { 0 = new WorkerSocket(); 1 = server; });
		replaceGlobal(t, 'Response', class extends NativeResponse {
			constructor(body?: BodyInit | null, init?: ResponseInit) {
				super(body, init?.status === 101 ? { ...init, status: 200 } : init);
				if (init?.status === 101) Object.defineProperties(this, { status: { value: 101 }, ok: { value: false }, webSocket: { value: init.webSocket } });
			}
		});
	}
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) === GCP_OAUTH_TOKEN_URL) { authCalls++; return onAuth(); }
		assert.equal(runtime, 'worker'); transportCalls++; transports.push(init ?? {});
		assert.equal(init?.redirect, 'manual'); return onWorkerConnect();
	});
	const nodeDispatch = runtime === 'node' ? createNodeDashScopeRealtimeDispatch(client, Upstream) : undefined;
	const config = (extra: DashScopeRealtimeProxyOptions = common) => ({ ...common, ...extra, nodeDispatch });
	return {
		client, server, workerUpstream, sockets, transports,
		get authCalls() { return authCalls; }, get transportCalls() { return transportCalls; },
		auth(handler: typeof onAuth) { onAuth = handler; },
		node(handler: typeof onNodeConnect) { onNodeConnect = handler; },
		worker(handler: typeof onWorkerConnect) { onWorkerConnect = handler; },
		run(candidates = [route(operation)], signal?: AbortSignal, extra?: DashScopeRealtimeProxyOptions) {
			return proxyDashScopeRealtime(repositories(), candidates, operation, signal, config(extra));
		},
		direct(candidate = route(operation), signal?: AbortSignal, extra?: DashScopeRealtimeDispatchOptions) {
			return dispatchDashScopeRealtime(candidate, operation, signal, undefined, undefined, { ...extra, nodeDispatch });
		},
		stop() { if (runtime === 'node') client.close(); else server.dispatchEvent(closeEvent(1000, 'done')); },
	};
}
function closeEvent(code: number, reason: string) {
	const event = new Event('close'); Object.defineProperties(event, { code: { value: code }, reason: { value: reason } }); return event;
}
beforeEach(() => { clearGcpServiceAccountTokenCache(); resetProviderCircuitStateForTests(); });

for (const status of [300, 301, 302, 303, 307, 308, 408, 499, 500, 503, 599]) {
	it(`dispatched realtime HTTP ${status} does not prove the Upgrade had no side effect`, () => {
		const result = realtimeRejectedResponse(status, new Headers(), null);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.meta?.failoverForbidden, true);
	});
}
for (const status of [400, 401, 429]) {
	it(`explicit realtime HTTP ${status} remains a known rejection`, () => {
		const result = realtimeRejectedResponse(status, new Headers(), null);
		assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
	});
}

for (const runtime of ['node', 'worker'] as const) for (const operation of DASHSCOPE_REALTIME_OPERATIONS) {
	const label = `${runtime} ${operation}`;
	for (const separate of [false, true]) it(`${label}: auxiliary permits remain bounded (separate invocations=${separate})`, async t => {
		const h = fixture(t, runtime, operation); h.auth(async () => NativeResponse.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status: 503 }));
		const dispatchBudget = createRequestDispatchBudget(); let admissions = 0;
		const candidates = Array.from({ length: 32 }, (_, i) => route(operation, i, credential(String(i))));
		const options = { ...common, dispatchBudget, beforeUpstreamDispatch: async () => { admissions++; } };
		let result = await h.run(separate ? candidates.slice(0, 1) : candidates, undefined, options);
		if (separate) for (const candidate of candidates.slice(1)) { result = await h.run([candidate], undefined, options); if (result.meta?.failoverForbidden) break; }
		assert.equal(h.authCalls, 3); assert.equal(h.transportCalls, 0); assert.equal(admissions, 0);
		assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 3 } });
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
		assert.equal(result.meta?.admissionDeniedPreDispatch, true); assert.equal(result.meta?.failoverForbidden, true);
		assert.deepEqual(result.circuitEvents, []); assert.doesNotMatch(await result.response.text(), /PRIVATE_AUTH_DETAIL|PRIVATE KEY|@example/);
	});
	for (const cached of [false, true]) it(`${label}: exhausted auth budget permits ${cached ? 'cache hit' : 'plain key'}`, async t => {
		const h = fixture(t, runtime, operation);
		if (cached) await resolveProviderUpstreamSecret(credential());
		const dispatchBudget = createRequestDispatchBudget(3, 1); dispatchBudget.auxiliaryAuth.consume();
		const result = await h.run([route(operation, 0, cached ? credential() : 'synthetic-key')], undefined, { ...common, dispatchBudget });
		assert.equal(result.response.status, runtime === 'node' ? 200 : 101); assert.equal(h.transportCalls, 1); assert.equal(h.authCalls, cached ? 1 : 0);
		assert.equal(result.dispatchBudget?.permitsConsumed, 1); h.stop(); await result.usagePromise;
	});
	for (const stop of ['abort', 'deadline'] as const) it(`${label}: pre-${stop} sends nothing`, async t => {
		const h = fixture(t, runtime, operation); const controller = new AbortController(); let admissions = 0;
		if (stop === 'abort') controller.abort('PRIVATE_REASON');
		const result = await h.direct(route(operation, 0, credential()), controller.signal, { connectDeadlineAtMs: stop === 'deadline' ? Date.now() - 1 : Date.now() + 30_000, beforeUpstreamDispatch: async () => { admissions++; } });
		assert.equal(result.response.status, stop === 'abort' ? 499 : 504); assert.equal(h.authCalls, 0); assert.equal(h.transportCalls, 0); assert.equal(admissions, 0);
		assert.equal(result.meta?.upstreamOutcomeUnknown, false); assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	});
	for (const stop of ['abort', 'deadline'] as const) it(`${label}: OAuth ${stop} cannot later open a socket`, async t => {
		const h = fixture(t, runtime, operation); const pendingAuth = deferred<Response>(); h.auth(() => pendingAuth.promise);
		const controller = new AbortController(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		let admissions = 0;
		const resultPromise = h.run([route(operation, 0, credential())], controller.signal, { ...common, connectDeadlineAtMs: Date.now() + 100, beforeUpstreamDispatch: async () => { admissions++; } });
		await until(() => h.authCalls === 1);
		if (stop === 'abort') controller.abort('PRIVATE_REASON'); else t.mock.timers.tick(101);
		const result = await resultPromise;
		assert.equal(result.response.status, stop === 'abort' ? 499 : 504); assert.equal(result.meta?.upstreamOutcomeUnknown, false);
		assert.equal(result.dispatchBudget?.permitsConsumed, 0); assert.equal(h.transportCalls, 0);
		pendingAuth.resolve(NativeResponse.json({ access_token: 'synthetic-late', expires_in: 3600 })); await nextTurn();
		assert.equal(h.transportCalls, 0); assert.equal(admissions, 0); assert.doesNotMatch(await result.response.text(), /PRIVATE_REASON/);
	});
	it(`${label}: cancellation owns pending durable admission until it completes`, async t => {
		const h = fixture(t, runtime, operation); const admission = deferred<void>(); const controller = new AbortController(); let entered = false; let returned = false;
		const pending = h.direct(route(operation), controller.signal, { beforeUpstreamDispatch: () => { entered = true; return admission.promise; } }).then(r => { returned = true; return r; });
		await until(() => entered); controller.abort(); await nextTurn(); assert.equal(returned, false);
		admission.resolve(); const result = await pending;
		assert.equal(result.response.status, 499); assert.equal(h.transportCalls, 0); assert.equal(result.meta?.upstreamOutcomeUnknown, false);
	});
	it(`${label}: admission persistence failure is not swallowed by cancellation`, async t => {
		const h = fixture(t, runtime, operation); const admission = deferred<void>(); const controller = new AbortController(); let entered = false;
		const failure = new Error('Synthetic local admission failure');
		const pending = h.run([route(operation)], controller.signal, { ...common, beforeUpstreamDispatch: () => { entered = true; return admission.promise; } });
		const rejected = assert.rejects(pending, error => error === failure);
		await until(() => entered); controller.abort(); admission.reject(failure); await rejected;
		assert.equal(h.transportCalls, 0);
	});
	for (const stop of ['abort', 'deadline'] as const) it(`${label}: ${stop} after send is unknown and never replayed`, async t => {
		const h = fixture(t, runtime, operation); const upgrade = deferred<Response>(); h.node(() => {}); h.worker(() => upgrade.promise);
		const controller = new AbortController(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		const pending = h.run([route(operation), route(operation, 1)], controller.signal, { ...common, connectDeadlineAtMs: Date.now() + 100 });
		await until(() => h.transportCalls === 1);
		if (stop === 'abort') controller.abort(); else t.mock.timers.tick(101);
		const result = await pending; assert.equal(result.response.status, stop === 'abort' ? 499 : 504);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.failoverForbidden, true); assert.equal(result.dispatchBudget?.permitsConsumed, 1);
		upgrade.resolve(workerUpgrade(h.workerUpstream)); await nextTurn(); assert.equal(h.transportCalls, 1);
		if (runtime === 'node') { assert.equal(h.sockets[0]!.terminated, 1); assert.equal(h.sockets[0]!.listenerCount('error'), 0); }
		else { assert.equal(h.workerUpstream.accepted, 1); assert.equal(h.workerUpstream.closeCalls.length, 1); }
	});
	it(`${label}: sent 503 discards body without reconnecting another candidate`, async t => {
		const h = fixture(t, runtime, operation); let disposed = 0;
		h.worker(async () => new NativeResponse(new ReadableStream({ cancel() { disposed++; return new Promise<void>(() => {}); } }), { status: 503, headers: { 'Retry-After': '2' } }));
		h.node(socket => {
			const response = new IncomingMessage(new Socket()); response.statusCode = 503; response.headers = { 'retry-after': '2' };
			t.mock.method(response, 'destroy', () => { disposed++; return response; });
			t.mock.method(response, 'resume', () => { assert.fail('must not drain rejection'); });
			socket.emit('unexpected-response', response, response);
		});
		const result = await h.run(Array.from({ length: 12 }, (_, i) => route(operation, i)));
		await nextTurn(); assert.equal(h.transportCalls, 1); assert.equal(disposed, 1);
		assert.equal(result.dispatchBudget?.permitsConsumed, 1);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.failoverForbidden, true);
		assert.equal(result.response.status, 503);
	});
	it(`${label}: invalid 200 handshake is unknown, not success or known zero`, async t => {
		const h = fixture(t, runtime, operation); h.worker(async () => new NativeResponse(null, { status: 200 }));
		h.node(socket => { const response = new IncomingMessage(new Socket()); response.statusCode = 200; socket.emit('unexpected-response', response, response); });
		const result = await h.run([route(operation), route(operation, 1)]);
		assert.equal(result.response.status, 502); assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(h.transportCalls, 1);
	});
	it(`${label}: abort after upgrade settles once and stops both directions even if close hangs`, async t => {
		const h = fixture(t, runtime, operation); const controller = new AbortController();
		const result = await h.run(undefined, controller.signal);
		h.client.closeHangs = true; h.server.closeHangs = true; h.workerUpstream.closeHangs = true;
		if (h.sockets[0]) h.sockets[0].closeHangs = true;
		controller.abort(); const usage = await result.usagePromise; assert.match(usage.stream_error ?? '', /aborted/);
		if (runtime === 'node') {
			h.client.emit('message', Buffer.from('{}'), false); h.sockets[0]!.emit('message', Buffer.from('{}'), false);
			assert.equal(h.client.sent.length, 0); assert.equal(h.sockets[0]!.sent.length, 0);
			assert.equal(h.client.listenerCount('message'), 0); assert.equal(h.sockets[0]!.listenerCount('message'), 0);
			// Complete synthetic close acknowledgements to release error observers.
			for (const socket of [h.client, ...h.sockets]) { socket.readyState = 3; socket.emit('close', 1000, Buffer.alloc(0)); }
		} else {
			h.server.dispatchEvent(new MessageEvent('message', { data: '{}' })); h.workerUpstream.dispatchEvent(new MessageEvent('message', { data: '{}' }));
			assert.equal(h.server.sent.length, 0); assert.equal(h.workerUpstream.sent.length, 0);
			assert.equal(h.server.closeCalls.length, 1); assert.equal(h.workerUpstream.closeCalls.length, 1);
		}
	});
}

for (const code of [1000, 1001, 1005, 1006, 1011, 1015, 2000, 3000, 4999, 5000, NaN]) it(`bounded close parameters (${code})`, () => {
	const safe = realtimeCloseParameters(code, '中文🙂'.repeat(1000));
	assert.ok(Buffer.byteLength(safe.reason) <= 123); assert.ok(!safe.reason.endsWith('\uFFFD'));
	assert.equal(safe.code, [1000, 1001, 1011, 3000, 4999].includes(code) ? code : 1011);
});

for (const phase of ['oauth', 'admission', 'connecting'] as const) it(`Node client close during ${phase} cannot produce a late connection or flush`, async t => {
	const operation = DASHSCOPE_REALTIME_OPERATIONS[0]; const h = fixture(t, 'node', operation);
	const auth = deferred<Response>(); const admission = deferred<void>(); let entered = false;
	if (phase === 'oauth') h.auth(() => auth.promise); if (phase === 'connecting') h.node(() => {});
	const pending = h.direct(route(operation, 0, phase === 'oauth' ? credential() : 'synthetic-key'), undefined, {
		beforeUpstreamDispatch: () => { entered = true; return phase === 'admission' ? admission.promise : Promise.resolve(); },
	});
	await until(() => phase === 'oauth' ? h.authCalls === 1 : phase === 'admission' ? entered : h.transportCalls === 1);
	h.client.emit('message', Buffer.from('{}'), false); h.client.close(); admission.resolve();
	const result = await pending; auth.resolve(NativeResponse.json({ access_token: 'late', expires_in: 3600 })); await nextTurn();
	assert.equal(result.response.status, 499); assert.equal(h.transportCalls, phase === 'connecting' ? 1 : 0);
	assert.equal(result.meta?.upstreamOutcomeUnknown, phase === 'connecting'); assert.ok(h.sockets.every(socket => socket.sent.length === 0));
});
for (const runtime of ['node', 'worker'] as const) {
	const operation = DASHSCOPE_REALTIME_OPERATIONS[0];
	it(`${runtime}: invalid authentication header never reaches admission or exposes key`, async t => {
		const h = fixture(t, runtime, operation); let admission = 0;
		await assert.rejects(h.direct(route(operation, 0, 'PRIVATE_KEY\r\nINJECTED'), undefined, {
			beforeUpstreamDispatch: async () => { admission++; },
		}), error => error instanceof Error && error.message === 'Invalid realtime upstream authentication header');
		assert.equal(h.transportCalls, 0); assert.equal(admission, 0);
	});
	it(`${runtime}: connection expiry is shared across failover, not renewed per candidate`, async t => {
		const h = fixture(t, runtime, operation); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		h.worker(async () => { t.mock.timers.tick(100); return new NativeResponse(null, { status: 429 }); });
		h.node(socket => {
			const response = new IncomingMessage(new Socket()); response.statusCode = 429;
			socket.emit('unexpected-response', response, response); t.mock.timers.tick(100);
		});
		const result = await h.run([route(operation), route(operation, 1)], undefined, { ...common, connectDeadlineAtMs: Date.now() + 100 });
		assert.equal(result.response.status, 504); assert.equal(h.transportCalls, 1);
	});
	it(`${runtime}: transport failure is redacted and never replayed`, async t => {
		const h = fixture(t, runtime, operation); h.worker(async () => { throw new Error('PRIVATE_TRANSPORT_DETAIL'); });
		h.node(socket => socket.emit('error', new Error('PRIVATE_TRANSPORT_DETAIL')));
		const result = await h.run([route(operation), route(operation, 1)]);
		assert.equal(result.response.status, 502); assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(h.transportCalls, 1); assert.doesNotMatch(await result.response.text(), /PRIVATE_TRANSPORT_DETAIL/);
	});
	it(`${runtime}: successful session outlives the connection ceiling`, async t => {
		const h = fixture(t, runtime, operation); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		const result = await h.run(undefined, undefined, { ...common, connectDeadlineAtMs: Date.now() + 100 });
		t.mock.timers.tick(101); await nextTurn();
		assert.equal(runtime === 'node' ? h.client.readyState : h.server.readyState, 1);
		h.stop(); await result.usagePromise;
	});
	it(`${runtime}: shared budget origin prevents deadline renewal across proxy invocations`, async t => {
		const h = fixture(t, runtime, operation); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		const dispatchBudget = createRequestDispatchBudget();
		h.worker(async () => new NativeResponse(null, { status: 503 }));
		h.node(socket => { const response = new IncomingMessage(new Socket()); response.statusCode = 503; socket.emit('unexpected-response', response, response); });
		await h.run(undefined, undefined, { ...common, dispatchBudget });
		t.mock.timers.tick(30_001);
		const result = await h.run([route(operation, 1)], undefined, { ...common, dispatchBudget });
		assert.equal(result.response.status, 504); assert.equal(h.transportCalls, 1);
		assert.equal(result.dispatchBudget?.permitsConsumed, 1); assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	});
}
it('Node close-before-open cannot hang or replay', async t => {
	const operation = DASHSCOPE_REALTIME_OPERATIONS[0]; const h = fixture(t, 'node', operation);
	h.node(socket => { socket.readyState = 3; socket.emit('close', 1006, Buffer.alloc(0)); });
	const result = await h.run([route(operation), route(operation, 1)]);
	assert.equal(result.response.status, 502); assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(h.transportCalls, 1);
});
for (const mode of ['abort', 'deadline', 'reject', 'redirect'] as const) it(`native ws loopback: ${mode} closes pending TCP without unhandled errors`, { timeout: 10_000 }, async t => {
	let requests = 0; let remoteEnds = 0;
	const peers = new Set<Socket>();
	const server = createServer();
	server.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
	server.on('upgrade', (_request, socket) => {
		requests++;
		// HTTP upgrade detaches the parser and leaves this fixture half-open.
		// Consume the peer FIN and acknowledge it; otherwise server-side close
		// alone says nothing about whether the ws client destroyed its transport.
		socket.on('end', () => { remoteEnds++; socket.end(); });
		socket.resume();
		if (mode === 'reject' || mode === 'redirect') {
			socket.write(`HTTP/1.1 ${mode === 'reject' ? '503 Service Unavailable' : '302 Found'}\r\nContent-Length: 99999999\r\nRetry-After: 2\r\nLocation: http://127.0.0.1:1/forbidden\r\nX-Request-Id: synthetic-request\r\n\r\nunfinished`);
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
	const address = server.address(); assert.ok(address && typeof address === 'object');
	const operation = DASHSCOPE_REALTIME_OPERATIONS[0]; const candidate = route(operation);
	candidate.providerEndpoints = { dashscope: { base: `http://127.0.0.1:${address.port}/api/v1` } };
	const controller = new AbortController(); const client = new NodeSocket();
	const pending = createNodeDashScopeRealtimeDispatch(client)(candidate, operation, controller.signal, undefined, undefined, undefined, undefined, {
		connectDeadlineAtMs: Date.now() + (mode === 'deadline' ? 500 : 5_000),
	});
	await until(() => requests === 1); if (mode === 'abort') controller.abort();
	const result = await pending;
	assert.equal(result.response.status, mode === 'abort' ? 499 : mode === 'deadline' ? 504 : mode === 'reject' ? 503 : 302);
	assert.equal(result.meta?.upstreamOutcomeUnknown, true);
	if (mode === 'reject' || mode === 'redirect') { assert.equal(result.upstreamRequestId, 'synthetic-request'); assert.equal(result.response.headers.get('Retry-After'), '2'); }
	await until(() => peers.size === 0); assert.equal(remoteEnds, 1); assert.equal(requests, 1); client.close();
});
