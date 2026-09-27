import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type Socket } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { it, type TestContext } from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1StorageContext, type ResolvedGatewayKeyRow } from '@octafuse/core';
import { buildDashScopeRealtimeAuthProtocol } from '@octafuse/core/realtime-protocol';
import { createProxyApp, type GatewayBindings } from '../app';
import type { RouteResult } from '../services/model-router';
import type { ProxyDispatchResult } from '../services/failover-dispatch';
import { DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS } from '../services/dashscope-realtime-guardrails';
import { isDashScopeRealtimePath } from '../services/dashscope-realtime-path';
import { handleNodeRealtimeUpgrade } from './node-realtime-upgrade';
import { createNodeWebSocketServer, type NodeWebSocket } from './node-realtime';

const PATHS = ['/v1/dashscope/realtime', '/api/v1/dashscope/realtime'];
const KEY = 'synthetic-realtime-client-key';
const KEY_PROTOCOL = buildDashScopeRealtimeAuthProtocol(KEY);
const WS_HEADERS = {
	Connection: 'Upgrade', Upgrade: 'websocket',
	'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
};
const OPERATION = 'audio.transcriptions.realtime.inference';
const Ws = (createRequire(import.meta.url)('ws') as {
	WebSocket: new (url: string, protocols?: string[]) => NodeWebSocket;
}).WebSocket;
type UpgradeApp = Parameters<typeof handleNodeRealtimeUpgrade>[0];

function dispatchFrom(env: GatewayBindings | undefined) {
	assert.ok(env?.NODE_REALTIME_DISPATCH);
	return env.NODE_REALTIME_DISPATCH;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

async function serve(t: TestContext, app: UpgradeApp) {
	const server = createServer();
	const websocketServer = createNodeWebSocketServer();
	const sockets = new Set<Socket>();
	const pending = new Set<Promise<void>>();
	let upgrades = 0;
	server.on('connection', socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	server.on('upgrade', (request, socket, head) => {
		const work = handleNodeRealtimeUpgrade(app, request, socket, head, {
			handleUpgrade: (...args) => { upgrades++; websocketServer.handleUpgrade(...args); },
		});
		pending.add(work);
		void work.finally(() => pending.delete(work));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await Promise.all(pending);
	});
	return { url: `http://127.0.0.1:${address.port}`, port: address.port, upgrades: () => upgrades };
}

function upgrade(url: string, headers: Record<string, string> = {}, method = 'GET') {
	return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const request = httpRequest(url, { method, headers: { ...WS_HEADERS, ...headers } });
		request.on('error', reject);
		request.on('upgrade', (response, socket) => {
			socket.destroy();
			resolve({ status: response.statusCode!, headers: response.headers, body: '' });
		});
		request.on('response', response => {
			const chunks: Buffer[] = [];
			response.on('error', reject);
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
		});
		request.end();
	});
}

function realApp() {
	const unexpected = (): never => { throw new Error('Unexpected fixture database call'); };
	const db: D1Database = { prepare: unexpected, batch: unexpected, exec: unexpected, withSession: unexpected, dump: unexpected };
	const storage = createD1StorageContext(db);
	const key: ResolvedGatewayKeyRow = {
		id: 'synthetic-key-id', key: KEY, user_id: 'synthetic-user-id', workspace_id: 'synthetic-workspace-id',
		name: 'Test', status: 'active', metadata: null, last_used_at: null,
		created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z', user_email: null,
		user_metadata: null, user_charged_cost_factors: null, budget_max: null, budget_base: 0,
		budget_spent: 0, budget_period: 'none', budget_reset_at: null, budget_epoch: 0,
		budget_reserved_micros: 0, include_byok_in_limit: false, limit_micros: null,
		limit_epoch: 0, limit_reset: null, expires_at: null,
	};
	const lookups: string[] = [];
	return { lookups, app: createProxyApp(async () => ({ ...storage, repositories: {
		...storage.repositories,
		apiKeys: { ...storage.repositories.apiKeys, getApiKeyWithUserByKey: async value => {
			lookups.push(value); return value === KEY ? key : null;
		} },
	} })) };
}

for (const path of PATHS) {
	for (const [name, auth, status, code] of [
		['missing key', {}, 401, 'gateway.auth_failed'],
		['invalid bearer', { Authorization: 'Bearer synthetic-invalid' }, 401, 'gateway.auth_failed'],
		['valid bearer / missing model', { Authorization: `Bearer ${KEY}` }, 400, 'gateway.missing_model'],
		['browser protocol / missing model', { 'Sec-WebSocket-Protocol': KEY_PROTOCOL }, 400, 'gateway.missing_model'],
		['invalid bearer cannot fall back to browser protocol', { Authorization: 'Bearer synthetic-invalid', 'Sec-WebSocket-Protocol': KEY_PROTOCOL }, 401, 'gateway.auth_failed'],
	] as const) {
		it(`native ${path}: ${name} rejects before 101`, { timeout: 5_000 }, async t => {
			const { app } = realApp();
			const server = await serve(t, app);
			const result = await upgrade(`${server.url}${path}`, auth);
			assert.equal(result.status, status);
			assert.equal(result.headers['x-octafuse-error-code'], code);
			assert.equal(server.upgrades(), 0);
			assert.equal(result.headers['cache-control'], 'no-store');
			assert.equal(result.headers['sec-websocket-protocol'], undefined);
			assert.equal(result.body.includes(KEY), false);
		});
	}
	for (const suffix of ['/extra', '-extra', '/']) {
		it(`native path-exact allowlist rejects ${path}${suffix}`, async t => {
			let appCalls = 0;
			const server = await serve(t, { fetch: () => { appCalls++; return new Response(null, { status: 500 }); } });
			assert.equal((await upgrade(`${server.url}${path}${suffix}`)).status, 404);
			assert.equal(appCalls, 0);
			assert.equal(server.upgrades(), 0);
			assert.equal(isDashScopeRealtimePath(`${path}${suffix}`), false);
		});
	}
	it(`shared app ${path} requires an Upgrade and validates operation`, async () => {
		const { app } = realApp();
		const headers = { Authorization: `Bearer ${KEY}` };
		const http = await app.request(path, { headers }, {});
		// Shared error normalization exposes gateway.invalid_request as 400.
		assert.equal(http.status, 400);
		assert.match(await http.text(), /Expected a WebSocket upgrade/);
		const invalid = await app.request(`${path}?model=test&operation=invalid`, { headers: { ...headers, Upgrade: 'websocket' } }, {});
		assert.equal(invalid.status, 400);
		assert.match(await invalid.text(), /Unsupported realtime operation/);
	});
}

it('Node Upgrade rejects non-GET before invoking the app', async t => {
	const server = await serve(t, { fetch: () => { throw new Error('Must not invoke app'); } });
	assert.equal((await upgrade(`${server.url}${PATHS[0]}`, {}, 'POST')).status, 405);
});

it('pre-upgrade failures preserve bounded safe headers and redact exceptions', async t => {
	const server = await serve(t, { fetch: () => { throw new Error(`private-error-${KEY}`); } });
	const response = await upgrade(`${server.url}${PATHS[0]}`);
	assert.equal(response.status, 500);
	assert.equal(response.body, 'Realtime request failed');
	assert.equal(server.upgrades(), 0);
});

it('bounded rejection does not clone, leak arbitrary headers or buffer a huge body', async t => {
	let cancelled = 0;
	const server = await serve(t, { fetch: () => new Response(new ReadableStream<Uint8Array>({
		start(c) { c.enqueue(new Uint8Array(8 * 1024 + 1).fill(65)); },
		cancel() { cancelled++; },
	}), { status: 429, headers: {
		'Retry-After': '60', 'X-OctaFuse-Error-Code': 'gateway.auth_rate_limited',
		Authorization: `Bearer ${KEY}`, 'Set-Cookie': KEY, Location: 'https://example.invalid/private',
		'X-Generation-Id': 'x'.repeat(513),
	} }) });
	const response = await upgrade(`${server.url}${PATHS[0]}`);
	assert.equal(response.status, 429);
	assert.equal(response.body, 'Realtime request rejected (HTTP 429)');
	assert.equal(response.headers['retry-after'], '60');
	assert.equal(response.headers.authorization, undefined);
	assert.equal(response.headers['set-cookie'], undefined);
	assert.equal(response.headers.location, undefined);
	assert.equal(response.headers['x-generation-id'], undefined);
	assert.equal(cancelled, 1);
});

it('peer FIN cancels a pending app without accepting a late dispatch', { timeout: 5_000 }, async t => {
	const entered = deferred<AbortSignal>();
	const release = deferred<void>();
	t.after(() => release.resolve());
	let attemptsAfterStop = 0;
	const server = await serve(t, { fetch: async (request, env) => {
		entered.resolve(request.signal);
		await release.promise;
		await assert.rejects(dispatchFrom(env)(route(), OPERATION), /cancelled/i);
		attemptsAfterStop++;
		return new Response(null, { status: 499 });
	} });
	const raw = connect(server.port, '127.0.0.1');
	t.after(() => raw.destroy());
	raw.write(rawUpgrade(PATHS[0]!));
	const signal = await entered.promise;
	const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
	raw.end();
	await aborted;
	release.resolve();
	await nextTurn();
	assert.equal(signal.aborted, true);
	assert.equal(server.upgrades(), 0);
	assert.equal(attemptsAfterStop, 1);
});

it('connection deadline closes the transport but drains owned app work', { timeout: 5_000 }, async t => {
	const entered = deferred<AbortSignal>();
	const release = deferred<void>();
	t.after(() => release.resolve());
	let completed = false;
	const server = await serve(t, { fetch: async request => {
		entered.resolve(request.signal); await release.promise; completed = true;
		return new Response('late response', { status: 400 });
	} });
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
	const pendingResponse = upgrade(`${server.url}${PATHS[0]}`);
	const signal = await entered.promise;
	t.mock.timers.tick(DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS);
	const response = await pendingResponse;
	assert.equal(response.status, 504);
	assert.equal(signal.aborted, true);
	assert.equal(completed, false, 'do not confuse transport closure with owned-work completion');
	assert.equal(server.upgrades(), 0);
	release.resolve();
	await nextTurn();
	assert.equal(completed, true);
});

it('deadline also bounds a never-ending HTTP rejection body', { timeout: 5_000 }, async t => {
	const reading = deferred<void>();
	const server = await serve(t, { fetch: () => new Response(new ReadableStream<Uint8Array>({
		pull() { reading.resolve(); return new Promise<void>(() => {}); },
	}), { status: 403 }) });
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
	const response = upgrade(`${server.url}${PATHS[0]}`);
	await reading.promise;
	t.mock.timers.tick(DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS);
	assert.equal((await response).status, 504);
});

it('pre-101 speculative frames have an independent byte ceiling', { timeout: 5_000 }, async t => {
	const entered = deferred<AbortSignal>(); const release = deferred<void>();
	t.after(() => release.resolve());
	const server = await serve(t, { fetch: async request => {
		entered.resolve(request.signal); await release.promise; return new Response(null, { status: 400 });
	} });
	const raw = connect(server.port, '127.0.0.1');
	t.after(() => raw.destroy());
	const received: Buffer[] = [];
	raw.on('data', chunk => received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
	const ended = new Promise<void>(resolve => raw.on('close', () => resolve()));
	raw.write(rawUpgrade(PATHS[0]!));
	const signal = await entered.promise;
	raw.write(Buffer.alloc(64 * 1024 + 1));
	await ended;
	assert.match(Buffer.concat(received).toString(), /^HTTP\/1.1 413 /);
	assert.equal(signal.aborted, true);
	assert.equal(server.upgrades(), 0);
	release.resolve();
});

function rawUpgrade(path: string): string {
	return `GET ${path} HTTP/1.1\r\nHost: localhost\r\n${Object.entries(WS_HEADERS).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
}
function route(endpoint = 'ws://127.0.0.1:1/unreachable'): RouteResult {
	return {
		targetId: 'synthetic-target', modelSurfaceId: null, routePoolId: null,
		providerId: 'synthetic-provider', providerName: 'Test', providerModelName: 'private-asr-model',
		upstreamProtocol: 'dashscope', upstreamOperation: OPERATION, adapter: 'passthrough',
		providerEndpoints: { dashscope: { endpoints: { 'audio.realtime.inference': endpoint } } },
		providerApiKey: 'synthetic-upstream-key', providerSharedChannelType: null,
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 0, routeWeight: 1,
		providerKeyId: null, providerKeyLabel: null, providerKeyFingerprint: null,
	};
}

it('post-101 admission exceptions use a fixed safe close reason', { timeout: 5_000 }, async t => {
	let admissions = 0;
	const server = await serve(t, { fetch: async (request, env) => {
		const result = await dispatchFrom(env)(route(), OPERATION, request.signal, undefined, undefined, undefined,
			async () => { admissions++; throw new Error(`private-admission-${KEY}-${'密'.repeat(500)}`); });
		return result.response;
	} });
	const client = new Ws(server.url.replace('http:', 'ws:') + PATHS[0]);
	client.on('error', () => {});
	t.after(() => client.terminate());
	const closed = await new Promise<{ code: number; reason: string }>(resolve => {
		client.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
	});
	assert.equal(server.upgrades(), 1);
	assert.equal(admissions, 1);
	assert.deepEqual(closed, { code: 1011, reason: 'Realtime request failed' });
});

for (const path of PATHS) {
	it(`native ${path} bridges a local upstream after preparation and keeps cancellation live`, { timeout: 5_000 }, async t => {
		const upstream = createServer();
		const upstreamWss = createNodeWebSocketServer();
		const upstreamSockets: NodeWebSocket[] = [];
		let admission = false; let upstreamCalls = 0;
		upstream.on('upgrade', (request, socket, head) => {
			upstreamCalls++;
			assert.equal(admission, true);
			assert.equal(request.headers.authorization, 'Bearer synthetic-upstream-key');
			assert.equal(request.headers['sec-websocket-protocol'], undefined);
			upstreamWss.handleUpgrade(request, socket, head, ws => {
				upstreamSockets.push(ws);
				ws.on('error', () => {});
				ws.on('message', data => {
					assert.equal(JSON.parse(data.toString()).payload.model, 'private-asr-model');
					ws.send('{"header":{"event":"task-finished"},"payload":{"usage":{"duration":1}}}');
				});
			});
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const address = upstream.address(); assert.ok(address && typeof address !== 'string');
		t.after(async () => {
			for (const ws of upstreamSockets) ws.terminate();
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		});
		const prepared = deferred<void>(); const allowDispatch = deferred<void>();
		t.after(() => allowDispatch.resolve());
		const dispatched = deferred<ProxyDispatchResult>();
		let requestSignal: AbortSignal | undefined;
		let appCalls = 0;
		const server = await serve(t, { fetch: async (request, env) => {
			appCalls++; requestSignal = request.signal;
			assert.equal(request.headers.get('sec-websocket-protocol'), KEY_PROTOCOL);
			prepared.resolve(); await allowDispatch.promise;
			const result = await dispatchFrom(env)(route(`ws://127.0.0.1:${address.port}/inference`), OPERATION,
				request.signal, undefined, undefined, undefined, async () => { admission = true; });
				dispatched.resolve(result); return result.response;
		} });
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		const client = new Ws(server.url.replace('http:', 'ws:') + path, [KEY_PROTOCOL]);
		client.on('error', () => {}); t.after(() => client.terminate());
		const message = new Promise<string>(resolve => client.on('message', data => resolve(data.toString())));
		client.on('open', () => client.send('{"header":{"action":"run-task"},"payload":{"model":"gateway-model"}}'));
		await prepared.promise;
		assert.equal(server.upgrades(), 0); assert.equal(upstreamCalls, 0);
		allowDispatch.resolve();
		assert.match(await message, /task-finished/);
		const result = await dispatched.promise;
		assert.equal(server.upgrades(), 1); assert.equal(upstreamCalls, 1); assert.equal(appCalls, 1);
		await nextTurn();
		t.mock.timers.tick(DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS + 1);
		assert.equal(requestSignal?.aborted, false, 'successful session outlives the connection deadline');
		assert.equal(client.readyState, 1);
		client.terminate();
		await result.usagePromise;
		await nextTurn();
		assert.equal(requestSignal?.aborted, true);
	});
}

it('an elapsed clock cannot accept 101 before the deadline timer is serviced', { timeout: 5_000 }, async t => {
	const entered = deferred<void>(); const release = deferred<void>();
	t.after(() => release.resolve());
	const server = await serve(t, { fetch: async (_request, env) => {
		entered.resolve(); await release.promise;
		await assert.rejects(dispatchFrom(env)(route(), OPERATION), /deadline exceeded/i);
		return new Response(null, { status: 504 });
	} });
	const response = upgrade(`${server.url}${PATHS[0]}`);
	await entered.promise;
	const elapsed = Date.now() + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS + 1;
	t.mock.method(Date, 'now', () => elapsed);
	release.resolve();
	assert.equal((await response).status, 504);
	assert.equal(server.upgrades(), 0);
});

it('invalid WebSocket handshake cannot reach admission or upstream', { timeout: 5_000 }, async t => {
	let admissions = 0;
	const server = await serve(t, { fetch: async (request, env) => {
		const result = await dispatchFrom(env)(route(), OPERATION, request.signal, undefined, undefined, undefined,
			async () => { admissions++; });
		return result.response;
	} });
	const result = await upgrade(`${server.url}${PATHS[0]}`, { 'Sec-WebSocket-Key': 'invalid' });
	assert.equal(result.status, 400);
	assert.equal(admissions, 0);
});

it('post-101 deadline observes late admission without starting an upstream', { timeout: 5_000 }, async t => {
	const admitted = deferred<void>(); const release = deferred<void>(); const completed = deferred<ProxyDispatchResult>();
	t.after(() => release.resolve());
	const server = await serve(t, { fetch: async (request, env) => {
		const result = await dispatchFrom(env)(route(), OPERATION, request.signal, undefined, undefined, undefined,
			async () => { admitted.resolve(); await release.promise; });
		completed.resolve(result); return result.response;
	} });
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
	const client = new Ws(server.url.replace('http:', 'ws:') + PATHS[0]);
	client.on('error', () => {}); t.after(() => client.terminate());
	const closed = new Promise<void>(resolve => client.on('close', () => resolve()));
	await admitted.promise;
	t.mock.timers.tick(DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS);
	await closed;
	release.resolve();
	const result = await completed.promise;
	assert.equal(result.response.status, 504);
	assert.equal(result.meta?.upstreamOutcomeUnknown, false);
	assert.equal(result.meta?.admissionDeniedPreDispatch, true);
	assert.equal(server.upgrades(), 1);
});

it('Upgrade head and later pre-101 frames transfer once in order', { timeout: 5_000 }, async t => {
	const upstream = createServer(); const upstreamWss = createNodeWebSocketServer();
	const upstreamSockets: NodeWebSocket[] = [];
	const messages = deferred<number[]>(); const observed: number[] = [];
	upstream.on('upgrade', (request, socket, head) => upstreamWss.handleUpgrade(request, socket, head, ws => {
		upstreamSockets.push(ws); ws.on('error', () => {});
		ws.on('message', data => {
			const event = JSON.parse(data.toString());
			assert.equal(event.payload.model, 'private-asr-model');
			observed.push(event.payload.n);
			if (observed.length === 2) messages.resolve(observed);
		});
	}));
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const address = upstream.address(); assert.ok(address && typeof address !== 'string');
	t.after(async () => {
		for (const ws of upstreamSockets) ws.terminate();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	});
	const prepared = deferred<void>(); const allowDispatch = deferred<void>(); const dispatched = deferred<ProxyDispatchResult>();
	t.after(() => allowDispatch.resolve());
	const server = await serve(t, { fetch: async (request, env) => {
		prepared.resolve(); await allowDispatch.promise;
		const result = await dispatchFrom(env)(route(`ws://127.0.0.1:${address.port}/inference`), OPERATION, request.signal);
		dispatched.resolve(result); return result.response;
	} });
	function frame(n: number): Buffer {
		const payload = Buffer.from(JSON.stringify({ header: { action: 'run-task' }, payload: { model: 'gateway', n } }));
		assert.ok(payload.byteLength < 126);
		const mask = Buffer.from([1, 2, 3, 4]);
		return Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), mask, payload.map((value: number, i: number) => value ^ mask[i % 4]!) ]);
	}
	const raw = connect(server.port, '127.0.0.1');
	raw.on('data', () => {}); t.after(() => raw.destroy());
	raw.write(Buffer.concat([Buffer.from(rawUpgrade(PATHS[0]!)), frame(0)]));
	await prepared.promise;
	raw.write(frame(1)); await nextTurn();
	assert.equal(server.upgrades(), 0);
	allowDispatch.resolve();
	assert.deepEqual(await messages.promise, [0, 1]);
	assert.equal(server.upgrades(), 1);
	const result = await dispatched.promise;
	raw.destroy(); await result.usagePromise;
});
