import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import {
	createD1StorageContext, createEncryptedProvidersRepository, createEnvironmentProviderKeysRepository,
	createEncryptedSharedKeysRepository, createEncryptedByokKeysRepository, encryptSharedKeySecret,
	preparationRead, preparationMutation, ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY,
	type ByokRuntimeKeyRow, type ModelRow, type ProviderRow, type SharedKeyRow, type PreparationControl,
} from '@octafuse/core';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline';
import { resolveModelRouting } from './resolve-model-route-group';
import { resolveRoutesForSurface, type RouteResult } from './model-router';
import { buildModelFallbackPlan } from './model-fallback-plan';
import { expandAttemptsWithSharedKeys } from './shared-key-pool';
import { expandAttemptsWithPrivateByok } from './byok-key-pool';
import { prepareProviderRoutingPreferences } from './provider-routing-preferences';
import { applyProviderPerformanceRouting } from './provider-performance-routing';
import { failoverDispatch } from './failover-dispatch';

// Real repository shapes with no database: any uninstalled SQL path is a failure.
function repositories() {
	const unexpected = (): never => { throw new Error('Unexpected database operation'); };
	const db: D1Database = { prepare: unexpected, batch: unexpected, exec: unexpected,
		withSession: unexpected, dump: unexpected };
	return createD1StorageContext(db).repositories;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const NOW = '2026-09-05T00:00:00Z';
const SECRET = 'synthetic-test-encryption-secret-32-characters';
const context = { workspaceId: 'w', userId: 'u', apiKeyHash: 'a'.repeat(64) };
function model(): ModelRow {
	return { id: 'model', display_name: 'Model', vendor: 'test', context_window: 8192, max_tokens: 1024,
		pricing_profile: null, tags: '[]', description: null, metadata: null, input_modalities: '["text"]',
		output_modalities: '["text"]', released_at: null, route_policy: null, created_at: NOW };
}
function provider(id = 'p'): ProviderRow {
	return { id, name: id, api_key: 'synthetic-provider', endpoints: '{"openai":{"base":"https://upstream.invalid"}}',
		status: 'active', description: null, created_at: NOW };
}
function sharedKey(id = 's'): SharedKeyRow {
	return { id, sellerUserId: 'seller', channelType: 'openai', apiKey: 'synthetic-shared', keyFingerprint: id,
		label: id, status: 'active', sellerPriority: 0, weight: 1, inputPrice: 0, outputPrice: 0,
		cacheReadPrice: null, cacheWritePrice: null, validatedAt: null, lastUsedAt: null, lastFailureAt: null,
		failureReason: null, servedInputTokens: 0, servedOutputTokens: 0, earnedTotal: 0, createdAt: NOW, updatedAt: NOW };
}
function byokKey(id = 'b'): ByokRuntimeKeyRow {
	return { id, workspace_id: 'w', provider: 'p', name: null, label: id, disabled: false, is_fallback: false,
		always_use_for_provider: false, always_use_for_matching_models: false, sort_order: 0,
		allowed_models: null, allowed_user_ids: null, allowed_api_key_hashes: null,
		created_by_management_key_id: null, created_at: NOW, updated_at: NOW, api_key: 'synthetic-byok' };
}
function route(id = 'p'): RouteResult {
	return { targetId: id, modelSurfaceId: null, routePoolId: null, providerId: id, providerName: id,
		providerModelName: 'model', gatewayModelId: 'model', upstreamProtocol: 'openai', upstreamOperation: 'chat',
		adapter: 'passthrough', providerEndpoints: {}, providerApiKey: 'synthetic-provider',
		providerSharedChannelType: 'openai', priceOverrideRaw: null, routeMeteredProfileJson: null,
		routeChargedProfileJson: null, customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
		endpoint: { id, modelId: 'model', providerId: id, providerSlug: id, selectorSlug: id,
			endpointClass: null, region: null, contextLength: 8192, maxPromptTokens: null, maxCompletionTokens: 1024,
			quantization: null, supportedParameters: [], pricing: null, imageCapabilities: null,
			capabilities: { implicit_caching: false, voice_cloning: false, tool_choice: { auto: false, none: false, required: false, function: false } },
			evidenceUrl: 'https://upstream.invalid/evidence', verifiedBy: 'test', verifiedAt: NOW, expiresAt: '2099-01-01T00:00:00Z' } };
}

for (const cancel of ['client', 'deadline'] as const) {
	it(`does not perform colon fallback after a late missing model (${cancel})`, async (t) => {
		const repos = repositories();
		const entered = deferred<void>();
		const late = deferred<null>();
		const calls: string[] = [];
		t.mock.method(repos.modelRouting, 'getModelById', (id: string) => { calls.push(id); entered.resolve(); return late.promise; });
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
		const parent = new AbortController();
		const control = createRequestDeadline(1100, parent.signal);
		const rejected = assert.rejects(resolveModelRouting(repos, 'model:group', control), RequestExecutionStoppedError);
		await entered.promise;
		if (cancel === 'client') parent.abort('not for logs'); else t.mock.timers.tick(100);
		await rejected;
		late.resolve(null);
		await nextTurn();
		assert.deepEqual(calls, ['model:group']);
		control.dispose();
	});
}

it('does not turn surface cancellation into legacy routing or credential reads', async (t) => {
	const repos = repositories();
	const entered = deferred<void>();
	const late = deferred<null>();
	t.mock.method(repos.modelRouting, 'resolveModelSurface', () => { entered.resolve(); return late.promise; });
	const fallback = t.mock.method(repos.modelRouting, 'getModelRoutesByModelId', async () => []);
	const parent = new AbortController();
	const control = createRequestDeadline(Date.now() + 10000, parent.signal);
	const rejected = assert.rejects(resolveRoutesForSurface(repos, { modelId: 'model', routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat' }, control), RequestExecutionStoppedError);
	await entered.promise;
	parent.abort();
	await rejected;
	late.reject(new Error('late storage failure'));
	await nextTurn();
	assert.equal(fallback.mock.callCount(), 0);
	control.dispose();
});

it('stops the complete planner after a late business timezone read', async (t) => {
	const repos = repositories();
	t.mock.method(repos.modelRouting, 'getModelById', async () => model());
	const entered = deferred<void>();
	const late = deferred<string>();
	t.mock.method(repos.systemConfig, 'getConfig', () => { entered.resolve(); return late.promise; });
	const surfaces = t.mock.method(repos.modelRouting, 'resolveModelSurface', async () => null);
	const parent = new AbortController();
	const control = createRequestDeadline(Date.now() + 10000, parent.signal);
	const rejected = assert.rejects(buildModelFallbackPlan(repos, { modelIds: ['model'], body: {}, requestProtocol: 'openai', requestOperation: 'chat', control }), RequestExecutionStoppedError);
	await entered.promise; parent.abort(); await rejected;
	late.resolve('UTC'); await nextTurn();
	assert.equal(surfaces.mock.callCount(), 0);
	control.dispose();
});

it('does not start the next shared channel after a cancelled pool read', async (t) => {
	const repos = repositories();
	const entered = deferred<void>();
	const late = deferred<SharedKeyRow[]>();
	const calls: string[] = [];
	t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', (channel: string) => { calls.push(channel); entered.resolve(); return late.promise; });
	const parent = new AbortController();
	const control = createRequestDeadline(Date.now() + 10000, parent.signal);
	const rejected = assert.rejects(expandAttemptsWithSharedKeys(repos, [route(), { ...route('p2'), providerSharedChannelType: 'anthropic' }], control), RequestExecutionStoppedError);
	await entered.promise; parent.abort(); await rejected;
	late.reject(new Error('late pool error')); await nextTurn();
	assert.deepEqual(calls, ['openai']);
	control.dispose();
});

for (const hanging of ['keys', 'policy'] as const) {
	it(`does not start the next BYOK provider after cancelled ${hanging}`, async (t) => {
		const repos = repositories();
		const entered = deferred<void>();
		const gate = deferred<void>();
		const keys = t.mock.method(repos.byokKeys, 'listActiveForRequest', async () => {
			if (hanging === 'keys') { entered.resolve(); await gate.promise; } return [];
		});
		const policy = t.mock.method(repos.byokKeys, 'shouldSuppressSharedCapacityForRequest', async () => {
			if (hanging === 'policy') { entered.resolve(); await gate.promise; } return false;
		});
		const parent = new AbortController();
		const control = createRequestDeadline(Date.now() + 10000, parent.signal);
		const rejected = assert.rejects(expandAttemptsWithPrivateByok(repos, [route(), route('p2')], [route(), route('p2')], context, control), RequestExecutionStoppedError);
		await entered.promise; parent.abort(); await rejected;
		gate.reject(new Error('late BYOK failure')); await nextTurn();
		assert.equal(keys.mock.callCount(), 1); assert.equal(policy.mock.callCount(), 1);
		control.dispose();
	});
}

it('does not swallow cancellation in performance allSettled or query another batch', async (t) => {
	const repos = repositories();
	const prepared = prepareProviderRoutingPreferences({ provider: { sort: 'latency' } });
	assert.ok(prepared.ok && prepared.value.preferences);
	const entered = deferred<void>(); const gate = deferred<void>();
	const samples = t.mock.method(repos.requestLogs, 'getRecentRoutePerformanceSamples', async () => { entered.resolve(); await gate.promise; return []; });
	const availability = t.mock.method(repos.requestLogs, 'getRouteAvailabilityAggregates', async () => { await gate.promise; return []; });
	const parent = new AbortController(); const control = createRequestDeadline(Date.now() + 10000, parent.signal);
	const routes = Array.from({ length: ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY + 1 }, (_, i) => route(`p${i}`));
	const rejected = assert.rejects(applyProviderPerformanceRouting(repos, routes, prepared.value.preferences, new Date(), control), RequestExecutionStoppedError);
	await entered.promise; parent.abort(); await rejected; gate.reject(new Error('late telemetry failure')); await nextTurn();
	assert.equal(samples.mock.callCount(), 1); assert.equal(availability.mock.callCount(), 1);
	control.dispose();
});

for (const kind of ['provider', 'shared', 'byok'] as const) {
	it(`${kind}: a late database result cannot start decryption or online migration`, async (t) => {
		const repos = repositories(); const entered = deferred<void>(); const gate = deferred<void>();
		t.mock.method(repos.providers, 'getProvidersByIds', async () => { entered.resolve(); await gate.promise; return [provider()]; });
		t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', async () => { entered.resolve(); await gate.promise; return [sharedKey()]; });
		t.mock.method(repos.byokKeys, 'listActiveForRequest', async () => { entered.resolve(); await gate.promise; return [byokKey()]; });
		const cryptoCalls = t.mock.method(crypto.subtle, 'importKey', () => { throw new Error('Late crypto'); });
		const parent = new AbortController(); const control = createRequestDeadline(Date.now() + 10000, parent.signal);
		const work = kind === 'provider' ? createEncryptedProvidersRepository(repos.providers, SECRET).getProvidersByIds(['p'], control)
			: kind === 'shared' ? createEncryptedSharedKeysRepository(repos.sharedKeys, SECRET).listActiveSharedKeysByChannel('openai', control)
				: createEncryptedByokKeysRepository(repos.byokKeys, SECRET).listActiveForRequest({ ...context, provider: 'p', modelId: 'model' }, control);
		const rejected = assert.rejects(work, RequestExecutionStoppedError);
		await entered.promise; parent.abort(); await rejected; gate.resolve(); await nextTurn();
		assert.equal(cryptoCalls.mock.callCount(), 0); control.dispose();
	});
	it(`${kind}: cancellation during key derivation stops decrypt and the next credential`, async (t) => {
		const repos = repositories();
		const identity = kind === 'provider' ? 'cinatoken:provider-key:p' : kind === 'shared' ? 'cinatoken:shared-key:s:s' : 'cinatoken:byok-key:b:w:p';
		const encrypted = await encryptSharedKeySecret('synthetic', SECRET, identity);
		t.mock.method(repos.providers, 'getProvidersByIds', async () => [{ ...provider(), api_key: encrypted }, provider('p2')]);
		t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', async () => [{ ...sharedKey(), apiKey: encrypted }, sharedKey('s2')]);
		t.mock.method(repos.byokKeys, 'listActiveForRequest', async () => [{ ...byokKey(), api_key: encrypted }, byokKey('b2')]);
		const entered = deferred<void>(); const gate = deferred<ArrayBuffer>();
		const derives = t.mock.method(crypto.subtle, 'deriveBits', () => { entered.resolve(); return gate.promise; });
		const decrypts = t.mock.method(crypto.subtle, 'decrypt', () => { throw new Error('Late decrypt'); });
		const parent = new AbortController(); const control = createRequestDeadline(Date.now() + 10000, parent.signal);
		const work = kind === 'provider' ? createEncryptedProvidersRepository(repos.providers, SECRET).getProvidersByIds(['p', 'p2'], control)
			: kind === 'shared' ? createEncryptedSharedKeysRepository(repos.sharedKeys, SECRET).listActiveSharedKeysByChannel('openai', control)
				: createEncryptedByokKeysRepository(repos.byokKeys, SECRET).listActiveForRequest({ ...context, provider: 'p', modelId: 'model' }, control);
		const rejected = assert.rejects(work, RequestExecutionStoppedError);
		await entered.promise; parent.abort(); await rejected; gate.resolve(new ArrayBuffer(32)); await nextTurn();
		assert.equal(derives.mock.callCount(), 1); assert.equal(decrypts.mock.callCount(), 0); control.dispose();
	});
}

it('environment-backed provider decoration propagates cancellation without revealing a late binding', async (t) => {
	const repos = repositories(); const entered = deferred<void>(); const gate = deferred<ProviderRow[]>();
	const parent = new AbortController(); const control = createRequestDeadline(Date.now() + 10000, parent.signal);
	t.mock.method(repos.providers, 'getProvidersByIds', (_ids: string[], received?: PreparationControl) => { assert.equal(received, control); entered.resolve(); return gate.promise; });
	const decorated = createEnvironmentProviderKeysRepository(repos.providers, {
		policies: [{ providerId: 'p', envName: 'TEST_KEY', allowedEndpointHosts: ['upstream.invalid'] }], secrets: { TEST_KEY: 'synthetic' },
	});
	const rejected = assert.rejects(decorated.getProvidersByIds(['p'], control), RequestExecutionStoppedError);
	await entered.promise; parent.abort(); await rejected; gate.resolve([{ ...provider(), api_key: 'env:TEST_KEY' }]); await nextTurn(); control.dispose();
});

for (const rejectWrite of [false, true]) {
	it(`dispatcher drains already-started shared-key upgrade after timeout (reject=${rejectWrite})`, { timeout: 5000 }, async (t) => {
		const repos = repositories(); const entered = deferred<void>(); const gate = deferred<boolean>();
		t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', async () => [sharedKey(), sharedKey('s2')]);
		let writes = 0;
		repos.sharedKeys.replaceSharedKeySecret = async () => { writes++; entered.resolve(); return gate.promise; };
		const configuredRepos = { ...repos, sharedKeys: createEncryptedSharedKeysRepository(repos.sharedKeys, SECRET) };
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
		let finished = false;
		const pending = failoverDispatch(configuredRepos, [route()], 'openai', async () => { throw new Error('Unexpected dispatch'); }, undefined,
			{ affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', requestDeadlineAtMs: 1100, delegateBeforeUpstreamDispatchToDriver: true })
			.then((value) => { finished = true; return value; });
		await entered.promise; t.mock.timers.tick(100); await nextTurn();
		assert.equal(finished, false, 'a write that may commit remains owned');
		if (rejectWrite) gate.reject(new Error('synthetic migration failure')); else gate.resolve(true);
		const result = await pending; await nextTurn();
		assert.equal(result.response.status, 504); assert.equal(result.dispatchBudget?.permitsConsumed, 0);
		assert.equal(result.meta?.upstreamOutcomeUnknown, false); assert.equal(writes, 1);
	});
}

it('checks the absolute clock after a read even when no timer callback has run', async () => {
	let now = 1;
	const control = createRequestDeadline(10, undefined, { now: () => now, set: () => 1, clear: () => {} });
	await assert.rejects(preparationRead(control, async () => { now = 10; return 'too late'; }), RequestExecutionStoppedError);
	control.dispose();
});

it('seals mutation ownership before draining and prevents late work after disposal', async () => {
	const control = createRequestDeadline(Date.now() + 10000);
	await control.drainOwnedMutations();
	await assert.rejects(preparationMutation(control, async () => assert.fail('late write')), /owner has closed/);
	control.dispose();
	await assert.rejects(preparationRead(control, async () => assert.fail('late read')), /owner has closed/);
});
