import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createD1StorageContext, computeRouteDataPolicySubjectFingerprintFromRows, hashLookupKey,
	createEncryptedByokKeysRepository, createEncryptedSharedKeysRepository, encryptSharedKeySecret } from '@octafuse/core';
import { buildDashScopeRealtimeAuthProtocol } from '@octafuse/core/realtime-protocol';
import { createProxyApp } from '../app';
import type { DashScopeRealtimeOperation } from '../services/egress/dashscope-realtime-driver';
import { resetProviderCircuitStateForTests } from '../services/provider-circuit-breaker';
import { resetUserModelCircuitStateForTests } from '../services/user-model-circuit-breaker';
import { createSqliteD1 } from '../test-support/sqlite-d1';
import { createNodeWebSocketServer, type NodeWebSocket } from './node-realtime';
import { handleNodeRealtimeUpgrade } from './node-realtime-upgrade';
import { drainNodeBackgroundWork } from './schedule-background-work';
import { EMPTY_USAGE } from '../services/proxy';
import { resetSharedKeyPoolStateForTests } from '../services/shared-key-pool';

const KEY = 'synthetic-realtime-ledger-key';
const MODEL = 'synthetic-realtime-ledger-model';
const CEILING = 601_000;
const SYNTHETIC_ENCRYPTION_SECRET = 'synthetic-local-byok-encryption-secret-32-bytes';
const Ws = (createRequire(import.meta.url)('ws') as {
	WebSocket: new (url: string, protocols?: string[]) => NodeWebSocket;
}).WebSocket;
const OPERATIONS = ['audio.transcriptions.realtime.inference', 'audio.transcriptions.realtime.session'] as const;
type Outcome = 'actual' | 'explicit_zero' | 'local_pcm' | 'missing_usage' | 'stream_error' | 'transport_unknown' | 'http_rejection' | 'http_ambiguous' | 'reject_then_actual' | 'reject_then_unknown';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
async function until(check: () => boolean) {
	const deadline = performance.now() + 3_000;
	while (!check()) {
		if (performance.now() >= deadline) throw new Error('Timed out observing local request state');
		await nextTurn();
	}
}

async function server(t: TestContext) {
	const http = createServer();
	const sockets = new Set<Socket>();
	http.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
	await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
	const address = http.address();
	assert.ok(address && typeof address !== 'string');
	let closing: Promise<void> | undefined;
	const close = () => closing ??= (async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => http.close(() => resolve()));
	})();
	t.after(close);
	return { http, url: `ws://127.0.0.1:${address.port}`, close };
}

async function fixture(t: TestContext, operation: DashScopeRealtimeOperation, outcome: Outcome) {
	resetProviderCircuitStateForTests();
	resetUserModelCircuitStateForTests();
	resetSharedKeyPoolStateForTests();
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected non-loopback fetch'); });
	const db = createSqliteD1();
	const servers: Array<Awaited<ReturnType<typeof server>>> = [];
	// Close DB last, after route-owned usage promises have settled.
	t.after(async () => {
		await Promise.all(servers.map(server => server.close()));
		await drainNodeBackgroundWork();
		db.sqlite.close();
	});
	const storage = createD1StorageContext(db.binding);
	const upstream = await server(t);
	servers.push(upstream);
	const upstreamWs = createNodeWebSocketServer();
	const inference = operation.endsWith('.inference');
	const providerModel = inference ? 'fun-asr-realtime' : 'qwen3-asr-flash-realtime';
	let dispatches = 0;
	const byokDispatches: boolean[] = [];
	const credentialKinds: string[] = [];
	let rejectPrivateByok = false;
	let rejectSharedFirst: 0 | 401 | 429 | 503 = 0;
	let holdUpstream: Promise<void> | undefined;
	const observedFrames: string[] = [];
	const dispatchSnapshots: ReturnType<typeof snapshot>[] = [];
	upstream.http.on('upgrade', (request, socket, head) => {
		dispatches++;
		byokDispatches.push(request.headers.authorization === 'Bearer synthetic-private-byok');
		const credential = request.headers.authorization === 'Bearer synthetic-private-byok' ? 'byok'
			: request.headers.authorization === 'Bearer synthetic-shared-1' ? 'shared-1'
				: request.headers.authorization === 'Bearer synthetic-shared-2' ? 'shared-2' : 'platform';
		credentialKinds.push(credential);
		dispatchSnapshots.push(snapshot());
		const rejection = rejectPrivateByok && credential === 'byok' ? 429 : credential === 'shared-1' ? rejectSharedFirst : 0;
		if (rejection) {
			socket.end(`HTTP/1.1 ${rejection} Synthetic rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
			return;
		}
		if (outcome === 'transport_unknown' || (outcome === 'reject_then_unknown' && dispatches === 2)) { socket.destroy(); return; }
		if (outcome === 'http_rejection' || (outcome.startsWith('reject_then_') && dispatches === 1)) {
			socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
			return;
		}
		if (outcome === 'http_ambiguous') {
			socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
			return;
		}
		upstreamWs.handleUpgrade(request, socket, head, ws => {
			ws.on('error', () => undefined);
			ws.on('message', (data, binary) => {
				if (binary) return;
				const text = data.toString();
				observedFrames.push(text);
				if (!text.includes('finish-task') && !text.includes('input_audio_buffer.commit')) return;
				const finish = () => {
					if (ws.readyState !== 1) return;
					if (outcome === 'stream_error') { ws.close(1011, 'synthetic failure'); return; }
					const duration = outcome === 'actual' || outcome === 'reject_then_actual' ? 1 : outcome === 'explicit_zero' ? 0 : undefined;
					const usage = duration == null ? undefined : { duration };
					ws.send(JSON.stringify(inference
						? { header: { event: 'task-finished', task_id: 'test-task' }, payload: { usage } }
						: { type: 'session.finished', usage }));
					ws.close(1000);
				};
				if (holdUpstream) void holdUpstream.then(finish).catch(() => ws.terminate());
				else finish();
			});
		});
	});
	const run = (sql: string, ...values: (string | number | null)[]) => db.sqlite.prepare(sql).run(...values);
	run('INSERT INTO users (id,email,budget_max) VALUES (?,?,?)', 'test-user', 'realtime@example.invalid', 2);
	run('INSERT INTO workspaces (id,scope_type,personal_owner_user_id,name,slug) VALUES (?,?,?,?,?)',
		'personal:test-user', 'personal', 'test-user', 'Test', 'test');
	const keyHash = await hashLookupKey(KEY);
	run('INSERT INTO api_keys (id,key,key_hash,user_id,workspace_id,limit_micros) VALUES (?,?,?,?,?,?)',
		'test-key', `hashref:${keyHash}`, keyHash, 'test-user', 'personal:test-user', 2_000_000);
	run('INSERT INTO providers (id,name,api_key,endpoints) VALUES (?,?,?,?)', 'test-provider', 'Test', 'synthetic-upstream-key',
		JSON.stringify({ dashscope: { endpoints: { 'audio.realtime.inference': `${upstream.url}/inference`, 'audio.realtime.session': `${upstream.url}/realtime` } } }));
	run('INSERT INTO models (id,display_name,input_modalities,output_modalities) VALUES (?,?,?,?)', MODEL, 'Test', '["audio"]', '["text"]');
	run('INSERT INTO model_routes (id,model_id,provider_id,provider_model_name,upstream_protocol,upstream_operation,adapter) VALUES (?,?,?,?,?,?,?)',
		'test-route', MODEL, 'test-provider', providerModel, 'dashscope', operation, 'passthrough');
	run('INSERT INTO model_endpoints (id,model_id,provider_id,provider_slug,tag,pricing,audio_capabilities,status,verified_at,expires_at,verified_by,evidence_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
		'test-endpoint', MODEL, 'test-provider', 'test-provider', 'standard',
		JSON.stringify({ currency: 'USD', prompt: '0', completion: '0' }),
		JSON.stringify({ v: 1, pricing_by_operation: { [operation]: { currency: 'USD', meter: { kind: 'duration', unit: 'second', price: '0.001', minimum_units: 0, increment_units: 1 } } } }),
		'verified', '2026-09-01T00:00:00Z', '2099-01-01T00:00:00Z', 'synthetic-test', 'https://upstream.invalid/evidence');
	run("UPDATE model_endpoints SET endpoint_class = 'standard'");
	const route = (await storage.repositories.modelRouting.getModelRoutesByModelId(MODEL))[0]!;
	const provider = await storage.repositories.providers.getProviderById('test-provider');
	assert.ok(provider);
	run('INSERT INTO model_endpoint_routes (endpoint_id,route_target_id,subject_fingerprint) VALUES (?,?,?)',
		'test-endpoint', 'test-route', await computeRouteDataPolicySubjectFingerprintFromRows(route, provider));
	if (outcome.startsWith('reject_then_')) {
		run("UPDATE model_routes SET priority = 2 WHERE id = 'test-route'");
		run("INSERT INTO providers (id,name,api_key,endpoints) SELECT 'test-provider-2','Fallback',api_key,endpoints FROM providers WHERE id = 'test-provider'");
		run("INSERT INTO model_routes (id,model_id,provider_id,provider_model_name,upstream_protocol,upstream_operation,adapter,priority) VALUES ('test-route-2',?,'test-provider-2',?,'dashscope',?,'passthrough',1)",
			MODEL, inference ? 'paraformer-realtime-v2' : 'qwen3-asr-flash-realtime-2026-01-01', operation);
		run("INSERT INTO model_endpoints (id,model_id,provider_id,provider_slug,tag,endpoint_class,pricing,audio_capabilities,status,verified_at,expires_at,verified_by,evidence_url) SELECT 'test-endpoint-2',model_id,'test-provider-2','test-provider-2',tag,endpoint_class,pricing,audio_capabilities,status,verified_at,expires_at,verified_by,evidence_url FROM model_endpoints WHERE id = 'test-endpoint'");
		const routes = await storage.repositories.modelRouting.getModelRoutesByModelId(MODEL);
		for (const current of routes) {
			const currentProvider = await storage.repositories.providers.getProviderById(current.provider_id);
			assert.ok(currentProvider);
			const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(current, currentProvider);
			if (current.id === 'test-route') run("UPDATE model_endpoint_routes SET subject_fingerprint = ? WHERE route_target_id = 'test-route'", fingerprint);
			else run('INSERT INTO model_endpoint_routes (endpoint_id,route_target_id,subject_fingerprint) VALUES (?,?,?)', 'test-endpoint-2', current.id, fingerprint);
		}
		if (outcome === 'reject_then_unknown') {
			run("INSERT INTO providers (id,name,api_key,endpoints) SELECT 'test-provider-3','Must not dispatch',api_key,endpoints FROM providers WHERE id = 'test-provider'");
			run("INSERT INTO model_routes (id,model_id,provider_id,provider_model_name,upstream_protocol,upstream_operation,adapter,priority) SELECT 'test-route-3',model_id,'test-provider-3',provider_model_name,upstream_protocol,upstream_operation,adapter,0 FROM model_routes WHERE id = 'test-route'");
			run("INSERT INTO model_endpoints (id,model_id,provider_id,provider_slug,tag,endpoint_class,pricing,audio_capabilities,status,verified_at,expires_at,verified_by,evidence_url) SELECT 'test-endpoint-3',model_id,'test-provider-3','test-provider-3',tag,endpoint_class,pricing,audio_capabilities,status,verified_at,expires_at,verified_by,evidence_url FROM model_endpoints WHERE id = 'test-endpoint'");
			const third = (await storage.repositories.modelRouting.getModelRoutesByModelId(MODEL)).find(route => route.id === 'test-route-3');
			const thirdProvider = await storage.repositories.providers.getProviderById('test-provider-3');
			assert.ok(third && thirdProvider);
			run('INSERT INTO model_endpoint_routes (endpoint_id,route_target_id,subject_fingerprint) VALUES (?,?,?)',
				'test-endpoint-3', third.id, await computeRouteDataPolicySubjectFingerprintFromRows(third, thirdProvider));
		}
	}
	const gateway = await server(t);
	servers.push(gateway);
	const gatewayWs = createNodeWebSocketServer();
	const runtimeStorage = { ...storage, repositories: {
		...storage.repositories,
		byokKeys: createEncryptedByokKeysRepository(storage.repositories.byokKeys, SYNTHETIC_ENCRYPTION_SECRET),
		sharedKeys: createEncryptedSharedKeysRepository(storage.repositories.sharedKeys, SYNTHETIC_ENCRYPTION_SECRET),
	} };
	const app = createProxyApp(async () => runtimeStorage);
	const pending = new Set<Promise<void>>();
	const requestSignals: AbortSignal[] = [];
	gateway.http.on('upgrade', (request, socket, head) => {
		const task = handleNodeRealtimeUpgrade({ fetch: (request, env) => {
			requestSignals.push(request.signal);
			return app.fetch(request, env);
		} }, request, socket, head, gatewayWs);
		pending.add(task);
		void task.finally(() => pending.delete(task));
	});
	const rows = (sql: string) => db.sqlite.prepare(sql).all().map(row => ({ ...row }));
	function snapshot() {
		return {
			user: rows("SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id = 'test-user'")[0],
			ordinary: rows('SELECT state,reserved_micros,settled_micros FROM user_budget_reservations'),
			guardrail: rows('SELECT state,reserved_micros,settled_micros FROM guardrail_budget_reservations'),
			windows: rows('SELECT reserved_micros,settled_micros FROM guardrail_budget_windows'),
			logs: rows('SELECT status,charged_cost,budget_charged_micros,audio_duration_seconds FROM api_key_request_logs'),
		};
	}
	function openClient(path: string) {
		const client = new Ws(`${gateway.url}${path}?model=${MODEL}&operation=${operation}`, [buildDashScopeRealtimeAuthProtocol(KEY)]);
		t.after(() => client.terminate());
		const received: string[] = [];
		const errors: string[] = [];
		client.on('error', error => errors.push(String(error)));
		client.on('unexpected-response', (_request, response) => {
			response.on('data', (data: Buffer) => errors.push(data.toString()));
			response.on('end', () => client.terminate());
		});
		client.on('message', data => received.push(data.toString()));
		client.on('open', () => {
			client.send(JSON.stringify(inference
				? { header: { action: 'run-task', task_id: 'test-task' }, payload: { model: MODEL, parameters: { format: 'pcm', sample_rate: 16_000 } } }
				: { type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16_000 } }));
			if (outcome !== 'missing_usage') {
				if (inference) client.send(Buffer.alloc(32_000));
				else client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(32_000).toString('base64') }));
			}
			client.send(JSON.stringify(inference
				? { header: { action: 'finish-task', task_id: 'test-task' }, payload: {} }
				: { type: 'input_audio_buffer.commit' }));
		});
		const closed = new Promise<void>(resolve => client.on('close', () => resolve()));
		const settled = closed.then(async () => {
			await Promise.all(pending);
			await drainNodeBackgroundWork();
			return { received, errors };
		});
		return { client, closed, settled };
	}
	const connect = (path: string) => openClient(path).settled;
	async function enableByok(includeInLimit: boolean, allowPaidFallback = false) {
		run('INSERT INTO byok_keys (id,workspace_id,provider,api_key_encrypted,label,sort_order,always_use_for_matching_models) VALUES (?,?,?,?,?,0,1)',
			'test-byok', 'personal:test-user', 'test-provider',
			await encryptSharedKeySecret('synthetic-private-byok', SYNTHETIC_ENCRYPTION_SECRET, 'cinatoken:byok-key:test-byok:personal:test-user:test-provider'), 'synthetic-label');
		run('UPDATE api_keys SET include_byok_in_limit = ?', includeInLimit ? 1 : 0);
		if (allowPaidFallback) {
			run('UPDATE byok_keys SET always_use_for_matching_models = 0');
			rejectPrivateByok = true;
		} else run('UPDATE users SET budget_max = 0');
	}
	async function enableSharedKeys(rejectFirst: 0 | 401 | 429 | 503 = 0) {
		rejectSharedFirst = rejectFirst;
		run("INSERT INTO users (id,email) VALUES ('test-seller','seller@example.invalid')");
		run("UPDATE providers SET shared_channel_type = 'synthetic-audio' WHERE id = 'test-provider'");
		for (const id of [1, 2]) {
			run('INSERT INTO shared_keys (id,seller_user_id,channel_type,api_key,key_fingerprint,status,seller_priority,input_price,output_price) VALUES (?,?,?,?,?,?,?,?,?)',
				`test-shared-${id}`, 'test-seller', 'synthetic-audio',
				await encryptSharedKeySecret(`synthetic-shared-${id}`, SYNTHETIC_ENCRYPTION_SECRET, `cinatoken:shared-key:test-shared-${id}:fingerprint-${id}`),
				`fingerprint-${id}`, 'active', 3 - id, 1, 1);
		}
		const refreshed = (await storage.repositories.modelRouting.getModelRoutesByModelId(MODEL))[0]!;
		const refreshedProvider = await storage.repositories.providers.getProviderById('test-provider');
		assert.ok(refreshedProvider);
		run("UPDATE model_endpoint_routes SET subject_fingerprint = ? WHERE route_target_id = 'test-route'",
			await computeRouteDataPolicySubjectFingerprintFromRows(refreshed, refreshedProvider));
	}
	return { db, storage, app, snapshot, connect, openClient, requestSignals, enableByok, enableSharedKeys,
		byokDispatches, credentialKinds, dispatches: () => dispatches, dispatchSnapshots, observedFrames,
		holdUpstream: (promise: Promise<void>) => { holdUpstream = promise; }, activeUpgrades: () => pending.size };
}

it('shared public route does not renew the connection deadline after model preparation', async t => {
	const f = await fixture(t, OPERATIONS[0], 'actual');
	const startedAt = Date.now();
	t.mock.timers.enable({ apis: ['Date'], now: startedAt });
	let advanced = false;
	f.db.hooks.beforeStatement = sql => {
		if (!advanced && /from\s+"?models"?/i.test(sql)) {
			advanced = true;
			t.mock.timers.setTime(startedAt + 5_000);
		}
	};
	let receivedDeadline: number | undefined;
	await f.app.request(`/v1/dashscope/realtime?model=${MODEL}&operation=${OPERATIONS[0]}`, {
		headers: { Authorization: `Bearer ${KEY}`, Upgrade: 'websocket' },
	}, { NODE_REALTIME_DISPATCH: async (_route, _operation, _signal, _timing, _attempt, limits) => {
		receivedDeadline = limits?.connectDeadlineAtMs;
		return { response: new Response(null, { status: 503 }), usagePromise: Promise.resolve(EMPTY_USAGE), upstreamRequestId: null };
	} });
	await drainNodeBackgroundWork();
	assert.equal(advanced, true);
	assert.equal(receivedDeadline, startedAt + 30_000);
	assert.equal(f.dispatches(), 0);
});

for (const ledger of ['ordinary', 'key-limit'] as const) {
	it(`real public ${ledger} budget rejection cannot dispatch or retain capacity`, { timeout: 10_000 }, async t => {
		const f = await fixture(t, OPERATIONS[0], 'actual');
		f.db.sqlite.exec(ledger === 'ordinary' ? 'UPDATE users SET budget_max = 0.1' : 'UPDATE api_keys SET limit_micros = 100000');
		await f.connect('/v1/dashscope/realtime');
		assert.equal(f.dispatches(), 0);
		assert.deepEqual(f.snapshot().user, { budget_spent_micros: 0, budget_reserved_micros: 0 });
		assert.ok(f.snapshot().ordinary.every(row => row.state === 'released'));
		assert.deepEqual(f.snapshot().guardrail, []);
	});
}

for (const operation of OPERATIONS) {
	for (const included of [false, true]) {
		for (const outcome of ['actual', 'stream_error'] as const) {
			it(`paid BYOK fallback ${operation} included=${included} ${outcome} admits before sending`, { timeout: 10_000 }, async t => {
				const f = await fixture(t, operation, outcome);
				await f.enableByok(included, true);
				await f.connect('/v1/dashscope/realtime');
				assert.deepEqual(f.credentialKinds, ['byok', 'platform']);
				assert.deepEqual(f.dispatchSnapshots[0]?.ordinary, []);
				assert.equal(f.dispatchSnapshots[0]?.guardrail.length, included ? 1 : 0);
				assert.deepEqual(f.dispatchSnapshots[1]?.ordinary, [{ state: 'dispatched', reserved_micros: CEILING, settled_micros: 0 }]);
				assert.deepEqual(f.dispatchSnapshots[1]?.guardrail, [{ state: 'dispatched', reserved_micros: CEILING, settled_micros: 0 }]);
				const cost = outcome === 'actual' ? 1_000 : CEILING;
				assert.deepEqual(f.snapshot().user, { budget_spent_micros: cost, budget_reserved_micros: 0 });
				assert.deepEqual(f.snapshot().windows, [{ reserved_micros: 0, settled_micros: cost }]);
				assert.equal(f.snapshot().logs.length, 1);
				assert.equal(f.db.sqlite.prepare('SELECT provider_key_id FROM api_key_request_logs').get()?.provider_key_id, 'test-provider');
			});
		}
		it(`paid BYOK fallback ${operation} included=${included} rejects insufficient Ordinary funds`, { timeout: 10_000 }, async t => {
			const f = await fixture(t, operation, 'actual');
			await f.enableByok(included, true);
			f.db.sqlite.exec('UPDATE users SET budget_max = 0.1');
			await f.connect('/v1/dashscope/realtime');
			assert.deepEqual(f.credentialKinds, ['byok']);
			assert.deepEqual(f.snapshot().ordinary, []);
			assert.deepEqual(f.snapshot().user, { budget_spent_micros: 0, budget_reserved_micros: 0 });
			assert.ok(f.snapshot().windows.every(row => row.reserved_micros === 0 && row.settled_micros === 0));
		});
	}
	for (const included of [false, true]) {
		for (const enough of [false, true]) {
			it(`Workspace paid fallback ${operation} included=${included} enough=${enough} adds only paid scopes`, { timeout: 10_000 }, async t => {
				const f = await fixture(t, operation, 'actual');
				await f.enableByok(included, true);
				f.db.sqlite.prepare('INSERT INTO workspace_budgets (id,workspace_id,reset_interval,limit_micros) VALUES (?,?,?,?)')
					.run('test-workspace-budget', 'personal:test-user', 'lifetime', enough ? 2_000_000 : 100_000);
				await f.connect('/v1/dashscope/realtime');
				assert.deepEqual(f.credentialKinds, enough ? ['byok', 'platform'] : ['byok']);
				assert.deepEqual(f.dispatchSnapshots[0]?.ordinary, []);
				assert.equal(f.dispatchSnapshots[0]?.guardrail.length, included ? 1 : 0);
				assert.deepEqual(f.snapshot().user, { budget_spent_micros: enough ? 1_000 : 0, budget_reserved_micros: 0 });
				assert.equal(f.snapshot().guardrail.length, enough ? 2 : included ? 1 : 0);
				assert.ok(f.snapshot().windows.every(row => row.reserved_micros === 0 && row.settled_micros === (enough ? 1_000 : 0)));
				if (enough) {
					assert.equal(f.dispatchSnapshots[1]?.guardrail.length, 2);
					assert.ok(f.dispatchSnapshots[1]?.guardrail.every(row => row.state === 'dispatched' && row.reserved_micros === CEILING));
				}
			});
		}
	}
	for (const rejection of [0, 401, 429] as const) {
		it(`shared channel ${operation} rejection=${rejection} selects stored encrypted credentials`, { timeout: 10_000 }, async t => {
			const f = await fixture(t, operation, 'actual');
			await f.enableSharedKeys(rejection);
			await f.connect('/api/v1/dashscope/realtime');
			assert.deepEqual(f.credentialKinds, rejection ? ['shared-1', 'shared-2'] : ['shared-1']);
			assert.equal(f.snapshot().ordinary.length, 1);
			assert.equal(f.snapshot().guardrail.length, 1);
			assert.deepEqual(f.snapshot().user, { budget_spent_micros: 1_000, budget_reserved_micros: 0 });
			assert.deepEqual(f.snapshot().windows, [{ reserved_micros: 0, settled_micros: 1_000 }]);
			const keys = f.db.sqlite.prepare('SELECT status FROM shared_keys ORDER BY id').all();
			assert.equal(keys[0]?.status, rejection === 401 ? 'invalid' : 'active');
			assert.equal(keys[1]?.status, 'active');
			assert.equal(f.db.sqlite.prepare('SELECT provider_key_id FROM api_key_request_logs').get()?.provider_key_id,
				rejection ? 'sharedkey:test-shared-2' : 'sharedkey:test-shared-1');
			// Observe the separate seller ledger without asserting that missing
			// duration-priced earnings is an acceptable marketplace contract.
			t.diagnostic(`C04/C12/C17 seller-earnings rows: ${f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM shared_key_earnings').get()?.count}`);
		});
	}
	it(`shared channel ${operation} HTTP 503 cannot replay on another key`, { timeout: 10_000 }, async t => {
		const f = await fixture(t, operation, 'actual');
		await f.enableSharedKeys(503);
		await f.connect('/v1/dashscope/realtime');
		assert.deepEqual(f.credentialKinds, ['shared-1']);
		assert.equal(f.dispatches(), 1);
		assert.deepEqual(f.snapshot().user, { budget_spent_micros: CEILING, budget_reserved_micros: 0 });
		assert.equal(f.snapshot().ordinary[0]?.state, 'expired');
		assert.equal(f.snapshot().guardrail[0]?.state, 'expired');
	});
	it(`shared channel ${operation} unknown cannot replay on another key or platform`, { timeout: 10_000 }, async t => {
		const f = await fixture(t, operation, 'transport_unknown');
		await f.enableSharedKeys();
		await f.connect('/v1/dashscope/realtime');
		assert.deepEqual(f.credentialKinds, ['shared-1']);
		assert.deepEqual(f.snapshot().user, { budget_spent_micros: CEILING, budget_reserved_micros: 0 });
		assert.deepEqual(f.snapshot().windows, [{ reserved_micros: 0, settled_micros: CEILING }]);
	});
}

for (const operation of OPERATIONS) {
	for (const included of [false, true]) {
		for (const outcome of ['actual', 'stream_error'] as const) {
			it(`stored encrypted BYOK ${operation} included=${included} ${outcome} never consumes Ordinary`, { timeout: 10_000 }, async t => {
				const f = await fixture(t, operation, outcome);
				await f.enableByok(included);
				await f.connect('/api/v1/dashscope/realtime');
				assert.deepEqual(f.byokDispatches, [true]);
				const after = f.snapshot();
				assert.deepEqual(after.user, { budget_spent_micros: 0, budget_reserved_micros: 0 });
				assert.deepEqual(after.ordinary, []);
				assert.deepEqual(after.windows, included ? [{ reserved_micros: 0, settled_micros: outcome === 'actual' ? 1_000 : CEILING }] : []);
				assert.equal(after.logs.length, 1);
				assert.equal(after.logs[0]?.charged_cost, 0);
			});
		}
	}
}

for (const operation of OPERATIONS) {
	for (const outcome of ['reject_then_actual', 'reject_then_unknown'] as const) {
		it(`public Realtime ${operation} preserves early frames across ${outcome}`, { timeout: 5_000 }, async t => {
			const f = await fixture(t, operation, outcome);
			await f.connect('/api/v1/dashscope/realtime');
			assert.equal(f.dispatches(), 2);
			assert.equal(f.snapshot().ordinary.length, 1);
			assert.equal(f.snapshot().guardrail.length, 1);
			assert.deepEqual(f.snapshot().user, { budget_spent_micros: outcome === 'reject_then_actual' ? 1_000 : CEILING, budget_reserved_micros: 0 });
			if (outcome === 'reject_then_actual') {
				assert.equal(f.observedFrames.filter(frame => frame.includes('finish-task') || frame.includes('input_audio_buffer.commit')).length, 1);
				if (operation.endsWith('.inference')) {
					assert.ok(f.observedFrames[0]?.includes('paraformer-realtime-v2'));
					assert.ok(!f.observedFrames[0]?.includes(MODEL));
				}
			}
		});
	}
}

for (const operation of OPERATIONS) {
	for (const path of ['/v1/dashscope/realtime', '/api/v1/dashscope/realtime']) {
		for (const outcome of ['actual', 'explicit_zero', 'local_pcm', 'missing_usage', 'stream_error', 'transport_unknown', 'http_rejection', 'http_ambiguous'] as const) {
			it(`real ledger ${path} ${operation}: ${outcome}`, { timeout: 10_000 }, async t => {
				const f = await fixture(t, operation, outcome);
				const result = await f.connect(path);
				assert.equal(f.dispatches(), 1, JSON.stringify(result));
				const before = f.dispatchSnapshots[0];
				assert.deepEqual(before, {
					user: { budget_spent_micros: 0, budget_reserved_micros: CEILING },
					ordinary: [{ state: 'dispatched', reserved_micros: CEILING, settled_micros: 0 }],
					guardrail: [{ state: 'dispatched', reserved_micros: CEILING, settled_micros: 0 }],
					windows: [{ reserved_micros: CEILING, settled_micros: 0 }], logs: [],
				});
					const unknown = ['missing_usage', 'stream_error', 'transport_unknown', 'http_ambiguous'].includes(outcome);
				const cost = unknown ? CEILING : ['explicit_zero', 'http_rejection'].includes(outcome) ? 0 : 1_000;
				const after = f.snapshot();
				assert.deepEqual(after.user, { budget_spent_micros: cost, budget_reserved_micros: 0 });
				assert.deepEqual(after.windows, [{ reserved_micros: 0, settled_micros: cost }]);
				assert.equal(after.ordinary[0]?.settled_micros, cost);
				assert.equal(after.guardrail[0]?.settled_micros, cost);
				assert.equal(after.logs.length, 1);
				// Existing Core contract records actual charges here; conservative
				// unknown debits are authoritative in the reservation/usage audit.
				assert.equal(after.logs[0]?.budget_charged_micros, unknown ? 0 : cost);
				assert.equal(after.ordinary[0]?.state, unknown ? 'expired' : 'settled');
				assert.equal(after.guardrail[0]?.state, unknown ? 'expired' : 'settled');
			});
		}
	}
}

it('Guardrail admission failure retains an Ordinary lease whose first release fails', { timeout: 10_000 }, async t => {
	const f = await fixture(t, OPERATIONS[0], 'actual');
	let releaseAttempts = 0;
	f.db.hooks.beforeStatement = sql => {
		if (/INSERT INTO guardrail_budget_reservations/.test(sql)) throw new Error('synthetic admission failure');
		if (/UPDATE user_budget_reservations/.test(sql) && /state = 'released'/.test(sql) && ++releaseAttempts === 1) {
			throw new Error('synthetic transient release failure');
		}
	};
	await f.connect('/v1/dashscope/realtime');
	assert.equal(f.dispatches(), 0);
	assert.ok(releaseAttempts >= 2);
	assert.deepEqual(f.snapshot().user, { budget_spent_micros: 0, budget_reserved_micros: 0 });
	assert.equal(f.snapshot().ordinary[0]?.state, 'released');
});

const COMMIT_POINTS = ['ordinary-reserve', 'guardrail-reserve', 'guardrail-dispatch', 'ordinary-dispatch', 'settlement'] as const;
type CommitPoint = typeof COMMIT_POINTS[number];
function interceptCommit(f: Awaited<ReturnType<typeof fixture>>, point: CommitPoint, callback: () => void | Promise<void>) {
	let seen = false;
	const matches = (sql: string) => point === 'ordinary-reserve' ? /INSERT INTO user_budget_reservations/.test(sql)
		: point === 'guardrail-reserve' ? /INSERT INTO guardrail_budget_reservations/.test(sql)
			: point === 'settlement' ? /INSERT INTO api_key_request_logs/.test(sql)
				: sql.includes(point === 'ordinary-dispatch' ? 'UPDATE user_budget_reservations' : 'UPDATE guardrail_budget_reservations')
					&& /state = 'dispatched'/.test(sql);
	const invoke = (sql: readonly string[]) => {
		if (!seen && sql.some(matches)) { seen = true; return callback(); }
	};
	f.db.hooks.afterStatement = sql => invoke([sql]);
	f.db.hooks.afterBatch = invoke;
	return () => seen;
}

for (const operation of OPERATIONS) {
	for (const point of COMMIT_POINTS.filter(point => point !== 'settlement')) {
		for (const stop of ['cancel', 'deadline'] as const) {
			it(`durable admission ${operation} ${point} ${stop} owns committed writes without outbound`, { timeout: 10_000 }, async t => {
				const gate = deferred();
				t.after(gate.resolve);
				const f = await fixture(t, operation, 'actual');
				const startedAt = Date.now();
				if (stop === 'deadline') t.mock.timers.enable({ apis: ['Date'], now: startedAt });
				const seen = interceptCommit(f, point, () => gate.promise);
				const connection = f.openClient('/v1/dashscope/realtime');
				await until(seen);
				assert.equal(f.dispatches(), 0);
				assert.equal(f.activeUpgrades(), 1, 'the request must retain ownership until SQL acknowledges');
				if (stop === 'cancel') {
					connection.client.terminate();
					await connection.closed;
					await until(() => f.requestSignals[0]?.aborted === true);
				} else t.mock.timers.setTime(startedAt + 30_001);
				gate.resolve();
				await connection.settled;
				assert.equal(f.activeUpgrades(), 0);
				assert.equal(f.dispatches(), 0);
				assert.deepEqual(f.snapshot().user, { budget_spent_micros: 0, budget_reserved_micros: 0 });
				assert.ok(f.snapshot().windows.every(row => row.reserved_micros === 0 && row.settled_micros === 0));
				assert.ok(f.snapshot().ordinary.every(row => row.state === 'released' || row.state === 'settled'));
			});
		}
	}
	for (const point of COMMIT_POINTS) {
		it(`lost acknowledgement ${operation} ${point} does not duplicate dispatch or settlement`, { timeout: 10_000 }, async t => {
			const f = await fixture(t, operation, 'actual');
			const seen = interceptCommit(f, point, () => { throw new Error('synthetic acknowledgement lost after COMMIT'); });
			await f.connect('/v1/dashscope/realtime');
			assert.equal(seen(), true);
			assert.equal(f.snapshot().ordinary.length, 1);
			assert.equal(f.snapshot().guardrail.length, 1);
			// A failed dispatch marker is fail-closed, not an excuse to replay.
			if (point.endsWith('dispatch')) {
				assert.equal(f.dispatches(), 0);
				assert.equal(f.snapshot().logs.length, 0);
				assert.equal(f.snapshot().ordinary[0]?.state, point === 'ordinary-dispatch' ? 'dispatched' : 'released');
				assert.equal(f.snapshot().guardrail[0]?.state, point === 'ordinary-dispatch' ? 'expired' : 'dispatched');
			}
			else {
				assert.equal(f.dispatches(), 1);
				assert.equal(f.snapshot().logs.length, 1);
				assert.deepEqual(f.snapshot().user, { budget_spent_micros: 1_000, budget_reserved_micros: 0 });
				assert.deepEqual(f.snapshot().windows, [{ reserved_micros: 0, settled_micros: 1_000 }]);
			}
			await f.storage.repositories.userBudgets.expireBefore('2099-01-01T00:00:00Z', 50);
			await f.storage.repositories.guardrailBudgets.expireBefore('2099-01-01T00:00:00Z', 50);
			assert.equal(f.snapshot().user?.budget_reserved_micros, 0);
			assert.ok(f.snapshot().windows.every(row => row.reserved_micros === 0));
			if (point.endsWith('dispatch')) {
				// Existing conservative recovery treats a durable marker as unknown;
				// this is NOT a confirmed provider charge (no outbound occurred).
				assert.equal(f.snapshot().user?.budget_spent_micros, point === 'ordinary-dispatch' ? CEILING : 0);
				assert.equal(f.snapshot().windows[0]?.settled_micros, CEILING);
			}
		});
	}
	it(`concurrent public Realtime ${operation} cannot oversubscribe the shared user ceiling`, { timeout: 10_000 }, async t => {
		const gate = deferred();
		t.after(gate.resolve);
		const f = await fixture(t, operation, 'actual');
		f.db.sqlite.exec('UPDATE users SET budget_max = 1');
		f.holdUpstream(gate.promise);
		const first = f.openClient('/v1/dashscope/realtime');
		await until(() => f.observedFrames.some(frame => frame.includes('finish-task') || frame.includes('input_audio_buffer.commit')));
		const second = f.openClient('/api/v1/dashscope/realtime');
		await second.closed;
		assert.equal(f.dispatches(), 1);
		assert.equal(f.snapshot().user?.budget_reserved_micros, CEILING);
		gate.resolve();
		await Promise.all([first.settled, second.settled]);
		assert.equal(f.dispatches(), 1);
		assert.deepEqual(f.snapshot().user, { budget_spent_micros: 1_000, budget_reserved_micros: 0 });
		assert.deepEqual(f.snapshot().windows, [{ reserved_micros: 0, settled_micros: 1_000 }]);
	});
}

it('failed Guardrail cleanup cannot skip the independent Ordinary release', { timeout: 10_000 }, async t => {
	const f = await fixture(t, OPERATIONS[0], 'actual');
	let releaseAttempts = 0;
	f.db.hooks.beforeStatement = sql => {
		if (/UPDATE guardrail_budget_reservations/.test(sql) && /state = '(dispatched|released)'/.test(sql)) {
			throw new Error('synthetic Guardrail write outage');
		}
		if (/UPDATE user_budget_reservations/.test(sql) && /state = 'released'/.test(sql) && ++releaseAttempts === 1) {
			throw new Error('synthetic transient Ordinary write outage');
		}
	};
	await f.connect('/v1/dashscope/realtime');
	assert.equal(f.dispatches(), 0);
	assert.ok(releaseAttempts >= 2);
	assert.deepEqual(f.snapshot().user, { budget_spent_micros: 0, budget_reserved_micros: 0 });
	assert.equal(f.snapshot().guardrail[0]?.state, 'reserved');
	// Persistent write failures retain the durable ceiling; recovery, not a
	// false in-memory success, must release it when persistence becomes usable.
	f.db.hooks.beforeStatement = undefined;
	await f.storage.repositories.guardrailBudgets.expireBefore('2099-01-01T00:00:00Z', 50);
	assert.equal(f.snapshot().guardrail[0]?.state, 'released');
	assert.deepEqual(f.snapshot().windows, [{ reserved_micros: 0, settled_micros: 0 }]);
});

for (const failedCleanup of ['none', 'ordinary', 'guardrail'] as const) {
	it(`settlement batch rollback and ${failedCleanup} cleanup outage preserve both ledgers`, { timeout: 10_000 }, async t => {
		const f = await fixture(t, OPERATIONS[0], 'actual');
		let settlementFailures = 0;
		f.db.hooks.beforeStatement = sql => {
			if (/UPDATE user_budget_reservations/.test(sql) && /SET state = \?/.test(sql)) {
				settlementFailures++;
				throw new Error('synthetic critical transaction failure after log insert');
			}
			if (failedCleanup !== 'none' && /SET state = 'expired'/.test(sql)
				&& sql.includes(failedCleanup === 'ordinary' ? 'user_budget_reservations' : 'guardrail_budget_reservations')) {
				throw new Error('synthetic cleanup write outage');
			}
		};
		await f.connect('/api/v1/dashscope/realtime');
		assert.equal(f.dispatches(), 1);
		assert.equal(settlementFailures, 1);
		const after = f.snapshot();
		assert.deepEqual(after.logs, [], 'failed transaction must roll back its request log');
		assert.deepEqual(after.user, {
			budget_spent_micros: failedCleanup === 'ordinary' ? 0 : CEILING,
			budget_reserved_micros: failedCleanup === 'ordinary' ? CEILING : 0,
		});
		assert.deepEqual(after.windows, [{
			settled_micros: failedCleanup === 'guardrail' ? 0 : CEILING,
			reserved_micros: failedCleanup === 'guardrail' ? CEILING : 0,
		}]);
		f.db.hooks.beforeStatement = undefined;
		await f.storage.repositories.userBudgets.expireBefore('2099-01-01T00:00:00Z', 50);
		await f.storage.repositories.guardrailBudgets.expireBefore('2099-01-01T00:00:00Z', 50);
		assert.deepEqual(f.snapshot().user, { budget_spent_micros: CEILING, budget_reserved_micros: 0 });
		assert.deepEqual(f.snapshot().windows, [{ settled_micros: CEILING, reserved_micros: 0 }]);
	});
}
