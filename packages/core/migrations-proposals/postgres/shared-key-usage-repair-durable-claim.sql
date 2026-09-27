-- REVIEW ONLY successor to shared-key-usage-repair-failure-isolation.sql.
-- Install as direct migrator, before the dedicated repair LOGIN is created, in
-- one explicit transaction with:
--   SET LOCAL cinatoken.shared_key_usage_repair_claim_activation = 'reviewed-v3';
-- A claim must COMMIT before finish_claimed_shared_key_usage_repair is called.
-- No formal migration, remote SQL, or production activation is supplied here.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE;
LOCK TABLE cinatoken_gateway.shared_key_earnings IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.shared_key_usage_repair_claim_activation', true)
      IS DISTINCT FROM 'reviewed-v3'
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
    OR pg_catalog.to_regprocedure('cinatoken_gateway.attempt_one_shared_key_usage_repair()') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(text,text)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = 'cinatoken_gateway.attempt_one_shared_key_usage_repair()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND p.prosecdef AND p.provolatile = 'v'
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(p.prosrc) = '9c488c248dc6af5d1863f0ea640de693')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_enqueue_usage_repair'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.enqueue_shared_key_usage_repair()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '9b5cdfc119cb06d10079062a744ac4aa')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_history_immutable'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 27
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_history_no_truncate'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 34
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname = 'shared_key_earnings_credit_after_insert'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 5
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = 'cinatoken_gateway.shared_key_earnings_credit_after_insert_fn()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc) = '5f4867439aca9484551b83af6bb7c7f6')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
        AND conname = 'shared_key_usage_repair_failure_state' AND contype = 'c')
    OR pg_catalog.to_regprocedure('cinatoken_gateway.claim_one_shared_key_usage_repair()') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.finish_claimed_shared_key_usage_repair(text,uuid)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
        AND attname IN ('claim_token', 'claim_expires_at') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Shared-key usage repair durable-claim preflight differs';
  END IF;
END;
$preflight$;

ALTER TABLE cinatoken_gateway.shared_key_usage_repair_jobs
  DROP CONSTRAINT shared_key_usage_repair_failure_state,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_expires_at timestamptz,
  ADD CONSTRAINT shared_key_usage_repair_claim_state CHECK (
    ((claim_token IS NULL) = (claim_expires_at IS NULL))
    AND ((attempt_count = 0 AND retry_after IS NULL AND dead_lettered_at IS NULL
      AND last_failed_at IS NULL AND last_sqlstate IS NULL AND claim_token IS NULL)
    OR (attempt_count BETWEEN 1 AND 4 AND retry_after IS NOT NULL
      AND dead_lettered_at IS NULL AND last_failed_at IS NOT NULL
      AND last_sqlstate ~ '^[0-9A-Z]{5}$')
    OR (attempt_count = 5 AND retry_after IS NULL
      AND dead_lettered_at IS NOT NULL AND last_failed_at IS NOT NULL
      AND last_sqlstate ~ '^[0-9A-Z]{5}$'))
  );

-- A claim is a short, independent transaction. It reserves one key and moves
-- its due time before any expensive aggregate is attempted. PZL01 means the
-- outcome is still unconfirmed, including a lost COMMIT ACK or cancellation.
-- The fifth admitted attempt is conservatively dead-lettered until success
-- deletes the job, or a direct migrator explicitly requeues it.
CREATE FUNCTION cinatoken_gateway.claim_one_shared_key_usage_repair()
RETURNS TABLE(shared_key_id text, claim_token uuid, attempt_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $claim$
DECLARE
  candidate_id text;
  recorded_request_log text;
  prior_attempt integer;
  claimed_at timestamptz;
  new_token uuid;
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
    WHERE job.dead_lettered_at IS NULL AND job.attempt_count < 5
      AND GREATEST(job.available_at, COALESCE(job.retry_after, job.available_at))
        <= pg_catalog.clock_timestamp()
      AND (job.claim_token IS NULL OR job.claim_expires_at <= pg_catalog.clock_timestamp())
    ORDER BY GREATEST(job.available_at, COALESCE(job.retry_after, job.available_at)),
      job.shared_key_id
    LIMIT 1 FOR UPDATE OF sk SKIP LOCKED
  LOOP
    -- Earning INSERT takes the key FK lock before enqueueing the job.
    recorded_request_log := NULL;
    SELECT job.request_log_id, job.attempt_count
      INTO recorded_request_log, prior_attempt
      FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
      WHERE job.shared_key_id = candidate_id AND job.dead_lettered_at IS NULL
        AND job.attempt_count < 5
        AND GREATEST(job.available_at, COALESCE(job.retry_after, job.available_at))
          <= pg_catalog.clock_timestamp()
        AND (job.claim_token IS NULL OR job.claim_expires_at <= pg_catalog.clock_timestamp())
      FOR UPDATE;
    IF recorded_request_log IS NULL THEN CONTINUE; END IF;
    claimed_at := pg_catalog.clock_timestamp();
    new_token := pg_catalog.gen_random_uuid();
    UPDATE cinatoken_gateway.shared_key_usage_repair_jobs AS job
    SET attempt_count = prior_attempt + 1,
        retry_after = CASE WHEN prior_attempt >= 4 THEN NULL
          ELSE claimed_at + pg_catalog.make_interval(secs => (60 * (1 << prior_attempt))) END,
        dead_lettered_at = CASE WHEN prior_attempt >= 4 THEN claimed_at ELSE NULL END,
        last_failed_at = claimed_at,
        last_sqlstate = 'PZL01',
        claim_token = new_token,
        claim_expires_at = claimed_at + interval '35 seconds'
    WHERE job.shared_key_id = candidate_id AND job.request_log_id = recorded_request_log
      AND job.attempt_count = prior_attempt;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'Shared-key usage repair claim acknowledgement differs';
    END IF;
    RETURN QUERY SELECT candidate_id, new_token, prior_attempt + 1;
    RETURN;
  END LOOP;
  RETURN QUERY SELECT NULL::text, NULL::uuid, 0::integer;
END;
$claim$;
REVOKE ALL ON FUNCTION cinatoken_gateway.claim_one_shared_key_usage_repair() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.claim_one_shared_key_usage_repair()
  FROM cinatoken_gateway_runtime;

-- Finish runs after claim COMMIT, in a second transaction. The key -> job lock
-- order matches earning INSERT. Recompute from immutable earning rows, then
-- delete only the exact claim's job in the same transaction. The existing
-- credit trigger is INSERT-only: this function does not insert an earning.
-- WHEN OTHERS excludes query_canceled and assertion_failure in PostgreSQL;
-- cancellation rolls this transaction back while the prior claim stays due
-- later, so another key can be claimed on the next invocation.
CREATE FUNCTION cinatoken_gateway.finish_claimed_shared_key_usage_repair(
  key_id text, expected_claim_token uuid)
RETURNS TABLE(shared_key_id text, outcome text, attempt_count integer, retry_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $finish$
DECLARE
  recorded_request_log text;
  admitted_attempt integer;
  failed_sqlstate text;
  changed_rows integer;
  failed_at timestamptz;
BEGIN
  IF SESSION_USER NOT IN ('cinatoken_gateway_migrator',
      'cinatoken_gateway_shared_key_usage_repair_consumer')
    OR pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR key_id IS NULL OR expected_claim_token IS NULL THEN
    RAISE EXCEPTION 'Shared-key usage repair caller or claim differs';
  END IF;
  PERFORM 1 FROM cinatoken_gateway.shared_keys AS sk
    WHERE sk.id = key_id FOR UPDATE;
  recorded_request_log := NULL;
  SELECT job.request_log_id, job.attempt_count
    INTO recorded_request_log, admitted_attempt
    FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
    WHERE job.shared_key_id = key_id AND job.claim_token = expected_claim_token
      AND job.claim_expires_at > pg_catalog.clock_timestamp()
    FOR UPDATE;
  IF recorded_request_log IS NULL THEN
    RETURN QUERY SELECT key_id, 'stale'::text, 0::integer, NULL::timestamptz;
    RETURN;
  END IF;
  failed_sqlstate := NULL;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.shared_key_earnings e
        WHERE e.request_log_id = recorded_request_log AND e.shared_key_id = key_id) THEN
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
      WHERE e.shared_key_id = key_id
    ) AS totals
    WHERE sk.id = key_id;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'PZ002',
        MESSAGE = 'Shared-key usage repair update differs';
    END IF;
    DELETE FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
      WHERE job.shared_key_id = key_id AND job.claim_token = expected_claim_token
        AND job.attempt_count = admitted_attempt;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'PZ003',
        MESSAGE = 'Shared-key usage repair acknowledgement differs';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS failed_sqlstate = RETURNED_SQLSTATE;
  END;
  IF failed_sqlstate IS NULL THEN
    RETURN QUERY SELECT key_id, 'repaired'::text, admitted_attempt, NULL::timestamptz;
    RETURN;
  END IF;
  failed_at := pg_catalog.clock_timestamp();
  UPDATE cinatoken_gateway.shared_key_usage_repair_jobs AS job
  SET claim_token = NULL, claim_expires_at = NULL,
      last_failed_at = failed_at, last_sqlstate = failed_sqlstate,
      dead_lettered_at = CASE WHEN admitted_attempt = 5 THEN failed_at ELSE NULL END
  WHERE job.shared_key_id = key_id AND job.claim_token = expected_claim_token
    AND job.attempt_count = admitted_attempt;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Shared-key usage repair failure acknowledgement differs';
  END IF;
  RETURN QUERY SELECT key_id,
    CASE WHEN admitted_attempt = 5 THEN 'dead_lettered' ELSE 'deferred' END::text,
    admitted_attempt, job.retry_after
    FROM cinatoken_gateway.shared_key_usage_repair_jobs AS job
    WHERE job.shared_key_id = key_id;
END;
$finish$;
REVOKE ALL ON FUNCTION cinatoken_gateway.finish_claimed_shared_key_usage_repair(text, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.finish_claimed_shared_key_usage_repair(text, uuid)
  FROM cinatoken_gateway_runtime;

-- A fifth claim is dead-lettered at admission, even if the client disappears.
-- Manual recovery may not revoke a still-live claim. Replacing the old
-- migrator-only function preserves the full-precision failure token contract.
CREATE OR REPLACE FUNCTION cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(
  key_id text, expected_failure_token text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $requeue_v3$
DECLARE changed_rows integer;
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator' OR SESSION_USER <> CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.shared_key_usage_repair_requeue_activation', true)
      IS DISTINCT FROM 'reviewed-v3' OR key_id IS NULL
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
      claim_token = NULL, claim_expires_at = NULL,
      available_at = pg_catalog.clock_timestamp()
  WHERE job.shared_key_id = key_id AND job.dead_lettered_at IS NOT NULL
    AND (job.claim_token IS NULL OR job.claim_expires_at <= pg_catalog.clock_timestamp())
    AND pg_catalog.md5(pg_catalog.to_char(job.last_failed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD HH24:MI:SS.US')) = expected_failure_token;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN RAISE EXCEPTION 'Shared-key usage repair dead letter changed'; END IF;
  RETURN true;
END;
$requeue_v3$;
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
        'cinatoken_gateway.claim_one_shared_key_usage_repair()'::pg_catalog.regprocedure,
        'cinatoken_gateway.finish_claimed_shared_key_usage_repair(text,uuid)'::pg_catalog.regprocedure,
        'cinatoken_gateway.requeue_shared_key_usage_repair_dead_letter(text,text)'::pg_catalog.regprocedure)
        AND acl.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
      WHERE c.oid = 'cinatoken_gateway.shared_key_usage_repair_jobs'::pg_catalog.regclass
        AND acl.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'Shared-key usage repair durable-claim ACL differs';
  END IF;
END;
$acl$;
