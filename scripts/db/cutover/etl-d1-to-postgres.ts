import postgres from 'postgres';
import {
	ETL_TABLE_ORDER,
	ETL_TABLES_TO_TRUNCATE,
	ETL_EXCLUDED_SESSION_TABLES,
	TABLE_BOOLEAN_COLUMNS,
	TABLE_CONFLICT_KEYS,
	type EtlTableName,
} from '../lib/migration-tables';
import {
	type D1ExecutionConfig,
	getTableColumns,
	parseD1ExecutionConfig,
	runD1ExecuteJson,
	DEFAULT_D1_DATABASE_NAME,
	DEFAULT_D1_PERSIST_TO,
} from '../lib/d1-execute';
import {
	assertGuardrailLedgerTableSelection,
	GUARDRAIL_LEDGER_TABLES,
} from './guardrail-ledger-contract';
import {
	D1_BUDGET_SPENT_MICROS_MIGRATION,
	D1_BUDGET_SPENT_TRANSFER_ALIAS,
	type D1BudgetSpentPrecisionMode,
	d1BudgetSpentInvariantSql,
	d1BudgetSpentTransferExpression,
	postgresBudgetSpentFromTransferRow,
	postgresUserColumnsForD1Source,
	resolveD1BudgetSpentPrecisionMode,
} from './user-budget-spent-precision';

interface EtlConfig {
	postgresUrl: string;
	batchSize: number;
	truncateBeforeLoad: boolean;
	tableFilter: Set<string> | null;
	guardrailLedgerIncluded: boolean;
	ordinaryBudgetLedgerIncluded: boolean;
	targetOfflineConfirmed: boolean;
	sourceFrozenConfirmed: boolean;
	d1: D1ExecutionConfig;
}

const TARGET_SCHEMA = 'cinatoken_gateway';
const REQUIRED_MIGRATION = '0053_workspace_budgets.sql';
const ETL_LOCK_KEY = 746923552;
const MAX_POSTGRES_BATCH_PARAMETERS = 60_000;
const ORDINARY_BUDGET_ETL_TABLES = ['users', 'user_budget_reservations'] as const;
type QuerySql = postgres.Sql | postgres.TransactionSql;
type EtlSqlValue = string | number | boolean | null;

function printUsage(): void {
	console.log(`Usage:
  npx tsx scripts/db/cutover/etl-d1-to-postgres.ts [options]

Options:
  --batch-size=<n>           Batch size per INSERT (default: 500)
  --truncate                 TRUNCATE target tables before ETL (recommended first run)
  --tables=<a,b,c>           Only migrate selected tables (do not combine with --truncate).
                             Guardrail logs/windows/reservations must be selected together
                             Users/user budget reservations must be selected together
  --target-offline           Required acknowledgement: target has no live writers/readers
  --source-frozen            Required acknowledgement: source D1 writes are frozen
  --d1-source=remote|local   D1 source (default: remote)
  --d1-persist-to=<path>     Local D1 persist dir when d1-source=local (default: ${DEFAULT_D1_PERSIST_TO})
  -h, --help                 Show this help

Environment:
  DATABASE_URL                 Required target PostgreSQL connection string
                               Target schema is always cinatoken_gateway
  D1_DATABASE_NAME             Optional source database name (default: ${DEFAULT_D1_DATABASE_NAME})
  D1_PERSIST_TO                Optional fallback for local D1 path
`);
}

function parseConfig(): EtlConfig {
	const args = process.argv.slice(2).filter((arg) => arg !== '--');
	if (args.includes('-h') || args.includes('--help')) {
		printUsage();
		process.exit(0);
	}

	const unknownArgs = args.filter(
		(arg) =>
			arg !== '--truncate' &&
			arg !== '--target-offline' &&
			arg !== '--source-frozen' &&
			!arg.startsWith('--batch-size=') &&
			!arg.startsWith('--tables=') &&
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

	const batchSizeArg = args.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1];
	const batchSize = batchSizeArg ? Number(batchSizeArg) : 500;
	if (!Number.isFinite(batchSize) || batchSize <= 0) {
		throw new Error('Invalid --batch-size, expected a positive number');
	}

	const tablesArg = args.find((arg) => arg.startsWith('--tables='))?.split('=')[1];
	const tableFilter = tablesArg
		? new Set(
				tablesArg
					.split(',')
					.map((item) => item.trim())
					.filter((item) => item.length > 0)
		  )
		: null;
	if (tableFilter?.size === 0) {
		throw new Error('Invalid --tables, expected at least one table name');
	}
	const invalidTables = [...(tableFilter ?? [])].filter(
		(tableName) => !ETL_TABLE_ORDER.includes(tableName as EtlTableName)
	);
	if (invalidTables.length > 0) {
		throw new Error(`Unknown ETL table(s): ${invalidTables.join(', ')}`);
	}
	const guardrailLedgerIncluded = assertGuardrailLedgerTableSelection(tableFilter);
	const selectedOrdinaryBudgetTables = tableFilter == null
		? ORDINARY_BUDGET_ETL_TABLES.length
		: ORDINARY_BUDGET_ETL_TABLES.filter((table) => tableFilter.has(table)).length;
	if (selectedOrdinaryBudgetTables !== 0 && selectedOrdinaryBudgetTables !== ORDINARY_BUDGET_ETL_TABLES.length) {
		throw new Error(
			`Ordinary-user budget account and reservation tables are an indivisible cutover group: ${ORDINARY_BUDGET_ETL_TABLES.join(', ')}`,
		);
	}
	const ordinaryBudgetLedgerIncluded = selectedOrdinaryBudgetTables === ORDINARY_BUDGET_ETL_TABLES.length;

	const truncateBeforeLoad = args.includes('--truncate');
	if (truncateBeforeLoad && tableFilter) {
		throw new Error(
			'--truncate cannot be combined with --tables: this would still wipe all target tables. Use full ETL with --truncate, or partial --tables without --truncate.'
		);
	}

	const targetOfflineConfirmed = args.includes('--target-offline');
	if (!targetOfflineConfirmed) {
		throw new Error(
			'--target-offline is required: ETL temporarily disables ledger triggers and must never run against a live target'
		);
	}
	const sourceFrozenConfirmed = args.includes('--source-frozen');
	if (!sourceFrozenConfirmed) {
		throw new Error(
			'--source-frozen is required: remote D1 queries do not share one snapshot, so source writes must be frozen'
		);
	}

	return {
		postgresUrl,
		batchSize,
		truncateBeforeLoad,
		tableFilter,
		guardrailLedgerIncluded,
		ordinaryBudgetLedgerIncluded,
		targetOfflineConfirmed,
		sourceFrozenConfirmed,
		d1: parseD1ExecutionConfig(args),
	};
}

function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function qualifiedTable(tableName: string): string {
	return `${quoteIdentifier(TARGET_SCHEMA)}.${quoteIdentifier(tableName)}`;
}

function toSqlValue(tableName: EtlTableName, columnName: string, value: unknown): EtlSqlValue {
	if (value === undefined || value === null) {
		return null;
	}
	if (TABLE_BOOLEAN_COLUMNS[tableName]?.includes(columnName)) {
		if (value === true || value === 1 || value === '1') {
			return true;
		}
		if (value === false || value === 0 || value === '0') {
			return false;
		}
		throw new Error(`Invalid SQLite boolean ${tableName}.${columnName}: ${String(value)}`);
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	throw new Error(`Unsupported D1 value type for ${tableName}.${columnName}: ${typeof value}`);
}

function buildUpsertClause(tableName: EtlTableName, columns: string[]): string {
	const conflictKeys = TABLE_CONFLICT_KEYS[tableName];
	if (!conflictKeys || conflictKeys.length === 0) {
		return '';
	}
	const updatableColumns = columns.filter((column) => !conflictKeys.includes(column));
	if (updatableColumns.length === 0) {
		return ` ON CONFLICT (${conflictKeys.map(quoteIdentifier).join(', ')}) DO NOTHING`;
	}
	return ` ON CONFLICT (${conflictKeys.map(quoteIdentifier).join(', ')}) DO UPDATE SET ${updatableColumns
		.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
		.join(', ')}`;
}

async function truncateTables(sql: QuerySql): Promise<void> {
	const tables = [...ETL_TABLES_TO_TRUNCATE, ...ETL_EXCLUDED_SESSION_TABLES];
	const statement = `TRUNCATE TABLE ${tables.map(qualifiedTable).join(', ')} CASCADE`;
	await sql.unsafe(statement);
}

async function assertGuardrailLedgerTargetEmpty(sql: QuerySql): Promise<void> {
	const countExpressions = GUARDRAIL_LEDGER_TABLES.map(
		(table) => `(SELECT COUNT(*)::text FROM ${qualifiedTable(table)}) AS ${quoteIdentifier(table)}`,
	).join(',\n');
	const [counts] = await sql.unsafe<Record<string, string>[]>(`SELECT ${countExpressions}`);
	if (!counts) {
		throw new Error('Unable to verify that the target Guardrail ledger tables are empty');
	}
	const nonEmpty = GUARDRAIL_LEDGER_TABLES.filter((table) => {
		const value = counts[table];
		return value === undefined || !/^\d+$/u.test(value) || BigInt(value) !== 0n;
	});
	if (nonEmpty.length > 0) {
		const details = GUARDRAIL_LEDGER_TABLES.map(
			(table) => `${table}=${String(counts[table] ?? 'unavailable')}`,
		).join(', ');
		throw new Error(
			`Target Guardrail ledger must be truncated or all three tables must be empty before load (${details})`,
		);
	}
	console.log('[ETL] verified target Guardrail ledger group is empty');
}

async function assertOrdinaryBudgetLedgerTargetEmpty(sql: QuerySql): Promise<void> {
	const [row] = await sql.unsafe<Array<{ count: string }>>(
		`SELECT COUNT(*)::text AS count FROM ${qualifiedTable('user_budget_reservations')}`,
	);
	if (!row || !/^\d+$/u.test(row.count) || BigInt(row.count) !== 0n) {
		throw new Error(
			`Target ordinary-user budget reservation ledger must be empty before load (user_budget_reservations=${String(row?.count ?? 'unavailable')})`,
		);
	}
	console.log('[ETL] verified target ordinary-user budget reservation ledger is empty');
}

function buildBatchInsertSql(tableName: EtlTableName, columns: string[], rowCount: number): string {
	const quotedColumns = columns.map(quoteIdentifier).join(', ');
	const values = Array.from({ length: rowCount }, (_, rowIndex) => {
		const placeholders = columns
			.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`)
			.join(', ');
		return `(${placeholders})`;
	}).join(', ');
	return `INSERT INTO ${qualifiedTable(tableName)} (${quotedColumns}) VALUES ${values}${buildUpsertClause(
		tableName,
		columns
	)}`;
}

function parseCount(rows: Record<string, unknown>[]): number {
	const countValue = rows[0]?.count;
	const count = typeof countValue === 'number' ? countValue : Number(countValue ?? 0);
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`Invalid count value: ${String(countValue)}`);
	}
	return count;
}

function inspectD1BudgetSpentPrecision(config: EtlConfig): D1BudgetSpentPrecisionMode {
	const userColumns = getTableColumns('users', config.d1);
	const migrationCount = parseCount(runD1ExecuteJson(
		`SELECT COUNT(*) AS count FROM d1_migrations WHERE name = '${D1_BUDGET_SPENT_MICROS_MIGRATION}'`,
		config.d1,
	));
	if (migrationCount > 1) {
		throw new Error(`D1 migration ledger contains duplicate ${D1_BUDGET_SPENT_MICROS_MIGRATION} rows`);
	}
	const mode = resolveD1BudgetSpentPrecisionMode(userColumns, migrationCount === 1);
	const invalidRows = parseCount(runD1ExecuteJson(d1BudgetSpentInvariantSql(mode), config.d1));
	if (invalidRows !== 0) {
		throw new Error(
			`D1 users.budget_spent cannot be transferred exactly in ${mode} mode: ${invalidRows} invalid row(s)`,
		);
	}
	console.log(`[ETL] users.budget_spent precision=${mode}; invalid_rows=0`);
	return mode;
}

async function migrateTable(
	sql: QuerySql,
	tableName: EtlTableName,
	config: EtlConfig,
	budgetSpentPrecisionMode: D1BudgetSpentPrecisionMode,
): Promise<void> {
	const sourceColumns = getTableColumns(tableName, config.d1);
	if (sourceColumns.length === 0) {
		throw new Error(`Table ${tableName} has no columns or does not exist in D1 source`);
	}
	const columns = tableName === 'users'
		? postgresUserColumnsForD1Source(sourceColumns)
		: sourceColumns;

	const totalRows = parseCount(runD1ExecuteJson(`SELECT COUNT(*) AS count FROM "${tableName}"`, config.d1));
	const tableBatchSize = Math.min(
		config.batchSize,
		Math.max(1, Math.floor(MAX_POSTGRES_BATCH_PARAMETERS / columns.length))
	);
	console.log(`\n[ETL] ${tableName}: ${totalRows} rows, batch=${tableBatchSize}`);

	let migrated = 0;
	for (let offset = 0; offset < totalRows; offset += tableBatchSize) {
		const selectList = tableName === 'users'
			? `*, ${d1BudgetSpentTransferExpression(budgetSpentPrecisionMode)} AS "${D1_BUDGET_SPENT_TRANSFER_ALIAS}"`
			: '*';
		const d1Rows = runD1ExecuteJson(
			`SELECT ${selectList} FROM "${tableName}" ORDER BY rowid LIMIT ${tableBatchSize} OFFSET ${offset}`,
			config.d1
		);
		if (d1Rows.length === 0) {
			break;
		}
		const params = d1Rows.flatMap((row) => columns.map((column) => {
			if (tableName === 'users' && column === 'budget_spent') {
				return postgresBudgetSpentFromTransferRow(row);
			}
			return toSqlValue(tableName, column, row[column]);
		}));
		const sqlText = buildBatchInsertSql(tableName, columns, d1Rows.length);
		await sql.unsafe(sqlText, params);
		migrated += d1Rows.length;
		console.log(`[ETL] ${tableName}: ${migrated}/${totalRows}`);
	}
	if (migrated !== totalRows) {
		throw new Error(`Short D1 read for ${tableName}: expected ${totalRows}, received ${migrated}`);
	}
}

async function assertTargetReady(sql: postgres.Sql): Promise<void> {
	const [state] = await sql.unsafe<
		{ current_schema: string | null; migrations_table: string | null; legacy_schema: boolean }[]
	>(`
		SELECT
			current_schema() AS current_schema,
			to_regclass('${TARGET_SCHEMA}.schema_migrations')::text AS migrations_table,
			to_regnamespace('octafuse_gateway') IS NOT NULL AS legacy_schema
	`);
	if (state?.current_schema !== TARGET_SCHEMA) {
		throw new Error(
			`Unsafe PostgreSQL target: current_schema()=${String(state?.current_schema)}; expected ${TARGET_SCHEMA}`
		);
	}
	if (!state.migrations_table) {
		throw new Error(`Target ${TARGET_SCHEMA}.schema_migrations does not exist; run db:migrate:pg first`);
	}
	if (state.legacy_schema) {
		throw new Error('Legacy octafuse_gateway still exists beside cinatoken_gateway; reconcile manually');
	}

	const [migration] = await sql.unsafe<{ present: boolean }[]>(
		`SELECT EXISTS (
			SELECT 1 FROM ${qualifiedTable('schema_migrations')} WHERE version = $1
		) AS present`,
		[REQUIRED_MIGRATION]
	);
	if (!migration?.present) {
		throw new Error(`Target is not current: missing migration ${REQUIRED_MIGRATION}`);
	}

	const missingTables: string[] = [];
	for (const tableName of [...ETL_TABLE_ORDER, ...ETL_EXCLUDED_SESSION_TABLES]) {
		const [row] = await sql.unsafe<{ table_name: string | null }[]>(
			'SELECT to_regclass($1)::text AS table_name',
			[`${TARGET_SCHEMA}.${tableName}`]
		);
		if (!row?.table_name) {
			missingTables.push(tableName);
		}
	}
	if (missingTables.length > 0) {
		throw new Error(`Target schema is incomplete; missing table(s): ${missingTables.join(', ')}`);
	}
}

async function main(): Promise<void> {
	const config = parseConfig();
	const sql = postgres(config.postgresUrl, {
		max: 1,
		connection: { search_path: `${TARGET_SCHEMA}, public` },
	});

	try {
		await assertTargetReady(sql);
		const budgetSpentPrecisionMode = inspectD1BudgetSpentPrecision(config);
		const activeGuardrailReservations = parseCount(runD1ExecuteJson(
			`SELECT COUNT(*) AS count FROM guardrail_budget_reservations
			 WHERE state IN ('reserved', 'dispatched')`,
			config.d1,
		));
		if (activeGuardrailReservations !== 0) {
			throw new Error(
				`Source Guardrail budget leases are not drained: ${activeGuardrailReservations} active reservation(s)`,
			);
		}
		const activeUserBudgetReservations = parseCount(runD1ExecuteJson(
			`SELECT COUNT(*) AS count FROM user_budget_reservations
			 WHERE state IN ('reserved', 'dispatched')`,
			config.d1,
		));
		if (activeUserBudgetReservations !== 0) {
			throw new Error(
				`Source ordinary-user budget leases are not drained: ${activeUserBudgetReservations} active reservation(s)`,
			);
		}
		console.log(
			`[ETL] source=D1(${config.d1.source}:${config.d1.databaseName}), target=Postgres(${TARGET_SCHEMA}), batch=${config.batchSize}`
		);
		console.log(
			`[ETL] target-offline=${config.targetOfflineConfirmed}; source-frozen=${config.sourceFrozenConfirmed}; sessions excluded and invalidated: ${ETL_EXCLUDED_SESSION_TABLES.join(', ')}`
		);

		await sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${ETL_LOCK_KEY})`;
			if (config.guardrailLedgerIncluded && !config.truncateBeforeLoad) {
				await assertGuardrailLedgerTargetEmpty(tx);
			}
			if (config.ordinaryBudgetLedgerIncluded && !config.truncateBeforeLoad) {
				await assertOrdinaryBudgetLedgerTargetEmpty(tx);
			}
			await tx.unsafe(
				`ALTER TABLE ${qualifiedTable('shared_key_earnings')} DISABLE TRIGGER USER`
			);
			await tx.unsafe(`ALTER TABLE ${qualifiedTable('withdrawals')} DISABLE TRIGGER USER`);

			if (config.truncateBeforeLoad) {
				console.log('[ETL] truncating target tables and invalidating target sessions before load...');
				await truncateTables(tx);
			}

			for (const tableName of ETL_TABLE_ORDER) {
				if (config.tableFilter && !config.tableFilter.has(tableName)) {
					continue;
				}
				await migrateTable(tx, tableName, config, budgetSpentPrecisionMode);
			}

			await tx.unsafe(
				`TRUNCATE TABLE ${ETL_EXCLUDED_SESSION_TABLES.map(qualifiedTable).join(', ')}`
			);
			await tx.unsafe(`ALTER TABLE ${qualifiedTable('withdrawals')} ENABLE TRIGGER USER`);
			await tx.unsafe(
				`ALTER TABLE ${qualifiedTable('shared_key_earnings')} ENABLE TRIGGER USER`
			);
		});

		console.log('\n[ETL] Completed. Run reconciliation before any cutover.');
	} finally {
		await sql.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
