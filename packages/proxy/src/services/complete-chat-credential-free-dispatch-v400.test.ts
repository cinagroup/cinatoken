import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { createCredentialFreeCompleteChatDispatchV400,
	type CredentialFreeCompleteChatInputV400, type CredentialFreeCompleteChatPortsV400 } from './complete-chat-credential-free-dispatch-v400';
import type { CredentialFreeRoutingProjectionV396 } from './postgres-complete-text-routing-projection-v396';
import type { AuthenticatedPersonalKeyV395 } from './postgres-personal-key-auth-v395';
import { prepareCredentialFreeRouteAttemptsV398 } from './credential-free-route-attempts-v398';

function fixture(stream = false) {
	const events: string[] = [], handed: Record<string, unknown>[] = [];
	const modelIds = Object.freeze(['model']);
	const finalBodyUtf8 = JSON.stringify({ model: 'model', models: modelIds, messages: [{ role: 'user', content: 'hello' }], max_tokens: 50, stream });
	const finalBodySha256 = createHash('sha256').update(finalBodyUtf8).digest('hex');
	const expiry = new Date(Date.now() + 60_000).toISOString();
	const finalQuoteInput = Object.freeze({ requestId: 'request', originalBodySha256: '1'.repeat(64), finalBodyUtf8, finalBodySha256, modelIds });
	const authenticated: AuthenticatedPersonalKeyV395 = Object.freeze({ keyId: 'key', userId: 'user', workspaceId: 'workspace',
		budgetEpoch: 7, keyLimitEpoch: 8, userEmail: null, budgetMax: 1, budgetSpent: 0, budgetPeriod: 'none',
		budgetResetAt: null, includeByokInLimit: false, metadata: {}, chargedCostFactors: null });
	const quote = Object.freeze({ requestId: 'request', quoteId: '11111111-1111-4111-8111-111111111111', finalBodySha256,
		modelIds, routeCount: 2, credentialClass: 'platform' as const, maxPerAttemptCeilingMicros: 100,
		threeAttemptCeilingMicros: 300, expiresAt: expiry });
	const projection: CredentialFreeRoutingProjectionV396 = { ...quote, routingEpoch: '1', candidates: [{ candidateIndex: 0,
		modelId: 'model', routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat', surface: null,
		strategy: { base: 'weight_priority', tierOverrides: [] }, routes: ['a', 'z'].map(targetId => ({ targetId,
			providerId: targetId, routePoolId: null, routePriority: 10, routeWeight: targetId === 'z' ? 3 : 1,
			sourceGeneration: '1', attestedSourceSha256: '2'.repeat(64), endpointId: `endpoint-${targetId}`, endpointClass: 'standard',
			defaultEndpointEligible: true, maxCompletionTokens: 100, priceScore: null, beneficialCacheReadPricing: false })) }] };
	const admission = { status: 'admitted' as const, requestId: 'request', quoteId: quote.quoteId, finalBodySha256,
		reservedMicros: 300, ordinary: 'reserved' as const, guardrailCount: 0, expiresAt: expiry };
	const controller = new AbortController();
	const input: CredentialFreeCompleteChatInputV400 = { finalQuoteInput, bearer: 'captured-personal-bearer', guardrailIntents: [],
		runtimeClient: { driver: 'postgres' } as PostgresDatabaseClient, runtimeConnectionString: 'runtime-connection',
		authConnectionString: 'auth-connection', capabilityConnectionString: 'capability-connection', quoteConnectionString: 'quote-connection',
		projectorConnectionString: 'projector-connection', stickyConnectionString: 'sticky-connection', admissionConnectionString: 'admission-connection',
		signal: controller.signal, holderBinding: { async fetch(request) { events.push('holder'); handed.push(await request.json());
			return new Response(stream ? 'data: [DONE]\n\n' : '{"ok":true}', { status: 200,
				headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json', 'X-Private': 'must-not-escape' } }); } } };
	const ports: CredentialFreeCompleteChatPortsV400 = { authenticate: async p => { events.push('auth'); assert.equal(p.bearer, input.bearer); return authenticated; },
		issueQuote: async p => { events.push('quote'); assert.deepEqual(p.identity, { apiKeyId: 'key', userId: 'user', workspaceId: 'workspace', budgetEpoch: 7, keyLimitEpoch: 8 });
			assert.equal(Object.hasOwn(p, 'authConnectionString'), false); return quote; },
		project: async () => { events.push('project'); return projection; },
		prepare: async p => { events.push('prepare'); return prepareCredentialFreeRouteAttemptsV398(p); },
		admit: async p => { events.push('admit'); assert.equal(Object.hasOwn(p, 'stickyConnectionString'), false); return admission; },
		newAttemptNonce: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
	return { input, ports, events, handed, authenticated, quote, projection, admission, controller };
}

test('actual safe preparer selects configured z and hands off only the six-field envelope once', async () => {
	const f = fixture(); const dispatch = createCredentialFreeCompleteChatDispatchV400(f.input, f.ports);
	const response = await dispatch.run();
	assert.deepEqual(f.events, ['auth', 'quote', 'project', 'prepare', 'admit', 'holder']);
	assert.deepEqual(Object.keys(f.handed[0]!).sort(), ['attemptNonce', 'candidateIndex', 'finalBodyUtf8', 'quoteId', 'requestId', 'routeTargetId']);
	assert.equal(f.handed[0]!.routeTargetId, 'z'); assert.equal(response.headers.get('X-Private'), null);
	assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(await response.text(), '{"ok":true}');
	await assert.rejects(dispatch.run(), /dispatch rejected/u); assert.equal(f.handed.length, 1);
});

test('stream completion remains owned by the holder and private headers are removed', async () => {
	const f = fixture(true); const response = await createCredentialFreeCompleteChatDispatchV400(f.input, f.ports).run();
	assert.equal(response.headers.get('Content-Type'), 'text/event-stream'); assert.equal(response.headers.get('X-Private'), null);
	assert.equal(await response.text(), 'data: [DONE]\n\n');
});

test('authentication failure or pending period never reaches quote, admission or holder', async () => {
	for (const pending of [false, true]) {
		const f = fixture();
		const dispatch = createCredentialFreeCompleteChatDispatchV400(f.input, { ...f.ports, authenticate: async () => {
			f.events.push('auth'); if (pending) throw new Error('period_reset_pending'); return null; } });
		await assert.rejects(dispatch.run()); assert.deepEqual(f.events, ['auth']); assert.equal(f.handed.length, 0);
		await assert.rejects(dispatch.run()); assert.deepEqual(f.events, ['auth']);
	}
});

test('unacknowledged quote, projection or admission is not retried and prevents handoff', async () => {
	for (const step of ['issueQuote', 'project', 'admit'] as const) {
		const f = fixture(); let calls = 0;
		const dispatch = createCredentialFreeCompleteChatDispatchV400(f.input, { ...f.ports, [step]: async () => { calls++; throw new Error('COMMIT or close unknown'); } });
		await assert.rejects(dispatch.run(), /unknown/u); await assert.rejects(dispatch.run());
		assert.equal(calls, 1); assert.equal(f.handed.length, 0);
	}
});

test('quote identity, projection quote binding and admission amount drift all prevent holder', async () => {
	for (const changed of [
		{ issueQuote: async (f: ReturnType<typeof fixture>) => ({ ...f.quote, requestId: 'different' }) },
		{ project: async (f: ReturnType<typeof fixture>) => ({ ...f.projection, quoteId: '22222222-2222-4222-8222-222222222222' }) },
		{ admit: async (f: ReturnType<typeof fixture>) => ({ ...f.admission, reservedMicros: 301 }) },
	]) {
		const f = fixture(), [step, callback] = Object.entries(changed)[0]!;
		const dispatch = createCredentialFreeCompleteChatDispatchV400(f.input, { ...f.ports, [step]: () => callback(f) });
		await assert.rejects(dispatch.run()); assert.equal(f.handed.length, 0);
	}
});

test('no circuit-available route prevents financial admission and holder', async () => {
	const f = fixture();
	await assert.rejects(createCredentialFreeCompleteChatDispatchV400(f.input, { ...f.ports, prepare: async p => {
		const result = await prepareCredentialFreeRouteAttemptsV398(p);
		return { ...result, candidates: result.candidates.map(c => ({ ...c, attempts: [], skippedByCircuit: c.attempts.length })) };
	} }).run());
	assert.equal(f.events.includes('admit'), false); assert.equal(f.handed.length, 0);
});

test('cancellation after committed admission leaves no holder handoff', async () => {
	const f = fixture();
	await assert.rejects(createCredentialFreeCompleteChatDispatchV400(f.input, { ...f.ports, admit: async () => {
		f.events.push('admit'); f.controller.abort(); return f.admission; } }).run(), /abort/iu);
	assert.equal(f.handed.length, 0);
});

test('projection expiry during acknowledged admission prevents handoff', async t => {
	const f = fixture(); let now = Date.now(); const expires = Date.parse(f.projection.expiresAt);
	t.mock.method(Date, 'now', () => now);
	await assert.rejects(createCredentialFreeCompleteChatDispatchV400(f.input, { ...f.ports, admit: async () => {
		now = expires; return f.admission; } }).run(), /dispatch rejected/u);
	assert.equal(f.handed.length, 0);
});

test('captures request, connections, bearer, ports and session before delayed authentication', async () => {
	const f = fixture(); const bearer = f.input.bearer;
	const raw = { marker: 'original-runtime' };
	Object.assign(f.input.runtimeClient, { raw });
	let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
	const ports: CredentialFreeCompleteChatPortsV400 = { ...f.ports, authenticate: async p => {
		await wait; assert.equal(p.bearer, bearer); assert.equal(p.authConnectionString, 'auth-connection'); return f.authenticated; },
		issueQuote: async p => { assert.equal(p.bearer, bearer); assert.equal(p.quoteConnectionString, 'quote-connection');
			assert.equal(p.finalQuoteInput.requestId, 'request'); assert.equal(p.runtimeClient.driver, 'postgres');
			assert.equal(p.runtimeClient.raw, raw); return f.quote; },
		admit: async p => { assert.equal(p.runtimeClient.driver, 'postgres'); assert.equal(p.runtimeClient.raw, raw); return f.admission; } };
	const dispatch = createCredentialFreeCompleteChatDispatchV400(f.input, ports);
	const pending = dispatch.run();
	Object.assign(f.input, { bearer: 'changed', authConnectionString: 'changed', quoteConnectionString: 'changed', finalQuoteInput: {} });
	Object.assign(f.input.runtimeClient, { driver: 'mysql', raw: { marker: 'changed-runtime' } });
	Object.assign(ports, { authenticate: async () => { throw new Error('changed port'); } });
	release(); await (await pending).text(); assert.equal(f.handed.length, 1);
});

test('unavailable private response is cancelled and never triggers a second handoff', async () => {
	const f = fixture(); let cancelled = false, count = 0;
	f.input.holderBinding.fetch = async () => { count++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 502 }); };
	const dispatch = createCredentialFreeCompleteChatDispatchV400(f.input, f.ports);
	await assert.rejects(dispatch.run()); await Promise.resolve(); await assert.rejects(dispatch.run());
	assert.equal(cancelled, true); assert.equal(count, 1);
});

test('cancellation during the holder handoff cancels an unhanded successful response', async () => {
	const f = fixture(); let cancelled = false;
	f.input.holderBinding.fetch = async () => { f.controller.abort();
		return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
	await assert.rejects(createCredentialFreeCompleteChatDispatchV400(f.input, f.ports).run(), /abort/iu);
	await Promise.resolve(); assert.equal(cancelled, true);
});
