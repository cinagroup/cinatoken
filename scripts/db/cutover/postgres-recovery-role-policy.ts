import {
	RECOVERY_ORIGIN_ROLE,
	validatePostgresRecoveryOriginBudget,
	type RecoveryOriginBudgetResult,
} from './postgres-recovery-origin-budget';

/**
 * Offline proposal for a dedicated recovery identity. Nothing in this module opens a
 * connection, creates a role, changes the shared runtime role, or enables LOGIN.
 * The recovery schema migrations are local artifacts, not evidence of a live
 * rollout. The SQL checks the live catalog before making grants and still
 * rejects the current schema until the legacy request-log guard is installed.
 */
export const POSTGRES_RECOVERY_ROLE = RECOVERY_ORIGIN_ROLE;
export const POSTGRES_RECOVERY_SCHEMA = 'cinatoken_gateway';
export const POSTGRES_RECOVERY_MIGRATOR = 'cinatoken_gateway_migrator';

export type RecoveryRolePolicyInput = Readonly<{
	originBudgetFacts: unknown;
	nowMs: number;
}>;

export type RecoveryRoleTimeoutDefaults = Readonly<{
	transactionMs: number;
	statementMs: number;
	lockMs: number;
	idleInTransactionMs: number;
}>;

export type RecoveryRolePolicy = Readonly<{
	role: typeof POSTGRES_RECOVERY_ROLE;
	login: false;
	connectionLimit: number;
	timeouts: RecoveryRoleTimeoutDefaults;
	originBudget: RecoveryOriginBudgetResult;
}>;

/** One fixed table catalogue: no ALL TABLES, sequence, schema CREATE, or default grants. */
export const RECOVERY_TABLE_GRANTS = Object.freeze([
	{ table: 'request_usage_settlements', privileges: ['SELECT'], updateColumns: [] },
	{ table: 'request_usage_settlement_outbox', privileges: ['SELECT'], updateColumns: [] },
	{ table: 'request_usage_recovery_jobs', privileges: ['SELECT', 'INSERT'], updateColumns: [
		'state', 'revision', 'attempts', 'last_transition', 'lease_token', 'lease_seconds', 'last_error',
	] },
	{ table: 'request_usage_commit_receipts', privileges: ['SELECT', 'INSERT'], updateColumns: [] },
	// PostgreSQL FOR UPDATE on the key row requires UPDATE on at least one column.
	// Do not confer an unrelated mutation just to satisfy that lock permission.
	{ table: 'api_keys', privileges: [], selectColumns: ['id', 'workspace_id'], updateColumns: [] },
	// The settlement writer reads this append-only log without a row lock. The
	// reservation row and the log primary key carry its replay exclusion.
	// Direct log mutation remains outside the recovery role.
	{ table: 'api_key_request_logs', privileges: ['INSERT'], selectColumns: [
		'id', 'user_id', 'api_key_id', 'workspace_id', 'request_operation', 'created_at', 'model_id',
		'provider_id', 'status', 'charged_cost', 'standard_cost', 'metered_cost', 'budget_charged_micros',
		'input_tokens', 'output_tokens', 'total_tokens',
	], updateColumns: [] },
	{ table: 'provider_attempt_availability', privileges: ['INSERT'], updateColumns: [] },
	{ table: 'users', privileges: [], selectColumns: [
		'id', 'budget_epoch', 'budget_reserved_micros', 'budget_spent',
	], updateColumns: ['budget_spent', 'budget_reserved_micros', 'updated_at'] },
	{ table: 'user_budget_reservations', privileges: [], selectColumns: [
		'request_id', 'user_id', 'api_key_id', 'budget_epoch', 'reserved_micros', 'settled_micros', 'state',
	], updateColumns: [
		'state', 'settled_micros', 'terminal_at', 'terminal_reason', 'updated_at',
	] },
	{ table: 'guardrail_budget_reservations', privileges: [], selectColumns: [
		'id', 'assignment_id', 'request_id', 'workspace_id', 'scope_type', 'scope_id', 'period',
		'period_start', 'settled_micros', 'reserved_micros', 'settlement_basis', 'state',
	], updateColumns: [
		'state', 'settled_micros', 'terminal_at', 'terminal_reason', 'updated_at',
	] },
	{ table: 'guardrail_budget_windows', privileges: [], selectColumns: [
		'workspace_id', 'scope_type', 'scope_id', 'period', 'period_start', 'period_end',
		'reserved_micros', 'settled_micros', 'unreserved_micros',
	], updateColumns: [
		'reserved_micros', 'settled_micros', 'unreserved_micros', 'updated_at',
	] },
	{ table: 'public_model_daily_stats', privileges: ['SELECT', 'INSERT'], updateColumns: [
		'request_count', 'success_count', 'error_count', 'output_tokens', 'total_tokens',
		'latency_total_ms', 'latency_sample_count', 'updated_at',
	] },
	{ table: 'user_audit_logs', privileges: ['INSERT'], updateColumns: [] },
] as const);

/** Callable helpers used by the recovery commit; trigger entry points need no direct EXECUTE grant. */
export const RECOVERY_FUNCTION_GRANTS = Object.freeze([
	'recovery_api_key_workspace_matches(text,text)',
	'usage_commit_matches(text,text)',
	'usage_round_nonnegative_v1(double precision)',
	'usage_money_v1(text)',
	'usage_budget_units_v1(text)',
] as const);

export const REQUIRED_TRIGGERS = Object.freeze([
	// tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16.
	['request_dispatch_intents', 'request_dispatch_intents_guard', 'guard_request_dispatch_intent()', 23, false, false],
	['request_usage_settlements', 'request_usage_settlements_guard', 'guard_usage_settlement_fact()', 7, false, false],
	['request_usage_settlements', 'request_usage_settlements_enqueue', 'enqueue_usage_settlement_fact()', 5, false, false],
	['request_usage_settlements', 'request_usage_settlements_immutable', 'reject_usage_settlement_mutation()', 27, false, false],
	['request_usage_settlement_outbox', 'request_usage_settlement_outbox_immutable', 'reject_usage_settlement_mutation()', 27, false, false],
	['request_usage_recovery_jobs', 'request_usage_recovery_guard', 'guard_usage_recovery_job()', 31, false, false],
	['request_usage_commit_receipts', 'request_usage_commit_receipts_guard', 'guard_usage_commit_receipt()', 31, false, false],
	['request_usage_commit_receipts', 'request_usage_commit_transaction_check', 'check_usage_commit_transaction()', 5, true, true],
	['api_key_request_logs', 'trg_api_key_request_logs_workspace', 'enforce_request_log_workspace()', 7, false, false],
	['api_key_request_logs', 'request_usage_log_recovery_guard', 'guard_fact_owned_usage_log()', 7, false, false],
	['request_usage_settlements', 'request_usage_settlements_legacy_log_fence', 'guard_fact_without_legacy_log()', 7, false, false],
] as const);

/** Optional replay expand and parent-gate contracts. These are never implicit
 * recovery grants: a caller must explicitly select the fully gated phase. */
export const REPLAY_RESERVATION_TRIGGERS = Object.freeze([
	['request_dispatch_replay_tombstones', 'request_dispatch_replay_tombstones_insert_guard', 'guard_request_dispatch_replay_insert()', 7, false, false],
	['request_dispatch_replay_tombstones', 'request_dispatch_replay_tombstones_immutable', 'reject_request_dispatch_replay_mutation()', 27, false, false],
	['request_dispatch_replay_tombstones', 'request_dispatch_replay_tombstones_no_truncate', 'reject_request_dispatch_replay_mutation()', 34, false, false],
	['request_dispatch_intents', 'request_dispatch_intents_replay_reserve', 'reserve_request_dispatch_intent_id()', 7, false, false],
	['request_dispatch_intents', 'request_dispatch_intents_replay_no_delete', 'reject_request_dispatch_replay_mutation()', 11, false, false],
	['request_dispatch_intents', 'request_dispatch_intents_replay_no_truncate', 'reject_request_dispatch_replay_mutation()', 34, false, false],
	['api_key_request_logs', 'api_key_request_logs_replay_reserve', 'reserve_request_log_replay_id()', 7, false, false],
	['api_key_request_logs', 'api_key_request_logs_replay_id_immutable', 'guard_request_log_replay_id_update()', 19, false, false],
] as const);

export const REPLAY_PARENT_GATE_TRIGGERS = Object.freeze([
	['request_dispatch_requests', 'request_dispatch_requests_replay_reserve', 'reserve_request_dispatch_parent_id()', 7, false, false],
	['request_dispatch_requests', 'request_dispatch_requests_replay_no_delete', 'reject_request_dispatch_replay_mutation()', 11, false, false],
	['request_dispatch_requests', 'request_dispatch_requests_replay_no_truncate', 'reject_request_dispatch_replay_mutation()', 34, false, false],
] as const);

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function valuesSql(rows: readonly (readonly string[])[]): string {
	return rows.map((row) => `(${row.map(sqlString).join(', ')})`).join(',\n\t\t\t');
}

function requireTimeout(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
		throw new TypeError(`Invalid recovery ${name}`);
	}
}

export function validatePostgresRecoveryRolePolicy(input: RecoveryRolePolicyInput): RecoveryRolePolicy {
	if (!input || typeof input !== 'object') throw new TypeError('Recovery role policy input required');
	const budget = validatePostgresRecoveryOriginBudget(input.originBudgetFacts, input.nowMs);
	if (budget.recoveryRoleName !== POSTGRES_RECOVERY_ROLE || budget.recoveryRoleLogin !== false) {
		throw new TypeError('Recovery role must be a separate NOLOGIN provisioning identity');
	}
	const timeouts = Object.freeze({ ...budget.roleTimeoutDefaults });
	for (const [name, value] of Object.entries(timeouts)) requireTimeout(value, name);
	if (!(timeouts.lockMs < timeouts.statementMs && timeouts.statementMs < timeouts.transactionMs
		&& timeouts.idleInTransactionMs < timeouts.transactionMs)) {
		throw new TypeError('Recovery timeout ordering must keep lock, statement and idle limits effective');
	}
	return Object.freeze({
		role: POSTGRES_RECOVERY_ROLE,
		login: false,
		connectionLimit: budget.recoveryRoleConnectionLimit,
		timeouts,
		originBudget: budget,
	});
}

export type RecoveryRoleSqlPlan = Readonly<{
	role: typeof POSTGRES_RECOVERY_ROLE;
	login: false;
	adminSql: string;
	migratorSql: string;
	runtimeCompatible: false;
	/** No password or LOGIN activation is included. */
	activation: 'requires_separate_review';
	/** The grants are deliberately insufficient for today's financial writer. */
	knownBlockers: readonly [
		'legacy_request_log_guard_not_installed',
		'financial_writer_lock_acl_not_native_verified',
		'public_acl_outside_gateway_unverified',
		'native_privilege_and_timeout_behavior_unverified',
	];
}>;

/**
 * Render two reviewable, transactional SQL phases. The administrator phase creates
 * an inert cluster role. The migrator phase grants only the fixed recovery path.
 * Neither string is executed here. Apply only after the required schema and
 * trigger migrations, a fresh origin budget and native PostgreSQL verification.
 */
export function buildPostgresRecoveryRoleSql(input: RecoveryRolePolicyInput): RecoveryRoleSqlPlan {
	const policy = validatePostgresRecoveryRolePolicy(input);
	const role = policy.role;
	const schema = POSTGRES_RECOVERY_SCHEMA;
	const migrator = POSTGRES_RECOVERY_MIGRATOR;
	const timeout = policy.timeouts;
	const tableRows = valuesSql(RECOVERY_TABLE_GRANTS.map(({ table }) => [table]));
	const functionRows = valuesSql(RECOVERY_FUNCTION_GRANTS.map((signature) => [`${schema}.${signature}`]));
	const triggerRows = valuesSql(REQUIRED_TRIGGERS.map(([
		table, name, functionName, triggerType, deferrable, initiallyDeferred,
	]) => [table, name, `${schema}.${functionName}`, String(triggerType), String(deferrable), String(initiallyDeferred)]));
	const grants = RECOVERY_TABLE_GRANTS.flatMap((entry) => [
		...('selectColumns' in entry && entry.selectColumns.length
			? [`GRANT SELECT (${entry.selectColumns.join(', ')}) ON TABLE ${schema}.${entry.table} TO ${role};`] : []),
		...(entry.privileges.length ? [`GRANT ${entry.privileges.join(', ')} ON TABLE ${schema}.${entry.table} TO ${role};`] : []),
		...(entry.updateColumns.length ? [`GRANT UPDATE (${entry.updateColumns.join(', ')}) ON TABLE ${schema}.${entry.table} TO ${role};`] : []),
	]).join('\n');
	const functionGrants = RECOVERY_FUNCTION_GRANTS.map((signature) =>
		`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${role};`).join('\n');
	const adminSql = `-- REVIEW ONLY. No password, LOGIN or Hyperdrive is created. Run as a controlled DBA.
-- ALTER ROLE IN DATABASE settings are new-login defaults, not immutable hard ceilings.
BEGIN;
DO $recovery_admin_preflight$
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'PostgreSQL 17 or later is required for transaction_timeout';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
    RAISE EXCEPTION 'Recovery role already exists; audit it instead of overwriting it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${migrator}') THEN
    RAISE EXCEPTION 'Gateway migrator role is missing';
  END IF;
END
$recovery_admin_preflight$;
CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT ${policy.connectionLimit} PASSWORD NULL;
DO $recovery_admin_defaults$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${role}');
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET transaction_timeout TO ${timeout.transactionMs}', '${role}', current_database());
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout TO ${timeout.statementMs}', '${role}', current_database());
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET lock_timeout TO ${timeout.lockMs}', '${role}', current_database());
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout TO ${timeout.idleInTransactionMs}', '${role}', current_database());
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path TO pg_catalog, ${schema}', '${role}', current_database());
  -- PostgreSQL may grant the newly created role to its creator. Remove that edge.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    WHERE granted.rolname = '${role}' AND member.rolname = current_user
  ) THEN
    EXECUTE format('REVOKE %I FROM %I', '${role}', current_user);
  END IF;
END
$recovery_admin_defaults$;
COMMIT;`;
	const migratorSql = `-- REVIEW ONLY. Run as ${migrator} after formal recovery migrations.
-- Recovery locks the API key through a narrow SECURITY DEFINER helper and reads
-- the immutable request log without FOR UPDATE. Direct UPDATE remains denied.
BEGIN;
DO $recovery_grant_preflight$
DECLARE
  expected_table record;
  expected_function record;
  expected_trigger record;
  catalog_object record;
  privilege_name text;
  role_row record;
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'PostgreSQL 17 or later is required for transaction_timeout';
  END IF;
  IF current_user <> '${migrator}' OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid = n.nspowner
    WHERE n.nspname = '${schema}' AND owner.rolname = '${migrator}'
  ) THEN
    RAISE EXCEPTION 'Gateway migrator must own the recovery schema';
  END IF;
  SELECT oid, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
    rolbypassrls, rolconnlimit INTO role_row
    FROM pg_catalog.pg_roles WHERE rolname = '${role}';
  IF NOT FOUND OR role_row.rolcanlogin OR role_row.rolinherit OR role_row.rolsuper OR role_row.rolcreatedb
    OR role_row.rolcreaterole OR role_row.rolreplication OR role_row.rolbypassrls
    OR role_row.rolconnlimit <> ${policy.connectionLimit} THEN
    RAISE EXCEPTION 'Recovery role attributes differ from the inert provision plan';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid = role_row.oid OR member = role_row.oid) THEN
    RAISE EXCEPTION 'Recovery role membership is forbidden';
  END IF;
  -- The new role must not already gain gateway permissions via PUBLIC. A REVOKE
  -- from this individual role cannot override a PUBLIC grant.
  IF pg_catalog.has_schema_privilege('${role}', '${schema}', 'USAGE')
    OR pg_catalog.has_schema_privilege('${role}', '${schema}', 'CREATE') THEN
    RAISE EXCEPTION 'Recovery schema privileges are already exposed through PUBLIC';
  END IF;
  IF pg_catalog.has_database_privilege('${role}', current_database(), 'CREATE')
    OR (pg_catalog.to_regnamespace('public') IS NOT NULL
      AND pg_catalog.has_schema_privilege('${role}', 'public', 'CREATE')) THEN
    RAISE EXCEPTION 'Recovery role can create shared database or public schema objects';
  END IF;
  FOR catalog_object IN
    SELECT c.oid, c.relname, c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}'
  LOOP
    IF catalog_object.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
      FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF pg_catalog.has_table_privilege('${role}', catalog_object.oid, privilege_name) THEN
          RAISE EXCEPTION 'Recovery role already has table privilege via PUBLIC: %', catalog_object.relname;
        END IF;
      END LOOP;
      FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege('${role}', catalog_object.oid, privilege_name) THEN
          RAISE EXCEPTION 'Recovery role already has column privilege via PUBLIC: %', catalog_object.relname;
        END IF;
      END LOOP;
    ELSIF catalog_object.relkind = 'S' THEN
      FOREACH privilege_name IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
        IF pg_catalog.has_sequence_privilege('${role}', catalog_object.oid, privilege_name) THEN
          RAISE EXCEPTION 'Recovery role already has sequence privilege via PUBLIC: %', catalog_object.relname;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  FOR catalog_object IN
    SELECT p.oid, p.proname FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${schema}'
  LOOP
    IF pg_catalog.has_function_privilege('${role}', catalog_object.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Recovery role already has function execution via PUBLIC: %', catalog_object.proname;
    END IF;
  END LOOP;
  FOR expected_table IN SELECT name FROM (VALUES
            ${tableRows}
  ) AS required(name) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid = c.relowner
      WHERE n.nspname = '${schema}' AND c.relname = expected_table.name
        AND c.relkind IN ('r', 'p') AND owner.rolname = '${migrator}'
    ) THEN
      RAISE EXCEPTION 'Required recovery table missing, wrong kind or wrong owner: %', expected_table.name;
    END IF;
  END LOOP;
  FOR expected_function IN SELECT signature FROM (VALUES
            ${functionRows}
  ) AS required(signature) LOOP
    IF pg_catalog.to_regprocedure(expected_function.signature) IS NULL THEN
      RAISE EXCEPTION 'Required recovery function missing: %', expected_function.signature;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
    JOIN pg_catalog.pg_language language ON language.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure('${schema}.recovery_api_key_workspace_matches(text,text)')
      AND owner.rolname = '${migrator}' AND language.lanname = 'plpgsql'
      AND p.prokind = 'f' AND p.prosecdef AND p.provolatile = 'v'
      AND NOT p.proretset AND p.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
      AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'Recovery API-key lock helper ownership or security contract differs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
    WHERE p.oid = pg_catalog.to_regprocedure('${schema}.recovery_api_key_workspace_matches(text,text)')
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Recovery API-key lock helper is executable by PUBLIC';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cinatoken_gateway_runtime') THEN
    RAISE EXCEPTION 'Ordinary runtime role is missing';
  END IF;
  IF pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
    pg_catalog.to_regprocedure('${schema}.recovery_api_key_workspace_matches(text,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'Ordinary runtime must not execute the recovery API-key lock helper';
  END IF;
  -- 0053 reads api_keys without a schema qualifier. Migration 0068 pins the
  -- workspace trigger to the gateway schema before pg_temp so a caller's
  -- temporary api_keys table cannot replace the authoritative lookup.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
    JOIN pg_catalog.pg_language language ON language.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure('${schema}.enforce_request_log_workspace()')
      AND owner.rolname = '${migrator}' AND language.lanname = 'plpgsql'
      AND p.prokind = 'f' AND NOT p.prosecdef AND p.provolatile = 'v'
      AND NOT p.proretset AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND p.proconfig = ARRAY['search_path=pg_catalog, cinatoken_gateway, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'Request-log workspace trigger function security contract differs';
  END IF;
  -- Both optional guards read recovery-only tables on ordinary and recovery
  -- INSERTs. Definer ownership, fixed search_path and denied direct execution
  -- are required before this role can be granted.
  FOR expected_function IN SELECT signature FROM (VALUES
    ('${schema}.guard_fact_owned_usage_log()'),
    ('${schema}.guard_fact_without_legacy_log()')
  ) AS required(signature) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      WHERE p.oid = pg_catalog.to_regprocedure(expected_function.signature)
        AND owner.rolname = '${migrator}' AND language.lanname = 'plpgsql'
        AND p.prokind = 'f' AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proretset AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'Legacy log fence ownership or security contract differs: %', expected_function.signature;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
      WHERE p.oid = pg_catalog.to_regprocedure(expected_function.signature)
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'Legacy log fence is executable by PUBLIC: %', expected_function.signature;
    END IF;
    IF pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      pg_catalog.to_regprocedure(expected_function.signature), 'EXECUTE') THEN
      RAISE EXCEPTION 'Ordinary runtime must not execute the legacy log fence: %', expected_function.signature;
    END IF;
  END LOOP;
  FOR expected_trigger IN SELECT table_name, trigger_name, function_signature,
    trigger_type, is_deferrable, initially_deferred FROM (VALUES
            ${triggerRows}
  ) AS required(table_name, trigger_name, function_signature,
    trigger_type, is_deferrable, initially_deferred) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schema}' AND c.relname = expected_trigger.table_name
        AND t.tgname = expected_trigger.trigger_name AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
        AND t.tgfoid = pg_catalog.to_regprocedure(expected_trigger.function_signature)
        AND t.tgtype = expected_trigger.trigger_type::smallint
        AND t.tgdeferrable = expected_trigger.is_deferrable::boolean
        AND t.tginitdeferred = expected_trigger.initially_deferred::boolean
        AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr) = 0
        AND t.tgnargs = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
    ) THEN
      RAISE EXCEPTION 'Required recovery trigger missing, disabled or has wrong function/event/timing: %', expected_trigger.trigger_name;
    END IF;
  END LOOP;
END
$recovery_grant_preflight$;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${grants}
${functionGrants}
COMMIT;`;
	return Object.freeze({
		role, login: false, adminSql, migratorSql, runtimeCompatible: false,
		activation: 'requires_separate_review',
		knownBlockers: Object.freeze([
			'legacy_request_log_guard_not_installed',
			'financial_writer_lock_acl_not_native_verified',
			'public_acl_outside_gateway_unverified',
			'native_privilege_and_timeout_behavior_unverified',
		] as const),
	});
}
