-- REVIEW ONLY successor to shared-key-usage-repair-jobs.sql. Install as the
-- direct migrator in one explicit transaction after the v335 job proposal and
-- before creating the dedicated consumer LOGIN. The caller must SET LOCAL
-- cinatoken.shared_key_usage_repair_failure_activation = 'reviewed-v2'.
-- No formal migration, remote SQL or automatic production activation.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

-- Take relation locks before reading the version ledger or trigger catalog.
-- A concurrent DISABLE TRIGGER must commit or roll back before preflight.
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;
LOCK TABLE cinatoken_gateway.shared_key_earnings IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.shared_key_usage_repair_failure_activation', true)
      IS DISTINCT FROM 'reviewed-v2'
    OR pg_catalog.current_setting('server_version_num')::integer < 180000
    OR pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR migrator_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = 'cinatoken_gateway_shared_key_usage_repair_consumer')
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = pg_catalog.to_regclass('cinatoken_gateway.shared_key_usage_repair_jobs')
        AND c.relkind = 'r' AND c.relowner = migrator_oid
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.repair_one_shared_key_usage()')
        AND p.proowner = migrator_oid AND p.prosecdef AND p.provolatile = 'v'
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(p.prosrc) = '3d969f058d559358d51077eeea22a648')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_enqueue_usage_repair'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_shared_key_usage_repair()')
        AND p.proowner = migrator_oid AND p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '9b5cdfc119cb06d10079062a744ac4aa')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_history_immutable'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 27
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.reject_shared_key_earnings_history_mutation()')
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_history_no_truncate'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 34
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.reject_shared_key_earnings_history_mutation()')
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_credit_after_insert'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()')
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '5f4867439aca9484551b83af6bb7c7f6')
    OR pg_catalog.to_regprocedure('cinatoken_gateway.attempt_one_shared_key_usage_repair()') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(text,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
        AND attname IN ('attempt_count','retry_after','dead_lettered_at','last_failed_at','last_sqlstate')
        AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Shared-key usage repair failure-isolation preflight differs';
  END IF;
END;
$preflight$;

ALTER TABLE cinatoken_gateway.shared_key_usage_repair_jobs
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN retry_after timestamptz,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN last_failed_at timestamptz,
  ADD COLUMN last_sqlstate text,
  ADD CONSTRAINT shared_key_usage_repair_failure_state CHECK (
    (attempt_count = 0 AND retry_after IS NULL AND dead_lettered_at IS NULL
      AND last_failed_at IS NULL AND last_sqlstate IS NULL)
    OR (attempt_count BETWEEN 1 AND 4 AND retry_after IS NOT NULL
      AND dead_lettered_at IS NULL AND last_failed_at IS NOT NULL
      AND last_sqlstate ~ '^[0-9A-Z]{5}$')
    OR (attempt_count = 5 AND retry_after IS NULL
      AND dead_lettered_at IS NOT NULL AND last_failed_at IS NOT NULL
      AND last_sqlstate ~ '^[0-9A-Z]{5}$')
  );

DROP INDEX cinatoken_gateway.shared_key_usage_repair_due;
CREATE INDEX shared_key_usage_repair_ready_v2
  ON cinatoken_gateway.shared_key_usage_repair_jobs
  ((GREATEST(available_at, COALESCE(retry_after, available_at))), shared_key_id)
  WHERE dead_lettered_at IS NULL;

-- The original repair function remains migrator-only for the v335 fixture.
-- Only this entrypoint is granted to the dedicated consumer. Every failed
-- per-key projection rolls back in a PL/pgSQL subtransaction before the job's
-- failure state is committed. PostgreSQL query cancellation and assert failure
-- are not swallowed by WHEN OTHERS; server deadlines still stop the transaction.
CREATE FUNCTION cinatoken_gateway.attempt_one_shared_key_usage_repair()
RETURNS TABLE(shared_key_id text, outcome text, attempt_count integer, retry_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $attempt$
DECLARE
  candidate_id text;
  recorded_request_log text;
  failed_sqlstate text;
  failed_at timestamptz;
  changed_rows integer;
BEGIN
  IF SESSION_USER NOT IN ('cinatoken_gateway_migrator',
      'cinatoken_gateway_shared_key_usage_repair_consumer')
    OR pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Shared-key usage repair caller differs';
  END IF;
  FOR candidate_id IN
    SELECT job.shared_key_id
    FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
    JOIN cinatoken_gateway.shared_keys AS sk ON sk.id = job.shared_key_id
    WHERE job.dead_lettered_at IS NULL
      AND GREATEST(job.available_at, COALESCE(job.retry_after, job.available_at))
        <= pg_catalog.clock_timestamp()
    ORDER BY GREATEST(job.available_at, COALESCE(job.retry_after, job.available_at)),
      job.shared_key_id
    LIMIT 1 FOR UPDATE OF sk SKIP LOCKED
  LOOP
    -- Earning INSERT takes the FK key lock before enqueueing its job. Keep
    -- that key -> job order; recheck the due predicate after locking the job.
    recorded_request_log := NULL;
    SELECT job.request_log_id INTO recorded_request_log
      FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
      WHERE job.shared_key_id = candidate_id AND job.dead_lettered_at IS NULL
        AND GREATEST(job.available_at, COALESCE(job.retry_after, job.available_at))
          <= pg_catalog.clock_timestamp()
      FOR UPDATE;
    IF recorded_request_log IS NULL THEN CONTINUE; END IF;
    failed_sqlstate := NULL;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings e
          WHERE e.request_log_id = recorded_request_log AND e.shared_key_id = candidate_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'PZ001',
          MESSAGE = 'Shared-key usage repair identity differs';
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
        FROM cinatoken_gateway.shared_key_earnings AS e
        WHERE e.shared_key_id = candidate_id
      ) AS totals
      WHERE sk.id = candidate_id;
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
      IF changed_rows <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'PZ002',
          MESSAGE = 'Shared-key usage repair update differs';
      END IF;
      DELETE FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
        WHERE job.shared_key_id = candidate_id;
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
      IF changed_rows <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'PZ003',
          MESSAGE = 'Shared-key usage repair acknowledgement differs';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failed_sqlstate = RETURNED_SQLSTATE;
    END;
    IF failed_sqlstate IS NULL THEN
      RETURN QUERY SELECT candidate_id, 'repaired'::text, 0::integer, NULL::timestamptz;
      RETURN;
    END IF;
    failed_at := pg_catalog.clock_timestamp();
    UPDATE cinatoken_gateway.shared_key_usage_repair_jobs AS job
    SET attempt_count = job.attempt_count + 1,
        retry_after = CASE WHEN job.attempt_count >= 4 THEN NULL
          ELSE failed_at + pg_catalog.make_interval(secs => (60 * (1 << job.attempt_count))) END,
        dead_lettered_at = CASE WHEN job.attempt_count >= 4 THEN failed_at ELSE NULL END,
        last_failed_at = failed_at,
        last_sqlstate = failed_sqlstate
    WHERE job.shared_key_id = candidate_id AND job.request_log_id = recorded_request_log
      AND job.attempt_count < 5;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Shared-key usage repair failure acknowledgement differs';
    END IF;
    RETURN QUERY SELECT candidate_id,
      CASE WHEN job.dead_lettered_at IS NULL THEN 'deferred' ELSE 'dead_lettered' END::text,
      job.attempt_count, job.retry_after
      FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
      WHERE job.shared_key_id = candidate_id;
    RETURN;
  END LOOP;
  RETURN QUERY SELECT NULL::text, 'no_candidate'::text, 0::integer, NULL::timestamptz;
END;
$attempt$;
REVOKE ALL ON FUNCTION cinatoken_gateway.attempt_one_shared_key_usage_repair() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.attempt_one_shared_key_usage_repair()
  FROM cinatoken_gateway_runtime;

-- Manual recovery requires direct migrator LOGIN, a token derived from the
-- full-precision database failure timestamp and explicit local activation. It preserves the
-- original earning and job; the next repair recomputes the projection only.
CREATE FUNCTION cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(
  key_id text, expected_failure_token text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $requeue$
DECLARE changed_rows integer;
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator' OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.shared_key_usage_repair_requeue_activation', true)
      IS DISTINCT FROM 'reviewed-v2' OR key_id IS NULL
    OR expected_failure_token IS NULL
    OR expected_failure_token !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'Shared-key usage repair manual recovery authority differs';
  END IF;
  PERFORM 1 FROM cinatoken_gateway.shared_keys AS sk WHERE sk.id = key_id FOR UPDATE;
  PERFORM 1 FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
    WHERE job.shared_key_id = key_id FOR UPDATE;
  UPDATE cinatoken_gateway.shared_key_usage_repair_jobs AS job
  SET attempt_count = 0, retry_after = NULL, dead_lettered_at = NULL,
      last_failed_at = NULL, last_sqlstate = NULL,
      available_at = pg_catalog.clock_timestamp()
  WHERE job.shared_key_id = key_id AND job.dead_lettered_at IS NOT NULL
    AND pg_catalog.md5(pg_catalog.to_char(job.last_failed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD HH24:MI:SS.US')) = expected_failure_token;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN RAISE EXCEPTION 'Shared-key usage repair dead letter changed'; END IF;
  RETURN true;
END;
$requeue$;
REVOKE ALL ON FUNCTION cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(
  text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(
  text, text) FROM cinatoken_gateway_runtime;

DO $acl$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
      WHERE p.oid IN (
        'cinatoken_gateway.attempt_one_shared_key_usage_repair()'::pg_catalog.regprocedure,
        'cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(text,text)'::pg_catalog.regprocedure)
        AND acl.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
      WHERE c.oid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
        AND acl.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'Shared-key usage repair failure-isolation ACL differs';
  END IF;
END;
$acl$;
