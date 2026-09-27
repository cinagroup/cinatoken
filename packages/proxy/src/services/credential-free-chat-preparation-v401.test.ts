import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequestDeadline, type EffectiveGuardrailRow, type GatewayRepositories, type StorageContext, type RequestPresetWithVersionRow } from '@octafuse/core';
import { prepareCredentialFreeChatV401, validateCredentialFreeChatIngressProfileV401,
	type CredentialFreeChatAuthenticatedV401, type CredentialFreeChatPreparationInputV401 } from './credential-free-chat-preparation-v401';
import { recordClientErrorCircuitTrigger, resetUserModelCircuitStateForTests } from './user-model-circuit-breaker';

const body = () => ({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function effective(config: Record<string, unknown>): EffectiveGuardrailRow {
	return { id: 'guardrail-1', workspace_id: 'ws-1', owner_user_id: 'user-1', name: 'Test', description: null,
		status: 'active', designated_version: 1, latest_version: 1, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
		version_id: 'version-1', version_config_json: JSON.stringify(config), version_created_by_user_id: 'user-1', version_created_at: '2026-09-01T00:00:00.000Z',
		assignment_id: 'assignment-1', assignment_scope_type: 'user', assignment_scope_id: 'user-1' };
}
function preset(config: Record<string, unknown>): RequestPresetWithVersionRow {
	return { id: 'preset-1', workspace_id: 'ws-1', owner_user_id: 'user-1', slug: 'coding', name: 'Test', description: null,
		visibility: 'private', status: 'active', designated_version: 1, latest_version: 1, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
		version_id: 'version-1', version_system_prompt: 'Be precise.', version_config_json: JSON.stringify(config),
		version_created_by_user_id: 'user-1', version_created_at: '2026-09-01T00:00:00.000Z' };
}
function fixture(value: unknown = body(), options: { policy?: Record<string, unknown>; preset?: RequestPresetWithVersionRow | null;
	onAudit?: () => Promise<void>; onPolicy?: () => Promise<void>; headers?: Headers } = {}) {
	const calls: Array<{ name: string; args: unknown[] }> = [], audits: unknown[] = [];
	const allowed = {
		client: { driver: 'postgres', raw: { unsafe: async (sql: string, args: unknown[]) => {
			assert.match(sql, /^SELECT[\s\S]*FROM cinatoken_gateway\.workspace_budgets/u);
			calls.push({ name: 'workspace-budget-read', args }); return [];
		} }, drizzle: {} },
		requestPresets: { getAccessibleBySlug: async (...args: unknown[]) => { calls.push({ name: 'preset', args }); return options.preset ?? null; } },
		guardrails: { getEffectiveForRequest: async (...args: unknown[]) => { calls.push({ name: 'policy', args }); await options.onPolicy?.(); return options.policy ? [effective(options.policy)] : []; } },
		apiKeys: { getApiKeyByIdInWorkspace: async (...args: unknown[]) => { calls.push({ name: 'key-policy', args }); return {
			id: 'key-1', user_id: 'user-1', workspace_id: 'ws-1', status: 'active', limit_micros: null, limit_reset: null, limit_epoch: 5,
			include_byok_in_limit: false, created_at: '2026-09-01T00:00:00.000Z',
		}; } },
		userAuditLogs: { insertUserAuditLog: async (audit: unknown) => { audits.push(audit); await options.onAudit?.(); } },
	};
	const repositories = new Proxy(allowed, { get(target, key) {
		if (!(key in target)) throw new Error(`Forbidden legacy repository: ${String(key)}`);
		return Reflect.get(target, key);
	} }) as unknown as GatewayRepositories;
	const authenticated = { keyId: 'key-1', userId: 'user-1', workspaceId: 'ws-1', budgetEpoch: 4, keyLimitEpoch: 5,
		budgetMax: 10, budgetSpent: 0, budgetPeriod: 'none', budgetResetAt: null, userEmail: null,
		includeByokInLimit: false, metadata: null, chargedCostFactors: null } satisfies CredentialFreeChatAuthenticatedV401;
	const controller = new AbortController(), deadline = createRequestDeadline(Date.now() + 60_000, controller.signal);
	const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
	const input: CredentialFreeChatPreparationInputV401 = { repositories, storage: { repositories, client: repositories.client } as StorageContext,
		authenticated, requestId: 'request-v401', originalBodyBytes: bytes, originalBodySha256: sha(bytes),
		headers: options.headers ?? new Headers(), signal: controller.signal, deadline, now: new Date('2026-09-27T00:00:00.000Z') };
	return { input, calls, audits, controller, deadline, authenticated, allowed,
		close: async () => { await deadline.drainOwnedMutations(); deadline.dispose(); } };
}

test('actual flat preparation preserves a body above 256KiB, exact hash and implicit session without a credential repository', async () => {
	const f = fixture({ ...body(), messages: [{ role: 'user', content: 'x'.repeat(300_000) }], stream: true });
	try {
		const result = await prepareCredentialFreeChatV401(f.input); assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.finalQuoteInput.originalBodySha256, sha(f.input.originalBodyBytes));
		assert.deepEqual(result.finalQuoteInput.modelIds, ['model-a']);
		assert.equal(JSON.parse(result.finalQuoteInput.finalBodyUtf8).messages[0].content.length, 300_000);
		assert.equal(result.sessionRouting.stickySource, 'messages'); assert.equal(result.sessionRouting.stickyKeyDigest?.length, 64);
		assert.deepEqual(result.guardrailIntents, []); assert.ok(Object.isFrozen(result.finalQuoteInput));
		assert.deepEqual(f.calls.map(c => c.name), ['policy', 'key-policy', 'workspace-budget-read']);
	} finally { await f.close(); }
});

test('actual preset, model policy, redaction, budget intent and body session produce one immutable final snapshot', async () => {
	const f = fixture({ ...body(), model: '@preset/coding', session_id: 'body-session' }, {
		preset: preset({ model: 'model-a', models: ['model-b'], temperature: 0.2 }),
		policy: { allowed_models: ['model-a'], input_filters: [{ id: 'greeting', pattern: 'hello', action: 'redact' }], budget: { limit: 2, period: 'daily' } },
		headers: new Headers({ 'x-session-id': 'header-session' }),
	});
	try {
		const result = await prepareCredentialFreeChatV401(f.input); assert.equal(result.ok, true); if (!result.ok) return;
		const final = JSON.parse(result.finalQuoteInput.finalBodyUtf8);
		assert.equal(final.preset, undefined); assert.equal(final.session_id, undefined);
		assert.equal(final.messages[0].role, 'system'); assert.equal(final.messages[0].content, 'Be precise.');
		assert.notEqual(final.messages[1].content, 'hello'); assert.deepEqual(final.models, ['model-a']);
		assert.equal(result.sessionRouting.sessionId, 'body-session'); assert.equal(result.sessionRouting.source, 'body');
		assert.equal(result.guardrailIntents.length, 1); assert.equal(result.guardrailIntents[0]!.scopeId, 'user-1');
		assert.equal(result.guardrailIntents[0]!.periodStart, '2026-09-27T00:00:00.000Z');
		assert.ok(Object.isFrozen(result.guardrailIntents[0])); assert.equal(f.audits.length, 1);
		assert.deepEqual(f.calls[0]!.args, ['coding', 'ws-1', 'user-1']);
	} finally { await f.close(); }
});

test('pre-auth profile rejects credential controls, unknown/structured/multimodal fields and metadata without repositories', () => {
	for (const value of [
		{ ...body(), provider: {} }, { ...body(), providers: [] }, { ...body(), tools: [] }, { ...body(), output: 'text' },
		{ ...body(), prompt_cache_key: 'cache' }, { ...body(), service_tier: 'priority' }, { ...body(), extra: true },
		{ ...body(), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
		{ ...body(), messages: [{ role: ['user'], content: 'hello' }] }, { ...body(), messages: [{ role: 'user', content: 'hello', name: 'unsafe' }] },
	]) {
		const result = validateCredentialFreeChatIngressProfileV401({ originalBodyBytes: new TextEncoder().encode(JSON.stringify(value)), headers: new Headers() });
		assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'unsupported_profile');
	}
	for (const name of ['x-openrouter-metadata', 'x-openrouter-experimental-metadata']) {
		const result = validateCredentialFreeChatIngressProfileV401({ originalBodyBytes: new TextEncoder().encode(JSON.stringify(body())), headers: new Headers({ [name]: 'enabled' }) });
		assert.equal(result.ok, false);
	}
});

test('lexical byte/depth/node/property-name limits reject before native graph allocation, including overwritten keys', () => {
	for (const raw of [' '.repeat(1_048_577), '{"discard":' + '['.repeat(17) + '0' + ']'.repeat(17) + ',"discard":0}',
		'{"discard":[' + '0,'.repeat(16_384) + '0],"discard":0}', '{"' + 'x'.repeat(129) + '":0}']) {
		const result = validateCredentialFreeChatIngressProfileV401({ originalBodyBytes: new TextEncoder().encode(raw), headers: new Headers() });
		assert.equal(result.ok, false); if (!result.ok) assert.equal(result.status, 413);
	}
	for (const bytes of [new TextEncoder().encode('{'), new Uint8Array([0xff])]) {
		const result = validateCredentialFreeChatIngressProfileV401({ originalBodyBytes: bytes, headers: new Headers() });
		assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'invalid_json');
	}
});

test('unsupported actual preset transforms reject before Guardrail; no old plan is available', async () => {
	for (const config of [{ provider: { only: ['private'] } }, { tools: [{ type: 'function', function: { name: 'tool' } }] }]) {
		const f = fixture({ ...body(), preset: 'coding' }, { preset: preset(config) });
		try { const result = await prepareCredentialFreeChatV401(f.input); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'unsupported_profile'); assert.deepEqual(f.calls.map(c => c.name), ['preset']); }
		finally { await f.close(); }
	}
});

test('actual Guardrail provider and ZDR controls reject final profile; output filters reject before financial owners', async () => {
	for (const policy of [{ allowed_providers: ['private'] }, { require_zdr: true }, { output_filters: [{ id: 'secret', pattern: 'secret', action: 'block' }] }]) {
		const f = fixture(body(), { policy });
		try { const result = await prepareCredentialFreeChatV401(f.input); assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.code, 'unsupported_profile'); assert.equal(result.status, 'output_filters' in policy ? 403 : 400); } }
		finally { await f.close(); }
	}
});

test('Guardrail blocking returns only its failure; metadata is rejected before any policy/credential diagnostics', async () => {
	const policy = { input_filters: [{ id: 'secret', pattern: 'hello', action: 'block' }] };
	const f = fixture(body(), { policy });
	try { const result = await prepareCredentialFreeChatV401(f.input); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'guardrail_blocked'); assert.equal(f.audits.length, 1); assert.deepEqual(f.calls.map(c => c.name), ['policy']); }
	finally { await f.close(); }
	const metadata = fixture(body(), { policy, headers: new Headers({ 'x-openrouter-metadata': 'enabled' }) });
	try { const result = await prepareCredentialFreeChatV401(metadata.input); assert.equal(result.ok, false); assert.equal(metadata.calls.length, 0); assert.equal(metadata.audits.length, 0); }
	finally { await metadata.close(); }
});

test('actual audit remains caller-owned and awaited when cancellation arrives during its write', async () => {
	const entered = deferred(), release = deferred();
	const f = fixture(body(), { policy: { input_filters: [{ id: 'greeting', pattern: 'hello', action: 'redact' }] },
		onAudit: async () => { entered.resolve(); await release.promise; } });
	try {
		let finished = false, drained = false;
		const pending = prepareCredentialFreeChatV401(f.input); void pending.then(() => { finished = true; }, () => { finished = true; });
		await entered.promise; f.controller.abort();
		const drain = f.deadline.drainOwnedMutations().then(() => { drained = true; });
		await Promise.resolve(); assert.equal(finished, false); assert.equal(drained, false);
		release.resolve(); await assert.rejects(pending); await drain; assert.equal(drained, true); assert.equal(f.audits.length, 1);
		assert.equal(f.calls.some(c => c.name === 'key-policy'), false);
	} finally { release.resolve(); await f.close(); }
});

test('cancelled read cannot resume into a late unowned audit', async () => {
	const entered = deferred(), release = deferred();
	const f = fixture(body(), { policy: { input_filters: [{ id: 'greeting', pattern: 'hello', action: 'redact' }] },
		onPolicy: async () => { entered.resolve(); await release.promise; } });
	try { const pending = prepareCredentialFreeChatV401(f.input); await entered.promise; f.controller.abort(); await assert.rejects(pending); release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.audits.length, 0); }
	finally { release.resolve(); await f.close(); }
});

test('original bytes/hash, identity, headers/time and permitted repository methods are captured before awaits', async () => {
	const f = fixture({ ...body(), preset: 'coding' }, { preset: preset({ temperature: 0.2 }),
		policy: { budget: { limit: 2, period: 'daily' } }, headers: new Headers({ 'x-session-id': 'session-original' }) });
	try {
		const originalHash = f.input.originalBodySha256;
		const pending = prepareCredentialFreeChatV401(f.input);
		f.input.originalBodyBytes.fill(0); f.input.headers.set('x-session-id', 'changed'); f.authenticated.userId = 'changed';
		f.allowed.requestPresets.getAccessibleBySlug = async () => { throw new Error('Caller replaced preset reader'); };
		f.allowed.client.driver = 'd1';
		f.input.now!.setUTCFullYear(2030);
		const result = await pending; assert.equal(result.ok, true); if (!result.ok) return;
		assert.equal(result.finalQuoteInput.originalBodySha256, originalHash); assert.equal(result.sessionRouting.sessionId, 'session-original');
		assert.deepEqual(f.calls[0]!.args, ['coding', 'ws-1', 'user-1']); assert.deepEqual(f.calls.find(c => c.name === 'policy')!.args, ['ws-1', 'user-1', 'key-1']);
		assert.equal(result.guardrailIntents[0]!.periodStart, '2026-09-27T00:00:00.000Z');
	} finally { await f.close(); }
});

test('wrong original hash or mismatched storage fails without preparation repository reads', async () => {
	const f = fixture();
	try { await assert.rejects(prepareCredentialFreeChatV401({ ...f.input, originalBodySha256: '0'.repeat(64) }), /hash differs/u); assert.equal(f.calls.length, 0);
		await assert.rejects(prepareCredentialFreeChatV401({ ...f.input, storage: { ...f.input.storage, client: {} } as StorageContext }), /contract invalid/u); }
	finally { await f.close(); }
});

test('actual user-model circuit rejects any final candidate before quote, and clears only through its existing authority', async () => {
	resetUserModelCircuitStateForTests(); recordClientErrorCircuitTrigger('user-1', 'model-b');
	const f = fixture({ ...body(), models: ['model-b'] });
	try { const result = await prepareCredentialFreeChatV401(f.input); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'user_model_circuit_open'); }
	finally { resetUserModelCircuitStateForTests(); await f.close(); }
});
