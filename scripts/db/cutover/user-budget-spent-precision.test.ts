import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
	D1_BUDGET_SPENT_TRANSFER_ALIAS,
	d1BudgetSpentInvariantSql,
	d1BudgetSpentMicrosFromTransferRow,
	d1BudgetSpentTransferExpression,
	formatBudgetSpentMicrosForPostgres,
	postgresBudgetSpentMicrosText,
	postgresUserColumnsForD1Source,
	resolveD1BudgetSpentPrecisionMode,
} from './user-budget-spent-precision';

test('0041 mode is authoritative and removes the D1-only micros column from PG inserts', () => {
	const columns = ['id', 'budget_spent', 'budget_spent_micros'];
	assert.equal(resolveD1BudgetSpentPrecisionMode(columns, true), 'authoritative_micros');
	assert.deepEqual(postgresUserColumnsForD1Source(columns), ['id', 'budget_spent']);
	assert.equal(d1BudgetSpentTransferExpression('authoritative_micros'), 'CAST(budget_spent_micros AS TEXT)');
	assert.match(d1BudgetSpentInvariantSql('authoritative_micros'), /budget_spent_micros > 9007199254740991/u);
});

test('legacy mode is explicit and bounded below 2^32 units', () => {
	assert.equal(
		resolveD1BudgetSpentPrecisionMode(['id', 'budget_spent'], false),
		'legacy_real_safe_fallback',
	);
	assert.match(d1BudgetSpentInvariantSql('legacy_real_safe_fallback'), /budget_spent < 4294967296\.0/u);
	assert.match(d1BudgetSpentTransferExpression('legacy_real_safe_fallback'), /CAST\(ROUND\(budget_spent \* 1000000\.0\) AS INTEGER\)/u);
});

test('schema and migration ledger disagreement fails closed', () => {
	assert.throws(
		() => resolveD1BudgetSpentPrecisionMode(['id', 'budget_spent'], true),
		/0041 schema\/ledger mismatch/u,
	);
	assert.throws(
		() => resolveD1BudgetSpentPrecisionMode(['id', 'budget_spent', 'budget_spent_micros'], false),
		/0041 schema\/ledger mismatch/u,
	);
});

test('integer TEXT preserves a one-micro amount above the binary64 exact range', () => {
	const row = { [D1_BUDGET_SPENT_TRANSFER_ALIAS]: '8589934592000001' };
	const micros = d1BudgetSpentMicrosFromTransferRow(row);
	assert.equal(micros, 8_589_934_592_000_001n);
	assert.equal(formatBudgetSpentMicrosForPostgres(micros), '8589934592.000001');
	assert.equal(postgresBudgetSpentMicrosText('8589934592000001.000000'), '8589934592000001');
});

test('Number inputs, fractional micros, negatives, and values above MAX_SAFE fail closed', () => {
	for (const value of [8_589_934_592_000_001, '1.5', '-1', '9007199254740992']) {
		assert.throws(
			() => d1BudgetSpentMicrosFromTransferRow({ [D1_BUDGET_SPENT_TRANSFER_ALIAS]: value }),
			/TEXT|ceiling/u,
		);
	}
	assert.throws(() => postgresBudgetSpentMicrosText('1.000001'), /not an exact micro/u);
});

test('D1 SQL returns authoritative huge micros as TEXT and rejects the legacy 2^32 boundary', () => {
	const authoritative = new DatabaseSync(':memory:');
	authoritative.exec(`CREATE TABLE users (
		budget_spent REAL NOT NULL,
		budget_spent_micros INTEGER NOT NULL
	)`);
	authoritative.exec(`INSERT INTO users VALUES (
		CAST(8589934592000001 AS REAL) / 1000000.0,
		8589934592000001
	)`);
	const transfer = authoritative.prepare(
		`SELECT ${d1BudgetSpentTransferExpression('authoritative_micros')} AS ${D1_BUDGET_SPENT_TRANSFER_ALIAS} FROM users`,
	).get() as Record<string, unknown>;
	assert.equal(transfer[D1_BUDGET_SPENT_TRANSFER_ALIAS], '8589934592000001');
	assert.equal(
		authoritative.prepare(d1BudgetSpentInvariantSql('authoritative_micros')).get()!.value,
		0,
	);
	authoritative.close();

	const legacy = new DatabaseSync(':memory:');
	legacy.exec('CREATE TABLE users (budget_spent REAL NOT NULL)');
	legacy.exec('INSERT INTO users VALUES (4294967295.999999), (4294967296.0)');
	assert.equal(
		legacy.prepare(d1BudgetSpentInvariantSql('legacy_real_safe_fallback')).get()!.value,
		1,
	);
	legacy.exec('DELETE FROM users WHERE budget_spent >= 4294967296.0');
	const legacyTransfer = legacy.prepare(
		`SELECT ${d1BudgetSpentTransferExpression('legacy_real_safe_fallback')} AS ${D1_BUDGET_SPENT_TRANSFER_ALIAS} FROM users`,
	).get() as Record<string, unknown>;
	assert.equal(legacyTransfer[D1_BUDGET_SPENT_TRANSFER_ALIAS], '4294967295999999');
	legacy.close();
});
