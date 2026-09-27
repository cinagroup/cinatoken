import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { GatewayRepositories } from '@octafuse/core';
import type { AdminEnv } from '@/lib/admin-env';
import { adminEarningsRoutes } from './earnings';

function appFor(logs: Array<{ id: string; provider_key_id: string | null }>, total = logs.length) {
	let ledgerReadsOrWrites = 0;
	let logReads = 0;
	const repositories = {
		requestLogs: {
			async getRequestLogs(options: { page: number; pageSize: number; startDate: string }) {
				assert.equal(options.page, 1);
				assert.equal(options.pageSize, 200);
				assert.equal(options.startDate, '2026-09-01T00:00:00.000Z');
				logReads++;
				return { logs, total };
			},
		},
		sharedKeys: {
			async getSharedKeyById() { ledgerReadsOrWrites++; throw new Error('current key must not supply historical price or owner'); },
			async addSharedKeyUsage() { ledgerReadsOrWrites++; throw new Error('historical usage must not be incremented'); },
		},
		systemConfig: {
			async getConfig() { ledgerReadsOrWrites++; throw new Error('current commission must not price history'); },
		},
		portalLedger: {
			async ensureUserEarnings() { ledgerReadsOrWrites++; throw new Error('historical ledger must not be written'); },
			async recordEarningAndCredit() { ledgerReadsOrWrites++; throw new Error('historical ledger must not be written'); },
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use('*', async (c, next) => {
		c.set('repositories', repositories);
		c.set('principal', { type: 'console', id: 'console:test', username: 'test' });
		await next();
	});
	app.route('/admin/earnings', adminEarningsRoutes);
	return { app, counts: () => ({ logReads, ledgerReadsOrWrites }) };
}

const endpoint = '/admin/earnings/rederive?since=2026-09-01T00%3A00%3A00.000Z';

test('historical apply returns review candidates without repricing or crediting from current state', async () => {
	const { app, counts } = appFor([
		{ id: 'historical-shared', provider_key_id: 'sharedkey:key-1' },
		{ id: 'ordinary', provider_key_id: 'provider:key-2' },
	]);
	const response = await app.request(`${endpoint}&apply=1`, { method: 'POST' });
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		success: false,
		dryRun: false,
		error: 'Historical shared-key earnings require original price, commission, and owner evidence',
		code: 'historical_earning_evidence_required',
		data: {
			windowSince: '2026-09-01T00:00:00.000Z', scanned: 2, windowTotal: 2, scanComplete: true,
			candidates: 1, reviewRequired: 1, requestLogIds: ['historical-shared'],
		},
	});
	assert.deepEqual(counts(), { logReads: 1, ledgerReadsOrWrites: 0 });
});

test('dry run and empty apply remain read-only', async () => {
	const nonShared = [{ id: 'ordinary', provider_key_id: 'provider:key-2' }];
	const { app, counts } = appFor(nonShared);
	const dryRun = await app.request(endpoint, { method: 'POST' });
	assert.equal(dryRun.status, 200);
	assert.deepEqual(await dryRun.json(), {
		success: true, dryRun: true,
		data: { windowSince: '2026-09-01T00:00:00.000Z', scanned: 1, windowTotal: 1, scanComplete: true, candidates: 0, reviewRequired: 0 },
	});
	const apply = await app.request(`${endpoint}&apply=1`, { method: 'POST' });
	assert.equal(apply.status, 200);
	assert.deepEqual(await apply.json(), {
		success: true, dryRun: false,
		data: { windowSince: '2026-09-01T00:00:00.000Z', scanned: 1, windowTotal: 1, scanComplete: true, candidates: 0, reviewRequired: 0 },
	});
	assert.deepEqual(counts(), { logReads: 2, ledgerReadsOrWrites: 0 });
});

test('empty first-page candidates do not make incomplete historical apply look complete', async () => {
	const { app, counts } = appFor([{ id: 'ordinary', provider_key_id: 'provider:key-2' }], 3);
	const dryRun = await app.request(endpoint, { method: 'POST' });
	assert.equal(dryRun.status, 200);
	assert.deepEqual(await dryRun.json(), {
		success: true, dryRun: true,
		data: { windowSince: '2026-09-01T00:00:00.000Z', scanned: 1, windowTotal: 3, scanComplete: false, candidates: 0, reviewRequired: 0 },
	});
	const apply = await app.request(`${endpoint}&apply=1`, { method: 'POST' });
	assert.equal(apply.status, 409);
	assert.deepEqual(await apply.json(), {
		success: false, dryRun: false,
		error: 'Historical shared-key earnings scan is incomplete; later pages require review',
		code: 'historical_earning_scan_incomplete',
		data: {
			windowSince: '2026-09-01T00:00:00.000Z', scanned: 1, windowTotal: 3,
			scanComplete: false, candidates: 0, reviewRequired: 0, requestLogIds: [],
		},
	});
	assert.deepEqual(counts(), { logReads: 2, ledgerReadsOrWrites: 0 });
});
