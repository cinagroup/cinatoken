-- REVIEW ONLY. Install after shared-key-quote-versions.sql, under the direct
-- cinatoken_gateway_migrator LOGIN, in a single transaction. A pre-provisioned
-- cinatoken_gateway_shared_quote_attempt_producer direct LOGIN calls one
-- SECURITY DEFINER function. Ordinary runtime and PUBLIC receive no access.
-- A row means the quote was captured before a possible network send; it is
-- explicitly NOT evidence that bytes reached an upstream or that usage exists.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $preflight$
DECLARE producer_oid oid;
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE protected_functions integer;
DECLARE protected_triggers integer;
BEGIN
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_shared_quote_attempt_producer';
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  IF pg_catalog.current_setting('cinatoken.shared_quote_attempt_activation', true)
       IS DISTINCT FROM 'reviewed-v1'
    OR SESSION_USER <> 'cinatoken_gateway_migrator'
    OR CURRENT_USER <> SESSION_USER
    OR producer_oid IS NULL OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid = producer_oid)
       IS DISTINCT FROM TRUE
    OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid = producer_oid)
       IS DISTINCT FROM FALSE
    OR pg_catalog.pg_has_role(producer_oid, migrator_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid, producer_oid, 'MEMBER')
    OR pg_catalog.pg_has_role(producer_oid, 'pg_read_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.pg_has_role(producer_oid, 'pg_write_all_data'::pg_catalog.regrole, 'MEMBER')
    OR pg_catalog.to_regnamespace('cinatoken_economic_quotes') IS NULL
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname = 'cinatoken_economic_quotes') IS DISTINCT FROM migrator_oid
    OR pg_catalog.to_regclass('cinatoken_economic_quotes.shared_key_quote_versions') IS NULL
    OR pg_catalog.to_regclass('cinatoken_economic_quotes.shared_key_quote_transitions') IS NULL
    OR pg_catalog.to_regclass('cinatoken_economic_quotes.shared_key_dispatch_quote_attempts') IS NOT NULL
    OR (SELECT relowner FROM pg_catalog.pg_class
        WHERE oid = 'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass)
       IS DISTINCT FROM migrator_oid
    OR (SELECT relowner FROM pg_catalog.pg_class
        WHERE oid = 'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass)
       IS DISTINCT FROM migrator_oid THEN
    RAISE EXCEPTION 'Shared-key dispatch quote attempt activation or role contract differs';
  END IF;
  -- Pin the reviewed quote-v338 bodies. A disabled, rebound or no-op
  -- validation/immutability trigger makes the saved reference untrustworthy.
  WITH expected(name, body_md5) AS (VALUES
    ('validate_shared_key_quote_insert', 'ba92aa971f3cbfb32fedacd65f62810e'),
    ('reject_shared_key_quote_mutation', '8dfd706a02e3274cb7eed8cf114ef947'),
    ('validate_shared_key_quote_statement', '45158dfcf951011e5866ffacbf988da9'),
    ('validate_shared_key_quote_transition', '6fe435768177d48d04a7fa359ad4a25a'),
    ('validate_shared_key_quote_transition_statement', 'd9ce8f65c2c3cf641ad4747776008c7e'),
    ('guard_shared_key_quote_owner_transfer', 'b971adf9c6f0cc8489ec0bfab63e20ea')
  )
  SELECT pg_catalog.count(*) INTO protected_functions FROM expected AS e
    JOIN pg_catalog.pg_proc AS p ON p.proname = e.name
    WHERE p.pronamespace = 'cinatoken_economic_quotes'::pg_catalog.regnamespace
      AND p.pronargs = 0
      AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND p.proowner = migrator_oid
      AND p.provolatile = 'v' AND NOT p.prosecdef
      AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(p.prosrc) = e.body_md5;
  IF protected_functions <> 6 THEN
    RAISE EXCEPTION 'Reviewed shared-key quote function catalog differs';
  END IF;
  WITH expected(name, relation_name, function_name, kind, deferred) AS (VALUES
    ('shared_key_quote_versions_validate_insert', 'shared_key_quote_versions',
      'validate_shared_key_quote_insert', 7, false),
    ('shared_key_quote_versions_no_change', 'shared_key_quote_versions',
      'reject_shared_key_quote_mutation', 26, false),
    ('shared_key_quote_versions_no_truncate', 'shared_key_quote_versions',
      'reject_shared_key_quote_mutation', 34, false),
    ('shared_key_quote_versions_one_row', 'shared_key_quote_versions',
      'validate_shared_key_quote_statement', 4, false),
    ('shared_key_quote_transitions_validate_insert', 'shared_key_quote_transitions',
      'validate_shared_key_quote_transition', 7, false),
    ('shared_key_quote_transitions_no_change', 'shared_key_quote_transitions',
      'reject_shared_key_quote_mutation', 26, false),
    ('shared_key_quote_transitions_no_truncate', 'shared_key_quote_transitions',
      'reject_shared_key_quote_mutation', 34, false),
    ('shared_key_quote_transitions_one_row', 'shared_key_quote_transitions',
      'validate_shared_key_quote_transition_statement', 4, false),
    ('shared_key_quote_owner_transfer_guard', 'shared_keys',
      'guard_shared_key_quote_owner_transfer', 17, true)
  )
  SELECT pg_catalog.count(*) INTO protected_triggers FROM expected AS e
    JOIN pg_catalog.pg_trigger AS t ON t.tgname = e.name
    JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
    WHERE c.relname = e.relation_name
      AND n.nspname = CASE WHEN e.relation_name = 'shared_keys'
        THEN 'cinatoken_gateway' ELSE 'cinatoken_economic_quotes' END
      AND p.pronamespace = 'cinatoken_economic_quotes'::pg_catalog.regnamespace
      AND p.proname = e.function_name AND p.pronargs = 0
      AND t.tgenabled = 'O' AND NOT t.tgisinternal
      AND t.tgtype = e.kind
      AND t.tgdeferrable = e.deferred
      AND t.tginitdeferred = e.deferred
      AND t.tgqual IS NULL;
  IF protected_triggers <> 9 OR
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid IN (
        'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass,
        'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass)
        AND NOT tgisinternal) <> 8 THEN
    RAISE EXCEPTION 'Reviewed shared-key quote trigger catalog differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace AS n
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS acl
      WHERE n.nspname = 'cinatoken_economic_quotes'
        AND acl.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
      WHERE c.oid IN (
        'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass,
        'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass)
        AND acl.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
      WHERE p.pronamespace = 'cinatoken_economic_quotes'::pg_catalog.regnamespace
        AND acl.grantee <> migrator_oid) THEN
    RAISE EXCEPTION 'Reviewed shared-key quote private ACL differs';
  END IF;
END;
$preflight$;

CREATE TABLE cinatoken_economic_quotes.shared_key_dispatch_quote_attempts (
  attempt_id uuid PRIMARY KEY,
  request_log_id text NOT NULL,
  attempt_index integer NOT NULL,
  shared_key_id text NOT NULL REFERENCES cinatoken_gateway.shared_keys(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  transition_id text NOT NULL REFERENCES
    cinatoken_economic_quotes.shared_key_quote_transitions(transition_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  quote_version_id text NOT NULL REFERENCES
    cinatoken_economic_quotes.shared_key_quote_versions(version_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_user_id text NOT NULL REFERENCES cinatoken_gateway.users(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  route_target_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT shared_quote_attempt_request_id_valid CHECK (
    request_log_id = pg_catalog.btrim(request_log_id)
    AND pg_catalog.length(request_log_id) BETWEEN 1 AND 128),
  CONSTRAINT shared_quote_attempt_index_valid CHECK (
    attempt_index BETWEEN 1 AND 1000),
  CONSTRAINT shared_quote_attempt_target_valid CHECK (
    route_target_id = pg_catalog.btrim(route_target_id)
    AND pg_catalog.length(route_target_id) BETWEEN 1 AND 128),
  CONSTRAINT shared_quote_attempt_request_index UNIQUE (request_log_id, attempt_index),
  CONSTRAINT shared_quote_attempt_exact_reference UNIQUE
    (attempt_id, request_log_id, attempt_index,
      transition_id, quote_version_id, shared_key_id)
);

CREATE FUNCTION cinatoken_economic_quotes.reject_dispatch_quote_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  IF TG_RELID <> 'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass
    OR (TG_NAME = 'shared_quote_attempts_no_change' AND TG_OP NOT IN ('UPDATE','DELETE'))
    OR (TG_NAME = 'shared_quote_attempts_no_truncate' AND TG_OP <> 'TRUNCATE')
    OR TG_NAME NOT IN ('shared_quote_attempts_no_change','shared_quote_attempts_no_truncate') THEN
    RAISE EXCEPTION 'Shared-key dispatch quote attempt guard binding differs';
  END IF;
  RAISE EXCEPTION 'Shared-key dispatch quote attempt references are append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempts_append_only';
END;
$reject$;
CREATE TRIGGER shared_quote_attempts_no_change
  BEFORE UPDATE OR DELETE ON cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_economic_quotes.reject_dispatch_quote_attempt_mutation();
CREATE TRIGGER shared_quote_attempts_no_truncate
  BEFORE TRUNCATE ON cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_economic_quotes.reject_dispatch_quote_attempt_mutation();

-- The request advisory lock must also be taken by the future log/outbox writer
-- BEFORE its request-log insert. It fences a late extra claim against the
-- terminal log transaction; the existing-log check rejects post-log claims.
-- The parent-key lock serializes a competing quote transition or owner/status
-- change. Under READ COMMITTED, the subsequent head query sees the transition
-- committed before the lock was acquired. The insert and lookup commit atomically.
-- A repeated attempt_id is accepted only while its exact originally captured
-- quote remains the current active head. An ACK-unknown caller must still stop
-- before fetch; replaying the function is only for forensic resolution.
CREATE FUNCTION cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
  p_attempt_id uuid, p_request_log_id text, p_attempt_index integer,
  p_shared_key_id text, p_route_target_id text)
RETURNS TABLE (
  attempt_id uuid, request_log_id text, attempt_index integer,
  shared_key_id text, transition_id text, quote_version_id text,
  seller_user_id text, route_target_id text, claimed_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $claim$
DECLARE actual_seller text;
DECLARE actual_status text;
DECLARE head cinatoken_economic_quotes.shared_key_quote_transitions%ROWTYPE;
DECLARE version_seller text;
DECLARE version_key text;
DECLARE captured cinatoken_economic_quotes.shared_key_dispatch_quote_attempts%ROWTYPE;
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> 'cinatoken_gateway_shared_quote_attempt_producer'
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed'
    OR p_attempt_id IS NULL OR p_request_log_id IS NULL
    OR p_attempt_index IS NULL OR p_shared_key_id IS NULL
    OR p_route_target_id IS NULL THEN
    RAISE EXCEPTION 'Shared-key dispatch quote attempt protocol differs'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempt_protocol';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shared_quote_attempt:' || p_request_log_id, 0));
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.api_key_request_logs AS log
      WHERE log.id = p_request_log_id) THEN
    RAISE EXCEPTION 'Shared-key quote claim is closed after its request log'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempt_after_log';
  END IF;
  SELECT sk.seller_user_id, sk.status INTO actual_seller, actual_status
    FROM cinatoken_gateway.shared_keys AS sk
    WHERE sk.id = p_shared_key_id FOR SHARE;
  IF actual_seller IS NULL OR actual_status <> 'active' THEN
    RAISE EXCEPTION 'Shared-key dispatch quote is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempt_unavailable';
  END IF;
  SELECT t.* INTO head
    FROM cinatoken_economic_quotes.shared_key_quote_transitions AS t
    WHERE t.shared_key_id = p_shared_key_id
    ORDER BY t.transition_seq DESC LIMIT 1;
  IF head.transition_kind IS DISTINCT FROM 'activate'
    OR head.quote_version_id IS NULL
    OR head.seller_user_id IS DISTINCT FROM actual_seller THEN
    RAISE EXCEPTION 'Shared-key dispatch quote is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempt_unavailable';
  END IF;
  SELECT q.shared_key_id, q.seller_user_id INTO version_key, version_seller
    FROM cinatoken_economic_quotes.shared_key_quote_versions AS q
    WHERE q.version_id = head.quote_version_id;
  IF version_key IS DISTINCT FROM p_shared_key_id
    OR version_seller IS DISTINCT FROM actual_seller THEN
    RAISE EXCEPTION 'Shared-key dispatch quote version differs from active head'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempt_version';
  END IF;
  INSERT INTO cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS a
    (attempt_id,request_log_id,attempt_index,shared_key_id,transition_id,
      quote_version_id,seller_user_id,route_target_id)
    VALUES (p_attempt_id,p_request_log_id,p_attempt_index,p_shared_key_id,
      head.transition_id,head.quote_version_id,actual_seller,p_route_target_id)
    ON CONFLICT ON CONSTRAINT shared_key_dispatch_quote_attempts_pkey DO NOTHING;
  SELECT a.* INTO captured FROM
    cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS a
    WHERE a.attempt_id = p_attempt_id;
  IF NOT FOUND
    OR captured.request_log_id IS DISTINCT FROM p_request_log_id
    OR captured.attempt_index IS DISTINCT FROM p_attempt_index
    OR captured.shared_key_id IS DISTINCT FROM p_shared_key_id
    OR captured.transition_id IS DISTINCT FROM head.transition_id
    OR captured.quote_version_id IS DISTINCT FROM head.quote_version_id
    OR captured.seller_user_id IS DISTINCT FROM actual_seller
    OR captured.route_target_id IS DISTINCT FROM p_route_target_id THEN
    RAISE EXCEPTION 'Shared-key dispatch quote attempt identity or active quote changed'
      USING ERRCODE = '23514', CONSTRAINT = 'shared_quote_attempt_identity';
  END IF;
  RETURN QUERY SELECT captured.attempt_id, captured.request_log_id,
    captured.attempt_index, captured.shared_key_id, captured.transition_id,
    captured.quote_version_id, captured.seller_user_id,
    captured.route_target_id, captured.claimed_at;
END;
$claim$;

REVOKE ALL ON TABLE cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
  FROM PUBLIC, cinatoken_gateway_runtime,
  cinatoken_gateway_shared_quote_attempt_producer;
REVOKE ALL ON FUNCTION
  cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
    uuid,text,integer,text,text)
  FROM PUBLIC, cinatoken_gateway_runtime;
REVOKE ALL ON FUNCTION
  cinatoken_economic_quotes.reject_dispatch_quote_attempt_mutation()
  FROM PUBLIC, cinatoken_gateway_runtime,
  cinatoken_gateway_shared_quote_attempt_producer;
GRANT USAGE ON SCHEMA cinatoken_economic_quotes
  TO cinatoken_gateway_shared_quote_attempt_producer;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(
    uuid,text,integer,text,text)
  TO cinatoken_gateway_shared_quote_attempt_producer;

DO $postflight$
DECLARE producer_oid oid;
DECLARE runtime_oid oid;
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_shared_quote_attempt_producer';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF NOT pg_catalog.has_schema_privilege(producer_oid,
      'cinatoken_economic_quotes', 'USAGE')
    OR pg_catalog.has_schema_privilege(producer_oid,
      'cinatoken_economic_quotes', 'CREATE')
    OR NOT pg_catalog.has_function_privilege(producer_oid,
      'cinatoken_economic_quotes.claim_shared_key_dispatch_quote_attempt(uuid,text,integer,text,text)',
      'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'cinatoken_economic_quotes.shared_key_quote_versions',
      'cinatoken_economic_quotes.shared_key_quote_transitions',
      'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts']::text[]) AS t(name)
      CROSS JOIN pg_catalog.unnest(ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]) AS p(privilege)
      WHERE pg_catalog.has_table_privilege(producer_oid, t.name, p.privilege)
        OR pg_catalog.has_table_privilege(runtime_oid, t.name, p.privilege))
    OR pg_catalog.has_schema_privilege(runtime_oid,
      'cinatoken_economic_quotes', 'USAGE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE pronamespace = 'cinatoken_economic_quotes'::pg_catalog.regnamespace
        AND (pg_catalog.has_function_privilege(runtime_oid, oid, 'EXECUTE')
          OR (proname <> 'claim_shared_key_dispatch_quote_attempt'
            AND pg_catalog.has_function_privilege(producer_oid, oid, 'EXECUTE'))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace AS n
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS acl
      WHERE n.nspname = 'cinatoken_economic_quotes'
        AND (acl.grantee NOT IN (migrator_oid, producer_oid)
          OR (acl.grantee = producer_oid
            AND (acl.privilege_type <> 'USAGE' OR acl.is_grantable))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
      WHERE c.oid IN (
        'cinatoken_economic_quotes.shared_key_quote_versions'::pg_catalog.regclass,
        'cinatoken_economic_quotes.shared_key_quote_transitions'::pg_catalog.regclass,
        'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass)
        AND acl.grantee <> migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
      WHERE p.pronamespace = 'cinatoken_economic_quotes'::pg_catalog.regnamespace
        AND acl.grantee <> migrator_oid
        AND NOT (p.proname = 'claim_shared_key_dispatch_quote_attempt'
          AND p.pronargs = 5 AND acl.grantee = producer_oid
          AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable)) THEN
    RAISE EXCEPTION 'Shared-key dispatch quote attempt ACL is wider than reviewed contract';
  END IF;
END;
$postflight$;
