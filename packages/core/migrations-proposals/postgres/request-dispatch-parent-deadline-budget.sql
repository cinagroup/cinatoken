-- REVIEW ONLY, outside migrations-postgres and every production factory.
-- This V1 request parent freezes the first accepted scope, canonical request
-- digest, database creation instant, original deadline and TOTAL number of
-- prepared attempts. Child context_sha256 is route-specific and may vary. It also
-- allows at most one committed dispatch claim, including outcome_unknown.
-- No producer or runtime grant is installed here. A future writer must use
-- only the functions below, wait for transaction COMMIT acknowledgement, and
-- have no direct INSERT/UPDATE/DELETE/TRUNCATE privilege on either table.
-- The current TypeScript repository uses attempt-first locks and direct DML;
-- it is deliberately incompatible until separately changed and tested.
--
-- Apply as cinatoken_gateway_migrator in ONE explicit transaction after the
-- reviewed claim-time authorization and single-claim index proposals, with:
--   SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1';
-- Existing intent rows have no trustworthy original request budget, so this
-- proposal rejects them instead of inventing a backfill or deleting evidence.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $activation$
BEGIN
  IF pg_catalog.current_setting('cinatoken.request_dispatch_parent_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit request dispatch parent activation assertion is missing';
  END IF;
END;
$activation$;

SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
LOCK TABLE cinatoken_gateway.request_dispatch_intents IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE producer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  IF pg_catalog.current_setting('cinatoken.request_dispatch_parent_activation', true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND relkind = 'r' AND relowner = migrator_oid
        AND NOT relrowsecurity AND NOT relforcerowsecurity) THEN
    RAISE EXCEPTION 'Request dispatch parent migrator or relation contract differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Formal recovery migration 0073 is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND t.tgname = 'request_dispatch_intents_guard' AND t.tgenabled = 'O'
        AND NOT t.tgisinternal AND t.tgtype = 23
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr) = 0
        AND t.tgnargs = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.guard_request_dispatch_intent()')
        AND p.proowner = migrator_oid AND p.prosecdef AND p.provolatile = 'v'
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
          = '5279c6d9241666ec76e612614640fb7b') THEN
    RAISE EXCEPTION 'Request dispatch parent needs reviewed claim authorization';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
      WHERE i.indexrelid = pg_catalog.to_regclass(
        'cinatoken_gateway.request_dispatch_intents_one_claim_per_request')
        AND i.indrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND i.indisunique AND i.indisvalid AND i.indislive
        AND i.indnkeyatts = 1 AND i.indexprs IS NULL
        AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(dispatch_claim_id IS NOT NULL)'
        AND i.indkey[0] = (SELECT attnum FROM pg_catalog.pg_attribute
          WHERE attrelid = i.indrelid AND attname = 'request_id')) THEN
    RAISE EXCEPTION 'Request dispatch single-claim index contract differs';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_intents) THEN
    RAISE EXCEPTION 'Existing dispatch intents need separately reviewed request backfill';
  END IF;
  -- A future producer receives EXECUTE only after identity, capacity and
  -- admission review. Direct DML grants would bypass the parent lock order.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) acl
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND acl.grantee <> migrator_oid
        AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) THEN
    RAISE EXCEPTION 'Direct dispatch intent writer privilege remains';
  END IF;
  IF runtime_oid IS NULL
    OR pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
      'INSERT, UPDATE, DELETE, TRUNCATE')
    OR (producer_oid IS NOT NULL AND (
      pg_catalog.pg_has_role(producer_oid, migrator_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(producer_oid, runtime_oid, 'MEMBER')
      OR pg_catalog.has_table_privilege(producer_oid,
        'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
        'INSERT, UPDATE, DELETE, TRUNCATE'))) THEN
    RAISE EXCEPTION 'Known dispatch producer or runtime can bypass parent gate';
  END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.request_dispatch_requests (
  request_id text PRIMARY KEY
    CHECK (request_id COLLATE "C" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  user_id text NOT NULL REFERENCES cinatoken_gateway.users(id) ON DELETE RESTRICT,
  api_key_id text NOT NULL REFERENCES cinatoken_gateway.api_keys(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES cinatoken_gateway.workspaces(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('images.generations', 'images.edits')),
  request_sha256 text NOT NULL CHECK (request_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  original_created_at_ms bigint NOT NULL
    CHECK (original_created_at_ms BETWEEN 0 AND 9007199254740991),
  expires_at_ms bigint NOT NULL
    CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  prepared_count integer NOT NULL DEFAULT 0 CHECK (prepared_count BETWEEN 0 AND 3),
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 1),
  first_claim_id text UNIQUE
    CHECK (first_claim_id COLLATE "C" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CHECK (expires_at_ms > original_created_at_ms),
  CHECK (prepared_count <= max_attempts),
  CHECK (claim_count <= prepared_count),
  CHECK ((claim_count = 0 AND first_claim_id IS NULL)
    OR (claim_count = 1 AND first_claim_id IS NOT NULL))
);
CREATE INDEX request_dispatch_requests_user ON cinatoken_gateway.request_dispatch_requests(user_id);
CREATE INDEX request_dispatch_requests_api_key ON cinatoken_gateway.request_dispatch_requests(api_key_id);
CREATE INDEX request_dispatch_requests_workspace ON cinatoken_gateway.request_dispatch_requests(workspace_id);

-- One statement, or an explicit caller transaction, must own the whole result.
-- Return true only for a newly prepared attempt; false means exact duplicate.
CREATE FUNCTION cinatoken_gateway.prepare_request_dispatch_intent_v1(
  p_request_id text, p_attempt_index integer, p_user_id text, p_api_key_id text,
  p_workspace_id text, p_operation text, p_request_sha256 text, p_context_sha256 text,
  p_expires_at_ms bigint, p_max_attempts integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $prepare$
DECLARE parent cinatoken_gateway.request_dispatch_requests%ROWTYPE;
DECLARE existing cinatoken_gateway.request_dispatch_intents%ROWTYPE;
DECLARE inserted_id text;
DECLARE checked_at_ms bigint;
BEGIN
  -- The first insert is the serialization point for a previously unseen id.
  -- The zero timestamp is invisible before commit and replaced AFTER any wait.
  INSERT INTO cinatoken_gateway.request_dispatch_requests
    (request_id,user_id,api_key_id,workspace_id,operation,request_sha256,
     original_created_at_ms,expires_at_ms,max_attempts)
  VALUES (p_request_id,p_user_id,p_api_key_id,p_workspace_id,p_operation,
    p_request_sha256,0,p_expires_at_ms,p_max_attempts)
  ON CONFLICT (request_id) DO NOTHING RETURNING request_id INTO inserted_id;

  SELECT * INTO STRICT parent FROM cinatoken_gateway.request_dispatch_requests
    WHERE request_id = p_request_id FOR UPDATE;
  checked_at_ms := pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
  IF parent.user_id IS DISTINCT FROM p_user_id
    OR parent.api_key_id IS DISTINCT FROM p_api_key_id
    OR parent.workspace_id IS DISTINCT FROM p_workspace_id
    OR parent.operation IS DISTINCT FROM p_operation
    OR parent.request_sha256 IS DISTINCT FROM p_request_sha256
    OR parent.max_attempts IS DISTINCT FROM p_max_attempts
    OR p_attempt_index NOT BETWEEN 1 AND parent.max_attempts
    OR p_expires_at_ms > parent.expires_at_ms THEN
    RAISE EXCEPTION 'Dispatch request frozen scope, deadline or attempt budget differs';
  END IF;
  IF checked_at_ms >= parent.expires_at_ms
    OR checked_at_ms >= p_expires_at_ms THEN
    RAISE EXCEPTION 'Dispatch request deadline elapsed';
  END IF;
  -- Images V1 has at most three attempts and a five-minute total deadline.
  -- The subtraction avoids overflow if a database clock is malformed.
  IF parent.max_attempts > 3
    OR checked_at_ms > 9007199254740991 - 300000
    OR (inserted_id IS NOT NULL AND parent.expires_at_ms > checked_at_ms + 300000) THEN
    RAISE EXCEPTION 'Dispatch request V1 attempt or time ceiling exceeded';
  END IF;
  IF inserted_id IS NOT NULL THEN
    UPDATE cinatoken_gateway.request_dispatch_requests
      SET original_created_at_ms = checked_at_ms
      WHERE request_id = p_request_id;
  END IF;

  -- Always lock the parent before an existing attempt, including duplicates.
  SELECT * INTO existing FROM cinatoken_gateway.request_dispatch_intents
    WHERE request_id = p_request_id AND attempt_index = p_attempt_index FOR UPDATE;
  IF FOUND THEN
    IF existing.user_id IS DISTINCT FROM p_user_id
      OR existing.api_key_id IS DISTINCT FROM p_api_key_id
      OR existing.workspace_id IS DISTINCT FROM p_workspace_id
      OR existing.operation IS DISTINCT FROM p_operation
      OR existing.context_sha256 IS DISTINCT FROM p_context_sha256
      OR existing.expires_at_ms IS DISTINCT FROM p_expires_at_ms THEN
      RAISE EXCEPTION 'Dispatch intent identity or deadline conflict';
    END IF;
    RETURN false;
  END IF;
  IF parent.prepared_count >= parent.max_attempts THEN
    RAISE EXCEPTION 'Dispatch request attempt budget exhausted';
  END IF;
  -- The existing INSERT guard checks Key association and sets attempt time.
  -- A failure rolls back both the parent creation and the counter change.
  INSERT INTO cinatoken_gateway.request_dispatch_intents
    (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,
     context_sha256,expires_at_ms)
  VALUES (p_request_id,p_attempt_index,p_user_id,p_api_key_id,p_workspace_id,
    p_operation,p_context_sha256,p_expires_at_ms);
  UPDATE cinatoken_gateway.request_dispatch_requests
    SET prepared_count = prepared_count + 1 WHERE request_id = p_request_id;
  RETURN true;
END;
$prepare$;

-- A true function result is still not a send grant until transaction COMMIT is
-- acknowledged. Claim-time tenant authorization remains in the pinned guard.
CREATE FUNCTION cinatoken_gateway.claim_request_dispatch_intent_v1(
  p_request_id text, p_attempt_index integer, p_user_id text, p_api_key_id text,
  p_workspace_id text, p_operation text, p_request_sha256 text, p_context_sha256 text,
  p_expected_revision bigint, p_claim_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $claim$
DECLARE parent cinatoken_gateway.request_dispatch_requests%ROWTYPE;
DECLARE attempt cinatoken_gateway.request_dispatch_intents%ROWTYPE;
DECLARE checked_at_ms bigint;
DECLARE changed_id text;
BEGIN
  SELECT * INTO parent FROM cinatoken_gateway.request_dispatch_requests
    WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF parent.user_id IS DISTINCT FROM p_user_id
    OR parent.api_key_id IS DISTINCT FROM p_api_key_id
    OR parent.workspace_id IS DISTINCT FROM p_workspace_id
    OR parent.operation IS DISTINCT FROM p_operation
    OR parent.request_sha256 IS DISTINCT FROM p_request_sha256
    OR p_attempt_index NOT BETWEEN 1 AND parent.max_attempts THEN
    RAISE EXCEPTION 'Dispatch request frozen scope or attempt budget differs';
  END IF;
  IF parent.claim_count <> 0 THEN RETURN false; END IF;

  SELECT * INTO attempt FROM cinatoken_gateway.request_dispatch_intents
    WHERE request_id = p_request_id AND attempt_index = p_attempt_index FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  checked_at_ms := pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
  IF attempt.user_id IS DISTINCT FROM p_user_id
    OR attempt.api_key_id IS DISTINCT FROM p_api_key_id
    OR attempt.workspace_id IS DISTINCT FROM p_workspace_id
    OR attempt.operation IS DISTINCT FROM p_operation
    OR attempt.context_sha256 IS DISTINCT FROM p_context_sha256
    OR attempt.expires_at_ms > parent.expires_at_ms THEN
    RAISE EXCEPTION 'Dispatch attempt exceeds frozen request';
  END IF;
  IF attempt.state <> 'prepared' OR attempt.revision <> p_expected_revision
    OR checked_at_ms < attempt.updated_at_ms
    OR checked_at_ms >= parent.expires_at_ms
    OR checked_at_ms >= attempt.expires_at_ms THEN
    RETURN false;
  END IF;
  UPDATE cinatoken_gateway.request_dispatch_intents
    SET state='dispatch_claimed',revision=revision+1,dispatch_claim_id=p_claim_id
    WHERE request_id=p_request_id AND attempt_index=p_attempt_index
      AND revision=p_expected_revision AND state='prepared'
    RETURNING request_id INTO changed_id;
  IF changed_id IS NULL THEN RETURN false; END IF;
  UPDATE cinatoken_gateway.request_dispatch_requests
    SET claim_count=1,first_claim_id=p_claim_id WHERE request_id=p_request_id;
  RETURN true;
END;
$claim$;

-- Classification never frees the parent's claim slot. In particular an
-- outcome_unknown row remains a consumed dispatch grant forever in V1.
CREATE FUNCTION cinatoken_gateway.classify_request_dispatch_intent_v1(
  p_request_id text, p_attempt_index integer, p_user_id text, p_api_key_id text,
  p_workspace_id text, p_operation text, p_request_sha256 text, p_context_sha256 text,
  p_expected_revision bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $classify$
DECLARE parent cinatoken_gateway.request_dispatch_requests%ROWTYPE;
DECLARE attempt cinatoken_gateway.request_dispatch_intents%ROWTYPE;
DECLARE changed_id text;
BEGIN
  SELECT * INTO parent FROM cinatoken_gateway.request_dispatch_requests
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF parent.user_id IS DISTINCT FROM p_user_id
    OR parent.api_key_id IS DISTINCT FROM p_api_key_id
    OR parent.workspace_id IS DISTINCT FROM p_workspace_id
    OR parent.operation IS DISTINCT FROM p_operation
    OR parent.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
    RAISE EXCEPTION 'Dispatch request frozen scope differs';
  END IF;
  SELECT * INTO attempt FROM cinatoken_gateway.request_dispatch_intents
    WHERE request_id=p_request_id AND attempt_index=p_attempt_index FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF attempt.user_id IS DISTINCT FROM p_user_id
    OR attempt.api_key_id IS DISTINCT FROM p_api_key_id
    OR attempt.workspace_id IS DISTINCT FROM p_workspace_id
    OR attempt.operation IS DISTINCT FROM p_operation
    OR attempt.context_sha256 IS DISTINCT FROM p_context_sha256
    OR attempt.expires_at_ms > parent.expires_at_ms THEN
    RAISE EXCEPTION 'Dispatch attempt exceeds frozen request';
  END IF;
  UPDATE cinatoken_gateway.request_dispatch_intents
    SET state=CASE state WHEN 'prepared' THEN 'expired_before_dispatch'
      ELSE 'outcome_unknown' END,revision=revision+1
    WHERE request_id=p_request_id AND attempt_index=p_attempt_index
      AND revision=p_expected_revision
      AND state IN ('prepared','dispatch_claimed')
    RETURNING request_id INTO changed_id;
  RETURN changed_id IS NOT NULL;
END;
$classify$;

REVOKE ALL ON TABLE cinatoken_gateway.request_dispatch_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.prepare_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.claim_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.classify_request_dispatch_intent_v1(
  text,integer,text,text,text,text,text,text,bigint) FROM PUBLIC;

-- CREATE applies any migrator/schema ALTER DEFAULT PRIVILEGES. A REVOKE from
-- PUBLIC alone would leave an explicit role grant, including one inherited by
-- a future producer. Audit the just-created objects before this transaction
-- can commit; aborting here rolls back the table and all three functions.
DO $verify_new_object_acl$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO STRICT migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass
        AND c.relkind = 'r' AND c.relowner = migrator_oid
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'Request parent relation owner or RLS differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) acl
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass
        AND acl.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'New request parent table ACL exposes a nonowner';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
      WHERE p.oid IN (
        pg_catalog.to_regprocedure('cinatoken_gateway.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)'),
        pg_catalog.to_regprocedure('cinatoken_gateway.claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)'),
        pg_catalog.to_regprocedure('cinatoken_gateway.classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)'))
        AND p.proowner = migrator_oid AND p.prosecdef AND p.provolatile = 'v'
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]) <> 3 THEN
    RAISE EXCEPTION 'New request parent function owner or security mode differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) acl
      WHERE p.oid IN (
        pg_catalog.to_regprocedure('cinatoken_gateway.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)'),
        pg_catalog.to_regprocedure('cinatoken_gateway.claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)'),
        pg_catalog.to_regprocedure('cinatoken_gateway.classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)'))
        AND acl.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'New request parent function ACL exposes a nonowner';
  END IF;
  -- Superusers always bypass SQL ACLs. Other roles able to SET ROLE to the
  -- migrator could bypass the function-only route even without object grants.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles role
      WHERE role.oid <> migrator_oid AND NOT role.rolsuper
        AND pg_catalog.pg_has_role(role.oid, migrator_oid, 'MEMBER')) THEN
    RAISE EXCEPTION 'Nonowner migrator role membership can bypass parent gate';
  END IF;
END;
$verify_new_object_acl$;

-- No direct writer/EXECUTE grant, origin, Worker, Hyperdrive, D1 parity,
-- backfill, DELETE, retention or automatic activation is part of this file.
-- Later GRANT or role membership changes remain a separate privilege-drift
-- boundary; operator preflight must repeat this audit before runtime adoption.
