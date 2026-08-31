import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAndFinalizeUserAuditInsert } from '../db/user-audit-catalog';
import { computeBudgetTransition } from './budget-transition-service';

test('computeBudgetTransition carries remaining budget forward', () => {
	const result = computeBudgetTransition(
		{
			budget_max: 10,
			budget_base: 10,
			budget_spent: 1,
			budget_period: 'monthly',
			budget_reset_at: '2026-06-23T15:31:49.000Z',
			budget_reserved_micros: 0,
		},
		{
			target_budget_base: 100,
			budget_period: 'monthly',
			budget_reset_at: '2026-07-25T05:49:46.000Z',
			carryover_strategy: 'remaining_or_overage',
			reset_spent: true,
		}
	);
	assert.equal(result.carryover, 9);
	assert.equal(result.after.budget_max, 109);
	assert.equal(result.after.budget_spent, 0);
	assert.equal(result.after.budget_base, 100);
});

test('computeBudgetTransition deducts overage from next period', () => {
	const result = computeBudgetTransition(
		{
			budget_max: 10,
			budget_base: 10,
			budget_spent: 12,
			budget_period: 'monthly',
			budget_reset_at: '2026-06-23T15:31:49.000Z',
			budget_reserved_micros: 0,
		},
		{
			target_budget_base: 100,
			budget_period: 'monthly',
			carryover_strategy: 'remaining_or_overage',
			reset_spent: true,
		}
	);
	assert.equal(result.carryover, -2);
	assert.equal(result.after.budget_max, 98);
	assert.equal(result.after.budget_spent, 0);
});

test('computeBudgetTransition does not carry active reservation capacity into a reset period', () => {
	const result = computeBudgetTransition(
		{
			budget_max: 10,
			budget_base: 10,
			budget_spent: 1,
			budget_period: 'monthly',
			budget_reset_at: '2026-06-23T15:31:49.000Z',
			budget_reserved_micros: 2_500_000,
		},
		{
			target_budget_base: 100,
			budget_period: 'monthly',
			carryover_strategy: 'remaining_or_overage',
			reset_spent: true,
		},
	);
	assert.equal(result.carryover, 6.5);
	assert.equal(result.after.budget_max, 106.5);
	assert.equal(result.after.budget_reserved_micros, 0);
});

test('computeBudgetTransition none strategy skips carryover', () => {
	const result = computeBudgetTransition(
		{
			budget_max: 10,
			budget_base: 10,
			budget_spent: 1,
			budget_period: 'monthly',
			budget_reset_at: null,
			budget_reserved_micros: 0,
		},
		{
			target_budget_base: 100,
			budget_period: 'monthly',
			carryover_strategy: 'none',
			reset_spent: true,
		}
	);
	assert.equal(result.carryover, 0);
	assert.equal(result.after.budget_max, 100);
});

test('computeBudgetTransition preserves active reservations when spent is not reset', () => {
	const result = computeBudgetTransition(
		{
			budget_max: 10,
			budget_base: 10,
			budget_spent: 1,
			budget_period: 'monthly',
			budget_reset_at: null,
			budget_reserved_micros: 250_000,
		},
		{
			target_budget_base: 10,
			budget_period: 'monthly',
			carryover_strategy: 'none',
			reset_spent: false,
		},
	);
	assert.equal(result.after.budget_spent, 1);
	assert.equal(result.after.budget_reserved_micros, 250_000);
});

test('assertAndFinalizeUserAuditInsert accepts admin_budget_transition source', () => {
	const finalized = assertAndFinalizeUserAuditInsert({
		id: '00000000-0000-4000-8000-000000000001',
		userId: 'user-1',
		eventType: 'admin_adjust',
		actorType: 'admin',
		actorId: 'master_key',
		source: 'admin_budget_transition',
		reasonCode: 'budget_transition',
		reasonText: 'wechat_pay:active',
	});
	assert.equal(finalized.source, 'admin_budget_transition');
	assert.equal(finalized.actorId, 'admin:gateway_master_key');
});

test('assertAndFinalizeUserAuditInsert rejects unknown admin budget source', () => {
	assert.throws(
		() =>
			assertAndFinalizeUserAuditInsert({
				id: '00000000-0000-4000-8000-000000000002',
				userId: 'user-1',
				eventType: 'admin_adjust',
				actorType: 'admin',
				source: 'admin_budget_transition_typo',
			}),
		/invalid source/
	);
});
