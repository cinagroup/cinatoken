import { ETL_EXCLUDED_SESSION_TABLES, ETL_TABLE_ORDER } from '../lib/migration-tables';
import {
	type D1ExecutionConfig,
	parseD1ExecutionConfig,
	runD1ExecuteJson,
	DEFAULT_D1_DATABASE_NAME,
	DEFAULT_D1_PERSIST_TO,
} from '../lib/d1-execute';

const REQUIRED_MIGRATION = '0030_chain_job_transactions.sql';

type InvariantCheck = {
	label: string;
	sql: string;
	expected: number;
};

export const SOURCE_D1_REQUIRED_TABLES = [
	...ETL_TABLE_ORDER,
	...ETL_EXCLUDED_SESSION_TABLES,
] as const;

export const SOURCE_D1_INVARIANT_CHECKS: readonly InvariantCheck[] = [
	{
		label: 'foreign_key_violations',
		sql: 'SELECT COUNT(*) AS value FROM pragma_foreign_key_check',
		expected: 0,
	},
	{
		label: 'invalid_identity_pairs',
		sql: `SELECT COUNT(*) AS value FROM users
			WHERE (external_system IS NULL) <> (external_user_id IS NULL)
				OR (external_system IS NOT NULL AND TRIM(external_system) = '')
				OR (external_user_id IS NOT NULL AND TRIM(external_user_id) = '')
				OR TRIM(email) = ''`,
		expected: 0,
	},
	{
		label: 'duplicate_identity_mappings',
		sql: `SELECT COUNT(*) AS value FROM (
			SELECT external_system, external_user_id
			FROM users
			WHERE external_system IS NOT NULL
			GROUP BY external_system, external_user_id
			HAVING COUNT(*) > 1
		)`,
		expected: 0,
	},
	{
		label: 'negative_earnings_micros',
		sql: `SELECT COUNT(*) AS value FROM user_earnings
			WHERE balance_micros < 0 OR locked_amount_micros < 0
				OR lifetime_earned_micros < 0 OR lifetime_withdrawn_micros < 0
				OR contribution_value_micros < 0`,
		expected: 0,
	},
	{
		label: 'earnings_projection_drift',
		sql: `SELECT COUNT(*) AS value FROM user_earnings
			WHERE balance_micros <> CAST(ROUND(balance * 1000000) AS INTEGER)
				OR locked_amount_micros <> CAST(ROUND(locked_amount * 1000000) AS INTEGER)
				OR lifetime_earned_micros <> CAST(ROUND(lifetime_earned * 1000000) AS INTEGER)
				OR lifetime_withdrawn_micros <> CAST(ROUND(lifetime_withdrawn * 1000000) AS INTEGER)
				OR contribution_value_micros <> CAST(ROUND(contribution_value * 1000000) AS INTEGER)`,
		expected: 0,
	},
	{
		label: 'duplicate_active_withdrawals',
		sql: `SELECT COUNT(*) AS value FROM (
			SELECT user_id FROM withdrawals
			WHERE status IN ('requested', 'processing', 'submitted')
			GROUP BY user_id HAVING COUNT(*) > 1
		)`,
		expected: 0,
	},
	{
		label: 'invalid_withdrawal_micros',
		sql: `SELECT COUNT(*) AS value FROM withdrawals
			WHERE amount_micros <= 0 OR fee_micros < 0 OR net_amount_micros < 0
				OR net_amount_micros > amount_micros
				OR ABS(amount_micros - fee_micros - net_amount_micros) > 1`,
		expected: 0,
	},
	{
		label: 'withdrawal_projection_drift',
		sql: `SELECT COUNT(*) AS value FROM withdrawals
			WHERE amount_micros <> CAST(ROUND(amount * 1000000) AS INTEGER)
				OR fee_micros <> CAST(ROUND(fee * 1000000) AS INTEGER)
				OR net_amount_micros <> CAST(ROUND(net_amount * 1000000) AS INTEGER)`,
		expected: 0,
	},
	{
		label: 'active_withdrawal_lock_mismatches',
		sql: `SELECT COUNT(*) AS value FROM user_earnings AS earnings
			WHERE earnings.locked_amount_micros <> COALESCE((
				SELECT SUM(withdrawals.amount_micros)
				FROM withdrawals
				WHERE withdrawals.user_id = earnings.user_id
					AND withdrawals.status IN ('requested', 'processing', 'submitted')
			), 0)`,
		expected: 0,
	},
	{
		label: 'invalid_chain_outbox_rows',
		sql: `SELECT COUNT(*) AS value FROM chain_job_transactions AS outbox
			WHERE TRIM(outbox.tx_hash) = '' OR TRIM(outbox.raw_transaction) = ''
				OR outbox.job_kind NOT IN ('withdrawal', 'nft_mint')
				OR (outbox.job_kind = 'withdrawal' AND NOT EXISTS (
					SELECT 1 FROM withdrawals WHERE withdrawals.id = outbox.job_id
				))
				OR (outbox.job_kind = 'nft_mint' AND NOT EXISTS (
					SELECT 1 FROM nft_mints WHERE nft_mints.id = outbox.job_id
				))`,
		expected: 0,
	},
	{
		label: 'legacy_master_key_rows',
		sql: `SELECT COUNT(*) AS value FROM system_config WHERE key = 'MASTER_KEY'`,
		expected: 0,
	},
];

function quoteSqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function parseCount(value: unknown, label: string): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid count returned for ${label}.`);
	}
	return parsed;
}

function printUsage(): void {
	console.log(`Usage:
  npx tsx scripts/db/cutover/preflight-d1-source.ts [options]

Options:
  --d1-source=remote|local   D1 source (default: remote)
  --d1-persist-to=<path>     Local D1 persist dir when source=local (default: ${DEFAULT_D1_PERSIST_TO})
  -h, --help                 Show this help

Environment:
  D1_DATABASE_NAME           Optional database name (default: ${DEFAULT_D1_DATABASE_NAME})
`);
}

function parseConfig(): D1ExecutionConfig {
	const args = process.argv.slice(2).filter((arg) => arg !== '--');
	if (args.includes('-h') || args.includes('--help')) {
		printUsage();
		process.exit(0);
	}
	const unknownArgs = args.filter(
		(arg) => !arg.startsWith('--d1-source=') && !arg.startsWith('--d1-persist-to='),
	);
	if (unknownArgs.length > 0) throw new Error(`Unknown option(s): ${unknownArgs.join(', ')}`);
	const source = args.find((arg) => arg.startsWith('--d1-source='))?.split('=')[1];
	if (source && source !== 'remote' && source !== 'local') {
		throw new Error('Invalid --d1-source, expected remote or local.');
	}
	return parseD1ExecutionConfig(args);
}

export function runSourceD1Preflight(config: D1ExecutionConfig): void {
	console.log(`[D1 preflight] source=${config.source} database=${config.databaseName} mode=read-only`);

	const [migration] = runD1ExecuteJson(
		`SELECT COUNT(*) AS value FROM d1_migrations WHERE name = ${quoteSqlString(REQUIRED_MIGRATION)}`,
		config,
	);
	if (parseCount(migration?.value, 'required_migration') !== 1) {
		throw new Error(`Required D1 migration is missing: ${REQUIRED_MIGRATION}`);
	}
	console.log(`[PASS] required_migration=${REQUIRED_MIGRATION}`);

	const tableNames = SOURCE_D1_REQUIRED_TABLES.map(quoteSqlString).join(', ');
	const tables = runD1ExecuteJson(
		`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${tableNames}) ORDER BY name`,
		config,
	);
	const existingTables = new Set(
		tables.map((row) => row.name).filter((name): name is string => typeof name === 'string'),
	);
	const missingTables = SOURCE_D1_REQUIRED_TABLES.filter((table) => !existingTables.has(table));
	if (missingTables.length > 0) throw new Error(`Missing required D1 tables: ${missingTables.join(', ')}`);
	console.log(`[PASS] required_tables=${SOURCE_D1_REQUIRED_TABLES.length}`);

	let failures = 0;
	for (const check of SOURCE_D1_INVARIANT_CHECKS) {
		let row: Record<string, unknown> | undefined;
		try {
			[row] = runD1ExecuteJson(check.sql, config);
		} catch {
			throw new Error(`D1 invariant query failed: ${check.label}`);
		}
		const actual = parseCount(row?.value, check.label);
		const passed = actual === check.expected;
		console.log(`[${passed ? 'PASS' : 'FAIL'}] ${check.label}=${actual} expected=${check.expected}`);
		if (!passed) failures += 1;
	}

	// Remote D1 currently rejects six-term compound SELECT statements.
	const countBatchSize = 4;
	for (let offset = 0; offset < SOURCE_D1_REQUIRED_TABLES.length; offset += countBatchSize) {
		const tableBatch = SOURCE_D1_REQUIRED_TABLES.slice(offset, offset + countBatchSize);
		const countsSql = tableBatch
			.map((table) => `SELECT ${quoteSqlString(table)} AS table_name, COUNT(*) AS row_count FROM ${table}`)
			.join('\nUNION ALL\n');
		const counts = runD1ExecuteJson(countsSql, config);
		for (const row of counts) {
			console.log(`[COUNT] ${String(row.table_name)}=${parseCount(row.row_count, String(row.table_name))}`);
		}
	}

	const [operational] = runD1ExecuteJson(`SELECT
		(SELECT COUNT(*) FROM users WHERE external_system = 'cinaauth') AS cinaauth_users,
		(SELECT COUNT(*) FROM withdrawals WHERE status IN ('requested', 'processing', 'submitted')) AS active_withdrawals,
		(SELECT COUNT(*) FROM chain_job_transactions WHERE broadcast_at IS NULL) AS unbroadcast_transactions`, config);
	console.log(`[STATE] cinaauth_users=${parseCount(operational?.cinaauth_users, 'cinaauth_users')}`);
	console.log(`[STATE] active_withdrawals=${parseCount(operational?.active_withdrawals, 'active_withdrawals')}`);
	console.log(`[STATE] unbroadcast_transactions=${parseCount(operational?.unbroadcast_transactions, 'unbroadcast_transactions')}`);

	if (failures > 0) throw new Error(`D1 source preflight failed: ${failures} invariant(s) did not pass.`);
	console.log('[D1 preflight] PASS');
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
	try {
		runSourceD1Preflight(parseConfig());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
