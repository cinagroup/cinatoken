import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { afterEach, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Hono } from 'hono';
import { clearGcpServiceAccountTokenCache, createRequestAuxiliaryAuthBudget, createRequestDeadline,
	GCP_OAUTH_TOKEN_URL, RequestExecutionStoppedError, type ModelWithRouteCountsRow, type ProviderRow } from '@octafuse/core';
import { invokePlaygroundUpstream, applyPlaygroundUpstreamCredential, resolvePlaygroundRoute } from './playground-service';
import { AdminServiceError } from './errors';
import { handleAdminRouteError } from '../../routes/admin/error-response';
import { PLAYGROUND_MAX_CONTROL_RESPONSE_BYTES, PLAYGROUND_REQUEST_DEADLINE_MS, readPlaygroundJson, waitPlaygroundPoll } from './playground-request-lifecycle';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'synthetic@example.invalid', private_key: privateKey });
const TOKEN = 'synthetic-preview-oauth-token';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearGcpServiceAccountTokenCache(); });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
async function until(check: () => boolean) {
	const end = performance.now() + 3_000;
	while (!check()) { if (performance.now() >= end) throw new Error('Local test observation timed out'); await nextTurn(); }
}
function status(expected: number) {
	return (error: unknown) => error instanceof AdminServiceError && error.status === expected;
}

function fixture(protocol = 'gemini', key = ACCOUNT, operation = 'chat') {
	const provider: ProviderRow = {
		id: 'p1', name: 'Synthetic', api_key: key, status: 'active', description: null, created_at: '2026-09-05',
		endpoints: JSON.stringify({
			openai: { base: 'https://model.example.invalid/v1' },
			anthropic: { base: 'https://model.example.invalid/v1' },
			gemini: { base: 'https://model.example.invalid/v1/models', auth: 'bearer' },
			dashscope: { base: 'https://model.example.invalid/api/v1' },
		}),
	};
	const model: ModelWithRouteCountsRow = {
		id: 'm1', display_name: 'Synthetic', vendor: 'test', context_window: null, max_tokens: 128,
		pricing_profile: protocol === 'dashscope' ? JSON.stringify({ audio_billing_mode: 'per_second', audio: { price_per_second: 0.001 } }) : null,
		tags: '[]', description: null, metadata: null, input_modalities: null, output_modalities: null,
		released_at: null, route_policy: null, created_at: '2026-09-05', routes_count: 1, active_routes_count: 1,
	};
	const repos: Parameters<typeof invokePlaygroundUpstream>[0] = {
		routes: { async getModelRouteRowById(id) { return { id, model_id: 'm1', provider_id: 'p1', provider_model_name: 'synthetic-model',
			priority: 0, status: 'active', price_override: null, custom_params: null, upstream_protocol: protocol,
			upstream_operation: operation, adapter: operation === 'audio.transcriptions.async' ? 'dashscope-asr-file-async' : 'passthrough' }; } },
		providers: { async getProvidersByIds(ids) { assert.deepEqual(ids, ['p1']); return [provider]; } },
		models: { async getModelDetailWithRouteCounts() { return model; } },
	};
	return { repos, provider, model };
}
const INPUT = { routeId: 'r1', body: { messages: [{ role: 'user', content: 'synthetic' }] } };
function oauthResponse() { return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3600 })); }

it('Admin Worker config opts into incoming Request.signal cancellation', () => {
	assert.match(readFileSync(new URL('../../../wrangler.base.jsonc', import.meta.url), 'utf8'),
		/"compatibility_flags":\s*\[[^\]]*"enable_request_signal"/);
	const config: unknown = JSON.parse(readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8'));
	assert.ok(config && typeof config === 'object' && 'compatibility_flags' in config && Array.isArray(config.compatibility_flags));
	assert.ok(config.compatibility_flags.includes('enable_request_signal'));
});

for (const protocol of ['openai', 'anthropic', 'gemini', 'dashscope']) {
	it(`preview ${protocol} plain credential has one manual-redirect POST and streams bytes`, async () => {
		const f = fixture(protocol, 'synthetic-key', protocol === 'dashscope' ? 'audio.transcriptions.multimodal' : 'chat');
		let calls = 0;
		globalThis.fetch = async (_url, init) => {
			calls++;
			assert.equal(init?.method, 'POST');
			assert.equal(init?.redirect, 'manual');
			assert.equal(init?.signal?.aborted, false);
			return new Response('synthetic-stream', { headers: { 'content-type': 'text/event-stream', 'x-test': 'yes' } });
		};
		const response = await invokePlaygroundUpstream(f.repos, INPUT);
		assert.equal(await response.response.text(), 'synthetic-stream');
		assert.equal(response.response.headers.get('x-test'), 'yes');
		assert.equal(calls, 1);
	});
}
for (const protocol of ['openai', 'gemini']) {
	it(`preview ${protocol} reuses only completed OAuth data across independent requests`, async () => {
		const f = fixture(protocol);
		let oauth = 0, model = 0;
		globalThis.fetch = async (url, init) => {
			if (String(url) === GCP_OAUTH_TOKEN_URL) { oauth++; return oauthResponse(); }
			model++;
			assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${TOKEN}`);
			assert.ok(!String(url).includes(ACCOUNT));
			return new Response('ok');
		};
		for (let i = 0; i < 2; i++) assert.equal(await (await invokePlaygroundUpstream(f.repos, INPUT)).response.text(), 'ok');
		assert.equal(oauth, 1);
		assert.equal(model, 2);
	});
}

it('exhausted preview auth budget blocks a cold exchange but not a completed cache hit', async () => {
	const f = fixture();
	const route = await resolvePlaygroundRoute(f.repos, 'r1');
	const budget = createRequestAuxiliaryAuthBudget(1);
	budget.consume();
	let calls = 0;
	globalThis.fetch = async () => { calls++; return oauthResponse(); };
	await assert.rejects(applyPlaygroundUpstreamCredential(route, { auxiliaryAuth: budget }), status(429));
	assert.equal(calls, 0);
	await applyPlaygroundUpstreamCredential(route);
	assert.equal((await applyPlaygroundUpstreamCredential(route, { auxiliaryAuth: budget })).providerApiKey, TOKEN);
	assert.equal(calls, 1);
});

for (const phase of ['route', 'provider', 'model'] as const) {
	it(`preview cancelled during ${phase} read never resumes into OAuth or inference`, async () => {
		const f = fixture();
		const gate = deferred<void>();
		let entered = false, calls = 0;
		const pause = async () => { entered = true; await gate.promise; };
		if (phase === 'route') {
			const read = f.repos.routes.getModelRouteRowById;
			f.repos.routes.getModelRouteRowById = async id => { await pause(); return read(id); };
		} else if (phase === 'provider') f.repos.providers.getProvidersByIds = async () => { await pause(); return [f.provider]; };
		else f.repos.models.getModelDetailWithRouteCounts = async () => { await pause(); return f.model; };
		globalThis.fetch = async () => { calls++; throw new Error('Must not fetch'); };
		const parent = new AbortController();
		const promise = invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
		const rejected = assert.rejects(promise, status(499));
		await until(() => entered);
		parent.abort('untrusted-abort-secret');
		await rejected;
		gate.resolve();
		await nextTurn();
		assert.equal(calls, 0);
		assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
	});
}

it('pre-cancelled preview cannot query repositories or fetch', async () => {
	const f = fixture();
	let reads = 0;
	f.repos.routes.getModelRouteRowById = async () => { reads++; return null; };
	globalThis.fetch = async () => { throw new Error('Must not fetch'); };
	await assert.rejects(invokePlaygroundUpstream(f.repos, INPUT, AbortSignal.abort('secret')), status(499));
	assert.equal(reads, 0);
});

it('preview retains an already-started compatibility write until acknowledgement', async () => {
	const f = fixture();
	const gate = deferred<void>();
	let entered = false, settled = false, calls = 0;
	f.repos.providers.getProvidersByIds = async (_ids, control) => {
		assert.ok(control);
		await control.runOwnedMutation(async () => { entered = true; await gate.promise; });
		return [f.provider];
	};
	globalThis.fetch = async () => { calls++; return oauthResponse(); };
	const parent = new AbortController();
	const pending = invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
	void pending.then(() => { settled = true; }, () => { settled = true; });
	const rejected = assert.rejects(pending, status(499));
	await until(() => entered);
	parent.abort();
	await nextTurn();
	assert.equal(settled, false);
	gate.resolve();
	await rejected;
	assert.equal(calls, 0);
});

for (const stop of ['cancel', 'timeout'] as const) {
	it(`preview OAuth ${stop} cannot send model request or cache late token`, async t => {
		const f = fixture();
		const gate = deferred<Response>();
		const parent = new AbortController();
		let oauth = 0, models = 0, discarded = 0;
		if (stop === 'timeout') t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		globalThis.fetch = async (url) => {
			if (String(url) === GCP_OAUTH_TOKEN_URL) { oauth++; return oauth === 1 ? gate.promise : oauthResponse(); }
			models++;
			return new Response('ok');
		};
		const pending = invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
		const rejected = assert.rejects(pending, status(stop === 'cancel' ? 499 : 504));
		await until(() => oauth === 1);
		if (stop === 'cancel') parent.abort('secret'); else t.mock.timers.tick(30_001);
		await rejected;
		gate.resolve(new Response(new ReadableStream({ cancel() { discarded++; } })));
		await until(() => discarded === 1);
		assert.equal(models, 0);
		assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
		assert.equal(await (await invokePlaygroundUpstream(f.repos, INPUT)).response.text(), 'ok');
		assert.equal(oauth, 2);
		assert.equal(models, 1);
	});
}

it('model preparation time consumes the same preview deadline, not a renewed OAuth window', async t => {
	const f = fixture();
	const now = Date.now();
	t.mock.timers.enable({ apis: ['Date'], now });
	f.repos.models.getModelDetailWithRouteCounts = async () => { t.mock.timers.setTime(now + PLAYGROUND_REQUEST_DEADLINE_MS); return f.model; };
	let calls = 0;
	globalThis.fetch = async () => { calls++; return oauthResponse(); };
	await assert.rejects(invokePlaygroundUpstream(f.repos, INPUT), status(504));
	assert.equal(calls, 0);
});

for (const stop of ['cancel', 'timeout'] as const) {
	it(`preview ${stop} bounds an unread model stream without awaiting cancellation acknowledgement`, async t => {
		if (stop === 'timeout') t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
		const f = fixture('openai', 'synthetic-key');
		let cancelled = 0;
		globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } }));
		const parent = new AbortController();
		const result = await invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
		if (stop === 'cancel') parent.abort(); else t.mock.timers.tick(PLAYGROUND_REQUEST_DEADLINE_MS);
		await assert.rejects(result.response.text(), RequestExecutionStoppedError);
		assert.equal(cancelled, 1);
		assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
	});
}

it('stopped model fetch disposes its late response and never retries POST', async () => {
	const f = fixture('openai', 'synthetic-key');
	const gate = deferred<Response>();
	let calls = 0, cancelled = 0;
	globalThis.fetch = async () => { calls++; return gate.promise; };
	const parent = new AbortController();
	const pending = invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
	const rejected = assert.rejects(pending, status(499));
	await until(() => calls === 1);
	parent.abort();
	await rejected;
	gate.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
	await until(() => cancelled === 1);
	assert.equal(calls, 1);
});

for (const declared of [false, true]) {
	it(`preview bounds control JSON declared=${declared}`, async () => {
		const owner = createRequestDeadline(Date.now() + 5_000);
		let cancelled = 0;
		const response = new Response(new ReadableStream({ start(target) { target.enqueue(new Uint8Array(PLAYGROUND_MAX_CONTROL_RESPONSE_BYTES + 1)); }, cancel() { cancelled++; } }),
			{ headers: declared ? { 'content-length': String(PLAYGROUND_MAX_CONTROL_RESPONSE_BYTES + 1) } : {} });
		try { await assert.rejects(readPlaygroundJson(response, owner), status(502)); assert.equal(cancelled, 1); }
		finally { owner.dispose(); }
	});
}

it('completed poll waits do not accumulate abort listeners; cancellation removes the current wait', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const parent = new AbortController();
	const owner = createRequestDeadline(Date.now() + 120_000, parent.signal);
	try {
		for (let i = 0; i < 12; i++) {
			const wait = waitPlaygroundPoll(owner);
			assert.equal(getEventListeners(owner.signal, 'abort').length, 1);
			t.mock.timers.tick(1000);
			await wait;
			assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
		}
		const wait = waitPlaygroundPoll(owner);
		const rejected = assert.rejects(wait, RequestExecutionStoppedError);
		parent.abort();
		await rejected;
		assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
	} finally { owner.dispose(); }
});

it('preview errors retain the Admin JSON contract without reflecting transport secrets', async () => {
	const f = fixture('openai', 'synthetic-key');
	globalThis.fetch = async () => { throw new Error('Bearer secret-from-transport https://signed.example/?token=secret'); };
	const app = new Hono();
	app.get('/', async c => {
		try { return (await invokePlaygroundUpstream(f.repos, INPUT)).response; }
		catch (error) { return handleAdminRouteError(c, error, 'Unexpected'); }
	});
	const response = await app.request('/');
	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), { success: false, message: 'Playground upstream request failed' });
});

it('preview OAuth body cancellation is bounded even when its reader will not acknowledge cancel', async () => {
	const f = fixture();
	const parent = new AbortController();
	let entered = false, cancelled = 0, models = 0;
	globalThis.fetch = async url => {
		if (String(url) !== GCP_OAUTH_TOKEN_URL) { models++; throw new Error('Must not dispatch'); }
		return new Response(new ReadableStream({ start() { entered = true; }, cancel() { cancelled++; return new Promise<void>(() => {}); } }));
	};
	const pending = invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
	const rejected = assert.rejects(pending, status(499));
	await until(() => entered);
	parent.abort();
	await rejected;
	assert.equal(cancelled, 1);
	assert.equal(models, 0);
});

it('preview OAuth receives only the remaining total deadline after slow preparation', async t => {
	const f = fixture();
	const now = Date.now();
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
	f.repos.models.getModelDetailWithRouteCounts = async () => { t.mock.timers.setTime(now + PLAYGROUND_REQUEST_DEADLINE_MS - 10); return f.model; };
	let calls = 0;
	globalThis.fetch = async () => { calls++; return new Promise<Response>(() => {}); };
	const pending = invokePlaygroundUpstream(f.repos, INPUT);
	const rejected = assert.rejects(pending, status(504));
	await until(() => calls === 1);
	t.mock.timers.tick(11);
	await rejected;
	assert.equal(calls, 1);
});

it('a provider 307 is returned without repeating a billable POST, and EOF releases the parent', async () => {
	const f = fixture('openai', 'synthetic-key');
	const parent = new AbortController();
	let calls = 0;
	globalThis.fetch = async (_url, init) => {
		calls++;
		assert.equal(init?.redirect, 'manual');
		return new Response('redirect', { status: 307, headers: { location: 'https://must-not-follow.example.invalid/' } });
	};
	const result = await invokePlaygroundUpstream(f.repos, INPUT, parent.signal);
	assert.equal(result.response.status, 307);
	assert.equal(await result.response.text(), 'redirect');
	assert.equal(calls, 1);
	assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

for (const resultStatus of [200, 403]) {
	it(`preview async ASR polls one task then handles result HTTP ${resultStatus}`, async t => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const f = fixture('dashscope', 'synthetic-key', 'audio.transcriptions.async');
		let submits = 0, polls = 0, downloads = 0;
		globalThis.fetch = async (url, init) => {
			if (init?.method === 'POST') { submits++; return Response.json({ output: { task_id: 'synthetic-task' } }); }
			if (String(url).includes('/tasks/')) {
				polls++;
				return Response.json({ output: polls < 3 ? { task_status: 'RUNNING' }
					: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.example.invalid/asr' }] } });
			}
			downloads++;
			assert.equal(new Headers(init?.headers).get('authorization'), null);
			return Response.json({ transcripts: [{ text: 'synthetic transcript' }] }, { status: resultStatus });
		};
		const pending = invokePlaygroundUpstream(f.repos, { routeId: 'r1', body: { file_url: 'https://input.example.invalid/audio.wav' } });
		const observed = resultStatus === 403 ? assert.rejects(pending, status(502)) : pending;
		await until(() => submits === 1);
		for (let i = 0; i < 3; i++) { await nextTurn(); t.mock.timers.tick(1000); await until(() => polls === i + 1); }
		await observed;
		if (resultStatus === 200) {
			const result: unknown = await (await pending).response.json();
			assert.ok(result && typeof result === 'object' && 'output' in result);
			assert.deepEqual(result.output, { text: 'synthetic transcript' });
		}
		assert.equal(submits, 1);
		assert.equal(downloads, 1);
	});
}

it('cancelled async ASR query cannot resume polling or download a late result', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = fixture('dashscope', 'synthetic-key', 'audio.transcriptions.async');
	const gate = deferred<Response>();
	const parent = new AbortController();
	let submits = 0, polls = 0, discarded = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method === 'POST') { submits++; return Response.json({ output: { task_id: 'synthetic-task' } }); }
		polls++;
		return gate.promise;
	};
	const pending = invokePlaygroundUpstream(f.repos, { routeId: 'r1', body: { file_url: 'https://input.example.invalid/audio.wav' } }, parent.signal);
	const rejected = assert.rejects(pending, status(499));
	await until(() => submits === 1);
	await nextTurn(); t.mock.timers.tick(1000);
	await until(() => polls === 1);
	parent.abort();
	await rejected;
	gate.resolve(new Response(new ReadableStream({ cancel() { discarded++; } })));
	await until(() => discarded === 1);
	t.mock.timers.tick(60_000);
	assert.equal(submits, 1);
	assert.equal(polls, 1);
});

it('TTS downloads stream media with no provider credential and keep cancellation live', async () => {
	const f = fixture('dashscope', 'synthetic-key', 'audio.speech');
	const parent = new AbortController();
	let calls = 0, cancelled = 0;
	globalThis.fetch = async (_url, init) => {
		calls++;
		if (init?.method === 'POST') return Response.json({ output: { audio: { url: 'https://audio.example.invalid/result' } } });
		assert.equal(new Headers(init?.headers).get('authorization'), null);
		return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'audio/mpeg' } });
	};
	const result = await invokePlaygroundUpstream(f.repos, { routeId: 'r1', body: { input: 'synthetic', voice: 'test' } }, parent.signal);
	assert.equal(result.response.headers.get('content-type'), 'audio/mpeg');
	parent.abort();
	await assert.rejects(result.response.text(), RequestExecutionStoppedError);
	assert.equal(calls, 2);
	assert.equal(cancelled, 1);
});

it('a late download redirect cannot start another fetch after preview cancellation', async () => {
	const f = fixture('dashscope', 'synthetic-key', 'audio.speech');
	const parent = new AbortController();
	const gate = deferred<Response>();
	let downloads = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method === 'POST') return Response.json({ output: { audio: { url: 'https://audio.example.invalid/result' } } });
		downloads++;
		return gate.promise;
	};
	const pending = invokePlaygroundUpstream(f.repos, { routeId: 'r1', body: { input: 'synthetic', voice: 'test' } }, parent.signal);
	const rejected = assert.rejects(pending, status(499));
	await until(() => downloads === 1);
	parent.abort();
	await rejected;
	gate.resolve(new Response(null, { status: 307, headers: { location: 'https://must-not-follow.example.invalid/' } }));
	await nextTurn();
	assert.equal(downloads, 1);
});

it('transient Postgres failures still reach the shared Admin 503 mapper', async () => {
	const f = fixture();
	const failure = Object.assign(new Error('synthetic db failure'), { code: 'CONNECTION_CLOSED' });
	f.repos.routes.getModelRouteRowById = async () => { throw failure; };
	const app = new Hono();
	app.get('/', async c => {
		try { return (await invokePlaygroundUpstream(f.repos, INPUT)).response; }
		catch (error) { return handleAdminRouteError(c, error, 'Unexpected'); }
	});
	const response = await app.request('/');
	assert.equal(response.status, 503);
	assert.ok(!(await response.text()).includes('synthetic db failure'));
});
