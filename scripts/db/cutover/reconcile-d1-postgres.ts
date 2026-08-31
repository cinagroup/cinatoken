import postgres from 'postgres';
import { ETL_TABLE_ORDER } from '../lib/migration-tables';
import {
	type D1ExecutionConfig,
	getTableColumns,
	parseD1ExecutionConfig,
	runD1ExecuteJson,
	DEFAULT_D1_DATABASE_NAME,
	DEFAULT_D1_PERSIST_TO,
} from '../lib/d1-execute';
import {
	buildD1GuardrailLedgerAuditSql,
	buildPostgresGuardrailLedgerAuditSql,
	GUARDRAIL_LEDGER_DETAIL_LIMIT,
} from './guardrail-ledger-contract';
import {
	D1_BUDGET_SPENT_MICROS_MIGRATION,
	D1_BUDGET_SPENT_TRANSFER_ALIAS,
	type D1BudgetSpentPrecisionMode,
	d1BudgetSpentInvariantSql,
	d1BudgetSpentMicrosFromTransferRow,
	d1BudgetSpentTransferExpression,
	postgresBudgetSpentMicrosText,
	resolveD1BudgetSpentPrecisionMode,
} from './user-budget-spent-precision';

interface ReconcileConfig {
	d1: D1ExecutionConfig;
	postgresUrl: string;
	sourceFrozenConfirmed: boolean;
}

interface ReconcileCheck {
	label: string;
	d1Sql: string;
	pgSql: string;
	tolerance?: number;
}

const TARGET_SCHEMA = 'cinatoken_gateway';
const REQUIRED_MIGRATION = '0053_workspace_budgets.sql';
const GUARDRAIL_LEDGER_CHECK_PREFIX = 'guardrail-ledger:';
const BUDGET_SPENT_RECONCILE_BATCH_SIZE = 250;

function printUsage(): void {
	console.log(`Usage:
  npx tsx scripts/db/cutover/reconcile-d1-postgres.ts [options]

Options:
  --source-frozen            Required acknowledgement: source D1 writes are frozen
  --d1-source=remote|local   D1 source (default: remote)
  --d1-persist-to=<path>     Local D1 persist dir when d1-source=local (default: ${DEFAULT_D1_PERSIST_TO})
  -h, --help                 Show this help

Environment:
  DATABASE_URL                 Required PostgreSQL connection string
  D1_DATABASE_NAME             Optional source database name (default: ${DEFAULT_D1_DATABASE_NAME})
`);
}

function parseConfig(): ReconcileConfig {
	const args = process.argv.slice(2).filter((arg) => arg !== '--');
	if (args.includes('-h') || args.includes('--help')) {
		printUsage();
		process.exit(0);
	}
	const unknownArgs = args.filter(
		(arg) =>
			arg !== '--source-frozen' &&
			!arg.startsWith('--d1-source=') &&
			!arg.startsWith('--d1-persist-to=')
	);
	if (unknownArgs.length > 0) {
		throw new Error(`Unknown option(s): ${unknownArgs.join(', ')}`);
	}
	const d1Source = args.find((arg) => arg.startsWith('--d1-source='))?.split('=')[1];
	if (d1Source && d1Source !== 'remote' && d1Source !== 'local') {
		throw new Error('Invalid --d1-source, expected remote or local');
	}

	const postgresUrl = process.env.DATABASE_URL?.trim();
	if (!postgresUrl) {
		throw new Error('DATABASE_URL is required');
	}
	const sourceFrozenConfirmed = args.includes('--source-frozen');
	if (!sourceFrozenConfirmed) {
		throw new Error(
			'--source-frozen is required: reconciliation reads multiple D1 snapshots; this is an operator acknowledgement, not mechanical fencing'
		);
	}

	return {
		d1: parseD1ExecutionConfig(args),
		postgresUrl,
		sourceFrozenConfirmed,
	};
}

function normalizeValue(value: unknown): string {
	if (value == null) {
		return 'null';
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? String(value) : 'NaN';
	}
	return String(value);
}

function toNumber(value: unknown): number {
	if (value == null) {
		return 0;
	}
	if (typeof value === 'number') {
		return value;
	}
	return Number(value);
}

function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function qualifiedTable(tableName: string): string {
	return `${quoteIdentifier(TARGET_SCHEMA)}.${quoteIdentifier(tableName)}`;
}

async function runPgScalar(
	sql: postgres.Sql,
	query: string
): Promise<unknown> {
	const rows = await sql.unsafe<Record<string, unknown>[]>(query);
	if (!rows[0]) {
		return null;
	}
	return rows[0].value ?? null;
}

function runD1Scalar(query: string, config: D1ExecutionConfig): unknown {
	const rows = runD1ExecuteJson(query, config);
	if (!rows[0]) {
		return null;
	}
	return rows[0].value ?? null;
}

function toExactInteger(value: unknown): bigint | null {
	const normalized = normalizeValue(value);
	return /^-?\d+$/.test(normalized) ? BigInt(normalized) : null;
}

function compareValues(d1Value: unknown, pgValue: unknown, tolerance = 0): boolean {
	if (tolerance === 0) {
		const d1Integer = toExactInteger(d1Value);
		const pgInteger = toExactInteger(pgValue);
		if (d1Integer !== null && pgInteger !== null) {
			return d1Integer === pgInteger;
		}
	}
	const d1Number = toNumber(d1Value);
	const pgNumber = toNumber(pgValue);
	if (Number.isFinite(d1Number) && Number.isFinite(pgNumber)) {
		return Math.abs(d1Number - pgNumber) <= tolerance;
	}
	return normalizeValue(d1Value) === normalizeValue(pgValue);
}

function buildChecks(): ReconcileCheck[] {
	const checks: ReconcileCheck[] = ETL_TABLE_ORDER.map((table) => ({
		label: `row-count:${table}`,
		d1Sql: `SELECT CAST(COUNT(*) AS TEXT) AS value FROM "${table}"`,
		pgSql: `SELECT COUNT(*)::text AS value FROM ${qualifiedTable(table)}`,
	}));
	const d1Ledger = buildD1GuardrailLedgerAuditSql();
	const pgLedger = buildPostgresGuardrailLedgerAuditSql(qualifiedTable);

	checks.push(
		{
			label: 'api_key_request_logs:sum_charged_cost',
			d1Sql: 'SELECT ROUND(COALESCE(SUM(charged_cost), 0), 6) AS value FROM api_key_request_logs',
			pgSql: `SELECT ROUND(COALESCE(SUM(charged_cost), 0)::numeric, 6) AS value FROM ${qualifiedTable('api_key_request_logs')}`,
			tolerance: 0.000001,
		},
		{
			label: 'api_key_request_logs:sum_metered_cost',
			d1Sql: 'SELECT ROUND(COALESCE(SUM(metered_cost), 0), 6) AS value FROM api_key_request_logs',
			pgSql: `SELECT ROUND(COALESCE(SUM(metered_cost), 0)::numeric, 6) AS value FROM ${qualifiedTable('api_key_request_logs')}`,
			tolerance: 0.000001,
		},
		{
			label: 'api_key_request_logs:sum_total_tokens',
			d1Sql: 'SELECT CAST(COALESCE(SUM(total_tokens), 0) AS TEXT) AS value FROM api_key_request_logs',
			pgSql: `SELECT COALESCE(SUM(total_tokens), 0)::text AS value FROM ${qualifiedTable('api_key_request_logs')}`,
		},
		...[
			'request_count',
			'success_count',
			'error_count',
			'output_tokens',
			'latency_total_ms',
			'latency_sample_count',
		].map((column): ReconcileCheck => ({
			label: `public_model_daily_stats:sum_${column}`,
			d1Sql: `SELECT CAST(COALESCE(SUM(${quoteIdentifier(column)}), 0) AS TEXT) AS value FROM public_model_daily_stats`,
			pgSql: `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS value FROM ${qualifiedTable('public_model_daily_stats')}`,
		})),
		{
			label: 'user_audit_logs:sum_delta_spent_from_snapshots',
			d1Sql: `SELECT ROUND(COALESCE(SUM(
				COALESCE(CAST(json_extract(after_user_snapshot, '$.budget_spent') AS REAL), 0) -
				COALESCE(CAST(json_extract(before_user_snapshot, '$.budget_spent') AS REAL), 0)
			), 0), 6) AS value FROM user_audit_logs`,
			pgSql: `SELECT ROUND(COALESCE(SUM(
				COALESCE(NULLIF(TRIM(after_user_snapshot::json->>'budget_spent'), '')::double precision, 0) -
				COALESCE(NULLIF(TRIM(before_user_snapshot::json->>'budget_spent'), '')::double precision, 0)
			), 0)::numeric, 6) AS value FROM ${qualifiedTable('user_audit_logs')}`,
			tolerance: 0.000001,
		},
		...[
			'balance_micros',
			'locked_amount_micros',
			'lifetime_earned_micros',
			'lifetime_withdrawn_micros',
			'contribution_value_micros',
		].map((column): ReconcileCheck => ({
			label: `user_earnings:sum_${column}`,
			d1Sql: `SELECT CAST(COALESCE(SUM(${quoteIdentifier(column)}), 0) AS TEXT) AS value FROM user_earnings`,
			pgSql: `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS value FROM ${qualifiedTable('user_earnings')}`,
		})),
		...['amount_micros', 'fee_micros', 'net_amount_micros'].map(
			(column): ReconcileCheck => ({
				label: `withdrawals:sum_${column}`,
				d1Sql: `SELECT CAST(COALESCE(SUM(${quoteIdentifier(column)}), 0) AS TEXT) AS value FROM withdrawals`,
				pgSql: `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS value FROM ${qualifiedTable('withdrawals')}`,
			})
		),
		{
			label: 'target:portal_sessions_invalidated',
			d1Sql: 'SELECT 0 AS value',
			pgSql: `SELECT COUNT(*)::text AS value FROM ${qualifiedTable('portal_sessions')}`,
		},
		{
			label: 'target:admin_sessions_invalidated',
			d1Sql: 'SELECT 0 AS value',
			pgSql: `SELECT COUNT(*)::text AS value FROM ${qualifiedTable('admin_sessions')}`,
		},
		{
			label: 'ordinary-budget:source-active-reservations',
			d1Sql: `SELECT CAST(COUNT(*) AS TEXT) AS value FROM user_budget_reservations
				WHERE state IN ('reserved', 'dispatched')`,
			pgSql: 'SELECT 0::text AS value',
		},
		{
			label: 'ordinary-budget:target-active-reservations',
			d1Sql: 'SELECT CAST(0 AS TEXT) AS value',
			pgSql: `SELECT COUNT(*)::text AS value FROM ${qualifiedTable('user_budget_reservations')}
				WHERE state IN ('reserved', 'dispatched')`,
		},
		{
			label: 'ordinary-budget:source-reserved-counter-drift',
			d1Sql: `SELECT CAST(COUNT(*) AS TEXT) AS value FROM users AS account
				WHERE account.budget_reserved_micros <> COALESCE((
					SELECT SUM(reservation.reserved_micros)
					FROM user_budget_reservations AS reservation
					WHERE reservation.user_id = account.id
						AND reservation.budget_epoch = account.budget_epoch
						AND reservation.state IN ('reserved', 'dispatched')
				), 0)`,
			pgSql: 'SELECT 0::text AS value',
		},
		{
			label: 'ordinary-budget:target-reserved-counter-drift',
			d1Sql: 'SELECT CAST(0 AS TEXT) AS value',
			pgSql: `SELECT COUNT(*)::text AS value FROM ${qualifiedTable('users')} AS account
				WHERE account.budget_reserved_micros <> COALESCE((
					SELECT SUM(reservation.reserved_micros)
					FROM ${qualifiedTable('user_budget_reservations')} AS reservation
					WHERE reservation.user_id = account.id
						AND reservation.budget_epoch = account.budget_epoch
						AND reservation.state IN ('reserved', 'dispatched')
				), 0)`,
		},
		...['reserved_micros', 'settled_micros'].map((column): ReconcileCheck => ({
			label: `ordinary-budget:sum_${column}`,
			d1Sql: `SELECT CAST(COALESCE(SUM(${quoteIdentifier(column)}), 0) AS TEXT) AS value
				FROM user_budget_reservations`,
			pgSql: `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS value
				FROM ${qualifiedTable('user_budget_reservations')}`,
		})),
		...['settled', 'released', 'expired'].map((state): ReconcileCheck => ({
			label: `ordinary-budget:state_${state}_count`,
			d1Sql: `SELECT CAST(COUNT(*) AS TEXT) AS value FROM user_budget_reservations
				WHERE state = '${state}'`,
			pgSql: `SELECT COUNT(*)::text AS value FROM ${qualifiedTable('user_budget_reservations')}
				WHERE state = '${state}'`,
		})),
		...[
			['source:active-reservations', d1Ledger.activeReservationCount, 'SELECT 0::text AS value'],
			['target:active-reservations', 'SELECT CAST(0 AS TEXT) AS value', pgLedger.activeReservationCount],
			['source:window-invariants', d1Ledger.windowInvariantCounts, "SELECT 'reserved=0,settled=0,unreserved=0' AS value"],
			['target:window-invariants', "SELECT 'reserved=0,settled=0,unreserved=0' AS value", pgLedger.windowInvariantCounts],
		].map(([label, d1Sql, pgSql]): ReconcileCheck => ({
			label: `${GUARDRAIL_LEDGER_CHECK_PREFIX}${label}`,
			d1Sql: d1Sql!,
			pgSql: pgSql!,
		})),
		{
			label: 'target:portal_ledger_triggers_enabled',
			d1Sql: "SELECT 'enabled' AS value",
			pgSql: `SELECT CASE
				WHEN COUNT(*) = 5 AND bool_and(t.tgenabled = 'O') THEN 'enabled'
				ELSE 'disabled_or_missing'
			END AS value
			FROM pg_trigger t
			JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = '${TARGET_SCHEMA}'
			  AND c.relname IN ('shared_key_earnings', 'withdrawals')
			  AND NOT t.tgisinternal`,
		}
	);

	return checks;
}

function inspectD1BudgetSpentPrecision(config: D1ExecutionConfig): D1BudgetSpentPrecisionMode {
	const migrationRows = runD1ExecuteJson(
		`SELECT CAST(COUNT(*) AS TEXT) AS count FROM d1_migrations ` +
		`WHERE name = '${D1_BUDGET_SPENT_MICROS_MIGRATION}'`,
		config,
	);
	const migrationCount = migrationRows[0]?.count;
	if (migrationCount !== '0' && migrationCount !== '1') {
		throw new Error(`Invalid D1 0041 migration count: ${String(migrationCount)}`);
	}
	const mode = resolveD1BudgetSpentPrecisionMode(
		getTableColumns('users', config),
		migrationCount === '1',
	);
	const invalidRows = runD1Scalar(d1BudgetSpentInvariantSql(mode), config);
	const invalidCount = typeof invalidRows === 'number' ? invalidRows : Number(invalidRows);
	if (!Number.isSafeInteger(invalidCount) || invalidCount !== 0) {
		throw new Error(`D1 users.budget_spent is unsafe for ${mode}: ${String(invalidRows)} invalid row(s)`);
	}
	return mode;
}

interface BudgetSpentMismatch {
	userId: string;
	d1Micros: string;
	pgMicros: string;
}

async function reconcileUserBudgetSpentMicros(
	config: D1ExecutionConfig,
	sql: postgres.Sql,
	mode: D1BudgetSpentPrecisionMode,
): Promise<{ mismatchCount: number; firstMismatch?: BudgetSpentMismatch }> {
	const totalValue = runD1Scalar('SELECT CAST(COUNT(*) AS TEXT) AS value FROM users', config);
	const totalRows = Number(totalValue);
	if (!Number.isSafeInteger(totalRows) || totalRows < 0) {
		throw new Error(`Invalid D1 users count: ${String(totalValue)}`);
	}
	let mismatchCount = 0;
	let firstMismatch: BudgetSpentMismatch | undefined;
	let readRows = 0;
	for (let offset = 0; offset < totalRows; offset += BUDGET_SPENT_RECONCILE_BATCH_SIZE) {
		const sourceRows = runD1ExecuteJson(
			`SELECT id, ${d1BudgetSpentTransferExpression(mode)} AS "${D1_BUDGET_SPENT_TRANSFER_ALIAS}"
			 FROM users ORDER BY rowid LIMIT ${BUDGET_SPENT_RECONCILE_BATCH_SIZE} OFFSET ${offset}`,
			config,
		);
		if (sourceRows.length === 0) {
			throw new Error(`Short D1 users read at offset ${offset} of ${totalRows}`);
		}
		readRows += sourceRows.length;
		const userIds = sourceRows.map((row) => {
			if (typeof row.id !== 'string' || row.id.length === 0) {
				throw new Error('D1 users row contains an invalid id');
			}
			return row.id;
		});
		const placeholders = userIds.map((_, index) => `$${index + 1}`).join(', ');
		const targetRows = await sql.unsafe<Array<{ id: string; budget_spent_micros: string }>>(
			`SELECT id, (budget_spent * 1000000)::text AS budget_spent_micros
			 FROM ${qualifiedTable('users')} WHERE id IN (${placeholders})`,
			userIds,
		);
		const targetById = new Map(targetRows.map((row) => [row.id, row.budget_spent_micros]));
		for (const row of sourceRows) {
			const userId = String(row.id);
			const d1Micros = d1BudgetSpentMicrosFromTransferRow(row).toString();
			const targetValue = targetById.get(userId);
			let pgMicros = '<missing>';
			if (targetValue !== undefined) {
				try {
					pgMicros = postgresBudgetSpentMicrosText(targetValue);
				} catch {
					pgMicros = `<invalid:${String(targetValue)}>`;
				}
			}
			if (d1Micros !== pgMicros) {
				mismatchCount += 1;
				firstMismatch ??= { userId, d1Micros, pgMicros };
			}
		}
	}
	if (readRows !== totalRows) {
		throw new Error(`Short D1 users read: expected ${totalRows}, received ${readRows}`);
	}
	return { mismatchCount, firstMismatch };
}

async function reportGuardrailLedgerDifferences(
	config: ReconcileConfig,
	sql: postgres.Sql,
): Promise<void> {
	const d1Ledger = buildD1GuardrailLedgerAuditSql();
	const pgLedger = buildPostgresGuardrailLedgerAuditSql(qualifiedTable);
	const sourceActiveReservations = runD1ExecuteJson(
		d1Ledger.activeReservationDetails,
		config.d1,
	);
	const sourceWindowMismatches = runD1ExecuteJson(
		d1Ledger.windowMismatchDetails,
		config.d1,
	);
	const [targetActiveReservations, targetWindowMismatches] = await Promise.all([
		sql.unsafe<Record<string, unknown>[]>(pgLedger.activeReservationDetails),
		sql.unsafe<Record<string, unknown>[]>(pgLedger.windowMismatchDetails),
	]);

	console.error(
		`[Reconcile] Guardrail ledger differences (detail limit ${GUARDRAIL_LEDGER_DETAIL_LIMIT} per list):\n${JSON.stringify({
			source: {
				active_reservations: sourceActiveReservations,
				window_mismatches: sourceWindowMismatches,
			},
			target: {
				active_reservations: targetActiveReservations,
				window_mismatches: targetWindowMismatches,
			},
		}, null, 2)}`,
	);
}

async function assertTargetReady(sql: postgres.Sql): Promise<void> {
	const [state] = await sql.unsafe<
		{ current_schema: string | null; current: boolean; legacy_schema: boolean }[]
	>(`
		SELECT
			current_schema() AS current_schema,
			to_regnamespace('octafuse_gateway') IS NOT NULL AS legacy_schema,
			EXISTS (
				SELECT 1 FROM ${qualifiedTable('schema_migrations')}
				WHERE version = '${REQUIRED_MIGRATION}'
			) AS current
	`);
	if (state?.current_schema !== TARGET_SCHEMA || !state.current || state.legacy_schema) {
		throw new Error(
			`PostgreSQL target is not ready: schema=${String(state?.current_schema)}, legacy=${String(state?.legacy_schema)}, required=${REQUIRED_MIGRATION}`
		);
	}
}

async function main(): Promise<void> {
	const config = parseConfig();
	const sql = postgres(config.postgresUrl, {
		max: 1,
		connection: { search_path: `${TARGET_SCHEMA}, public` },
	});
	let failed = 0;
	let guardrailLedgerFailed = false;

	try {
		await assertTargetReady(sql);
		const budgetSpentPrecisionMode = inspectD1BudgetSpentPrecision(config.d1);
		console.log(
			`[Reconcile] D1(${config.d1.source}:${config.d1.databaseName}) vs Postgres(${TARGET_SCHEMA}); source-frozen=${config.sourceFrozenConfirmed} (operator acknowledgement, not fencing); user-budget-spent=${budgetSpentPrecisionMode}`
		);
		for (const check of buildChecks()) {
			const d1Value = runD1Scalar(check.d1Sql, config.d1);
			const pgValue = await runPgScalar(sql, check.pgSql);
			const matched = compareValues(d1Value, pgValue, check.tolerance ?? 0);
			const prefix = matched ? 'OK ' : 'ERR';
			console.log(
				`[${prefix}] ${check.label} | d1=${normalizeValue(d1Value)} | pg=${normalizeValue(pgValue)}`
			);
			if (!matched) {
				failed += 1;
				guardrailLedgerFailed ||= check.label.startsWith(GUARDRAIL_LEDGER_CHECK_PREFIX);
			}
		}
		const budgetSpent = await reconcileUserBudgetSpentMicros(config.d1, sql, budgetSpentPrecisionMode);
		const budgetSpentMatched = budgetSpent.mismatchCount === 0;
		console.log(
			`[${budgetSpentMatched ? 'OK ' : 'ERR'}] users:budget_spent_micros_exact | ` +
			(budgetSpentMatched
				? `mode=${budgetSpentPrecisionMode}; mismatches=0`
				: `mismatches=${budgetSpent.mismatchCount}; first=${JSON.stringify(budgetSpent.firstMismatch)}`),
		);
		if (!budgetSpentMatched) failed += 1;
		if (guardrailLedgerFailed) {
			await reportGuardrailLedgerDifferences(config, sql);
		}
	} finally {
		await sql.end();
	}

	if (failed > 0) {
		throw new Error(`Reconciliation failed (${failed} mismatch checks).`);
	}

	console.log('[Reconcile] All checks passed.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
