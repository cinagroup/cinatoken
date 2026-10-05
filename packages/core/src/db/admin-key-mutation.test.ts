import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesAdminUserAuditSnapshot } from './admin-key-mutation';
import { userRowToSnapshot } from './user-audit-snapshot';

test('MySQL/Postgres decimal locking reads match the same canonical user snapshot as getById', () => {
	const expected = userRowToSnapshot({
		id: 'u1', email: 'user@example.test',
		budget_max: 10, budget_base: 10, budget_spent: 3,
		budget_period: 'monthly', budget_reset_at: '2026-10-01T00:00:00.000Z',
		budget_epoch: 2, budget_reserved_micros: 125,
		status: 'active', metadata: '{"z":1,"a":2}',
		charged_cost_factors: null, external_system: null, external_user_id: null,
		created_at: '', updated_at: '',
	});
	const locked = {
		id: 'u1', email: 'user@example.test',
		budgetMax: '10.000000', budgetBase: '10.000000', budgetSpent: '3.000000',
		budgetPeriod: 'monthly', budgetResetAt: '2026-10-01T00:00:00.000Z',
		budgetEpoch: 2, budgetReservedMicros: 125,
		status: 'active', metadata: '{"z":1,"a":2}',
		chargedCostFactors: null, externalSystem: null, externalUserId: null,
	};
	assert.equal(matchesAdminUserAuditSnapshot(locked, expected), true);
	assert.equal(matchesAdminUserAuditSnapshot({ ...locked, budgetSpent: '3.000001' }, expected), false);
	assert.equal(matchesAdminUserAuditSnapshot({ ...locked, metadata: '{"a":2,"z":1}' }, expected), false);
});
