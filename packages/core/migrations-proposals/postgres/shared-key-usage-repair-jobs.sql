-- REVIEW ONLY. Install after 0073 and the credited-earning history guard in
-- one explicit migrator transaction with:
--   SET LOCAL cinatoken.shared_key_usage_repair_activation = 'reviewed-v1';
-- This is a prototype for C04.7. It does not grant a runtime caller, seed old
-- earnings, schedule execution, or replace immutable quote/economic outbox work.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $activation$
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR pg_catalog.current_setting('cinatoken.shared_key_usage_repair_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Shared-key usage repair activation or owner contract differs';
  END IF;
END;
$activation$;

-- Trigger activation must not cross an earning INSERT. A failure rolls back
-- the entire proposal, including the table and both functions.
LOCK TABLE cinatoken_gateway.shared_key_earnings IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF migrator_oid IS NULL OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    -- The three upstream triggers and both bodies are part of the reviewed
    -- economic contract. A name-only check can accept disabled TRUNCATE
    -- protection or a replaced credit function that no longer credits.
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_history_immutable'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 27
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND pg_catalog.md5(p.prosrc) = '208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_history_no_truncate'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 34
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND pg_catalog.md5(p.prosrc) = '208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_credit_after_insert'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND pg_catalog.md5(p.prosrc) = '5f4867439aca9484551b83af6bb7c7f6')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE relnamespace = 'cinatoken_gateway'::pg_catalog.regnamespace
        AND relname = 'shared_key_usage_repair_jobs')
    OR pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_shared_key_usage_repair()') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.repair_one_shared_key_usage()') IS NOT NULL THEN
    RAISE EXCEPTION 'Shared-key usage repair preflight differs';
  END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.shared_key_usage_repair_jobs (
  shared_key_id text PRIMARY KEY REFERENCES cinatoken_gateway.shared_keys(id) ON DELETE RESTRICT,
  request_log_id text NOT NULL REFERENCES cinatoken_gateway.shared_key_earnings(request_log_id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL
);
CREATE INDEX shared_key_usage_repair_due
  ON cinatoken_gateway.shared_key_usage_repair_jobs(available_at, shared_key_id);
REVOKE ALL ON cinatoken_gateway.shared_key_usage_repair_jobs FROM PUBLIC;
REVOKE ALL ON cinatoken_gateway.shared_key_usage_repair_jobs FROM cinatoken_gateway_runtime;

CREATE FUNCTION cinatoken_gateway.enqueue_shared_key_usage_repair()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $enqueue$
DECLARE requested timestamptz;
BEGIN
  IF TG_RELID <> 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
    OR TG_NAME <> 'shared_key_earnings_enqueue_usage_repair'
    OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shared-key usage repair trigger binding differs';
  END IF;
  requested := pg_catalog.clock_timestamp();
  INSERT INTO cinatoken_gateway.shared_key_usage_repair_jobs
    (shared_key_id, request_log_id, requested_at, available_at)
  VALUES (NEW.shared_key_id, NEW.request_log_id, requested, requested)
  ON CONFLICT (shared_key_id) DO UPDATE
    SET request_log_id = EXCLUDED.request_log_id,
        requested_at = EXCLUDED.requested_at,
        available_at = EXCLUDED.available_at;
  RETURN NEW;
END;
$enqueue$;
REVOKE ALL ON FUNCTION cinatoken_gateway.enqueue_shared_key_usage_repair() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.enqueue_shared_key_usage_repair() FROM cinatoken_gateway_runtime;
CREATE TRIGGER shared_key_earnings_enqueue_usage_repair
  AFTER INSERT ON cinatoken_gateway.shared_key_earnings
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.enqueue_shared_key_usage_repair();

-- One call repairs at most one key in the caller's transaction. Lock the key
-- before its job: earning INSERT already holds a key FK lock before enqueueing
-- the job, so reversing this order could deadlock. A crash or lost COMMIT ACK
-- rolls back both the projection and job deletion, or commits both together.
CREATE FUNCTION cinatoken_gateway.repair_one_shared_key_usage()
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $repair$
DECLARE
  candidate text;
  recorded_request_log text;
  changed_rows integer;
BEGIN
  FOR candidate IN
    SELECT job.shared_key_id
    FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
    JOIN cinatoken_gateway.shared_keys AS sk ON sk.id = job.shared_key_id
    WHERE job.available_at <= pg_catalog.clock_timestamp()
    ORDER BY job.available_at, job.shared_key_id
    LIMIT 1 FOR UPDATE OF sk SKIP LOCKED
  LOOP
    -- LockRows skips busy keys before LIMIT counts a candidate, so a run of
    -- older locked jobs cannot hide a later due job. The key is held before
    -- the job row, matching earning INSERT's FK/key -> enqueue order.
    recorded_request_log := NULL;
    SELECT request_log_id INTO recorded_request_log
      FROM cinatoken_gateway.shared_key_usage_repair_jobs
      WHERE shared_key_id = candidate
        AND available_at <= pg_catalog.clock_timestamp()
      FOR UPDATE;
    IF recorded_request_log IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings
      WHERE request_log_id = recorded_request_log AND shared_key_id = candidate) THEN
      RAISE EXCEPTION 'Shared-key usage repair identity differs';
    END IF;

    UPDATE cinatoken_gateway.shared_keys AS sk
    SET served_input_tokens = totals.input_tokens,
        served_output_tokens = totals.output_tokens,
        earned_total = totals.net_amount,
        last_used_at = totals.last_used_at,
        updated_at = pg_catalog.clock_timestamp()
    FROM (
      SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(net_amount), 0) AS net_amount,
        MAX(created_at) AS last_used_at
      FROM cinatoken_gateway.shared_key_earnings WHERE shared_key_id = candidate
    ) AS totals
    WHERE sk.id = candidate;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN RAISE EXCEPTION 'Shared-key usage repair update differs'; END IF;

    DELETE FROM cinatoken_gateway.shared_key_usage_repair_jobs
      WHERE shared_key_id = candidate;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN RAISE EXCEPTION 'Shared-key usage repair acknowledgement differs'; END IF;
    RETURN candidate;
  END LOOP;
  RETURN NULL;
END;
$repair$;
REVOKE ALL ON FUNCTION cinatoken_gateway.repair_one_shared_key_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.repair_one_shared_key_usage() FROM cinatoken_gateway_runtime;

-- A migrator's default ACL may grant an unexpected role even after PUBLIC is
-- revoked. Reject that entire activation rather than exposing definer entrypoints.
DO $acl$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
    WHERE p.oid IN (
      'cinatoken_gateway.enqueue_shared_key_usage_repair()'::pg_catalog.regprocedure,
      'cinatoken_gateway.repair_one_shared_key_usage()'::pg_catalog.regprocedure)
      AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> migrator_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
    WHERE c.oid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
      AND acl.grantee <> migrator_oid
  ) THEN
    RAISE EXCEPTION 'Shared-key usage repair ACL differs';
  END IF;
END;
$acl$;
