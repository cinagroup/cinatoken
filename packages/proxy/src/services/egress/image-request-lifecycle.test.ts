import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import {
	clearGcpServiceAccountTokenCache, createD1StorageContext, GCP_OAUTH_TOKEN_URL,
	GCP_OAUTH_TIMEOUT_MS, resolveProviderUpstreamSecret,
	type ByokRuntimeKeyRow, type SharedKeyRow,
} from '@octafuse/core';
import { proxyImageGenerations, proxyImageEdits, type FailoverDispatchOptions } from '../proxy';
import { createRequestDispatchBudget } from '../request-dispatch-budget';
import { RequestBudgetAdmissionError } from '../request-budget-admission';
import { GatewayErrorCode } from '../gateway-error-codes';
import { RequestTimingCollector } from '../request-timing';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';
import type { RouteResult } from '../model-router';
import {
	dispatchOpenAiImageGenerations, dispatchOpenAiImageEdits, IMAGE_GENERATION_TIMEOUT_MS,
	type OpenAiImageDispatchOptions,
} from './openai-images-driver';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const credential = (id = 'test') => JSON.stringify({ type: 'service_account', client_email: `${id}@example.invalid`, private_key: privateKey });
const imageRequest = { prompt: 'synthetic', n: 1, images: [{ filename: 'test.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }] };
const goodImage = () => Response.json({ data: [{ b64_json: 'AQI=' }] });
const nativeFetch = globalThis.fetch.bind(globalThis);
const options: FailoverDispatchOptions = { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority' };

function deferred<T>() {
	let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function repositories() {
	const unexpected = (): never => { throw new Error('Unexpected database operation'); };
	const db: D1Database = { prepare: unexpected, batch: unexpected, exec: unexpected, withSession: unexpected, dump: unexpected };
	return createD1StorageContext(db).repositories;
}
function route(operation: 'generations' | 'edits', index = 0, key = credential()): RouteResult {
	return {
		targetId: `target-${index}`, modelSurfaceId: null, routePoolId: null,
		providerId: `provider-${index}`, providerName: 'Synthetic', providerModelName: 'synthetic-image',
		upstreamProtocol: 'openai', upstreamOperation: `images.${operation}`, adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://upstream.example.invalid/v1' } },
		providerApiKey: key, providerSharedChannelType: null, priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 100 - index, routeWeight: 1,
	};
}
beforeEach(() => { clearGcpServiceAccountTokenCache(); resetProviderCircuitStateForTests(); });

for (const operation of ['generations', 'edits'] as const) {
	for (const phase of ['headers', 'body', 'explicit-rejection', 'pre-dispatch'] as const) {
		it(`images.${operation}: cancellation attempt fact preserves ${phase} evidence`, { timeout: 5000 }, async () => {
			const candidate = route(operation, 0, 'synthetic-key'), timing = new RequestTimingCollector();
			const attempt = timing.startAttempt(candidate), controller = new AbortController(), entered = deferred<void>();
			let sends = 0;
			const config: OpenAiImageDispatchOptions = { fetchImpl: async () => {
				sends++;
				if (phase === 'headers') { entered.resolve(); return new Promise<Response>(() => {}); }
				return new Response(new ReadableStream<Uint8Array>({
					pull(c) { c.enqueue(new TextEncoder().encode('{')); entered.resolve(); return new Promise<void>(() => {}); },
				}, { highWaterMark: 0 }), { status: phase === 'explicit-rejection' ? 400 : 200 });
			} };
			if (phase === 'pre-dispatch') controller.abort();
			const flight = operation === 'generations'
				? dispatchOpenAiImageGenerations(candidate, imageRequest, controller.signal, timing, attempt, config)
				: dispatchOpenAiImageEdits(candidate, imageRequest, controller.signal, timing, attempt, config);
			try {
				if (phase !== 'pre-dispatch') { await entered.promise; controller.abort(); }
				const result = await flight; await result.response.body?.cancel(); await result.usagePromise;
				assert.equal(result.response.status, phase === 'explicit-rejection' ? 400 : 499);
				assert.equal(sends, phase === 'pre-dispatch' ? 0 : 1);
				const facts = timing.snapshot().providerAttempts;
				assert.equal(facts.length, phase === 'pre-dispatch' ? 0 : 1);
				if (facts.length) {
					assert.equal(facts[0].outcome, 'excluded');
					assert.equal(facts[0].reason, phase === 'explicit-rejection' ? 'client_error' : 'client_cancelled');
					assert.equal(facts[0].httpStatus, phase === 'headers' ? null : phase === 'explicit-rejection' ? 400 : 200);
				}
			} finally { controller.abort(); await flight; }
		});
	}
}

for (const [operation, proxy] of [['generations', proxyImageGenerations], ['edits', proxyImageEdits]] as const) {
	const driver = (candidate: RouteResult, signal?: AbortSignal, config?: OpenAiImageDispatchOptions, beforeFetch?: () => Promise<void>) =>
		operation === 'generations'
			? dispatchOpenAiImageGenerations(candidate, imageRequest, signal, undefined, undefined, config, beforeFetch)
			: dispatchOpenAiImageEdits(candidate, imageRequest, signal, undefined, undefined, config, beforeFetch);
	for (const acrossInvocations of [false, true]) {
		it(`images.${operation}: 32 candidates share three auth permits (separate invocations=${acrossInvocations})`, async t => {
			let auth = 0; let admission = 0;
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
				assert.equal(String(input), GCP_OAUTH_TOKEN_URL); auth++;
				return Response.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status: 503 });
			});
			const dispatchBudget = createRequestDispatchBudget();
			const candidates = Array.from({ length: 32 }, (_, i) => route(operation, i, credential(`test-${i}`)));
			const config = { ...options, dispatchBudget, beforeUpstreamDispatch: async () => { admission++; } };
			let result = await proxy(repositories(), acrossInvocations ? candidates.slice(0, 1) : candidates, imageRequest, undefined, config);
			if (acrossInvocations) for (const candidate of candidates.slice(1)) {
				result = await proxy(repositories(), [candidate], imageRequest, undefined, config);
				if (result.meta?.failoverForbidden) break;
			}
			assert.equal(auth, 3); assert.equal(admission, 0);
			assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 0, auxiliaryAuth: { limit: 3, exchangesStarted: 3 } });
			assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
			assert.equal(result.meta?.admissionDeniedPreDispatch, true);
			assert.equal(result.meta?.failoverForbidden, true); assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
			assert.deepEqual(result.circuitEvents, []); assert.equal(result.suppressErrorAlert, true);
			assert.doesNotMatch(await result.response.text(), /PRIVATE_AUTH_DETAIL|PRIVATE KEY|@example/);
		});
	}
	for (const cached of [false, true]) {
		it(`images.${operation}: exhausted auth budget still permits ${cached ? 'cached OAuth' : 'plain API key'}`, async t => {
			t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'synthetic', expires_in: 3600 }));
			if (cached) await resolveProviderUpstreamSecret(credential());
			const fetches = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
				assert.notEqual(String(input), GCP_OAUTH_TOKEN_URL); assert.equal(init?.redirect, 'manual'); return goodImage();
			});
			const dispatchBudget = createRequestDispatchBudget(3, 1); dispatchBudget.auxiliaryAuth.consume();
			const result = await proxy(repositories(), [route(operation, 0, cached ? credential() : 'synthetic-key')], imageRequest, undefined, { ...options, dispatchBudget });
			assert.equal(result.response.status, 200); assert.equal(fetches.mock.callCount(), 1);
			assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 1, auxiliaryAuth: { limit: 1, exchangesStarted: 1 } });
			await result.response.text();
		});
	}
	for (const status of [300, 301, 302, 303, 307, 308, 408, 499, 500, 503, 524]) {
		it(`images.${operation}: ambiguous HTTP ${status} stops before a second paid send`, async t => {
			let sends = 0;
			t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
				sends++;
				assert.equal(init?.redirect, 'manual');
				return Response.json({ error: { message: 'synthetic upstream failure' } }, { status });
			});
			const result = await proxy(repositories(), [route(operation, 0, 'key'), route(operation, 1, 'key')],
				imageRequest, undefined, options);
			assert.equal(sends, 1);
			assert.equal(result.response.status, status);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(result.dispatchBudget?.permitsConsumed, 1);
			await result.response.text();
		});
	}
	it(`images.${operation}: a clear 429 rejection can use the next bounded candidate`, async t => {
		let sends = 0;
		t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
			sends++;
			assert.equal(init?.redirect, 'manual');
			return sends === 1 ? Response.json({ error: { message: 'rate limited' } }, { status: 429 }) : goodImage();
		});
		const result = await proxy(repositories(), [route(operation, 0, 'key'), route(operation, 1, 'key')],
			imageRequest, undefined, options);
		assert.equal(sends, 2);
		assert.equal(result.response.status, 200);
		assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.dispatchBudget?.permitsConsumed, 2);
		await result.response.text();
	});
	it(`images.${operation}: native 307 cannot follow a redirect or cross to another model`, async () => {
		let firstEndpoint = 0, redirectedEndpoint = 0;
		const server = createServer(async (request, response) => {
			for await (const _chunk of request) { /* Fully receive the first upload. */ }
			if (request.url === '/redirected') {
				redirectedEndpoint++;
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ data: [{ b64_json: 'AQI=' }] }));
				return;
			}
			firstEndpoint++;
			response.writeHead(307, { Location: '/redirected', 'Content-Type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const candidate = { ...route(operation, 0, 'key'), gatewayCandidateIndex: 0, providerEndpoints: {
				openai: { base: `http://127.0.0.1:${port}/v1` },
			} };
			const second = { ...route(operation, 1, 'key'), gatewayCandidateIndex: 1,
				providerEndpoints: candidate.providerEndpoints };
			const result = await proxy(repositories(), [candidate, second], imageRequest, undefined,
				{ ...options, crossModelCandidateFailover: true, image: { fetchImpl: nativeFetch } });
			assert.equal(firstEndpoint, 1);
			assert.equal(redirectedEndpoint, 0);
			assert.equal(result.response.status, 307);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(result.dispatchBudget?.permitsConsumed, 1);
			await result.response.text();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
	it(`images.${operation}: a lost native response does not cause an inner or outer resend`, async () => {
		let received = 0;
		const server = createServer(async (request) => {
			for await (const _chunk of request) { /* Accept the first upload. */ }
			received++;
			request.socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const candidate = { ...route(operation, 0, 'key'), providerEndpoints: {
				openai: { base: `http://127.0.0.1:${port}/v1` },
			} };
			const result = await proxy(repositories(), [candidate, route(operation, 1, 'key')],
				imageRequest, undefined, { ...options, image: { fetchImpl: nativeFetch } });
			assert.equal(received, 1);
			assert.equal(result.response.status, 502);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(result.dispatchBudget?.permitsConsumed, 1);
			await result.response.text();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
	for (const shared of [false, true]) {
		it(`images.${operation}: primary BYOK → ${shared ? 'shared → ' : ''}platform → fallback BYOK cannot reset auth permits`, async t => {
			const repos = repositories();
			const byok = (id: string, fallback = false): ByokRuntimeKeyRow => ({
				id, workspace_id: 'workspace-test', provider: 'test', name: null, label: 'synthetic', disabled: false,
				is_fallback: fallback, always_use_for_provider: false, always_use_for_matching_models: false, sort_order: 0,
				allowed_models: null, allowed_user_ids: null, allowed_api_key_hashes: null, created_by_management_key_id: null,
				created_at: '2026-09-05', updated_at: '2026-09-05', api_key: credential(id),
			});
			const sharedKey: SharedKeyRow = {
				id: 'shared', sellerUserId: 'seller', channelType: 'openai', apiKey: credential('shared'), keyFingerprint: 'synthetic', label: null,
				status: 'active', sellerPriority: 0, weight: 1, inputPrice: 0, outputPrice: 0, cacheReadPrice: null, cacheWritePrice: null,
				validatedAt: null, lastUsedAt: null, lastFailureAt: null, failureReason: null, servedInputTokens: 0, servedOutputTokens: 0,
				earnedTotal: 0, createdAt: '2026-09-05', updatedAt: '2026-09-05',
			};
			t.mock.method(repos.byokKeys, 'listActiveForRequest', async () => [byok('primary'), byok('fallback1', true), byok('fallback2', true)]);
			t.mock.method(repos.byokKeys, 'shouldSuppressSharedCapacityForRequest', async () => false);
			t.mock.method(repos.sharedKeys, 'listActiveSharedKeysByChannel', async () => shared ? [sharedKey] : []);
			const candidate: RouteResult = { ...route(operation, 0, credential('platform')), providerSharedChannelType: 'openai', gatewayModelId: 'model',
				endpoint: { id: 'endpoint', modelId: 'model', providerId: 'provider-0', providerSlug: 'test', selectorSlug: 'test', endpointClass: null,
					region: null, contextLength: null, maxPromptTokens: null, maxCompletionTokens: null, quantization: null, supportedParameters: [],
					pricing: null, imageCapabilities: null, capabilities: { implicit_caching: false, voice_cloning: false, tool_choice: { auto: true, function: true, none: true, required: true } },
					evidenceUrl: 'https://example.invalid/evidence', verifiedBy: 'test', verifiedAt: '2026-09-05', expiresAt: '2099-01-01',
				},
			};
			const identities: string[] = [];
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
				assert.equal(String(input), GCP_OAUTH_TOKEN_URL, 'no image inference is allowed');
				const jwt = new URLSearchParams(String(init?.body)).get('assertion')!;
				const claims: unknown = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
				assert.ok(claims && typeof claims === 'object' && 'iss' in claims && typeof claims.iss === 'string');
				identities.push(claims.iss); return new Response('', { status: 503 });
			});
			const result = await proxy(repos, [candidate], imageRequest, undefined, { ...options,
				byok: { workspaceId: 'workspace-test', userId: 'user', apiKeyHash: 'a'.repeat(64) },
				beforeUpstreamDispatch: async () => { throw new Error('Unexpected inference admission'); },
			});
			assert.deepEqual(identities, (shared ? ['primary', 'shared', 'platform'] : ['primary', 'platform', 'fallback1']).map(id => `${id}@example.invalid`));
			assert.equal(result.chosenRoute.providerKeyId, shared ? 'byok:fallback1' : 'byok:fallback2');
			assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
			assert.equal(result.dispatchBudget?.permitsConsumed, 0); assert.deepEqual(result.circuitEvents, []);
			await result.response.text();
		});
	}
	it(`images.${operation}: successful cached auth cannot bypass the three inference permits`, async t => {
		let auth = 0; let inference = 0; let admissions = 0;
		t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
			if (String(input) === GCP_OAUTH_TOKEN_URL) { auth++; return Response.json({ access_token: 'synthetic', expires_in: 3600 }); }
			inference++; return Response.json({}, { status: 429 });
		});
		const result = await proxy(repositories(), Array.from({ length: 12 }, (_, i) => route(operation, i)), imageRequest, undefined, {
			...options, beforeUpstreamDispatch: async () => { admissions++; },
		});
		assert.equal(auth, 1); assert.equal(inference, 3); assert.equal(admissions, 3);
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.dispatchLimitExceeded);
		assert.equal(result.meta?.failoverForbidden, true); assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		await result.response.text();
	});
	for (const denial of [true, false]) {
		it(`images.${operation}: ${denial ? 'policy denial' : 'persistence failure'} is terminal before fetch`, async t => {
			const failure = denial ? new RequestBudgetAdmissionError({ code: GatewayErrorCode.budgetExceeded, message: 'Budget exceeded' }) : new Error('Synthetic admission failure');
			const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
			let admissions = 0; const dispatchBudget = createRequestDispatchBudget();
			const pending = proxy(repositories(), [route(operation, 0, 'key'), route(operation, 1, 'key')], imageRequest, undefined, {
				...options, dispatchBudget, beforeUpstreamDispatch: async () => { admissions++; throw failure; },
			});
			if (denial) {
				const result = await pending;
				assert.equal(result.response.status, 402); assert.equal(result.meta?.admissionDeniedPreDispatch, true);
				assert.equal(result.meta?.failoverForbidden, true); assert.deepEqual(result.circuitEvents, []);
				await result.response.text();
			} else await assert.rejects(pending, error => error === failure);
			assert.equal(admissions, 1); assert.equal(fetches.mock.callCount(), 0); assert.equal(dispatchBudget.snapshot().permitsConsumed, 0);
		});
	}
	for (const reject of [false, true]) {
		it(`images.${operation}: cancellation owns pending durable admission (reject=${reject})`, { timeout: 5000 }, async t => {
			const parent = new AbortController(); const entered = deferred<void>(); const write = deferred<void>();
			const fetches = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
			let finished = false; let admissions = 0;
			const pending = proxy(repositories(), [route(operation, 0, 'key'), route(operation, 1, 'key')], imageRequest, parent.signal, {
				...options, beforeUpstreamDispatch: async () => { admissions++; entered.resolve(); await write.promise; },
			}).then(value => { finished = true; return value; }, error => { finished = true; throw error; });
			await entered.promise; parent.abort('PRIVATE_CANCEL_DETAIL'); await nextTurn();
			assert.equal(finished, false, 'durable writes cannot be abandoned on client cancellation');
			if (reject) { write.reject(new Error('Synthetic admission failure')); await assert.rejects(pending, /Synthetic admission failure/); }
			else {
				write.resolve(); const result = await pending;
				assert.equal(result.response.status, 499); assert.equal(result.meta?.admissionDeniedPreDispatch, true);
				assert.notEqual(result.meta?.upstreamOutcomeUnknown, true); await result.response.text();
			}
			assert.equal(admissions, 1); assert.equal(fetches.mock.callCount(), 0);
		});
	}
	for (const stage of ['oauth-headers', 'oauth-body', 'inference-headers', 'accepted-body', 'rejected-body'] as const) {
		for (const stop of ['client', 'deadline'] as const) {
			it(`images.${operation}: ${stop} at ${stage} observes cancellation without ACK or late replay`, { timeout: 5000 }, async t => {
				t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
				const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
				let auth = 0; let inference = 0; let admission = 0; let cancels = 0; let signal: AbortSignal | null | undefined;
				const body = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise<void>(() => {}); }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
				t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
					const oauth = String(input) === GCP_OAUTH_TOKEN_URL;
					if (oauth) auth++; else inference++;
					if (oauth !== stage.startsWith('oauth')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
					signal = init?.signal;
					if (stage.endsWith('headers')) { entered.resolve(); return late.promise; }
					return new Response(body, { status: stage === 'rejected-body' ? 429 : 200 });
				});
				// Direct driver avoids an independent dispatcher deadline obscuring its own behavior.
				const budget = createRequestDispatchBudget();
				const pending = driver(route(operation), parent.signal, { auxiliaryAuth: budget.auxiliaryAuth, deadlineAtMs: Date.now() + 1000 }, async () => { admission++; budget.consume(); });
				await entered.promise;
				if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL'); else t.mock.timers.tick(1000);
				const result = await pending; const sent = stage.startsWith('oauth') ? 0 : 1;
				assert.equal(result.response.status, stage === 'rejected-body' ? 429 : stop === 'client' ? 499 : 504);
				assert.equal(result.meta.imageAbortReason, stop === 'client' ? 'client_abort' : 'gateway_timeout');
				assert.equal(result.meta.upstreamOutcomeUnknown === true, sent === 1 && stage !== 'rejected-body');
				assert.equal(result.meta.admissionDeniedPreDispatch === true, sent === 0);
				assert.equal(result.meta.failoverForbidden, true); assert.equal(signal?.aborted, true);
				assert.equal(auth, 1); assert.equal(inference, sent); assert.equal(admission, sent);
				assert.equal(budget.snapshot().auxiliaryAuth.exchangesStarted, 1);
				assert.doesNotMatch(await result.response.text(), /PRIVATE_CANCEL_DETAIL|PRIVATE KEY/);
				if (stage.endsWith('headers')) late.resolve(new Response(body));
				await nextTurn(); assert.equal(cancels, 1); assert.equal(body.locked, false); assert.equal(inference, sent);
			});
		}
	}
	it(`images.${operation}: OAuth's own 30s ceiling prevents inference`, { timeout: 5000 }, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
		const entered = deferred<void>(); let admission = 0;
		const fetches = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
			assert.equal(String(input), GCP_OAUTH_TOKEN_URL); entered.resolve(); return new Promise<Response>(() => {});
		});
		const pending = driver(route(operation), undefined, {}, async () => { admission++; });
		await entered.promise; t.mock.timers.tick(GCP_OAUTH_TIMEOUT_MS);
		const result = await pending; assert.equal(result.response.status, 502);
		assert.equal(result.meta.admissionDeniedPreDispatch, true); assert.notEqual(result.meta.upstreamOutcomeUnknown, true);
		assert.equal(admission, 0); assert.equal(fetches.mock.callCount(), 1); await result.response.text();
	});
	it(`images.${operation}: candidate fallback cannot renew the absolute image deadline`, { timeout: 5000 }, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
		const entered = deferred<void>(); let inference = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			inference++;
			if (inference === 1) { t.mock.timers.tick(200_000); return Response.json({}, { status: 429 }); }
			entered.resolve(); return new Promise<Response>(() => {});
		});
		const pending = proxy(repositories(), [route(operation, 0, 'key'), route(operation, 1, 'key'), route(operation, 2, 'key')], imageRequest, undefined, options);
		await entered.promise; t.mock.timers.tick(IMAGE_GENERATION_TIMEOUT_MS - 200_000);
		const result = await pending;
		assert.equal(result.response.status, 504); assert.equal(inference, 2);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.failoverForbidden, true);
		await result.response.text();
	});
	it(`images.${operation}: invalid auth headers never consume an inference permit`, async () => {
		let admissions = 0;
		const result = await driver(route(operation, 0, 'invalid\nheader'), undefined, { fetchImpl: async () => { throw new Error('Unexpected inference'); } }, async () => { admissions++; });
		assert.equal(admissions, 0); assert.equal(result.meta.admissionDeniedPreDispatch, true); assert.notEqual(result.meta.upstreamOutcomeUnknown, true);
		await result.response.text();
	});
	it(`images.${operation}: a tightened caller deadline retains image-specific settlement metadata`, { timeout: 5000 }, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
		const entered = deferred<void>();
		t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); return new Promise<Response>(() => {}); });
		const pending = proxy(repositories(), [route(operation, 0, 'key')], imageRequest, undefined, { ...options, requestDeadlineAtMs: Date.now() + 1000 });
		await entered.promise; t.mock.timers.tick(1000);
		const result = await pending;
		assert.equal(result.response.status, 504); assert.equal(result.meta?.imageAbortReason, 'gateway_timeout');
		assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.gatewayGeneratedError, true);
		await result.response.text();
	});
}

describe('image SSE cancellation ownership', () => {
	for (const payload of ['not-json', '{"type":"error","error":{"message":"synthetic"}}']) {
		it(`settles an unread protocol error without relying on an already-aborted timer (${payload})`, { timeout: 5000 }, async () => {
			let cancels = 0;
			const source = new ReadableStream<Uint8Array>({
				start(c) { c.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`)); },
				cancel() { cancels++; return new Promise<void>(() => {}); },
			});
			const result = await dispatchOpenAiImageGenerations(route('generations', 0, 'key'), { prompt: 'synthetic', stream: true }, undefined, undefined, undefined, {
				fetchImpl: async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
			});
			const outcome = await result.meta.imageStreamSettlement!;
			assert.equal(outcome.completed, false); assert.equal(outcome.cancelled, false);
			assert.equal(outcome.imageAbortReason, undefined); assert.equal(cancels, 1); assert.equal(source.locked, false);
			assert.match(await result.response.text(), /\[DONE\]/);
		});
	}
	for (const stop of ['client', 'deadline', 'reader'] as const) for (const activeRead of [false, true]) {
		it(`${stop} settles ${activeRead ? 'a pending read' : 'an unread response'} and releases a never-ACK source`, { timeout: 5000 }, async t => {
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
			const parent = new AbortController(); let cancels = 0;
			const source = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel() { cancels++; return new Promise<void>(() => {}); } });
			const result = await dispatchOpenAiImageGenerations(route('generations', 0, 'key'), { prompt: 'synthetic', stream: true }, parent.signal, undefined, undefined, {
				fetchImpl: async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
			});
			const reader = result.response.body!.getReader(); const pending = activeRead ? reader.read() : null;
			if (stop === 'reader') await reader.cancel(); else if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL'); else t.mock.timers.tick(IMAGE_GENERATION_TIMEOUT_MS);
			const outcome = await result.meta.imageStreamSettlement!;
			assert.equal(outcome.completed, false); assert.equal(outcome.validImages, 0);
			assert.equal(outcome.cancelled, stop !== 'deadline');
			assert.equal(outcome.imageAbortReason, stop === 'deadline' ? 'gateway_timeout' : 'client_abort');
			if (pending) await pending;
			await reader.cancel(); assert.equal(cancels, 1); assert.equal(source.locked, false);
			await result.usagePromise;
		});
	}
	it('delivers completed + DONE and settles even when upstream cancellation never ACKs', { timeout: 5000 }, async () => {
		let cancels = 0;
		const source = new ReadableStream<Uint8Array>({
			start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"image_generation.completed","b64_json":"AQI="}\n\ndata: [DONE]\n\n')); },
			cancel() { cancels++; return new Promise<void>(() => {}); },
		});
		const result = await dispatchOpenAiImageGenerations(route('generations', 0, 'key'), { prompt: 'synthetic', stream: true }, undefined, undefined, undefined, {
			fetchImpl: async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
		});
		assert.match(await result.response.text(), /\[DONE\]/);
		assert.equal((await result.meta.imageStreamSettlement!).completed, true);
		assert.equal(cancels, 1); assert.equal(source.locked, false);
	});
	it('rejects a non-SSE content type without waiting for cancellation ACK', { timeout: 5000 }, async () => {
		let cancels = 0;
		const result = await dispatchOpenAiImageGenerations(route('generations', 0, 'key'), { prompt: 'synthetic', stream: true }, undefined, undefined, undefined, {
			fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancels++; return new Promise<void>(() => {}); } })),
		});
		assert.equal(result.response.status, 502); assert.equal(result.meta.upstreamOutcomeUnknown, true); assert.equal(cancels, 1);
		await result.response.text();
	});
});
