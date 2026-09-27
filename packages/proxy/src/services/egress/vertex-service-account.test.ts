import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import type { ByokRuntimeKeyRow, SharedKeyRow } from '@octafuse/core';
import { clearGcpServiceAccountTokenCache, GCP_OAUTH_TOKEN_URL, GCP_OAUTH_TIMEOUT_MS, GcpTokenExchangeError, createD1StorageContext, resolveProviderUpstreamSecret } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { dispatchGeminiRoute } from './gemini-driver';
import { dispatchOpenAiRoute } from './openai-driver';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchOpenAiEmbeddingsRoute } from './openai-embeddings-driver';
import { dispatchOpenAiRerankRoute } from './openai-rerank-driver';
import { proxyChatCompletions, proxyResponses, proxyAnthropicMessages, proxyGeminiContent, proxyEmbeddings, proxyRerank } from '../proxy';
import { createRequestDispatchBudget } from '../request-dispatch-budget';
import { GatewayErrorCode } from '../gateway-error-codes';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
	type: 'service_account',
	client_email: 'vertex@demo.iam.gserviceaccount.com',
	private_key: privateKey,
});

const originalFetch = globalThis.fetch;

function stubFetch(handler: typeof fetch): void {
	globalThis.fetch = handler;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(yes => { resolve = yes; });
	return { promise, resolve };
}

function repositories() {
	const unexpected = (): never => { throw new Error('Unexpected database operation'); };
	const db: D1Database = { prepare: unexpected, batch: unexpected, exec: unexpected, withSession: unexpected, dump: unexpected };
	return createD1StorageContext(db).repositories;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearGcpServiceAccountTokenCache();
});

function route(overrides: Partial<RouteResult>): RouteResult {
	return {
		targetId: 't1',
		modelSurfaceId: null,
		routePoolId: null,
		providerId: 'p1',
		providerName: 'Vertex',
		providerModelName: 'gemini-2.5-flash',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: {},
		providerApiKey: SERVICE_ACCOUNT_JSON,
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
		...overrides,
	};
}

function tokenThenUpstreamFetch(): { fetchImpl: typeof fetch; upstream: { url: string; init: RequestInit }[] } {
	const upstream: { url: string; init: RequestInit }[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url === GCP_OAUTH_TOKEN_URL) {
			return new Response(JSON.stringify({ access_token: 'ya29.sa-token', expires_in: 3600 }), { status: 200 });
		}
		upstream.push({ url, init: { ...init, body: await new Response(init?.body).text() } });
		return new Response('{}', { status: 400 });
	};
	return { fetchImpl, upstream };
}

for (const [name, proxy, protocol] of [
	['chat', proxyChatCompletions, 'openai'],
	['responses', proxyResponses, 'openai'],
	['messages', proxyAnthropicMessages, 'anthropic'],
	['embeddings', proxyEmbeddings, 'openai'],
	['rerank', proxyRerank, 'openai'],
] as const) {
	const body = { input: 'synthetic', query: 'synthetic', documents: ['synthetic'] };
	for (const acrossModels of [false, true]) {
		it(`${name}: auth failures share three permits across ${acrossModels ? 'model invocations' : '32 credentials'} without admission`, async () => {
			resetProviderCircuitStateForTests();
			const dispatchBudget = createRequestDispatchBudget();
			let auth = 0; let inference = 0; let admission = 0;
			stubFetch(async (input) => {
				if (String(input) === GCP_OAUTH_TOKEN_URL) { auth++; return new Response('private auth error', { status: 503 }); }
				inference++; throw new Error('Unexpected inference');
			});
			const candidates = Array.from({ length: 32 }, (_, i) => route({
				targetId: `target-${i}`, providerId: `provider-${i}`, providerKeyId: `key-${i}`,
				providerModelName: `model-${i}`, routePriority: 32 - i, upstreamProtocol: protocol,
				upstreamOperation: name, providerEndpoints: { [protocol]: { base: 'https://model.example.invalid/v1' } },
				providerApiKey: JSON.stringify({ type: 'service_account', client_email: `synthetic-${i}@example.invalid`, private_key: privateKey }),
			}));
			const options = { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority' as const, dispatchBudget,
				beforeUpstreamDispatch: async () => { admission++; } };
			let result = await proxy(repositories(), acrossModels ? candidates.slice(0, 1) : candidates, body, undefined, options);
			if (acrossModels) {
				for (const candidate of candidates.slice(1)) {
					result = await proxy(repositories(), [candidate], body, undefined, options);
					if (result.meta?.failoverForbidden) break;
				}
			}
			assert.equal(result.response.status, 502);
			assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
			assert.equal(result.meta?.admissionDeniedPreDispatch, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
			assert.deepEqual(result.circuitEvents, []);
			assert.equal(result.suppressErrorAlert, true);
			assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 3 } });
			assert.equal(auth, 3); assert.equal(inference, 0); assert.equal(admission, 0);
			assert.equal((await result.usagePromise).total_tokens, 0);
			assert.doesNotMatch(await result.response.text(), /private auth error|synthetic-.*@|PRIVATE KEY/);
		});
	}
	for (const outcome of ['known-failure', 'unknown'] as const) {
		it(`${name}: ${outcome} after successful auth keeps inference and auth facts separate`, async () => {
			resetProviderCircuitStateForTests();
			let auth = 0; let inference = 0; let admission = 0;
			stubFetch(async (input) => {
				if (String(input) === GCP_OAUTH_TOKEN_URL) { auth++; return Response.json({ access_token: 'synthetic', expires_in: 3600 }); }
				inference++;
				if (outcome === 'unknown') throw new Error('synthetic network failure');
				return new Response('rate limited', { status: 429 });
			});
			const candidates = Array.from({ length: 8 }, (_, i) => route({ targetId: `t-${i}`, providerId: `p-${i}`, routePriority: 8 - i,
				upstreamProtocol: protocol, upstreamOperation: name, providerEndpoints: { [protocol]: { base: 'https://model.example.invalid/v1' } } }));
			const result = await proxy(repositories(), candidates, body, undefined, {
				affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', beforeUpstreamDispatch: async () => { admission++; },
			});
			const sent = outcome === 'unknown' ? 1 : 3;
			assert.equal(auth, 1, 'successful cached token is reused without another auth permit');
			assert.equal(inference, sent); assert.equal(admission, sent);
			assert.equal(result.dispatchBudget?.permitsConsumed, sent);
			assert.equal(result.dispatchBudget?.auxiliaryAuth.exchangesStarted, 1);
			assert.equal(result.meta?.upstreamOutcomeUnknown === true, outcome === 'unknown');
			assert.equal(result.meta?.failoverForbidden, true);
			await result.response.text();
		});
	}
}

it('Gemini proxy forwards the request auth owner and does not admit after its ceiling', async () => {
	resetProviderCircuitStateForTests();
	let auth = 0; let admission = 0;
	stubFetch(async input => { assert.equal(String(input), GCP_OAUTH_TOKEN_URL); auth++; return new Response('', { status: 503 }); });
	const candidates = Array.from({ length: 10 }, (_, i) => route({
		targetId: `gemini-${i}`, providerId: `gemini-${i}`, upstreamProtocol: 'gemini', upstreamOperation: 'models.generate',
		providerEndpoints: { gemini: { base: 'https://model.example.invalid/v1beta/models' } },
	}));
	const result = await proxyGeminiContent(repositories(), candidates, 'generateContent', {}, '', undefined, {
		affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', beforeUpstreamDispatch: async () => { admission++; },
	});
	assert.equal(auth, 3); assert.equal(admission, 0);
	assert.equal(result.dispatchBudget?.permitsConsumed, 0);
	assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
	assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
	await result.response.text();
});

for (const [name, proxy, shared] of ([['chat', proxyChatCompletions], ['embeddings', proxyEmbeddings], ['rerank', proxyRerank]] as const)
	.flatMap(([name, proxy]) => [false, true].map(shared => [name, proxy, shared] as const))) {
	it(`${name}: private primary → ${shared ? 'shared → ' : ''}platform → private fallback shares the auth ceiling`, async (t) => {
		resetProviderCircuitStateForTests();
		const raw = (id: string) => JSON.stringify({ type: 'service_account', client_email: `${id}@example.invalid`, private_key: privateKey });
		const byok = (id: string, fallback = false): ByokRuntimeKeyRow => ({
			id, workspace_id: 'workspace-test', provider: 'test', name: null, label: 'synthetic', disabled: false,
			is_fallback: fallback, always_use_for_provider: false, always_use_for_matching_models: false, sort_order: 0,
			allowed_models: null, allowed_user_ids: null, allowed_api_key_hashes: null, created_by_management_key_id: null,
			created_at: '2026-09-05', updated_at: '2026-09-05', api_key: raw(id),
		});
		const sharedKey: SharedKeyRow = {
			id: 'shared', sellerUserId: 'seller', channelType: 'openai', apiKey: raw('shared'), keyFingerprint: 'synthetic', label: null,
			status: 'active', sellerPriority: 0, weight: 1, inputPrice: 0, outputPrice: 0, cacheReadPrice: null, cacheWritePrice: null,
			validatedAt: null, lastUsedAt: null, lastFailureAt: null, failureReason: null, servedInputTokens: 0,
			servedOutputTokens: 0, earnedTotal: 0, createdAt: '2026-09-05', updatedAt: '2026-09-05',
		};
		const repos = repositories();
		t.mock.method(repos.byokKeys, 'listActiveForRequest', async () => [byok('primary'), byok('fallback1', true), byok('fallback2', true)]);
		t.mock.method(repos.byokKeys, 'shouldSuppressSharedCapacityForRequest', async () => false);
		t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', async () => shared ? [sharedKey] : []);
		const candidate = route({
			upstreamOperation: name,
			providerApiKey: raw('platform'), providerSharedChannelType: 'openai', gatewayModelId: 'model',
			providerEndpoints: { openai: { base: 'https://model.example.invalid/v1' } },
			endpoint: {
				id: 'endpoint', modelId: 'model', providerId: 'p1', providerSlug: 'test', selectorSlug: 'test', endpointClass: null,
				region: null, contextLength: 8192, maxPromptTokens: null, maxCompletionTokens: null, quantization: null,
				supportedParameters: [], pricing: null, imageCapabilities: null,
				capabilities: { implicit_caching: false, voice_cloning: false, tool_choice: { auto: true, function: true, none: true, required: true } },
				evidenceUrl: 'https://example.invalid/evidence', verifiedBy: 'test', verifiedAt: '2026-09-05', expiresAt: '2099-01-01',
			},
		});
		const identities: string[] = []; let admission = 0;
		stubFetch(async (input, init) => {
			assert.equal(String(input), GCP_OAUTH_TOKEN_URL, 'no inference is allowed');
			const jwt = new URLSearchParams(String(init?.body)).get('assertion')!;
			const claims: unknown = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
			assert.ok(claims && typeof claims === 'object' && 'iss' in claims && typeof claims.iss === 'string');
			identities.push(claims.iss);
			return new Response('', { status: 503 });
		});
		const result = await proxy(repos, [candidate], { input: 'synthetic', query: 'synthetic', documents: ['synthetic'] }, undefined, {
			affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority',
			byok: { workspaceId: 'workspace-test', userId: 'user', apiKeyHash: 'a'.repeat(64) },
			beforeUpstreamDispatch: async () => { admission++; },
		});
		assert.deepEqual(identities, (shared ? ['primary', 'shared', 'platform'] : ['primary', 'platform', 'fallback1']).map(id => `${id}@example.invalid`));
		assert.equal(result.chosenRoute.providerKeyId, shared ? 'byok:fallback1' : 'byok:fallback2');
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
		assert.equal(result.dispatchBudget?.permitsConsumed, 0); assert.equal(admission, 0);
		assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		assert.deepEqual(result.circuitEvents, []);
		await result.response.text();
	});
}

for (const [name, proxy, cached] of ([['chat', proxyChatCompletions], ['embeddings', proxyEmbeddings], ['rerank', proxyRerank]] as const)
	.flatMap(([name, proxy]) => [false, true].map(cached => [name, proxy, cached] as const))) {
	it(`${name}: an exhausted auth budget still allows ${cached ? 'a valid cached token' : 'an ordinary key'} and counts only inference`, async () => {
		resetProviderCircuitStateForTests();
		let inference = 0;
		stubFetch(async input => {
			if (String(input) === GCP_OAUTH_TOKEN_URL) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
			throw new Error('Unexpected inference while warming the cache');
		});
		if (cached) await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON);
		stubFetch(async input => {
			assert.notEqual(String(input), GCP_OAUTH_TOKEN_URL, 'exhausted budget must not start new authentication');
			inference++;
			return new Response('', { status: 400 });
		});
		const dispatchBudget = createRequestDispatchBudget(3, 1);
		dispatchBudget.auxiliaryAuth.consume();
		const result = await proxy(repositories(), [route({
			upstreamOperation: name,
			providerApiKey: cached ? SERVICE_ACCOUNT_JSON : 'synthetic-key',
			providerEndpoints: { openai: { base: 'https://model.example.invalid/v1' } },
		})], { input: 'synthetic', query: 'synthetic', documents: ['synthetic'] }, undefined, { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget });
		assert.equal(inference, 1); assert.equal(result.response.status, 400);
		assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 1, auxiliaryAuth: { limit: 1, exchangesStarted: 1 } });
		await result.response.text();
	});
}

for (const [name, proxy, driver] of [
	['embeddings', proxyEmbeddings, dispatchOpenAiEmbeddingsRoute],
	['rerank', proxyRerank, dispatchOpenAiRerankRoute],
] as const) {
	const body = { input: 'synthetic', query: 'synthetic', documents: ['synthetic'] };
	const candidate = () => route({ upstreamOperation: name, providerApiKey: 'synthetic-ordinary-key',
		providerEndpoints: { openai: { base: 'https://model.example.invalid/v1' } } });
	for (const stop of ['client', 'deadline'] as const) {
		it(`${name}: ${stop} cancels a stalled accepted body without waiting for cancellation ACK or replaying`, { timeout: 5000 }, async (t) => {
			resetProviderCircuitStateForTests();
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
			const parent = new AbortController(); const reading = deferred<void>();
			let sends = 0; let cancels = 0; let admissions = 0; let signal: AbortSignal | null | undefined;
			const stream = new ReadableStream<Uint8Array>({
				pull() { reading.resolve(); return new Promise<void>(() => {}); },
				cancel() { cancels++; return new Promise<void>(() => {}); },
			}, { highWaterMark: 0 });
			stubFetch(async (_input, init) => { sends++; signal = init?.signal; return new Response(stream, { headers: { 'Content-Type': 'application/json' } }); });
			const pending = proxy(repositories(), [candidate(), candidate()], body, parent.signal, {
				affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', requestDeadlineAtMs: Date.now() + 100,
				beforeUpstreamDispatch: async () => { admissions++; },
			}, 'gen-vector-stop');
			await reading.promise;
			if (stop === 'client') parent.abort('private cancellation'); else t.mock.timers.tick(100);
			const result = await pending;
			assert.equal(result.response.status, stop === 'client' ? 499 : 504);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(result.meta?.admissionDeniedPreDispatch, false);
			assert.equal(signal?.aborted, true); assert.equal(cancels, 1); assert.equal(stream.locked, false);
			assert.equal(sends, 1); assert.equal(admissions, 1);
			assert.equal(result.dispatchBudget?.permitsConsumed, 1);
			assert.equal(result.dispatchBudget?.auxiliaryAuth.exchangesStarted, 0);
			assert.doesNotMatch(await result.response.text(), /private cancellation/);
		});
	}
	it(`${name}: invalid content type does not wait for an unacknowledged cancellation`, { timeout: 5000 }, async () => {
		let cancels = 0;
		stubFetch(async () => new Response(new ReadableStream({ cancel() { cancels++; return new Promise<void>(() => {}); } }),
			{ headers: { 'Content-Type': 'text/plain' } }));
		const result = await driver(candidate(), body);
		assert.equal(result.response.status, 502); assert.equal(cancels, 1);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.failoverForbidden, true);
		await result.response.text();
	});
	it(`${name}: a pre-cancelled request spends no auth or inference permit`, async () => {
		resetProviderCircuitStateForTests();
		const parent = new AbortController(); parent.abort();
		stubFetch(async () => { throw new Error('Unexpected fetch'); });
		const result = await proxy(repositories(), [candidate()], body, parent.signal);
		assert.equal(result.response.status, 499); assert.equal(result.meta?.admissionDeniedPreDispatch, true);
		assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 0 } });
		await result.response.text();
	});
}

describe('Vertex service account egress', () => {
	it('sends Vertex OpenAI a Bearer access token and prefixes google/', async () => {
		const { fetchImpl, upstream } = tokenThenUpstreamFetch();
		stubFetch(fetchImpl);
		await dispatchOpenAiRoute(
			route({
				providerEndpoints: {
					openai: {
						endpoints: {
							chat: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi/chat/completions',
						},
					},
				},
			}),
			{ messages: [{ role: 'user', content: 'hi' }] }
		);
		assert.equal(upstream.length, 1);
		assert.match(upstream[0].url, /\/endpoints\/openapi\/chat\/completions$/);
		const headers = upstream[0].init.headers as Record<string, string>;
		assert.equal(headers.Authorization, 'Bearer ya29.sa-token');
		const body = JSON.parse(String(upstream[0].init.body)) as { model: string };
		assert.equal(body.model, 'google/gemini-2.5-flash');
		assert.equal(upstream[0].url.includes(SERVICE_ACCOUNT_JSON), false);
	});

	it('forces Gemini Bearer and never puts the service account JSON in ?key=', async () => {
		const { fetchImpl, upstream } = tokenThenUpstreamFetch();
		stubFetch(fetchImpl);
		await dispatchGeminiRoute(
			route({
				upstreamProtocol: 'gemini',
				upstreamOperation: 'models.generate',
				providerEndpoints: {
					gemini: {
						base: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models',
						auth: 'query-key',
					},
				},
			}),
			{},
			'generateContent',
			''
		);
		assert.equal(upstream.length, 1);
		const called = new URL(upstream[0].url);
		assert.equal(called.searchParams.has('key'), false);
		assert.equal(called.pathname.endsWith('/models/gemini-2.5-flash:generateContent'), true);
		assert.equal(called.pathname.includes('/google/gemini-2.5-flash'), false);
		const headers = upstream[0].init.headers as Record<string, string>;
		assert.equal(headers.Authorization, 'Bearer ya29.sa-token');
	});
});

for (const [name, proxy, protocol] of [
	['chat', proxyChatCompletions, 'openai'],
	['responses', proxyResponses, 'openai'],
	['messages', proxyAnthropicMessages, 'anthropic'],
	['embeddings', proxyEmbeddings, 'openai'],
	['rerank', proxyRerank, 'openai'],
] as const) {
	for (const stop of ['client', 'deadline', 'oauth-timeout'] as const) {
		it(`${name}: ${stop} during OAuth does not admit, send inference or mark an unknown model outcome`, async (t) => {
			resetProviderCircuitStateForTests();
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
			const entered = deferred<void>(); const transport = deferred<Response>();
			const controller = new AbortController();
			let oauthCalls = 0; let modelCalls = 0; let admissionCalls = 0;
			let oauthSignal: AbortSignal | null | undefined;
			stubFetch(async (input, init) => {
				if (String(input) === GCP_OAUTH_TOKEN_URL) {
					oauthCalls++; oauthSignal = init?.signal; entered.resolve(); return transport.promise;
				}
				modelCalls++; return new Response('unexpected', { status: 500 });
			});
			const candidate = route({ upstreamProtocol: protocol, upstreamOperation: name,
				providerEndpoints: { [protocol]: { base: 'https://model.example.invalid/v1' } } });
			const pending = proxy(repositories(), [candidate], { messages: [], input: 'synthetic', query: 'synthetic', documents: ['synthetic'] }, controller.signal, {
				affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority',
				requestDeadlineAtMs: Date.now() + (stop === 'oauth-timeout' ? 60_000 : 100),
				beforeUpstreamDispatch: async () => { admissionCalls++; },
			});
			await entered.promise;
			if (stop === 'client') controller.abort('private client material');
			else t.mock.timers.tick(stop === 'deadline' ? 100 : GCP_OAUTH_TIMEOUT_MS);
			const result = await pending;
			assert.equal(result.response.status, stop === 'client' ? 499 : stop === 'deadline' ? 504 : 502);
			assert.equal(result.dispatchBudget?.permitsConsumed, 0);
			assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(oauthSignal?.aborted, true);
			assert.equal(oauthCalls, 1); assert.equal(admissionCalls, 0); assert.equal(modelCalls, 0);
			const errorBody = await result.response.text();
			assert.equal(errorBody.includes('private client material'), false);
			let cancelled = 0;
			transport.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
			await nextTurn();
			assert.equal(cancelled, 1);
			assert.equal(admissionCalls, 0); assert.equal(modelCalls, 0);
		});
	}
}

for (const name of ['chat', 'responses', 'messages', 'gemini', 'embeddings', 'rerank'] as const) {
	it(`${name}: driver passes cancellation into OAuth body consumption before its fetch boundary`, async () => {
		const reading = deferred<void>(); const controller = new AbortController();
		let cancelled = 0; let boundary = 0;
		const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
		stubFetch(async (input) => {
			assert.equal(String(input), GCP_OAUTH_TOKEN_URL, 'only the token endpoint may be called');
			return new Response(stream);
		});
		const candidate = route({ providerEndpoints: {
			openai: { base: 'https://model.example.invalid/v1' },
			anthropic: { base: 'https://model.example.invalid/v1' },
			gemini: { base: 'https://model.example.invalid/v1beta/models' },
		} });
		const beforeFetch = async () => { boundary++; };
		const pending = name === 'gemini'
			? dispatchGeminiRoute(candidate, {}, 'generateContent', '', controller.signal, undefined, undefined, beforeFetch)
			: (name === 'chat' ? dispatchOpenAiRoute : name === 'responses' ? dispatchOpenAiResponsesRoute : name === 'embeddings' ? dispatchOpenAiEmbeddingsRoute : name === 'rerank' ? dispatchOpenAiRerankRoute : dispatchAnthropicRoute)(candidate, { input: 'synthetic', query: 'synthetic', documents: ['synthetic'] }, controller.signal, undefined, undefined, beforeFetch);
		const rejected = assert.rejects(pending, (error: unknown) => error instanceof GcpTokenExchangeError && error.code === 'cancelled');
		await reading.promise; controller.abort(); await rejected;
		assert.equal(cancelled, 1); assert.equal(boundary, 0); assert.equal(stream.locked, false);
	});
}
