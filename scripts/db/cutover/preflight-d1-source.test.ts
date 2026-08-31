import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildD1BudgetSpentPreflightCheck,
	SOURCE_D1_INVARIANT_CHECKS,
	SOURCE_D1_REQUIRED_TABLES,
} from './preflight-d1-source';
import { resolveWranglerCommand } from '../lib/d1-execute';

test('D1 execution launches the repository Wrangler with the current Node runtime', () => {
	const command = resolveWranglerCommand();
	assert.equal(command.command, process.execPath);
	assert.equal(command.argsPrefix.length, 1);
	assert.match(command.argsPrefix[0]!, /wrangler[\\/]bin[\\/]wrangler\.js$/u);
});

test('D1 budget-spent preflight prefers 0041 micros and bounds the legacy fallback', () => {
	const authoritative = buildD1BudgetSpentPreflightCheck('authoritative_micros');
	assert.equal(authoritative.label, 'user_budget_spent_authoritative_micros_invalid');
	assert.match(authoritative.sql, /typeof\(budget_spent_micros\) <> 'integer'/u);
	assert.match(authoritative.sql, /budget_spent_micros > 9007199254740991/u);
	assert.match(authoritative.sql, /budget_spent IS NOT CAST\(budget_spent_micros AS REAL\) \/ 1000000\.0/u);

	const legacy = buildD1BudgetSpentPreflightCheck('legacy_real_safe_fallback');
	assert.equal(legacy.label, 'user_budget_spent_legacy_real_unsafe');
	assert.match(legacy.sql, /budget_spent < 4294967296\.0/u);
	assert.equal(legacy.expected, 0);
});

test('D1 source preflight covers every ETL and invalidated-session table once', () => {
	assert.equal(new Set(SOURCE_D1_REQUIRED_TABLES).size, SOURCE_D1_REQUIRED_TABLES.length);
	assert.ok(SOURCE_D1_REQUIRED_TABLES.includes('users'));
	assert.ok(SOURCE_D1_REQUIRED_TABLES.includes('chain_job_transactions'));
	assert.ok(SOURCE_D1_REQUIRED_TABLES.includes('public_model_daily_stats'));
	assert.ok(SOURCE_D1_REQUIRED_TABLES.includes('user_budget_reservations'));
	assert.ok(SOURCE_D1_REQUIRED_TABLES.includes('portal_sessions'));
	assert.ok(SOURCE_D1_REQUIRED_TABLES.includes('admin_sessions'));
});

test('D1 source invariants are unique, fixed read-only count queries', () => {
	const labels = SOURCE_D1_INVARIANT_CHECKS.map((check) => check.label);
	assert.equal(new Set(labels).size, labels.length);
	assert.ok(labels.includes('foreign_key_violations'));
	assert.ok(labels.includes('active_withdrawal_lock_mismatches'));
	assert.ok(labels.includes('invalid_chain_outbox_rows'));
	assert.ok(labels.includes('active_user_budget_reservations'));
	assert.ok(labels.includes('user_budget_reserved_counter_drift'));
	for (const check of SOURCE_D1_INVARIANT_CHECKS) {
		assert.equal(check.expected, 0);
		assert.match(check.sql, /^SELECT COUNT\(\*\) AS value/u);
		assert.doesNotMatch(check.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|PRAGMA\s+\w+\s*=)\b/iu);
	}
});
