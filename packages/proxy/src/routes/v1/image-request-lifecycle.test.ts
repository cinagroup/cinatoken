import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { before, beforeEach, it, mock, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Hono } from 'hono';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
	clearGcpServiceAccountTokenCache, computeRouteDataPolicySubjectFingerprintFromRows,
	createD1StorageContext, createEncryptedProvidersRepository, GCP_OAUTH_TOKEN_URL,
	type EffectiveGuardrailRow, type ModelRow, type ModelRouteRow, type ProviderRow, type ResolvedGatewayKeyRow,
} from '@octafuse/core';
import { createProxyApp, type Env } from '../../app';
import { isImageInferenceRequest, textRequestLifecycle } from '../../middleware/text-request-lifecycle';
import { drainNodeBackgroundWork } from '../../runtime/schedule-background-work';
import { markProviderFailure, resetProviderCircuitStateForTests } from '../../services/provider-circuit-breaker';
import { resetUserModelCircuitStateForTests } from '../../services/user-model-circuit-breaker';
import { TEXT_REQUEST_DEADLINE_MS } from '../../services/request-deadline';
import { MAX_REQUEST_BODY_BYTES } from '../../services/bounded-request-body';
import { MULTIPART_MAX_FIELD_BYTES, MULTIPART_MAX_FIELDS_BYTES, MULTIPART_MAX_HEADER_BYTES, MULTIPART_MAX_PARTS } from '../../services/multipart-body-inspector';
import { IMAGE_MAX_BYTES_PER_FILE, IMAGE_MAX_REFERENCE_COUNT, IMAGE_MAX_RESPONSE_BYTES } from '../../services/egress/openai-images-driver';
import { MultipartFile, MULTIPART_FILE_PAGE_BYTES } from '../../services/streaming-multipart-body';
import { IMAGE_JSON_MAX_PROPERTY_NAME_CHARS, IMAGE_JSON_STRUCTURE_LIMITS } from '../../services/json-structure-budget';
import { IMAGE_MAX_USAGE_JSON_BYTES } from '../../services/egress/image-response-usage';
import { JSON_OUTPUT_PAGE_BYTES } from '../../services/egress/stream-json-body';
import { JSON_PARSE_STRING_PIECE_CHARS } from '../../services/egress/segmented-json-response';
import { JsonStringPages } from '../../services/egress/json-string-pages';
import { IMAGE_CONTROL_MAX_CHARS, IMAGE_PROVIDER_MAX_JSON_BYTES } from '../../services/image-control-limits';
import type { ImageUsageRecoveryFactory, TrustedImagePreparedAttemptContext } from '../../services/image-usage-recovery';
import type { RouteResult } from '../../services/model-router';
import type { SingleGrantBudgetTicket } from '../../services/request-budget-admission';
import { PostgresDispatchClaimUncertainError } from '../../../../core/src/storage/recovery/dispatch-intent-postgres';
import { imageRoutes } from './images';

const NOW = '2026-09-06T00:00:00.000Z';
type Operation = 'generations' | 'edits';
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
function input(operation: Operation, patch: Record<string, unknown> = {}): BodyInit {
	const values = { model: 'image-model', prompt: 'synthetic drawing', ...patch };
	if (operation === 'generations') return JSON.stringify(values);
	// Inbound wire bytes, not Undici's lazy outbound FormData serializer. Node
	// 24 can enqueue after cancel when that serializer is stopped before auth.
	const fields = Object.entries(values).map(([name, value]) =>
		`------cinatoken-synthetic-boundary-2026\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${typeof value === 'string' ? value : JSON.stringify(value)}\r\n`).join('');
	return fields + '------cinatoken-synthetic-boundary-2026\r\nContent-Disposition: form-data; name="image"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\nsynthetic bytes\r\n------cinatoken-synthetic-boundary-2026--\r\n';
}
function responseBody() { return { data: [{ b64_json: 'AQID' }] }; }
function request(path: string, body: BodyInit, signal?: AbortSignal, declaredLength?: number) {
	const init = { method: 'POST', signal, body, duplex: 'half', headers: {
		Authorization: 'Bearer synthetic-client-key', ...(body instanceof FormData ? {} : { 'Content-Type': path.endsWith('/edits') ? 'multipart/form-data; boundary=----cinatoken-synthetic-boundary-2026' : 'application/json' }),
		...(declaredLength === undefined ? {} : { 'Content-Length': String(declaredLength) }),
	} };
	return new Request('https://gateway.example.invalid' + path, init);
}
function send(app: ReturnType<typeof createProxyApp>, req: Request) {
	return app.fetch(req, { REQUEST_BODY_LOGGING: 'off' });
}
/** Independently parse actual outbound wire bytes with the native parser, only in tests. */
async function outgoingForm(init?: RequestInit): Promise<FormData> {
	assert.ok(init?.body instanceof ReadableStream);
	let bytes = 0;
	const counted = init.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) {
		assert.ok(chunk.length <= MULTIPART_FILE_PAGE_BYTES); bytes += chunk.length; c.enqueue(chunk);
	} }));
	const form = await new Response(counted, { headers: init.headers }).formData();
	assert.equal(bytes, Number(new Headers(init.headers).get('Content-Length')));
	return form;
}
function trackUploads(t: TestContext) {
	const files: MultipartFile[] = [], append = MultipartFile.prototype.append;
	t.mock.method(MultipartFile.prototype, 'append', function(this: MultipartFile, bytes: Uint8Array) {
		if (!files.includes(this)) files.push(this); append.call(this, bytes);
	});
	return files;
}
async function assertStop(response: Response, status: 499 | 504 | 413) {
	const body = await response.text();
	assert.equal(response.status, status, body);
	const code = status === 499 ? 'gateway.request_cancelled' : status === 504 ? 'gateway.request_deadline_exceeded' : 'gateway.payload_too_large';
	assert.equal(response.headers.get('X-OctaFuse-Error-Code'), code);
	assert.doesNotMatch(body, /PRIVATE_DETAIL|PRIVATE KEY|@example/);
}

/** Real Hono/auth/planner/driver; synthetic rows and a narrowly checked SQL sink, NOT a financial DB. */
async function fixture(t: TestContext, operation: Operation, credential = 'synthetic-provider-key', features: { shared?: boolean; sticky?: boolean; recoveryFactory?: ImageUsageRecoveryFactory } = {}) {
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
		id: 'image-key', key: 'synthetic-client-key', user_id: 'image-user', workspace_id: 'image-workspace', name: 'Synthetic',
		status: 'active', metadata: null, last_used_at: null, created_at: NOW, updated_at: NOW, user_email: null, user_metadata: null,
		user_charged_cost_factors: null, budget_max: null, budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
		budget_epoch: 0, budget_reserved_micros: 0, include_byok_in_limit: false, limit_micros: null, limit_epoch: 0, limit_reset: null, expires_at: null,
	};
	const model: ModelRow = { id: 'image-model', display_name: 'Synthetic', vendor: 'test', context_window: 8192, max_tokens: 1024,
		pricing_profile: null, tags: '[]', description: null, metadata: null, input_modalities: '["text","image"]', output_modalities: '["image"]',
		released_at: null, route_policy: '{"strategy":"weight_priority"}', created_at: NOW };
	const routes: ModelRouteRow[] = [0, 1].map(i => ({ id: 'target-' + i, model_id: model.id, provider_id: 'provider-' + i,
		provider_model_name: 'private-model', priority: i, status: 'active', route_group: 'default', weight: 1, price_override: null, custom_params: null,
		upstream_protocol: 'openai', upstream_operation: `images.${operation}`, adapter: 'passthrough', routing_metadata: null }));
	const providers: ProviderRow[] = routes.map(route => ({ id: route.provider_id, name: route.provider_id, api_key: credential,
		shared_channel_type: features.shared ? 'openai' : null,
		endpoints: '{"openai":{"base":"https://upstream.example.invalid/v1"}}', status: 'active', description: null, created_at: NOW }));
	const endpoints = await Promise.all(routes.map(async (route, index) => ({ id: 'endpoint-' + index, model_id: model.id, provider_id: route.provider_id,
		provider_slug: 'test', tag: 'test', endpoint_class: null, region: null, context_length: 8192, max_prompt_tokens: null, max_completion_tokens: 1024,
		quantization: null, supported_parameters: '[]', pricing: '{"currency":"USD","prompt":"0","completion":"0"}',
		supports_implicit_caching: false, supports_voice_cloning: false, audio_capabilities: '{}', image_capabilities: JSON.stringify({
			provider_slug: 'test', provider_tag: null, supports_streaming: true,
			supported_parameters: { n: { type: 'range', min: 1, max: 10 } }, allowed_passthrough_parameters: [],
			pricing: [{ billable: 'output_image', unit: 'image', cost_usd: '0' }],
		}),
		supports_tool_choice: '{"auto":false,"function":false,"none":false,"required":false}', evidence_url: 'https://upstream.example.invalid/evidence',
		verified_by: 'test', verified_at: NOW, expires_at: '2099-01-01T00:00:00.000Z', status: 'verified' as const, created_at: NOW, updated_at: NOW,
		route_target_id: route.id, subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(route, providers[index]!) })));
	repos.apiKeys.getApiKeyWithUserByKey = async () => { await touch('auth'); return key; };
	repos.apiKeys.getApiKeyByIdInWorkspace = async () => { await touch('key-limit'); return key; };
	repos.guardrails.getEffectiveForRequest = async () => { await touch('guardrail'); return []; };
	repos.userAuditLogs.insertUserAuditLog = async () => { await touch('audit-write'); };
	repos.modelRouting.getModelById = async () => { await touch('model'); return model; };
	repos.modelRouting.resolveModelSurface = async () => {
		await touch('surface'); return features.sticky ? {
			id: 'surface', model_id: model.id, route_group: 'default', request_protocol: 'openai', request_operation: `images.${operation}`,
			route_pool_id: 'pool', status: 'active', pool_name: 'Synthetic', pool_strategy: 'weight_priority', pool_tier_strategies: null,
			pool_status: 'active', pool_sticky_enabled: true, pool_sticky_idle_ttl_seconds: 3600, pool_sticky_epoch: 1,
		} : null;
	};
	repos.modelRouting.getModelRoutesByModelId = async () => { await touch('routes'); return routes; };
	repos.modelRouting.getModelRoutesByPoolId = async () => { await touch('routes'); return routes; };
	repos.providers.getProvidersByIds = async () => { await touch('provider'); return providers; };
	repos.modelEndpoints.listRuntimeBindingsByRouteTargetIds = async () => { await touch('endpoint'); return endpoints; };
	repos.routeDataPolicies.getByRouteTargetIds = async () => { await touch('policy'); return []; };
	repos.systemConfig.getConfig = async () => { await touch('pricing-config'); return null; };
	repos.byokKeys.listActiveForRequest = async () => { await touch('byok-pool'); return []; };
	repos.byokKeys.shouldSuppressSharedCapacityForRequest = async () => { await touch('byok-suppress'); return false; };
	repos.sharedKeys.listActiveSharedKeysByChannel = async () => { await touch('shared-pool'); return []; };
	repos.routePoolSticky.getBinding = async () => { await touch('sticky-lookup'); return null; };
	repos.routePoolSticky.deleteStaleBefore = async () => { await touch('sticky-gc'); return 0; };
	repos.routePoolSticky.tryBind = async () => true;
	repos.requestLogs.getRecentRoutePerformanceSamples = async () => [];
	repos.requestLogs.getRouteAvailabilityAggregates = async () => [];
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external fetch'); });
	t.mock.method(console, 'error', (...args: unknown[]) => {
		const first = args[0];
		if (typeof first === 'string' && first.startsWith('{')) {
			const event: unknown = JSON.parse(first);
			if (event && typeof event === 'object' && 'event' in event && event.event === 'gateway.images.upstream_error'
				&& 'abortReason' in event && event.abortReason !== 'none') return;
		}
		errors.push(args);
	});
	t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
	t.after(async () => { await drainNodeBackgroundWork(); assert.deepEqual(errors, [], 'no swallowed settlement/ingress errors'); });
	const app = features.recoveryFactory ? new Hono<Env>() : createProxyApp(async () => storage);
	if (features.recoveryFactory) {
		const recoveryFactory = features.recoveryFactory;
		app.use('*', textRequestLifecycle);
		app.use('*', async (c, next) => {
			c.set('repositories', repos);
			c.set('imageUsageRecovery', recoveryFactory);
			c.set('requestBodyLoggingMode', 'off');
			await next();
		});
		app.route('/v1/images', imageRoutes);
		app.onError(() => new Response('Test app unhandled error', { status: 500 }));
	}
	return { app, storage, repos, key, model, calls, hooks, batches: () => batches };
}

before(async () => {
	// Let Node 22 print its one-time MockTimers warning before fixtures capture console.error.
	void mock.timers;
	await nextTurn();
});
beforeEach(() => { clearGcpServiceAccountTokenCache(); resetProviderCircuitStateForTests(); resetUserModelCircuitStateForTests(); });

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations']) {
	it(`${prefix}${suffix}: property-name cap rejects before model, Guardrail, or upstream work`, async t => {
		const f = await fixture(t, 'generations'); let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const raw = '{"model":"image-model","prompt":"test","discard":{"' + 'PRIVATE_PROPERTY'.repeat(20) + '":0},"discard":{}}';
		const result = await send(f.app, request(prefix + suffix, raw)); await assertStop(result, 413);
		assert.equal(sends, 0); assert.equal(f.calls.includes('model'), false); assert.equal(f.calls.includes('guardrail'), false);
		assert.equal(f.batches(), 0);
	});
	it(`${prefix}${suffix}: exact property-name boundary remains valid`, async t => {
		const f = await fixture(t, 'generations'); let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(prefix + suffix, input('generations', { ['A'.repeat(IMAGE_JSON_MAX_PROPERTY_NAME_CHARS)]: 0 })));
		assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});
}

for (const operation of ['generations', 'edits', 'stream'] as const) for (const overflow of ['key', 'usage'] as const) {
	it(`Images ${operation}: ${overflow} capacity rejection never reaches the second configured provider`, async t => {
		const f = await fixture(t, operation === 'edits' ? 'edits' : 'generations'); let sends = 0;
		const previousError = console.error;
		t.mock.method(console, 'error', (...args: unknown[]) => {
			if (typeof args[0] === 'string' && /"errorName":"(?:ImageUsageLimitError|JsonStructureLimitError)"/.test(args[0])) return;
			previousError(...args);
		});
		const usage = { input_tokens: 3, output_tokens: 7, ...(overflow === 'usage' ? { opaque: 'PRIVATE_USAGE'.repeat(IMAGE_MAX_USAGE_JSON_BYTES / 4) } : {}) };
		const extras = { usage, ...(overflow === 'key' ? { ['PRIVATE_PROPERTY'.repeat(20)]: 0 } : {}) };
		t.mock.method(globalThis, 'fetch', async () => {
			sends++;
			if (sends > 1) throw new Error('Must not replay an accepted image request');
			return operation === 'stream'
				? new Response('data: ' + JSON.stringify({ type: 'image_generation.completed', b64_json: 'PRIVATE_IMAGE', ...extras }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
				: Response.json({ data: [{ b64_json: 'PRIVATE_IMAGE' }], ...extras });
		});
		const result = await send(f.app, request('/api/v1/images/' + (operation === 'edits' ? 'edits' : 'generations'),
			input(operation === 'edits' ? 'edits' : 'generations', operation === 'stream' ? { stream: true } : {})));
		const text = await result.text(); assert.equal(result.status, operation === 'stream' ? 200 : 502, text);
		if (operation === 'stream') { assert.match(text, /"type":"error"/); assert.match(text, /\[DONE\]/); }
		assert.doesNotMatch(text, /PRIVATE_IMAGE|PRIVATE_PROPERTY|PRIVATE_USAGE/);
		await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});
}

const RESOURCE_BOUNDARY = '----cinatoken-synthetic-boundary-2026';
const encode = (value: string) => new TextEncoder().encode(value);

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations']) {
	for (const direction of ['request', 'response'] as const) for (const valid of [true, false]) {
		it(`${prefix}${suffix}: full-capacity numeric ${direction}, valid=${valid}, preserves value and replay boundary`, async t => {
			const f = await fixture(t, 'generations'); let phase = 0, bytes = 0, sends = 0;
			const maximum = direction === 'request' ? MAX_REQUEST_BODY_BYTES : IMAGE_MAX_RESPONSE_BYTES;
			const head = encode(direction === 'request' ? '{"model":"image-model","prompt":"synthetic","n":1'
				: '{"data":[{"b64_json":"AQID"}],"usage":{"input_tokens":3,"output_tokens":7');
			const end = (valid ? '' : ',') + (direction === 'request' ? '}' : '}}');
			let remaining = maximum - head.length, tail = encode(end);
			for (let i = 0; i < 4; i++) { tail = encode('e-' + remaining + end); remaining = maximum - head.length - tail.length; }
			tail = encode('e-' + remaining + end);
			const page = new Uint8Array(65536).fill(48);
			const source = new ReadableStream<Uint8Array>({ pull(c) {
				let chunk: Uint8Array, last = false;
				if (phase++ === 0) chunk = head;
				else if (remaining) { const size = Math.min(page.length, remaining); remaining -= size; chunk = page.subarray(0, size); }
				else { chunk = tail; last = true; }
				bytes += chunk.length; c.enqueue(chunk); if (last) c.close();
			} }, { highWaterMark: 0 });
			const parse = JSON.parse;
			t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
				assert.ok(args[0].length < 8192, 'no whole numeric JSON reaches native parsing'); return parse(...args);
			});
			t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
				sends++; assert.ok(init?.body instanceof ReadableStream);
				const outbound = await new Response(init.body).json() as { n: number }; assert.equal(outbound.n, 1);
				return direction === 'response' ? new Response(source) : Response.json(responseBody());
			});
			const response = await send(f.app, request(prefix + suffix, direction === 'request' ? source : input('generations')));
			const text = await response.text(); assert.equal(response.status, valid ? 200 : direction === 'request' ? 400 : 502, text);
			if (valid && direction === 'response') assert.equal(JSON.parse(text).usage.completion_tokens, 7);
			assert.equal(bytes, maximum); assert.equal(source.locked, false); await drainNodeBackgroundWork();
			assert.equal(sends, direction === 'request' && !valid ? 0 : 1); assert.equal(f.batches(), sends);
			assert.equal(f.calls.includes('guardrail'), sends === 1);
		});
	}
}

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations']) {
	for (const [field, limit] of [...Object.entries(IMAGE_CONTROL_MAX_CHARS), ['provider', IMAGE_PROVIDER_MAX_JSON_BYTES] as const]) {
		it(`${prefix}${suffix}: oversized ${field} has a safe 400 before policy, budget or dispatch`, async t => {
			const f = await fixture(t, 'generations');
			t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must reject before materializing'); });
			const value = 'PRIVATE_DETAIL' + 'A'.repeat(limit);
			const response = await send(f.app, request(prefix + suffix, input('generations', { [field]: field === 'provider' ? { unknown: [value] } : value })));
			const text = await response.text(); assert.equal(response.status, 400, text);
			assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.invalid_request');
			assert.equal(response.headers.get('Cache-Control'), 'no-store');
			assert.match(text, new RegExp(`${field} must be at most ${limit} ${field === 'provider' ? 'JSON bytes' : 'characters'}`));
			assert.doesNotMatch(text, /PRIVATE_DETAIL|Must reject|synthetic-client-key/);
			for (const phase of ['guardrail', 'audit-write', 'model', 'key-limit', 'workspace-budget']) assert.equal(f.calls.includes(phase), false);
			await drainNodeBackgroundWork(); assert.equal(f.batches(), 0);
		});
	}
	for (const [field, message] of [['model', 'Missing model'], ['n', 'n must be an integer between 1 and 10'], ['size', 'size must be a string']] as const) {
		it(`${prefix}${suffix}: wrong-type ${field} is still rejected without joining nested strings`, async t => {
			const f = await fixture(t, 'generations');
			t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must not join wrong types'); });
			const response = await send(f.app, request(prefix + suffix, input('generations', { [field]: { nested: ['A'.repeat(20000)] } })));
			const text = await response.text(); assert.equal(response.status, 400, text); assert.ok(text.includes(message), text);
			assert.equal(f.calls.includes('guardrail'), false); assert.equal(f.batches(), 0);
		});
	}
	it(`${prefix}${suffix}: admitted boundary values retain normalization and complete retry`, async t => {
		const f = await fixture(t, 'generations'); let sends = 0;
		const patch = { model: 'image-model'.padEnd(256), n: '1'.padStart(32), size: 'A'.repeat(64), quality: 'B'.repeat(64), background: 'C'.repeat(64), provider: { order: ['test'] } };
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.ok(init?.body instanceof ReadableStream); const raw = await new Response(init.body).text();
			assert.equal(Buffer.byteLength(raw), Number(new Headers(init.headers).get('Content-Length')));
			const body = JSON.parse(raw); assert.equal(body.model, 'private-model'); assert.equal(body.n, 1);
			assert.equal(body.size, patch.size); assert.equal(body.quality, patch.quality); assert.equal(body.background, patch.background);
			assert.equal(Object.hasOwn(body, 'provider'), false);
			return sends === 1 ? Response.json({ error: { message: 'synthetic rejection' } }, { status: 401 }) : Response.json(responseBody());
		});
		const response = await send(f.app, request(prefix + suffix, input('generations', patch)));
		assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork(); assert.equal(sends, 2); assert.equal(f.batches(), 1);
	});
}

for (const shape of ['size', 'provider', 'wrong-size', 'duplicate-size', 'duplicate-provider'] as const) {
	it(`generations: full 50 MiB ${shape} respects control admission without a whole value join`, async t => {
		const f = await fixture(t, 'generations'); let phase = 0, bytes = 0, sends = 0;
		const provider = shape.includes('provider'), nested = provider || shape === 'wrong-size', duplicate = shape.startsWith('duplicate');
		const head = encode('{"model":"image-model","prompt":"synthetic","' + (provider ? 'provider' : 'size') + '":' + (nested ? '{"nested":"' : '"'));
		const tail = encode('Ā"' + (nested ? '}' : '') + (duplicate ? provider ? ',"provider":{}' : ',"size":"1024x1024"' : '') + '}');
		let remaining = MAX_REQUEST_BODY_BYTES - head.length - tail.length;
		const page = new Uint8Array(65536).fill(65);
		const source = new ReadableStream<Uint8Array>({ pull(c) {
			let chunk: Uint8Array, last = false;
			if (phase++ === 0) chunk = head;
			else if (remaining) { const count = Math.min(remaining, page.length); remaining -= count; chunk = page.subarray(0, count); }
			else { chunk = tail; last = true; }
			bytes += chunk.length; c.enqueue(chunk); if (last) c.close();
		} }, { highWaterMark: 0 });
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must not join full control input'); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.ok(init?.body instanceof ReadableStream); const body = await new Response(init.body).json() as Record<string, unknown>;
			assert.equal(body.size, provider ? undefined : '1024x1024'); return Response.json(responseBody());
		});
		const response = await send(f.app, request('/v1/images', source)), text = await response.text();
		assert.equal(response.status, duplicate ? 200 : 400, text); assert.equal(bytes, MAX_REQUEST_BODY_BYTES); assert.equal(source.locked, false);
		await drainNodeBackgroundWork(); assert.equal(sends, duplicate ? 1 : 0); assert.equal(f.batches(), sends); assert.equal(f.calls.includes('guardrail'), duplicate);
	});
}

for (const ending of ['valid', 'malformed', 'oversized', 'cancel', 'deadline'] as const) {
	it(`generations: ${ending} withheld control tail is never admitted prematurely`, async t => {
		const f = await fixture(t, 'generations'), client = new AbortController(); let incoming!: ReadableStreamDefaultController<Uint8Array>, reading = false, settled = false, sends = 0;
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		const source = new ReadableStream<Uint8Array>({ start(c) { incoming = c; }, pull() { reading = true; }, cancel() { return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must not join discarded or rejected values'); });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const pending = Promise.resolve(send(f.app, request('/api/v1/images/generations', source, client.signal))).then(value => { settled = true; return value; });
		await until(() => reading); incoming.enqueue(encode('{"model":"image-model","prompt":"synthetic","size":"' + 'A'.repeat(20000) + '"'));
		await nextTurn(); assert.equal(settled, false); assert.equal(f.calls.includes('guardrail'), false);
		if (ending === 'cancel') client.abort();
		else if (ending === 'deadline') t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		else { incoming.enqueue(encode(ending === 'valid' ? ',"size":"1024x1024"}' : ending === 'oversized' ? '}' : ',}')); incoming.close(); }
		const response = await pending, text = await response.text();
		assert.equal(response.status, ending === 'valid' ? 200 : ending === 'cancel' ? 499 : ending === 'deadline' ? 504 : 400, text);
		if (ending === 'malformed') assert.match(text, /Invalid JSON body/);
		if (ending === 'oversized') assert.match(text, /size must be at most 64 characters/);
		assert.equal(source.locked, false); await drainNodeBackgroundWork(); assert.equal(sends, ending === 'valid' ? 1 : 0); assert.equal(f.batches(), sends);
	});
}

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations']) {
	for (const scenario of ['padded-limit', 'overflow', 'empty', 'wrong-type', 'stream-type', 'session-presence', 'guardrail-block'] as const) {
		it(`${prefix}${suffix}: paged control ${scenario} preserves the public validation boundary`, async t => {
			const f = await fixture(t, 'generations'); let sends = 0;
			const prompt = scenario === 'wrong-type' ? { text: 'A'.repeat(20000) }
				: scenario === 'empty' ? ' '.repeat(20000)
					: ' '.repeat(20000) + (scenario === 'overflow' ? 'A'.repeat(4001) : scenario === 'guardrail-block' ? 'secret' : 'A'.repeat(4000)) + '\ufeff';
			const patch = { prompt, ...(scenario === 'stream-type' ? { stream: 'A'.repeat(20000) } : {}),
				...(scenario === 'session-presence' ? { session_id: { text: 'A'.repeat(20000) } } : {}) };
			if (scenario === 'guardrail-block') f.repos.guardrails.getEffectiveForRequest = async () => {
				f.calls.push('guardrail');
				return [{ ...policy(), version_config_json: '{"input_filters":[{"id":"secret","pattern":"^secret$","action":"block"}]}' }];
			};
			const materialize = JsonStringPages.prototype.materialize;
			t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) { assert.ok(this.length <= 4000); return materialize.call(this); });
			t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
				sends++; assert.ok(init?.body instanceof ReadableStream);
				assert.equal((await new Response(init.body).json() as { prompt: string }).prompt, 'A'.repeat(4000));
				return Response.json(responseBody());
			});
			const response = await send(f.app, request(prefix + suffix, input('generations', patch))), text = await response.text();
			assert.equal(response.status, scenario === 'padded-limit' ? 200 : scenario === 'guardrail-block' ? 403 : 400, text);
			if (scenario === 'overflow') assert.match(text, /prompt must be at most 4000 characters/);
			if (scenario === 'empty' || scenario === 'wrong-type') assert.match(text, /prompt is required/);
			if (scenario === 'stream-type') assert.match(text, /stream must be a boolean/);
			if (scenario === 'session-presence') assert.match(text, /session_id is not supported/);
			assert.equal(f.calls.includes('guardrail'), scenario === 'padded-limit' || scenario === 'guardrail-block');
			await drainNodeBackgroundWork(); assert.equal(sends, scenario === 'padded-limit' ? 1 : 0); assert.equal(f.batches(), sends);
		});
	}
	it(`${prefix}${suffix}: paged format/sequential fields preserve exact pass-through and replay`, async t => {
		const f = await fixture(t, 'generations'); let sends = 0;
		const value = ' '.repeat(8192) + 'A'.repeat(8191) + '💡Ā\ud800\n';
		const raw = input('generations', { response_format: value, output_format: value, sequential_image_generation: value, watermark: { text: value } });
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Unexpected pass-through materialization'); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.ok(init?.body instanceof ReadableStream); const outbound = await new Response(init.body).json() as Record<string, unknown>;
			assert.equal(outbound.response_format, value.trim()); assert.equal(outbound.output_format, value);
			assert.equal(outbound.sequential_image_generation, value.trim()); assert.equal(Object.hasOwn(outbound, 'watermark'), false);
			return sends === 1 ? Response.json({ error: { message: 'synthetic rejection' } }, { status: 401 }) : Response.json(responseBody());
		});
		const response = await send(f.app, request(prefix + suffix, raw)); assert.equal(response.status, 200, await response.text());
		await drainNodeBackgroundWork(); assert.equal(sends, 2); assert.equal(f.batches(), 1);
	});
}

for (const shape of ['padded', 'overflow', 'replacement', 'nested', 'duplicate'] as const) {
	it(`generations: full 50 MiB ${shape} prompt has no unbounded native materialization`, async t => {
		const f = await fixture(t, 'generations'); let sends = 0, phase = 0, bytes = 0;
		const head = encode('{"model":"image-model","prompt":' + (shape === 'nested' ? '{"text":"' : '"'));
		const tail = encode(shape === 'nested' ? '"}}' : shape === 'duplicate' ? '","prompt":"syntheticĀ"}' : (shape === 'padded' ? 'syntheticĀ' : '') + '"}');
		let remaining = MAX_REQUEST_BODY_BYTES - head.length - tail.length;
		const page = new Uint8Array(65536).fill(shape === 'padded' ? 32 : shape === 'replacement' ? 255 : 65);
		const source = new ReadableStream<Uint8Array>({ pull(c) {
			let chunk: Uint8Array, last = false;
			if (phase++ === 0) chunk = head;
			else if (remaining) { const size = Math.min(page.length, remaining); remaining -= size; chunk = page.subarray(0, size); }
			else { chunk = tail; last = true; }
			bytes += chunk.length; c.enqueue(chunk); if (last) c.close();
		} }, { highWaterMark: 0 });
		const materialize = JsonStringPages.prototype.materialize;
		t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) { assert.ok(this.length <= 4000); return materialize.call(this); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.ok(init?.body instanceof ReadableStream);
			assert.equal((await new Response(init.body).json() as { prompt: string }).prompt, 'syntheticĀ'); return Response.json(responseBody());
		});
		const response = await send(f.app, request('/v1/images', source)), text = await response.text();
		const valid = shape === 'padded' || shape === 'duplicate';
		assert.equal(response.status, valid ? 200 : 400, text); assert.equal(bytes, MAX_REQUEST_BODY_BYTES); assert.equal(source.locked, false);
		await drainNodeBackgroundWork(); assert.equal(sends, valid ? 1 : 0); assert.equal(f.batches(), sends); assert.equal(f.calls.includes('guardrail'), valid);
	});
}

for (const prefix of ['/v1', '/api/v1']) for (const operation of ['generations', 'edits'] as const) {
	it(`${prefix}/images/${operation}: complete 32 MiB segmented input preserves Unicode/duplicate metadata and one settlement`, async t => {
		const f = await fixture(t, operation), files = trackUploads(t); let sends = 0, phase = 0;
		const head = encode('{"data":[{"b64_json":"');
		const tail = encode('"}],"opaque":{"label":"Ā图💡","duplicate":0,"duplicate":1,"__proto__":{"value":true}},"usage":{"input_tokens":3,"output_tokens":7,"total_tokens":10}}');
		const imageChars = IMAGE_MAX_RESPONSE_BYTES - head.length - tail.length;
		let remaining = imageChars, maxParseChars = 0;
		const page = new Uint8Array(65536).fill(65), parse = JSON.parse;
		t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => { maxParseChars = Math.max(maxParseChars, args[0].length); return parse(...args); });
		const source = new ReadableStream<Uint8Array>({ pull(c) {
			if (phase++ === 0) c.enqueue(head);
			else if (remaining) { const count = Math.min(page.length, remaining); remaining -= count; c.enqueue(page.subarray(0, count)); }
			else { c.enqueue(tail); c.close(); }
		} }, { highWaterMark: 0 });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; if (operation === 'edits') await outgoingForm(init); return new Response(source);
		});
		const response = await send(f.app, request(`${prefix}/images/${operation}`, input(operation)));
		assert.equal(response.status, 200); assert.equal(source.locked, false);
		assert.ok(maxParseChars <= JSON_PARSE_STRING_PIECE_CHARS + 7, 'gateway never parsed full image JSON text');
		const body = await response.json() as { data: Array<{ b64_json: string }>; opaque: Record<string, unknown>; usage: Record<string, number> };
		assert.equal(body.data[0]?.b64_json.length, imageChars); assert.equal(body.data[0]?.b64_json[imageChars - 1], 'A');
		assert.equal(body.opaque.label, 'Ā图💡'); assert.equal(body.opaque.duplicate, 1);
		assert.equal(Object.hasOwn(body.opaque, '__proto__'), true); assert.deepEqual(body.opaque.__proto__, { value: true });
		assert.equal(body.usage.prompt_tokens, 3); assert.equal(body.usage.completion_tokens, 7);
		await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
		assert.ok(files.every(file => file.retainedBytes === 0));
	});
}

for (const operation of ['generations', 'edits'] as const) for (const ending of ['valid', 'truncated'] as const) {
	it(`${operation}: segmented input with ${ending} withheld tail cannot publish a partial image or replay`, async t => {
		const f = await fixture(t, operation); let incoming!: ReadableStreamDefaultController<Uint8Array>, sends = 0, reading = false, published = false;
		const source = new ReadableStream<Uint8Array>({ start(c) { incoming = c; }, pull() { reading = true; } }, { highWaterMark: 0 });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; if (operation === 'edits') await outgoingForm(init); return new Response(source);
		});
		const pending = Promise.resolve(send(f.app, request('/api/v1/images/' + operation, input(operation)))).then(value => { published = true; return value; });
		await until(() => reading); incoming.enqueue(encode('{"data":[{"b64_json":"' + 'A'.repeat(65536)));
		await nextTurn(); assert.equal(published, false); assert.equal(f.batches(), 0);
		if (ending === 'valid') incoming.enqueue(encode('"}]}'));
		incoming.close();
		const response = await pending; assert.equal(response.status, ending === 'valid' ? 200 : 502, await response.text());
		assert.equal(source.locked, false); await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});
}

function resourcePart(name: string, value: string, file = false) {
	return `--${RESOURCE_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"${file ? '; filename="synthetic.png"' : ''}\r\n${file ? 'Content-Type: image/png\r\n' : ''}\r\n${value}\r\n`;
}

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations']) {
	for (const shape of ['depth', 'array', 'duplicate-keys'] as const) {
		it(`${prefix}${suffix}: JSON ${shape} limit rejects before the withheld tail, policy, budget or dispatch`, async t => {
			const f = await fixture(t, 'generations'); let pulls = 0, cancels = 0;
			const raw = '{"model":"image-model","prompt":"synthetic","PRIVATE_DETAIL":'
				+ (shape === 'depth' ? '['.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxDepth)
					: shape === 'array' ? '[' + '0,'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxNodes)
						: '{' + '"x":0,'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxNodes / 2));
			const source = new ReadableStream<Uint8Array>({ pull(c) {
				if (++pulls === 1) c.enqueue(encode(raw)); else throw new Error('Must not request JSON tail');
			}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
			await assertStop(await send(f.app, request(prefix + suffix, source)), 413);
			assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false);
			assert.equal(f.calls.includes('auth'), true); assert.equal(f.calls.includes('guardrail'), false);
			assert.equal(f.calls.includes('model'), false); assert.equal(f.calls.includes('key-limit'), false); assert.equal(f.batches(), 0);
		});
	}
}
for (const dimension of ['nodes', 'depth'] as const) it(`generations: exact JSON ${dimension} ceiling remains accepted`, async t => {
	const f = await fixture(t, 'generations'); let sends = 0;
	const opaque = dimension === 'depth' ? '['.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxDepth - 1) + '0' + ']'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxDepth - 1)
		: '[' + '0,'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxNodes - 8) + '0]';
	const raw = '{"model":"image-model","prompt":"synthetic","opaque":' + opaque + '}';
	t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
	const result = await send(f.app, request('/api/v1/images', raw));
	assert.equal(result.status, 200, await result.text()); await drainNodeBackgroundWork();
	assert.equal(sends, 1); assert.equal(f.batches(), 1);
});

for (const shape of ['ascii', 'mixed-string', 'replacement'] as const) it(`generations: exact 50 MiB ${shape} reference stays paged through count/dispatch with exact wire hash`, async t => {
	const f = await fixture(t, 'generations'); let sends = 0, index = 0, bodyCache: object | undefined;
	const app = createProxyApp(async c => { bodyCache = c.req.bodyCache; return f.storage; });
	const prefix = encode('{"model":"image-model","prompt":"synthetic","image":"'), suffix = encode(shape === 'mixed-string' ? 'Ā"}' : '"}');
	let remaining = MAX_REQUEST_BODY_BYTES - prefix.length - suffix.length;
	const imageLength = remaining;
	const page = new Uint8Array(65536).fill(shape === 'replacement' ? 255 : 65);
	const replacement = shape === 'replacement' ? encode('�'.repeat(page.length)) : undefined;
	const expectedHash = createHash('sha256').update('{"prompt":"synthetic","n":1,"image":"'), actualHash = createHash('sha256');
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (index++ === 0) c.enqueue(prefix);
		else if (remaining) {
			const length = Math.min(page.length, remaining); remaining -= length;
			expectedHash.update(replacement ? replacement.subarray(0, length * 3) : page.subarray(0, length)); c.enqueue(page.subarray(0, length));
		} else { expectedHash.update((shape === 'mixed-string' ? 'Ā' : '') + '","model":"private-model"}'); c.enqueue(suffix); c.close(); }
	} }, { highWaterMark: 0 });
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Unexpected whole payload materialization'); });
	const stringify = JSON.stringify; let scalarChars = 0;
	t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
		if (typeof args[0] === 'string') scalarChars = Math.max(scalarChars, args[0].length);
		else if (args[0] && typeof args[0] === 'object') assert.notEqual(typeof (args[0] as Record<string, unknown>).image, 'string', 'no complete JSON request serialization');
		return stringify(...args);
	});
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
		sends++; assert.ok(init?.body instanceof ReadableStream); assert.ok(bodyCache); assert.deepEqual(Object.keys(bodyCache), []);
		let bytes = 0; const reader = init.body.getReader();
		while (true) { const next = await reader.read(); if (next.done) break; assert.ok(next.value.length <= JSON_OUTPUT_PAGE_BYTES); bytes += next.value.length; actualHash.update(next.value); }
		reader.releaseLock(); assert.equal(bytes, Number(new Headers(init.headers).get('Content-Length')));
		assert.equal(bytes, imageLength * (shape === 'replacement' ? 3 : 1) + (shape === 'mixed-string' ? 2 : 0) + Buffer.byteLength('{"prompt":"synthetic","n":1,"image":"","model":"private-model"}'));
		assert.equal(actualHash.digest('hex'), expectedHash.digest('hex'));
		return Response.json(responseBody());
	});
	const result = await send(app, request('/v1/images/generations', source));
	assert.equal(result.status, 200, await result.text()); await drainNodeBackgroundWork();
	assert.equal(sends, 1); assert.equal(f.batches(), 1); assert.equal(source.locked, false);
	assert.ok(scalarChars <= JSON_PARSE_STRING_PIECE_CHARS); assert.deepEqual(Object.keys(bodyCache!), []);
});

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations']) {
	it(`${prefix}${suffix}: large references/options preserve native trim, projection and supplier-control behavior without materializing`, async t => {
		const f = await fixture(t, 'generations'); let sends = 0;
		const value = 'A'.repeat(8191) + '💡Ā\ud800\n', reference = ' '.repeat(8192) + value + '\ufeff';
		const body = input('generations', { image: [reference, ' '.repeat(20000), false, reference],
			provider: { order: ['test'] }, optimize_prompt_options: { label: value }, sequential_image_generation_options: value });
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Unexpected reference/options materialization'); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.ok(init?.body instanceof ReadableStream); const outbound = await new Response(init.body).json() as Record<string, unknown>;
			assert.deepEqual(outbound.image, [value.trim(), value.trim()]);
			assert.deepEqual(outbound.optimize_prompt_options, { label: value });
			assert.equal(Object.hasOwn(outbound, 'sequential_image_generation_options'), false);
			assert.equal(Object.hasOwn(outbound, 'provider'), false); return Response.json(responseBody());
		});
		const result = await send(f.app, request(prefix + suffix, body));
		assert.equal(result.status, 200, await result.text()); await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});

	it(`${prefix}${suffix}: native ingress values preserve BOM/replacement/duplicate semantics through actual route and driver`, async t => {
		const f = await fixture(t, 'generations'); let bodyCache: object | undefined, sends = 0;
		const app = createProxyApp(async c => { bodyCache = c.req.bodyCache; return f.storage; });
		const head = encode('\uFEFF{"model":"wrong","model":"image-model","prompt":" synthetic ","image":"Ā💡');
		const tail = encode('","n":"1","sequential_image_generation_options":{"duplicate":0,"duplicate":1,"__proto__":{"x":1},"toJSON":"ordinary data"}}');
		const raw = new Uint8Array(head.length + 1 + tail.length); raw.set(head); raw[head.length] = 255; raw.set(tail, head.length + 1);
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.ok(init?.body instanceof ReadableStream);
			const body = await new Response(init.body).json() as Record<string, unknown>;
			assert.equal(body.model, 'private-model'); assert.equal(body.prompt, 'synthetic'); assert.equal(body.n, 1); assert.equal(body.image, 'Ā💡�');
			assert.deepEqual(body.sequential_image_generation_options, JSON.parse('{"duplicate":1,"__proto__":{"x":1},"toJSON":"ordinary data"}'));
			return Response.json(responseBody());
		});
		const req = request(prefix + suffix, raw); req.headers.set('Content-Type', 'text/plain'); // Existing json() contract did not require MIME.
		const response = await send(app, req); assert.equal(response.status, 200, await response.text());
		await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1); assert.deepEqual(Object.keys(bodyCache!), []);
	});
}

for (const operation of ['generations', 'edits'] as const) for (const upstreamStatus of [200, 401]) {
	it(`${operation}: excessive upstream JSON after ${upstreamStatus} preserves the existing replay and usage boundary`, async t => {
		const f = await fixture(t, operation), files = trackUploads(t);
		let sends = 0, pulls = 0, cancels = 0, structureLogs = 0, unsafeParses = 0;
		const previousError = console.error;
		t.mock.method(console, 'error', (...args: unknown[]) => {
			if (typeof args[0] === 'string' && args[0].includes('"errorName":"JsonStructureLimitError"')) { structureLogs++; return; }
			previousError(...args);
		});
		const parse = JSON.parse;
		t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
			if (typeof args[0] === 'string' && args[0].startsWith('{"oversized_synthetic":')) unsafeParses++;
			return parse(...args);
		});
		const raw = '{"oversized_synthetic":[' + '0,'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxNodes);
		const source = new ReadableStream<Uint8Array>({ pull(c) {
			if (++pulls === 1) c.enqueue(encode(raw)); else throw new Error('Must not request upstream tail');
		}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			if (operation === 'edits') { const file = (await outgoingForm(init)).get('image'); assert.ok(file instanceof File); assert.equal(await file.text(), 'synthetic bytes'); }
			return sends === 1 ? new Response(source, { status: upstreamStatus }) : Response.json(responseBody());
		});
		const result = await send(f.app, request('/api/v1/images/' + operation, input(operation))), body = await result.text();
		assert.equal(result.status, upstreamStatus === 200 ? 502 : 200, body);
		assert.equal(sends, upstreamStatus === 200 ? 1 : 2); assert.equal(unsafeParses, 0);
		assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(structureLogs, 1);
		assert.doesNotMatch(body, /oversized_synthetic|Must not request/); assert.ok(files.every(file => file.retainedBytes === 0));
		await drainNodeBackgroundWork(); assert.equal(f.batches(), 1);
	});
}

for (const shape of ['depth', 'nodes'] as const) it(`generations SSE: ${shape} overflow is terminal before JSON.parse and emits only the existing error/DONE contract`, async t => {
	const f = await fixture(t, 'generations'); let sends = 0, pulls = 0, cancels = 0, unsafeParses = 0;
	const opaque = shape === 'depth' ? '['.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxDepth) + '0' + ']'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxDepth)
		: '[' + '0,'.repeat(IMAGE_JSON_STRUCTURE_LIMITS.maxNodes) + '0]';
	const raw = '{"oversized_synthetic":' + opaque + ',"type":"image_generation.completed","b64_json":"AQID"}';
	const parse = JSON.parse;
	t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
		if (typeof args[0] === 'string' && args[0].startsWith('{"oversized_synthetic":')) unsafeParses++;
		return parse(...args);
	});
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (++pulls === 1) c.enqueue(encode('data: ' + raw + '\n\n')); else throw new Error('Must not request next event');
	}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	t.mock.method(globalThis, 'fetch', async () => { sends++; return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }); });
	const result = await send(f.app, request('/v1/images', input('generations', { stream: true }))), body = await result.text();
	assert.equal(result.status, 200); assert.match(body, /structure limit/); assert.match(body, /\[DONE\]/);
	assert.doesNotMatch(body, /image_generation.completed|AQID|oversized_synthetic/); assert.equal(unsafeParses, 0);
	assert.equal(sends, 1); assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false);
	await drainNodeBackgroundWork(); assert.equal(f.batches(), 1);
});

for (const prefix of ['/v1', '/api/v1']) {
	for (const scenario of ['files', 'field', 'fields-total', 'headers', 'parts', 'file-size'] as const) {
		it(`${prefix}/images/edits: ${scenario} fails before the withheld upload tail or any policy/dispatch`, async t => {
			const f = await fixture(t, 'edits'); let pulls = 0, cancels = 0;
			const base = resourcePart('model', 'image-model') + resourcePart('prompt', 'synthetic');
			const header = scenario === 'files' ? resourcePart('image', 'abc', true).repeat(IMAGE_MAX_REFERENCE_COUNT) + resourcePart('ignored-file', '', true)
				: scenario === 'field' ? resourcePart('unknown', 'x'.repeat(MULTIPART_MAX_FIELD_BYTES + 100))
					: scenario === 'fields-total' ? resourcePart('repeat', 'x'.repeat(MULTIPART_MAX_FIELD_BYTES)).repeat(MULTIPART_MAX_FIELDS_BYTES / MULTIPART_MAX_FIELD_BYTES + 1)
						: scenario === 'headers' ? `--${RESOURCE_BOUNDARY}\r\nX-Oversize: ` + 'x'.repeat(MULTIPART_MAX_HEADER_BYTES)
							: scenario === 'parts' ? resourcePart('repeat', '').repeat(MULTIPART_MAX_PARTS)
								: resourcePart('image', 'x'.repeat(IMAGE_MAX_BYTES_PER_FILE + 100), true);
			const source = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls === 1) c.enqueue(encode(base + header)); else throw new Error('Unread tail requested'); },
				cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
			const req = request(prefix + '/images/edits', source);
			req.headers.set('Content-Type', `multipart/form-data; boundary=${RESOURCE_BOUNDARY}`);
			const response = await send(f.app, req), body = await response.text();
			const status = scenario === 'files' || scenario === 'file-size' ? 400 : 413;
			assert.equal(response.status, status, body);
			assert.equal(response.headers.get('X-OctaFuse-Error-Code'), status === 400 ? 'gateway.invalid_request' : 'gateway.payload_too_large');
			assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false);
			assert.equal(f.calls.includes('guardrail'), false); assert.equal(f.calls.includes('model'), false); assert.equal(f.batches(), 0);
			assert.doesNotMatch(body, /Unread tail|synthetic.png|PRIVATE_DETAIL/);
		});
	}
	it(`${prefix}/images/edits/: existing strict-router 404 cancels without reading a multipart upload`, async t => {
		const f = await fixture(t, 'edits'); let pulls = 0, cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
		const req = request(prefix + '/images/edits/', source);
		req.headers.set('Content-Type', `multipart/form-data; boundary=${RESOURCE_BOUNDARY}`);
		const response = await send(f.app, req); assert.equal(response.status, 404, await response.text());
		assert.equal(pulls, 0); assert.equal(cancels, 1); assert.equal(f.calls.includes('guardrail'), false); assert.equal(f.batches(), 0);
	});
}

for (const extra of [0, 1]) {
	it(`edits: preserves the full ${MAX_REQUEST_BODY_BYTES}-byte raw upload capacity, extra=${extra}`, async t => {
		const f = await fixture(t, 'edits'); let sends = 0, index = 0, cancels = 0;
		const base = encode(resourcePart('model', 'image-model') + resourcePart('prompt', 'synthetic'));
		const header = encode(resourcePart('image', '', true).slice(0, -2)), crlf = encode('\r\n');
		const end = encode(`--${RESOURCE_BOUNDARY}--\r\n`);
		const overhead = base.length + 3 * (header.length + crlf.length) + end.length;
		const sizes = [IMAGE_MAX_BYTES_PER_FILE, IMAGE_MAX_BYTES_PER_FILE, MAX_REQUEST_BODY_BYTES - overhead - 2 * IMAGE_MAX_BYTES_PER_FILE + extra];
		const chunks = [base], data = new Uint8Array(64 * 1024);
		for (const size of sizes) {
			chunks.push(header);
			for (let remaining = size; remaining > 0; remaining -= data.length) chunks.push(data.subarray(0, Math.min(data.length, remaining)));
			chunks.push(crlf);
		}
		chunks.push(end); assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), MAX_REQUEST_BODY_BYTES + extra);
		const source = new ReadableStream<Uint8Array>({ pull(c) { if (index === chunks.length) c.close(); else c.enqueue(chunks[index++]!); }, cancel() { cancels++; } }, { highWaterMark: 0 });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; const form = await outgoingForm(init);
			assert.deepEqual(form.getAll('image').map(file => file instanceof File ? file.size : -1), sizes);
			return Response.json(responseBody());
		});
		const response = await send(f.app, request('/v1/images/edits', source));
		assert.equal(response.status, extra ? 413 : 200, await response.text()); await drainNodeBackgroundWork();
		assert.equal(sends, extra ? 0 : 1); assert.equal(f.batches(), extra ? 0 : 1); assert.equal(cancels, extra ? 1 : 0);
	});
}

for (const outcome of ['missing-model', 'policy-block', 'success', 'unknown', 'cancel-prepare', 'cancel-dispatch', 'deadline-body'] as const) {
	it(`edits: request-owned pages released on ${outcome}, with no extra dispatch`, async t => {
		const f = await fixture(t, 'edits'), client = new AbortController(), files = trackUploads(t);
		let sends = 0, readingResponse = false, responseCancels = 0;
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		if (outcome === 'policy-block') f.repos.guardrails.getEffectiveForRequest = async () => [policy()];
		if (outcome === 'cancel-prepare') f.hooks.set('model', async () => { client.abort(); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; const form = await outgoingForm(init); assert.ok(form.get('image') instanceof File);
			assert.ok(files.every(file => file.retainedBytes > 0));
			if (outcome === 'cancel-dispatch') client.abort();
			if (outcome === 'unknown') return Response.json({ data: [] });
			if (outcome === 'deadline-body') return new Response(new ReadableStream<Uint8Array>({
				pull() { readingResponse = true; }, cancel() { responseCancels++; return new Promise<void>(() => {}); },
			}));
			return Response.json(responseBody());
		});
		const pending = send(f.app, request('/v1/images/edits', input('edits', outcome === 'missing-model' ? { model: '' } : {}), client.signal));
		if (outcome === 'deadline-body') { await until(() => readingResponse); t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS); }
		const response = await pending;
		const expected = outcome === 'missing-model' ? 400 : outcome === 'policy-block' ? 403 : outcome === 'unknown' ? 502
			: outcome.startsWith('cancel') ? 499 : outcome === 'deadline-body' ? 504 : 200;
		assert.equal(response.status, expected, await response.text()); await drainNodeBackgroundWork();
		assert.equal(files.length, 1); assert.ok(files.every(file => file.retainedBytes === 0));
		assert.equal(sends, ['missing-model', 'policy-block', 'cancel-prepare'].includes(outcome) ? 0 : 1);
		assert.equal(responseCancels, outcome === 'deadline-body' ? 1 : 0);
	});
}
it('edits: only a definitive rejection permits replay of the same retained bytes, then releases them', async t => {
	const f = await fixture(t, 'edits'), files = trackUploads(t); let sends = 0;
	const seen: number[][] = [];
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
		sends++; const form = await outgoingForm(init), file = form.get('image'); assert.ok(file instanceof File);
		seen.push([...new Uint8Array(await file.arrayBuffer())]);
		assert.ok(files.every(file => file.retainedBytes > 0));
		return sends === 1 ? Response.json({ error: { message: 'definitive synthetic rejection' } }, { status: 401 }) : Response.json(responseBody());
	});
	const response = await send(f.app, request('/api/v1/images/edits', input('edits')));
	assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork();
	assert.equal(sends, 2); assert.deepEqual(seen[0], seen[1]); assert.deepEqual(seen[0], [...encode('synthetic bytes')]);
	assert.equal(files.length, 1); assert.equal(files[0]!.retainedBytes, 0); assert.equal(f.batches(), 1);
});
it('edits: public route leaves Hono bodyCache empty and native probes never contain the upload', async t => {
	const f = await fixture(t, 'edits'); let bodyCache: object | undefined, probes = 0;
	const app = createProxyApp(async c => { bodyCache = c.req.bodyCache; return f.storage; });
	const native = Response.prototype.formData;
	t.mock.method(Response.prototype, 'formData', async function(this: Response) {
		const bytes = await this.arrayBuffer(); assert.ok(bytes.byteLength < 20000); probes++;
		return native.call(new Response(bytes, { headers: this.headers }));
	});
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
		assert.ok(init?.body instanceof ReadableStream); const reader = init.body.getReader(); let size = 0;
		while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; }
		reader.releaseLock(); assert.equal(size, Number(new Headers(init.headers).get('Content-Length')));
		return Response.json(responseBody());
	});
	const response = await send(app, request('/v1/images/edits', input('edits')));
	assert.equal(response.status, 200, await response.text()); assert.equal(probes, 3);
	assert.ok(bodyCache); assert.deepEqual(Object.keys(bodyCache), []);
});

function policy(output = false): EffectiveGuardrailRow {
	return { id: 'policy', workspace_id: 'image-workspace', owner_user_id: 'image-user', name: 'Synthetic', description: null,
		status: 'active', designated_version: 1, latest_version: 1, created_at: NOW, updated_at: NOW, version_id: 'policy-v1',
		version_config_json: output ? '{"output_filters":[{"id":"secret","pattern":"secret","action":"block"}]}' : '{"allowed_models":["not-this-model"]}', version_created_by_user_id: 'image-user', version_created_at: NOW,
		assignment_id: 'assignment', assignment_scope_type: 'user', assignment_scope_id: 'image-user' };
}

it('Images ingress allowlist includes only exact canonical and legacy writes', () => {
	for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations', '/images/edits']) {
		assert.equal(isImageInferenceRequest('POST', prefix + suffix), true);
		assert.equal(isImageInferenceRequest('POST', prefix + suffix + '/'), true);
		assert.equal(isImageInferenceRequest('GET', prefix + suffix), false);
		assert.equal(isImageInferenceRequest('POST', prefix + suffix + '/extra'), false);
	}
	for (const path of ['/v1/images-more', '/v2/images', '/v1/batches', '/v1/images/models', '/v1/embeddings']) {
		assert.equal(isImageInferenceRequest('POST', path), false);
	}
});

async function multipartRequest(form: FormData): Promise<Request> {
	const encoded = new Request('https://gateway.example.invalid/v1/images/edits', { method: 'POST', body: form });
	const req = request('/v1/images/edits', await encoded.arrayBuffer());
	req.headers.set('Content-Type', encoded.headers.get('Content-Type')!);
	return req;
}

for (const field of ['image', 'images', 'image[]', 'image_2', 'IMAGE']) {
	it(`edits: ${field} retains parsed files without application arrayBuffer copies`, async t => {
		const f = await fixture(t, 'edits'), form = new FormData();
		form.set('model', 'image-model'); form.set('prompt', 'synthetic');
		for (let i = 0; i < IMAGE_MAX_REFERENCE_COUNT; i++) {
			form.append(field, new File([new Uint8Array([i, 1, 2])], `image-${i}.png`, { type: 'image/png' }));
		}
		const req = await multipartRequest(form); let seen = 0;
		t.mock.method(Blob.prototype, 'arrayBuffer', () => { throw new Error('Unexpected application file copy'); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			const files = (await outgoingForm(init)).getAll('image');
			assert.equal(files.length, IMAGE_MAX_REFERENCE_COUNT);
			for (const [i, file] of files.entries()) {
				assert.ok(file instanceof File); assert.equal(file.size, 3); assert.equal(file.type, 'image/png');
				assert.equal(file.name, `image-${i}.png`); seen++;
			}
			return Response.json(responseBody());
		});
		const response = await send(f.app, req); assert.equal(response.status, 200, await response.text());
		assert.equal(seen, IMAGE_MAX_REFERENCE_COUNT);
	});
}

for (const invalid of ['empty', 'mime', 'too-many', 'oversize', 'exact-file-limit'] as const) {
	it(`edits: ${invalid} validates native file metadata before policy and dispatch`, async t => {
		const f = await fixture(t, 'edits'), form = new FormData(); let sends = 0;
		form.set('model', 'image-model'); form.set('prompt', 'synthetic');
		const size = invalid === 'empty' ? 0 : invalid === 'oversize' ? IMAGE_MAX_BYTES_PER_FILE + 1
			: invalid === 'exact-file-limit' ? IMAGE_MAX_BYTES_PER_FILE : 1;
		for (let i = 0; i < (invalid === 'too-many' ? IMAGE_MAX_REFERENCE_COUNT + 1 : 1); i++) {
			form.append('image', new File([new Uint8Array(size)], 'image.png', { type: invalid === 'mime' ? 'text/plain' : 'image/png' }));
		}
		const req = await multipartRequest(form);
		t.mock.method(Blob.prototype, 'arrayBuffer', () => { throw new Error('Unexpected application file copy'); });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; const file = (await outgoingForm(init)).get('image');
			assert.ok(file instanceof File); assert.equal(file.size, IMAGE_MAX_BYTES_PER_FILE); return Response.json(responseBody());
		});
		const response = await send(f.app, req), valid = invalid === 'exact-file-limit';
		assert.equal(response.status, valid ? 200 : 400, await response.text());
		assert.equal(sends, valid ? 1 : 0); assert.equal(f.calls.includes('guardrail'), valid);
	});
}

for (const body of ['null', '[]', '42', '{invalid']) {
	it(`generations: non-object or malformed JSON (${body}) is a controlled 400`, async t => {
		const f = await fixture(t, 'generations');
		const response = await send(f.app, request('/v1/images', body));
		assert.equal(response.status, 400, await response.text()); assert.equal(f.calls.includes('guardrail'), false);
	});
}

for (const prefix of ['/v1', '/api/v1']) {
	it(`${prefix}/images: remaining ingress time survives SSE handoff and settles unread timeout`, async t => {
		const f = await fixture(t, 'generations'); let cancels = 0, sends = 0;
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		f.hooks.set('auth', async () => { t.mock.timers.setTime(Date.parse(NOW) + TEXT_REQUEST_DEADLINE_MS - 20); });
		t.mock.method(globalThis, 'fetch', async () => {
			sends++; return new Response(new ReadableStream({ cancel() { cancels++; return new Promise<void>(() => {}); } }), { headers: { 'Content-Type': 'text/event-stream' } });
		});
		const response = await send(f.app, request(prefix + '/images', input('generations', { stream: true })));
		assert.equal(response.status, 200); t.mock.timers.tick(21);
		await drainNodeBackgroundWork(); const body = await response.text();
		assert.match(body, /timed out/); assert.match(body, /\[DONE\]/);
		assert.equal(sends, 1); assert.equal(cancels, 1); assert.equal(f.batches(), 1);
	});
}

for (const prefix of ['/v1', '/api/v1']) for (const suffix of ['/images', '/images/generations', '/images/edits']) {
	const path = prefix + suffix, operation = suffix.endsWith('/edits') ? 'edits' : 'generations';
	for (const stop of ['client', 'deadline'] as const) for (const declared of [false, true]) {
		it(`${path}: silent upload ${stop}, declared=${declared}`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(); let cancels = 0;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const source = new ReadableStream<Uint8Array>({ cancel() { cancels++; return new Promise<void>(() => {}); } });
			const pending = send(f.app, request(path, source, parent.signal, declared ? 128 : undefined));
			await until(() => f.calls.includes('auth'));
			if (stop === 'client') parent.abort('PRIVATE_DETAIL'); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(f.batches(), 0);
			assert.equal(f.calls.includes('guardrail'), false);
		});
	}
	it(`${path}: missing key cancels unread upload without waiting for cancel acknowledgement`, async t => {
		const f = await fixture(t, operation); let pulls = 0, cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		const req = request(path, source); req.headers.delete('Authorization');
		assert.equal((await send(f.app, req)).status, 401); assert.equal(pulls, 0); assert.equal(cancels, 1); assert.equal(f.calls.length, 0);
	});
	it(`${path}: declared body limit is checked before storage`, async t => {
		const f = await fixture(t, operation); let storage = 0, cancels = 0;
		const app = createProxyApp(async () => { storage++; return f.storage; });
		await assertStop(await send(app, request(path, new ReadableStream({ cancel() { cancels++; } }), undefined, MAX_REQUEST_BODY_BYTES + 1)), 413);
		assert.equal(storage, 0); assert.equal(cancels, 1);
	});
	it(`${path}: successful response still has one dispatch and one usage batch`, async t => {
		const f = await fixture(t, operation); let sends = 0;
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; assert.equal(init?.redirect, 'manual'); return Response.json(responseBody());
		});
		const response = await send(f.app, request(path, input(operation)));
		assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork();
		assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});
	it(`${path}: authentication time consumes the later OAuth/dispatch allowance`, { timeout: 5000 }, async t => {
		const f = await fixture(t, operation, ACCOUNT); let oauth = 0, sends = 0;
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		f.hooks.set('auth', async () => { t.mock.timers.setTime(Date.parse(NOW) + TEXT_REQUEST_DEADLINE_MS - 10); });
		t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
			if (String(url) === GCP_OAUTH_TOKEN_URL) { oauth++; return new Promise<Response>(() => {}); }
			sends++; throw new Error('Must not send');
		});
		const pending = send(f.app, request(path, input(operation)));
		await until(() => oauth === 1); t.mock.timers.tick(11);
		await assertStop(await pending, 504); assert.equal(sends, 0); assert.equal(oauth, 1);
	});
}

for (const operation of ['generations', 'edits'] as const) for (const stop of ['client', 'deadline'] as const) {
	for (const phase of ['shared-pool', 'sticky-hash', 'sticky-lookup'] as const) {
		it(`${operation}: ${stop} during ${phase} cannot continue credential/sticky preparation`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation, 'synthetic-provider-key', { shared: phase === 'shared-pool', sticky: phase !== 'shared-pool' });
			const parent = new AbortController(), gate = deferred<void>(), hash = deferred<ArrayBuffer>(); let hashes = 0;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			if (phase === 'sticky-hash') f.hooks.set('byok-pool', async () => {
				t.mock.method(crypto.subtle, 'digest', () => { hashes++; return hash.promise; });
			});
			else f.hooks.set(phase, () => gate.promise);
			const pending = send(f.app, request('/v1/images/' + operation, input(operation), parent.signal));
			await until(() => phase === 'sticky-hash' ? hashes === 1 : f.calls.includes(phase));
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			const stopped = [...f.calls]; gate.resolve(); hash.resolve(new ArrayBuffer(32)); await nextTurn(); await nextTurn();
			assert.deepEqual(f.calls, stopped); assert.equal(f.batches(), 0);
		});
	}
	for (const mutation of ['sticky-gc', 'sticky-clear'] as const) {
		it(`${operation}: ${stop} does not orphan already-started ${mutation}`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation, 'synthetic-provider-key', { sticky: true }), parent = new AbortController(), gate = deferred<void>();
			let entered = false, settled = false, sends = 0;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			t.mock.method(Math, 'random', () => mutation === 'sticky-gc' ? 0 : 1);
			const pause = async () => { entered = true; if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS); await gate.promise; };
			if (mutation === 'sticky-gc') f.hooks.set(mutation, pause);
			else {
				f.repos.routePoolSticky.getBinding = async (_pool, affinityHash) => ({ route_pool_id: 'pool', affinity_hash: affinityHash,
					route_target_id: 'target-1', binding_token: 'synthetic-binding', pool_epoch: 1,
					expires_at: '2099-01-01T00:00:00.000Z', created_at: NOW, updated_at: NOW });
				f.repos.routePoolSticky.clearBinding = async () => { await pause(); return true; };
			}
			t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json({ error: { message: 'synthetic rejection' } }, { status: 401 }); });
			const pending = send(f.app, request('/v1/images/' + operation, input(operation), parent.signal));
			void Promise.resolve(pending).then(() => { settled = true; }); await until(() => entered);
			await nextTurn(); assert.equal(settled, false);
			gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504); await drainNodeBackgroundWork();
			assert.equal(sends, mutation === 'sticky-gc' ? 0 : 1);
		});
	}
	for (const phase of ['guardrail', 'key-limit', 'workspace-budget', 'model', 'surface', 'routes', 'provider', 'endpoint', 'policy', 'pricing-config', 'byok-pool', 'byok-suppress']) {
		it(`${operation}: ${stop} at ${phase} read prevents late continuation`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>();
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.hooks.set(phase, () => gate.promise);
			const body = input(operation, phase === 'policy' ? { provider: { data_collection: 'deny' } } : {});
			const pending = send(f.app, request('/api/v1/images/' + operation, body, parent.signal));
			await until(() => f.calls.includes(phase));
			if (phase === 'pricing-config') assert.equal(f.calls.includes('endpoint'), true);
			if (stop === 'client') parent.abort('PRIVATE_DETAIL'); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			const stopped = [...f.calls]; gate.resolve(); await nextTurn(); await nextTurn();
			assert.deepEqual(f.calls, stopped); assert.equal(f.batches(), 0);
		});
	}
	for (const output of [false, true]) {
		it(`${operation}: ${stop} while hashing ${output ? 'output' : 'input'} audit prevents its write`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<ArrayBuffer>(); let hashes = 0;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.repos.guardrails.getEffectiveForRequest = async () => {
				t.mock.method(crypto.subtle, 'digest', () => { hashes++; return gate.promise; }); return [policy(output)];
			};
			const pending = send(f.app, request('/v1/images/' + operation, input(operation), parent.signal));
			await until(() => hashes === 1);
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await assertStop(await pending, stop === 'client' ? 499 : 504);
			gate.resolve(new ArrayBuffer(32)); await nextTurn();
			assert.equal(hashes, 1); assert.equal(f.calls.includes('audit-write'), false); assert.equal(f.batches(), 0);
		});
		it(`${operation}: ${stop} retains already-started ${output ? 'output' : 'input'} audit ownership`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>(); let settled = false;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			f.repos.guardrails.getEffectiveForRequest = async () => [policy(output)]; f.hooks.set('audit-write', () => gate.promise);
			const pending = send(f.app, request('/v1/images/' + operation, input(operation), parent.signal));
			void Promise.resolve(pending).then(() => { settled = true; });
			await until(() => f.calls.includes('audit-write'));
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextTurn(); assert.equal(settled, false);
			gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504);
			assert.equal(f.calls.includes('model'), false); assert.equal(f.batches(), 0);
		});
	}
	it(`${operation}: ${stop} drains first actual encryption-wrapper migration and forbids the second`, { timeout: 5000 }, async t => {
		const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>(); let writes = 0, settled = false;
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
		f.repos.providers.updateProviderByPatch = async (_id, patch) => {
			assert.match(String(patch.api_key), /^enc:v2:/); writes++; await gate.promise; return 1;
		};
		const storage = { ...f.storage, repositories: { ...f.repos,
			providers: createEncryptedProvidersRepository(f.repos.providers, 'synthetic-image-encryption-secret-32-characters') } };
		const app = createProxyApp(async () => storage);
		const pending = send(app, request('/v1/images/' + operation, input(operation), parent.signal));
		void Promise.resolve(pending).then(() => { settled = true; }); await until(() => writes === 1);
		if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
		await nextTurn(); assert.equal(settled, false);
		gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504); await nextTurn();
		assert.equal(writes, 1); assert.equal(f.batches(), 0);
	});
	for (const phase of ['storage', 'auth'] as const) {
		it(`${operation}: ${stop} waits for ${phase} confirmation then stops`, { timeout: 5000 }, async t => {
			const f = await fixture(t, operation), parent = new AbortController(), gate = deferred<void>(); let entered = false, settled = false;
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			const pause = async () => { entered = true; await gate.promise; };
			const app = phase === 'storage' ? createProxyApp(async () => { await pause(); return f.storage; }) : f.app;
			if (phase === 'auth') f.hooks.set('auth', pause);
			const pending = send(app, request('/v1/images/' + operation, input(operation), parent.signal));
			void Promise.resolve(pending).then(() => { settled = true; }); await until(() => entered);
			if (stop === 'client') parent.abort(); else t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			await nextTurn(); assert.equal(settled, false);
			gate.resolve(); await assertStop(await pending, stop === 'client' ? 499 : 504);
			assert.equal(f.calls.includes('guardrail'), false); assert.equal(f.batches(), 0);
		});
	}
}

for (const operation of ['generations', 'edits'] as const) {
	it(`Images ${operation}: an upstream 307 is unknown and never exposes its redirect target`, async t => {
		const f = await fixture(t, operation);
		let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			sends++;
			return Response.json({ error: { message: 'synthetic redirect' } }, {
				status: 307, headers: { Location: 'https://redirect.example.invalid/private-token' },
			});
		});
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		const body = await response.text();
		assert.equal(response.status, 502, body);
		assert.equal(response.headers.get('Location'), null);
		assert.match(body, /"outcome_unknown":true/);
		assert.match(body, /"retry_safe":false/);
		assert.doesNotMatch(body, /private-token/);
		await drainNodeBackgroundWork();
		assert.equal(sends, 1);
	});
	it(`${operation}: actual global overflow remains 413 even with stalled cancel`, async t => {
		const f = await fixture(t, operation); let cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(MAX_REQUEST_BODY_BYTES + 1)); }, cancel() { cancels++; return new Promise<void>(() => {}); } });
		await assertStop(await send(f.app, request('/v1/images/' + operation, source)), 413);
		assert.equal(cancels, 1); assert.equal(f.calls.includes('guardrail'), false);
	});
	it(`${operation}: ingress listeners are released at response handoff`, async t => {
		const f = await fixture(t, operation); let signal: AbortSignal | undefined;
		const app = createProxyApp(async c => { signal = c.get('textRequestLifecycle')?.deadline.signal; return f.storage; });
		t.mock.method(globalThis, 'fetch', async () => Response.json(responseBody()));
		const response = await send(app, request('/v1/images/' + operation, input(operation)));
		assert.equal(response.status, 200, await response.text()); assert.ok(signal);
		assert.equal(getEventListeners(signal, 'abort').length, 0);
	});
}

for (const prefix of ['/v1', '/api/v1']) for (const operation of ['generations', 'edits'] as const) {
	it(`${prefix}/images/${operation}: no whole image JSON serialization during body handoff`, async t => {
		const f = await fixture(t, operation), value = 'iVBORw0KGgoA' + 'A'.repeat(1024 * 1024);
		const opaque = { label: '图Ā💡\ud800\n"\\', nested: [null, 17, { toJSON: 'data' }] };
		const raw = JSON.stringify({ data: [{ b64_json: value }], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 }, opaque });
		const stringify = t.mock.method(JSON, 'stringify'); let sends = 0;
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++; if (operation === 'edits') await outgoingForm(init);
			return new Response(raw, { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Length': String(raw.length), 'X-Private-Debug': 'PRIVATE_DETAIL' } });
		});
		const response = await send(f.app, request(`${prefix}/images/${operation}`, input(operation)));
		assert.equal(response.status, 200);
		const body = await response.json() as { data: Array<{ b64_json: string; media_type: string }>; usage: { prompt_tokens: number; completion_tokens: number }; opaque: unknown };
		assert.equal(body.data[0]?.b64_json, value); assert.equal(body.data[0]?.media_type, 'image/png');
		assert.equal(body.usage.prompt_tokens, 3); assert.equal(body.usage.completion_tokens, 7);
		assert.deepEqual(body.opaque, opaque);
		assert.equal(response.headers.get('X-Private-Debug'), null); assert.equal(response.headers.get('Content-Length'), null);
		assert.equal(stringify.mock.calls.filter(call => call.arguments[0]?.data?.[0]?.b64_json === value).length, 0);
		await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
	});
}

for (const prefix of ['/v1', '/api/v1']) for (const operation of ['generations', 'edits'] as const) {
	for (const phase of ['unread', 'one-page', 'eof'] as const) for (const stop of ['cancel', 'client', 'deadline', 'elapsed'] as const) {
		it(`${prefix}/images/${operation}: ${stop} during ${phase} JSON delivery never replays a confirmed generation`, async t => {
			const f = await fixture(t, operation), client = new AbortController(), files = trackUploads(t);
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(NOW) });
			let sends = 0, upstreamSignal: AbortSignal | null | undefined;
			const raw = JSON.stringify({ data: [{ b64_json: 'A'.repeat(3 * JSON_OUTPUT_PAGE_BYTES) }], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } });
			t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
				sends++; upstreamSignal = init?.signal;
				if (operation === 'edits') await outgoingForm(init);
				return new Response(raw);
			});
			const response = await send(f.app, request(`${prefix}/images/${operation}`, input(operation), client.signal));
			assert.equal(response.status, 200); assert.ok(upstreamSignal);
			assert.ok(files.every(file => file.retainedBytes === 0));
			const reader = response.body!.getReader();
			if (phase === 'one-page') assert.equal((await reader.read()).value?.length, JSON_OUTPUT_PAGE_BYTES);
			if (phase === 'eof') while (!(await reader.read()).done) { /* complete encoding, not network ACK */ }
			if (stop === 'cancel') await reader.cancel('PRIVATE_DETAIL');
			else if (stop === 'client') client.abort('PRIVATE_DETAIL');
			else if (stop === 'deadline') t.mock.timers.tick(TEXT_REQUEST_DEADLINE_MS);
			else t.mock.timers.setTime(Date.parse(NOW) + TEXT_REQUEST_DEADLINE_MS);
			if (phase === 'eof' || stop === 'cancel') assert.equal((await reader.read()).done, true);
			else await assert.rejects(reader.read(), { message: 'JSON response delivery was interrupted' });
			reader.releaseLock(); assert.equal(getEventListeners(upstreamSignal, 'abort').length, 0);
			await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
			// This fixture observes one confirmed-result usage write, not real money or network delivery acknowledgement.
		});
	}
}

for (const order of ['upload-first', 'headers-first', 'upload-cancelled'] as const) for (const valid of [true, false]) {
	it(`edits: release accepted upload only after both 2xx and upload completion (${order}, valid=${valid})`, async t => {
		const f = await fixture(t, 'edits'), files = trackUploads(t); let sends = 0, readingResponse = false;
		let outbound: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let incoming!: ReadableStreamDefaultController<Uint8Array>;
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			if (order === 'upload-first') await outgoingForm(init);
			else { assert.ok(init?.body instanceof ReadableStream); outbound = init.body.getReader(); await outbound.read(); }
			assert.ok(files.length > 0 && files.every(file => file.retainedBytes > 0), 'EOF alone cannot authorize release before headers');
			return new Response(new ReadableStream<Uint8Array>({ start(c) { incoming = c; }, pull() { readingResponse = true; } }, { highWaterMark: 0 }));
		});
		// Include an unused file too; ownership is the complete parsed request, not only the sent image.
		const raw = input('edits'); assert.equal(typeof raw, 'string');
		const wire = String(raw).replace(`--${RESOURCE_BOUNDARY}--\r\n`, resourcePart('unused-file', 'synthetic unused', true) + `--${RESOURCE_BOUNDARY}--\r\n`);
		const pending = send(f.app, request('/v1/images/edits', wire));
		await until(() => readingResponse); assert.equal(files.length, 2);
		if (order === 'upload-first') assert.ok(files.every(file => file.retainedBytes === 0));
		else {
			assert.ok(outbound); assert.ok(files.every(file => file.retainedBytes > 0), '2xx alone must not truncate an in-flight upload');
			if (order === 'upload-cancelled') await outbound.cancel('synthetic transport no longer needs upload');
			else while (!(await outbound.read()).done) { /* drain the real serializer */ }
			outbound.releaseLock();
			assert.ok(files.every(file => file.retainedBytes === 0), 'release before the stalled response body is supplied');
		}
		incoming.enqueue(encode(JSON.stringify(valid ? responseBody() : { data: [] }))); incoming.close();
		const response = await pending; assert.equal(response.status, valid ? 200 : 502, await response.text());
		await drainNodeBackgroundWork(); assert.equal(sends, 1); assert.equal(f.batches(), 1);
		assert.ok(files.every(file => file.retainedBytes === 0));
	});
}

it('generations: early 401 cancels its locked encoder; next candidate receives all original reference bytes once', async t => {
	const f = await fixture(t, 'generations'); let sends = 0, abandoned: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const reference = 'A'.repeat(4 * JSON_OUTPUT_PAGE_BYTES) + '💡';
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
		sends++; assert.ok(init?.body instanceof ReadableStream);
		if (sends === 1) {
			abandoned = init.body.getReader(); assert.equal((await abandoned.read()).value?.length, JSON_OUTPUT_PAGE_BYTES);
			return Response.json({ error: { message: 'synthetic rejection' } }, { status: 401 });
		}
		assert.ok(abandoned); await assert.rejects(abandoned.read()); abandoned.releaseLock();
		const body = await new Response(init.body).json() as { image: string };
		assert.equal(body.image, reference); return Response.json(responseBody());
	});
	const response = await send(f.app, request('/api/v1/images', input('generations', { image: reference })));
	assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork();
	assert.equal(sends, 2); assert.equal(f.batches(), 1);
});

it('edits: an early 401 may abandon its upload but preserves complete replay pages for the next candidate', async t => {
	const f = await fixture(t, 'edits'), files = trackUploads(t); let sends = 0, abandoned: ReadableStreamDefaultReader<Uint8Array> | undefined;
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
		sends++; assert.ok(files.length > 0 && files.every(file => file.retainedBytes > 0));
		if (sends === 1) {
			assert.ok(init?.body instanceof ReadableStream); abandoned = init.body.getReader(); await abandoned.read();
			return Response.json({ error: { message: 'synthetic rejection' } }, { status: 401 });
		}
		assert.ok(abandoned); await assert.rejects(abandoned.read()); abandoned.releaseLock();
		const image = (await outgoingForm(init)).get('image'); assert.ok(image instanceof File);
		assert.equal(await image.text(), 'synthetic bytes');
		return Response.json(responseBody());
	});
	const response = await send(f.app, request('/v1/images/edits', input('edits')));
	assert.equal(response.status, 200, await response.text()); await drainNodeBackgroundWork();
	assert.equal(sends, 2); assert.equal(f.batches(), 1); assert.ok(files.every(file => file.retainedBytes === 0));
});

for (const operation of ['generations', 'edits'] as const) {
	it(`Images ${operation}: opt-in recovery receives a digest of admitted ingress content`, async t => {
		const digests: string[] = [];
		let sends = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = Object.assign(
			(scope: Parameters<ImageUsageRecoveryFactory>[0]) => {
				digests.push(scope.requestSha256 ?? '');
				let granted = false;
				return {
					get mayHaveDispatched() { return granted; },
					async beforeDispatch(_route: unknown, _attemptIndex: number, admit: () => Promise<void>, checkActive: () => void) {
						checkActive();
						await admit();
						granted = true;
					},
					async persist() { return async () => {}; },
				};
			},
			{ requiresTrustedIngressDigest: true as const },
		);
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			if (operation === 'edits') await outgoingForm(init);
			return Response.json(responseBody());
		});
		const first = input(operation);
		const second = operation === 'edits'
			? String(input('edits')).replace('synthetic bytes', 'changed bytes')
			: input('generations', { prompt: 'different admitted prompt' });
		for (const body of [first, second]) {
			const response = await send(f.app, request(`/v1/images/${operation}`, body));
			assert.equal(response.status, 200, await response.text());
		}
		await drainNodeBackgroundWork();
		assert.equal(sends, 2);
		assert.equal(digests.length, 2);
		assert.match(digests[0]!, /^[0-9a-f]{64}$/);
		assert.match(digests[1]!, /^[0-9a-f]{64}$/);
		assert.notEqual(digests[0], digests[1], 'actual accepted prompt or decoded file bytes must change the digest');
	});
	it(`Images ${operation}: single grant receives the driver-prepared attempt context`, async t => {
		const contexts: Array<{ request: string; context: string; outbound: string }> = [];
		let sends = 0, settlements = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = Object.assign(
			(scope: Parameters<ImageUsageRecoveryFactory>[0]) => ({
				singleCommittedRequestGrant: true as const,
				mayHaveDispatched: false,
				async beforeSingleGrantDispatch(route: RouteResult, _attemptIndex: number,
					ticket: SingleGrantBudgetTicket, checkActive: () => void,
					preparedContext: TrustedImagePreparedAttemptContext | undefined) {
					checkActive();
					assert.ok(preparedContext);
					assert.equal(preparedContext.requestSha256, scope.requestSha256);
					assert.equal(preparedContext.operation, `images.${operation}`);
					assert.equal(preparedContext.routeIdentity.targetId, route.targetId);
					assert.equal(preparedContext.routeIdentity.providerId, route.providerId);
					assert.equal(Object.isFrozen(preparedContext), true);
					contexts.push({ request: preparedContext.requestSha256,
						context: preparedContext.contextSha256,
						outbound: preparedContext.outboundPayloadSha256 });
					await ticket.markAfterCommittedClaim();
				},
				async persist() { settlements++; return async () => {}; },
			}),
			{ requiresTrustedIngressDigest: true as const, requiresTrustedAttemptContext: true as const },
		);
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			if (operation === 'edits') await outgoingForm(init);
			return Response.json(responseBody());
		});
		const first = input(operation);
		const second = operation === 'edits'
			? String(input('edits')).replace('synthetic bytes', 'changed bytes')
			: input('generations', { prompt: 'different driver payload' });
		for (const body of [first, second]) {
			const response = await send(f.app, request(`/v1/images/${operation}`, body));
			assert.equal(response.status, 200, await response.text());
		}
		await drainNodeBackgroundWork();
		assert.equal(sends, 2);
		assert.equal(settlements, 2);
		assert.equal(contexts.length, 2);
		for (const value of contexts) {
			assert.match(value.request, /^[a-f0-9]{64}$/);
			assert.match(value.context, /^[a-f0-9]{64}$/);
			assert.match(value.outbound, /^[a-f0-9]{64}$/);
		}
		assert.notEqual(contexts[0]!.context, contexts[1]!.context);
		assert.notEqual(contexts[0]!.outbound, contexts[1]!.outbound);
		assert.equal(f.batches(), 0);
	});

	it(`Images ${operation}: a declared single committed grant treats the first 503 as unknown without replay`, async t => {
		let granted = false, grants = 0, sends = 0, settlements = 0;
		const dispatchOrder: string[] = [];
		let settledRoute: string | null | undefined, settledStatus: string | undefined;
		let settledUsage: unknown, settledUpstreamRequestId: string | null | undefined;
		const attemptedTargets: string[] = [];
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			get mayHaveDispatched() { return granted; },
			async beforeSingleGrantDispatch(route, attemptIndex, ticket, checkActive) {
				attemptedTargets.push(route.targetId);
				assert.equal(attemptIndex, 1);
				checkActive();
				dispatchOrder.push('claim_ack');
				await ticket.markAfterCommittedClaim();
				dispatchOrder.push('budget_dispatched');
				granted = true;
				grants++;
			},
			async persist(params) {
				settlements++;
				settledRoute = params.routeTargetId;
				settledStatus = params.status;
				settledUsage = params.imageUsage;
				settledUpstreamRequestId = params.upstreamRequestId;
				return async () => {};
			},
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			dispatchOrder.push('fetch');
			if (operation === 'edits') await outgoingForm(init);
			return Response.json({ error: { message: 'first synthetic provider unavailable' } }, {
				status: 503, headers: { 'X-Request-Id': 'first-upstream-request' },
			});
		});
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		const body = await response.text();
		assert.equal(response.status, 503, body);
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'upstream.server_error');
		assert.match(body, /"outcome_unknown":true/);
		assert.match(body, /"retry_safe":false/);
		await drainNodeBackgroundWork();
		assert.equal(grants, 1);
		assert.equal(sends, 1);
		assert.deepEqual(dispatchOrder, ['claim_ack', 'budget_dispatched', 'fetch']);
		assert.equal(attemptedTargets.length, 1);
		assert.equal(settlements, 1);
		assert.equal(settledRoute, attemptedTargets[0]);
		assert.equal(settledStatus, 'error');
		assert.equal(settledUsage, null, 'an ambiguous non-2xx has no confirmed image result');
		assert.equal(settledUpstreamRequestId, 'first-upstream-request');
		assert.equal(f.batches(), 0, 'the synthetic recovery path bypasses legacy writes');
	});
	it(`Images ${operation}: a committed single grant cannot fall back to legacy settlement`, async t => {
		let sends = 0, settlements = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			async beforeSingleGrantDispatch(_route, _attemptIndex, ticket) {
				await ticket.markAfterCommittedClaim();
			},
			async persist() { settlements++; return async () => {}; },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			if (operation === 'edits') await outgoingForm(init);
			return Response.json(responseBody());
		});
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 200, await response.text());
		await drainNodeBackgroundWork();
		assert.equal(sends, 1);
		assert.equal(settlements, 1);
		assert.equal(f.batches(), 0, 'a successful single grant owns the sole settlement path');
	});
	it(`Images ${operation}: all circuits open keeps the pre-claim error without settlement`, async t => {
		let sends = 0, decisions = 0, settlements = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			async beforeSingleGrantDispatch() { decisions++; throw new Error('Unexpected claim'); },
			async persist() { settlements++; throw new Error('Unexpected settlement'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		markProviderFailure('provider-0', 'auth');
		markProviderFailure('provider-1', 'auth');
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 429, await response.text());
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'circuit.upstream_capacity_exhausted');
		assert.equal(decisions, 0);
		assert.equal(sends, 0);
		assert.equal(settlements, 0);
		assert.equal(f.batches(), 0);
	});
	it(`Images ${operation}: recovery without the single-grant capability retains ordinary failover`, async t => {
		let granted = false, sends = 0, settlements = 0;
		const attemptedTargets: string[] = [];
		let settledRoute: string | null | undefined;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			// Like D1, this per-attempt recovery does not advertise a request-wide grant.
			get mayHaveDispatched() { return granted; },
			async beforeDispatch(route, attemptIndex, admit, checkActive) {
				assert.equal(attemptIndex, attemptedTargets.length + 1);
				attemptedTargets.push(route.targetId);
				checkActive();
				await admit();
				granted = true;
			},
			async persist(params) {
				settlements++;
				settledRoute = params.routeTargetId;
				return async () => {};
			},
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			if (operation === 'edits') await outgoingForm(init);
			return sends === 1
				? Response.json({ error: { message: 'first synthetic rejection' } }, { status: 401 })
				: Response.json(responseBody());
		});
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 200, await response.text());
		await drainNodeBackgroundWork();
		assert.equal(sends, 2);
		assert.equal(attemptedTargets.length, 2);
		assert.notEqual(attemptedTargets[0], attemptedTargets[1]);
		assert.equal(settlements, 1);
		assert.equal(settledRoute, attemptedTargets[1]);
		assert.equal(f.batches(), 0);
	});
	it(`Images ${operation}: a missing durable grant callback fails before fetch`, async t => {
		let sends = 0, settlements = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			beforeSingleGrantDispatch: undefined as never,
			async persist() { settlements++; throw new Error('Unexpected settlement'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 500);
		assert.equal(await response.text(), 'Test app unhandled error');
		assert.equal(sends, 0);
		assert.equal(settlements, 0);
		assert.equal(f.batches(), 0);
	});
	
	it(`Images ${operation}: definitive no-claim releases admission and never fetches`, async t => {
		let decisions = 0, sends = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			async beforeSingleGrantDispatch(_route, attemptIndex, ticket, checkActive) {
				decisions++;
				assert.equal(attemptIndex, 1);
				checkActive();
				await ticket.releaseAfterDefiniteNoClaim();
				throw Object.assign(new Error('Image dispatch ownership not granted'),
					{ name: 'PostgresImageDispatchNotGrantedError' });
			},
			async persist() { throw new Error('Unexpected settlement after denied claim'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable');
		const metadata = (await response.json() as { error: { metadata: {
			request_id: string; outcome_unknown: boolean; retry_safe: boolean;
		} } }).error.metadata;
		assert.match(metadata.request_id, /^gen-[0-9a-f-]+$/);
		assert.equal(metadata.outcome_unknown, false);
		assert.equal(metadata.retry_safe, true);
		assert.equal(decisions, 1, 'denial cannot enter a second selected route');
		assert.equal(sends, 0);
		assert.equal(f.batches(), 0);
	});

	it(`Images ${operation}: an unresolved single-grant callback fails closed before fetch`, async t => {
		let decisions = 0, sends = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			async beforeSingleGrantDispatch() { decisions++; },
			async persist() { throw new Error('Unexpected settlement after unresolved claim'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable');
		assert.equal(decisions, 1);
		assert.equal(sends, 0);
		assert.equal(f.batches(), 0);
	});

	it(`Images ${operation}: a throw after the committed mark keeps the claim outcome conservative`, async t => {
		let decisions = 0, sends = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			async beforeSingleGrantDispatch(_route, _attemptIndex, ticket) {
				decisions++;
				await ticket.markAfterCommittedClaim();
				throw new Error('Synthetic post-mark failure');
			},
			async persist() { throw new Error('Unexpected settlement after post-mark failure'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable');
		assert.equal(decisions, 1);
		assert.equal(sends, 0);
		assert.equal(f.batches(), 0);
	});

	it(`Images ${operation}: cancellation after a committed mark keeps the outcome non-retryable`, async t => {
		const parent = new AbortController();
		let sends = 0, settlements = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			mayHaveDispatched: false,
			async beforeSingleGrantDispatch(_route, _attemptIndex, ticket) {
				await ticket.markAfterCommittedClaim();
				parent.abort('PRIVATE_DETAIL');
			},
			async persist() { settlements++; throw new Error('Unexpected settlement'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation), parent.signal));
		const body = await response.json() as { error?: { metadata?: Record<string, unknown> } };
		assert.equal(response.status, 503);
		assert.equal(body.error?.metadata?.outcome_unknown, true);
		assert.equal(body.error?.metadata?.retry_safe, false);
		assert.equal(sends, 0);
		assert.equal(settlements, 0);
		assert.equal(f.batches(), 0);
	});

	it(`Images ${operation}: uncertain PostgreSQL claim ACK returns non-retryable 503 without fetch or failover`, async t => {
		let claimCalls = 0, persistCalls = 0, sends = 0;
		const attemptedTargets: string[] = [];
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			singleCommittedRequestGrant: true,
			get mayHaveDispatched() { return true; },
			async beforeSingleGrantDispatch(route, attemptIndex, ticket, checkActive) {
				claimCalls++;
				attemptedTargets.push(route.targetId);
				assert.equal(attemptIndex, 1);
				checkActive();
				ticket.holdAfterUncertainClaim();
				// An ACK may be lost after COMMIT, but no grant reached the caller.
				throw new PostgresDispatchClaimUncertainError();
			},
			async persist() { persistCalls++; throw new Error('Unexpected settlement after uncertain claim'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		const body = await response.json() as { error?: { metadata?: Record<string, unknown> } };
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable');
		assert.equal(body.error?.metadata?.request_id, response.headers.get('X-Generation-Id'));
		assert.equal(body.error?.metadata?.outcome_unknown, true);
		assert.equal(body.error?.metadata?.retry_safe, false);
		assert.doesNotMatch(JSON.stringify(body), /PostgresDispatchClaimUncertainError|Dispatch claim acknowledgement|synthetic-provider-key/);
		await drainNodeBackgroundWork();
		assert.equal(claimCalls, 1);
		assert.equal(attemptedTargets.length, 1, 'no second route admission');
		assert.equal(sends, 0, 'no provider fetch before confirmed grant');
		assert.equal(persistCalls, 0, 'no legacy settlement fallback');
		assert.equal(f.batches(), 0, 'no legacy request log or charge');
	});
	it(`Images ${operation}: other recovery errors retain the existing error path`, async t => {
		let claims = 0, sends = 0;
		const recoveryFactory: ImageUsageRecoveryFactory = () => ({
			mayHaveDispatched: true,
			async beforeDispatch() { claims++; throw new Error('Other recovery failure'); },
			async persist() { throw new Error('Unexpected settlement'); },
		});
		const f = await fixture(t, operation, 'synthetic-provider-key', { recoveryFactory });
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json(responseBody()); });
		const response = await send(f.app, request(`/v1/images/${operation}`, input(operation)));
		assert.equal(response.status, 500);
		assert.equal(await response.text(), 'Test app unhandled error');
		assert.equal(claims, 1);
		assert.equal(sends, 0);
	});
}

it('Images generations: an unsupported recovery stream fails closed before fetch by default', async t => {
	let constructed = 0, sends = 0;
	const recoveryFactory: ImageUsageRecoveryFactory = () => {
		constructed++;
		throw new Error('Unsupported recovery must not be constructed');
	};
	const f = await fixture(t, 'generations', 'synthetic-provider-key', { recoveryFactory });
	t.mock.method(globalThis, 'fetch', async () => { sends++; throw new Error('Unsupported stream must not fetch'); });
	const response = await send(f.app, request('/v1/images/generations', input('generations', { stream: true })));
	assert.equal(response.status, 503);
	assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable');
	assert.equal(constructed, 0);
	assert.equal(sends, 0);
	assert.equal(f.batches(), 0);
});

it('Images generations: an explicit legacy recovery factory retains SSE fallback', async t => {
	let constructed = 0, sends = 0;
	const recoveryFactory: ImageUsageRecoveryFactory = Object.assign(
		() => {
			constructed++;
			throw new Error('Non-streaming recovery must not be constructed for SSE');
		},
		{ allowLegacyStreamingFallback: true as const },
	);
	const f = await fixture(t, 'generations', 'synthetic-provider-key', { recoveryFactory });
	t.mock.method(globalThis, 'fetch', async () => {
		sends++;
		return new Response('data: {"type":"image_generation.completed","b64_json":"AQID"}\n\ndata: [DONE]\n\n', {
			headers: { 'Content-Type': 'text/event-stream' },
		});
	});
	const response = await send(f.app, request('/v1/images/generations', input('generations', { stream: true })));
	const body = await response.text();
	assert.equal(response.status, 200, body);
	await drainNodeBackgroundWork();
	assert.equal(constructed, 0);
	assert.equal(sends, 1);
	assert.equal(f.batches(), 1);
});
