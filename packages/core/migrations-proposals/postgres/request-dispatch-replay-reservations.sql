-- REVIEW ONLY. Expand step for a permanent request-ID replay reservation.
-- Apply as cinatoken_gateway_migrator in one explicit transaction after 0073,
-- with SET LOCAL cinatoken.request_dispatch_replay_reservations_activation = 'reviewed-v1'.
-- This file does not grant application access, install a retention policy, or
-- delete/archive history. Run bounded backfill separately, then activate the
-- parent gate in request-dispatch-replay-parent-gate.sql. Until that gate is
-- active, PostgreSQL Images recovery must stay disabled.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF pg_catalog.current_setting('cinatoken.request_dispatch_replay_reservations_activation', true)
       IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator' OR migrator_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND relowner = migrator_oid AND relkind = 'r'
        AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_replay_tombstones') IS NOT NULL THEN
    RAISE EXCEPTION 'Replay reservation activation, migration or owner contract differs';
  END IF;
END;
$preflight$;

SELECT pg_catalog.pg_advisory_xact_lock(746923557);
-- CREATE TRIGGER obtains SHARE ROW EXCLUSIVE. A contested old writer fails
-- promptly; no backfill scan holds this lock for the lifetime of all history.
CREATE TABLE cinatoken_gateway.request_dispatch_replay_tombstones (
  request_id text PRIMARY KEY,
  first_source text NOT NULL CHECK (first_source IN
    ('parent','intent','fact','outbox','job','receipt','legacy_log')),
  reserved_at_ms bigint NOT NULL DEFAULT
    (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint)
    CHECK (reserved_at_ms BETWEEN 0 AND 9007199254740991)
);

-- A later broad runtime grant must not let the runtime fabricate reservations.
-- Trigger writers above and the bounded migrator backfill execute as migrator;
-- an ordinary direct INSERT keeps its own current_user and fails closed.
CREATE FUNCTION cinatoken_gateway.guard_request_dispatch_replay_insert()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP <> 'INSERT' OR TG_NAME <> 'request_dispatch_replay_tombstones_insert_guard'
    OR TG_RELID <> 'cinatoken_gateway.request_dispatch_replay_tombstones'::pg_catalog.regclass
    OR CURRENT_USER <> 'cinatoken_gateway_migrator' THEN
    RAISE EXCEPTION 'Replay reservation direct writer is not the migrator';
  END IF;
  NEW.reserved_at_ms := pg_catalog.floor(
    extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER request_dispatch_replay_tombstones_insert_guard
  BEFORE INSERT ON cinatoken_gateway.request_dispatch_replay_tombstones
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.guard_request_dispatch_replay_insert();

CREATE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Request-ID replay reservation and source history cannot be deleted or rewritten';
END;
$reject$;
CREATE TRIGGER request_dispatch_replay_tombstones_immutable
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.request_dispatch_replay_tombstones
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation();
CREATE TRIGGER request_dispatch_replay_tombstones_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.request_dispatch_replay_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation();

-- Every newly inserted legacy intent reserves its ID in the same transaction.
-- A second attempt may use an ID with an extant intent or parent; a reservation
-- without either is a tombstone and may never become a fresh request.
CREATE FUNCTION cinatoken_gateway.reserve_request_dispatch_intent_id()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reserve$
DECLARE inserted_id text;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_NAME <> 'request_dispatch_intents_replay_reserve'
    OR TG_RELID <> 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'Replay intent trigger binding differs';
  END IF;
  INSERT INTO cinatoken_gateway.request_dispatch_replay_tombstones(request_id, first_source)
    VALUES (NEW.request_id, 'intent')
    ON CONFLICT (request_id) DO NOTHING RETURNING request_id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM cinatoken_gateway.request_dispatch_intents
    WHERE request_id = NEW.request_id LIMIT 1 FOR KEY SHARE;
  IF FOUND THEN RETURN NEW; END IF;
  IF pg_catalog.to_regclass('cinatoken_gateway.request_dispatch_requests') IS NOT NULL THEN
    PERFORM 1 FROM cinatoken_gateway.request_dispatch_requests
      WHERE request_id = NEW.request_id FOR KEY SHARE;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Request ID is permanently reserved';
END;
$reserve$;
CREATE TRIGGER request_dispatch_intents_replay_reserve
  BEFORE INSERT ON cinatoken_gateway.request_dispatch_intents
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reserve_request_dispatch_intent_id();
CREATE TRIGGER request_dispatch_intents_replay_no_delete
  BEFORE DELETE ON cinatoken_gateway.request_dispatch_intents
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation();
CREATE TRIGGER request_dispatch_intents_replay_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.request_dispatch_intents
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation();

-- Legacy logs are an independent request-ID source. Their existing writer may
-- have INSERT on that table without reservation-table DML; this narrowly
-- pinned SECURITY DEFINER trigger makes the reservation in the same commit.
-- It continues running after parent gate activation, so a late low-sorting ID
-- cannot escape a completed keyset backfill or final census.
CREATE FUNCTION cinatoken_gateway.reserve_request_log_replay_id()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reserve$
DECLARE inserted_id text;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_NAME <> 'api_key_request_logs_replay_reserve'
    OR TG_RELID <> 'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'Replay log trigger binding differs';
  END IF;
  INSERT INTO cinatoken_gateway.request_dispatch_replay_tombstones(request_id, first_source)
    VALUES (NEW.id, 'legacy_log')
    ON CONFLICT (request_id) DO NOTHING RETURNING request_id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM cinatoken_gateway.api_key_request_logs
    WHERE id = NEW.id FOR KEY SHARE;
  IF FOUND THEN RETURN NEW; END IF;
  -- A recovery financial log is written after its receipt in the same
  -- transaction. The receipt FK to this log is deferred, so it is visible here
  -- before COMMIT. A mere parent/claim does not authorize a financial log.
  PERFORM 1 FROM cinatoken_gateway.request_usage_commit_receipts r
    JOIN cinatoken_gateway.request_usage_settlements f
      ON f.request_id = r.request_id AND f.payload_sha256 = r.payload_sha256
        AND f.created_at_ms = r.fact_created_at_ms
    WHERE r.request_id = NEW.id
      AND r.user_id = NEW.user_id AND r.workspace_id = NEW.workspace_id
      AND f.api_key_id = NEW.api_key_id AND f.operation = NEW.request_operation
    FOR KEY SHARE OF r;
  IF FOUND THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Request log ID is permanently reserved or financial scope differs';
END;
$reserve$;
CREATE TRIGGER api_key_request_logs_replay_reserve
  BEFORE INSERT ON cinatoken_gateway.api_key_request_logs
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reserve_request_log_replay_id();

-- Formal 0001 leaves log IDs as unconstrained TEXT. An UPDATE that changes id
-- after the final census would create a historical key without a reservation.
-- Keep ordinary updates compatible while refusing a primary-key rewrite.
CREATE FUNCTION cinatoken_gateway.guard_request_log_replay_id_update()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP <> 'UPDATE' OR TG_NAME <> 'api_key_request_logs_replay_id_immutable'
    OR TG_RELID <> 'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass THEN
    RAISE EXCEPTION 'Replay log ID update trigger binding differs';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Request log ID cannot be rewritten after replay reservation';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER api_key_request_logs_replay_id_immutable
  BEFORE UPDATE OF id ON cinatoken_gateway.api_key_request_logs
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.guard_request_log_replay_id_update();

REVOKE ALL ON TABLE cinatoken_gateway.request_dispatch_replay_tombstones FROM PUBLIC;
-- Normal runtime provisioning installs a schema-scoped SELECT default. Remove
-- only that known grant; unexpected nonowner defaults still abort below.
REVOKE ALL ON TABLE cinatoken_gateway.request_dispatch_replay_tombstones
  FROM cinatoken_gateway_runtime;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_dispatch_replay_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.reject_request_dispatch_replay_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.reserve_request_dispatch_intent_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.reserve_request_log_replay_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_log_replay_id_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_dispatch_replay_insert(),
  cinatoken_gateway.reject_request_dispatch_replay_mutation(),
  cinatoken_gateway.reserve_request_dispatch_intent_id(),
  cinatoken_gateway.reserve_request_log_replay_id(),
  cinatoken_gateway.guard_request_log_replay_id_update()
  FROM cinatoken_gateway_runtime;
DO $acl$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO STRICT migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid IN (
        'cinatoken_gateway.reserve_request_dispatch_intent_id()'::pg_catalog.regprocedure,
        'cinatoken_gateway.reserve_request_log_replay_id()'::pg_catalog.regprocedure,
        'cinatoken_gateway.guard_request_log_replay_id_update()'::pg_catalog.regprocedure)
        AND p.proowner = migrator_oid AND p.prosecdef AND p.provolatile = 'v'
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
      GROUP BY p.proowner HAVING count(*) = 2)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
        pg_catalog.acldefault('r', c.relowner))) a
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_replay_tombstones'::pg_catalog.regclass
        AND a.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) a
      WHERE p.oid IN (
        'cinatoken_gateway.guard_request_dispatch_replay_insert()'::pg_catalog.regprocedure,
        'cinatoken_gateway.reject_request_dispatch_replay_mutation()'::pg_catalog.regprocedure,
        'cinatoken_gateway.reserve_request_dispatch_intent_id()'::pg_catalog.regprocedure,
        'cinatoken_gateway.reserve_request_log_replay_id()'::pg_catalog.regprocedure,
        'cinatoken_gateway.guard_request_log_replay_id_update()'::pg_catalog.regprocedure)
        AND a.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'Replay reservation default ACL exposes a nonowner';
  END IF;
END;
$acl$;
