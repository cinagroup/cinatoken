/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildBudgetTransitionInput,
	type BudgetTransitionDraft,
} from './user-detail-transition-domain'

const valid: BudgetTransitionDraft = {
	targetBase: '25.250001',
	period: 'monthly',
	resetAt: '2030-02-01T12:30',
	carryover: 'remaining_or_overage',
	resetSpent: true,
	reason: 'period renewal',
}

test('transition input preserves UTC target and explicit accounting policy', () => {
	assert.deepEqual(buildBudgetTransitionInput(valid), {
		target_budget_base: 25.250001,
		budget_period: 'monthly',
		budget_reset_at: '2030-02-01T12:30:00Z',
		carryover_strategy: 'remaining_or_overage',
		reset_spent: true,
		reason: 'period renewal',
	})
	const automatic = buildBudgetTransitionInput({ ...valid, resetAt: '' })
	assert.equal(Object.hasOwn(automatic, 'budget_reset_at'), false)
})

test('transition input rejects invalid money and calendar dates', () => {
	for (const invalid of [
		{ ...valid, targetBase: '-1' },
		{ ...valid, targetBase: '0.0000001' },
		{ ...valid, targetBase: '1e5' },
		{ ...valid, resetAt: '2030-02-30T12:30' },
		{ ...valid, resetAt: '2000-01-01T00:00' },
		{ ...valid, period: 'none' as const },
	])
		assert.throws(() => buildBudgetTransitionInput(invalid))
})
