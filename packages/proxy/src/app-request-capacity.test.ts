import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { get, Server } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAdaptorServer } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { createProxyApp, type Env } from './app';
import { createRequestCapacityPool } from './services/request-capacity';
import { requestCapacityMiddleware } from './middleware/request-capacity';
import { drainNodeBackgroundWork, scheduleBackgroundWork } from './runtime/schedule-background-work';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(beforeAll: (...args: Parameters<MiddlewareHandler<Env>>) => ReturnType<MiddlewareHandler<Env>> | Response) {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 100 });
	let entered = 0, storageReads = 0;
	const app = createProxyApp(async () => { storageReads++; throw new Error('Unexpected storage read'); }, {
		httpCapacity: { pool, reservedBytesPerRequest: 100 },
		beforeAll: async (c, next) => { entered++; return beforeAll(c, next); },
	});
	return { app, pool, counts: () => ({ entered, storageReads }) };
}

test('capacity admission rejects before runtime checks, body reads, auth and storage', async () => {
	const gate = deferred<Response>();
	const { app, pool, counts } = fixture(() => gate.promise);
	const first = app.request('/hold');
	assert.equal(pool.snapshot().requests, 1);
	let pulls = 0;
	const body = new ReadableStream<Uint8Array>({ pull() { pulls++; } }, { highWaterMark: 0 });
	const init = { method: 'POST', body, duplex: 'half', headers: { 'content-length': '1' } };
	const denied = await app.fetch(new Request('https://gateway.test/v1/images/generations', init));
	assert.equal(denied.status, 503);
	assert.equal(denied.headers.get('x-octafuse-error-code'), 'gateway.capacity_unavailable');
	assert.equal(denied.headers.get('cache-control'), 'no-store');
	assert.equal(denied.headers.get('access-control-allow-origin'), '*');
	assert.equal(denied.headers.get('retry-after'), null);
	assert.deepEqual(await denied.json(), {
		error: { code: 503, message: 'Gateway capacity is unavailable', metadata: { error_type: 'server' } },
		code: 'gateway.capacity_unavailable',
	});
	assert.deepEqual(counts(), { entered: 1, storageReads: 0 });
	assert.equal(pulls, 0);
	gate.resolve(new Response('ok'));
	assert.equal(await (await first).text(), 'ok');
	assert.equal(pool.snapshot().requests, 0);
	await body.cancel();
});

for (const [method, path] of [
	['POST', '/v1/images'], ['POST', '/api/v1/images/generations'], ['POST', '/v1/images/edits'],
	['POST', '/api/v1/chat/completions'], ['POST', '/v1/audio/speech'], ['POST', '/v1/embeddings'],
	['POST', '/v1/messages'], ['POST', '/v1beta/models/test:generateContent'],
	['GET', '/api/v1/models'], ['GET', '/health'], ['PATCH', '/unknown'], ['OPTIONS', '/api/v1/images'],
] as const) test(`${method} ${path} shares the same HTTP pool without a path/header bypass`, async () => {
	const { app, pool, counts } = fixture((c) => c.text('held'));
	const first = await app.request('/hold');
	const denied = await app.request(path, { method, headers: { 'content-length': '0', 'x-capacity': '0' } });
	assert.equal(denied.status, 503);
	if (path.endsWith('/messages')) {
		const body = await denied.json() as { error: { type: string; message: string } };
		assert.equal(body.error.type, 'api_error');
		assert.equal(body.error.message, 'Gateway capacity is unavailable');
	} else await denied.text();
	assert.equal(counts().entered, 1);
	await first.text();
	assert.equal(pool.snapshot().requests, 0);
});

for (const firstFinished of ['response', 'accounting'] as const) test(`${firstFinished} completion alone cannot release the other owner`, async () => {
	const accounting = deferred<void>();
	const { app, pool } = fixture((c) => { scheduleBackgroundWork(c, accounting.promise); return c.text('ok'); });
	const response = await app.request('/test');
	if (firstFinished === 'response') await response.text();
	else { accounting.resolve(); await drainNodeBackgroundWork(); }
	assert.equal(pool.snapshot().requests, 1);
	const denied = await app.request('/test');
	assert.equal(denied.status, 503);
	await denied.text();
	if (firstFinished === 'response') { accounting.resolve(); await drainNodeBackgroundWork(); }
	else await response.text();
	assert.equal(pool.snapshot().requests, 0);
});

test('abort does not abandon the handler mutation or an independently running accounting task', async () => {
	const handler = deferred<Response>(), accounting = deferred<void>();
	const { app, pool } = fixture((c) => { scheduleBackgroundWork(c, accounting.promise); return handler.promise; });
	const controller = new AbortController();
	const request = app.fetch(new Request('https://gateway.test/test', { signal: controller.signal }));
	controller.abort();
	assert.equal(pool.snapshot().requests, 1);
	handler.resolve(new Response('not delivered'));
	const response = await request;
	await assert.rejects(response.text(), /delivery stopped/);
	assert.equal(pool.snapshot().requests, 1);
	accounting.resolve();
	await drainNodeBackgroundWork();
	assert.equal(pool.snapshot().requests, 0);
});

test('unread response cancellation and background work are independent', async () => {
	const accounting = deferred<void>();
	let cancelled = 0;
	const { app, pool } = fixture((c) => {
		scheduleBackgroundWork(c, accounting.promise);
		return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 }));
	});
	const response = await app.request('/test');
	await response.body!.cancel();
	assert.equal(cancelled, 1);
	assert.equal(pool.snapshot().requests, 1);
	accounting.resolve();
	await drainNodeBackgroundWork();
	assert.equal(pool.snapshot().requests, 0);
});

test('HEAD discards/cancels the GET body but retains asynchronous source cleanup', async () => {
	const cleanup = deferred<void>();
	let pulls = 0, cancels = 0;
	const { app, pool } = fixture(() => new Response(new ReadableStream<Uint8Array>({
		pull() { pulls++; }, cancel() { cancels++; return cleanup.promise; },
	}, { highWaterMark: 0 }), { headers: { 'x-test': 'preserved' } }));
	const response = await app.request('/test', { method: 'HEAD' });
	assert.equal(response.body, null);
	assert.equal(response.headers.get('x-test'), 'preserved');
	assert.equal(pulls, 0); assert.equal(cancels, 1);
	assert.equal(pool.snapshot().requests, 1);
	cleanup.resolve(); await drainNodeBackgroundWork();
	assert.equal(pool.snapshot().requests, 0);
});

test('a bodyless response releases immediately except for registered background work', async () => {
	const accounting = deferred<void>();
	const { app, pool } = fixture((c) => { scheduleBackgroundWork(c, accounting.promise); return new Response(null, { status: 204 }); });
	const response = await app.request('/test');
	assert.equal(response.status, 204);
	assert.equal(response.body, null);
	assert.equal(pool.snapshot().requests, 1);
	accounting.resolve(); await drainNodeBackgroundWork();
	assert.equal(pool.snapshot().requests, 0);
});

test('handler errors preserve the typed error response and remain owned through delivery', async () => {
	const { app, pool } = fixture(() => { throw new Error('synthetic-private'); });
	const response = await app.request('/test');
	assert.equal(response.status, 500);
	assert.equal(pool.snapshot().requests, 1);
	assert.doesNotMatch(await response.text(), /synthetic-private/);
	assert.equal(pool.snapshot().requests, 0);
});

test('opting into HTTP-only capacity refuses upgrades rather than bypassing admission', async () => {
	const { app, pool, counts } = fixture((c) => c.text('unreachable'));
	for (const upgrade of ['websocket', 'WebSocket', 'h2c', '']) {
		const response = await app.request('/v1/dashscope/realtime', { headers: { upgrade } });
		assert.equal(response.status, 503); await response.text();
	}
	assert.deepEqual(counts(), { entered: 0, storageReads: 0 });
	assert.equal(pool.snapshot().requests, 0);
});

test('policy validation is startup-time and captures the reservation rather than mutable config', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 2, maxReservedBytes: 10 });
	for (const reservedBytesPerRequest of [0, -1, 1.5, Infinity, 11]) {
		assert.throws(() => requestCapacityMiddleware({ pool, reservedBytesPerRequest }), RangeError);
	}
	const policy = { pool, reservedBytesPerRequest: 10 };
	const app = createProxyApp(async () => { throw new Error('unreachable'); }, {
		httpCapacity: policy, beforeAll: async (c) => c.text('ok'),
	});
	policy.reservedBytesPerRequest = 1;
	const response = await app.request('/test');
	assert.equal(pool.snapshot().reservedBytes, 10);
	await response.text();
});

test('apps in one instance may explicitly share a pool', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 10 });
	const make = () => createProxyApp(async () => { throw new Error('unreachable'); }, {
		httpCapacity: { pool, reservedBytesPerRequest: 10 }, beforeAll: async (c) => c.text('ok'),
	});
	const a = make(), b = make();
	const first = await a.request('/test');
	const denied = await b.request('/test');
	assert.equal(denied.status, 503); await denied.text();
	await first.text();
	assert.equal(await (await b.request('/test')).text(), 'ok');
	assert.equal(pool.snapshot().requests, 0);
});

test('unconfigured runtime behavior and response identity remain unchanged', async () => {
	const original = new Response('ok');
	const app = createProxyApp(async () => { throw new Error('unreachable'); }, { beforeAll: async () => original });
	const response = await app.request('/test', { headers: { upgrade: 'websocket' } });
	assert.equal(response, original);
	assert.equal(await response.text(), 'ok');
});

test('loopback Node disconnect retains producer cleanup and accounting after the client is gone', { timeout: 5000 }, async (t) => {
	const cleanup = deferred<void>(), accounting = deferred<void>();
	let cancels = 0;
	const { app, pool } = fixture((c) => {
		scheduleBackgroundWork(c, accounting.promise);
		return new Response(new ReadableStream<Uint8Array>({
			start(target) { target.enqueue(new TextEncoder().encode('first chunk')); },
			cancel() { cancels++; return cleanup.promise; },
		}, { highWaterMark: 0 }));
	});
	const server = createAdaptorServer({ fetch: app.fetch });
	assert.ok(server instanceof Server);
	t.after(async () => {
		cleanup.resolve(); accounting.resolve();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await drainNodeBackgroundWork();
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const origin = `http://127.0.0.1:${address.port}`;
	const clientResponse = deferred<import('node:http').IncomingMessage>();
	const client = get(origin + '/test', (response) => clientResponse.resolve(response));
	t.after(() => client.destroy());
	const response = await clientResponse.promise;
	await once(response, 'data');
	assert.equal(pool.snapshot().requests, 1);
	const denied = await fetch(origin + '/another');
	assert.equal(denied.status, 503); await denied.text();
	response.destroy();
	const end = performance.now() + 2000;
	while (cancels === 0) { assert.ok(performance.now() < end, 'Node adapter must propagate disconnect'); await nextTurn(); }
	assert.equal(cancels, 1);
	assert.equal(pool.snapshot().requests, 1);
	cleanup.resolve();
	await nextTurn();
	assert.equal(pool.snapshot().requests, 1);
	accounting.resolve();
	await drainNodeBackgroundWork();
	assert.equal(pool.snapshot().requests, 0);
});
