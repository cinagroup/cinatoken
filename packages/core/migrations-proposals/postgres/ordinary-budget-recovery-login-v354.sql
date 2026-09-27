-- REVIEW ONLY. PG73, v348 buyer split and v350 ordinary admission required.
-- A pre-provisioned direct recovery LOGIN receives only these two functions.
-- Install in one direct-migrator transaction with
--   SET LOCAL cinatoken.ordinary_budget_recovery_v354_activation='reviewed-v1'.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.user_budget_reservations
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid; admission_oid oid; recovery_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_recovery';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.ordinary_budget_recovery_v354_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR admission_oid IS NULL OR recovery_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)') IS NULL
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)',
      'EXECUTE')
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)') IS NOT NULL
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=recovery_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=recovery_oid OR member=recovery_oid)
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR pg_catalog.has_schema_privilege(recovery_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(recovery_oid,c.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(recovery_oid,c.oid,
            'INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.users'::pg_catalog.regclass,
      'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_reserved_micros','UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
  THEN RAISE EXCEPTION 'ordinary budget recovery v354 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.forfeit_user_budget_dispatched_v354(
  p_request_id text,p_now timestamptz,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $forfeit$
DECLARE reservation record; account record; active_micros bigint;
DECLARE account_exists boolean; account_found boolean;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_recovery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_reason IS NULL OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
    OR p_now IS NULL OR p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
  THEN RAISE EXCEPTION 'invalid ordinary budget forfeiture call'
    USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_call_v354'; END IF;
  SELECT * INTO reservation FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF reservation.state IN ('expired','settled') THEN RETURN 1; END IF;
  IF reservation.state<>'dispatched' THEN RETURN 0; END IF;
  IF reservation.dispatched_at IS NULL THEN
    RAISE EXCEPTION 'dispatched ordinary budget lease has no dispatch marker'
      USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
  SELECT * INTO account FROM cinatoken_gateway.users
    WHERE id=reservation.user_id FOR UPDATE SKIP LOCKED;
  account_found:=FOUND;
  IF NOT account_found THEN
    SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.users
      WHERE id=reservation.user_id) INTO account_exists;
    IF account_exists THEN
      RAISE EXCEPTION 'ordinary budget recovery account is busy'
        USING ERRCODE='55P03'; END IF;
  END IF;
  IF account_found AND account.budget_epoch=reservation.budget_epoch THEN
    SELECT COALESCE(pg_catalog.sum(reserved_micros),0)::bigint
      INTO active_micros FROM cinatoken_gateway.user_budget_reservations
      WHERE user_id=reservation.user_id AND budget_epoch=reservation.budget_epoch
        AND state IN ('reserved','dispatched');
    IF active_micros<>account.budget_reserved_micros
      OR account.budget_reserved_micros<reservation.reserved_micros THEN
      RAISE EXCEPTION 'ordinary budget recovery counter differs'
        USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_counter_v354'; END IF;
    UPDATE cinatoken_gateway.users SET
      budget_reserved_micros=budget_reserved_micros-reservation.reserved_micros,
      budget_spent=pg_catalog.round(GREATEST(
        budget_spent+(reservation.reserved_micros::numeric/1000000::numeric),
        0::numeric),6),
      updated_at=p_now WHERE id=reservation.user_id
        AND budget_epoch=reservation.budget_epoch;
  END IF;
  UPDATE cinatoken_gateway.user_budget_reservations SET
    state='expired',settled_micros=reservation.reserved_micros,
    terminal_at=p_now,terminal_reason=p_reason,updated_at=p_now
    WHERE request_id=p_request_id AND state='dispatched';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ordinary budget recovery transition raced'
      USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
  RETURN 1;
END;
$forfeit$;

CREATE FUNCTION cinatoken_gateway.expire_user_budget_leases_v354(
  p_now timestamptz,p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $expire$
DECLARE reservation record; account record; active_micros bigint;
DECLARE account_exists boolean; account_found boolean;
DECLARE n integer:=0;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_recovery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_now IS NULL OR p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'invalid ordinary budget expiry call'
    USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_call_v354'; END IF;
  FOR reservation IN SELECT * FROM cinatoken_gateway.user_budget_reservations
    WHERE state IN ('reserved','dispatched')
      AND expires_at<=p_now AND expires_at<=server_now
    ORDER BY user_id,budget_epoch,request_id
    LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    IF (reservation.state='dispatched' AND reservation.dispatched_at IS NULL)
      OR (reservation.state='reserved' AND reservation.dispatched_at IS NOT NULL)
    THEN RAISE EXCEPTION 'ordinary budget expiry dispatch marker differs'
      USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
    SELECT * INTO account FROM cinatoken_gateway.users
      WHERE id=reservation.user_id FOR UPDATE SKIP LOCKED;
    account_found:=FOUND;
    IF NOT account_found THEN
      SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.users
        WHERE id=reservation.user_id) INTO account_exists;
      IF account_exists THEN CONTINUE; END IF;
    END IF;
    IF account_found AND account.budget_epoch=reservation.budget_epoch THEN
      SELECT COALESCE(pg_catalog.sum(reserved_micros),0)::bigint
        INTO active_micros FROM cinatoken_gateway.user_budget_reservations
        WHERE user_id=reservation.user_id AND budget_epoch=reservation.budget_epoch
          AND state IN ('reserved','dispatched');
      IF active_micros<>account.budget_reserved_micros
        OR account.budget_reserved_micros<reservation.reserved_micros THEN
        RAISE EXCEPTION 'ordinary budget recovery counter differs'
          USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_counter_v354'; END IF;
      UPDATE cinatoken_gateway.users SET
        budget_reserved_micros=budget_reserved_micros-reservation.reserved_micros,
        budget_spent=pg_catalog.round(GREATEST(
          budget_spent+(CASE WHEN reservation.state='dispatched'
            THEN reservation.reserved_micros::numeric/1000000::numeric
            ELSE 0::numeric END),0::numeric),6),
        updated_at=p_now WHERE id=reservation.user_id
          AND budget_epoch=reservation.budget_epoch;
    END IF;
    UPDATE cinatoken_gateway.user_budget_reservations SET
      state=CASE WHEN reservation.state='dispatched' THEN 'expired' ELSE 'released' END,
      settled_micros=CASE WHEN reservation.state='dispatched'
        THEN reservation.reserved_micros ELSE 0 END,
      terminal_at=p_now,
      terminal_reason=CASE WHEN reservation.state='dispatched'
        THEN 'lease_expired_after_dispatch' ELSE 'lease_expired_before_dispatch' END,
      updated_at=p_now
      WHERE request_id=reservation.request_id AND state=reservation.state;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ordinary budget expiry transition raced'
        USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
    n:=n+1;
  END LOOP;
  RETURN n;
END;
$expire$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text),
  cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_budget_admission,
    cinatoken_gateway_buyer_settlement;
GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_budget_recovery;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text),
  cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)
  TO cinatoken_gateway_budget_recovery;

DO $postflight$
DECLARE recovery_oid oid; runtime_oid oid; admission_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO recovery_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_recovery';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF NOT pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(recovery_oid,
      'cinatoken_gateway.release_user_budget_v350(text,timestamptz,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(recovery_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(recovery_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_column_privilege(recovery_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
  THEN RAISE EXCEPTION 'ordinary budget recovery v354 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
