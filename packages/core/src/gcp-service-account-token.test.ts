import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
	clearGcpServiceAccountTokenCache,
	GCP_CLOUD_PLATFORM_SCOPE,
	GCP_OAUTH_TOKEN_URL,
	isGcpServiceAccountJson,
	parseGcpServiceAccountJson,
	resolveProviderUpstreamSecret,
	GcpTokenExchangeError, GCP_OAUTH_TIMEOUT_MS, GCP_OAUTH_MAX_RESPONSE_BYTES, GCP_TOKEN_CACHE_MAX_ENTRIES,
} from './gcp-service-account-token';
import { fingerprintProviderApiKey, maskProviderApiKeyForAdmin } from './db/provider-key-utils';
import { prepareGeminiUpstreamFetch, resolveGeminiAuthForUpstreamSecret } from './gemini-upstream-url';

const { privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
	type: 'service_account',
	project_id: 'demo',
	client_email: 'vertex@demo.iam.gserviceaccount.com',
	private_key: privateKey,
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function tokenResponse(token = 'synthetic-oauth-token', expires = 3600): Response {
	return Response.json({ access_token: token, expires_in: expires, token_type: 'Bearer' });
}
function oauthError(code: GcpTokenExchangeError['code']) {
	return (error: unknown) => error instanceof GcpTokenExchangeError && error.code === code;
}

function decodeJwtPayload(assertion: string): Record<string, unknown> {
	const payload = assertion.split('.')[1];
	assert.ok(payload);
	return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

afterEach(() => {
	clearGcpServiceAccountTokenCache();
});

describe('parseGcpServiceAccountJson', () => {
	it('recognizes a service account JSON', () => {
		const parsed = parseGcpServiceAccountJson(SERVICE_ACCOUNT_JSON);
		assert.ok(parsed);
		assert.equal(parsed.client_email, 'vertex@demo.iam.gserviceaccount.com');
		assert.equal(isGcpServiceAccountJson(SERVICE_ACCOUNT_JSON), true);
	});

	it('rejects ordinary API keys and incomplete JSON', () => {
		assert.equal(parseGcpServiceAccountJson('sk-vertex-api-key'), null);
		assert.equal(isGcpServiceAccountJson('sk-vertex-api-key'), false);
		assert.equal(parseGcpServiceAccountJson('{"type":"service_account"}'), null);
		assert.equal(
			parseGcpServiceAccountJson(
				JSON.stringify({ type: 'authorized_user', client_email: 'x', private_key: privateKey })
			),
			null
		);
	});
});

describe('resolveProviderUpstreamSecret', () => {
	it('returns ordinary keys unchanged', async () => {
		const resolved = await resolveProviderUpstreamSecret('sk-plain');
		assert.deepEqual(resolved, { secret: 'sk-plain', isServiceAccount: false });
	});

	it('exchanges a JWT assertion for an access token and caches it', async () => {
		let tokenCalls = 0;
		const fetchImpl: typeof fetch = async (input, init) => {
			tokenCalls += 1;
			assert.equal(String(input), GCP_OAUTH_TOKEN_URL);
			const body = String(init?.body ?? '');
			const params = new URLSearchParams(body);
			assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
			const assertion = params.get('assertion') ?? '';
			const claims = decodeJwtPayload(assertion);
			assert.equal(claims.iss, 'vertex@demo.iam.gserviceaccount.com');
			assert.equal(claims.aud, GCP_OAUTH_TOKEN_URL);
			assert.equal(claims.scope, GCP_CLOUD_PLATFORM_SCOPE);
			return new Response(JSON.stringify({ access_token: 'ya29.cached', expires_in: 3600, token_type: 'bEaReR' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		};

		const first = await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl, nowMs: () => 1_000 });
		const second = await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl, nowMs: () => 60_000 });
		assert.equal(first.isServiceAccount, true);
		assert.equal(first.secret, 'ya29.cached');
		assert.equal(first.clientEmail, 'vertex@demo.iam.gserviceaccount.com');
		assert.equal(second.secret, 'ya29.cached');
		assert.equal(tokenCalls, 1);
	});

	it('refreshes when the cached token is within the skew window', async () => {
		let tokenCalls = 0;
		const fetchImpl: typeof fetch = async () => {
			tokenCalls += 1;
			return new Response(JSON.stringify({ access_token: `ya29.${tokenCalls}`, expires_in: 3600 }), {
				status: 200,
			});
		};
		const t0 = 10_000_000;
		await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl, nowMs: () => t0 });
		await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, {
			fetchImpl,
			nowMs: () => t0 + 56 * 60 * 1000,
		});
		assert.equal(tokenCalls, 2);
	});
});

describe('provider key masking for service accounts', () => {
	it('does not leak the private key', () => {
		assert.equal(maskProviderApiKeyForAdmin(SERVICE_ACCOUNT_JSON), 'sa:vertex@demo.iam.gserviceaccount.com');
		assert.equal(fingerprintProviderApiKey(SERVICE_ACCOUNT_JSON), 'sa:….com');
		assert.equal(maskProviderApiKeyForAdmin(SERVICE_ACCOUNT_JSON).includes('BEGIN'), false);
		assert.equal(fingerprintProviderApiKey('sk-1234567890'), '…7890');
	});
});

describe('bounded request-owned OAuth', () => {
	it('rejects pre-cancelled ordinary and service-account secrets without crypto or fetch', async (t) => {
		const controller = new AbortController();
		controller.abort('private client reason');
		const digest = t.mock.method(crypto.subtle, 'digest', async () => { assert.fail('no crypto'); });
		for (const raw of ['ordinary-synthetic', SERVICE_ACCOUNT_JSON]) {
			await assert.rejects(resolveProviderUpstreamSecret(raw, { signal: controller.signal }), oauthError('cancelled'));
		}
		assert.equal(digest.mock.callCount(), 0);
	});

	for (const mode of ['cancelled', 'timeout'] as const) {
		it(`stops hung fetch on ${mode}, disposes late bodies and never caches them`, async (t) => {
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
			const controller = new AbortController();
			const entered = deferred<void>();
			const late = deferred<Response>();
			let signal: AbortSignal | null | undefined;
			const pending = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { signal: controller.signal, fetchImpl: async (_input, init) => {
				signal = init?.signal; assert.equal(init?.redirect, 'manual'); entered.resolve(); return late.promise;
			} });
			const rejected = assert.rejects(pending, oauthError(mode));
			await entered.promise;
			if (mode === 'cancelled') controller.abort('private cancellation reason');
			else t.mock.timers.tick(GCP_OAUTH_TIMEOUT_MS);
			await rejected;
			assert.equal(signal?.aborted, true);
			let cancelled = 0;
			late.resolve(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } })));
			await nextTurn();
			assert.equal(cancelled, 1);
			let calls = 0;
			const fresh = await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { calls++; return tokenResponse(); } });
			assert.equal(calls, 1);
			assert.equal(fresh.secret, 'synthetic-oauth-token');
		});
	}

	for (const mode of ['cancelled', 'timeout'] as const) {
		it(`stops body reading on ${mode} even when cancellation acknowledgement never settles`, async (t) => {
			t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
			const controller = new AbortController();
			const reading = deferred<void>();
			let cancelled = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull() { reading.resolve(); return new Promise<void>(() => {}); },
				cancel() { cancelled++; return new Promise<void>(() => {}); },
			}, { highWaterMark: 0 });
			const pending = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { signal: controller.signal, fetchImpl: async () => new Response(stream) });
			const rejected = assert.rejects(pending, oauthError(mode));
			await reading.promise;
			if (mode === 'cancelled') controller.abort('private reason'); else t.mock.timers.tick(GCP_OAUTH_TIMEOUT_MS);
			await rejected;
			assert.equal(cancelled, 1);
			assert.equal(stream.locked, false);
		});
	}

	it('does not renew the signing/fetch/body deadline when headers arrive', async (t) => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
		const reading = deferred<void>();
		const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); } }, { highWaterMark: 0 });
		const pending = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => {
			t.mock.timers.tick(GCP_OAUTH_TIMEOUT_MS - 1); return new Response(stream);
		} });
		const rejected = assert.rejects(pending, oauthError('timeout'));
		await reading.promise;
		t.mock.timers.tick(1);
		await rejected;
		assert.equal(stream.locked, false);
	});

	for (const declared of [false, true]) {
		it(`enforces response bytes (declared oversized=${declared})`, async () => {
			let pulls = 0;
			let cancelled = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(c) { pulls++; c.enqueue(new Uint8Array(GCP_OAUTH_MAX_RESPONSE_BYTES + 1)); },
				cancel() { cancelled++; },
			}, { highWaterMark: 0 });
			await assert.rejects(resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => new Response(stream, {
				headers: { 'content-length': String(declared ? GCP_OAUTH_MAX_RESPONSE_BYTES + 1 : 1) },
			}) }), oauthError('response_too_large'));
			assert.equal(pulls, declared ? 0 : 1);
			assert.equal(cancelled, 1);
			assert.equal(stream.locked, false);
		});
	}

	it('accepts exactly the byte limit across chunks and releases the reader on EOF', async () => {
		const text = JSON.stringify({ access_token: 'synthetic-exact', expires_in: 3600 }).padEnd(GCP_OAUTH_MAX_RESPONSE_BYTES, ' ');
		const bytes = new TextEncoder().encode(text);
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>({ pull(c) {
			if (offset === bytes.length) { c.close(); return; }
			const next = Math.min(bytes.length, offset + 37); c.enqueue(bytes.slice(offset, next)); offset = next;
		} });
		const result = await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => new Response(stream) });
		assert.equal(result.secret, 'synthetic-exact');
		assert.equal(stream.locked, false);
	});

	for (const status of [302, 400, 500]) {
		it(`rejects HTTP ${status} without reading or reflecting its body`, async () => {
			let cancelled = 0;
			const stream = new ReadableStream<Uint8Array>({ pull() { assert.fail('error body must not be read'); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
			await assert.rejects(resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => new Response(stream, { status }) }),
				(error: unknown) => error instanceof GcpTokenExchangeError && error.code === 'http_error' && error.status === status && error.message === 'GCP token exchange was rejected');
			assert.equal(cancelled, 1);
		});
	}

	for (const [label, payload] of [
		['null', null], ['array', []], ['missing token', { expires_in: 3600 }],
		['missing expiry', { access_token: 'synthetic' }],
		['negative expiry', { access_token: 'synthetic', expires_in: -1 }],
		['string expiry', { access_token: 'synthetic', expires_in: '3600' }],
		['header injection', { access_token: 'synthetic\r\nsecret', expires_in: 3600 }],
		['wrong token type', { access_token: 'synthetic', expires_in: 3600, token_type: 'Basic' }],
	] as const) {
		it(`rejects ${label} and does not cache it`, async () => {
			await assert.rejects(resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => Response.json(payload) }), oauthError('invalid_response'));
			let calls = 0;
			await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { calls++; return tokenResponse(); } });
			assert.equal(calls, 1);
		});
	}

	it('sanitizes raw transport and parser errors', async () => {
		await assert.rejects(resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { throw new Error('private JWT assertion'); } }),
			(error: unknown) => error instanceof GcpTokenExchangeError && error.message === 'GCP token exchange failed');
		await assert.rejects(resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => new Response('private non-JSON body') }), oauthError('invalid_response'));
	});

	it('isolates two simultaneous requests using the same account and only caches the survivor', async () => {
		const controller = new AbortController();
		const firstEntered = deferred<void>();
		const secondEntered = deferred<void>();
		const firstBody = deferred<Response>();
		const secondBody = deferred<Response>();
		const first = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { signal: controller.signal, fetchImpl: async () => { firstEntered.resolve(); return firstBody.promise; } });
		const rejected = assert.rejects(first, oauthError('cancelled'));
		await firstEntered.promise;
		const second = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async (_input, init) => {
			secondEntered.resolve(); const response = await secondBody.promise; assert.equal(init?.signal?.aborted, false); return response;
		} });
		await secondEntered.promise;
		controller.abort();
		await rejected;
		secondBody.resolve(tokenResponse('surviving-token'));
		assert.equal((await second).secret, 'surviving-token');
		firstBody.resolve(tokenResponse('cancelled-late-token'));
		await nextTurn();
		const cached = await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { assert.fail('should use completed survivor'); } });
		assert.equal(cached.secret, 'surviving-token');
	});

	it('clear prevents an old in-flight exchange from repopulating the cache', async () => {
		const entered = deferred<void>(); const late = deferred<Response>();
		const old = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { entered.resolve(); return late.promise; } });
		await entered.promise;
		clearGcpServiceAccountTokenCache();
		await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => tokenResponse('new-generation') });
		late.resolve(tokenResponse('old-generation')); await old;
		assert.equal((await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { assert.fail('cached'); } })).secret, 'new-generation');
	});

	it('does not reuse short-lived tokens or extend lifetime by response delay', async () => {
		let now = 1000; let calls = 0;
		const fetchImpl: typeof fetch = async () => { calls++; return tokenResponse('short', 1); };
		await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl, nowMs: () => now });
		await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl, nowMs: () => now });
		assert.equal(calls, 2);
		await assert.rejects(resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { nowMs: () => now, fetchImpl: async () => {
			now += 2000; return tokenResponse('already-expired', 1);
		} }), oauthError('invalid_response'));
	});

	it('bounds completed cache entries without limiting enrolled account count', async (t) => {
		t.mock.method(crypto.subtle, 'sign', async () => new ArrayBuffer(256)); // synthetic exchange, not a signature verification test
		const account = parseGcpServiceAccountJson(SERVICE_ACCOUNT_JSON)!;
		let calls = 0;
		const fetchImpl: typeof fetch = async () => { calls++; return tokenResponse(); };
		for (let i = 0; i <= GCP_TOKEN_CACHE_MAX_ENTRIES; i++) {
			await resolveProviderUpstreamSecret(JSON.stringify({ ...account, client_email: `cache-${i}@example.invalid` }), { fetchImpl });
		}
		await resolveProviderUpstreamSecret(JSON.stringify({ ...account, client_email: 'cache-0@example.invalid' }), { fetchImpl });
		assert.equal(calls, GCP_TOKEN_CACHE_MAX_ENTRIES + 2, 'oldest evicted, request still succeeds');
	});

	it('stops between private-key import and signing', async (t) => {
		const realKeys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign', 'verify']);
		assert.ok('privateKey' in realKeys);
		const entered = deferred<void>(); const imported = deferred<CryptoKey>();
		t.mock.method(crypto.subtle, 'importKey', () => { entered.resolve(); return imported.promise; });
		const sign = t.mock.method(crypto.subtle, 'sign', async () => { assert.fail('no signing after cancellation'); });
		const controller = new AbortController();
		const pending = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { signal: controller.signal, fetchImpl: async () => { assert.fail('no fetch'); } });
		const rejected = assert.rejects(pending, oauthError('cancelled'));
		await entered.promise; controller.abort(); await rejected;
		imported.resolve(realKeys.privateKey); await nextTurn();
		assert.equal(sign.mock.callCount(), 0);
	});

	for (const method of ['digest', 'sign'] as const) {
		it(`does not start subsequent work after cancellation during ${method}`, async (t) => {
			const entered = deferred<void>(); const cryptoWork = deferred<ArrayBuffer>();
			t.mock.method(crypto.subtle, method, () => { entered.resolve(); return cryptoWork.promise; });
			const controller = new AbortController();
			let fetches = 0;
			const pending = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { signal: controller.signal, fetchImpl: async () => { fetches++; return tokenResponse(); } });
			const rejected = assert.rejects(pending, oauthError('cancelled'));
			await entered.promise; controller.abort(); await rejected;
			cryptoWork.resolve(new ArrayBuffer(256)); await nextTurn();
			assert.equal(fetches, 0);
		});
	}

	it('checks elapsed time even when the timeout callback has not run', async (t) => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
		const entered = deferred<void>(); const response = deferred<Response>();
		const pending = resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl: async () => { entered.resolve(); return response.promise; } });
		const rejected = assert.rejects(pending, oauthError('timeout'));
		await entered.promise; t.mock.timers.setTime(Date.now() + GCP_OAUTH_TIMEOUT_MS);
		let cancelled = 0;
		response.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
		await rejected; assert.equal(cancelled, 1);
	});

	it('separates completed tokens by token endpoint as well as account/key', async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => { calls++; return tokenResponse(`endpoint-${calls}`); };
		const first = await resolveProviderUpstreamSecret(SERVICE_ACCOUNT_JSON, { fetchImpl });
		const raw = JSON.stringify({ ...parseGcpServiceAccountJson(SERVICE_ACCOUNT_JSON), token_uri: 'https://auth.example.invalid/token' });
		const second = await resolveProviderUpstreamSecret(raw, { fetchImpl });
		assert.notEqual(first.secret, second.secret);
		assert.equal(calls, 2);
	});
});

describe('resolveGeminiAuthForUpstreamSecret', () => {
	it('forces bearer for service accounts and keeps query-key for ordinary keys', () => {
		assert.equal(resolveGeminiAuthForUpstreamSecret('query-key', true), 'bearer');
		assert.equal(resolveGeminiAuthForUpstreamSecret(undefined, true), 'bearer');
		assert.equal(resolveGeminiAuthForUpstreamSecret('query-key', false), 'query-key');
		assert.equal(resolveGeminiAuthForUpstreamSecret(undefined, false), 'query-key');
	});

	it('does not put service account JSON into ?key=', () => {
		const { url, headers } = prepareGeminiUpstreamFetch({
			baseUrl: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models',
			modelName: 'gemini-2.5-flash',
			action: 'generateContent',
			apiKey: SERVICE_ACCOUNT_JSON,
			auth: resolveGeminiAuthForUpstreamSecret('query-key', true),
		});
		assert.equal(url.searchParams.has('key'), false);
		assert.equal(headers.Authorization, `Bearer ${SERVICE_ACCOUNT_JSON}`);
	});
});
