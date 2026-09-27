-- REVIEW-ONLY C03.5 proposal. Deliberately outside migrations-postgres.
-- Replace only the 0070 fact-to-outbox enqueue function. A future fact
-- producer can then INSERT a fact without direct INSERT on the outbox.
-- This does not create/grant/activate a producer role or connect an origin.
-- Execute as cinatoken_gateway_migrator in one explicit transaction after
-- separate review, first setting LOCAL
-- cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
DO $activation$
BEGIN
  IF pg_catalog.current_setting('cinatoken.settlement_outbox_definer_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit settlement outbox definer activation assertion is missing';
  END IF;
END;
$activation$;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.request_usage_settlements,
  cinatoken_gateway.request_usage_settlement_outbox IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE producer_oid oid;
DECLARE expected_trigger record;
DECLARE fact_identity_cols smallint[];
DECLARE outbox_identity_cols smallint[];
BEGIN
  IF pg_catalog.current_setting('cinatoken.settlement_outbox_definer_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit settlement outbox definer activation assertion is missing';
  END IF;
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  IF migrator_oid IS NULL OR runtime_oid IS NULL
    OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid) THEN
    RAISE EXCEPTION 'Settlement outbox definer requires the gateway migrator and runtime roles';
  END IF;
  IF pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
    OR (producer_oid IS NOT NULL AND (
      pg_catalog.pg_has_role(producer_oid, migrator_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(producer_oid, runtime_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(runtime_oid, producer_oid, 'MEMBER'))) THEN
    RAISE EXCEPTION 'Settlement outbox definer role membership contract differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Formal recovery migration 0073 is required';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
      ('request_usage_settlements'), ('request_usage_settlement_outbox')
    ) AS expected(name)
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'cinatoken_gateway'
    LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = expected.name
    WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> migrator_oid
      OR c.relrowsecurity OR c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'Settlement fact or outbox relation contract differs';
  END IF;
  SELECT ARRAY(SELECT a.attnum FROM (VALUES
      (1, 'request_id'), (2, 'payload_sha256'), (3, 'created_at_ms')
    ) AS expected(position, name)
    JOIN pg_catalog.pg_attribute a ON a.attrelid =
      'cinatoken_gateway.request_usage_settlements'::pg_catalog.regclass
      AND a.attname = expected.name AND NOT a.attisdropped
    ORDER BY expected.position) INTO fact_identity_cols;
  SELECT ARRAY(SELECT a.attnum FROM (VALUES
      (1, 'request_id'), (2, 'payload_sha256'), (3, 'created_at_ms')
    ) AS expected(position, name)
    JOIN pg_catalog.pg_attribute a ON a.attrelid =
      'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass
      AND a.attname = expected.name AND NOT a.attisdropped
    ORDER BY expected.position) INTO outbox_identity_cols;
  IF pg_catalog.cardinality(fact_identity_cols) <> 3
    OR pg_catalog.cardinality(outbox_identity_cols) <> 3 THEN
    RAISE EXCEPTION 'Settlement fact or outbox identity columns differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conname = 'request_usage_settlements_require_outbox'
        AND c.conrelid = 'cinatoken_gateway.request_usage_settlements'::pg_catalog.regclass
        AND c.confrelid = 'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass
        AND c.contype = 'f' AND c.condeferrable AND c.condeferred AND c.convalidated
        AND c.conkey = fact_identity_cols AND c.confkey = outbox_identity_cols
        AND c.confupdtype = 'a' AND c.confdeltype = 'a' AND c.confmatchtype = 's')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conname = 'request_usage_settlement_outbox_fact'
        AND c.conrelid = 'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass
        AND c.confrelid = 'cinatoken_gateway.request_usage_settlements'::pg_catalog.regclass
        AND c.contype = 'f' AND NOT c.condeferrable AND NOT c.condeferred
        AND c.convalidated AND c.conkey = outbox_identity_cols
        AND c.confkey = fact_identity_cols AND c.confupdtype = 'a'
        AND c.confdeltype = 'a' AND c.confmatchtype = 's') THEN
    RAISE EXCEPTION 'Settlement fact and outbox reciprocal FK contract differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'cinatoken_gateway.request_usage_settlements'::pg_catalog.regclass
        AND t.tgname = 'request_usage_settlements_enqueue'
        AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 5
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgfoid = pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_usage_settlement_fact()')
        AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr) = 0
        AND t.tgnargs = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND t.tgconstraint = 0) THEN
    RAISE EXCEPTION 'Settlement outbox enqueue trigger binding differs';
  END IF;
  FOR expected_trigger IN SELECT * FROM (VALUES
      ('request_usage_settlements', 'request_usage_settlements_guard',
        'guard_usage_settlement_fact()', 7),
      ('request_usage_settlements', 'request_usage_settlements_immutable',
        'reject_usage_settlement_mutation()', 27),
      ('request_usage_settlement_outbox', 'request_usage_settlement_outbox_immutable',
        'reject_usage_settlement_mutation()', 27)
    ) AS expected(table_name, trigger_name, function_name, trigger_type) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = ('cinatoken_gateway.' || expected_trigger.table_name)::pg_catalog.regclass
          AND t.tgname = expected_trigger.trigger_name
          AND NOT t.tgisinternal AND t.tgenabled = 'O'
          AND t.tgtype = expected_trigger.trigger_type::smallint
          AND t.tgfoid = pg_catalog.to_regprocedure(
            'cinatoken_gateway.' || expected_trigger.function_name)
          AND NOT t.tgdeferrable AND NOT t.tginitdeferred
          AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr) = 0
          AND t.tgnargs = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
          AND t.tgconstraint = 0) THEN
      RAISE EXCEPTION 'Settlement fact or outbox guard/immutable trigger differs: %',
        expected_trigger.trigger_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      WHERE p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_usage_settlement_fact()')
        AND p.proowner = migrator_oid AND language.lanname = 'plpgsql'
        AND p.prokind = 'f' AND NOT p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proretset AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        -- Hash the normalized 0070 body before replacing it in place.
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
          = '3f557218415026228ddc9114c65932ee') THEN
    RAISE EXCEPTION 'Settlement outbox enqueue source contract differs';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
      ('guard_usage_settlement_fact()', '9d8f96bee684f2a573bfb9012341d416'),
      ('reject_usage_settlement_mutation()', 'b4c0850d546798c45f888713b54bd40f')
    ) AS expected(function_name, source_md5)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(
      'cinatoken_gateway.' || expected.function_name)
    LEFT JOIN pg_catalog.pg_language language ON language.oid = p.prolang
    WHERE p.oid IS NULL OR p.proowner <> migrator_oid OR language.lanname <> 'plpgsql'
      OR p.prokind <> 'f' OR p.prosecdef OR p.provolatile <> 'v'
      OR p.proretset OR p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
        IS DISTINCT FROM expected.source_md5) THEN
    RAISE EXCEPTION 'Settlement fact guard or immutable function source contract differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) acl
      WHERE p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_usage_settlement_fact()')
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> 0 AND acl.grantee <> migrator_oid
        AND acl.grantee <> runtime_oid
        AND (producer_oid IS NULL OR acl.grantee <> producer_oid)) THEN
    RAISE EXCEPTION 'Settlement outbox enqueue has an unknown EXECUTE grantee';
  END IF;
  IF pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass,
      'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass,
      'INSERT, UPDATE')
    OR (producer_oid IS NOT NULL AND (
      pg_catalog.has_table_privilege(producer_oid,
      'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass,
      'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
      OR pg_catalog.has_any_column_privilege(producer_oid,
      'cinatoken_gateway.request_usage_settlement_outbox'::pg_catalog.regclass,
      'INSERT, UPDATE'))) THEN
    RAISE EXCEPTION 'Settlement outbox runtime or producer has effective outbox write privilege';
  END IF;
END;
$preflight$;

-- CREATE OR REPLACE keeps the trigger's OID and binding. The relation/event
-- check runs before touching NEW or writing outbox, so a misgranted EXECUTE
-- cannot turn a caller-owned temporary trigger into an outbox writer.
CREATE OR REPLACE FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $enqueue$
BEGIN
  IF TG_RELID <> 'cinatoken_gateway.request_usage_settlements'::pg_catalog.regclass
    OR TG_NAME <> 'request_usage_settlements_enqueue'
    OR TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' OR TG_OP <> 'INSERT'
    OR TG_NARGS <> 0 THEN
    RAISE EXCEPTION 'Settlement outbox enqueue relation or event mismatch';
  END IF;
  INSERT INTO cinatoken_gateway.request_usage_settlement_outbox(request_id, payload_sha256, created_at_ms)
    VALUES (NEW.request_id, NEW.payload_sha256, NEW.created_at_ms);
  RETURN NEW;
END;
$enqueue$;

REVOKE ALL ON FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact()
  FROM cinatoken_gateway_runtime;
DO $revoke_optional_producer$
DECLARE producer_oid oid;
DECLARE enqueue_oid oid;
BEGIN
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  IF producer_oid IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION cinatoken_gateway.enqueue_usage_settlement_fact()
      FROM cinatoken_gateway_fact_producer';
  END IF;
  enqueue_oid := pg_catalog.to_regprocedure('cinatoken_gateway.enqueue_usage_settlement_fact()');
  IF pg_catalog.has_function_privilege('cinatoken_gateway_runtime', enqueue_oid, 'EXECUTE')
    OR (producer_oid IS NOT NULL
      AND pg_catalog.has_function_privilege(producer_oid, enqueue_oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'Settlement outbox definer effective EXECUTE privilege remains';
  END IF;
END;
$revoke_optional_producer$;

-- This proposal is not deployable until broad runtime grant reruns also
-- re-revoke this definer, and the producer origin and role are specified and
-- verified on native PostgreSQL. Do not grant direct outbox INSERT.
