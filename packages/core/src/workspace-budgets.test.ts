import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildWorkspaceBudgetIntent,
	normalizeWorkspaceBudgetLimitMicros,
	validateWorkspaceBudgetOrdering,
	type WorkspaceBudgetRow,
} from './workspace-budgets';

const row: WorkspaceBudgetRow = {
	id: 'budget-1',
	workspace_id: 'workspace-1',
	reset_interval: 'monthly',
	limit_micros: 100_000_000,
	config_epoch: 2,
	workspace_created_at: '2026-01-01T00:00:00.000Z',
	created_at: '2026-08-31T00:00:00.000Z',
	updated_at: '2026-08-31T00:00:00.000Z',
};

test('Workspace budget limits use positive integer micros', () => {
	assert.equal(normalizeWorkspaceBudgetLimitMicros(10.25), 10_250_000);
	assert.throws(() => normalizeWorkspaceBudgetLimitMicros(0), /positive/u);
	assert.throws(() => normalizeWorkspaceBudgetLimitMicros(-1), /positive/u);
});

test('Workspace budget ordering is strictly broader-to-narrower', () => {
	assert.equal(validateWorkspaceBudgetOrdering([
		{ reset_interval: 'daily', limit_micros: 1 },
		{ reset_interval: 'weekly', limit_micros: 2 },
		{ reset_interval: 'monthly', limit_micros: 3 },
		{ reset_interval: 'lifetime', limit_micros: 4 },
	]), null);
	assert.match(validateWorkspaceBudgetOrdering([
		{ reset_interval: 'daily', limit_micros: 2 },
		{ reset_interval: 'weekly', limit_micros: 2 },
	]) ?? '', /weekly must exceed daily/u);
});

test('Workspace budget intents pin Workspace, interval, and epoch', () => {
	assert.deepEqual(buildWorkspaceBudgetIntent(row, new Date('2026-08-31T12:00:00.000Z')), {
		workspaceId: 'workspace-1',
		assignmentId: 'workspace-budget:budget-1',
		guardrailId: 'workspace-budget:budget-1',
		guardrailVersion: 3,
		scopeType: 'workspace',
		scopeId: 'workspace-1',
		period: 'monthly',
		periodStart: '2026-08-01T00:00:00.000Z',
		periodEnd: '2026-09-01T00:00:00.000Z',
		limitMicros: 100_000_000,
	});
});
