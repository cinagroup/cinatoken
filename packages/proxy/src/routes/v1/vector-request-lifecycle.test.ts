import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
	clearGcpServiceAccountTokenCache, computeRouteDataPolicySubjectFingerprintFromRows,
	createD1StorageContext, createEncryptedProvidersRepository, GCP_OAUTH_TOKEN_URL,
	type EffectiveGuardrailRow, type ModelRow, type ModelRouteRow, type ProviderRow, type ResolvedGatewayKeyRow,
} from '@octafuse/core';
import { createProxyApp } from '../../app';
import { isVectorInferenceRequest } from '../../middleware/text-request-lifecycle';
import { drainNodeBackgroundWork } from '../../runtime/schedule-background-work';
import { resetProviderCircuitStateForTests } from '../../services/provider-circuit-breaker';
import { resetUserModelCircuitStateForTests } from '../../services/user-model-circuit-breaker';
import { TEXT_REQUEST_DEADLINE_MS } from '../../services/request-deadline';
import { MAX_REQUEST_BODY_BYTES } from '../../services/bounded-request-body';
import { createRequestCapacityPool } from '../../services/request-capacity';
import { drainNodeResourceWork } from '../../runtime/schedule-resource-completion';

const NOW = '2026-09-06T00:00:00.000Z';
const nativeFetch = globalThis.fetch;
type Operation = 'embeddings' | 'rerank';
const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'synthetic@example.invalid', private_key: privateKey });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
async function until(check: () => boolean) {
	const end = performance.now() + 3000;
	while (!check()) { if (performance.now() >= end) throw new Error('Local test observation timed out'); await nextTurn(); }
}
function input(operation: Operation) {
	return { model: 'vector-model', ...(operation === 'embeddings' ? { input: ['synthetic input'] } : { query: 'synthetic', documents: ['synthetic document'] }) };
}
function responseBody(operation: Operation) {
	return operation === 'embeddings'
		? { object: 'list', model: 'private-model', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1, total_tokens: 1 } }
		: { model: 'private-model', results: [{ index: 0, relevance_score: 0.5 }], usage: { total_tokens: 1 } };
}
function request(path: string, body: BodyInit, signal?: AbortSignal, declaredLength?: number) {
	const init = { method: 'POST', signal, body, duplex: 'half', headers: {
		Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json',
		...(declaredLength === undefined ? {} : { 'Content-Length': String(declaredLength) }),
	} };
	return new Request('https://gateway.example.invalid' + path, init);
}
function send(app: ReturnType<typeof createProxyApp>, req: Request) {
	return app.fetch(req, { REQUEST_BODY_LOGGING: 'off' });
}
async function assertStop(response: Response, status: 499 | 504 | 413) {
	const body = await response.text();
	assert.equal(response.status, status, body);
	const code = status === 499 ? 'gateway.request_cancelled' : status === 504 ? 'gateway.request_deadline_exceeded' : 'gateway.payload_too_large';
	assert.equal(response.headers.get('X-OctaFuse-Error-Code'), code);
	assert.doesNotMatch(body, /PRIVATE_DETAIL|PRIVATE KEY|@example/);
}

/** Real Hono/auth/planner/driver; synthetic rows and a narrowly checked SQL sink, NOT a financial DB. */
async function fixture(t: TestContext, operation: Operation, credential = 'synthetic-provider-key', options?: Parameters<typeof createProxyApp>[1], upstreamBase = 'https://upstream.example.invalid/v1') {
	const calls: string[] = [], errors: unknown[][] = [];
	const hooks = new Map<string, () => Promise<void>>();
	const touch = async (phase: string) => { calls.push(phase); await hooks.get(phase)?.(); };
	let batches = 0;
	function result<T>(): D1Result<T> {
		return { results: [], success: true, meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 1, last_row_id: 0, changes: 1, changed_db: true } };
	}
	class Statement {
		constructor(readonly sql: string) {}
		bind(..._values: unknown[]) { return this; }
		async first<T = Record<string, unknown>>(): Promise<T | null> { throw new Error('Unexpected fixture first'); }
		async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { throw new Error('Unexpected fixture run'); }
		async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			assert.match(this.sql, /FROM workspace_budgets budget/); await touch('workspace-budget'); return result<T>();
		}
		raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
		raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
		async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
			assert.notEqual(options?.columnNames, true); assert.match(this.sql, /select "value" from "system_config"/); return [];
		}
	}
	const db: D1Database = {
		prepare: sql => new Statement(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			for (const statement of statements) {
				assert.ok(statement instanceof Statement);
				assert.match(statement.sql, /^\s*INSERT\s+INTO\s+(api_key_request_logs|public_model_daily_stats|provider_attempt_availability)/i);
			}
			batches++; return statements.map(() => result<T>());
		},
		exec: async () => { throw new Error('Unexpected fixture exec'); },
		withSession: () => { throw new Error('Unexpected fixture session'); }, dump: async () => { throw new Error('Unexpected fixture dump'); },
	};
	const storage = createD1StorageContext(db), repos = storage.repositories;
	const key: ResolvedGatewayKeyRow = {
		id: 'vector-key', key: 'synthetic-client-key', user_id: 'vector-user', workspace_id: 'vector-workspace', name: 'Synthetic',
		status: 'active', metadata: null, last_used_at: null, created_at: NOW, updated_at: NOW, user_email: null, user_metadata: null,
		user_charged_cost_factors: null, budget_max: null, budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
		budget_epoch: 0, budget_reserved_micros: 0, include_byok_in_limit: false, limit_micros: null, limit_epoch: 0, limit_reset: null, expires_at: null,
	};
	const model: ModelRow = { id: 'vector-model', display_name: 'Synthetic', vendor: 'test', context_window: 8192, max_tokens: 1024,
		pricing_profile: null, tags: '[]', description: null, metadata: null, input_modalities: '["text"]', output_modalities: JSON.stringify([operation]),
		released_at: null, route_policy: '{"strategy":"weight_priority"}', created_at: NOW };
	const routes: ModelRouteRow[] = [0, 1].map(i => ({ id: 'target-' + i, model_id: model.id, provider_id: 'provider-' + i,
		provider_model_name: 'private-model', priority: i, status: 'active', route_group: 'default', weight: 1, price_override: null, custom_params: null,
		upstream_protocol: 'openai', upstream_operation: operation, adapter: 'passthrough', routing_metadata: null }));
	const providers: ProviderRow[] = routes.map(route => ({ id: route.provider_id, name: route.provider_id, api_key: credential,
		endpoints: JSON.stringify({ openai: { base: upstreamBase } }), status: 'active', description: null, created_at: NOW }));
	const endpoints = await Promise.all(routes.map(async (route, index) => ({ id: 'endpoint-' + index, model_id: model.id, provider_id: route.provider_id,
		provider_slug: 'test', tag: 'test', endpoint_class: null, region: null, context_length: 8192, max_prompt_tokens: null, max_completion_tokens: 1024,
		quantization: null, supported_parameters: '[]', pricing: '{"currency":"USD","prompt":"0","completion":"0"}',
		supports_implicit_caching: false, supports_voice_cloning: false, audio_capabilities: '{}', image_capabilities: '{}',
		supports_tool_choice: '{"auto":false,"function":false,"none":false,"required":false}', evidence_url: 'https://upstream.example.invalid/evidence',
		verified_by: 'test', verified_at: NOW, expires_at: '2099-01-01T00:00:00.000Z', status: 'verified' as const, created_at: NOW, updated_at: NOW,
		route_target_id: route.id, subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(route, providers[index]!) })));
	repos.apiKeys.getApiKeyWithUserByKey = async () => { await touch('auth'); return key; };
	repos.apiKeys.getApiKeyByIdInWorkspace = async () => { await touch('key-limit'); return key; };
	repos.guardrails.getEffectiveForRequest = async () => { await touch('guardrail'); return []; };
	repos.userAuditLogs.insertUserAuditLog = async () => { await touch('audit-write'); };
	repos.modelRouting.getModelById = async () => { await touch('model'); return model; };
	repos.modelRouting.resolveModelSurface = async () => { await touch('surface'); return null; };
	repos.modelRouting.getModelRoutesByModelId = async () => { await touch('routes'); return routes; };
	repos.providers.getProvidersByIds = async () => { await touch('provider'); return providers; };
	repos.modelEndpoints.listRuntimeBindingsByRouteTargetIds = async () => { await touch('endpoint'); return endpoints; };
	repos.routeDataPolicies.getByRouteTargetIds = async () => { await touch('policy'); return []; };
	repos.systemConfig.getConfig = async () => { await touch('config'); return null; };
	repos.byokKeys.listActiveForRequest = async () => [];
	repos.byokKeys.shouldSuppressSharedCapacityForRequest = async () => false;
	repos.requestLogs.getRecentRoutePerformanceSamples = async () => [];
	repos.requestLogs.getRouteAvailabilityAggregates = async () => [];
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external fetch'); });
	t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
	t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
	t.after(async () => { await drainNodeBackgroundWork(); assert.deepEqual(errors, [], 'no swallowed settlement/ingress errors'); });
	return { app: createProxyApp(async () => storage, options), storage, repos, key, model, calls, hooks, batches: () => batches };
}

for (const operation of ['embeddings', 'rerank'] as const) for (const prefix of ['/v1/', '/api/v1/'])
for (const mode of ['mime', 'late-client', 'late-deadline'] as const)
for (const ack of ['resolve', 'reject'] as const) it(`${prefix}${operation}: ${mode}/${ack} cleanup owns capacity after accounting`, { timeout: 5000 }, async t => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1024 });
	const f = await fixture(t, operation, undefined, { httpCapacity: { pool, reservedBytesPerRequest: 1024 } });
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
	const headers = deferred<void>(), abort = new AbortController();
	let release!: () => void, reject!: (reason: Error) => void, cancels = 0, sends = 0;
	const gate = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
	t.after(async () => { headers.resolve(); release(); abort.abort(); await drainNodeResourceWork(); });
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		if (mode !== 'mime') await headers.promise;
		return new Response(new ReadableStream({ cancel() { cancels++; return gate; } }), { headers: { 'Content-Type': 'text/html' } });
	});
	const pending = send(f.app, request(prefix + operation, JSON.stringify(input(operation)), abort.signal));
	if (mode !== 'mime') {
		await until(() => sends === 1);
		if (mode === 'late-client') abort.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
	}
	const response = await pending;
	assert.equal(response.status, mode === 'mime' ? 502 : mode === 'late-client' ? 499 : 504);
	if (mode === 'late-client') await assert.rejects(response.text(), /Gateway response delivery stopped/);
	else await response.text();
	await drainNodeBackgroundWork();
	assert.equal(pool.snapshot().requests, 1, 'raw fetch is still owned before late headers');
	headers.resolve(); await until(() => cancels === 1);
	assert.equal(f.batches(), 1); assert.equal(cancels, 1); assert.equal(sends, 1);
	assert.equal(pool.snapshot().requests, 1);
	const rejected = await send(f.app, request(prefix + operation, JSON.stringify(input(operation))));
	assert.equal(rejected.status, 503); await rejected.text(); assert.equal(sends, 1);
	if (ack === 'resolve') release(); else reject(new Error('PRIVATE_CANCEL_DETAIL'));
	await drainNodeResourceWork();
	assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1);
});

for (const operation of ['embeddings', 'rerank'] as const) for (const prefix of ['/v1/', '/api/v1/'])
for (const mode of ['full', 'partial', 'last-page', 'cancel'] as const)
it(`${prefix}${operation}: ${mode} upload ownership does not rewrite successful accounting`, { timeout: 5000 }, async t => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1024 });
	const f = await fixture(t, operation, undefined, { httpCapacity: { pool, reservedBytesPerRequest: 1024 } });
	const payload = input(operation);
	if (mode === 'partial') {
		if ('input' in payload) payload.input = ['x'.repeat(200000)];
		else payload.query = 'x'.repeat(200000);
	}
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, sends = 0;
	t.after(async () => { reader?.releaseLock(); await drainNodeResourceWork(); });
	t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
		sends++; assert.ok(init?.body instanceof ReadableStream);
		if (mode === 'full') {
			const text = await new Response(init.body).text();
			assert.equal(new TextEncoder().encode(text).byteLength, Number(new Headers(init.headers).get('Content-Length')));
			assert.equal((JSON.parse(text) as { model: string }).model, 'private-model');
		} else if (mode === 'cancel') await init.body.cancel();
		else { const activeReader = init.body.getReader(); reader = activeReader; assert.equal((await activeReader.read()).done, false); }
		return Response.json(responseBody(operation));
	});
	const response = await send(f.app, request(prefix + operation, JSON.stringify(payload)));
	assert.equal(response.status, 200); await response.text();
	await drainNodeBackgroundWork(); await drainNodeResourceWork();
	assert.equal(f.batches(), 1); assert.equal(sends, 1);
	assert.equal(pool.snapshot().requests, mode === 'full' || mode === 'cancel' ? 0 : 1);
	if (reader) await assert.rejects(reader.read(), /JSON upload stopped/);
});

beforeEach(() => { clearGcpServiceAccountTokenCache(); resetProviderCircuitStateForTests(); resetUserModelCircuitStateForTests(); });

function blockingPolicy(): EffectiveGuardrailRow {
	return { id: 'policy', workspace_id: 'vector-workspace', owner_user_id: 'vector-user', name: 'Synthetic', description: null,
		status: 'active', designated_version: 1, latest_version: 1, created_at: NOW, updated_at: NOW, version_id: 'policy-v1',
		version_config_json: '{"allowed_models":["not-this-model"]}', version_created_by_user_id: 'vector-user', version_created_at: NOW,
		assignment_id: 'assignment', assignment_scope_type: 'user', assignment_scope_id: 'vector-user' };
}

for (const operation of ['embeddings', 'rerank'] as const) {
	for (const stop of ['client', 'deadline'] as const) {
		it(`${operation}: ${stop} during guardrail audit hashing cannot start the audit write`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<ArrayBuffer>(); let hashes = 0;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.repos.guardrails.getEffectiveForRequest = async () => {
				t.mock.method(crypto.subtle, 'digest', () => { hashes++; return gate.promise; }); return [blockingPolicy()];
			};
			const pending = send(f.app, request('/api/v1/' + operation, JSON.stringify(input(operation)), parent.signal));
			await until(() => hashes === 1);
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			gate.resolve(new ArrayBuffer(32)); await nextTurn();
			assert.equal(hashes, 1); assert.equal(f.calls.includes('audit-write'), false); assert.equal(f.batches(), 0);
		});
		it(`${operation}: ${stop} cannot orphan an already-started guardrail audit`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>(); let settled = false;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.repos.guardrails.getEffectiveForRequest = async () => [blockingPolicy()];
			f.hooks.set('audit-write', () => gate.promise);
			const pending = send(f.app, request('/api/v1/' + operation, JSON.stringify(input(operation)), parent.signal));
			void Promise.resolve(pending).then(() => { settled = true; });
			await until(() => f.calls.includes('audit-write'));
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextTurn(); assert.equal(settled, false);
			gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504);
			assert.equal(f.calls.includes('model'), false); assert.equal(f.batches(), 0);
		});
		it(`${operation}: ${stop} drains the actual encryption wrapper's first compatibility write and forbids its second`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>(); let writes = 0, settled = false;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.repos.providers.updateProviderByPatch = async (_id, patch) => {
				assert.equal(typeof patch.api_key, 'string'); assert.match(String(patch.api_key), /^enc:v2:/); writes++; await gate.promise;
				return 1;
			};
			const storage = { ...f.storage, repositories: { ...f.repos,
				providers: createEncryptedProvidersRepository(f.repos.providers, 'synthetic-vector-encryption-secret-32-characters') } };
			const app = createProxyApp(async () => storage);
			const pending = send(app, request('/api/v1/' + operation, JSON.stringify(input(operation)), parent.signal));
			void Promise.resolve(pending).then(() => { settled = true; });
			await until(() => writes === 1);
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextTurn(); assert.equal(settled, false);
			gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504); await nextTurn();
			assert.equal(writes, 1); assert.equal(f.batches(), 0);
		});
	}
	it(`${operation}: actual global body overflow remains 413 rather than invalid JSON`, { timeout: 5000 }, async t => {
		const f = await fixture(t, operation); let cancelled = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(MAX_REQUEST_BODY_BYTES + 1)); }, cancel() { cancelled++; return new Promise<void>(() => {}); } });
		await assertStop(await send(f.app, request('/v1/' + operation, source)), 413);
		assert.equal(cancelled, 1); assert.equal(f.calls.includes('guardrail'), false); assert.equal(f.batches(), 0);
	});
	it(`${operation}: provider redirect is not followed and cannot hide a second POST`, async t => {
		const f = await fixture(t, operation); let sends = 0;
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.equal(init?.redirect, 'manual');
			return new Response('redirect', { status: 307, headers: { location: 'https://must-not-follow.example.invalid/' } });
		});
		const response = await send(f.app, request('/v1/' + operation, JSON.stringify(input(operation))));
		assert.equal(response.status, 502);
		assert.equal(response.headers.get('location'), null);
		await response.text(); await drainNodeBackgroundWork(); assert.equal(sends, 1);
	});
	it(`${operation}: ingress abort listeners are released at response handoff`, async t => {
		const f = await fixture(t, operation); let signal: AbortSignal | undefined;
		const app = createProxyApp(async c => { signal = c.get('textRequestLifecycle')?.deadline.signal; return f.storage; });
		t.mock.method(globalThis, 'fetch', async () => Response.json(responseBody(operation)));
		const response = await send(app, request('/v1/' + operation, JSON.stringify(input(operation))));
		assert.equal(response.status, 200); await response.text(); assert.ok(signal);
		assert.equal(getEventListeners(signal, 'abort').length, 0);
	});
}

for (const operation of ['embeddings', 'rerank'] as const) for (const prefix of ['/v1/', '/api/v1/']) for (const redirectStatus of [307, 308]) {
	it('vector ' + prefix + operation + ' refuses browser-visible HTTP ' + redirectStatus + ' before a second provider POST', { timeout: 15_000 }, async t => {
		const providerPosts: Array<{ method: string; body: string }> = [];
		let gatewayBase = '';
		const upstream = createServer(async (incoming, outgoing) => {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			providerPosts.push({ method: incoming.method ?? '', body: Buffer.concat(chunks).toString('utf8') });
			if (providerPosts.length === 1) {
				outgoing.writeHead(redirectStatus, { Location: gatewayBase + prefix + operation });
				outgoing.end('upstream redirect');
			} else {
				outgoing.writeHead(200, { 'Content-Type': 'application/json' });
				outgoing.end(JSON.stringify(responseBody(operation)));
			}
		});
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		t.after(async () => {
			upstream.closeAllConnections();
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		});
		const upstreamBase = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port + '/v1';
		const f = await fixture(t, operation, undefined, undefined, upstreamBase);
		t.mock.method(globalThis, 'fetch', nativeFetch);
		let gatewayPosts = 0;
		let unsafePosts = 0;
		const unsafeBodies: string[] = [];
		const gateway = createServer(async (incoming, outgoing) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				const body = Buffer.concat(chunks);
				if (incoming.url === '/unsafe') {
					unsafePosts++;
					unsafeBodies.push(body.toString('utf8'));
					if (unsafePosts === 1) {
						outgoing.writeHead(redirectStatus, { Location: '/unsafe' });
						outgoing.end();
					} else {
						outgoing.writeHead(200);
						outgoing.end('followed');
					}
					return;
				}
				gatewayPosts++;
				const request = new Request(gatewayBase + incoming.url, {
					method: incoming.method, headers: incoming.headers as HeadersInit,
					body: body.length > 0 ? body : undefined,
				});
				const response = await f.app.fetch(request, { REQUEST_BODY_LOGGING: 'off' });
				outgoing.writeHead(response.status, Object.fromEntries(response.headers));
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			} catch (error) {
				outgoing.writeHead(500);
				outgoing.end(error instanceof Error ? error.message : String(error));
			}
		});
		await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
		t.after(async () => {
			gateway.closeAllConnections();
			await new Promise<void>(resolve => gateway.close(() => resolve()));
		});
		gatewayBase = 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port;
		const body = JSON.stringify(input(operation));
		const negative = await nativeFetch(gatewayBase + '/unsafe', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
		});
		assert.equal(negative.status, 200);
		assert.equal(unsafePosts, 2);
		assert.deepEqual(unsafeBodies, [body, body]);

		const response = await nativeFetch(gatewayBase + prefix + operation, {
			method: 'POST',
			headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body,
		});
		assert.equal(response.status, 502, await response.text());
		assert.equal(response.headers.get('location'), null);
		assert.equal(gatewayPosts, 1);
		assert.equal(providerPosts.length, 1);
		assert.equal(providerPosts[0]?.method, 'POST');
		assert.match(providerPosts[0]?.body ?? '', /private-model/);
		await drainNodeBackgroundWork();
		assert.equal(f.batches(), 1);
	});
}

it('vector lifecycle selection is exact and does not capture catalog, Batch or text routes', () => {
	for (const prefix of ['/v1/', '/api/v1/']) for (const operation of ['embeddings', 'rerank']) {
		assert.equal(isVectorInferenceRequest('POST', prefix + operation), true);
		assert.equal(isVectorInferenceRequest('POST', prefix + operation + '/'), true);
		assert.equal(isVectorInferenceRequest('GET', prefix + operation), false);
		assert.equal(isVectorInferenceRequest('POST', prefix + operation + '/models'), false);
	}
	for (const path of ['/v1/responses', '/v1/batches', '/v1/embeddings-more', '/v2/rerank']) assert.equal(isVectorInferenceRequest('POST', path), false);
});

for (const operation of ['embeddings', 'rerank'] as const) for (const prefix of ['/v1/', '/api/v1/']) {
	const path = prefix + operation;
	for (const stop of ['client', 'deadline'] as const) for (const declared of [false, true]) {
		it(`${path}: silent upload ${stop}, Content-Length=${declared}`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation); const parent = new AbortController(); let cancelled = 0;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise<void>(() => {}); } });
			const pending = send(f.app, request(path, source, parent.signal, declared ? 128 : undefined));
			await until(() => f.calls.includes('auth'));
			if (stop === 'client') parent.abort('PRIVATE_DETAIL'); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			assert.equal(cancelled, 1); assert.equal(source.locked, false); assert.equal(f.batches(), 0);
			assert.equal(f.calls.includes('guardrail'), false);
		});
	}
	it(`${path}: early missing-key response cancels unread upload without awaiting ACK`, { timeout: 5000 }, async t => {
		const f = await fixture(t, operation); let pulls = 0, cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		const req = request(path, source); req.headers.delete('Authorization');
		assert.equal((await send(f.app, req)).status, 401); assert.equal(pulls, 0); assert.equal(cancels, 1); assert.equal(f.calls.length, 0);
	});
	it(`${path}: declared oversize is rejected before storage and cancels source`, async t => {
		const f = await fixture(t, operation); let calls = 0, cancels = 0;
		const app = createProxyApp(async () => { calls++; return f.storage; });
		await assertStop(await send(app, request(path, new ReadableStream({ cancel() { cancels++; } }), undefined, MAX_REQUEST_BODY_BYTES + 1)), 413);
		assert.equal(calls, 0); assert.equal(cancels, 1);
	});
	it(`${path}: successful bounded vector response retains one inference and one usage record`, async t => {
		const f = await fixture(t, operation); let sends = 0;
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => { sends++; assert.equal(init?.redirect, 'manual'); return Response.json(responseBody(operation)); });
		const response = await send(f.app, request(path, JSON.stringify(input(operation))));
		assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork();
		assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});
	it(`${path}: authentication time is subtracted from the later OAuth/dispatch deadline`, { timeout: 5000 }, async t => {
		const f = await fixture(t, operation, ACCOUNT); let oauth = 0, sends = 0;
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		f.hooks.set('auth', async () => { t.mock.timers.setTime(Date.parse(NOW) + TEXT_REQUEST_DEADLINE_MS - 10); });
		t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
			if (String(url) === GCP_OAUTH_TOKEN_URL) { oauth++; return new Promise<Response>(() => {}); }
			sends++; throw new Error('Must not dispatch');
		});
		const pending = send(f.app, request(path, JSON.stringify(input(operation))));
		await until(() => oauth === 1); t.mock.timers.tick(11);
		await assertStop(await pending, 504); assert.equal(sends, 0); assert.equal(oauth, 1);
	});
}

for (const operation of ['embeddings', 'rerank'] as const) for (const stop of ['client', 'deadline'] as const) {
	for (const phase of ['guardrail', 'key-limit', 'workspace-budget', 'model', 'config', 'surface', 'routes', 'provider', 'endpoint', 'policy']) {
		it(`${operation}: ${stop} during ${phase} read forbids late continuation`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation); const parent = new AbortController(), gate = deferred<void>();
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.hooks.set(phase, () => gate.promise);
			const body = { ...input(operation), ...(phase === 'policy' ? { provider: { data_collection: 'deny' } } : {}) };
			const pending = send(f.app, request('/v1/' + operation, JSON.stringify(body), parent.signal));
			await until(() => f.calls.includes(phase));
			if (stop === 'client') parent.abort('PRIVATE_DETAIL'); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			const stoppedCalls = [...f.calls]; gate.resolve(); await nextTurn(); await nextTurn();
			assert.deepEqual(f.calls, stoppedCalls); assert.equal(f.batches(), 0);
		});
	}
	for (const phase of ['storage', 'auth'] as const) {
		it(`${operation}: ${stop} retains ${phase} ownership until late acknowledgement then stops`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>(); let entered = false, settled = false;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const pause = async () => { entered = true; await gate.promise; };
			const app = phase === 'storage' ? createProxyApp(async () => { await pause(); return f.storage; }) : f.app;
			if (phase === 'auth') f.hooks.set('auth', pause);
			const pending = send(app, request('/v1/' + operation, JSON.stringify(input(operation)), parent.signal));
			void Promise.resolve(pending).then(() => { settled = true; });
			await until(() => entered);
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextTurn(); assert.equal(settled, false, 'potential initialization/legacy-auth writes must not be detached');
			gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504);
			assert.equal(f.calls.includes('guardrail'), false); assert.equal(f.batches(), 0);
		});
	}
}
