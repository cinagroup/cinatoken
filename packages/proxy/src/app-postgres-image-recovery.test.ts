import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StorageContext } from '@octafuse/core';
import { createProxyApp } from './app';
import { createRequestCapacityPool } from './services/request-capacity';
import { drainNodeResourceWork } from './runtime/schedule-resource-completion';
import type { PostgresImageRecoveryAuthorities } from './services/image-usage-recovery-postgres';

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const apiKeyRow = {
	id: 'key-1', key: 'sk-local', user_id: 'user-1', workspace_id: 'workspace-1',
	name: 'Local', status: 'active', metadata: null, expires_at: null,
	limit_micros: null, limit_reset: null, include_byok_in_limit: false,
	limit_epoch: 0, last_used_at: null, created_at: '2026-09-24T00:00:00.000Z',
	updated_at: '2026-09-24T00:00:00.000Z', user_email: null,
	user_metadata: null, user_charged_cost_factors: null, budget_max: null,
	budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
	budget_epoch: 0, budget_reserved_micros: 0,
};
const repos = { apiKeys: { async getApiKeyWithUserByKey(key: string) {
	return key === 'sk-local' ? apiKeyRow : null;
} } };
const storage = { client: { driver: 'postgres', raw: {} }, repositories: repos } as unknown as StorageContext;
const imageRequest = { method: 'POST', headers: { Authorization: 'Bearer sk-local', 'Content-Type': 'application/json' }, body: '{}' };
const authorities = {
	claimProducer: { driver: 'postgres', raw: {} },
	factProducer: { driver: 'postgres', raw: {} },
} as PostgresImageRecoveryAuthorities;

test('PostgreSQL Images composition is explicit, capacity-backed and exclusive of D1 recovery', () => {
	const open = async () => ({ authorities, async close() {} });
	assert.throws(() => createProxyApp(async () => storage, {
		postgresImageRecovery: { maxAttempts: 1, open },
	}), /requires explicit HTTP capacity/);
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	assert.throws(() => createProxyApp(async () => storage, {
		httpCapacity: { pool, reservedBytesPerRequest: 1 },
		imageUsageRecovery: { settlementLeaseSeconds: 5 },
		postgresImageRecovery: { maxAttempts: 1, open },
	}), /mutually exclusive/);
});

test('only Images POST opens producers; close confirmation owns capacity after response', async () => {
	const closed = deferred();
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	let opened = 0, closeStarted = 0;
	const app = createProxyApp(async () => storage, {
		httpCapacity: { pool, reservedBytesPerRequest: 1 },
		postgresImageRecovery: { maxAttempts: 1, async open() {
			opened++;
			return { authorities, close() { closeStarted++; return closed.promise; } };
		} },
	});
	const ordinary = await app.request('/api/v1/does-not-exist', { method: 'POST' });
	await ordinary.text();
	assert.equal(opened, 0);
	assert.equal(pool.snapshot().requests, 0);
	const unauthenticated = await app.request('/api/v1/images/edits', { method: 'POST' }, {});
	assert.equal(unauthenticated.status, 401);
	await unauthenticated.text();
	assert.equal(opened, 0);
	const invalidKey = await app.request('/v1/images/generations', {
		...imageRequest, headers: { ...imageRequest.headers, Authorization: 'Bearer sk-invalid' },
	}, {});
	assert.equal(invalidKey.status, 401);
	await invalidKey.text();
	assert.equal(opened, 0);
	const image = await app.request('/api/v1/images/edits', imageRequest, {});
	await image.text();
	assert.equal(opened, 1);
	assert.equal(closeStarted, 1);
	assert.equal(pool.snapshot().requests, 1);
	const blocked = await app.request('/v1/images/generations', imageRequest, {});
	assert.equal(blocked.status, 503);
	await blocked.text();
	assert.equal(opened, 1);
	closed.resolve();
	await drainNodeResourceWork();
	assert.equal(pool.snapshot().requests, 0);
});

test('wrong storage driver fails closed before producer origins are opened', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	let opened = 0;
	const app = createProxyApp(async () => ({ client: { driver: 'd1' }, repositories: repos }) as unknown as StorageContext, {
		httpCapacity: { pool, reservedBytesPerRequest: 1 },
		postgresImageRecovery: { maxAttempts: 1, async open() {
			opened++;
			return { authorities, async close() {} };
		} },
	});
	const response = await app.request('/v1/images/generations', imageRequest, {});
	assert.equal(response.status, 500);
	await response.text();
	assert.equal(opened, 0);
	assert.equal(pool.snapshot().requests, 0);
});

test('unconfirmed producer close keeps the request capacity reservation', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	const app = createProxyApp(async () => storage, {
		httpCapacity: { pool, reservedBytesPerRequest: 1 },
		postgresImageRecovery: { maxAttempts: 1, async open() {
			return { authorities, async close() { throw new Error('synthetic close uncertainty'); } };
		} },
	});
	const response = await app.request('/v1/images/generations', imageRequest, {});
	await response.text();
	await drainNodeResourceWork();
	assert.equal(pool.snapshot().requests, 1);
	const denied = await app.request('/v1/images/generations', imageRequest, {});
	assert.equal(denied.status, 503);
	await denied.text();
});

test('unconfirmed partial producer open keeps capacity; confirmed open failure releases it', async () => {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	let attempts = 0;
	const app = createProxyApp(async () => storage, {
		httpCapacity: { pool, reservedBytesPerRequest: 1 },
		postgresImageRecovery: { maxAttempts: 1, async open() {
			attempts++;
			if (attempts === 1) throw new Error('confirmed preflight failure');
			const failure = new Error('partial producer cleanup unconfirmed');
			failure.name = 'PostgresImageProducerCleanupUnconfirmedError';
			throw failure;
		} },
	});
	const first = await app.request('/v1/images/generations', imageRequest, {});
	assert.equal(first.status, 500);
	await first.text();
	assert.equal(pool.snapshot().requests, 0);
	const second = await app.request('/v1/images/generations', imageRequest, {});
	assert.equal(second.status, 500);
	await second.text();
	await drainNodeResourceWork();
	assert.equal(pool.snapshot().requests, 1);
	const blocked = await app.request('/v1/images/generations', imageRequest, {});
	assert.equal(blocked.status, 503);
	await blocked.text();
	assert.equal(attempts, 2);
});
