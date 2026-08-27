import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const sqlFiles = (directory) =>
	readdirSync(join(root, directory)).filter((name) => name.endsWith('.sql')).sort();

const d1Migrations = sqlFiles('packages/core/migrations-d1');
const postgresMigrations = sqlFiles('packages/core/migrations-postgres');
assert.deepEqual(
	postgresMigrations,
	d1Migrations,
	'PostgreSQL and D1 migration versions must remain aligned',
);

for (const file of postgresMigrations) {
	const sql = read(`packages/core/migrations-postgres/${file}`);
	assert.doesNotMatch(sql, /octafuse_gateway/u, `${file} still targets the legacy schema`);
}
assert.doesNotMatch(
	read('packages/core/migrations-postgres/0001_baseline.sql'),
	/CREATE SCHEMA/u,
	'the least-privilege migrator must not need database-wide CREATE just to run the baseline',
);

const migrationRunner = read('packages/core/src/migrate/postgres.ts');
assert.match(migrationRunner, /GATEWAY_POSTGRES_SCHEMA = 'cinatoken_gateway'/u);
assert.match(migrationRunner, /LEGACY_GATEWAY_POSTGRES_SCHEMA = 'octafuse_gateway'/u);
assert.match(migrationRunner, /ALTER SCHEMA .* RENAME TO/u);
assert.match(migrationRunner, /both .* and .* schemas exist; manual reconciliation is required/u);
assert.match(migrationRunner, /pg_advisory_lock/u);

const postgresClient = read('packages/core/src/storage/drizzle/client-postgres.ts');
assert.match(
	postgresClient,
	/GATEWAY_POSTGRES_SEARCH_PATH = 'cinatoken_gateway, public'/u,
);

const ledgerMigration = read('packages/core/migrations-postgres/0029_portal_integer_ledger.sql');
for (const requiredContract of [
	'portal_ledger_entries',
	'balance_micros BIGINT',
	'idx_withdrawals_one_active_per_user',
	'shared_key_earnings_credit_after_insert',
	'withdrawals_validate_lock_before_insert',
	'withdrawals_lock_after_insert',
	'withdrawals_confirm_after_status_update',
	'withdrawals_refund_after_status_update',
]) {
	assert.ok(
		ledgerMigration.includes(requiredContract),
		`0029 is missing PostgreSQL ledger contract: ${requiredContract}`,
	);
}

const outboxMigration = read('packages/core/migrations-postgres/0030_chain_job_transactions.sql');
assert.match(outboxMigration, /CREATE TABLE chain_job_transactions/u);
assert.match(outboxMigration, /PRIMARY KEY \(job_kind, job_id\)/u);
assert.match(outboxMigration, /tx_hash TEXT NOT NULL UNIQUE/u);

const migrationTables = read('scripts/db/lib/migration-tables.ts');
const orderBlock = migrationTables.match(/ETL_TABLE_ORDER = \[([\s\S]*?)\] as const;/u)?.[1];
assert.ok(orderBlock, 'Unable to parse ETL_TABLE_ORDER');
const actualTables = [...orderBlock.matchAll(/^\s*'([^']+)',\s*$/gmu)].map((match) => match[1]);
assert.deepEqual(actualTables, [
	'users',
	'api_keys',
	'providers',
	'models',
	'model_tags',
	'route_pools',
	'model_surfaces',
	'model_routes',
	'route_pool_sticky_bindings',
	'api_key_request_logs',
	'public_model_daily_stats',
	'system_config',
	'user_audit_logs',
	'admin_api_keys',
	'shared_keys',
	'user_earnings',
	'shared_key_earnings',
	'withdrawals',
	'nft_mints',
	'portal_ledger_entries',
	'chain_job_transactions',
]);
assert.doesNotMatch(orderBlock, /provider_api_keys/u);
assert.match(migrationTables, /ETL_EXCLUDED_SESSION_TABLES = \['portal_sessions', 'admin_sessions'\]/u);

const etl = read('scripts/db/cutover/etl-d1-to-postgres.ts');
for (const safetyContract of [
	"const TARGET_SCHEMA = 'cinatoken_gateway'",
	'--target-offline',
	'--source-frozen',
	'DISABLE TRIGGER USER',
	'ENABLE TRIGGER USER',
	'pg_advisory_xact_lock',
	'ETL_EXCLUDED_SESSION_TABLES.map',
	'0034_public_model_daily_stats.sql',
]) {
	assert.ok(etl.includes(safetyContract), `ETL is missing safety contract: ${safetyContract}`);
}

const reconcile = read('scripts/db/cutover/reconcile-d1-postgres.ts');
assert.match(reconcile, /Postgres\(\$\{TARGET_SCHEMA\}\)/u);
assert.match(reconcile, /target:portal_sessions_invalidated/u);
assert.match(reconcile, /target:portal_ledger_triggers_enabled/u);
assert.match(reconcile, /user_earnings:sum_\$\{column\}/u);
assert.match(reconcile, /public_model_daily_stats:sum_\$\{column\}/u);

const hyperdriveMigrationWorker = read('scripts/db/cutover/postgres-migrations-worker.ts');
for (const file of postgresMigrations) {
	assert.ok(
		hyperdriveMigrationWorker.includes(`migrations-postgres/${file}`) &&
			hyperdriveMigrationWorker.includes(`['${file}',`),
		`Hyperdrive migration Worker is missing the fixed ${file} module`,
	);
}
assert.match(hyperdriveMigrationWorker, /isDiagnosticRequestAuthorized/u);
assert.match(hyperdriveMigrationWorker, /pg_advisory_xact_lock/u);
assert.match(hyperdriveMigrationWorker, /grantPostgresRuntime/u);

const runtimeGrants = read('scripts/db/cutover/grant-postgres-runtime.ts');
const runtimeGrantSql = runtimeGrants.match(/tx\.unsafe\(`([\s\S]*?)`\)/u)?.[1];
assert.ok(runtimeGrantSql, 'Unable to parse runtime grant SQL');
assert.doesNotMatch(runtimeGrantSql, /^\s*\/\//mu, 'Runtime grant SQL must use SQL comments, not JavaScript comments');
assert.match(runtimeGrants, /0034_public_model_daily_stats\.sql/u);

const hyperdriveAccessProbe = read('scripts/db/cutover/hyperdrive-access-probe-worker.ts');
assert.match(hyperdriveAccessProbe, /migratorContractPassed/u);
assert.match(hyperdriveAccessProbe, /runtimeContractPassed/u);
assert.match(hyperdriveAccessProbe, /migrations_select/u);
assert.match(hyperdriveAccessProbe, /users_truncate/u);
assert.match(hyperdriveAccessProbe, /migration_count === '34'/u);

console.log('PostgreSQL cinatoken_gateway migration contract: PASS');
