import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { D1Database } from '@cloudflare/workers-types';
import { clearGcpServiceAccountTokenCache, createD1StorageContext, GCP_OAUTH_TOKEN_URL, resolveProviderUpstreamSecret, type ByokRuntimeKeyRow, type SharedKeyRow } from '@octafuse/core';
import { proxyAudioSpeech, type AudioSpeechProxyOptions } from '../proxy';
import { createRequestDispatchBudget } from '../request-dispatch-budget';
import { RequestBudgetAdmissionError } from '../request-budget-admission';
import { GatewayErrorCode } from '../gateway-error-codes';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker';
import type { RouteResult } from '../model-router';
import {
	dispatchOpenAiAudioSpeech, dispatchDashScopeSpeechSynthesizer, dispatchDashScopeQwenTts, dispatchDashScopeMiniMaxTts,
	AUDIO_SPEECH_TIMEOUT_MS, AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES,
	type NormalizedAudioSpeechRequest, type AudioSpeechDispatchOptions,
} from './audio-speech-driver';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const credential = (id = 'test') => JSON.stringify({ type: 'service_account', client_email: `${id}@example.invalid`, private_key: privateKey });
type Variant = 'openai' | 'speech' | 'qwen' | 'minimax';
const variants: Variant[] = ['openai', 'speech', 'qwen', 'minimax'];
const audio: NormalizedAudioSpeechRequest = { input: 'hello', voice: 'synthetic', responseFormat: 'wav', speed: 1, streamFormat: 'audio' };
const config: AudioSpeechProxyOptions = { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority' };
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
	return { targetId: 'target-' + index, modelSurfaceId: null, routePoolId: null,
		providerId: 'provider-' + index, providerName: 'Synthetic', providerModelName: 'synthetic-tts',
		upstreamProtocol: variant === 'openai' ? 'openai' : 'dashscope',
		upstreamOperation: variant === 'openai' || variant === 'speech' ? 'audio.speech' : 'audio.speech.multimodal',
		adapter: variant === 'openai' ? 'passthrough' : variant === 'speech' ? 'dashscope-tts-speech' : variant === 'qwen' ? 'dashscope-tts-qwen' : 'dashscope-tts-minimax',
		providerEndpoints: { openai: { base: 'https://upstream.example/v1' }, dashscope: { base: 'https://upstream.example/api/v1' } },
		providerApiKey: key, providerSharedChannelType: null, priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: null, routeGroup: 'default', routePriority: 100 - index, routeWeight: 1 };
}
function driver(variant: Variant, candidate: RouteResult, signal?: AbortSignal, options: AudioSpeechDispatchOptions = {}, request = audio) {
	const dispatch = variant === 'openai' ? dispatchOpenAiAudioSpeech : variant === 'speech' ? dispatchDashScopeSpeechSynthesizer
		: variant === 'qwen' ? dispatchDashScopeQwenTts : dispatchDashScopeMiniMaxTts;
	return dispatch(candidate, request, signal, undefined, undefined, options);
}
function proxy(variant: Variant, candidates: RouteResult[], signal?: AbortSignal, options: AudioSpeechProxyOptions = config, repos = repositories(), request = audio) {
	return proxyAudioSpeech(repos, candidates, request, signal, options);
}
function event(variant: Variant, terminal = false): Uint8Array {
	const value = variant === 'openai' ? terminal
		? { type: 'speech.audio.done', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }
		: { type: 'speech.audio.delta', audio: 'AQID' }
		: { output: variant === 'minimax' ? { data: { audio: '010203', status: terminal ? 2 : 1 } }
			: { audio: { data: 'AQID' }, finish_reason: terminal ? 'stop' : null },
			usage: { characters: 5, input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
	return new TextEncoder().encode('data: ' + JSON.stringify(value) + '\n\n');
}
function success(variant: Variant, _input?: RequestInfo | URL): Response {
	return variant === 'openai' ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } })
		: new Response(event(variant, true), { headers: { 'Content-Type': 'text/event-stream' } });
}
beforeEach(() => { clearGcpServiceAccountTokenCache(); resetProviderCircuitStateForTests(); });


for (const outcome of ['client', 'rejected', 'accepted'] as const) it('openai: owned cloning source stops while fetch still holds its reader (' + outcome + ')', { timeout: 5000 }, async () => {
	const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
	let upload: ReadableStream<Uint8Array> | undefined;
	let uploadReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const pending = driver('openai', route('openai', 0, 'key'), parent.signal, {
		fetchImpl: async (_input, init) => {
			assert.ok(init?.body instanceof ReadableStream); upload = init.body; uploadReader = upload.getReader();
			assert.equal((await uploadReader.read()).done, false);
			entered.resolve();
			return outcome === 'client' ? late.promise : outcome === 'rejected' ? Response.json({}, { status: 503 }) : success('openai');
		},
	}, { ...audio, inputReferences: [{ type: 'input_audio', inputAudio: { bytes: new Uint8Array(0x12000), encoding: { kind: 'raw_base64' } } }] });
	await entered.promise; if (outcome === 'client') parent.abort();
	const result = await pending;
	assert.equal(result.response.status, outcome === 'client' ? 499 : outcome === 'rejected' ? 503 : 200);
	assert.ok(uploadReader); await assert.rejects(uploadReader.read(), { message: 'Audio speech upload stopped' });
	uploadReader.releaseLock(); assert.equal(upload?.locked, false);
	await result.response.arrayBuffer(); await result.usagePromise;
	if (outcome === 'client') { late.resolve(success('openai')); await nextTurn(); }
});

// Exercise the actual driver owner, including transports that ignore abort or
// never acknowledge cancellation. Time advances are local mock timers.
for (const variant of variants) {
	for (const stage of ['oauth-headers', 'oauth-body', 'inference-headers', 'rejected-body', 'first-sse'] as const) {
		if (stage === 'first-sse' && variant === 'openai') continue;
		for (const stop of ['client', 'deadline'] as const) {
			it(`${variant}: ${stop} at ${stage} cancels without ACK or replay`, { timeout: 5000 }, async t => {
				t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
				const parent = new AbortController(); const entered = deferred<void>(); const late = deferred<Response>();
				let auth = 0; let sends = 0; let admission = 0; let cancels = 0; let signal: AbortSignal | null | undefined;
				const source = new ReadableStream<Uint8Array>({
					pull() { entered.resolve(); return new Promise<void>(() => {}); },
					cancel() { cancels++; return new Promise<void>(() => {}); },
				}, { highWaterMark: 0 });
				t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
					const oauth = String(input) === GCP_OAUTH_TOKEN_URL; if (oauth) auth++; else sends++;
					if (oauth !== stage.startsWith('oauth')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
					signal = init?.signal;
					if (stage.endsWith('headers')) { entered.resolve(); return late.promise; }
					return new Response(source, { status: stage === 'rejected-body' ? 400 : 200, headers: { 'Content-Type': 'text/event-stream' } });
				});
				const budget = createRequestDispatchBudget();
				const pending = driver(variant, route(variant), parent.signal, {
					deadlineAtMs: Date.now() + 1000, auxiliaryAuth: budget.auxiliaryAuth,
					beforeUpstreamDispatch: async () => { admission++; budget.consume(); },
				});
				await entered.promise;
				if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL'); else t.mock.timers.tick(1000);
				const result = await pending; const sent = stage.startsWith('oauth') ? 0 : 1;
				assert.equal(result.response.status, stage === 'rejected-body' ? 400 : stop === 'client' ? 499 : 504);
				assert.equal(result.meta?.upstreamOutcomeUnknown === true, sent === 1 && stage !== 'rejected-body');
				assert.equal(result.meta?.failoverForbidden, true); assert.equal(signal?.aborted, true);
				assert.equal(auth, 1); assert.equal(sends, sent); assert.equal(admission, sent);
				assert.equal(budget.snapshot().auxiliaryAuth.exchangesStarted, 1);
				assert.doesNotMatch(await result.response.text(), /PRIVATE_CANCEL_DETAIL|PRIVATE KEY/);
				if (stage.endsWith('headers')) late.resolve(new Response(source));
				await nextTurn(); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(sends, sent);
			});
		}
	}
	it(`${variant}: retries cannot renew the 300s ceiling`, { timeout: 5000 }, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
		const entered = deferred<void>(); let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			sends++; if (sends === 1) { t.mock.timers.tick(200_000); return Response.json({}, { status: 429 }); }
			entered.resolve(); return new Promise<Response>(() => {});
		});
		const pending = proxy(variant, Array.from({ length: 5 }, (_, i) => route(variant, i, 'key')));
		await entered.promise; t.mock.timers.tick(AUDIO_SPEECH_TIMEOUT_MS - 200_000);
		const result = await pending;
		assert.equal(result.response.status, 504); assert.equal(sends, 2); assert.equal(result.meta?.upstreamOutcomeUnknown, true); await result.response.text();
	});
	for (const stop of ['client', 'deadline'] as const) it(`${variant}: ${stop} before auth never dispatches`, async t => {
		const parent = new AbortController(); if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL');
		let admission = 0;
		const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
		const result = await driver(variant, route(variant), parent.signal, { deadlineAtMs: stop === 'deadline' ? Date.now() - 1 : undefined, beforeUpstreamDispatch: async () => { admission++; } });
		assert.equal(result.response.status, stop === 'client' ? 499 : 504);
		assert.notEqual(result.meta?.upstreamOutcomeUnknown, true); assert.equal(admission, 0); assert.equal(calls.mock.callCount(), 0); await result.response.text();
	});
	it(`${variant}: invalid auth Headers do not consume admission`, async t => {
		let admission = 0; const calls = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected inference'); });
		const result = await driver(variant, route(variant, 0, 'bad\nheader'), undefined, { beforeUpstreamDispatch: async () => { admission++; } });
		assert.equal(result.response.status, 502); assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(admission, 0); assert.equal(calls.mock.callCount(), 0); await result.response.text();
	});
	it(`${variant}: bounds explicit non-OK bodies without waiting for cancellation`, { timeout: 5000 }, async () => {
		let cancels = 0; let admission = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES + 1)); }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		const result = await driver(variant, route(variant, 0, 'key'), undefined, { fetchImpl: async () => new Response(source, { status: 400 }), beforeUpstreamDispatch: async () => { admission++; } });
		assert.equal(result.response.status, 400); assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(admission, 1); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.ok((await result.response.text()).length < AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES);
	});
	for (const streamFormat of ['audio', 'sse'] as const) for (const stop of ['client', 'deadline', 'downstream'] as const) for (const pulling of [false, true]) {
		it(`${variant}/${streamFormat}: ${stop} settles once (pending pull=${pulling})`, { timeout: 5000 }, async t => {
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
			const parent = new AbortController(); const entered = deferred<void>();
			let cancels = 0; let sends = 0; let signal: AbortSignal | null | undefined; let settlements = 0;
			const source = new ReadableStream<Uint8Array>({
				start(c) { if (variant !== 'openai') c.enqueue(event(variant)); },
				pull() { entered.resolve(); return new Promise<void>(() => {}); },
				cancel() { cancels++; return new Promise<void>(() => {}); },
			}, { highWaterMark: 0 });
			const result = await proxy(variant, [route(variant, 0, 'key'), route(variant, 1, 'key')], parent.signal, {
				...config, deadlineAtMs: Date.now() + 1000,
				fetchImpl: async (_input, init) => { sends++; signal = init?.signal; return new Response(source, { headers: { 'Content-Type': variant === 'openai' && streamFormat === 'audio' ? 'audio/wav' : 'text/event-stream' } }); },
			}, repositories(), { ...audio, streamFormat });
			assert.equal(result.response.status, 200);
			void result.usagePromise.then(() => { settlements++; });
			const reader = result.response.body!.getReader();
			if (pulling && variant !== 'openai') assert.equal((await reader.read()).done, false);
			const read = pulling ? reader.read() : null;
			// Attach rejection ownership before causing abort.
			const stoppedRead = read && stop !== 'downstream' ? assert.rejects(read, /Audio speech request/) : null;
			if (pulling) await entered.promise;
			if (stop === 'client') parent.abort('PRIVATE_CANCEL_DETAIL');
			else if (stop === 'deadline') t.mock.timers.tick(1000);
			else await reader.cancel('PRIVATE_CANCEL_DETAIL');
			if (stoppedRead) await stoppedRead;
			if (read && stop === 'downstream') assert.equal((await read).done, true);
			const usage = await result.usagePromise;
			assert.equal(usage.cancelled === true, stop !== 'deadline');
			if (stop === 'deadline') assert.equal(usage.stream_error, 'Audio speech request deadline exceeded');
			assert.doesNotMatch(JSON.stringify(usage), /PRIVATE_CANCEL_DETAIL/);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true); assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(sends, 1);
			if (stop !== 'downstream') assert.equal(signal?.aborted, true);
			parent.abort(); t.mock.timers.tick(10_000); await nextTurn();
			assert.equal(settlements, 1); assert.equal(cancels, 1);
			if (!pulling && stop !== 'downstream') await assert.rejects(reader.read(), /Audio speech request/);
			reader.releaseLock();
		});
	}
	for (const malformed of [false, true]) it(`${variant}: protocol ${malformed ? 'failure' : 'terminal'} settles without HTTP EOF/ACK`, { timeout: 5000 }, async t => {
		let cancels = 0;
		const source = new ReadableStream<Uint8Array>({
			start(c) { c.enqueue(malformed ? new TextEncoder().encode('data: PRIVATE_MALFORMED_FRAME\n\n') : event(variant, true)); },
			cancel() { cancels++; return new Promise<void>(() => {}); },
		}, { highWaterMark: 0 });
		const result = await driver(variant, route(variant, 0, 'key'), undefined, {
			fetchImpl: async () => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
		}, { ...audio, streamFormat: 'sse' });
		if (malformed && variant === 'openai') await assert.rejects(result.response.text(), { message: 'Audio speech stream failed' });
		else {
			const text = await result.response.text();
			assert.doesNotMatch(text, /PRIVATE_MALFORMED_FRAME/);
			if (!malformed) assert.match(text, /speech.audio.done/);
			else assert.equal(result.response.status, 502);
		}
		const usage = await result.usagePromise;
		if (!malformed) { assert.equal(usage.total_tokens, 5); assert.notEqual(usage.cancelled, true); assert.equal(usage.stream_error, undefined); }
		assert.equal(result.meta?.upstreamOutcomeUnknown === true, malformed);
		assert.equal(cancels, 1); assert.equal(source.locked, false);
	});
}

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
			assert.equal(String(input), GCP_OAUTH_TOKEN_URL, 'no TTS inference is allowed');
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
		assert.equal(result.response.status, 200); assert.equal(sends, 1);
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
}
