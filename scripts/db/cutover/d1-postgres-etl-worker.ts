import postgres from 'postgres';
import type { D1Database } from '@cloudflare/workers-types';
import {
	ETL_EXCLUDED_SESSION_TABLES,
	ETL_TABLE_ORDER,
	ETL_TABLES_TO_TRUNCATE,
	TABLE_BOOLEAN_COLUMNS,
	TABLE_CONFLICT_KEYS,
	type EtlTableName,
} from '../lib/migration-tables';
import { isDiagnosticRequestAuthorized } from './diagnostic-auth';
import {
	buildD1GuardrailLedgerAuditSql,
	buildPostgresGuardrailLedgerAuditSql,
	GUARDRAIL_LEDGER_DETAIL_LIMIT,
} from './guardrail-ledger-contract';
import { GATEWAY_MIGRATOR_ROLE, GATEWAY_SCHEMA } from './provision-postgres-roles';
import {
	D1_BUDGET_SPENT_MICROS_MIGRATION,
	D1_BUDGET_SPENT_TRANSFER_ALIAS,
	type D1BudgetSpentPrecisionMode,
	d1BudgetSpentInvariantSql,
	d1BudgetSpentMicrosFromTransferRow,
	d1BudgetSpentTransferExpression,
	postgresBudgetSpentFromTransferRow,
	postgresBudgetSpentMicrosText,
	postgresUserColumnsForD1Source,
	resolveD1BudgetSpentPrecisionMode,
} from './user-budget-spent-precision';

interface EtlWorkerEnv {
	SOURCE_DB: D1Database;
	MIGRATOR_HYPERDRIVE: { readonly connectionString: string };
	PREFLIGHT_TOKEN?: string;
	/** 运维显式确认（仅获批的切换窗口注入）：源库已冻结 / 目标已离线。仅为 attestation，不构成数据库 fencing。 */
	ETL_ATTEST_SOURCE_FROZEN?: string;
	ETL_ATTEST_TARGET_OFFLINE?: string;
}

interface D1ColumnInfo {
	name: string;
	type: string;
}

interface ReconcileCheck {
	label: string;
	d1Sql: string;
	pgSql: string;
	tolerance?: number;
}

type EtlSqlValue = string | number | boolean | null;

const REQUIRED_MIGRATION = '0054_generation_metadata_snapshots.sql';
const ETL_LOCK_KEY = 746923552;
const BATCH_SIZE = 250;
const MAX_POSTGRES_BATCH_PARAMETERS = 60_000;
const GUARDRAIL_LEDGER_CHECK_PREFIX = 'guardrail-ledger:';

function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function qualifiedTable(tableName: string): string {
	return `${quoteIdentifier(GATEWAY_SCHEMA)}.${quoteIdentifier(tableName)}`;
}

function buildUpsertClause(tableName: EtlTableName, columns: string[]): string {
	const conflictKeys = TABLE_CONFLICT_KEYS[tableName];
	const updatableColumns = columns.filter((column) => !conflictKeys.includes(column));
	if (updatableColumns.length === 0) {
		return ` ON CONFLICT (${conflictKeys.map(quoteIdentifier).join(', ')}) DO NOTHING`;
	}
	return ` ON CONFLICT (${conflictKeys.map(quoteIdentifier).join(', ')}) DO UPDATE SET ${updatableColumns
		.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
		.join(', ')}`;
}

function buildBatchInsertSql(tableName: EtlTableName, columns: string[], rowCount: number): string {
	const quotedColumns = columns.map(quoteIdentifier).join(', ');
	const values = Array.from({ length: rowCount }, (_, rowIndex) => {
		const placeholders = columns
			.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`)
			.join(', ');
		return `(${placeholders})`;
	}).join(', ');
	return `INSERT INTO ${qualifiedTable(tableName)} (${quotedColumns}) VALUES ${values}${buildUpsertClause(tableName, columns)}`;
}

function toSqlValue(tableName: EtlTableName, columnName: string, value: unknown): EtlSqlValue {
	if (value === undefined || value === null) return null;
	if (TABLE_BOOLEAN_COLUMNS[tableName]?.includes(columnName)) {
		if (value === true || value === 1 || value === '1') return true;
		if (value === false || value === 0 || value === '0') return false;
		throw new Error(`invalid_sqlite_boolean:${tableName}.${columnName}`);
	}
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	throw new Error(`unsupported_d1_value:${tableName}.${columnName}:${typeof value}`);
}

async function getD1Columns(db: D1Database, tableName: EtlTableName): Promise<D1ColumnInfo[]> {
	const result = await db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all<D1ColumnInfo>();
	return result.results ?? [];
}

async function inspectD1BudgetSpentPrecision(db: D1Database): Promise<D1BudgetSpentPrecisionMode> {
	const userColumns = (await getD1Columns(db, 'users')).map((column) => column.name);
	const migration = await db.prepare(
		`SELECT CAST(COUNT(*) AS TEXT) AS count FROM d1_migrations WHERE name = ?`,
	).bind(D1_BUDGET_SPENT_MICROS_MIGRATION).first<{ count: string }>();
	const migrationCount = migration?.count;
	if (migrationCount !== '0' && migrationCount !== '1') {
		throw new Error(`invalid_d1_0041_migration_count:${String(migrationCount)}`);
	}
	const mode = resolveD1BudgetSpentPrecisionMode(userColumns, migrationCount === '1');
	const invalid = await db.prepare(d1BudgetSpentInvariantSql(mode)).first<{ value: number | string }>();
	const invalidCount = Number(invalid?.value ?? -1);
	if (!Number.isSafeInteger(invalidCount) || invalidCount !== 0) {
		throw new Error(`unsafe_d1_budget_spent:${mode}:${String(invalid?.value)}`);
	}
	return mode;
}

function d1SelectList(tableName: EtlTableName, columns: D1ColumnInfo[]): string {
	return columns.map((column) => {
		const identifier = quoteIdentifier(column.name);
		if (/INT/i.test(column.type) && !TABLE_BOOLEAN_COLUMNS[tableName]?.includes(column.name)) {
			return `CAST(${identifier} AS TEXT) AS ${identifier}`;
		}
		return identifier;
	}).join(', ');
}

async function assertTargetReady(sql: postgres.Sql): Promise<void> {
	const [state] = await sql.unsafe<Array<{
		user_name: string;
		current_schema: string | null;
		schema_owner: string | null;
		schema_usage: boolean;
		current: boolean;
		legacy_schema: boolean;
	}>>(`
		SELECT current_user AS user_name,
			current_schema() AS current_schema,
			(SELECT owner.rolname
			 FROM pg_namespace AS namespace
			 JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
			 WHERE namespace.nspname = '${GATEWAY_SCHEMA}') AS schema_owner,
			has_schema_privilege(current_user, '${GATEWAY_SCHEMA}', 'USAGE') AS schema_usage,
			EXISTS (
				SELECT 1 FROM ${qualifiedTable('schema_migrations')}
				WHERE version = '${REQUIRED_MIGRATION}'
			) AS current,
			to_regnamespace('octafuse_gateway') IS NOT NULL AS legacy_schema
	`);
	if (
		state?.user_name !== GATEWAY_MIGRATOR_ROLE ||
		state.schema_owner !== GATEWAY_MIGRATOR_ROLE ||
		!state.schema_usage ||
		!state.current ||
		state.legacy_schema
	) {
		throw new Error(
			`unsafe_postgres_target:user=${String(state?.user_name)};schema=${String(state?.current_schema)};owner=${String(state?.schema_owner)};usage=${String(state?.schema_usage)};current=${String(state?.current)};legacy=${String(state?.legacy_schema)}`,
		);
	}
}

async function migrateTable(
	db: D1Database,
	tx: postgres.TransactionSql,
	tableName: EtlTableName,
	budgetSpentPrecisionMode: D1BudgetSpentPrecisionMode,
): Promise<number> {
	const columnInfo = await getD1Columns(db, tableName);
	const sourceColumns = columnInfo.map((column) => column.name);
	if (sourceColumns.length === 0) throw new Error(`missing_d1_table:${tableName}`);
	const columns = tableName === 'users'
		? postgresUserColumnsForD1Source(sourceColumns)
		: sourceColumns;
	const countRow = await db.prepare(
		`SELECT CAST(COUNT(*) AS TEXT) AS count FROM ${quoteIdentifier(tableName)}`,
	).first<{ count: string | number }>();
	const totalRows = Number(countRow?.count ?? 0);
	if (!Number.isSafeInteger(totalRows) || totalRows < 0) throw new Error(`invalid_d1_count:${tableName}`);
	const batchSize = Math.min(BATCH_SIZE, Math.max(1, Math.floor(MAX_POSTGRES_BATCH_PARAMETERS / columns.length)));
	const selectList = tableName === 'users'
		? `${d1SelectList(tableName, columnInfo)}, ` +
			`${d1BudgetSpentTransferExpression(budgetSpentPrecisionMode)} AS ${quoteIdentifier(D1_BUDGET_SPENT_TRANSFER_ALIAS)}`
		: d1SelectList(tableName, columnInfo);
	let migrated = 0;
	for (let offset = 0; offset < totalRows; offset += batchSize) {
		const result = await db.prepare(
			`SELECT ${selectList} FROM ${quoteIdentifier(tableName)} ORDER BY rowid LIMIT ? OFFSET ?`,
		).bind(batchSize, offset).all<Record<string, unknown>>();
		const rows = result.results ?? [];
		if (rows.length === 0) break;
		const params = rows.flatMap((row) => columns.map((column) => {
			if (tableName === 'users' && column === 'budget_spent') {
				return postgresBudgetSpentFromTransferRow(row);
			}
			return toSqlValue(tableName, column, row[column]);
		}));
		await tx.unsafe(buildBatchInsertSql(tableName, columns, rows.length), params);
		migrated += rows.length;
	}
	if (migrated !== totalRows) throw new Error(`short_d1_read:${tableName}:${migrated}:${totalRows}`);
	return migrated;
}

async function runEtl(env: EtlWorkerEnv): Promise<{
	counts: Record<string, number>;
	budgetSpentPrecisionMode: D1BudgetSpentPrecisionMode;
}> {
	const sql = postgres(env.MIGRATOR_HYPERDRIVE.connectionString, {
		max: 1,
		fetch_types: false,
		prepare: true,
		connect_timeout: 10,
		idle_timeout: 5,
		connection: { search_path: `${GATEWAY_SCHEMA}, public` },
	});
	try {
		await assertTargetReady(sql);
		const budgetSpentPrecisionMode = await inspectD1BudgetSpentPrecision(env.SOURCE_DB);
		console.log('cinatoken.d1_postgres_budget_spent_precision', {
			operation: 'etl',
			mode: budgetSpentPrecisionMode,
		});
		const activeGuardrailReservations = await env.SOURCE_DB.prepare(`
			SELECT COUNT(*) AS count FROM guardrail_budget_reservations
			WHERE state IN ('reserved', 'dispatched')
		`).first<{ count: number | string }>();
		const activeReservationCount = Number(activeGuardrailReservations?.count ?? 0);
		if (!Number.isSafeInteger(activeReservationCount) || activeReservationCount !== 0) {
			throw new Error(`active_guardrail_budget_reservations:${String(activeGuardrailReservations?.count ?? 0)}`);
		}
		const activeUserBudgetReservations = await env.SOURCE_DB.prepare(`
			SELECT COUNT(*) AS count FROM user_budget_reservations
			WHERE state IN ('reserved', 'dispatched')
		`).first<{ count: number | string }>();
		const activeUserReservationCount = Number(activeUserBudgetReservations?.count ?? 0);
		if (!Number.isSafeInteger(activeUserReservationCount) || activeUserReservationCount !== 0) {
			throw new Error(`active_user_budget_reservations:${String(activeUserBudgetReservations?.count ?? 0)}`);
		}
		const counts: Record<string, number> = {};
		await sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${ETL_LOCK_KEY})`;
			await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(GATEWAY_SCHEMA)}, public`);
			await tx.unsafe(`ALTER TABLE ${qualifiedTable('shared_key_earnings')} DISABLE TRIGGER USER`);
			await tx.unsafe(`ALTER TABLE ${qualifiedTable('withdrawals')} DISABLE TRIGGER USER`);
			const tables = [...ETL_TABLES_TO_TRUNCATE, ...ETL_EXCLUDED_SESSION_TABLES];
			await tx.unsafe(`TRUNCATE TABLE ${tables.map(qualifiedTable).join(', ')} CASCADE`);
			for (const tableName of ETL_TABLE_ORDER) {
				counts[tableName] = await migrateTable(
					env.SOURCE_DB,
					tx,
					tableName,
					budgetSpentPrecisionMode,
				);
			}
			await tx.unsafe(`TRUNCATE TABLE ${ETL_EXCLUDED_SESSION_TABLES.map(qualifiedTable).join(', ')}`);
			await tx.unsafe(`ALTER TABLE ${qualifiedTable('withdrawals')} ENABLE TRIGGER USER`);
			await tx.unsafe(`ALTER TABLE ${qualifiedTable('shared_key_earnings')} ENABLE TRIGGER USER`);
		});
		return { counts, budgetSpentPrecisionMode };
	} finally {
		await sql.end({ timeout: 1 }).catch(() => undefined);
	}
}

function buildReconcileChecks(): ReconcileCheck[] {
	const checks: ReconcileCheck[] = ETL_TABLE_ORDER.map((table) => ({
		label: `row-count:${table}`,
		d1Sql: `SELECT CAST(COUNT(*) AS TEXT) AS value FROM ${quoteIdentifier(table)}`,
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
		...['balance_micros', 'locked_amount_micros', 'lifetime_earned_micros', 'lifetime_withdrawn_micros', 'contribution_value_micros'].map((column): ReconcileCheck => ({
			label: `user_earnings:sum_${column}`,
			d1Sql: `SELECT CAST(COALESCE(SUM(${quoteIdentifier(column)}), 0) AS TEXT) AS value FROM user_earnings`,
			pgSql: `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS value FROM ${qualifiedTable('user_earnings')}`,
		})),
		...['amount_micros', 'fee_micros', 'net_amount_micros'].map((column): ReconcileCheck => ({
			label: `withdrawals:sum_${column}`,
			d1Sql: `SELECT CAST(COALESCE(SUM(${quoteIdentifier(column)}), 0) AS TEXT) AS value FROM withdrawals`,
			pgSql: `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS value FROM ${qualifiedTable('withdrawals')}`,
		})),
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
			pgSql: `SELECT CASE WHEN COUNT(*) = 5 AND bool_and(t.tgenabled = 'O') THEN 'enabled' ELSE 'disabled_or_missing' END AS value
				FROM pg_trigger t
				JOIN pg_class c ON c.oid = t.tgrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = '${GATEWAY_SCHEMA}'
				  AND c.relname IN ('shared_key_earnings', 'withdrawals')
				  AND NOT t.tgisinternal`,
		},
	);
	return checks;
}

function normalizeValue(value: unknown): string {
	if (value == null) return 'null';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
	return String(value);
}

function toExactInteger(value: unknown): bigint | null {
	const normalized = normalizeValue(value);
	return /^-?\d+$/.test(normalized) ? BigInt(normalized) : null;
}

function compareValues(d1Value: unknown, pgValue: unknown, tolerance = 0): boolean {
	if (tolerance === 0) {
		const d1Integer = toExactInteger(d1Value);
		const pgInteger = toExactInteger(pgValue);
		if (d1Integer !== null && pgInteger !== null) return d1Integer === pgInteger;
	}
	const d1Number = Number(d1Value ?? 0);
	const pgNumber = Number(pgValue ?? 0);
	if (Number.isFinite(d1Number) && Number.isFinite(pgNumber)) {
		return Math.abs(d1Number - pgNumber) <= tolerance;
	}
	return normalizeValue(d1Value) === normalizeValue(pgValue);
}

interface GuardrailLedgerDifferences {
	detail_limit: number;
	source: {
		active_reservations: Record<string, unknown>[];
		window_mismatches: Record<string, unknown>[];
	};
	target: {
		active_reservations: Record<string, unknown>[];
		window_mismatches: Record<string, unknown>[];
	};
}

interface BudgetSpentReconcileResult {
	mismatchCount: number;
	firstMismatch?: { userId: string; d1Micros: string; pgMicros: string };
}

async function reconcileUserBudgetSpentMicros(
	db: D1Database,
	sql: postgres.Sql,
	mode: D1BudgetSpentPrecisionMode,
): Promise<BudgetSpentReconcileResult> {
	const count = await db.prepare('SELECT CAST(COUNT(*) AS TEXT) AS count FROM users')
		.first<{ count: string }>();
	const totalRows = Number(count?.count ?? -1);
	if (!Number.isSafeInteger(totalRows) || totalRows < 0) {
		throw new Error(`invalid_d1_count:users:${String(count?.count)}`);
	}
	let mismatchCount = 0;
	let firstMismatch: BudgetSpentReconcileResult['firstMismatch'];
	let readRows = 0;
	for (let offset = 0; offset < totalRows; offset += BATCH_SIZE) {
		const source = await db.prepare(
			`SELECT id, ${d1BudgetSpentTransferExpression(mode)} AS ${quoteIdentifier(D1_BUDGET_SPENT_TRANSFER_ALIAS)}
			 FROM users ORDER BY rowid LIMIT ? OFFSET ?`,
		).bind(BATCH_SIZE, offset).all<Record<string, unknown>>();
		const sourceRows = source.results ?? [];
		if (sourceRows.length === 0) {
			throw new Error(`short_d1_read:users:${offset}:${totalRows}`);
		}
		readRows += sourceRows.length;
		const userIds = sourceRows.map((row) => {
			if (typeof row.id !== 'string' || row.id.length === 0) throw new Error('invalid_d1_user_id');
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
		throw new Error(`short_d1_read:users:${readRows}:${totalRows}`);
	}
	return { mismatchCount, firstMismatch };
}

async function collectGuardrailLedgerDifferences(
	env: EtlWorkerEnv,
	sql: postgres.Sql,
): Promise<GuardrailLedgerDifferences> {
	const d1Ledger = buildD1GuardrailLedgerAuditSql();
	const pgLedger = buildPostgresGuardrailLedgerAuditSql(qualifiedTable);
	const [sourceActive, sourceWindows, targetActive, targetWindows] = await Promise.all([
		env.SOURCE_DB.prepare(d1Ledger.activeReservationDetails).all<Record<string, unknown>>(),
		env.SOURCE_DB.prepare(d1Ledger.windowMismatchDetails).all<Record<string, unknown>>(),
		sql.unsafe<Record<string, unknown>[]>(pgLedger.activeReservationDetails),
		sql.unsafe<Record<string, unknown>[]>(pgLedger.windowMismatchDetails),
	]);
	return {
		detail_limit: GUARDRAIL_LEDGER_DETAIL_LIMIT,
		source: {
			active_reservations: sourceActive.results ?? [],
			window_mismatches: sourceWindows.results ?? [],
		},
		target: {
			active_reservations: targetActive,
			window_mismatches: targetWindows,
		},
	};
}

async function runReconcile(env: EtlWorkerEnv): Promise<{
	total: number;
	failed: string[];
	mismatches: Array<{ label: string; d1_value: string; pg_value: string }>;
	budgetSpentPrecisionMode: D1BudgetSpentPrecisionMode;
	ledgerDifferences?: GuardrailLedgerDifferences;
}> {
	const sql = postgres(env.MIGRATOR_HYPERDRIVE.connectionString, {
		max: 1,
		fetch_types: false,
		prepare: true,
		connect_timeout: 10,
		idle_timeout: 5,
		connection: { search_path: `${GATEWAY_SCHEMA}, public` },
	});
	try {
		await assertTargetReady(sql);
		const budgetSpentPrecisionMode = await inspectD1BudgetSpentPrecision(env.SOURCE_DB);
		console.log('cinatoken.d1_postgres_budget_spent_precision', {
			operation: 'reconcile',
			mode: budgetSpentPrecisionMode,
		});
		const failed: string[] = [];
		const mismatches: Array<{ label: string; d1_value: string; pg_value: string }> = [];
		const checks = buildReconcileChecks();
		for (const check of checks) {
			const [d1Row, pgRows] = await Promise.all([
				env.SOURCE_DB.prepare(check.d1Sql).first<{ value: unknown }>(),
				sql.unsafe<Array<{ value: unknown }>>(check.pgSql),
			]);
			const d1Value = d1Row?.value ?? null;
			const pgValue = pgRows[0]?.value ?? null;
			if (!compareValues(d1Value, pgValue, check.tolerance ?? 0)) {
				failed.push(check.label);
				mismatches.push({
					label: check.label,
					d1_value: normalizeValue(d1Value),
					pg_value: normalizeValue(pgValue),
				});
			}
		}
		const budgetSpent = await reconcileUserBudgetSpentMicros(
			env.SOURCE_DB,
			sql,
			budgetSpentPrecisionMode,
		);
		if (budgetSpent.mismatchCount !== 0) {
			failed.push('users:budget_spent_micros_exact');
			mismatches.push({
				label: 'users:budget_spent_micros_exact',
				d1_value: budgetSpent.firstMismatch
					? `${budgetSpent.firstMismatch.userId}:${budgetSpent.firstMismatch.d1Micros}`
					: '<unavailable>',
				pg_value: budgetSpent.firstMismatch?.pgMicros ?? '<unavailable>',
			});
		}
		const ledgerDifferences = failed.some((label) => label.startsWith(GUARDRAIL_LEDGER_CHECK_PREFIX))
			? await collectGuardrailLedgerDifferences(env, sql)
			: undefined;
		if (ledgerDifferences) {
			console.error('cinatoken.guardrail_ledger_reconcile_mismatch', {
				failed: failed.filter((label) => label.startsWith(GUARDRAIL_LEDGER_CHECK_PREFIX)),
				ledger_differences: ledgerDifferences,
			});
		}
		return {
			total: checks.length + 1,
			failed,
			mismatches,
			budgetSpentPrecisionMode,
			ledgerDifferences,
		};
	} finally {
		await sql.end({ timeout: 1 }).catch(() => undefined);
	}
}

export default {
	async fetch(request: Request, env: EtlWorkerEnv): Promise<Response> {
		const path = new URL(request.url).pathname;
		const methodAllowed = (path === '/etl' && request.method === 'POST') ||
			(path === '/reconcile' && request.method === 'GET');
		if (!methodAllowed) return new Response('Not found', { status: 404 });
		if (!env.PREFLIGHT_TOKEN) {
			return Response.json({ ok: false, error: 'missing_preflight_token' }, { status: 503 });
		}
		if (!await isDiagnosticRequestAuthorized(request, env.PREFLIGHT_TOKEN)) {
			return new Response('Not found', { status: 404 });
		}
		if (!env.SOURCE_DB || !env.MIGRATOR_HYPERDRIVE?.connectionString) {
			return Response.json({ ok: false, error: 'missing_database_binding' }, { status: 503 });
		}
		try {
			const sourceFrozen = env.ETL_ATTEST_SOURCE_FROZEN === 'true';
			if (path === '/etl') {
				// 审计 M9：此前无条件 TRUNCATE+关触发器，却硬编码返回 source_frozen/target_offline=true。
				// 现要求运维在获批窗口显式注入两项确认变量；它们只是 attestation，不冒充数据库 fencing。
				const targetOffline = env.ETL_ATTEST_TARGET_OFFLINE === 'true';
				if (!sourceFrozen || !targetOffline) {
					return Response.json({ ok: false, error: 'etl_attestation_missing', source_frozen: sourceFrozen, target_offline: targetOffline }, {
						status: 409,
						headers: { 'Cache-Control': 'no-store' },
					});
				}
				const result = await runEtl(env);
				return Response.json({
					ok: true,
					source_frozen: sourceFrozen,
					target_offline: targetOffline,
					user_budget_spent_precision: result.budgetSpentPrecisionMode,
					counts: result.counts,
				}, {
					headers: { 'Cache-Control': 'no-store' },
				});
			}
			if (!sourceFrozen) {
				return Response.json({
					ok: false,
					error: 'source_frozen_attestation_missing',
					source_frozen: false,
					attestation_only: true,
				}, {
					status: 409,
					headers: { 'Cache-Control': 'no-store' },
				});
			}
			const result = await runReconcile(env);
			return Response.json({
				ok: result.failed.length === 0,
				source_frozen: sourceFrozen,
				attestation_only: true,
				user_budget_spent_precision: result.budgetSpentPrecisionMode,
				checks: result.total,
				failed: result.failed,
				mismatches: result.mismatches,
				ledger_differences: result.ledgerDifferences,
			}, {
				status: result.failed.length === 0 ? 200 : 502,
				headers: { 'Cache-Control': 'no-store' },
			});
		} catch (error) {
			console.error('cinatoken.d1_postgres_cutover_worker_failed', {
				operation: path === '/etl' ? 'etl' : 'reconcile',
				error: error instanceof Error ? error.message : 'unknown',
			});
			return Response.json({ ok: false, error: path === '/etl' ? 'etl_failed' : 'reconcile_failed' }, {
				status: 502,
				headers: { 'Cache-Control': 'no-store' },
			});
		}
	},
} satisfies {
	fetch(request: Request, env: EtlWorkerEnv): Promise<Response>;
};
