import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { GatewayRepositories, SharedKeyRow } from '@octafuse/core';
import type { UserEnv } from './user-env';
import { userSharedKeysRoutes } from './routes/user/shared-keys';
import {
	projectSellerCreditedUsageWithSignedClaims,
	requestSignedSellerStatsClaim,
} from './shared-key-signed-stats-reader';

const STATS_COOKIE = '__Host-cinatoken_stats_session=' + 'a'.repeat(48);
const NONCE = '12345678-1234-4234-8234-123456789abc';

const key = (id: string): SharedKeyRow => ({
	id, sellerUserId: 'seller-a', channelType: 'openai', apiKey: 'sk-synthetic-secret',
	keyFingerprint: `${id}-fingerprint`, label: null, status: 'active',
	sellerPriority: 0, weight: 1, inputPrice: 1, outputPrice: 2,
	cacheReadPrice: null, cacheWritePrice: null, validatedAt: null,
	lastUsedAt: null, lastFailureAt: null, failureReason: null,
	servedInputTokens: 1, servedOutputTokens: 2, earnedTotal: 3,
	earnedTotalExact: '3.000000', createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-01T00:00:00.000Z',
});

function claim(overrides: Record<string, unknown> = {}) {
	return {
		keyId: 'current', sellerUserId: 'seller-a', keyIds: ['key-a', 'key-b'],
		expiresEpoch: Math.floor(Date.now() / 1000) + 120,
		nonce: NONCE, signatureHex: 'ab'.repeat(32), ...overrides,
	};
}

test('issuer sees only independent session cookie and canonical key request', async () => {
	let seen: Request | undefined;
	const issuer = { fetch: async (request: Request) => {
		seen = request;
		return Response.json(claim());
	} } as Pick<Fetcher, 'fetch'>;
	const request = new Request('https://cinatoken.com/api/user/shared-keys', {
		headers: { cookie: `cinatoken_session=mutable; ${STATS_COOKIE}; other=secret` },
	});
	const signed = await requestSignedSellerStatsClaim(issuer, request,
		'seller-a', ['key-b', 'key-a']);
	assert.deepEqual(signed.keyIds, ['key-a', 'key-b']);
	assert.equal(seen?.headers.get('cookie'), STATS_COOKIE);
	assert.equal(seen?.method, 'POST');
	assert.equal(new URL(seen!.url).hostname, 'cinatoken-stats-issuer.internal');
	assert.deepEqual(await seen!.json(), { keyIds: ['key-a', 'key-b'] });
});

test('mutable portal cookie, duplicate independent cookie, and issuer scope drift fail closed', async () => {
	let calls = 0;
	let issued = claim();
	const issuer = { fetch: async () => { calls++; return Response.json(issued); } } as Pick<Fetcher, 'fetch'>;
	const request = (cookie: string) => new Request('https://cinatoken.com/api/user/shared-keys',
		{ headers: { cookie } });
	await assert.rejects(requestSignedSellerStatsClaim(issuer,
		request('cinatoken_session=forged'), 'seller-a', ['key-a', 'key-b']),
		/shared_key_stats_independent_session_required/);
	await assert.rejects(requestSignedSellerStatsClaim(issuer,
		request(`${STATS_COOKIE}; ${STATS_COOKIE}`), 'seller-a', ['key-a', 'key-b']),
		/shared_key_stats_independent_session_required/);
	assert.equal(calls, 0);
	for (const bad of [
		{ sellerUserId: 'seller-b' }, { keyIds: ['key-a'] },
		{ expiresEpoch: Math.floor(Date.now() / 1000) + 301 },
		{ signatureHex: 'bad' },
	]) {
		issued = claim(bad);
		await assert.rejects(requestSignedSellerStatsClaim(issuer,
			request(STATS_COOKIE), 'seller-a', ['key-a', 'key-b']),
			/shared_key_stats_claim_issuer_scope_mismatch/);
	}
});

test('signed seller route cannot fall back to the ordinary runtime SQL client', async () => {
	let ordinaryReads = 0;
	const rows = [key('key-a')];
	const repositories = {
		client: { driver: 'postgres', raw: { unsafe: async () => { ordinaryReads++; return []; } } },
		sharedKeys: { listSharedKeysBySeller: async () => rows },
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.onError((error, c) => c.json({ code: error.message }, 500));
	app.use('*', async (c, next) => {
		c.set('repositories', repositories);
		c.set('principal', { userId: 'seller-a', subject: 'subject-a',
			email: 'seller-a@example.invalid', isAdmin: false, capabilities: [] });
		await next();
	});
	app.route('/user/shared-keys', userSharedKeysRoutes);
	const noBindings = await app.request('/user/shared-keys',
		{ headers: { cookie: STATS_COOKIE } },
		{ SIGNED_SELLER_STATS_READER: 'reviewed-v1' });
	assert.equal(noBindings.status, 500);
	assert.deepEqual(await noBindings.json(), { code: 'shared_key_stats_independent_bindings_required' });
	assert.equal(ordinaryReads, 0);
	const sameConnection = await app.request('/user/shared-keys',
		{ headers: { cookie: STATS_COOKIE } },
		{ SIGNED_SELLER_STATS_READER: 'reviewed-v1',
			HYPERDRIVE: { connectionString: 'postgres://runtime' },
			STATS_READER_HYPERDRIVE: { connectionString: 'postgres://runtime' },
			STATS_CLAIM_ISSUER: { fetch: async () => Response.json(claim({ keyIds: ['key-a'] })) } as unknown as Fetcher });
	assert.equal(sameConnection.status, 500);
	assert.deepEqual(await sameConnection.json(), { code: 'shared_key_stats_reader_binding_reuses_runtime' });
	assert.equal(ordinaryReads, 0);
	await assert.rejects(projectSellerCreditedUsageWithSignedClaims(repositories,
		rows, 'seller-a', new Request('https://cinatoken.com',
			{ headers: { cookie: 'cinatoken_session=mutable' } }),
		{ STATS_CLAIM_ISSUER: { fetch: async () => Response.json(claim({ keyIds: ['key-a'] })) } as unknown as Fetcher,
			STATS_READER_HYPERDRIVE: { connectionString: 'postgres://reader' } }),
		/shared_key_stats_independent_session_required/);
	assert.equal(ordinaryReads, 0);
});
