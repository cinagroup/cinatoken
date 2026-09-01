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
	postgresMigrations.slice(0, 40),
	d1Migrations.slice(0, 40),
	'PostgreSQL and D1 migrations through 0040 must remain aligned',
);
assert.deepEqual(
	d1Migrations.slice(40),
	['0041_user_budget_spent_micros.sql', '0042_workspaces.sql', '0043_gateway_keys_workspace.sql', '0044_workspace_presets_guardrails.sql', '0045_route_routing_metadata.sql', '0046_route_data_policy_subject_fingerprint.sql', '0047_model_endpoints.sql', '0048_model_endpoint_route_subject_fingerprint.sql', '0049_model_endpoint_audio_capabilities.sql', '0050_model_endpoint_evidence_ledger.sql', '0051_management_api_keys.sql', '0052_gateway_key_expiry.sql', '0053_gateway_key_limits.sql', '0054_workspace_budgets.sql', '0055_generation_metadata_snapshots.sql'],
	'D1 must retain its dedicated precision migration before Workspace and Gateway Key scope migrations',
);
assert.deepEqual(
	postgresMigrations.slice(40),
	['0041_workspaces.sql', '0042_gateway_keys_workspace.sql', '0043_workspace_presets_guardrails.sql', '0044_route_routing_metadata.sql', '0045_route_data_policy_subject_fingerprint.sql', '0046_model_endpoints.sql', '0047_model_endpoint_route_subject_fingerprint.sql', '0048_model_endpoint_audio_capabilities.sql', '0049_model_endpoint_evidence_ledger.sql', '0050_management_api_keys.sql', '0051_gateway_key_expiry.sql', '0052_gateway_key_limits.sql', '0053_workspace_budgets.sql', '0054_generation_metadata_snapshots.sql'],
	'PostgreSQL stores budget_spent directly as NUMERIC and must end with its Workspace budgets migration',
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

const gatewayKeyLimitsMigration = read('packages/core/migrations-postgres/0052_gateway_key_limits.sql');
for (const contract of [
	'ADD COLUMN limit_micros BIGINT NULL',
	'ADD COLUMN limit_reset TEXT NULL',
	'ADD COLUMN include_byok_in_limit BOOLEAN NOT NULL DEFAULT FALSE',
	"CHECK (period IN ('daily', 'weekly', 'monthly', 'lifetime'))",
	'CHECK (limit_micros >= 0 AND limit_micros <= 9007199254740991)',
]) {
	assert.ok(gatewayKeyLimitsMigration.includes(contract), `PostgreSQL 0052 is missing Gateway Key limit contract: ${contract}`);
}

const workspaceBudgetsMigration = read('packages/core/migrations-postgres/0053_workspace_budgets.sql');
for (const contract of [
	'CREATE TABLE workspace_budgets',
	"CHECK (reset_interval IN ('daily', 'weekly', 'monthly', 'lifetime'))",
	'CONSTRAINT uk_workspace_budgets_interval UNIQUE (workspace_id, reset_interval)',
	'enforce_workspace_budget_order',
	"scope_type IN ('user', 'api_key', 'workspace')",
]) {
	assert.ok(workspaceBudgetsMigration.includes(contract), `PostgreSQL 0053 is missing Workspace budget contract: ${contract}`);
}

const generationMetadataMigration = read('packages/core/migrations-postgres/0054_generation_metadata_snapshots.sql');
for (const generationContract of [
	'ADD COLUMN request_origin TEXT',
	'ADD COLUMN response_streamed BOOLEAN',
	'ADD COLUMN data_region TEXT',
	'ADD COLUMN is_byok BOOLEAN',
	'ADD COLUMN charged_cost_usd NUMERIC(24, 12)',
	'ADD COLUMN upstream_inference_cost_usd NUMERIC(24, 12)',
	"data_region IN ('global', 'europe', 'us')",
]) {
	assert.ok(
		generationMetadataMigration.includes(generationContract),
		`PostgreSQL 0054 is missing Generation metadata contract: ${generationContract}`,
	);
}
assert.doesNotMatch(
	generationMetadataMigration,
	/(?:UPDATE|INSERT\s+INTO)\s+api_key_request_logs/iu,
	'Generation metadata facts must not be inferred for historical request logs',
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
const actualTables = [...orderBlock.matchAll(/^\s*["']([^"']+)["'],\s*$/gmu)].map((match) => match[1]);
assert.deepEqual(actualTables, [
	'users',
	'organizations',
	'organization_memberships',
	'workspaces',
	'workspace_memberships',
	'workspace_budgets',
	'identity_event_inbox',
	'api_keys',
	'management_api_keys',
	'request_presets',
	'request_preset_versions',
	'guardrails',
	'guardrail_versions',
	'guardrail_assignments',
	'providers',
	'models',
	'model_tags',
	'model_endpoints',
	'route_pools',
	'model_surfaces',
	'model_routes',
	'model_endpoint_routes',
	'route_data_policies',
	'route_data_policy_audit',
	'route_pool_sticky_bindings',
	'api_key_request_logs',
	'guardrail_budget_windows',
	'guardrail_budget_reservations',
	'user_budget_reservations',
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
assert.match(
	migrationTables,
	/ETL_EXCLUDED_SESSION_TABLES = \[\s*["']portal_sessions["'],\s*["']admin_sessions["'],?\s*\]/u,
);
assert.match(migrationTables, /user_budget_reservations: \[["']request_id["']\]/u);
assert.match(migrationTables, /workspaces: \[["']id["']\]/u);
assert.match(migrationTables, /workspace_memberships: \[["']id["']\]/u);
assert.match(migrationTables, /workspace_budgets: \[["']id["']\]/u);
assert.match(migrationTables, /management_api_keys: \[["']id["']\]/u);
assert.match(migrationTables, /workspaces: \[["']is_default["']\]/u);
assert.match(migrationTables, /model_endpoints: \[["']id["']\]/u);
assert.match(
	migrationTables,
	/model_endpoint_routes: \[["']endpoint_id["'], ["']route_target_id["']\]/u,
);
assert.match(
	migrationTables,
	/model_endpoints: \[["']supports_implicit_caching["'], ["']supports_voice_cloning["']\]/u,
);
assert.match(
	migrationTables,
	/guardrail_budget_windows: \[\s*["']workspace_id["'],\s*["']scope_type["'],\s*["']scope_id["'],\s*["']period["'],\s*["']period_start["'],?\s*\]/u,
);
const etl = read('scripts/db/cutover/etl-d1-to-postgres.ts');
for (const safetyContract of [
	"const TARGET_SCHEMA = 'cinatoken_gateway'",
	'--target-offline',
	'--source-frozen',
	'DISABLE TRIGGER USER',
	'ENABLE TRIGGER USER',
	'pg_advisory_xact_lock',
	'ETL_EXCLUDED_SESSION_TABLES',
	'0054_generation_metadata_snapshots.sql',
	'activeGuardrailReservations',
	'activeUserBudgetReservations',
	'postgresBudgetSpentFromTransferRow',
	'inspectD1BudgetSpentPrecision',
]) {
	assert.ok(etl.includes(safetyContract), `ETL is missing safety contract: ${safetyContract}`);
}

const reconcile = read('scripts/db/cutover/reconcile-d1-postgres.ts');
assert.match(reconcile, /Postgres\(\$\{TARGET_SCHEMA\}\)/u);
assert.match(reconcile, /target:portal_sessions_invalidated/u);
assert.match(reconcile, /target:portal_ledger_triggers_enabled/u);
assert.match(reconcile, /user_earnings:sum_\$\{column\}/u);
assert.match(reconcile, /public_model_daily_stats:sum_\$\{column\}/u);
assert.match(reconcile, /reportGuardrailLedgerDifferences/u);
assert.match(reconcile, /GUARDRAIL_LEDGER_CHECK_PREFIX = 'guardrail-ledger:'/u);
assert.match(reconcile, /source:active-reservations/u);
assert.match(reconcile, /target:active-reservations/u);
assert.match(reconcile, /0054_generation_metadata_snapshots\.sql/u);
assert.match(reconcile, /ordinary-budget:source-active-reservations/u);
assert.match(reconcile, /ordinary-budget:target-active-reservations/u);
assert.match(reconcile, /ordinary-budget:source-reserved-counter-drift/u);
assert.match(reconcile, /ordinary-budget:target-reserved-counter-drift/u);
assert.match(reconcile, /ordinary-budget:sum_\$\{column\}/u);
assert.match(reconcile, /ordinary-budget:state_\$\{state\}_count/u);
assert.match(reconcile, /--source-frozen is required:[\s\S]*?operator acknowledgement, not mechanical fencing/u);
assert.match(reconcile, /users:budget_spent_micros_exact/u);
assert.match(reconcile, /d1BudgetSpentMicrosFromTransferRow/u);
assert.doesNotMatch(reconcile, /users:sum_budget_spent/u);

const guardrailLedgerContract = read('scripts/db/cutover/guardrail-ledger-contract.ts');
for (const ledgerTable of [
	'api_key_request_logs',
	'guardrail_budget_windows',
	'guardrail_budget_reservations',
]) {
	assert.ok(
		new RegExp(`["']${ledgerTable}["']`, 'u').test(guardrailLedgerContract),
		`Cutover ledger group is missing ${ledgerTable}`,
	);
}
for (const ledgerInvariant of [
	"state IN ('reserved', 'dispatched')",
	"reservation.state IN ('settled', 'released', 'expired')",
	"coverage.state IN ('settled', 'expired')",
	'actual_reserved_micros <> 0',
	'actual_settled_micros <> expected_settled_micros',
	'actual_unreserved_micros <> expected_unreserved_micros',
	'COALESCE(log.budget_accounted_at, log.created_at)',
]) {
	assert.ok(
		guardrailLedgerContract.includes(ledgerInvariant),
		`Cutover ledger reconciliation is missing invariant: ${ledgerInvariant}`,
	);
}
assert.match(etl, /assertGuardrailLedgerTableSelection\(tableFilter\)/u);
assert.match(etl, /guardrailLedgerIncluded && !config\.truncateBeforeLoad/u);
assert.match(etl, /assertGuardrailLedgerTargetEmpty\(tx\)/u);
assert.match(etl, /ORDINARY_BUDGET_ETL_TABLES = \['users', 'user_budget_reservations'\]/u);
assert.match(etl, /ordinaryBudgetLedgerIncluded && !config\.truncateBeforeLoad/u);
assert.match(etl, /assertOrdinaryBudgetLedgerTargetEmpty\(tx\)/u);
assert.match(etl, /ordinary-user budget account and reservation tables are an indivisible cutover group/iu);

const etlWorker = read('scripts/db/cutover/d1-postgres-etl-worker.ts');
assert.match(etlWorker, /collectGuardrailLedgerDifferences/u);
assert.match(etlWorker, /ledger_differences/u);
assert.match(etlWorker, /ETL_ATTEST_SOURCE_FROZEN/u);
assert.match(etlWorker, /source_frozen_attestation_missing/u);
assert.match(etlWorker, /attestation_only: true/u);
assert.match(etlWorker, /0054_generation_metadata_snapshots\.sql/u);
assert.match(etlWorker, /active_user_budget_reservations/u);
assert.match(etlWorker, /ordinary-budget:source-active-reservations/u);
assert.match(etlWorker, /ordinary-budget:target-active-reservations/u);
assert.match(etlWorker, /ordinary-budget:source-reserved-counter-drift/u);
assert.match(etlWorker, /ordinary-budget:target-reserved-counter-drift/u);
assert.match(etlWorker, /ordinary-budget:sum_\$\{column\}/u);
assert.match(etlWorker, /ordinary-budget:state_\$\{state\}_count/u);
assert.match(etlWorker, /users:budget_spent_micros_exact/u);
assert.match(etlWorker, /postgresBudgetSpentFromTransferRow/u);
assert.match(etlWorker, /user_budget_spent_precision/u);
assert.doesNotMatch(etlWorker, /users:sum_budget_spent/u);

const d1Preflight = read('scripts/db/cutover/preflight-d1-source.ts');
assert.match(d1Preflight, /0049_model_endpoint_audio_capabilities\.sql/u);
assert.match(d1Preflight, /active_user_budget_reservations/u);
assert.match(d1Preflight, /user_budget_reserved_counter_drift/u);
assert.match(d1Preflight, /D1_BUDGET_SPENT_MICROS_MIGRATION/u);
assert.match(d1Preflight, /legacy_real_safe_fallback/u);

const userBudgetPrecision = read('scripts/db/cutover/user-budget-spent-precision.ts');
for (const precisionContract of [
	"D1_BUDGET_SPENT_MICROS_MIGRATION = '0041_user_budget_spent_micros.sql'",
	"D1_BUDGET_SPENT_MICROS_COLUMN = 'budget_spent_micros'",
	'LEGACY_D1_BUDGET_SPENT_EXCLUSIVE_MAX = 4_294_967_296',
	'CAST(CAST(ROUND(budget_spent * 1000000.0) AS INTEGER) AS TEXT)',
	'formatBudgetSpentMicrosForPostgres',
	'postgresBudgetSpentMicrosText',
]) {
	assert.ok(
		userBudgetPrecision.includes(precisionContract),
		`D1 budget-spent precision contract is missing: ${precisionContract}`,
	);
}
assert.doesNotMatch(
	userBudgetPrecision,
	/Number\([^)]*budget_spent/u,
	'D1 authoritative budget-spent conversion must not pass through JavaScript Number division',
);
const userBudgetPrecisionTests = read('scripts/db/cutover/user-budget-spent-precision.test.ts');
assert.match(userBudgetPrecisionTests, /8589934592000001/u);
assert.match(userBudgetPrecisionTests, /4294967296\.0/u);
assert.match(userBudgetPrecisionTests, /Number inputs[\s\S]*fail closed/u);
const cutoverRunbook = read('docs/operators/migrations/d1-postgres-cutover.md');
assert.match(cutoverRunbook, /源 D1 迁移链尾为 `0055_generation_metadata_snapshots\.sql`/u);
assert.match(cutoverRunbook, /目标 PostgreSQL 迁移链尾为 `0054_generation_metadata_snapshots\.sql`/u);
assert.match(cutoverRunbook, /D1 `0048`\/PostgreSQL `0047`[^\n]*subject_fingerprint/u);
assert.match(cutoverRunbook, /旧音频证据保持 `\{\}`/u);
assert.match(cutoverRunbook, /legacy_real_safe_fallback/u);
assert.match(cutoverRunbook, /不经过 JavaScript 浮点除法/u);

const guardrailBudgetMigration = read('packages/core/migrations-postgres/0039_guardrail_budget_reservations.sql');
for (const budgetContract of [
	'unreserved_micros BIGINT',
	'seed_request_id TEXT',
	'fk_guardrail_budget_reservation_window',
	'9007199254740991',
	'COALESCE(budget_accounted_at, created_at)',
]) {
	assert.ok(
		guardrailBudgetMigration.includes(budgetContract),
		`PostgreSQL 0039 is missing Guardrail budget contract: ${budgetContract}`,
	);
}

const userBudgetMigration = read('packages/core/migrations-postgres/0040_user_budget_reservations.sql');
for (const budgetContract of [
	'ALTER TABLE users ADD COLUMN budget_epoch BIGINT NOT NULL DEFAULT 0',
	'ALTER TABLE users ADD COLUMN budget_reserved_micros BIGINT NOT NULL DEFAULT 0',
	'CREATE TABLE user_budget_reservations',
	'request_id TEXT PRIMARY KEY',
	'budget_epoch BIGINT NOT NULL',
	'limit_micros BIGINT NOT NULL',
	'reserved_micros BIGINT NOT NULL',
	"CHECK (state IN ('reserved', 'dispatched', 'settled', 'released', 'expired'))",
	'idx_user_budget_reservations_expiry',
	'idx_user_budget_reservations_user_epoch',
	'9007199254740991',
]) {
	assert.ok(
		userBudgetMigration.includes(budgetContract),
		`PostgreSQL 0040 is missing ordinary-user budget contract: ${budgetContract}`,
	);
}

const workspaceMigration = read('packages/core/migrations-postgres/0041_workspaces.sql');
for (const workspaceContract of [
	'CREATE TABLE workspaces',
	'CREATE TABLE workspace_memberships',
	'workspaces_scope_owner_chk',
	'workspaces_default_key_chk',
	'idx_workspaces_personal_status',
	'idx_workspaces_organization_status',
	'idx_workspace_memberships_workspace_status',
	'idx_workspace_memberships_subject_status',
	"'personal:' || id",
	"'organization:' || id",
]) {
	assert.ok(
		workspaceMigration.includes(workspaceContract),
		`PostgreSQL 0041 is missing Workspace contract: ${workspaceContract}`,
	);
}

const gatewayKeyWorkspaceMigration = read('packages/core/migrations-postgres/0042_gateway_keys_workspace.sql');
for (const keyContract of [
	'ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE',
	"'personal:' || user_id",
	'ALTER COLUMN workspace_id SET NOT NULL',
	'idx_api_keys_workspace_created',
	'idx_api_keys_workspace_user_created',
]) {
	assert.ok(
		gatewayKeyWorkspaceMigration.includes(keyContract),
		`PostgreSQL 0042 is missing Gateway Key Workspace contract: ${keyContract}`,
	);
}

const routeDataPolicySubjectMigration = read('packages/core/migrations-postgres/0045_route_data_policy_subject_fingerprint.sql');
for (const subjectContract of [
	'ADD COLUMN subject_fingerprint TEXT',
	'ADD COLUMN invalidated_at TIMESTAMPTZ',
	'ADD COLUMN invalidation_reason TEXT',
	'subject_fingerprint_backfill_required',
	"SET status = 'unknown'",
	'route_data_policies_subject_fingerprint_chk',
]) {
	assert.ok(
		routeDataPolicySubjectMigration.includes(subjectContract),
		`PostgreSQL 0045 is missing route data-policy subject contract: ${subjectContract}`,
	);
}

const modelEndpointsMigration = read('packages/core/migrations-postgres/0046_model_endpoints.sql');
for (const endpointContract of [
	'CREATE TABLE model_endpoints',
	'model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE',
	'provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE',
	'CONSTRAINT uk_model_endpoints_identity UNIQUE (model_id, provider_id, tag)',
	"supported_parameters TEXT NOT NULL DEFAULT '[]'",
	"pricing TEXT NOT NULL DEFAULT '{}'",
	"supports_tool_choice TEXT NOT NULL DEFAULT '{\"auto\":null,\"function\":null,\"none\":null,\"required\":null}'",
	"image_capabilities TEXT NOT NULL DEFAULT '{}'",
	'supports_implicit_caching BOOLEAN',
	'supports_voice_cloning BOOLEAN',
	"CHECK (status IN ('draft', 'verified', 'disabled'))",
	'CREATE INDEX idx_model_endpoints_provider',
	'CREATE TABLE model_endpoint_routes',
	'endpoint_id TEXT NOT NULL REFERENCES model_endpoints(id) ON DELETE CASCADE',
	'route_target_id TEXT NOT NULL UNIQUE REFERENCES model_routes(id) ON DELETE CASCADE',
	'PRIMARY KEY (endpoint_id, route_target_id)',
]) {
	assert.ok(
		modelEndpointsMigration.includes(endpointContract),
		`PostgreSQL 0046 is missing endpoint-first contract: ${endpointContract}`,
	);
}
assert.doesNotMatch(modelEndpointsMigration, /\bJSONB\b/iu, 'endpoint JSON payloads must remain portable TEXT');
assert.doesNotMatch(
	modelEndpointsMigration,
	/INSERT\s+INTO\s+model_endpoints/iu,
	'endpoint evidence must not be guessed from legacy route JSON during schema migration',
);

const endpointRouteSubjectMigration = read(
	'packages/core/migrations-postgres/0047_model_endpoint_route_subject_fingerprint.sql',
);
for (const subjectContract of [
	'ALTER TABLE model_endpoint_routes',
	'ADD COLUMN subject_fingerprint TEXT',
	'model_endpoint_routes_subject_fingerprint_chk',
	"subject_fingerprint ~ '^[0-9a-f]{64}$'",
]) {
	assert.ok(
		endpointRouteSubjectMigration.includes(subjectContract),
		`PostgreSQL 0047 is missing endpoint-route subject contract: ${subjectContract}`,
	);
}
assert.doesNotMatch(
	endpointRouteSubjectMigration,
	/UPDATE\s+model_endpoint_routes/iu,
	'legacy endpoint-route links must remain NULL until explicitly re-verified',
);

const endpointAudioCapabilitiesMigration = read(
	'packages/core/migrations-postgres/0048_model_endpoint_audio_capabilities.sql',
);
for (const audioContract of [
	'ALTER TABLE model_endpoints',
	"ADD COLUMN audio_capabilities TEXT NOT NULL DEFAULT '{}'",
]) {
	assert.ok(
		endpointAudioCapabilitiesMigration.includes(audioContract),
		`PostgreSQL 0048 is missing endpoint audio-capabilities contract: ${audioContract}`,
	);
}
assert.doesNotMatch(
	endpointAudioCapabilitiesMigration,
	/(?:UPDATE|INSERT\s+INTO)\s+model_endpoints/iu,
	'legacy endpoint audio pricing must remain unknown instead of being inferred',
);

const endpointEvidenceLedgerMigration = read(
	'packages/core/migrations-postgres/0049_model_endpoint_evidence_ledger.sql',
);
for (const ledgerContract of [
	'CREATE TABLE model_endpoint_backfill_database_identity',
	'database_name TEXT NOT NULL',
	'database_oid BIGINT NOT NULL',
	"gateway_schema TEXT NOT NULL CHECK (gateway_schema = 'cinatoken_gateway')",
	'apply_role TEXT NOT NULL',
	'current_user',
	'current_database()',
	'CREATE TABLE model_endpoint_backfill_trust_registry',
	'trusted_signers_sha256 TEXT NOT NULL UNIQUE',
	'CREATE TABLE model_endpoint_backfill_runs',
	'execution_sha256 TEXT NOT NULL',
	'authorization_sha256 TEXT NOT NULL',
	'trusted_signers_sha256 TEXT NOT NULL',
	'manifest_actor_key_id TEXT NOT NULL',
	'evidence_reviewers_json TEXT NOT NULL',
	'approval_approved_at TEXT NOT NULL',
	'approval_expires_at TEXT NOT NULL',
	'CHECK (approval_expires_at > approval_approved_at)',
	'CREATE TABLE model_endpoint_evidence_attestations',
	'evidence_reviewer_key_id TEXT NOT NULL',
	'PRIMARY KEY (idempotency_key, endpoint_id)',
	'ON DELETE RESTRICT',
	'CREATE INDEX idx_model_endpoint_evidence_latest',
	'CREATE FUNCTION reject_model_endpoint_ledger_mutation()',
	'BEFORE UPDATE OR DELETE ON model_endpoint_backfill_database_identity',
	'BEFORE UPDATE OR DELETE ON model_endpoint_backfill_trust_registry',
	'BEFORE UPDATE OR DELETE ON model_endpoint_backfill_runs',
	'BEFORE UPDATE OR DELETE ON model_endpoint_evidence_attestations',
	"rolname = 'cinatoken_gateway_runtime'",
	'REVOKE INSERT, UPDATE, DELETE ON TABLE',
	'cinatoken_gateway.model_endpoint_backfill_trust_registry',
	'FROM cinatoken_gateway_runtime',
]) {
	assert.ok(
		endpointEvidenceLedgerMigration.includes(ledgerContract),
		`PostgreSQL 0049 is missing endpoint evidence-ledger contract: ${ledgerContract}`,
	);
}

const managementApiKeysMigration = read(
	'packages/core/migrations-postgres/0050_management_api_keys.sql',
);

const gatewayKeyExpiryMigration = read(
	'packages/core/migrations-postgres/0051_gateway_key_expiry.sql',
);
for (const gatewayKeyExpiryContract of [
	'ALTER TABLE api_keys ADD COLUMN expires_at TIMESTAMPTZ',
	'CREATE INDEX idx_api_keys_status_expiry ON api_keys(status, expires_at)',
]) {
	assert.ok(
		gatewayKeyExpiryMigration.includes(gatewayKeyExpiryContract),
		`PostgreSQL 0051 is missing Gateway Key expiry contract: ${gatewayKeyExpiryContract}`,
	);
}
for (const managementKeyContract of [
	'CREATE TABLE management_api_keys',
	'key_hash TEXT NOT NULL UNIQUE',
	"CHECK (key_hash ~ '^sha256:[0-9a-f]{64}$')",
	"account_type TEXT NOT NULL CHECK (account_type IN ('personal', 'organization'))",
	'personal_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE',
	'organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE',
	'created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL',
	'management_api_keys_account_owner_chk',
	'idx_management_api_keys_personal_created',
	'idx_management_api_keys_organization_created',
	'idx_management_api_keys_status_expiry',
]) {
	assert.ok(
		managementApiKeysMigration.includes(managementKeyContract),
		`PostgreSQL 0050 is missing Management API key contract: ${managementKeyContract}`,
	);
}
assert.doesNotMatch(
	managementApiKeysMigration,
	/^\s*(?:key|secret|api_key)\s+TEXT\b/mu,
	'PostgreSQL 0050 must never persist Management Key plaintext',
);

const presetGuardrailWorkspaceMigration = read('packages/core/migrations-postgres/0043_workspace_presets_guardrails.sql');
assert.doesNotMatch(
	presetGuardrailWorkspaceMigration,
	/UPDATE guardrail_budget_windows window\b/u,
	'PostgreSQL 0043 must not use the reserved WINDOW keyword as a table alias',
);
assert.match(
	presetGuardrailWorkspaceMigration,
	/UPDATE guardrail_budget_windows budget_window\b/u,
	'PostgreSQL 0043 must use a non-reserved Guardrail budget-window alias',
);
assert.ok(
	presetGuardrailWorkspaceMigration.indexOf('DROP CONSTRAINT fk_guardrail_budget_reservation_window') <
		presetGuardrailWorkspaceMigration.indexOf('DROP CONSTRAINT guardrail_budget_windows_pkey'),
	'PostgreSQL 0043 must drop the reservation foreign key before replacing its referenced primary key',
);
for (const workspaceContract of [
	'ALTER TABLE request_presets ADD COLUMN workspace_id TEXT',
	'UNIQUE (workspace_id, slug)',
	'ALTER TABLE guardrails ADD COLUMN workspace_id TEXT',
	'ALTER TABLE guardrail_assignments ADD COLUMN workspace_id TEXT',
	'UNIQUE (workspace_id, scope_type, scope_id)',
	'enforce_guardrail_assignment_api_key_workspace',
	'ALTER TABLE guardrail_budget_windows ADD COLUMN workspace_id TEXT',
	'PRIMARY KEY (workspace_id, scope_type, scope_id, period, period_start)',
]) {
	assert.ok(
		presetGuardrailWorkspaceMigration.includes(workspaceContract),
		`PostgreSQL 0043 is missing Preset/Guardrail Workspace contract: ${workspaceContract}`,
	);
}

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
assert.match(runtimeGrants, /0054_generation_metadata_snapshots\.sql/u);
assert.match(runtimeGrants, /migration=0054/u);
for (const immutableTable of [
	'api_key_request_logs',
	'shared_key_earnings',
	'portal_ledger_entries',
	'request_preset_versions',
	'guardrail_versions',
	'route_data_policy_audit',
	'identity_event_inbox',
]) {
	assert.match(
		runtimeGrantSql,
		new RegExp(`REVOKE UPDATE, DELETE ON TABLE[\\s\\S]*?\\$\\{GATEWAY_SCHEMA\\}\\.${immutableTable}`, 'u'),
		`Runtime role must not be able to rewrite immutable table ${immutableTable}`,
	);
}
for (const applyTable of [
	'model_endpoint_backfill_database_identity',
	'model_endpoint_backfill_trust_registry',
	'model_endpoint_backfill_runs',
	'model_endpoint_evidence_attestations',
]) {
	assert.match(
		runtimeGrantSql,
		new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE[\\s\\S]*?\\$\\{GATEWAY_SCHEMA\\}\\.${applyTable}`, 'u'),
		`Runtime role must not be able to manufacture or rewrite apply ledger ${applyTable}`,
	);
}
assert.match(runtimeGrantSql, /ALTER DEFAULT PRIVILEGES[\s\S]*?REVOKE INSERT, UPDATE, DELETE ON TABLES FROM/u);
assert.doesNotMatch(
	runtimeGrantSql,
	/ALTER DEFAULT PRIVILEGES[\s\S]*?GRANT SELECT, INSERT ON TABLES TO/u,
	'Runtime default table privileges must not grant INSERT on future tables',
);
assert.match(runtimeGrantSql, /ALTER DEFAULT PRIVILEGES[\s\S]*?GRANT SELECT ON TABLES TO/u);
for (const budgetLedgerTable of [
	'guardrail_budget_windows',
	'guardrail_budget_reservations',
	'user_budget_reservations',
]) {
	assert.match(
		runtimeGrantSql,
		new RegExp(`REVOKE DELETE ON TABLE[\\s\\S]*?\\$\\{GATEWAY_SCHEMA\\}\\.${budgetLedgerTable}`, 'u'),
		`Runtime role must not delete budget ledger table ${budgetLedgerTable}`,
	);
}

const hyperdriveAccessProbe = read('scripts/db/cutover/hyperdrive-access-probe-worker.ts');
assert.match(hyperdriveAccessProbe, /migratorContractPassed/u);
assert.match(hyperdriveAccessProbe, /runtimeContractPassed/u);
assert.match(hyperdriveAccessProbe, /migrations_select/u);
assert.match(hyperdriveAccessProbe, /users_truncate/u);
assert.match(hyperdriveAccessProbe, /management_api_keys_exists/u);
assert.match(hyperdriveAccessProbe, /management_api_keys_select/u);
assert.match(hyperdriveAccessProbe, /management_api_keys_insert/u);
assert.match(hyperdriveAccessProbe, /management_api_keys_update/u);
assert.match(hyperdriveAccessProbe, /management_api_keys_delete/u);
assert.match(hyperdriveAccessProbe, /user_budget_reservations_delete/u);
assert.match(hyperdriveAccessProbe, /migration_count === '54'/u);
assert.match(hyperdriveAccessProbe, /0054_generation_metadata_snapshots\.sql/u);

const corePackage = JSON.parse(read('packages/core/package.json'));
assert.match(corePackage.scripts['pretest:unit'], /test:ordinary-budget/u);
assert.match(corePackage.scripts['pretest:unit'], /test:workspaces/u);
assert.match(corePackage.scripts['pretest:unit'], /test:management-keys/u);
assert.match(corePackage.scripts['test:ordinary-budget'], /user-budget\.d1\.test\.ts/u);
assert.match(corePackage.scripts['test:workspaces'], /workspaces\.d1\.test\.ts/u);
assert.match(corePackage.scripts['test:workspaces'], /preset-guardrail-workspaces\.d1\.test\.ts/u);
assert.match(corePackage.scripts['test:management-keys'], /management-api-keys\.d1\.test\.ts/u);
assert.match(corePackage.scripts['test:management-keys'], /management-gateway-keys\.d1\.test\.ts/u);
const proxyPackage = JSON.parse(read('packages/proxy/package.json'));
assert.match(proxyPackage.scripts['pretest:unit'], /test:ordinary-budget/u);
assert.match(proxyPackage.scripts['test:ordinary-budget'], /ordinary-budget-lifecycle\.test\.ts/u);
assert.match(proxyPackage.scripts['pretest:unit'], /test:management-keys/u);
assert.match(proxyPackage.scripts['test:management-keys'], /management-keys\.test\.ts/u);

console.log('PostgreSQL cinatoken_gateway migration contract: PASS');
