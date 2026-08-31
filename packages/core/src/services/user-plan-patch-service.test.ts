import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayRepositories } from '../storage/repositories';
import type { UserRow } from '../types';
import {
	applyUserPlanPatchWithAudit,
	UserPlanPatchConflictError,
	type UserPlanPatchServiceDependencies,
} from './user-plan-patch-service';

function user(overrides: Partial<UserRow> = {}): UserRow {
	return {
		id: 'user-1',
		email: 'user@example.com',
		budget_max: 10,
		budget_base: 10,
		budget_spent: 4,
		budget_period: 'monthly',
		budget_reset_at: '2030-01-01T00:00:00.000Z',
		budget_epoch: 7,
		budget_reserved_micros: 2_000_000,
		status: 'active',
		metadata: JSON.stringify({ old: true }),
		charged_cost_factors: null,
		external_system: null,
		external_user_id: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function repositories(read: () => UserRow | null): GatewayRepositories {
	return {
		users: {
			getById: async () => {
				const row = read();
				return row ? { ...row } : null;
			},
		},
	} as unknown as GatewayRepositories;
}

test('exact plan PATCH submits full CAS inputs and the audit in one critical write', async () => {
	let current = user();
	let captured: Parameters<UserPlanPatchServiceDependencies['applyTransition']>[1] | null = null;
	const dependencies: UserPlanPatchServiceDependencies = {
		applyTransition: async (_storage, params) => {
			captured = params;
			current = {
				...current,
				budget_max: params.budgetMax,
				budget_base: params.budgetBase,
				budget_spent: params.budgetSpent,
				budget_period: params.budgetPeriod,
				budget_reset_at: params.budgetResetAt,
				metadata: params.metadata === undefined ? current.metadata : params.metadata,
			};
			return true;
		},
	};
	const result = await applyUserPlanPatchWithAudit(
		repositories(() => current),
		current.id,
		{
			budget_max: 20,
			budget_base: 12,
			budget_period: 'monthly',
			budget_reset_at: current.budget_reset_at,
			reset_budget: false,
			metadata: { kind: 'merge', value: { added: 'yes' } },
			reason: 'manual correction',
		},
		'admin-1',
		dependencies,
	);

	assert.equal(result?.audited, true);
	assert.ok(captured);
	assert.equal(captured.expectedBudgetMax, 10);
	assert.equal(captured.expectedBudgetBase, 10);
	assert.equal(captured.expectedBudgetSpent, 4);
	assert.equal(captured.expectedBudgetPeriod, 'monthly');
	assert.equal(captured.expectedBudgetResetAt, '2030-01-01T00:00:00.000Z');
	assert.equal(captured.expectedBudgetEpoch, 7);
	assert.equal(captured.expectedBudgetReservedMicros, 2_000_000);
	assert.equal(captured.resetEpoch, false);
	assert.deepEqual(JSON.parse(captured.metadata ?? '{}'), { old: true, added: 'yes' });
	assert.equal(captured.audit.reasonCode, 'admin_patch_budget');
	assert.equal(captured.audit.reasonText, 'manual correction');
	assert.deepEqual(JSON.parse(captured.audit.changedFields ?? '[]'), [
		'budget_max',
		'budget_base',
		'metadata',
	]);
});

test('reset-only PATCH audits epoch and reserved counter changes', async () => {
	const current = user({ budget_spent: 0, budget_reserved_micros: 400_000 });
	let changedFields: string[] = [];
	const dependencies: UserPlanPatchServiceDependencies = {
		applyTransition: async (_storage, params) => {
			changedFields = JSON.parse(params.audit.changedFields ?? '[]') as string[];
			return true;
		},
	};
	const result = await applyUserPlanPatchWithAudit(
		repositories(() => current),
		current.id,
		{
			budget_max: current.budget_max,
			budget_period: 'monthly',
			budget_reset_at: current.budget_reset_at,
			reset_budget: true,
		},
		'admin-1',
		dependencies,
	);
	assert.equal(result?.after.budget_epoch, 8);
	assert.equal(result?.after.budget_reserved_micros, 0);
	assert.ok(changedFields.includes('budget_epoch'));
	assert.ok(changedFields.includes('budget_reserved_micros'));
});

test('CAS conflict rereads and recomputes from the newest complete budget snapshot', async () => {
	let current = user();
	const expectedMaxes: Array<number | null> = [];
	const dependencies: UserPlanPatchServiceDependencies = {
		applyTransition: async (_storage, params) => {
			expectedMaxes.push(params.expectedBudgetMax);
			if (expectedMaxes.length === 1) {
				current = { ...current, budget_max: 11, budget_base: 11 };
				return false;
			}
			return true;
		},
	};
	const result = await applyUserPlanPatchWithAudit(
		repositories(() => current),
		current.id,
		{
			budget_max: 20,
			budget_period: 'monthly',
			budget_reset_at: current.budget_reset_at,
			reset_budget: false,
		},
		'admin-1',
		dependencies,
	);
	assert.equal(result?.audited, true);
	assert.deepEqual(expectedMaxes, [10, 11]);
	assert.equal(result?.after.budget_base, 11, 'an unspecified field must retain the concurrent value');
});

test('persistent CAS conflict is explicit and never falls back to a non-atomic write', async () => {
	let calls = 0;
	const current = user();
	await assert.rejects(
		() =>
			applyUserPlanPatchWithAudit(
				repositories(() => current),
				current.id,
				{
					budget_max: 20,
					budget_period: 'monthly',
					budget_reset_at: current.budget_reset_at,
					reset_budget: false,
				},
				'admin-1',
				{
					applyTransition: async () => {
						calls += 1;
						return false;
					},
				},
			),
		(error: unknown) => error instanceof UserPlanPatchConflictError,
	);
	assert.equal(calls, 3);
});

test('effective no-op does not create an audit row', async () => {
	const current = user();
	let calls = 0;
	const result = await applyUserPlanPatchWithAudit(
		repositories(() => current),
		current.id,
		{
			budget_max: current.budget_max,
			budget_period: 'monthly',
			budget_reset_at: current.budget_reset_at,
			reset_budget: false,
		},
		'admin-1',
		{
			applyTransition: async () => {
				calls += 1;
				return true;
			},
		},
	);
	assert.equal(result?.audited, false);
	assert.equal(calls, 0);
});
