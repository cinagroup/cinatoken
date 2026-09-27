-- MANUAL C03 SWITCH ONLY. This file is intentionally outside migrations-postgres
-- and postgres-migrations-worker.ts. It does not authorize recovery execution.
-- Run as the gateway migrator in one explicit transaction after the ordinary
-- runtime ACL is narrowed, native PostgreSQL role/race tests pass, and ordinary
-- writers are drained. The caller must first SET LOCAL
-- cinatoken.recovery_log_guard_activation = 'reviewed-v1' in that transaction.
-- This assertion prevents accidental inclusion in the automatic migration loop;
-- it is an operator acknowledgement, not a database privilege boundary.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
-- Keep the existing migration and runtime-grant administrators out of this
-- preflight/install window. Their lock keys are fixed in the cutover scripts.
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);

DO $preflight$
DECLARE migrator_oid oid;
DECLARE recovery_table text;
BEGIN
  IF pg_catalog.current_setting('cinatoken.recovery_log_guard_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit recovery log guard activation assertion is missing';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Recovery log guard activation requires READ COMMITTED';
  END IF;
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid) THEN
    RAISE EXCEPTION 'Recovery log guard requires the gateway schema owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Formal recovery migration 0073 is required';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
      ('api_key_request_logs'), ('request_dispatch_intents'),
      ('request_usage_settlements'), ('request_usage_settlement_outbox'),
      ('request_usage_recovery_jobs'), ('request_usage_commit_receipts')
    ) AS expected(name)
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'cinatoken_gateway'
    LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = expected.name
    WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> migrator_oid
      OR c.relrowsecurity OR c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'Recovery log guard source table is missing, RLS-enabled or has another owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = 'cinatoken_gateway_runtime') THEN
    RAISE EXCEPTION 'Ordinary gateway runtime role is required';
  END IF;
  IF NOT pg_catalog.has_schema_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway', 'USAGE')
    OR NOT pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_key_request_logs', 'SELECT')
    OR NOT pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_key_request_logs', 'INSERT')
    OR NOT pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_keys', 'SELECT')
    OR NOT pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.enforce_request_log_workspace()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Ordinary runtime lacks the existing request-log write path';
  END IF;
  IF pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_key_request_logs', 'UPDATE')
    OR pg_catalog.has_any_column_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_key_request_logs', 'UPDATE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_key_request_logs', 'DELETE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.api_key_request_logs', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Ordinary runtime must not mutate or erase request logs';
  END IF;
  FOR recovery_table IN SELECT name FROM (VALUES
      ('request_dispatch_intents'), ('request_usage_settlements'),
      ('request_usage_settlement_outbox'), ('request_usage_recovery_jobs'),
      ('request_usage_commit_receipts')
    ) AS expected(name) LOOP
    IF pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'SELECT')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'INSERT')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'UPDATE')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'DELETE')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'TRUNCATE')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'REFERENCES')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'TRIGGER')
      OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'MAINTAIN')
      OR pg_catalog.has_any_column_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'SELECT')
      OR pg_catalog.has_any_column_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'INSERT')
      OR pg_catalog.has_any_column_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'UPDATE')
      OR pg_catalog.has_any_column_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.' || recovery_table, 'REFERENCES') THEN
      RAISE EXCEPTION 'Ordinary runtime has unexpected recovery table privilege: %',
        recovery_table;
    END IF;
  END LOOP;
  IF pg_catalog.to_regprocedure('cinatoken_gateway.guard_fact_owned_usage_log()') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.guard_fact_without_legacy_log()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid IN ('cinatoken_gateway.api_key_request_logs'::regclass,
          'cinatoken_gateway.request_usage_settlements'::regclass)
        AND t.tgname IN ('request_usage_log_recovery_guard',
          'request_usage_settlements_legacy_log_fence')) THEN
    RAISE EXCEPTION 'Recovery log guard switch already exists; inspect before retrying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'cinatoken_gateway.api_key_request_logs'::regclass
        AND t.tgname = 'trg_api_key_request_logs_workspace'
        AND t.tgtype = 7 AND t.tgenabled = 'O'
        AND t.tgfoid = pg_catalog.to_regprocedure(
          'cinatoken_gateway.enforce_request_log_workspace()')) THEN
    RAISE EXCEPTION 'Existing request-log workspace trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      WHERE p.oid = pg_catalog.to_regprocedure(
          'cinatoken_gateway.enforce_request_log_workspace()')
        AND p.proowner = migrator_oid AND language.lanname = 'plpgsql'
        AND p.prokind = 'f' AND NOT p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proretset AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, cinatoken_gateway, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'Existing request-log workspace trigger function contract differs from 0068';
  END IF;
END;
$preflight$;

-- Freeze both INSERT streams before inspecting preexisting IDs. CREATE TRIGGER
-- takes a conflicting lock too; this explicit order keeps the overlap check
-- and both trigger installations inside one stable cutover boundary.
LOCK TABLE cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.request_usage_settlements IN SHARE ROW EXCLUSIVE MODE;
DO $overlap$
BEGIN
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_settlements s
      JOIN cinatoken_gateway.api_key_request_logs l ON l.id = s.request_id) THEN
    RAISE EXCEPTION 'Existing legacy log overlaps a recovery fact';
  END IF;
END;
$overlap$;

-- Both INSERT paths use the same transaction advisory key. A hash collision
-- only serializes unrelated IDs. READ COMMITTED is required so a waiter sees
-- the transaction that released the lock; older fixed snapshots are rejected.
CREATE FUNCTION cinatoken_gateway.guard_fact_owned_usage_log() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $log$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Recovery log guard requires READ COMMITTED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    (('x' || pg_catalog.substr(pg_catalog.md5(NEW.id), 1, 16))::bit(64))::bigint);
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_settlements
      WHERE request_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_commit_receipts r
      JOIN cinatoken_gateway.request_usage_recovery_jobs j
        ON j.request_id = r.request_id AND j.payload_sha256 = r.payload_sha256
      WHERE r.request_id = NEW.id AND r.user_id = NEW.user_id
        AND r.workspace_id = NEW.workspace_id AND j.state = 'leased'
        AND j.revision = r.lease_revision AND j.lease_token = r.lease_token
        AND j.lease_expires_at_ms >
          pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) * 1000)::bigint) THEN
    RAISE EXCEPTION 'Fact-owned usage log requires an active fenced receipt';
  END IF;
  RETURN NEW;
END;
$log$;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_fact_owned_usage_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_fact_owned_usage_log()
  FROM cinatoken_gateway_runtime;

CREATE FUNCTION cinatoken_gateway.guard_fact_without_legacy_log() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $fact$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Recovery fact guard requires READ COMMITTED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    (('x' || pg_catalog.substr(pg_catalog.md5(NEW.request_id), 1, 16))::bit(64))::bigint);
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.api_key_request_logs
      WHERE id = NEW.request_id) THEN
    RAISE EXCEPTION 'Existing legacy log cannot become a recovery fact';
  END IF;
  RETURN NEW;
END;
$fact$;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_fact_without_legacy_log() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_fact_without_legacy_log()
  FROM cinatoken_gateway_runtime;

CREATE TRIGGER request_usage_log_recovery_guard BEFORE INSERT
  ON cinatoken_gateway.api_key_request_logs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.guard_fact_owned_usage_log();
CREATE TRIGGER request_usage_settlements_legacy_log_fence BEFORE INSERT
  ON cinatoken_gateway.request_usage_settlements FOR EACH ROW
  EXECUTE FUNCTION cinatoken_gateway.guard_fact_without_legacy_log();

-- No ordinary/recovery role grants, scheduler, financial writes or automatic
-- rollback. Disable recovery admission and reconcile facts/receipts before any
-- later DDL that would remove this fence. Native contention and ACL checks
-- remain mandatory before applying this optional switch outside a test DB.
-- These local statement/lock limits do not bound the full transaction lifetime;
-- the migrator session needs an independently established transaction timeout.
