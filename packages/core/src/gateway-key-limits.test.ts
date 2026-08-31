import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildGatewayKeyLimitIntent,
	gatewayKeyLimitPeriodBounds,
	normalizeGatewayKeyLimitMicros,
} from './gateway-key-limits';
import type { ApiKeyRow } from './types';

const row: ApiKeyRow = {
	id: 'key-1',
	key: 'sk-preview',
	user_id: 'user-1',
	workspace_id: 'personal:user-1',
	name: null,
	status: 'active',
	metadata: null,
	expires_at: null,
	limit_micros: 10_000_000,
	limit_reset: 'weekly',
	include_byok_in_limit: false,
	limit_epoch: 2,
	last_used_at: null,
	created_at: '2026-08-01 12:00:00',
	updated_at: '2026-08-01 12:00:00',
};

test('Gateway key limit normalization uses integer micros', () => {
	assert.equal(normalizeGatewayKeyLimitMicros(null), null);
	assert.equal(normalizeGatewayKeyLimitMicros(12.345678), 12_345_678);
	assert.throws(() => normalizeGatewayKeyLimitMicros(-1), /non-negative/u);
});

test('weekly key limits reset on Monday UTC', () => {
	assert.deepEqual(
		gatewayKeyLimitPeriodBounds('weekly', new Date('2026-08-30T13:00:00Z'), row.created_at),
		{
			period: 'weekly',
			start: '2026-08-24T00:00:00.000Z',
			end: '2026-08-31T00:00:00.000Z',
		},
	);
});

test('Gateway key limit intent pins workspace, epoch, and window', () => {
	assert.deepEqual(buildGatewayKeyLimitIntent(row, new Date('2026-08-30T13:00:00Z')), {
		workspaceId: 'personal:user-1',
		assignmentId: 'gateway-key-limit:key-1',
		guardrailId: 'gateway-key-limit:key-1',
		guardrailVersion: 3,
		scopeType: 'api_key',
		scopeId: 'key-1',
		period: 'weekly',
		periodStart: '2026-08-24T00:00:00.000Z',
		periodEnd: '2026-08-31T00:00:00.000Z',
		limitMicros: 10_000_000,
	});
});

test('lifetime limits start at key creation', () => {
	assert.deepEqual(gatewayKeyLimitPeriodBounds(null, new Date(), row.created_at), {
		period: 'lifetime',
		start: '2026-08-01T12:00:00.000Z',
		end: '9999-12-31T23:59:59.999Z',
	});
});
