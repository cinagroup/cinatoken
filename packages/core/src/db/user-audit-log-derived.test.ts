import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveUserAuditBudgetFromSnapshots } from './user-audit-log-derived';

function snapshot(budgetMax: number | null | undefined): string {
	return JSON.stringify({ budget_spent: 3, budget_base: 7, ...(budgetMax === undefined ? {} : { budget_max: budgetMax }) });
}

test('audit budget derivation preserves explicit unlimited-to-limited transitions', () => {
	const derived = deriveUserAuditBudgetFromSnapshots(snapshot(null), snapshot(100));
	assert.equal(derived.before_budget_max, null);
	assert.equal(derived.after_budget_max, 100);
	assert.equal(derived.delta_spent, 0);
});

test('audit budget derivation preserves explicit limited-to-unlimited transitions', () => {
	const derived = deriveUserAuditBudgetFromSnapshots(snapshot(100), snapshot(null));
	assert.equal(derived.before_budget_max, 100);
	assert.equal(derived.after_budget_max, null);
});

test('audit budget derivation falls back only when a legacy snapshot lacks budget_max', () => {
	for (const [before, after, expectedBefore, expectedAfter] of [
		[snapshot(undefined), snapshot(100), 100, 100],
		[snapshot(100), snapshot(undefined), 100, 100],
		[snapshot(undefined), snapshot(null), null, null],
		[snapshot(null), snapshot(undefined), null, null],
		[null, snapshot(100), 100, 100],
		[snapshot(100), null, 100, 100],
	] as const) {
		const derived = deriveUserAuditBudgetFromSnapshots(before, after);
		assert.equal(derived.before_budget_max, expectedBefore);
		assert.equal(derived.after_budget_max, expectedAfter);
	}
});

test('audit budget derivation returns null when both snapshots omit budget_max', () => {
	const derived = deriveUserAuditBudgetFromSnapshots(snapshot(undefined), snapshot(undefined));
	assert.equal(derived.before_budget_max, null);
	assert.equal(derived.after_budget_max, null);
	assert.deepEqual(
		deriveUserAuditBudgetFromSnapshots(null, null),
		{
			before_spent: 0,
			delta_spent: 0,
			after_spent: 0,
			before_budget_max: null,
			after_budget_max: null,
			before_budget_base: 0,
			after_budget_base: 0,
		},
	);
});
