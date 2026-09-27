-- REVIEW ONLY / NON-ACTIVATABLE. Install after v362/v365/v366/v367 in one
-- migrator transaction with
-- cinatoken.complete_text_no_fetch_fence_v370_activation='reviewed-v1'.
-- Provision a separate direct NOINHERIT LOGIN
-- cinatoken_gateway_complete_text_no_fetch_resolver first. This is a durable
-- send-authority fence, not a buyer zero-charge settlement or retry grant.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
SELECT pg_catalog.pg_advisory_xact_lock(746923566);
SELECT pg_catalog.pg_advisory_xact_lock(746923567);
SELECT pg_catalog.pg_advisory_xact_lock(746923570);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365,
  cinatoken_gateway.complete_text_result_facts_v366,
  cinatoken_gateway.complete_text_hold_renewals_v367
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; resolver_oid oid; send_mutation_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO resolver_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_no_fetch_resolver';
  send_mutation_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.reject_complete_text_send_start_mutation_v365()');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_no_fetch_fence_v370_activation',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR resolver_oid IS NULL
    OR send_mutation_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=resolver_oid)
          IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=resolver_oid OR member=resolver_oid)
    OR pg_catalog.has_schema_privilege(resolver_oid,
      'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname LIKE 'cinatoken_economic_%'
        AND pg_catalog.has_schema_privilege(resolver_oid,n.oid,'USAGE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p','v','m','f')
        AND (pg_catalog.has_table_privilege(resolver_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(resolver_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(resolver_oid,p.oid,'EXECUTE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass,
      'cinatoken_gateway.complete_text_send_custody_v365'::pg_catalog.regclass,
      'cinatoken_gateway.complete_text_send_starts_v365'::pg_catalog.regclass,
      'cinatoken_gateway.complete_text_result_facts_v366'::pg_catalog.regclass,
      'cinatoken_gateway.complete_text_hold_renewals_v367'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgfoid=send_mutation_oid
        AND t.tgname IN ('complete_text_send_custody_v365_no_mutation',
          'complete_text_send_starts_v365_no_mutation'))<>2
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_no_fetch_resolutions_v370') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reject_complete_text_fenced_send_v370()') IS NOT NULL
  THEN RAISE EXCEPTION 'complete text no-fetch fence v370 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_no_fetch_resolutions_v370 (
  resolution_id uuid PRIMARY KEY,
  resolution_nonce uuid NOT NULL UNIQUE,
  grant_id uuid NOT NULL UNIQUE REFERENCES
    cinatoken_gateway.complete_text_attempt_grants_v362(grant_id),
  request_id text NOT NULL UNIQUE,
  quote_id uuid NOT NULL,
  attempt_nonce uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number=1),
  grant_claim_sha256 text NOT NULL
    CHECK (grant_claim_sha256 ~ '^[0-9a-f]{64}$'),
  outbound_body_sha256 text NOT NULL
    CHECK (outbound_body_sha256 ~ '^[0-9a-f]{64}$'),
  holder_run_id uuid,
  send_expires_at timestamptz NOT NULL,
  fenced_at timestamptz NOT NULL CHECK (fenced_at>send_expires_at),
  result text NOT NULL CHECK (result='verified_no_fetch')
);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text no-fetch resolution v370 is insert-only'
    USING ERRCODE='23514',CONSTRAINT='complete_text_no_fetch_append_v370';
END;
$immutable$;
CREATE TRIGGER complete_text_no_fetch_resolutions_v370_no_mutation
  BEFORE UPDATE OR DELETE ON
    cinatoken_gateway.complete_text_no_fetch_resolutions_v370
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370();
CREATE TRIGGER complete_text_no_fetch_resolutions_v370_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.complete_text_no_fetch_resolutions_v370
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370();

-- This trigger protects direct inserts as well as the v365 SECURITY DEFINER
-- wrappers. Read the immutable grant's request without a row lock, acquire
-- the request lock, then re-read and lock the grant before inspecting the
-- durable fence. NEW.request_id never chooses the advisory lock.
CREATE FUNCTION cinatoken_gateway.reject_complete_text_fenced_send_v370()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $fence$
DECLARE v_request_id text; v_locked_request_id text;
BEGIN
  SELECT request_id INTO v_request_id
    FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=NEW.grant_id;
  IF v_request_id IS NULL
  THEN RAISE EXCEPTION 'complete text send grant/request mismatch'
    USING ERRCODE='23514',CONSTRAINT='complete_text_fenced_send_v370'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(v_request_id));
  SELECT request_id INTO v_locked_request_id
    FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=NEW.grant_id FOR SHARE;
  IF v_locked_request_id IS DISTINCT FROM v_request_id
    OR NEW.request_id IS DISTINCT FROM v_request_id
  THEN RAISE EXCEPTION 'complete text send grant/request mismatch'
    USING ERRCODE='23514',CONSTRAINT='complete_text_fenced_send_v370'; END IF;
  IF EXISTS (SELECT 1 FROM
      cinatoken_gateway.complete_text_no_fetch_resolutions_v370
      WHERE request_id=v_request_id)
  THEN RAISE EXCEPTION 'complete text holder send authority permanently fenced'
    USING ERRCODE='23514',CONSTRAINT='complete_text_fenced_send_v370'; END IF;
  RETURN NEW;
END;
$fence$;
CREATE TRIGGER complete_text_send_custody_v370_no_fetch_fence
  BEFORE INSERT ON cinatoken_gateway.complete_text_send_custody_v365
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_fenced_send_v370();
CREATE TRIGGER complete_text_send_starts_v370_no_fetch_fence
  BEFORE INSERT ON cinatoken_gateway.complete_text_send_starts_v365
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_fenced_send_v370();

-- No caller observation, HTTP status, missing usage, or absent holder ACK is
-- accepted as proof. Under the request lock, a committed start always wins;
-- after the deadline, an absent start plus the permanent insert triggers is
-- the only v365 no-fetch proof. The immutable v362 unknown and every hold stay.
CREATE FUNCTION cinatoken_gateway.resolve_complete_text_no_fetch_v370(
  p_grant_id uuid,p_resolution_nonce uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $resolve$
DECLARE grant_row record; prior record; custody record; v_request_id text;
DECLARE v_now timestamptz; v_resolution_id uuid;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_no_fetch_resolver'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_grant_id IS NULL OR p_resolution_nonce IS NULL
  THEN RAISE EXCEPTION 'invalid complete text no-fetch resolver call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_no_fetch_call_v370'; END IF;
  SELECT request_id INTO v_request_id
    FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_grant'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(v_request_id));
  SELECT * INTO grant_row
    FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE grant_id=p_grant_id FOR SHARE;
  IF grant_row.grant_id IS NULL
    OR grant_row.request_id IS DISTINCT FROM v_request_id
  THEN RETURN pg_catalog.jsonb_build_object('status','grant_state_conflict'); END IF;
  SELECT * INTO prior
    FROM cinatoken_gateway.complete_text_no_fetch_resolutions_v370
    WHERE grant_id=p_grant_id FOR SHARE;
  IF FOUND THEN
    IF prior.resolution_nonce IS DISTINCT FROM p_resolution_nonce
    THEN RETURN pg_catalog.jsonb_build_object('status','resolution_conflict'); END IF;
    -- A replay after lost COMMIT/close ACK never creates a second decision.
    RETURN pg_catalog.jsonb_build_object('status','already_verified_no_fetch',
      'resolutionId',prior.resolution_id,'grantId',p_grant_id,
      'fencedAt',prior.fenced_at);
  END IF;
  v_now:=pg_catalog.clock_timestamp();
  IF grant_row.obligation_state IS DISTINCT FROM 'unknown'
    OR grant_row.attempt_number IS DISTINCT FROM 1
  THEN RETURN pg_catalog.jsonb_build_object('status','grant_state_conflict'); END IF;
  IF grant_row.send_expires_at>=v_now
  THEN RETURN pg_catalog.jsonb_build_object('status','send_deadline_live'); END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_send_starts_v365
      WHERE grant_id=p_grant_id OR request_id=grant_row.request_id)
  THEN RETURN pg_catalog.jsonb_build_object('status','possible_send_unknown'); END IF;
  -- v366 requires a start for every kind except holder no_fetch_attestation.
  -- A privileged or future source that contradicts this is an incident, not
  -- permission to infer zero supplier charge from the missing marker.
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_result_facts_v366
      WHERE grant_id=p_grant_id AND kind<>'no_fetch_attestation')
  THEN RETURN pg_catalog.jsonb_build_object('status','fact_contradiction_unknown'); END IF;
  SELECT * INTO custody FROM cinatoken_gateway.complete_text_send_custody_v365
    WHERE grant_id=p_grant_id FOR SHARE;
  IF custody.grant_id IS NOT NULL
    AND custody.request_id IS DISTINCT FROM grant_row.request_id
  THEN RETURN pg_catalog.jsonb_build_object('status','custody_conflict'); END IF;
  v_now:=pg_catalog.clock_timestamp();
  IF grant_row.send_expires_at>=v_now
  THEN RETURN pg_catalog.jsonb_build_object('status','send_deadline_live'); END IF;
  v_resolution_id:=pg_catalog.gen_random_uuid();
  INSERT INTO cinatoken_gateway.complete_text_no_fetch_resolutions_v370
    (resolution_id,resolution_nonce,grant_id,request_id,quote_id,
      attempt_nonce,attempt_number,grant_claim_sha256,outbound_body_sha256,
      holder_run_id,send_expires_at,fenced_at,result)
    VALUES(v_resolution_id,p_resolution_nonce,p_grant_id,grant_row.request_id,
      grant_row.quote_id,grant_row.attempt_nonce,grant_row.attempt_number,
      grant_row.claim_sha256,grant_row.outbound_body_sha256,
      custody.holder_run_id,grant_row.send_expires_at,v_now,
      'verified_no_fetch');
  RETURN pg_catalog.jsonb_build_object('status','verified_no_fetch_recorded',
    'resolutionId',v_resolution_id,'grantId',p_grant_id,'fencedAt',v_now,
    'result','verified_no_fetch');
END;
$resolve$;

REVOKE ALL ON cinatoken_gateway.complete_text_no_fetch_resolutions_v370
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_budget_recovery,
    cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_hold_renewer,
    cinatoken_gateway_complete_text_provider_bill,
    cinatoken_gateway_complete_text_no_fetch_resolver;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid),
  cinatoken_gateway.reject_complete_text_fenced_send_v370(),
  cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_budget_recovery,
    cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder,
    cinatoken_gateway_complete_text_hold_renewer,
    cinatoken_gateway_complete_text_provider_bill,
    cinatoken_gateway_complete_text_no_fetch_resolver;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_no_fetch_resolver;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid)
  TO cinatoken_gateway_complete_text_no_fetch_resolver;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_no_fetch_resolver',
      'cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_send_holder',
      'cinatoken_gateway.resolve_complete_text_no_fetch_v370(uuid,uuid)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_no_fetch_resolver',
      'cinatoken_gateway.complete_text_no_fetch_resolutions_v370',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgfoid='cinatoken_gateway.reject_complete_text_fenced_send_v370()'::pg_catalog.regprocedure
        AND t.tgname IN ('complete_text_send_custody_v370_no_fetch_fence',
          'complete_text_send_starts_v370_no_fetch_fence'))<>2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgfoid='cinatoken_gateway.reject_complete_text_no_fetch_mutation_v370()'::pg_catalog.regprocedure
        AND t.tgrelid=
          'cinatoken_gateway.complete_text_no_fetch_resolutions_v370'::pg_catalog.regclass
        AND t.tgname IN (
          'complete_text_no_fetch_resolutions_v370_no_mutation',
          'complete_text_no_fetch_resolutions_v370_no_truncate'))<>2
  THEN RAISE EXCEPTION 'complete text no-fetch fence v370 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
