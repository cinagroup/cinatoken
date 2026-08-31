import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayRepositories, UserRow } from '@octafuse/core';
import { UserPlanPatchConflictError } from '@octafuse/core/services/user-plan-patch-service';
import { AdminServiceError } from './errors';
import { updateAdminUser } from './users-service';

const USER_ID = '00000000-0000-4000-8000-000000000001';

function user(overrides: Partial<UserRow> = {}): UserRow {
	return {
		id: USER_ID,
		email: 'user@example.com',
		budget_max: 10,
		budget_base: 10,
		budget_spent: 3,
		budget_period: 'monthly',
		budget_reset_at: '2030-01-01T00:00:00.000Z',
		budget_epoch: 4,
		budget_reserved_micros: 500_000,
		status: 'active',
		metadata: JSON.stringify({ existing: true }),
		charged_cost_factors: null,
		external_system: null,
		external_user_id: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function mockRepositories(initial: UserRow) {
	let current = { ...initial };
	let directPlanWrites = 0;
	const profileAudits: Array<Record<string, unknown>> = [];
	const repos = {
		users: {
			getById: async (id: string) => (id === current.id ? { ...current } : null),
			updateUserPlan: async () => {
				directPlanWrites += 1;
				throw new Error('legacy non-atomic plan writer must not be called');
			},
			updateUserStatus: async (_id: string, status: string) => {
				current = { ...current, status };
				return true;
			},
			setUserEmailById: async (_id: string, email: string) => {
				current = { ...current, email };
				return true;
			},
			setUserExternalIdentityById: async (_id: string, system: string | null, externalId: string | null) => {
				current = { ...current, external_system: system, external_user_id: externalId };
				return true;
			},
			setUserChargedCostFactorsById: async (_id: string, value: string | null) => {
				current = { ...current, charged_cost_factors: value };
				return true;
			},
			setUserMetadataById: async (_id: string, value: string | null) => {
				current = { ...current, metadata: value };
				return true;
			},
		},
		userAuditLogs: {
			insertUserAuditLog: async (audit: Record<string, unknown>) => {
				profileAudits.push(audit);
			},
		},
	} as unknown as GatewayRepositories;
	return {
		repos,
		read: () => ({ ...current }),
		write: (next: UserRow) => {
			current = { ...next };
		},
		profileAudits,
		directPlanWrites: () => directPlanWrites,
	};
}

test('admin budget reset uses the atomic plan service and profile audit excludes budget fields', async () => {
	const state = mockRepositories(user());
	let atomicCalls = 0;
	const result = await updateAdminUser(
		state.repos,
		USER_ID,
		{ budget_max: 20, reset_budget: true, status: 'disabled', reason: 'support correction' },
		'admin-1',
		{
			applyPlanPatch: async (_repos, _userId, input) => {
				atomicCalls += 1;
				const before = state.read();
				const after: UserRow = {
					...before,
					budget_max: input.budget_max === undefined ? before.budget_max : input.budget_max,
					budget_spent: 0,
					budget_epoch: before.budget_epoch + 1,
					budget_reserved_micros: 0,
				};
				state.write(after);
				return { before, after, audited: true };
			},
		},
	);

	assert.equal(atomicCalls, 1);
	assert.equal(state.directPlanWrites(), 0);
	assert.equal(result?.budget_epoch, 5);
	assert.equal(result?.budget_reserved_micros, 0);
	assert.equal(state.profileAudits.length, 1);
	assert.equal(state.profileAudits[0]?.reasonCode, 'admin_patch_status');
	assert.deepEqual(JSON.parse(String(state.profileAudits[0]?.changedFields)), ['status']);
});

test('metadata changed with a budget PATCH is owned by the atomic audit without a duplicate profile audit', async () => {
	const state = mockRepositories(user());
	let metadataMutation: unknown;
	await updateAdminUser(
		state.repos,
		USER_ID,
		{ budget_max: 20, metadata: { added: true } },
		'admin-1',
		{
			applyPlanPatch: async (_repos, _userId, input) => {
				metadataMutation = input.metadata;
				const before = state.read();
				const after: UserRow = {
					...before,
					budget_max: input.budget_max === undefined ? before.budget_max : input.budget_max,
					metadata: JSON.stringify({ existing: true, added: true }),
				};
				state.write(after);
				return { before, after, audited: true };
			},
		},
	);
	assert.deepEqual(metadataMutation, { kind: 'merge', value: { added: true } });
	assert.equal(state.profileAudits.length, 0);
	assert.equal(state.directPlanWrites(), 0);
});

test('empty metadata replacement is preserved as an atomic null replacement', async () => {
	const state = mockRepositories(user());
	let metadataMutation: unknown;
	await updateAdminUser(
		state.repos,
		USER_ID,
		{ budget_max: 20, metadata_replace: '' },
		'admin-1',
		{
			applyPlanPatch: async (_repos, _userId, input) => {
				metadataMutation = input.metadata;
				const before = state.read();
				const after = { ...before, budget_max: 20, metadata: null };
				state.write(after);
				return { before, after, audited: true };
			},
		},
	);
	assert.deepEqual(metadataMutation, { kind: 'replace', value: null });
	assert.equal(state.profileAudits.length, 0);
});

test('invalid budget input is rejected before an independently stored status change', async () => {
	const state = mockRepositories(user());
	await assert.rejects(
		() =>
			updateAdminUser(
				state.repos,
				USER_ID,
				{ budget_max: -1, status: 'disabled' },
				'admin-1',
			),
		(error: unknown) => error instanceof AdminServiceError && error.status === 400,
	);
	assert.equal(state.read().status, 'active');
	assert.equal(state.directPlanWrites(), 0);
});

test('persistent plan CAS conflict maps to an explicit HTTP 409', async () => {
	const state = mockRepositories(user());
	await assert.rejects(
		() =>
			updateAdminUser(
				state.repos,
				USER_ID,
				{ budget_max: 20, status: 'disabled' },
				'admin-1',
				{
					applyPlanPatch: async () => {
						throw new UserPlanPatchConflictError();
					},
				},
			),
		(error: unknown) =>
			error instanceof AdminServiceError &&
			error.status === 409 &&
			error.message.includes('concurrently'),
	);
	assert.equal(state.directPlanWrites(), 0);
	assert.equal(state.read().status, 'active');
});
