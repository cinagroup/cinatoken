-- REVIEW ONLY. A pre-provisioned, direct LOGIN can invoke ordinary-budget
-- admission operations without owning or directly updating financial tables.
-- PG73 and the atomic v346/v347/v348 buyer split must already be installed.
-- Guardrail windows/multi-intent reservations, lease recovery, and the v348
-- Guardrail-denial release remain outside this intentionally narrow API.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.api_keys,
  cinatoken_gateway.user_budget_reservations
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid; buyer_oid oid; admission_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.budget_admission_login_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR admission_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.buyer_split_grant_policy_v348()') IS NULL
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=admission_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=admission_oid OR member=admission_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(admission_oid,c.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(admission_oid,c.oid,
            'INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.users'::pg_catalog.regclass,
      'cinatoken_gateway.api_keys'::pg_catalog.regclass,
      'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_schema_privilege(admission_oid,
      'cinatoken_gateway','CREATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.users','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.users','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)')
      IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)')
      IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)')
      IS NOT NULL
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_reserved_micros','UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
  THEN RAISE EXCEPTION 'budget admission v350 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.reserve_user_budget_v350(
  p_request_id text, p_user_id text, p_api_key_id text,
  p_budget_epoch bigint, p_reserved_micros bigint,
  p_now timestamptz, p_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reserve$
DECLARE account record; existing record; limit_micros bigint;
DECLARE spent_micros bigint; remaining_micros bigint; active_micros bigint;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_user_id IS NULL OR pg_catalog.length(p_user_id) NOT BETWEEN 1 AND 512
    OR p_api_key_id IS NULL OR pg_catalog.length(p_api_key_id) NOT BETWEEN 1 AND 512
    OR p_budget_epoch IS NULL OR p_budget_epoch<0 OR p_budget_epoch>9007199254740991
    OR p_reserved_micros IS NULL OR p_reserved_micros<=0
    OR p_reserved_micros>9007199254740991
    OR p_now IS NULL OR p_now<pg_catalog.clock_timestamp()-INTERVAL '5 minutes'
    OR p_now>pg_catalog.clock_timestamp()+INTERVAL '30 seconds'
    OR p_expires_at IS NULL OR p_expires_at<=p_now
    OR p_expires_at>p_now+INTERVAL '2 minutes'
  THEN RAISE EXCEPTION 'invalid ordinary budget admission call'
    USING ERRCODE='23514',CONSTRAINT='budget_admission_call_v350'; END IF;

  PERFORM 1 FROM cinatoken_gateway.api_keys k
    WHERE k.id=p_api_key_id AND k.user_id=p_user_id AND k.status='active'
    FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  SELECT * INTO account FROM cinatoken_gateway.users
    WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  IF account.budget_epoch<>p_budget_epoch
    OR (account.budget_period<>'none' AND account.budget_reset_at IS NOT NULL
      AND account.budget_reset_at<=p_now)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  IF account.budget_max IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status','unlimited');
  END IF;
  SELECT COALESCE(SUM(reserved_micros),0)::bigint INTO active_micros
    FROM cinatoken_gateway.user_budget_reservations
    WHERE user_id=p_user_id AND budget_epoch=p_budget_epoch
      AND state IN ('reserved','dispatched');
  IF active_micros<>account.budget_reserved_micros THEN
    RAISE EXCEPTION 'ordinary budget reserved counter differs'
      USING ERRCODE='23514',CONSTRAINT='budget_admission_counter_v350';
  END IF;
  limit_micros:=LEAST(pg_catalog.round(
    GREATEST(account.budget_max,0::numeric)*1000000::numeric),
    9007199254740991::numeric)::bigint;
  spent_micros:=LEAST(pg_catalog.round(
    GREATEST(account.budget_spent,0::numeric)*1000000::numeric),
    9007199254740991::numeric)::bigint;
  SELECT * INTO existing FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF existing.user_id=p_user_id AND existing.api_key_id=p_api_key_id
      AND existing.budget_epoch=p_budget_epoch
      AND existing.reserved_micros=p_reserved_micros
      AND existing.limit_micros=limit_micros
      AND existing.state IN ('reserved','dispatched')
    THEN RETURN pg_catalog.jsonb_build_object('status','idempotent',
      'limitMicros',limit_micros); END IF;
    RETURN pg_catalog.jsonb_build_object('status','conflict');
  END IF;
  remaining_micros:=GREATEST(0::bigint,
    limit_micros-LEAST(spent_micros,limit_micros)
      -LEAST(account.budget_reserved_micros,limit_micros));
  IF remaining_micros<p_reserved_micros THEN
    RETURN pg_catalog.jsonb_build_object('status','blocked',
      'remainingMicros',remaining_micros);
  END IF;
  UPDATE cinatoken_gateway.users SET
    budget_reserved_micros=budget_reserved_micros+p_reserved_micros,
    updated_at=p_now
    WHERE id=p_user_id AND budget_epoch=p_budget_epoch;
  INSERT INTO cinatoken_gateway.user_budget_reservations
    (request_id,user_id,api_key_id,budget_epoch,limit_micros,
     reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
    VALUES(p_request_id,p_user_id,p_api_key_id,p_budget_epoch,limit_micros,
      p_reserved_micros,0,'reserved',p_expires_at,p_now,p_now);
  RETURN pg_catalog.jsonb_build_object('status','reserved',
    'limitMicros',limit_micros);
END;
$reserve$;

CREATE FUNCTION cinatoken_gateway.mark_user_budget_dispatched_v350(
  p_request_id text,p_now timestamptz,p_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $mark$
DECLARE reservation record; account record; limit_micros bigint; active_micros bigint;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR p_now IS NULL OR p_expires_at IS NULL
    OR p_now<pg_catalog.clock_timestamp()-INTERVAL '5 minutes'
    OR p_now>pg_catalog.clock_timestamp()+INTERVAL '30 seconds'
    OR p_expires_at<=p_now OR p_expires_at>p_now+INTERVAL '15 minutes'
  THEN RAISE EXCEPTION 'invalid ordinary budget dispatch call'
    USING ERRCODE='23514',CONSTRAINT='budget_admission_call_v350'; END IF;
  SELECT * INTO reservation FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR reservation.state NOT IN ('reserved','dispatched') THEN RETURN false; END IF;
  SELECT * INTO account FROM cinatoken_gateway.users
    WHERE id=reservation.user_id FOR UPDATE;
  IF NOT FOUND OR account.budget_max IS NULL
    OR account.budget_epoch<>reservation.budget_epoch
    OR account.budget_reserved_micros<reservation.reserved_micros
    OR (account.budget_period<>'none' AND account.budget_reset_at IS NOT NULL
      AND account.budget_reset_at<=p_now)
    OR reservation.expires_at<=p_now
  THEN RETURN false; END IF;
  SELECT COALESCE(SUM(reserved_micros),0)::bigint INTO active_micros
    FROM cinatoken_gateway.user_budget_reservations
    WHERE user_id=reservation.user_id AND budget_epoch=reservation.budget_epoch
      AND state IN ('reserved','dispatched');
  IF active_micros<>account.budget_reserved_micros THEN
    RAISE EXCEPTION 'ordinary budget reserved counter differs'
      USING ERRCODE='23514',CONSTRAINT='budget_admission_counter_v350';
  END IF;
  limit_micros:=LEAST(pg_catalog.round(
    GREATEST(account.budget_max,0::numeric)*1000000::numeric),
    9007199254740991::numeric)::bigint;
  IF limit_micros<>reservation.limit_micros THEN RETURN false; END IF;
  IF reservation.state='dispatched' THEN RETURN true; END IF;
  UPDATE cinatoken_gateway.user_budget_reservations SET
    state='dispatched',dispatched_at=p_now,expires_at=p_expires_at,
    updated_at=p_now
    WHERE request_id=p_request_id AND state='reserved';
  RETURN FOUND;
END;
$mark$;

CREATE FUNCTION cinatoken_gateway.release_user_budget_v350(
  p_request_id text,p_now timestamptz,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $release$
DECLARE reservation record; account record; active_micros bigint;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR p_now IS NULL OR p_reason IS NULL
    OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
    OR p_reason='guardrail_budget_admission_rejected'
    OR p_now<pg_catalog.clock_timestamp()-INTERVAL '5 minutes'
    OR p_now>pg_catalog.clock_timestamp()+INTERVAL '30 seconds'
  THEN RAISE EXCEPTION 'invalid ordinary budget release call'
    USING ERRCODE='23514',CONSTRAINT='budget_admission_call_v350'; END IF;
  SELECT * INTO reservation FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF reservation.state='released' THEN RETURN 1; END IF;
  IF reservation.state<>'reserved' THEN RETURN 0; END IF;
  SELECT * INTO account FROM cinatoken_gateway.users
    WHERE id=reservation.user_id FOR UPDATE;
  IF FOUND AND account.budget_epoch=reservation.budget_epoch THEN
    SELECT COALESCE(SUM(reserved_micros),0)::bigint INTO active_micros
      FROM cinatoken_gateway.user_budget_reservations
      WHERE user_id=reservation.user_id AND budget_epoch=reservation.budget_epoch
        AND state IN ('reserved','dispatched');
    IF account.budget_reserved_micros<reservation.reserved_micros
      OR active_micros<>account.budget_reserved_micros THEN
      RAISE EXCEPTION 'ordinary budget reserved counter differs'
        USING ERRCODE='23514',CONSTRAINT='budget_admission_counter_v350';
    END IF;
    UPDATE cinatoken_gateway.users SET
      budget_reserved_micros=budget_reserved_micros-reservation.reserved_micros,
      updated_at=p_now WHERE id=reservation.user_id
      AND budget_epoch=reservation.budget_epoch;
  END IF;
  UPDATE cinatoken_gateway.user_budget_reservations SET
    state='released',settled_micros=0,terminal_at=p_now,
    terminal_reason=p_reason,updated_at=p_now
    WHERE request_id=p_request_id AND state='reserved';
  RETURN 1;
END;
$release$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz),
  cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz),
  cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_budget_admission;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz),
  cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz),
  cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)
  TO cinatoken_gateway_budget_admission;

DO $postflight$
DECLARE admission_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_column_privilege(admission_oid,
      'cinatoken_gateway.users','budget_reserved_micros','UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
  THEN RAISE EXCEPTION 'budget admission v350 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
