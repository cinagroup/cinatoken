import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import type { EffectiveGuardrailRow, GatewayRepositories, PostgresDatabaseClient, RequestPresetWithVersionRow,
	ResolvedGatewayKeyRow, StorageContext } from '@octafuse/core';
import type { RequestDeadline } from './services/request-deadline';
import { createProxyApp, type GatewayBindings, type ProxyAppOptions } from './app';
import type { CredentialFreeChatIngressCompositionV401 } from './services/credential-free-chat-ingress-v401';
import type { CredentialFreeCompleteChatPortsV400 } from './services/complete-chat-credential-free-dispatch-v400';
import { authenticatePostgresPersonalKeyV395 } from './services/postgres-personal-key-auth-v395';
import { issuePostgresCompleteChatQuoteV360, type CompleteFlatTextQuoteV360 } from './services/postgres-complete-chat-quote-v360';
import { readPostgresCompleteTextRoutingProjectionV396 } from './services/postgres-complete-text-routing-projection-v396';
import { admitPostgresCompleteChatQuoteV361 } from './services/postgres-complete-chat-admission-v361';
import { drainNodeBackgroundWork } from './runtime/schedule-background-work';
import { drainNodeResourceWork } from './runtime/schedule-resource-completion';
import { createRequestCapacityPool } from './services/request-capacity';
import { recordUserModelCircuitTrigger, resetUserModelCircuitStateForTests } from './services/user-model-circuit-breaker';

const ALIASES = ['/v1/chat/completions', '/api/v1/chat/completions'] as const;
const BEARER = 'sk-v401-synthetic-personal-key';
const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-09-27T00:00:00.000Z';
let legacyFetchCalls = 0;
const ROLES = { auth: 'cinatoken_gateway_personal_key_auth', capability: 'cinatoken_gateway_request_capability_issuer',
	quote: 'cinatoken_gateway_complete_text_quote_issuer', project: 'cinatoken_gateway_complete_text_routing_projector',
	sticky: 'cinatoken_gateway_complete_text_sticky_router', admission: 'cinatoken_gateway_budget_admission' } as const;
type Role = keyof typeof ROLES;
const connection = (role: string) => `postgres://${role}:fixture-only-password@127.0.0.1:5432/fixture?sslmode=disable`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function body(stream = false): Record<string, unknown> {
	return { model: 'model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 50, stream };
}
function policy(config: Record<string, unknown>): EffectiveGuardrailRow {
	return { id: 'guardrail', workspace_id: 'workspace', owner_user_id: 'user', name: 'Fixture policy', description: null,
		status: 'active', designated_version: 1, latest_version: 1, created_at: NOW, updated_at: NOW,
		version_id: 'version', version_config_json: JSON.stringify(config), version_created_by_user_id: 'user',
		version_created_at: NOW, assignment_id: 'assignment', assignment_scope_type: 'user', assignment_scope_id: 'user' };
}
function preset(config: Record<string, unknown>, systemPrompt: string | null = null): RequestPresetWithVersionRow {
	return { id: 'preset', workspace_id: 'workspace', owner_user_id: 'user', slug: 'fixture', name: 'Fixture', description: null,
		visibility: 'private', status: 'active', designated_version: 1, latest_version: 1, created_at: NOW, updated_at: NOW,
		version_id: 'preset-version', version_system_prompt: systemPrompt, version_config_json: JSON.stringify(config),
		version_created_by_user_id: 'user', version_created_at: NOW };
}

/** SQL replies are doubles; actual role clients, ingress, preparation and v400 dispatcher run. */
function fixture() {
	const events: string[] = [], forbidden: string[] = [], handed: Record<string, unknown>[] = [], audits: unknown[] = [];
	const state = { authStatus: 'authenticated', capabilityStatus: 'issued', capabilityKeyLimitEpoch: 8,
		roleFailure: null as null | { role: Role; at: 'commit' | 'close' },
		stickyLookup: 'disabled' as 'disabled' | 'miss' | 'hit',
		guardrails: [] as EffectiveGuardrailRow[], preset: null as RequestPresetWithVersionRow | null,
		quote: null as CompleteFlatTextQuoteV360 | null, originalBodySha256: '', expiry: new Date(Date.now() + 60_000).toISOString(),
		beforeAuth: undefined as undefined | (() => Promise<void>), beforeAudit: undefined as undefined | (() => Promise<void>),
		beforeAdmissionCommit: undefined as undefined | (() => void), holderObservedSignal: null as AbortSignal | null,
		holderUnavailable: false, holderAbort: false, cancelledBodies: 0 };
	const controller = new AbortController();
	const trap = (label: string) => (..._args: unknown[]): never => { forbidden.push(label); throw new Error(`Forbidden legacy path: ${label}`); };
	function repository(label: string, allowed: Record<string, unknown> = {}) {
		return new Proxy(allowed, { get(target, key) { return key in target ? target[String(key)] : trap(`${label}.${String(key)}`); } });
	}
	const runtimeRaw = { async unsafe(sql: string, values?: unknown[]) {
		if (sql.startsWith('SELECT current_user')) return [{ current_role: 'cinatoken_gateway_runtime', session_role: 'cinatoken_gateway_runtime' }];
		if (/FROM cinatoken_gateway\.workspace_budgets budget/.test(sql)) { events.push('workspace-budgets'); assert.deepEqual(values, ['workspace']); return []; }
		return trap(`runtime SQL ${sql.slice(0, 80)}`)();
	} };
	const client = { driver: 'postgres', raw: runtimeRaw, drizzle: repository('drizzle') } as unknown as PostgresDatabaseClient;
	const key = { id: 'key', user_id: 'user', workspace_id: 'workspace', key: BEARER, name: 'Fixture', status: 'active',
		metadata: null, last_used_at: null, created_at: NOW, updated_at: NOW, user_email: null, user_metadata: null,
		user_charged_cost_factors: null, budget_max: 1, budget_base: 1, budget_spent: 0, budget_period: 'none',
		budget_reset_at: null, budget_epoch: 7, budget_reserved_micros: 0, include_byok_in_limit: false,
		limit_micros: null, limit_epoch: 8, limit_reset: null, expires_at: null } as ResolvedGatewayKeyRow;
	const repos: Record<string, unknown> = { client,
		apiKeys: repository('apiKeys', { getApiKeyByIdInWorkspace: async (id: string, workspace: string) => {
			events.push('key-policy'); assert.equal(id, 'key'); assert.equal(workspace, 'workspace'); return key; } }),
		guardrails: repository('guardrails', { getEffectiveForRequest: async (...identity: unknown[]) => {
			events.push('guardrail'); assert.deepEqual(identity, ['workspace', 'user', 'key']); return state.guardrails; } }),
		requestPresets: repository('requestPresets', { getAccessibleBySlug: async (...identity: unknown[]) => {
			events.push('preset'); assert.deepEqual(identity, ['fixture', 'workspace', 'user']); return state.preset; } }),
		userAuditLogs: repository('userAuditLogs', { insertUserAuditLog: async (value: unknown) => {
			events.push('guardrail-audit'); audits.push(value); await state.beforeAudit?.(); } }),
	};
	for (const name of ['users', 'userBudgets', 'guardrailBudgets', 'providers', 'models', 'modelRouting', 'modelEndpoints', 'routes',
		'byokKeys', 'sharedKeys', 'requestLogs', 'routeDataPolicies', 'routePoolSticky', 'systemConfig', 'portalLedger', 'managementApiKeys']) {
		repos[name] = repository(name);
	}
	const repositories = new Proxy(repos, { get(target, key) { return key in target ? target[String(key)] : repository(String(key)); } }) as unknown as GatewayRepositories;
	const storage = { client, repositories } as StorageContext;
	function roleClient(role: Role, reply: (sql: string, values: unknown[] | undefined) => unknown) {
		const sql = { json(value: unknown) { return value; }, async unsafe(query: string, values?: unknown[]) {
			if (query.startsWith('SELECT current_user')) return [{ current_role: ROLES[role], session_role: ROLES[role],
				transaction_isolation: 'read committed', isolation: 'read committed' }];
			if (query.startsWith('SET LOCAL ')) return [];
			return [{ value: await reply(query, values) }];
		}, async begin<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
			events.push(`${role}:begin`); const value = await work(sql);
			if (role === 'admission') state.beforeAdmissionCommit?.();
			events.push(`${role}:commit`); if (state.roleFailure?.role === role && state.roleFailure.at === 'commit') throw new Error('fixture COMMIT ACK unknown'); return value;
		}, async end() { events.push(`${role}:close`); if (state.roleFailure?.role === role && state.roleFailure.at === 'close') throw new Error('fixture close ACK unknown'); } };
		return sql as unknown as PostgresDatabaseClient['raw'];
	}
	const stickyClientFactory: NonNullable<CredentialFreeChatIngressCompositionV401['stickyClientFactory']> = (url, options) => {
		assert.equal(url, connection(ROLES.sticky)); assert.deepEqual(options, { max: 1 });
		return roleClient('sticky', (sql, values) => {
			events.push('sticky:get'); assert.match(sql, /^SELECT cinatoken_gateway\.complete_text_sticky_action_v398\(/);
			assert.ok(state.quote); assert.ok(values); assert.match(String(values[6]), /^[0-9a-f]{64}$/);
			assert.deepEqual(values, [QUOTE_ID, state.quote.requestId, state.quote.finalBodySha256, '1', 0,
				'fixture-pool', values[6], true, 'stream_success', 'get', null, null, null]);
			assert.doesNotMatch(JSON.stringify(values), /fixture-session/);
			return { status: 'sticky_checked', binding: state.stickyLookup === 'hit' ? {
				route_pool_id: 'fixture-pool', affinity_hash: values[6], route_target_id: 'a-0', binding_token: 'fixture-binding', pool_epoch: 1,
				created_at: NOW, updated_at: NOW, expires_at: new Date(Date.now() + 600_000).toISOString(),
			} : null };
		});
	};
	const ports: CredentialFreeCompleteChatPortsV400 = {
		authenticate: async params => { events.push('auth');
			return authenticatePostgresPersonalKeyV395(params, url => { assert.equal(url, connection(ROLES.auth));
				return roleClient('auth', async (sql, values) => { assert.match(sql, /authenticate_personal_gateway_key_v395/); assert.deepEqual(values, [BEARER]);
					await state.beforeAuth?.();
					return state.authStatus !== 'authenticated' ? { status: state.authStatus } : { status: 'authenticated', keyId: 'key', userId: 'user', workspaceId: 'workspace',
						budgetEpoch: 7, keyLimitEpoch: 8, budgetMax: 1, budgetSpent: 0, budgetPeriod: 'none', budgetResetAt: null,
						includeByokInLimit: false, userEmail: null, keyMetadata: null, userMetadata: null, chargedCostFactors: null }; }); }); },
		issueQuote: async params => { events.push('quote'); const input = params.finalQuoteInput;
			state.originalBodySha256 = input.originalBodySha256;
			assert.equal(params.runtimeConnectionString, connection('cinatoken_gateway_runtime'));
			assert.equal(params.capabilityConnectionString, connection(ROLES.capability));
			assert.equal(params.quoteConnectionString, connection(ROLES.quote));
			const quote = { requestId: input.requestId, quoteId: QUOTE_ID, finalBodySha256: input.finalBodySha256,
				modelIds: input.modelIds, routeCount: input.modelIds.length * 2, credentialClass: 'platform' as const,
				maxPerAttemptCeilingMicros: 100, threeAttemptCeilingMicros: 300, expiresAt: state.expiry };
			state.quote = quote;
			assert.deepEqual(params.identity, { apiKeyId: 'key', userId: 'user', workspaceId: 'workspace', budgetEpoch: 7, keyLimitEpoch: 8 });
			return issuePostgresCompleteChatQuoteV360(params, {
				capability: () => roleClient('capability', (sql, values) => { assert.match(sql, /issue_request_capability_v356/);
					assert.deepEqual(values, [input.requestId, BEARER, input.originalBodySha256]);
					return state.capabilityStatus !== 'issued' ? { status: state.capabilityStatus }
						: { ...params.identity, keyLimitEpoch: state.capabilityKeyLimitEpoch, requestId: input.requestId,
							status: 'issued', capability: QUOTE_ID.repeat(2), expiresAt: state.expiry }; }),
				quote: () => roleClient('quote', (sql, values) => { assert.match(sql, /issue_complete_flat_text_quote_v360/);
					assert.deepEqual(values, [input.requestId, QUOTE_ID.repeat(2), input.originalBodySha256, input.finalBodyUtf8]);
					return { ...quote, status: 'quoted_complete_subset' }; }),
			}); },
		project: params => { events.push('project'); assert.equal(params.projectorConnectionString, connection(ROLES.project)); return readPostgresCompleteTextRoutingProjectionV396(params,
			() => roleClient('project', (sql, values) => { assert.match(sql, /project_complete_text_routing_v396/);
				assert.deepEqual(values, [params.quote.requestId, params.quote.quoteId]);
				return { status: 'routing_projected', requestId: params.quote.requestId, quoteId: params.quote.quoteId,
					finalBodySha256: params.quote.finalBodySha256, modelIds: params.quote.modelIds, expiresAt: params.quote.expiresAt, routingEpoch: '1',
					candidates: params.quote.modelIds.map((modelId, candidateIndex) => ({ candidateIndex, modelId, routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat',
						surface: state.stickyLookup === 'disabled' ? null : { id: 'fixture-surface', poolId: 'fixture-pool', match: 'exact',
							sticky: { enabled: true, idleTtlSeconds: 600, epoch: 1 } },
						strategy: { base: 'weight_priority', tierOverrides: [] }, routes: ['a', 'z'].map(target => ({ targetId: `${target}-${candidateIndex}`,
							providerId: target, routePoolId: state.stickyLookup === 'disabled' ? null : 'fixture-pool',
							routePriority: 10, routeWeight: target === 'z' ? 3 : 1, sourceGeneration: '1', attestedSourceSha256: '2'.repeat(64),
							endpointId: `endpoint-${target}`, endpointClass: 'standard', defaultEndpointEligible: true, maxCompletionTokens: 100,
							priceScore: null, beneficialCacheReadPricing: false })) })) }; })); },
		admit: params => { events.push('admit'); assert.equal(params.admissionConnectionString, connection(ROLES.admission)); return admitPostgresCompleteChatQuoteV361(params,
			() => roleClient('admission', (sql, values) => { assert.match(sql, /admit_complete_flat_text_quote_v361/);
				assert.deepEqual(values, [params.quote.requestId, params.quote.quoteId, params.guardrailIntents]);
				return { status: 'admitted', quoteId: params.quote.quoteId, finalBodySha256: params.quote.finalBodySha256,
					reservedMicros: params.quote.threeAttemptCeilingMicros, ordinary: 'reserved', guardrailCount: params.guardrailIntents.length, expiresAt: params.quote.expiresAt }; })); },
		newAttemptNonce: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	};
	const composition: CredentialFreeChatIngressCompositionV401 = {
		runtimeConnectionString: connection('cinatoken_gateway_runtime'), authConnectionString: connection(ROLES.auth),
		capabilityConnectionString: connection(ROLES.capability), quoteConnectionString: connection(ROLES.quote),
		projectorConnectionString: connection(ROLES.project), stickyConnectionString: connection(ROLES.sticky),
		admissionConnectionString: connection(ROLES.admission), ports, stickyClientFactory,
		holderBinding: { async fetch(request) { events.push('holder'); handed.push(await request.json()); state.holderObservedSignal = request.signal;
				assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
				if (state.holderAbort) controller.abort();
				if (state.holderUnavailable || state.holderAbort) return new Response(new ReadableStream({ cancel() { state.cancelledBodies++; } }),
					{ status: state.holderUnavailable ? 502 : 200, headers: { 'Content-Type': 'application/json' } });
				const stream = JSON.parse(String(handed.at(-1)?.finalBodyUtf8)).stream === true;
				return new Response(stream ? 'data: [DONE]\n\n' : '{"ok":true}', { status: 200,
					headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json', 'X-Private': 'secret-must-not-escape' } }); } },
	};
	const env: GatewayBindings = { DATABASE_DRIVER: 'postgres', HYPERDRIVE: { connectionString: composition.runtimeConnectionString },
		CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED: 'reviewed-v1', REQUEST_BODY_LOGGING: 'off' };
	let storageCalls = 0;
	const options: ProxyAppOptions = { credentialFreeChatV401: composition };
	const app = () => createProxyApp(async () => { storageCalls++; return storage; }, options);
	const request = (gateway: ReturnType<typeof createProxyApp>, path = ALIASES[0] as string, input = body(), headers: Record<string, string> = {}) =>
		gateway.request(path, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(input) }, env);
	return { app, options, composition, env, request, state, events, handed, forbidden, audits, controller, storage, repositories, key, ports,
		storageCalls: () => storageCalls, trap };
}
beforeEach(() => { resetUserModelCircuitStateForTests(); legacyFetchCalls = 0; mock.method(globalThis, 'fetch', async () => {
	legacyFetchCalls++; throw new Error('Legacy global upstream fetch is forbidden');
}); });
afterEach(async () => { await drainNodeBackgroundWork(); await drainNodeResourceWork(); mock.restoreAll(); });
const noLegacy = (f: ReturnType<typeof fixture>) => {
	assert.deepEqual(f.forbidden, [], 'no legacy auth/reset, credential plan, budget owner, dispatch or usage writer');
	assert.equal(legacyFetchCalls, 0, 'no legacy upstream HTTP fetch');
};
const noSend = (f: ReturnType<typeof fixture>) => { assert.equal(f.handed.length, 0); noLegacy(f); };

for (const path of ALIASES) for (const stream of [false, true]) test(`v401 actual Hono ${path} ${stream ? 'SSE' : 'JSON'} exclusively prepares and dispatches one six-field envelope`, async () => {
	const f = fixture(), input = body(stream), wire = JSON.stringify(input);
	const response = await f.request(f.app(), path, input);
	assert.equal(response.status, 200, JSON.stringify({ events: f.events, forbidden: f.forbidden })); assert.equal(response.headers.get('X-Private'), null);
	assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
	assert.equal(await response.text(), stream ? 'data: [DONE]\n\n' : '{"ok":true}');
	assert.equal(f.events.filter(e => e === 'auth').length, 1); assert.equal(f.events.filter(e => e === 'admit').length, 1);
	assert.equal(f.handed.length, 1); assert.equal(f.handed[0]!.routeTargetId, 'z-0');
	assert.deepEqual(Object.keys(f.handed[0]!).sort(), ['attemptNonce', 'candidateIndex', 'finalBodyUtf8', 'quoteId', 'requestId', 'routeTargetId']);
	assert.deepEqual(JSON.parse(String(f.handed[0]!.finalBodyUtf8)), { ...input, models: ['model'] });
	assert.equal(f.events.indexOf('auth:close') < f.events.indexOf('guardrail'), true);
	assert.equal(f.events.indexOf('admission:close') < f.events.indexOf('holder'), true);
	assert.equal(response.headers.get('X-Generation-Id'), f.handed[0]!.requestId);
	assert.equal(f.state.originalBodySha256, sha256(wire)); noLegacy(f);
});

for (const status of ['unauthorized', 'period_reset_pending']) test(`v401 ${status} never enters policy, quote or legacy authentication`, async () => {
	const f = fixture(); f.state.authStatus = status;
	const response = await f.request(f.app()); assert.equal(response.status, status === 'unauthorized' ? 401 : 409); await response.text();
	assert.equal(f.events.includes('guardrail'), false); assert.equal(f.events.includes('quote'), false); noSend(f);
});

test('v401 absent or unsupported Bearer namespace rejects before actual authentication', async () => {
	for (const auth of ['', 'Bearer sk-cina-mgmt-fixture-management', 'Basic fixture']) {
		const f = fixture(); const response = await f.request(f.app(), ALIASES[0], body(), { Authorization: auth });
		assert.equal(response.status, 401); await response.text(); assert.equal(f.events.includes('auth'), false); noSend(f);
	}
});

test('v401 alternate credential headers and query fields cannot invoke personal auth', async () => {
	for (const field of ['x-api-key', 'x-goog-api-key', 'api-key', 'x-cinatoken-management-key']) {
		const f = fixture(); const response = await f.request(f.app(), ALIASES[0], body(), { [field]: 'synthetic-alternate' });
		assert.equal(response.status, 401); await response.text(); assert.equal(f.events.includes('auth'), false); noSend(f);
	}
	for (const field of ['key', 'api_key', 'apiKey']) {
		const f = fixture(); const response = await f.request(f.app(), `${ALIASES[1]}?${field}=synthetic-alternate`);
		assert.equal(response.status, 401); await response.text(); assert.equal(f.events.includes('auth'), false); noSend(f);
	}
});

test('v401 invalid activation, missing composition, missing holder and D1 fail before role writes', async () => {
	for (const variant of ['activation', 'composition', 'holder', 'd1', 'role-url', 'wrong-database'] as const) {
		const f = fixture();
		if (variant === 'activation') f.env.CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED = 'true';
		if (variant === 'composition') delete f.options.credentialFreeChatV401;
		if (variant === 'holder') Object.assign(f.composition, { holderBinding: undefined });
		if (variant === 'd1') { f.env.DATABASE_DRIVER = 'd1'; Object.assign(f.storage.client, { driver: 'd1' }); }
		if (variant === 'role-url') Object.assign(f.composition, { authConnectionString: f.composition.runtimeConnectionString });
		if (variant === 'wrong-database') Object.assign(f.composition, { quoteConnectionString: f.composition.quoteConnectionString.replace('/fixture?', '/different?') });
		const response = await f.request(f.app()); assert.equal(response.status, 502, variant); await response.text();
		assert.equal(f.events.includes('auth'), false, variant); noSend(f);
	}
});

test('v401 mixed legacy producer and budget owner configuration rejects without opening either owner', async () => {
	for (const variant of ['producer-flag', 'budget-proof-flag', 'owner-flag', 'owner-factory', 'producer-option'] as const) {
		const f = fixture();
		if (variant === 'producer-flag') f.env.SHARED_KEY_QUOTE_ATTEMPTS_ENABLED = 'reviewed-v1';
		if (variant === 'budget-proof-flag') f.env.AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED = 'reviewed-v1';
		if (variant === 'owner-flag') f.env.POSTGRES_CHAT_BUDGET_OWNER_ENABLED = 'reviewed-v1';
		if (variant === 'owner-factory') f.options.chatBudgetRequestOwnerFactory = f.trap('chatBudgetRequestOwnerFactory');
		if (variant === 'producer-option') f.options.sharedKeyEconomicProducer = { recordUsageAndOutbox: f.trap('sharedKeyEconomicProducer') } as never;
		const response = await f.request(f.app()); assert.equal(response.status, 502, variant); await response.text();
		assert.equal(f.events.includes('auth'), false, variant); noSend(f);
	}
});

test('v401 metadata, provider controls and unsupported public profile reject before authentication and quote', async () => {
	for (const extra of [{ provider: { only: ['private'] } }, { tools: [] }, { response_format: { type: 'json_object' } },
		{ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, { logprobs: true }, { service_tier: 'priority' }]) {
		const f = fixture(); const response = await f.request(f.app(), ALIASES[0], { ...body(), ...extra });
		assert.equal(response.status, 400); assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.invalid_request');
		await response.text(); assert.equal(f.events.includes('auth'), false); assert.equal(f.events.includes('quote'), false); noSend(f);
	}
	for (const header of ['X-OpenRouter-Metadata', 'X-OpenRouter-Experimental-Metadata']) {
		const f = fixture(); f.state.guardrails = [policy({ allowed_models: ['different'] })];
		const response = await f.request(f.app(), ALIASES[1], body(), { [header]: 'true' });
		assert.equal(response.status, 400); await response.text(); assert.equal(f.events.includes('auth'), false); assert.equal(f.events.includes('quote'), false); noSend(f);
	}
});

test('v401 malformed, structurally excessive and oversized JSON fails before a personal-auth write', async () => {
	for (const wire of ['{invalid', JSON.stringify({ ...body(), messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }] }),
		'{"model":"model","messages":' + '['.repeat(18) + '1' + ']'.repeat(18) + '}']) {
		const f = fixture(); const response = await f.app().request(ALIASES[0], { method: 'POST',
			headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' }, body: wire }, f.env);
		assert.ok([400, 413].includes(response.status)); await response.text(); assert.equal(f.events.includes('auth'), false); noSend(f);
	}
});

test('v401 actual preset and input Guardrail transformation bind the final snapshot before quote', async () => {
	const f = fixture(); f.state.preset = preset({ model: 'model', temperature: 0.2 }, 'system instruction');
	f.state.guardrails = [policy({ input_filters: [{ id: 'hello', pattern: 'hello', action: 'redact' }] })];
	const input = { ...body(), preset: 'fixture' }; const response = await f.request(f.app(), ALIASES[1], input);
	assert.equal(response.status, 200); await response.text(); const final = JSON.parse(String(f.handed[0]!.finalBodyUtf8));
	assert.equal(final.preset, undefined); assert.equal(final.temperature, 0.2); assert.equal(final.messages[0].content, 'system instruction');
	assert.notEqual(final.messages[1].content, 'hello'); assert.equal(f.audits.length, 1); noLegacy(f);
});

test('v401 profile made unsupported by actual preset or Guardrail is rejected before quote/admission', async () => {
	for (const variant of ['preset', 'guardrail']) {
		const f = fixture(); f.state.preset = preset({ model: 'model', tools: [{ type: 'function', function: { name: 'fixture' } }] });
		if (variant === 'guardrail') f.state.guardrails = [policy({ allowed_providers: ['private'] })];
		const response = await f.request(f.app(), ALIASES[0], variant === 'preset' ? { ...body(), preset: 'fixture' } : body());
		assert.equal(response.status, 400); assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.invalid_request'); await response.text();
		assert.equal(f.events.includes(variant), true); assert.equal(f.events.includes('quote'), false); noSend(f);
	}
});

test('v401 real input block and nonempty output filters never enter credential diagnostics or response settlement', async () => {
	for (const config of [{ input_filters: [{ id: 'hello', pattern: 'hello', action: 'block' }] },
		{ output_filters: [{ id: 'secret', pattern: 'secret', action: 'block' }] }]) {
		const f = fixture(); f.state.guardrails = [policy(config)];
		const response = await f.request(f.app()); assert.equal(response.status, 403); await response.text();
		assert.equal(f.events.includes('guardrail'), true);
		assert.equal(f.events.includes('quote'), false); noSend(f);
	}
});

test('v401 actual Guardrail budget intent is enrolled once through the dedicated admission client', async () => {
	const f = fixture(); f.state.guardrails = [policy({ budget: { limit: 1, period: 'daily' } })];
	const response = await f.request(f.app()); assert.equal(response.status, 200); await response.text();
	assert.equal(f.events.filter(e => e === 'admit').length, 1); assert.equal(f.events.filter(e => e === 'admission:commit').length, 1);
	assert.equal(f.handed.length, 1); noLegacy(f);
});

test('v401 actual user-model circuit blocks the final candidate before quote enrollment', async () => {
	const f = fixture(); recordUserModelCircuitTrigger('user', 'model', 'client_error', 'private-fixture-detail');
	const response = await f.request(f.app()); assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /private-fixture-detail/);
	assert.equal(f.events.includes('guardrail'), true); assert.equal(f.events.includes('quote'), false); noSend(f);
});

test('v401 server-held auth receipt still requires actual fresh capability epoch and status checks', async () => {
	for (const stale of ['key-disabled', 'key-limit-epoch']) {
		const f = fixture();
		if (stale === 'key-disabled') f.state.capabilityStatus = 'stale'; else f.state.capabilityKeyLimitEpoch = 9;
		const response = await f.request(f.app()); assert.equal(response.status, 502); await response.text();
		assert.equal(f.events.filter(e => e === 'auth').length, 1); assert.equal(f.events.includes('capability:begin'), true);
		assert.equal(f.events.includes('quote:begin'), false); assert.equal(f.events.includes('admit'), false); noSend(f);
	}
});

for (const role of ['auth', 'capability', 'quote', 'project', 'admission'] as const) for (const at of ['commit', 'close'] as const)
test(`v401 actual ${role} ${at} ACK loss never falls back or hands off`, async () => {
	const f = fixture(); f.state.roleFailure = { role, at };
	const response = await f.request(f.app()); assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /fixture-only|ACK unknown|Forbidden legacy/);
	assert.equal(f.events.filter(e => e === `${role}:${at}`).length, 1); noSend(f);
});

for (const lookup of ['miss', 'hit'] as const) test(`v401 actual controlled-session sticky ${lookup} acknowledges before admission and selects the ${lookup === 'hit' ? 'bound' : 'ordinary'} route`, async () => {
	const f = fixture(); f.state.stickyLookup = lookup;
	const input = { ...body(), session_id: 'fixture-session' };
	const response = await f.request(f.app(), ALIASES[1], input);
	assert.equal(response.status, 200, JSON.stringify({ events: f.events, forbidden: f.forbidden })); await response.text();
	assert.deepEqual(f.events.filter(event => event.startsWith('sticky:')), ['sticky:begin', 'sticky:get', 'sticky:commit', 'sticky:close']);
	assert.equal(f.events.indexOf('sticky:close') < f.events.indexOf('admit'), true);
	assert.equal(f.handed.length, 1); assert.equal(f.handed[0]!.routeTargetId, lookup === 'hit' ? 'a-0' : 'z-0');
	assert.equal('session_id' in JSON.parse(String(f.handed[0]!.finalBodyUtf8)), false);
	assert.equal(f.state.originalBodySha256, sha256(JSON.stringify(input))); noLegacy(f);
});

for (const at of ['commit', 'close'] as const) test(`v401 actual sticky ${at} ACK loss stops before admission and ${at === 'close' ? 'retains' : 'releases'} HTTP capacity`, async () => {
	const f = fixture(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	f.options.httpCapacity = { pool, reservedBytesPerRequest: 1 };
	f.state.stickyLookup = 'miss'; f.state.roleFailure = { role: 'sticky', at };
	// Two projected candidates exercise the latched failure across a later candidate.
	const input = { ...body(), model: undefined, models: ['model', 'alternate'], session_id: 'fixture-session' };
	const gateway = f.app(), response = await f.request(gateway, ALIASES[0], input);
	assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /fixture-only|ACK unknown|Forbidden legacy/);
	assert.deepEqual(f.events.filter(event => event.startsWith('sticky:')), ['sticky:begin', 'sticky:get', 'sticky:commit', 'sticky:close']);
	assert.equal(f.events.includes('admit'), false); noSend(f);
	await drainNodeResourceWork(); assert.equal(pool.snapshot().requests, at === 'close' ? 1 : 0);
	if (at === 'close') {
		const second = await f.request(gateway); assert.equal(second.status, 503); await second.text();
		assert.equal(f.events.filter(event => event === 'auth').length, 1); assert.equal(f.storageCalls(), 1); noSend(f);
	}
});

test('v401 cancellation while auth is owned waits for client completion and never starts quote', async () => {
	const f = fixture(), entered = deferred(), release = deferred();
	f.state.beforeAuth = async () => { entered.resolve(); await release.promise; };
	const pending = f.request(f.app()); await entered.promise; f.controller.abort(); release.resolve();
	const response = await pending; assert.equal(response.status, 499); await response.text();
	assert.equal(f.events.includes('auth:begin'), true); assert.equal(f.events.includes('auth:close'), true);
	assert.equal(f.events.includes('quote'), false); noSend(f);
});

test('v401 cancellation after admission COMMIT and expiry stop the holder handoff', async () => {
	const f = fixture(); f.state.beforeAdmissionCommit = () => f.controller.abort();
	const response = await f.request(f.app()); assert.equal(response.status, 499); await response.text();
	assert.equal(f.events.includes('admission:commit'), true); noSend(f);
	const expired = fixture(); expired.state.expiry = new Date(Date.now() - 1).toISOString();
	const denied = await expired.request(expired.app()); assert.equal(denied.status, 502); await denied.text();
	assert.equal(expired.events.includes('admit'), false); noSend(expired);
});

test('v401 projection expiry after acknowledged admission prevents holder handoff', async t => {
	const f = fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now);
	f.state.beforeAdmissionCommit = () => { now = Date.parse(f.state.expiry); };
	const response = await f.request(f.app()); assert.equal(response.status, 502); await response.text();
	assert.equal(f.events.includes('admission:commit'), true); assert.equal(f.events.includes('admission:close'), true); noSend(f);
});

test('v401 captures mutable composition, ports and bindings before delayed authentication', async () => {
	const f = fixture(), entered = deferred(), release = deferred();
	f.state.beforeAuth = async () => { entered.resolve(); await release.promise; };
	const gateway = f.app(), pending = f.request(gateway); await entered.promise;
	Object.assign(f.composition, { authConnectionString: 'changed', quoteConnectionString: 'changed', holderBinding: { fetch: f.trap('changed holder') } });
	Object.assign(f.ports, { issueQuote: f.trap('changed quote port') });
	Object.assign(f.storage.client, { driver: 'd1', raw: { unsafe: f.trap('changed runtime client') } });
	f.env.CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED = 'changed'; Object.assign(f.env.HYPERDRIVE!, { connectionString: 'changed' });
	release.resolve(); const response = await pending; assert.equal(response.status, 200); await response.text();
	assert.equal(f.handed.length, 1); noLegacy(f);
});

test('v401 private holder failure or abort cancels the unhanded body and never retries', async () => {
	for (const abort of [false, true]) {
		const f = fixture(); f.state.holderUnavailable = !abort; f.state.holderAbort = abort;
		const response = await f.request(f.app()); assert.equal(response.status, abort ? 499 : 502); await response.text(); await Promise.resolve();
		assert.equal(f.handed.length, 1); assert.equal(f.state.cancelledBodies, 1); noLegacy(f);
	}
});

test('v401 retained HTTP capacity rejects before a second authentication and releases after the delivered body', async () => {
	const f = fixture(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	f.options.httpCapacity = { pool, reservedBytesPerRequest: 1 };
	const gateway = f.app(), first = await f.request(gateway);
	assert.equal(first.status, 200); assert.equal(pool.snapshot().requests, 1);
	const second = await f.request(gateway, ALIASES[1]); assert.equal(second.status, 503); await second.text();
	assert.equal(f.events.filter(e => e === 'auth').length, 1); assert.equal(f.storageCalls(), 1);
	await first.text(); await drainNodeResourceWork(); assert.equal(pool.snapshot().requests, 0); noLegacy(f);
});

test('v401 cancellation retains an owned real Guardrail audit until its write acknowledges', async () => {
	const f = fixture(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 }), entered = deferred(), release = deferred();
	f.options.httpCapacity = { pool, reservedBytesPerRequest: 1 };
	f.state.guardrails = [policy({ input_filters: [{ id: 'hello', pattern: 'hello', action: 'block' }] })];
	f.state.beforeAudit = async () => { entered.resolve(); await release.promise; };
	const gateway = f.app(), pending = f.request(gateway); await entered.promise; f.controller.abort();
	assert.equal(pool.snapshot().requests, 1);
	const second = await gateway.request(ALIASES[1], { method: 'POST', body: JSON.stringify(body()) }, f.env);
	assert.equal(second.status, 503); await second.text();
	assert.equal(f.events.filter(e => e === 'auth').length, 1); assert.equal(f.audits.length, 1);
	release.resolve(); const response = await pending; assert.equal(response.status, 499); await assert.rejects(response.text(), /delivery stopped/);
	await drainNodeResourceWork(); assert.equal(pool.snapshot().requests, 0); noSend(f);
});

test('v401 holder retains the original downstream abort signal after preparation disposes', async () => {
	const f = fixture(); const response = await f.request(f.app(), ALIASES[1], body(true)); assert.equal(response.status, 200);
	assert.equal(f.state.holderObservedSignal?.aborted, false); f.controller.abort(); assert.equal(f.state.holderObservedSignal?.aborted, true);
	await assert.rejects(response.text(), /delivery stopped/); assert.equal(f.handed.length, 1); noLegacy(f);
});

test('v401 preparation deadline aborts the pending private request before headers without retry', async t => {
	const f = fixture(), entered = deferred(), release = deferred(); let deadline: RequestDeadline | undefined;
	let now = Date.now(); t.mock.method(Date, 'now', () => now);
	f.options.beforeAll = async (c, next) => { deadline = c.get('textRequestLifecycle')!.deadline; await next(); };
	Object.assign(f.composition.holderBinding, { async fetch(request: Request) {
		f.events.push('holder'); f.handed.push(await request.json()); f.state.holderObservedSignal = request.signal;
		entered.resolve(); await release.promise;
		request.signal.throwIfAborted();
		return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
	} });
	const pending = f.request(f.app()); await entered.promise;
	try {
		now = deadline!.deadlineAtMs;
		assert.throws(() => deadline!.throwIfStopped(), /deadline exceeded/i);
		assert.equal(deadline!.signal.aborted, true); assert.equal(f.state.holderObservedSignal?.aborted, true);
	} finally { release.resolve(); }
	const response = await pending; assert.equal(response.status, 504); await response.text();
	assert.equal(f.handed.length, 1); assert.equal(f.events.filter(e => e === 'admit').length, 1); noLegacy(f);
});

for (const ack of ['resolve', 'reject'] as const) test(`v401 SSE client cancellation retains capacity until the underlying cancel ACK ${ack}s`, async t => {
	const f = fixture(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	let acknowledge!: () => void, reject!: (error: Error) => void, cancelCalls = 0, deadline: RequestDeadline | undefined;
	const pendingCancel = new Promise<void>((yes, no) => { acknowledge = yes; reject = no; });
	let now = Date.now(); t.mock.method(Date, 'now', () => now);
	f.options.httpCapacity = { pool, reservedBytesPerRequest: 1 };
	f.options.beforeAll = async (c, next) => { deadline = c.get('textRequestLifecycle')!.deadline; await next(); };
	Object.assign(f.composition.holderBinding, { async fetch(request: Request) {
		f.events.push('holder'); f.handed.push(await request.json()); f.state.holderObservedSignal = request.signal;
		return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelCalls++; return pendingCancel; } }, { highWaterMark: 0 }),
			{ headers: { 'Content-Type': 'text/event-stream' } });
	} });
	const response = await f.request(f.app(), ALIASES[1], body(true)); assert.equal(response.status, 200);
	try {
		assert.equal(f.state.holderObservedSignal?.aborted, false);
		// Headers have detached preparation's timer/signal from the holder stream.
		now = deadline!.deadlineAtMs;
		assert.throws(() => deadline!.throwIfStopped(), /deadline exceeded/i);
		assert.equal(f.state.holderObservedSignal?.aborted, false);
		f.controller.abort(); assert.equal(f.state.holderObservedSignal?.aborted, true);
		await assert.rejects(response.text(), /delivery stopped/);
		assert.equal(cancelCalls, 1); assert.equal(pool.snapshot().requests, 1);
		if (ack === 'resolve') acknowledge(); else reject(new Error('fixture cancel ACK unavailable'));
		await drainNodeResourceWork(); assert.equal(pool.snapshot().requests, ack === 'resolve' ? 0 : 1);
		assert.equal(f.handed.length, 1); noLegacy(f);
	} finally { acknowledge(); }
});

test('v401 a user-model circuit opened after admission prevents the private holder send', async () => {
	const f = fixture(); f.state.beforeAdmissionCommit = () => recordUserModelCircuitTrigger('user', 'model', 'client_error');
	const response = await f.request(f.app()); assert.equal(response.status, 502); await response.text();
	assert.equal(f.events.includes('admission:commit'), true); assert.equal(f.events.includes('admission:close'), true); noSend(f);
});

test('v401 unconfirmed dedicated close ACK retains the numeric HTTP capacity reservation', async () => {
	const f = fixture(), pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	f.options.httpCapacity = { pool, reservedBytesPerRequest: 1 }; f.state.roleFailure = { role: 'admission', at: 'close' };
	const gateway = f.app(), response = await f.request(gateway); assert.equal(response.status, 502); await response.text();
	await drainNodeResourceWork(); assert.equal(pool.snapshot().requests, 1);
	const second = await f.request(gateway); assert.equal(second.status, 503); await second.text();
	assert.equal(f.events.filter(e => e === 'auth').length, 1); noSend(f);
});

test('v401 activation affects only the two Chat POST aliases', async () => {
	const f = fixture(); let legacyLookups = 0;
	Object.assign(f.repositories.apiKeys, { getApiKeyWithUserByKey: async () => { legacyLookups++; return null; } });
	Object.assign(f.repositories.modelRouting, { listModelsWithActiveRoutes: async () => [] });
	Object.assign(f.repositories, { analytics: { queryPublicModelAnalytics: async () => [] } });
	const gateway = f.app(); const old = await f.request(gateway, '/v1/completions'); assert.equal(old.status, 401); await old.text();
	const health = await gateway.request('/health', {}, f.env); assert.equal(health.status, 200); await health.text();
	const models = await gateway.request('/api/v1/models', {}, f.env); assert.equal(models.status, 200); await models.text();
	assert.equal(legacyLookups, 1); assert.equal(f.events.includes('auth'), false); noSend(f);
});

test('v401 feature absent preserves legacy authentication and unrelated GET/Completions routes', async () => {
	const f = fixture(); delete f.env.CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED;
	let legacyLookups = 0;
	Object.assign(f.repositories.apiKeys, { getApiKeyWithUserByKey: async () => { legacyLookups++; return null; } });
	Object.assign(f.repositories.modelRouting, { listModelsWithActiveRoutes: async () => [] });
	Object.assign(f.repositories, { analytics: { queryPublicModelAnalytics: async () => [] } });
	const gateway = f.app();
	for (const path of [...ALIASES, '/v1/completions', '/api/v1/completions']) {
		const response = await f.request(gateway, path); assert.equal(response.status, 401); await response.text();
	}
	assert.equal(legacyLookups, 4); assert.equal(f.events.includes('auth'), false); noSend(f);
	const health = await gateway.request('/health', {}, f.env); assert.equal(health.status, 200); await health.text();
	const models = await gateway.request('/api/v1/models', {}, f.env); assert.equal(models.status, 200);
	assert.deepEqual(await models.json(), { data: [], total_count: 0, links: { next: null } });
	noLegacy(f);
});
