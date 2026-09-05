import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InsertRequestLogParams } from './request-logs-types';
import {
	PUBLIC_MODEL_DAILY_STATS_SHARDS,
	toPublicModelDailyStatsDelta,
} from './public-model-daily-stats';

function requestLog(overrides: Partial<InsertRequestLogParams> = {}): InsertRequestLogParams {
	return {
		id: '7f858a9f-b55c-4fb9-a962-47f20b178b0e',
		userId: 'user-1',
		apiKeyId: 'key-1',
		workspaceId: 'personal:user-1',
		userEmail: null,
		modelId: 'vendor/model',
		providerId: 'provider-1',
		providerModelName: null,
		modelName: null,
		providerName: null,
		requestBody: null,
		upstreamRequestBody: null,
		requestProtocol: 'openai',
		upstreamProtocol: 'openai',
		inputTokens: 10,
		outputTokens: 25,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 35,
		meteredCost: 0,
		standardCost: 0,
		chargedCost: 0,
		routeGroup: 'default',
		status: 'success',
		latencyMs: 120,
		errorMessage: null,
		rawUsage: null,
		...overrides,
	};
}

test('builds a bounded deterministic public daily-stats delta', () => {
	const first = toPublicModelDailyStatsDelta(requestLog(), '2026-08-27T12:34:56.000Z');
	const second = toPublicModelDailyStatsDelta(requestLog(), '2026-08-27T23:59:59.000Z');
	assert.deepEqual(first, second);
	assert.equal(first.statDate, '2026-08-27');
	assert.equal(first.requestCount, 1);
	assert.equal(first.successCount, 1);
	assert.equal(first.errorCount, 0);
	assert.equal(first.outputTokens, 25);
	assert.equal(first.totalTokens, 35);
	assert.equal(first.latencyTotalMs, 120);
	assert.equal(first.latencySampleCount, 1);
	assert.ok(first.shard >= 0 && first.shard < PUBLIC_MODEL_DAILY_STATS_SHARDS);
});

test('normalizes unsafe telemetry values without changing request status counts', () => {
	const delta = toPublicModelDailyStatsDelta(requestLog({
		status: 'error',
		outputTokens: Number.NaN,
		totalTokens: Number.POSITIVE_INFINITY,
		latencyMs: -1,
	}), '2026-08-27T00:00:00.000Z');
	assert.equal(delta.successCount, 0);
	assert.equal(delta.errorCount, 1);
	assert.equal(delta.outputTokens, 0);
	assert.equal(delta.totalTokens, 0);
	assert.equal(delta.latencyTotalMs, 0);
	assert.equal(delta.latencySampleCount, 0);
});

test('rejects a non-ISO aggregation timestamp', () => {
	assert.throws(() => toPublicModelDailyStatsDelta(requestLog(), 'not-a-date'), /YYYY-MM-DD/);
});
