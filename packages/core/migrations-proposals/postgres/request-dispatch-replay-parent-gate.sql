-- REVIEW ONLY. Switch step after reservation installation and bounded
-- backfill. Apply as cinatoken_gateway_migrator in one explicit transaction
-- with SET LOCAL cinatoken.request_dispatch_replay_parent_gate_activation = 'reviewed-v1'.
-- A full anti-join under short write-blocking locks detects missed rows from
-- cursor races or pre-install history. Failure rolls back every trigger.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
-- This also blocks ordinary legacy-log writers during the final census.
-- On a large live table the 15s statement ceiling must fail closed; this is
-- not evidence that a production maintenance window or lock budget exists.
LOCK TABLE cinatoken_gateway.request_dispatch_requests,
  cinatoken_gateway.request_dispatch_intents,
  cinatoken_gateway.request_usage_settlements,
  cinatoken_gateway.request_usage_settlement_outbox,
  cinatoken_gateway.request_usage_recovery_jobs,
  cinatoken_gateway.request_usage_commit_receipts,
  cinatoken_gateway.api_key_request_logs IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF pg_catalog.current_setting('cinatoken.request_dispatch_replay_parent_gate_activation', true)
       IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator' OR migrator_oid IS NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_replay_tombstones') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND tgname = 'request_dispatch_intents_replay_reserve' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND tgname = 'api_key_request_logs_replay_reserve' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_attribute a ON a.attrelid=t.tgrelid
        AND a.attname='id' AND NOT a.attisdropped
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid = 'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname = 'api_key_request_logs_replay_id_immutable'
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgtype = 19
        AND t.tgattr::text = a.attnum::text AND t.tgqual IS NULL
        AND t.tgnargs = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND p.oid = 'cinatoken_gateway.guard_request_log_replay_id_update()'::pg_catalog.regprocedure
        AND p.proowner = migrator_oid AND NOT p.prosecdef AND p.provolatile = 'v'
        AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) a
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND a.grantee <> migrator_oid
        AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) a
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_replay_tombstones'::pg_catalog.regclass
        AND a.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_requests p
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = p.request_id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_intents i
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = i.request_id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_settlements f
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = f.request_id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_settlement_outbox o
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = o.request_id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_recovery_jobs j
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = j.request_id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.request_usage_commit_receipts c
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = c.request_id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.api_key_request_logs l
      WHERE NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones r
        WHERE r.request_id = l.id)) THEN
    RAISE EXCEPTION 'Replay reservation backfill or parent gate contract incomplete';
  END IF;
END;
$preflight$;

-- The expand trigger allowed new legacy orphan attempts while old traffic was
-- still active. Switching parent admission must also stop fresh orphan child
-- inserts: only a live parent may receive another attempt after this point.
CREATE OR REPLACE FUNCTION cinatoken_gateway.reserve_request_dispatch_intent_id()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reserve$
BEGIN
  IF TG_OP <> 'INSERT' OR TG_NAME <> 'request_dispatch_intents_replay_reserve'
    OR TG_RELID <> 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'Replay intent trigger binding differs';
  END IF;
  PERFORM 1 FROM cinatoken_gateway.request_dispatch_requests
    WHERE request_id = NEW.request_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent requires a live request parent'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.request_dispatch_replay_tombstones
      WHERE request_id = NEW.request_id) THEN
    RAISE EXCEPTION 'Dispatch intent request ID has no replay reservation';
  END IF;
  RETURN NEW;
END;
$reserve$;

-- INSERT ... ON CONFLICT DO NOTHING still runs this BEFORE INSERT trigger.
-- The existing-parent branch takes a key-share lock. It cannot race an
-- archival DELETE into accepting a newly freed ID, even at READ COMMITTED.
CREATE FUNCTION cinatoken_gateway.reserve_request_dispatch_parent_id()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $reserve$
DECLARE inserted_id text;
BEGIN
  INSERT INTO cinatoken_gateway.request_dispatch_replay_tombstones(request_id, first_source)
    VALUES (NEW.request_id, 'parent')
    ON CONFLICT (request_id) DO NOTHING RETURNING request_id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM cinatoken_gateway.request_dispatch_requests
    WHERE request_id = NEW.request_id FOR KEY SHARE;
  IF FOUND THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Request ID is permanently reserved';
END;
$reserve$;
CREATE TRIGGER request_dispatch_requests_replay_reserve
  BEFORE INSERT ON cinatoken_gateway.request_dispatch_requests
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reserve_request_dispatch_parent_id();
CREATE TRIGGER request_dispatch_requests_replay_no_delete
  BEFORE DELETE ON cinatoken_gateway.request_dispatch_requests
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation();
CREATE TRIGGER request_dispatch_requests_replay_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.request_dispatch_requests
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation();
REVOKE ALL ON FUNCTION cinatoken_gateway.reserve_request_dispatch_parent_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.reserve_request_dispatch_parent_id()
  FROM cinatoken_gateway_runtime;

DO $acl$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO STRICT migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) a
      WHERE p.oid = 'cinatoken_gateway.reserve_request_dispatch_parent_id()'::pg_catalog.regprocedure
        AND a.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'Replay parent trigger default ACL exposes a nonowner';
  END IF;
END;
$acl$;
