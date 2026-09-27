import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { prepareCredentialFreeRouteAttemptsV398 } from './credential-free-route-attempts-v398';
import type { CredentialFreeRoutingProjectionV396, CredentialFreeRoutingRouteV396 } from './postgres-complete-text-routing-projection-v396';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';
import { markProviderFailure, resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { buildRouteAttemptPlan } from './route-attempt-planner';
import { buildAffinityKey, buildTierKeyPrefix, resetWeightedRoundRobinStateForTests } from './route-strategies';
import { isDefaultEndpointRouteEligible } from './provider-routing-preferences';
import type { StickyRoutingPorts } from './provider-sticky-routing';

const now = 1_800_000_000_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function route(id: string, overrides: Partial<CredentialFreeRoutingRouteV396> = {}): CredentialFreeRoutingRouteV396 {
	return { targetId: id, providerId: `provider-${id}`, routePoolId: 'pool', routePriority: 10,
		routeWeight: 1, sourceGeneration: '1', attestedSourceSha256: sha(id), endpointId: `endpoint-${id}`,
		endpointClass: 'standard', defaultEndpointEligible: true, maxCompletionTokens: 100,
		priceScore: null, beneficialCacheReadPricing: true, ...overrides };
}
function fixture(count = 1) {
	const modelIds = Array.from({ length: count }, (_, index) => `model-${index}`);
	const finalBodyUtf8 = JSON.stringify({ model: modelIds[0], models: modelIds,
		messages: [{ role: 'user', content: 'hello' }], max_tokens: 50 });
	const finalQuoteInput: FinalChatQuoteSnapshot = Object.freeze({ requestId: 'request', originalBodySha256: sha('ingress'),
		finalBodyUtf8, finalBodySha256: sha(finalBodyUtf8), modelIds: Object.freeze(modelIds) });
	const projection: CredentialFreeRoutingProjectionV396 = { requestId: 'request', quoteId: '11111111-1111-4111-8111-111111111111',
		finalBodySha256: finalQuoteInput.finalBodySha256, modelIds, expiresAt: new Date(now + 60_000).toISOString(), routingEpoch: '1',
		candidates: modelIds.map((modelId, candidateIndex) => ({ candidateIndex, modelId, routeGroup: 'default', requestProtocol: 'openai',
			requestOperation: 'chat', surface: null, strategy: { base: 'weight_priority', tierOverrides: [] },
			routes: [route(`${candidateIndex}-a`), route(`${candidateIndex}-b`, { routeWeight: 3 })] })) };
	return { projection, finalQuoteInput, identity: { userId: 'user', workspaceId: 'workspace' }, now,
		createStickyPorts: () => ports(async () => null) };
}
function ports(getBinding: StickyRoutingPorts['routePoolSticky']['getBinding']): StickyRoutingPorts {
	return { routePoolSticky: { getBinding, tryBind: async () => { throw new Error('preparation cannot write'); },
		touchBinding: async () => { throw new Error('preparation cannot write'); }, clearBinding: async () => { throw new Error('preparation cannot write'); } } };
}
beforeEach(() => { resetProviderCircuitStateForTests(); resetWeightedRoundRobinStateForTests(); });

test('prepares all eight candidates and preserves actual priority/tier strategy order', async () => {
	const params = fixture(8);
	const result = await prepareCredentialFreeRouteAttemptsV398(params);
	assert.equal(result.candidates.length, 8);
	for (const [index, candidate] of result.candidates.entries()) {
		const source = params.projection.candidates[index]!;
		const expected = buildRouteAttemptPlan(source.routes, { affinityKey: buildAffinityKey('user', source.modelId, 'default', 'openai'),
			tierKeyPrefix: buildTierKeyPrefix(source.modelId, 'default', 'openai') }, 'weight_priority', now);
		assert.deepEqual(candidate.attempts.map(r => r.targetId), expected.attempts.map(r => r.targetId));
		assert.equal(candidate.candidateIndex, index);
	}
});

test('default endpoint attestation preserves standard and unclassified variant rules', async () => {
	assert.equal(isDefaultEndpointRouteEligible({ endpoint: { selectorSlug: 'vendor/turbo', endpointClass: null } }), false);
	assert.equal(isDefaultEndpointRouteEligible({ endpoint: { selectorSlug: 'vendor', endpointClass: null } }), true);
	assert.equal(isDefaultEndpointRouteEligible({ endpoint: { selectorSlug: 'vendor/turbo', endpointClass: 'standard' } }), true);
	const params = fixture();
	(params.projection.candidates[0] as any).routes = [route('unclassified', { endpointClass: null, defaultEndpointEligible: false }),
		route('base', { endpointClass: null }), route('tier', { endpointClass: 'service_tier', defaultEndpointEligible: false })];
	const result = await prepareCredentialFreeRouteAttemptsV398(params);
	assert.deepEqual(result.candidates[0]!.attempts.map(r => r.targetId), ['base']);
});

test('inverse-square default load balancing precedes configured strategy', async () => {
	const params = fixture();
	(params.projection.candidates[0] as any).routes = [route('expensive', { routeWeight: 100, priceScore: 9 }), route('cheap', { priceScore: 1 })];
	const result = await prepareCredentialFreeRouteAttemptsV398({ ...params, randomUnit: () => 0.9 });
	assert.deepEqual(result.candidates[0]!.attempts.map(r => r.targetId), ['cheap', 'expensive']);
});

test('circuit hard skip and Retry-After remain visible without credentials', async () => {
	const params = fixture();
	markProviderFailure('provider-0-a', 'rate_limit', 5000, now);
	markProviderFailure('provider-0-b', 'auth', null, now);
	const result = await prepareCredentialFreeRouteAttemptsV398(params);
	assert.equal(result.candidates[0]!.attempts.length, 0);
	assert.equal(result.candidates[0]!.skippedByCircuit, 2);
	assert.equal(result.candidates[0]!.earliestRetryAfterMs, 5000);
});

test('explicit session looks up its quote-bound legacy pool and can promote the bound route', async () => {
	const params = fixture(); let seen: any;
	const result = await prepareCredentialFreeRouteAttemptsV398({ ...params,
		sessionRouting: { sessionId: 'session', source: 'body', stickyKeyDigest: null, stickySource: null, stickySuccessPolicy: null },
		createStickyPorts: context => { seen = context; return ports(async (pool, hash) => ({ route_pool_id: pool, affinity_hash: hash,
			route_target_id: '0-a', binding_token: 'token', pool_epoch: 0, expires_at: new Date(now + 600_000).toISOString() })); } });
	assert.equal(seen.quoteId, params.projection.quoteId);
	assert.equal(seen.routePoolId, 'pool');
	assert.equal(seen.sessionControlled, true);
	assert.equal(seen.successPolicy, 'stream_success');
	assert.equal(seen.affinityHash.length, 64);
	assert.deepEqual(result.candidates[0]!.attempts.map(r => r.targetId), ['0-a', '0-b']);
	assert.equal(result.candidates[0]!.stickySession!.config.idleTtlSeconds, 600);
});

test('implicit prompt sticky ignores a binding whose cache pricing is not beneficial', async () => {
	const params = fixture();
	(params.projection.candidates[0] as any).routes = [route('0-a', { beneficialCacheReadPricing: false }), route('0-b')];
	const result = await prepareCredentialFreeRouteAttemptsV398({ ...params, createStickyPorts: () => ports(async (pool, hash) => ({
		route_pool_id: pool, affinity_hash: hash, route_target_id: '0-a', binding_token: 'stale', pool_epoch: 0,
		expires_at: new Date(now + 600_000).toISOString() })) });
	assert.equal(result.candidates[0]!.stickyContext!.successPolicy, 'cache_hit');
	assert.equal(result.candidates[0]!.stickySession!.lookup, 'invalid_target');
	assert.equal(result.candidates[0]!.stickySession!.staleToken, 'stale');
});

test('legacy mixed-pool sticky retains the first pool namespace and every eligible model target', async () => {
	const params = fixture(); let namespace: string | undefined;
	(params.projection.candidates[0] as any).routes = [route('0-a'), route('0-b', { routePoolId: 'other-pool', routeWeight: 1 })];
	const result = await prepareCredentialFreeRouteAttemptsV398({ ...params,
		sessionRouting: { sessionId: 'session', source: 'body', stickyKeyDigest: null, stickySource: null, stickySuccessPolicy: null },
		createStickyPorts: context => { namespace = context.routePoolId; return ports(async (pool, hash) => ({
			route_pool_id: pool, affinity_hash: hash, route_target_id: '0-b', binding_token: 'token', pool_epoch: 0,
			expires_at: new Date(now + 600_000).toISOString() })); } });
	assert.equal(namespace, 'pool');
	assert.equal(result.candidates[0]!.stickySession!.lookup, 'hit');
	assert.deepEqual(result.candidates[0]!.attempts.map(r => r.targetId), ['0-b', '0-a']);
});

test('legacy mixed-pool namespace follows default price ordering before sticky promotion', async () => {
	const params = fixture(); let namespace: string | undefined;
	(params.projection.candidates[0] as any).routes = [route('0-a', { priceScore: 9 }),
		route('0-b', { routePoolId: 'cheap-pool', priceScore: 1 })];
	const result = await prepareCredentialFreeRouteAttemptsV398({ ...params, randomUnit: () => 0.9,
		sessionRouting: { sessionId: 'session', source: 'body', stickyKeyDigest: null, stickySource: null, stickySuccessPolicy: null },
		createStickyPorts: context => { namespace = context.routePoolId; return ports(async (pool, hash) => ({
			route_pool_id: pool, affinity_hash: hash, route_target_id: '0-a', binding_token: 'token', pool_epoch: 0,
			expires_at: new Date(now + 600_000).toISOString() })); } });
	assert.equal(namespace, 'cheap-pool');
	assert.equal(result.candidates[0]!.stickySession!.lookup, 'hit');
	assert.deepEqual(result.candidates[0]!.attempts.map(r => r.targetId), ['0-a', '0-b']);
});

test('validates final body digest, ordered candidate completeness, expiry and every candidate capacity', async () => {
	for (const mutate of [
		(p: ReturnType<typeof fixture>) => { (p.projection as any).expiresAt = new Date(now).toISOString(); },
		(p: ReturnType<typeof fixture>) => { (p.projection as any).candidates = p.projection.candidates.slice(0, 1); },
		(p: ReturnType<typeof fixture>) => { (p.projection.candidates[1] as any).routes = [route('missing', { maxCompletionTokens: null })]; },
		(p: ReturnType<typeof fixture>) => { p.finalQuoteInput = Object.freeze({ ...p.finalQuoteInput, finalBodyUtf8: p.finalQuoteInput.finalBodyUtf8.replace('hello', 'changed') }); },
	]) {
		const params = fixture(2); mutate(params);
		await assert.rejects(prepareCredentialFreeRouteAttemptsV398(params));
	}
});

test('captures caller fields before asynchronous work and removes unknown route fields', async () => {
	const params = fixture();
	(params.projection.candidates[0]!.routes[0] as any).providerApiKey = 'must-not-escape';
	(params.projection.candidates[0]!.routes[0] as any).providerEndpoints = { base: 'https://private.invalid' };
	const pending = prepareCredentialFreeRouteAttemptsV398(params);
	(params.projection.candidates[0]!.routes[0] as any).targetId = 'changed';
	params.identity.userId = 'changed';
	const result = await pending;
	assert.deepEqual(result.candidates[0]!.attempts.map(r => r.targetId), ['0-b', '0-a']);
	assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
	assert.equal(JSON.stringify(result).includes('private.invalid'), false);
});

test('cancellation while awaiting sticky read prevents a prepared plan', async () => {
	const params = fixture(); const controller = new AbortController();
	await assert.rejects(prepareCredentialFreeRouteAttemptsV398({ ...params, signal: controller.signal,
		createStickyPorts: () => ports(async () => { controller.abort(); return null; }) }), /stopped/u);
});

test('expiry while awaiting sticky read prevents a plan using the captured deadline', async t => {
	const params = fixture(); let clockNow = now;
	t.mock.method(Date, 'now', () => clockNow);
	let entered!: () => void, release!: () => void;
	const enteredRead = new Promise<void>(resolve => { entered = resolve; });
	const pendingRead = new Promise<void>(resolve => { release = resolve; });
	const pending = prepareCredentialFreeRouteAttemptsV398({ ...params,
		createStickyPorts: () => ports(async () => { entered(); await pendingRead; return null; }) });
	await enteredRead;
	clockNow = now + 60_000;
	(params.projection as any).expiresAt = new Date(now + 600_000).toISOString();
	release();
	await assert.rejects(pending, /Credential-free route preparation invalid/u);
});
