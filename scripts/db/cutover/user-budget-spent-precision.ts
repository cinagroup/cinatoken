export const D1_BUDGET_SPENT_MICROS_MIGRATION = '0041_user_budget_spent_micros.sql';
export const D1_BUDGET_SPENT_MICROS_COLUMN = 'budget_spent_micros';
export const D1_BUDGET_SPENT_TRANSFER_ALIAS = '__budget_spent_transfer_micros';
export const LEGACY_D1_BUDGET_SPENT_EXCLUSIVE_MAX = 4_294_967_296;
export const MAX_SAFE_BUDGET_SPENT_MICROS = 9_007_199_254_740_991n;

export type D1BudgetSpentPrecisionMode =
	| 'authoritative_micros'
	| 'legacy_real_safe_fallback';

export function resolveD1BudgetSpentPrecisionMode(
	userColumns: readonly string[],
	migration0041Recorded: boolean,
): D1BudgetSpentPrecisionMode {
	const hasMicrosColumn = userColumns.includes(D1_BUDGET_SPENT_MICROS_COLUMN);
	if (hasMicrosColumn !== migration0041Recorded) {
		throw new Error(
			`D1 0041 schema/ledger mismatch: migration_recorded=${migration0041Recorded}; ` +
			`budget_spent_micros_column=${hasMicrosColumn}`,
		);
	}
	return hasMicrosColumn ? 'authoritative_micros' : 'legacy_real_safe_fallback';
}

/**
 * The source-side query must return TEXT so neither Wrangler JSON nor a Worker
 * JavaScript Number can round an otherwise-safe 64-bit integer.
 */
export function d1BudgetSpentTransferExpression(mode: D1BudgetSpentPrecisionMode): string {
	return mode === 'authoritative_micros'
		? `CAST(${D1_BUDGET_SPENT_MICROS_COLUMN} AS TEXT)`
		: 'CAST(CAST(ROUND(budget_spent * 1000000.0) AS INTEGER) AS TEXT)';
}

export function d1BudgetSpentInvariantSql(mode: D1BudgetSpentPrecisionMode): string {
	if (mode === 'authoritative_micros') {
		return `SELECT COUNT(*) AS value FROM users
			WHERE typeof(budget_spent_micros) <> 'integer'
				OR budget_spent_micros < 0
				OR budget_spent_micros > 9007199254740991
				OR budget_spent IS NULL
				OR budget_spent IS NOT CAST(budget_spent_micros AS REAL) / 1000000.0`;
	}
	return `SELECT COUNT(*) AS value FROM users
		WHERE budget_spent IS NULL
			OR typeof(budget_spent) NOT IN ('integer', 'real')
			OR NOT (budget_spent >= 0 AND budget_spent < ${LEGACY_D1_BUDGET_SPENT_EXCLUSIVE_MAX}.0)`;
}

export function postgresUserColumnsForD1Source(userColumns: readonly string[]): string[] {
	if (!userColumns.includes('budget_spent')) {
		throw new Error('D1 users table is missing budget_spent');
	}
	return userColumns.filter((column) => column !== D1_BUDGET_SPENT_MICROS_COLUMN);
}

function parseUnsignedIntegerText(value: unknown, label: string): bigint {
	if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
		throw new Error(`${label} must be returned as unsigned integer TEXT`);
	}
	const parsed = BigInt(value);
	if (parsed > MAX_SAFE_BUDGET_SPENT_MICROS) {
		throw new Error(`${label} exceeds the D1 safe-integer micros ceiling`);
	}
	return parsed;
}

export function d1BudgetSpentMicrosFromTransferRow(row: Record<string, unknown>): bigint {
	return parseUnsignedIntegerText(
		row[D1_BUDGET_SPENT_TRANSFER_ALIAS],
		D1_BUDGET_SPENT_TRANSFER_ALIAS,
	);
}

export function formatBudgetSpentMicrosForPostgres(micros: bigint): string {
	if (micros < 0n || micros > MAX_SAFE_BUDGET_SPENT_MICROS) {
		throw new Error('budget_spent micros is outside the supported range');
	}
	const units = micros / 1_000_000n;
	const fraction = (micros % 1_000_000n).toString().padStart(6, '0');
	return `${units}.${fraction}`;
}

export function postgresBudgetSpentFromTransferRow(row: Record<string, unknown>): string {
	return formatBudgetSpentMicrosForPostgres(d1BudgetSpentMicrosFromTransferRow(row));
}

export function postgresBudgetSpentMicrosText(value: unknown): string {
	if (typeof value !== 'string') {
		throw new Error('PostgreSQL budget_spent micros must be returned as NUMERIC text');
	}
	const match = /^(0|[1-9]\d*)(?:\.0+)?$/u.exec(value);
	if (!match) {
		throw new Error(`PostgreSQL budget_spent is not an exact micro amount: ${value}`);
	}
	const parsed = BigInt(match[1]);
	if (parsed > MAX_SAFE_BUDGET_SPENT_MICROS) {
		throw new Error('PostgreSQL budget_spent exceeds the D1 safe-integer micros ceiling');
	}
	return parsed.toString();
}
