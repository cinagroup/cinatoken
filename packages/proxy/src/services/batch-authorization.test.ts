import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	GatewayRepositories,
	ResolvedGatewayKeyRow,
} from '@octafuse/core';
import { reauthorizeBatchGatewayKey } from './batch-authorization';

const LOOKUP_HASH = `sha256:${'a'.repeat(64)}`;

function row(
	overrides: Partial<ResolvedGatewayKeyRow> = {},
): ResolvedGatewayKeyRow {
	return {
		id: 'key-1',
		key: 'sk-test…1234',
		user_id: 'user-1',
		workspace_id: 'workspace-1',
		name: 'Batch',
		status: 'active',
		metadata: null,
		expires_at: null,
		limit_micros: null,
		limit_reset: null,
		include_byok_in_limit: false,
		limit_epoch: 0,
		last_used_at: null,
		created_at: '2026-09-05T00:00:00.000Z',
		updated_at: '2026-09-05T00:00:00.000Z',
		user_email: 'user@example.com',
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_max: null,
		budget_base: 0,
		budget_spent: 0,
		budget_period: 'none',
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
		...overrides,
	};
}

function repositories(resolved: ResolvedGatewayKeyRow | null) {
	let receivedHash: string | null = null;
	const repos = {
		apiKeys: {
			getActiveApiKeyWithUserByLookupHash: async (keyHash: string) => {
				receivedHash = keyHash;
				return resolved;
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, receivedHash: () => receivedHash };
}

test('Batch consumption reauthorizes by lookup hash and preserves BYOK identity', async () => {
	const fixture = repositories(row());
	const result = await reauthorizeBatchGatewayKey(fixture.repos, {
		api_key_hash: LOOKUP_HASH,
		user_id: 'user-1',
		workspace_id: 'workspace-1',
	});
	assert.equal(fixture.receivedHash(), LOOKUP_HASH);
	assert.equal(result.status, 'authorized');
	if (result.status !== 'authorized') throw new Error('expected authorization');
	assert.equal(result.apiKey.keyId, 'key-1');
	assert.equal(result.apiKey.apiKeyHash, 'a'.repeat(64));
});

test('Batch consumption fails closed for revoked state and tenant snapshot drift', async () => {
	const inactive = await reauthorizeBatchGatewayKey(repositories(null).repos, {
		api_key_hash: LOOKUP_HASH,
		user_id: 'user-1',
		workspace_id: 'workspace-1',
	});
	assert.deepEqual(inactive, { status: 'unauthorized', reason: 'inactive' });

	for (const resolved of [
		row({ user_id: 'different-user' }),
		row({ workspace_id: 'different-workspace' }),
	]) {
		assert.deepEqual(
			await reauthorizeBatchGatewayKey(repositories(resolved).repos, {
				api_key_hash: LOOKUP_HASH,
				user_id: 'user-1',
				workspace_id: 'workspace-1',
			}),
			{ status: 'unauthorized', reason: 'snapshot_mismatch' },
		);
	}
});
