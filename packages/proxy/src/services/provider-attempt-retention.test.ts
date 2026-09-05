import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assertProviderAttemptRetentionConfig,
	resolveProviderAttemptRetentionConfig,
	runProviderAttemptRetention,
} from './provider-attempt-retention';

test('provider attempt retention resolves strict bounded configuration', () => {
	assert.deepEqual(resolveProviderAttemptRetentionConfig({}), {
		retentionDays: 7,
		batchSize: 5_000,
		maxBatches: 10,
	});
	assert.deepEqual(resolveProviderAttemptRetentionConfig({
		PROVIDER_ATTEMPT_RETENTION_DAYS: '14',
		PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE: '250',
		PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES: '4',
	}), { retentionDays: 14, batchSize: 250, maxBatches: 4 });
	for (const environment of [
		{ PROVIDER_ATTEMPT_RETENTION_DAYS: '1' },
		{ PROVIDER_ATTEMPT_RETENTION_BATCH_SIZE: '5001' },
		{ PROVIDER_ATTEMPT_RETENTION_MAX_BATCHES: '0' },
		{ PROVIDER_ATTEMPT_RETENTION_DAYS: '2.5' },
	]) {
		assert.throws(() => resolveProviderAttemptRetentionConfig(environment), /must be an integer/u);
	}
	assert.doesNotThrow(() => assertProviderAttemptRetentionConfig({
		retentionDays: 7,
		batchSize: 5_000,
		maxBatches: 10,
	}));
	for (const config of [
		{ retentionDays: 1, batchSize: 5_000, maxBatches: 10 },
		{ retentionDays: 7, batchSize: 5_001, maxBatches: 10 },
		{ retentionDays: 7, batchSize: 5_000, maxBatches: 21 },
	]) {
		assert.throws(() => assertProviderAttemptRetentionConfig(config), /config is invalid/u);
	}
});

test('provider attempt retention drains oldest facts in bounded batches', async () => {
	const calls: Array<{ cutoffIso: string; limit: number }> = [];
	const pending = [5, 5, 2];
	const result = await runProviderAttemptRetention({
		repository: {
			async deleteProviderAttemptAvailabilityBefore(options) {
				calls.push(options);
				return pending.shift() ?? 0;
			},
		},
		nowMs: Date.parse('2026-09-02T12:00:00.000Z'),
		config: { retentionDays: 7, batchSize: 5, maxBatches: 10 },
	});
	assert.deepEqual(result, {
		cutoffIso: '2026-08-26T12:00:00.000Z',
		deleted: 12,
		batches: 3,
		saturated: false,
	});
	assert.equal(calls.length, 3);
	assert.deepEqual(new Set(calls.map((call) => call.cutoffIso)),
		new Set(['2026-08-26T12:00:00.000Z']));
	assert.deepEqual(calls.map((call) => call.limit), [5, 5, 5]);
});

test('provider attempt retention reports bounded backlog saturation', async () => {
	const result = await runProviderAttemptRetention({
		repository: {
			async deleteProviderAttemptAvailabilityBefore() { return 3; },
		},
		nowMs: 0,
		config: { retentionDays: 2, batchSize: 3, maxBatches: 2 },
	});
	assert.equal(result.deleted, 6);
	assert.equal(result.batches, 2);
	assert.equal(result.saturated, true);
});

test('provider attempt retention rejects forged config and scheduled times before storage', async () => {
	let calls = 0;
	const repository = {
		async deleteProviderAttemptAvailabilityBefore() {
			calls += 1;
			return 0;
		},
	};
	await assert.rejects(() => runProviderAttemptRetention({
		repository,
		nowMs: Date.now(),
		config: { retentionDays: 1, batchSize: 5_000, maxBatches: 10 },
	}), /config is invalid/u);
	await assert.rejects(() => runProviderAttemptRetention({
		repository,
		nowMs: Number.MAX_SAFE_INTEGER,
		config: { retentionDays: 7, batchSize: 5_000, maxBatches: 10 },
	}), /scheduled time is invalid/u);
	assert.equal(calls, 0);
});
