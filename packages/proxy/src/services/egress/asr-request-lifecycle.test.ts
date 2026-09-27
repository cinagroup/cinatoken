import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import { clearGcpServiceAccountTokenCache, createD1StorageContext, GCP_OAUTH_TOKEN_URL, resolveProviderUpstreamSecret, type ByokRuntimeKeyRow, type SharedKeyRow } from '@octafuse/core';
import { proxyAudioTranscriptions, proxyDashScopeMultimodalPassthrough, type AudioTranscriptionProxyOptions } from '../proxy';
import { createRequestDispatchBudget } from '../request-dispatch-budget';
import { RequestBudgetAdmissionError } from '../request-budget-admission';
import { GatewayErrorCode } from '../gateway-error-codes';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';
import type { RouteResult } from '../model-router';
import { dispatchOpenAiAudioTranscriptions, AUDIO_TRANSCRIPTION_TIMEOUT_MS, type NormalizedAudioTranscriptionRequest } from './openai-audio-driver';
import { dispatchDashScopeSyncAsr, dispatchDashScopeAsyncAsr, dispatchDashScopeMultimodalPassthrough, DASHSCOPE_ASYNC_MAX_POLLS, type DashScopeAsrDispatchOptions } from './dashscope-audio-driver';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const credential = (id = 'test') => JSON.stringify({ type: 'service_account', client_email: `${id}@example.invalid`, private_key: privateKey });
type Variant = 'openai' | 'sync' | 'async' | 'native';
const variants: Variant[] = ['openai', 'sync', 'async', 'native'];
const audio: NormalizedAudioTranscriptionRequest = { file: { filename: 'test.wav', mimeType: 'audio/wav', bytes: new Uint8Array([1, 2, 3]) }, clientResponseFormat: 'json', fileSourceUrl: 'https://audio.example/test.wav' };
const nativeBody = { model: 'public-asr', input: { messages: [] } };
const config: AudioTranscriptionProxyOptions = { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dashScope: { pollIntervalMs: 0 } };
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
function route(variant: Variant, index = 0, key = credential()): RouteResult {
	return { targetId: `target-${index}`, modelSurfaceId: null, routePoolId: null,
		providerId: `provider-${index}`, providerName: 'Synthetic', providerModelName: 'synthetic-asr',
		upstreamProtocol: variant === 'openai' ? 'openai' : 'dashscope',
		upstreamOperation: variant === 'openai' ? 'audio.transcriptions' : variant === 'async' ? 'audio.transcriptions.async' : 'audio.transcriptions.multimodal',
		adapter: variant === 'sync' ? 'dashscope-asr-qwen-file' : variant === 'async' ? 'dashscope-asr-file-async' : 'passthrough',
		providerEndpoints: { openai: { base: 'https://upstream.example/v1' }, dashscope: { base: 'https://upstream.example/api/v1' } },
		providerApiKey: key, providerSharedChannelType: null, priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 100 - index, routeWeight: 1 };
}
function driver(variant: Variant, candidate: RouteResult, signal?: AbortSignal, options: DashScopeAsrDispatchOptions = {}) {
	if (variant === 'openai') return dispatchOpenAiAudioTranscriptions(candidate, audio, signal, undefined, undefined, options);
	if (variant === 'sync') return dispatchDashScopeSyncAsr(candidate, audio, signal, undefined, undefined, options);
	if (variant === 'async') return dispatchDashScopeAsyncAsr(candidate, audio, signal, undefined, undefined, { pollIntervalMs: 0, ...options });
	return dispatchDashScopeMultimodalPassthrough(candidate, nativeBody, signal, undefined, undefined, options);
}
function proxy(variant: Variant, candidates: RouteResult[], signal?: AbortSignal, options: AudioTranscriptionProxyOptions = config, repos = repositories()) {
	return variant === 'native' ? proxyDashScopeMultimodalPassthrough(repos, candidates, nativeBody, signal, options)
		: proxyAudioTranscriptions(repos, candidates, audio, signal, options);
}
function success(variant: Variant, input: RequestInfo | URL): Response {
	if (variant === 'async') {
		if (String(input).includes('/tasks/')) return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.example/transcript.json' }] }, usage: { seconds: 1 } });
		if (String(input).includes('result.example')) return Response.json({ transcripts: [{ text: 'synthetic', sentences: [] }] });
		return Response.json({ output: { task_id: 'task-1' } });
	}
	return Response.json(variant === 'openai' ? { text: 'synthetic', duration: 1 }
		: { output: { text: 'synthetic', choices: [{ message: { content: [{ text: 'synthetic' }] } }] }, usage: { seconds: 1 } });
}
beforeEach(() => { clearGcpServiceAccountTokenCache(); resetProviderCircuitStateForTests(); });

for (const variant of variants) {
	for (const shared of [false, true]) it(`${variant}: BYOK/shared/platform expansion retains one auth budget (shared=${shared})`, async t => {
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
		const candidate: RouteResult = { ...route(variant, 0, credential('platform')), providerSharedChannelType: 'openai', gatewayModelId: 'model',
			endpoint: { id: 'endpoint', modelId: 'model', providerId: 'provider-0', providerSlug: 'test', selectorSlug: 'test', endpointClass: null,
				region: null, contextLength: null, maxPromptTokens: null, maxCompletionTokens: null, quantization: null, supportedParameters: [],
				pricing: null, imageCapabilities: null, capabilities: { implicit_caching: false, voice_cloning: false, tool_choice: { auto: true, function: true, none: true, required: true } },
				evidenceUrl: 'https://example.invalid/evidence', verifiedBy: 'test', verifiedAt: '2026-09-05', expiresAt: '2099-01-01',
			},
		};
		const identities: string[] = [];
		t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(String(input), GCP_OAUTH_TOKEN_URL, 'no ASR inference is allowed');
			const jwt = new URLSearchParams(String(init?.body)).get('assertion')!;
			const claims: unknown = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
			assert.ok(claims && typeof claims === 'object' && 'iss' in claims && typeof claims.iss === 'string');
			identities.push(claims.iss); return new Response('', { status: 503 });
		});
		const result = await proxy(variant, [candidate], undefined, { ...config,
			byok: { workspaceId: 'workspace-test', userId: 'user', apiKeyHash: 'a'.repeat(64) },
			beforeUpstreamDispatch: async () => { throw new Error('Unexpected inference admission'); },
		}, repos);
		assert.deepEqual(identities, (shared ? ['primary', 'shared', 'platform'] : ['primary', 'platform', 'fallback1']).map(id => `${id}@example.invalid`));
		assert.equal(result.chosenRoute.providerKeyId, shared ? 'byok:fallback1' : 'byok:fallback2');
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
		assert.equal(result.dispatchBudget?.permitsConsumed, 0); assert.deepEqual(result.circuitEvents, []);
		await result.response.text();
	});
	for (const separate of [false, true]) it(`${variant}: 32 credentials share the auth ceiling (separate=${separate})`, async t => {
		let auth = 0; let admission = 0;
		t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => { assert.equal(String(input), GCP_OAUTH_TOKEN_URL); auth++; return Response.json({ error: 'PRIVATE_AUTH_DETAIL' }, { status: 503 }); });
		const dispatchBudget = createRequestDispatchBudget();
		const options = { ...config, dispatchBudget, beforeUpstreamDispatch: async () => { admission++; } };
		const candidates = Array.from({ length: 32 }, (_, i) => route(variant, i, credential(`test-${i}`)));
		let result = await proxy(variant, separate ? candidates.slice(0, 1) : candidates, undefined, options);
		if (separate) for (const candidate of candidates.slice(1)) {
			result = await proxy(variant, [candidate], undefined, options); if (result.meta?.failoverForbidden) break;
		}
		assert.equal(auth, 3); assert.equal(admission, 0); assert.equal(result.dispatchBudget?.permitsConsumed, 0);
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.auxiliaryAuthLimitExceeded);
		assert.equal(result.meta?.admissionDeniedPreDispatch, true); assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		assert.deepEqual(result.circuitEvents, []); assert.doesNotMatch(await result.response.text(), /PRIVATE_AUTH_DETAIL|PRIVATE KEY/);
	});
	for (const cached of [false, true]) it(`${variant}: exhausted auth budget permits ${cached ? 'cache' : 'plain key'}`, async t => {
		t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'synthetic', expires_in: 3600 }));
		if (cached) await resolveProviderUpstreamSecret(credential());
		let sends = 0;
		t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			assert.notEqual(String(input), GCP_OAUTH_TOKEN_URL); assert.equal(init?.redirect, 'manual'); sends++; return success(variant, input);
		});
		const dispatchBudget = createRequestDispatchBudget(3, 1); dispatchBudget.auxiliaryAuth.consume();
		const result = await proxy(variant, [route(variant, 0, cached ? credential() : 'key')], undefined, { ...config, dispatchBudget });
		assert.equal(result.response.status, 200); assert.equal(sends, variant === 'async' ? 3 : 1);
		assert.deepEqual(result.dispatchBudget, { limit: 3, permitsConsumed: 1, auxiliaryAuth: { limit: 1, exchangesStarted: 1 } });
		await result.response.text();
	});
	it(`${variant}: cached auth does not reset the inference ceiling`, async t => {
		let auth = 0; let sends = 0; let admission = 0;
		t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
			if (String(input) === GCP_OAUTH_TOKEN_URL) { auth++; return Response.json({ access_token: 'synthetic', expires_in: 3600 }); }
			sends++; return Response.json({}, { status: 429 });
		});
		const result = await proxy(variant, Array.from({ length: 12 }, (_, i) => route(variant, i)), undefined, { ...config, beforeUpstreamDispatch: async () => { admission++; } });
		assert.equal(auth, 1); assert.equal(sends, 3); assert.equal(admission, 3);
		assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'), GatewayErrorCode.dispatchLimitExceeded); await result.response.text();
	});
	for (const denial of [false, true]) it(`${variant}: local admission failure is terminal (policy=${denial})`, async t => {
		const failure = denial ? new RequestBudgetAdmissionError({ code: GatewayErrorCode.budgetExceeded, message: 'Budget exceeded' }) : new Error('Synthetic persistence failure');
		const dispatchBudget = createRequestDispatchBudget(); let admission = 0;
		const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
		const pending = proxy(variant, [route(variant, 0, 'key'), route(variant, 1, 'key')], undefined, { ...config, dispatchBudget, beforeUpstreamDispatch: async () => { admission++; throw failure; } });
		if (denial) { const result = await pending; assert.equal(result.response.status, 402); assert.equal(result.meta?.admissionDeniedPreDispatch, true); await result.response.text(); }
		else await assert.rejects(pending, error => error === failure);
		assert.equal(admission, 1); assert.equal(calls.mock.callCount(), 0); assert.equal(dispatchBudget.snapshot().permitsConsumed, 0);
	});
	for (const reject of [false, true]) it(`${variant}: cancellation retains pending admission ownership (reject=${reject})`, { timeout: 5000 }, async t => {
		const parent = new AbortController(); const entered = deferred<void>(); const write = deferred<void>(); let finished = false; let admission = 0;
		const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
		const pending = proxy(variant, [route(variant, 0, 'key'), route(variant, 1, 'key')], parent.signal, { ...config, beforeUpstreamDispatch: async () => { admission++; entered.resolve(); await write.promise; } })
			.then(value => { finished = true; return value; }, error => { finished = true; throw error; });
		await entered.promise; parent.abort(); await nextTurn(); assert.equal(finished, false);
		if (reject) { const failure = new Error('Synthetic persistence failure'); write.reject(failure); await assert.rejects(pending, error => error === failure); }
		else { write.resolve(); const result = await pending; assert.equal(result.response.status, 499); assert.notEqual(result.meta?.upstreamOutcomeUnknown, true); await result.response.text(); }
		assert.equal(admission, 1); assert.equal(calls.mock.callCount(), 0);
	});
	for (const stage of ['oauth-headers', 'oauth-body', 'inference-headers', 'accepted-body', 'rejected-body'] as const) for (const stop of ['client', 'deadline'] as const) {
		it(`${variant}: ${stop} at ${stage} cancels without ACK or replay`, { timeout: 5000 }, async t => {
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
			const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
			let auth = 0; let inference = 0; let admission = 0; let cancels = 0; let signal: AbortSignal | null | undefined;
			const source = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise<void>(() => {}); }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
			t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
				const oauth = String(input) === GCP_OAUTH_TOKEN_URL; if (oauth) auth++; else inference++;
				if (oauth !== stage.startsWith('oauth')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
				signal = init?.signal;
				if (stage.endsWith('headers')) { entered.resolve(); return late.promise; }
				return new Response(source, { status: stage === 'rejected-body' ? 429 : 200 });
			});
			const budget = createRequestDispatchBudget();
			const pending = driver(variant, route(variant), parent.signal, { deadlineAtMs: Date.now() + 1000, auxiliaryAuth: budget.auxiliaryAuth, beforeUpstreamDispatch: async () => { admission++; budget.consume(); } });
			await entered.promise; if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL'); else t.mock.timers.tick(1000);
			const result = await pending; const sent = stage.startsWith('oauth') ? 0 : 1;
			assert.equal(result.response.status, stage === 'rejected-body' ? 429 : stop === 'client' ? 499 : 504);
			assert.equal(result.meta.upstreamOutcomeUnknown === true, sent === 1 && stage !== 'rejected-body');
			assert.equal(result.meta.failoverForbidden, true); assert.equal(signal?.aborted, true);
			assert.equal(auth, 1); assert.equal(inference, sent); assert.equal(admission, sent);
			assert.equal(budget.snapshot().auxiliaryAuth.exchangesStarted, 1);
			assert.doesNotMatch(await result.response.text(), /PRIVATE_CANCEL_DETAIL|PRIVATE KEY/);
			if (stage.endsWith('headers')) late.resolve(new Response(source));
			await nextTurn(); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(inference, sent);
		});
	}
	it(`${variant}: retries cannot renew the 120s deadline`, { timeout: 5000 }, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 }); const entered = deferred<void>(); let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			sends++; if (sends === 1) { t.mock.timers.tick(80_000); return Response.json({}, { status: 429 }); }
			entered.resolve(); return new Promise<Response>(() => {});
		});
		const pending = proxy(variant, Array.from({ length: 5 }, (_, i) => route(variant, i, 'key')));
		await entered.promise; t.mock.timers.tick(AUDIO_TRANSCRIPTION_TIMEOUT_MS - 80_000);
		const result = await pending; assert.equal(result.response.status, 504); assert.equal(sends, 2); assert.equal(result.meta?.upstreamOutcomeUnknown, true); await result.response.text();
	});
	it(`${variant}: invalid auth Headers do not consume admission or inference`, async t => {
		let admission = 0; const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
		const result = await driver(variant, route(variant, 0, 'bad\nheader'), undefined, { beforeUpstreamDispatch: async () => { admission++; } });
		assert.equal(result.response.status, 502); assert.notEqual(result.meta.upstreamOutcomeUnknown, true); assert.equal(admission, 0); assert.equal(calls.mock.callCount(), 0); await result.response.text();
	});
}

for (const stage of ['query-headers', 'query-body', 'download-headers', 'download-body', 'redirect-cancel'] as const) for (const stop of ['client', 'deadline'] as const) {
	it(`async: ${stop} at ${stage} never resubmits an accepted task`, { timeout: 5000 }, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
		const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>(); let posts = 0; let reads = 0; let cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise<void>(() => {}); }, cancel() { cancels++; entered.resolve(); return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') { posts++; return success('async', input); }
			reads++; const query = String(input).includes('/tasks/');
			if (query && !stage.startsWith('query')) return success('async', input);
			if (stage.endsWith('headers')) { entered.resolve(); return late.promise; }
			return new Response(source, stage === 'redirect-cancel' ? { status: 302, headers: { Location: 'https://result.example/next.json' } } : {});
		});
		const pending = proxy('async', [route('async', 0, 'key'), route('async', 1, 'key')], parent.signal, { ...config, requestDeadlineAtMs: Date.now() + 1000 });
		await entered.promise; if (stop === 'client') parent.abort(); else t.mock.timers.tick(1000);
		const result = await pending; assert.equal(result.response.status, stop === 'client' ? 499 : 504);
		assert.equal(posts, 1); assert.equal(reads, stage.startsWith('query') ? 1 : 2); assert.equal(result.dispatchBudget?.permitsConsumed, 1);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.failoverForbidden, true); await result.response.text();
		if (stage.endsWith('headers')) late.resolve(new Response(source));
		await nextTurn(); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(posts, 1);
	});
}
for (const output of [
	{}, { task_status: 'UNKNOWN_FUTURE_STATUS' },
	{ task_status: 'SUCCEEDED', results: [{ subtask_status: 'PENDING' }] },
	{ task_status: 'SUCCEEDED', results: [{ subtask_status: 'UNKNOWN_FUTURE_STATUS' }] },
]) it(`async: unrecognized terminal state remains unknown: ${JSON.stringify(output)}`, async t => {
	let posts = 0; let queries = 0;
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === 'POST') { posts++; return success('async', input); }
		queries++; return Response.json({ output });
	});
	const result = await proxy('async', [route('async', 0, 'key'), route('async', 1, 'key')]);
	assert.equal(posts, 1); assert.equal(queries, 1); assert.equal(result.response.status, 502);
	assert.equal(result.meta?.failoverForbidden, true); assert.equal(result.meta?.upstreamOutcomeUnknown, true);
	await result.response.text();
});

for (const terminal of ['FAILED', 'SUBTASK_FAILED', 'PENDING_LIMIT'] as const) it(`async: ${terminal} cannot trigger a second paid task`, async t => {
	let posts = 0; let queries = 0;
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === 'POST') { posts++; return success('async', input); }
		queries++; return Response.json({ output: terminal === 'SUBTASK_FAILED'
			? { task_status: 'SUCCEEDED', results: [{ subtask_status: 'FAILED' }] }
			: { task_status: terminal === 'FAILED' ? 'FAILED' : 'PENDING' } });
	});
	const result = await proxy('async', [route('async', 0, 'key'), route('async', 1, 'key')]);
	assert.equal(result.response.status, 502); assert.equal(posts, 1); assert.equal(queries, terminal === 'PENDING_LIMIT' ? DASHSCOPE_ASYNC_MAX_POLLS : 1);
	assert.equal(result.meta?.failoverForbidden, true); assert.equal(result.meta?.upstreamOutcomeUnknown === true, terminal === 'PENDING_LIMIT'); await result.response.text();
});
