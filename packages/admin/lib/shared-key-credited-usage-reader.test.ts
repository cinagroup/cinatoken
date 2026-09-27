import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { GatewayRepositories, SharedKeyRow } from '@octafuse/core';
import type { AdminEnv } from './admin-env';
import type { UserEnv } from './user-env';
import { adminSharedKeysRoutes } from './routes/admin/shared-keys';
import { userSharedKeysRoutes } from './routes/user/shared-keys';
import { projectCurrentSellerCreditedUsage } from './shared-key-credited-usage-reader';

const key = (id: string, sellerUserId: string): SharedKeyRow => ({
	id, sellerUserId, channelType: 'openai', apiKey: 'sk-synthetic-key-secret',
	keyFingerprint: `${id}-fingerprint`, label: null, status: 'active',
	sellerPriority: 0, weight: 1, inputPrice: 1, outputPrice: 2,
	cacheReadPrice: null, cacheWritePrice: null, validatedAt: null,
	lastUsedAt: null, lastFailureAt: null, failureReason: null,
	servedInputTokens: 999, servedOutputTokens: 999, earnedTotal: 999,
	earnedTotalExact: '999.000000', createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-01T00:00:00.000Z',
});

const credited = (id: string, seller: string, net = '5625000') => ({
	shared_key_id: id, seller_user_id: seller, input_tokens: '1000010',
	output_tokens: '2000020', net_micros: net,
	last_credited_at: '2026-09-25T00:00:00.000Z',
});

function fixture(rows: SharedKeyRow[], results = rows.map((row) => credited(row.id, row.sellerUserId)),
	error?: Error) {
	const calls: Array<{ seller: string; ids: string[] }> = [];
	const repositories = {
		client: { driver: 'postgres', raw: {
			unsafe: async (_sql: string, args: [string, string[]]) => {
				if (error) throw error;
				calls.push({ seller: args[0], ids: args[1] });
				return results.filter((item) => args[1].includes(item.shared_key_id)
					&& item.seller_user_id === args[0]);
			},
		} },
		sharedKeys: {
			listSharedKeysBySeller: async (seller: string) => rows.filter((row) => row.sellerUserId === seller),
			listAllSharedKeys: async () => rows,
		},
		users: { getById: async (id: string) => ({ email: `${id}@example.invalid` }) },
	} as unknown as GatewayRepositories;
	return { repositories, calls };
}

test('response projection uses exact credited micros and refuses owner or numeric drift', async () => {
	const current = key('key-1', 'seller-new');
	const { repositories, calls } = fixture([current]);
	const rows = await projectCurrentSellerCreditedUsage(repositories, [current], 'seller-new');
	assert.deepEqual(calls, [{ seller: 'seller-new', ids: ['key-1'] }]);
	assert.equal(rows[0]?.earnedTotal, 5.625);
	assert.equal(rows[0]?.earnedTotalExact, '5.625000');
	assert.equal(rows[0]?.servedInputTokens, 1000010);
	assert.equal(rows[0]?.lastUsedAt, '2026-09-25T00:00:00.000Z');
	assert.equal(current.earnedTotal, 999);
	await assert.rejects(projectCurrentSellerCreditedUsage(repositories, [current], 'seller-old'),
		/shared_key_stats_reader_seller_scope_mismatch/);
	await assert.rejects(projectCurrentSellerCreditedUsage(
		fixture([current], [credited('key-1', 'seller-old')]).repositories, [current]),
		/shared_key_stats_reader_missing_result/);
	await assert.rejects(projectCurrentSellerCreditedUsage(
		fixture([current], [credited('key-1', 'seller-new', '9007199254740992')]).repositories, [current]),
		/shared_key_stats_reader_count_exceeds_safe_range/);
});

test('seller and admin list routes default off and project only on exact opt-in', async () => {
	const { repositories, calls } = fixture([key('key-old', 'seller-old'), key('key-new', 'seller-new')]);
	const seller = new Hono<UserEnv>();
	seller.use('*', async (c, next) => {
		c.set('repositories', repositories);
		c.set('principal', { userId: 'seller-new', subject: 'subject-new',
			email: 'seller-new@example.invalid', isAdmin: false, capabilities: [] });
		await next();
	});
	seller.route('/user/shared-keys', userSharedKeysRoutes);
	const old = await seller.request('/user/shared-keys');
	assert.equal(old.status, 200);
	const oldData = ((await old.json()) as { data: SharedKeyRow[] }).data;
	assert.deepEqual(oldData.map((row: SharedKeyRow) => row.id), ['key-new']);
	assert.equal(oldData[0].earnedTotal, 999);
	assert.equal(calls.length, 0);
	const next = await seller.request('/user/shared-keys', {},
		{ SHARED_KEY_CREDITED_USAGE_READER: 'reviewed-v1' });
	assert.equal(next.status, 200);
	const nextData = ((await next.json()) as { data: SharedKeyRow[] }).data;
	assert.deepEqual(nextData.map((row: SharedKeyRow) => row.id), ['key-new']);
	assert.equal(nextData[0].earnedTotal, 5.625);
	assert.deepEqual(calls, [{ seller: 'seller-new', ids: ['key-new'] }]);

	const admin = new Hono<AdminEnv>();
	admin.use('*', async (c, following) => {
		c.set('repositories', repositories);
		c.set('principal', { type: 'console', id: 'console:test', username: 'test' });
		await following();
	});
	admin.route('/admin/shared-keys', adminSharedKeysRoutes);
	const adminResponse = await admin.request('/admin/shared-keys', {},
		{ SHARED_KEY_CREDITED_USAGE_READER: 'reviewed-v1' });
	assert.equal(adminResponse.status, 200);
	const adminData = ((await adminResponse.json()) as { data: SharedKeyRow[] }).data;
	assert.deepEqual(adminData.map((row: SharedKeyRow) => row.earnedTotal), [5.625, 5.625]);
	assert.deepEqual(calls.slice(1), [
		{ seller: 'seller-old', ids: ['key-old'] },
		{ seller: 'seller-new', ids: ['key-new'] },
	]);
});

test('enabled reader fails closed when the SQL readiness gate is absent', async () => {
	const current = key('key-new', 'seller-new');
	const f = fixture([current], [credited('key-new', 'seller-new')],
		new Error('shared_key_stats_reader_not_active'));
	await assert.rejects(projectCurrentSellerCreditedUsage(f.repositories, [current]),
		/shared_key_stats_reader_not_active/);
});
