-- REVIEW ONLY. Install with v353, v354, v362 and v365 present, using one
-- direct-migrator transaction and SET LOCAL
--   cinatoken.complete_text_legacy_reaper_fence_v366_activation='reviewed-v1'.
-- This deliberately supplies no complete-text closer or lease renewal.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.complete_text_send_custody_v365,
  cinatoken_gateway.complete_text_send_starts_v365,
  cinatoken_gateway.users,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; guardrail_oid oid; ordinary_oid oid;
DECLARE runtime_oid oid; buyer_oid oid; granter_oid oid; holder_oid oid;
DECLARE function_name text; function_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO guardrail_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO ordinary_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_recovery';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO granter_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_attempt_granter';
  SELECT oid INTO holder_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_send_holder';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_legacy_reaper_fence_v366_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR guardrail_oid IS NULL OR ordinary_oid IS NULL
    OR runtime_oid IS NULL OR buyer_oid IS NULL OR granter_oid IS NULL
    OR holder_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (guardrail_oid,ordinary_oid,granter_oid,holder_oid)
         OR member IN (guardrail_oid,ordinary_oid,granter_oid,holder_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid IN (guardrail_oid,ordinary_oid,granter_oid,holder_oid)
        AND (NOT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb
          OR rolreplication OR rolbypassrls OR rolinherit))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_send_custody_v365'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_send_starts_v365'::pg_catalog.regclass,
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_table_privilege(ordinary_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(ordinary_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(guardrail_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(guardrail_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname IN ('complete_text_ordinary_hold_fence_v366',
        'complete_text_guardrail_hold_fence_v366') AND NOT tgisinternal)<>0
  THEN RAISE EXCEPTION 'complete text reaper fence v366 activation or role differs'
    USING ERRCODE='P0001'; END IF;
  FOREACH function_name IN ARRAY ARRAY[
    'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)',
    'cinatoken_gateway.expire_guardrail_budgets_v353(integer)',
    'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
    'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)',
    'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
    'cinatoken_gateway.claim_complete_text_send_custody_v365(uuid,uuid)',
    'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)'
  ] LOOP
    function_oid:=pg_catalog.to_regprocedure(function_name);
    IF function_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid=function_oid AND proowner=migrator_oid AND prosecdef
        AND provolatile='v' AND prolang=(SELECT oid FROM pg_catalog.pg_language
          WHERE lanname='plpgsql')
        AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']::text[])
    THEN RAISE EXCEPTION 'complete text reaper fence v366 function differs: %',function_name
      USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(guardrail_oid,
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(guardrail_oid,
      'cinatoken_gateway.expire_guardrail_budgets_v353(integer)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(ordinary_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(ordinary_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(granter_oid,
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(holder_oid,
      'cinatoken_gateway.record_complete_text_send_start_v365(uuid,uuid,bigint,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)','EXECUTE')
  THEN RAISE EXCEPTION 'complete text reaper fence v366 ACL differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- This is a backstop for an old function already executing when the table-lock
-- barrier was acquired. The v362 grant writer changes holds before inserting its
-- grant row. It remains able to dispatch a fresh, unclaimed request.
CREATE FUNCTION cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $fence$
DECLARE old_request text; new_request text;
BEGIN
  old_request:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.request_id END;
  new_request:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.request_id END;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE request_id=old_request OR request_id=new_request)
  THEN RAISE EXCEPTION 'grant-linked complete text hold requires atomic closer'
    USING ERRCODE='23514',CONSTRAINT='complete_text_enrolled_hold_v366'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fence$;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_budget_admission,
    cinatoken_gateway_budget_recovery,cinatoken_gateway_buyer_settlement,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder;
CREATE TRIGGER complete_text_ordinary_hold_fence_v366
  BEFORE INSERT OR UPDATE OR DELETE ON cinatoken_gateway.user_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366();
CREATE TRIGGER complete_text_guardrail_hold_fence_v366
  BEFORE INSERT OR UPDATE OR DELETE ON cinatoken_gateway.guardrail_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366();

-- The four existing SECURITY DEFINER entry points are replaced below. Their
-- signatures and grants stay stable for legacy callers. No new caller authority.

CREATE OR REPLACE FUNCTION cinatoken_gateway.forfeit_guardrail_budgets_v353(
  p_request_id text,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $forfeit$
DECLARE reservation record; window_row record; active_micros bigint;
DECLARE found_rows integer:=0; transitioned integer:=0;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_reason IS NULL OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
    OR p_reason='guardrail_budget_admission_rejected'
  THEN RAISE EXCEPTION 'invalid Guardrail forfeit call'
    USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_call_v353'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE request_id=p_request_id)
  THEN RAISE EXCEPTION 'grant-linked Guardrail hold requires atomic closer'
    USING ERRCODE='23514',CONSTRAINT='complete_text_enrolled_hold_v366'; END IF;
  -- v365 takes a SHARE table lock before its window row locks. Obtain the
  -- eventual UPDATE's ROW EXCLUSIVE table lock before any window row lock.
  LOCK TABLE cinatoken_gateway.guardrail_budget_reservations
    IN ROW EXCLUSIVE MODE;
  FOR reservation IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,id FOR UPDATE NOWAIT
  LOOP
    found_rows:=found_rows+1;
    IF reservation.state='expired' AND reservation.dispatched_at IS NOT NULL
      AND reservation.settled_micros=reservation.reserved_micros
    THEN CONTINUE; END IF;
    IF reservation.state<>'dispatched' OR reservation.dispatched_at IS NULL
      OR reservation.settled_micros<>0
    THEN RAISE EXCEPTION 'Guardrail forfeit requires dispatched holds'
      USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_state_v353'; END IF;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start FOR UPDATE;
    SELECT COALESCE(sum(reserved_micros),0)::bigint INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL OR active_micros<>window_row.reserved_micros
      OR window_row.reserved_micros<reservation.reserved_micros
      OR window_row.settled_micros>9007199254740991-reservation.reserved_micros
    THEN RAISE EXCEPTION 'Guardrail forfeit window hold differs'
      USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_counter_v353'; END IF;
    UPDATE cinatoken_gateway.guardrail_budget_windows SET
      reserved_micros=reserved_micros-reservation.reserved_micros,
      settled_micros=settled_micros+reservation.reserved_micros,updated_at=server_now
      WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
        AND scope_id=reservation.scope_id AND period=reservation.period
        AND period_start=reservation.period_start;
    UPDATE cinatoken_gateway.guardrail_budget_reservations SET
      state='expired',settled_micros=reserved_micros,terminal_at=server_now,
      terminal_reason=p_reason,updated_at=server_now WHERE id=reservation.id;
    transitioned:=transitioned+1;
  END LOOP;
  IF found_rows=0 THEN RAISE EXCEPTION 'Guardrail forfeit has no reservation'
    USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_state_v353'; END IF;
  RETURN transitioned;
END;
$forfeit$;

-- Recovery trusts the database clock and recorded dispatch state, not a caller
-- supplied timestamp. Advisory request locks serialize with v351 and v348;
-- row/window locks and the live-hold sum reject fabricated counters.
CREATE OR REPLACE FUNCTION cinatoken_gateway.expire_guardrail_budgets_v353(p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $expire$
DECLARE candidate record; reservation record; window_row record;
DECLARE active_micros bigint; settled_delta bigint; n integer:=0;
DECLARE server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
  THEN RAISE EXCEPTION 'invalid Guardrail expiry call'
    USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_call_v353'; END IF;
  LOCK TABLE cinatoken_gateway.guardrail_budget_reservations
    IN ROW EXCLUSIVE MODE;
  -- Each branch can use the PG73 (state, expires_at) index and contributes at
  -- most 200 rows. A busy prefix can defer later candidates; that is a
  -- conservative availability limit, never permission to release a live hold.
  FOR candidate IN SELECT request_id,min(expires_at) AS first_expiry
    FROM (
      (SELECT request_id,expires_at FROM cinatoken_gateway.guardrail_budget_reservations
        WHERE state='reserved' AND expires_at<=server_now
          AND NOT EXISTS (SELECT 1 FROM
            cinatoken_gateway.complete_text_attempt_grants_v362 grant_row
            WHERE grant_row.request_id=guardrail_budget_reservations.request_id)
        ORDER BY expires_at LIMIT 200)
      UNION ALL
      (SELECT request_id,expires_at FROM cinatoken_gateway.guardrail_budget_reservations
        WHERE state='dispatched' AND expires_at<=server_now
          AND NOT EXISTS (SELECT 1 FROM
            cinatoken_gateway.complete_text_attempt_grants_v362 grant_row
            WHERE grant_row.request_id=guardrail_budget_reservations.request_id)
        ORDER BY expires_at LIMIT 200)
    ) bounded_candidates
    GROUP BY request_id ORDER BY first_expiry,request_id
  LOOP
    EXIT WHEN n>=p_limit;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(348,pg_catalog.hashtext(candidate.request_id))
    THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
        WHERE request_id=candidate.request_id)
    THEN CONTINUE; END IF;
    FOR reservation IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=candidate.request_id AND state IN ('reserved','dispatched')
        AND expires_at<=server_now
        AND NOT EXISTS (SELECT 1 FROM
          cinatoken_gateway.complete_text_attempt_grants_v362 grant_row
          WHERE grant_row.request_id=candidate.request_id)
      ORDER BY workspace_id,scope_type,scope_id,period,period_start,id
      LIMIT (p_limit-n) FOR UPDATE SKIP LOCKED
    LOOP
      IF reservation.settled_micros<>0
        OR (reservation.state='reserved' AND reservation.dispatched_at IS NOT NULL)
        OR (reservation.state='dispatched' AND reservation.dispatched_at IS NULL)
      THEN RAISE EXCEPTION 'Guardrail expiry reservation state differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_state_v353'; END IF;
      SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
        WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
          AND scope_id=reservation.scope_id AND period=reservation.period
          AND period_start=reservation.period_start FOR UPDATE;
      SELECT COALESCE(sum(reserved_micros),0)::bigint INTO active_micros
        FROM cinatoken_gateway.guardrail_budget_reservations
        WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
          AND scope_id=reservation.scope_id AND period=reservation.period
          AND period_start=reservation.period_start AND state IN ('reserved','dispatched');
      settled_delta:=CASE WHEN reservation.state='dispatched'
        THEN reservation.reserved_micros ELSE 0 END;
      IF window_row.workspace_id IS NULL OR active_micros<>window_row.reserved_micros
        OR window_row.reserved_micros<reservation.reserved_micros
        OR window_row.settled_micros>9007199254740991-settled_delta
      THEN RAISE EXCEPTION 'Guardrail expiry window hold differs'
        USING ERRCODE='23514',CONSTRAINT='guardrail_lifecycle_counter_v353'; END IF;
      UPDATE cinatoken_gateway.guardrail_budget_windows SET
        reserved_micros=reserved_micros-reservation.reserved_micros,
        settled_micros=settled_micros+settled_delta,updated_at=server_now
        WHERE workspace_id=reservation.workspace_id AND scope_type=reservation.scope_type
          AND scope_id=reservation.scope_id AND period=reservation.period
          AND period_start=reservation.period_start;
      UPDATE cinatoken_gateway.guardrail_budget_reservations SET
        state=CASE WHEN reservation.state='dispatched' THEN 'expired' ELSE 'released' END,
        settled_micros=settled_delta,terminal_at=server_now,
        terminal_reason=CASE WHEN reservation.state='dispatched'
          THEN 'lease_expired_after_dispatch' ELSE 'lease_expired_before_dispatch' END,
        updated_at=server_now WHERE id=reservation.id;
      n:=n+1;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$expire$;

-- The ordinary successor reads identity under the request advisory lock, locks
-- the user first, and only then locks the reservation. This matches v362's
-- account-before-hold order; a changed identity is rejected after row lock.
CREATE OR REPLACE FUNCTION cinatoken_gateway.forfeit_user_budget_dispatched_v354(
  p_request_id text,p_now timestamptz,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $forfeit_ordinary$
DECLARE candidate record; reservation record; account record;
DECLARE active_micros bigint; account_exists boolean; account_found boolean;
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
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE request_id=p_request_id)
  THEN RAISE EXCEPTION 'grant-linked ordinary hold requires atomic closer'
    USING ERRCODE='23514',CONSTRAINT='complete_text_enrolled_hold_v366'; END IF;
  SELECT user_id,budget_epoch,state INTO candidate
    FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- Keep legacy no-op and terminal replay independent of a busy account.
  -- A dispatched candidate is rechecked after account and reservation locks.
  IF candidate.state IN ('expired','settled') THEN RETURN 1; END IF;
  IF candidate.state<>'dispatched' THEN RETURN 0; END IF;
  SELECT * INTO account FROM cinatoken_gateway.users
    WHERE id=candidate.user_id FOR UPDATE SKIP LOCKED;
  account_found:=FOUND;
  IF NOT account_found THEN
    SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.users
      WHERE id=candidate.user_id) INTO account_exists;
    IF account_exists THEN
      RAISE EXCEPTION 'ordinary budget recovery account is busy'
        USING ERRCODE='55P03'; END IF;
  END IF;
  SELECT * INTO reservation FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF reservation.user_id IS DISTINCT FROM candidate.user_id
    OR reservation.budget_epoch IS DISTINCT FROM candidate.budget_epoch
  THEN RAISE EXCEPTION 'ordinary budget recovery identity raced'
    USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
  IF reservation.state IN ('expired','settled') THEN RETURN 1; END IF;
  IF reservation.state<>'dispatched' THEN RETURN 0; END IF;
  IF reservation.dispatched_at IS NULL THEN
    RAISE EXCEPTION 'dispatched ordinary budget lease has no dispatch marker'
      USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
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
$forfeit_ordinary$;

CREATE OR REPLACE FUNCTION cinatoken_gateway.expire_user_budget_leases_v354(
  p_now timestamptz,p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $expire_ordinary$
DECLARE candidate record; reservation record; account record;
DECLARE active_micros bigint; account_exists boolean; account_found boolean;
DECLARE n integer:=0; server_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_budget_recovery'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_now IS NULL OR p_now<server_now-INTERVAL '5 minutes'
    OR p_now>server_now+INTERVAL '30 seconds'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
  THEN RAISE EXCEPTION 'invalid ordinary budget expiry call'
    USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_call_v354'; END IF;
  -- Anti-join precedes LIMIT, so an enrolled prefix cannot starve legacy work.
  FOR candidate IN SELECT request_id,user_id,budget_epoch
    FROM cinatoken_gateway.user_budget_reservations ordinary
    WHERE state IN ('reserved','dispatched')
      AND expires_at<=p_now AND expires_at<=server_now
      AND NOT EXISTS (SELECT 1 FROM
        cinatoken_gateway.complete_text_attempt_grants_v362 grant_row
        WHERE grant_row.request_id=ordinary.request_id)
    ORDER BY user_id,budget_epoch,request_id LIMIT p_limit
  LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(348,
        pg_catalog.hashtext(candidate.request_id)) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
        WHERE request_id=candidate.request_id) THEN CONTINUE; END IF;
    SELECT * INTO account FROM cinatoken_gateway.users
      WHERE id=candidate.user_id FOR UPDATE SKIP LOCKED;
    account_found:=FOUND;
    IF NOT account_found THEN
      SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.users
        WHERE id=candidate.user_id) INTO account_exists;
      IF account_exists THEN CONTINUE; END IF;
    END IF;
    SELECT * INTO reservation FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=candidate.request_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF reservation.user_id IS DISTINCT FROM candidate.user_id
      OR reservation.budget_epoch IS DISTINCT FROM candidate.budget_epoch
      OR reservation.state NOT IN ('reserved','dispatched')
      OR reservation.expires_at>p_now OR reservation.expires_at>server_now
    THEN CONTINUE; END IF;
    IF (reservation.state='dispatched' AND reservation.dispatched_at IS NULL)
      OR (reservation.state='reserved' AND reservation.dispatched_at IS NOT NULL)
    THEN RAISE EXCEPTION 'ordinary budget expiry dispatch marker differs'
      USING ERRCODE='23514',CONSTRAINT='ordinary_recovery_state_v354'; END IF;
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
$expire_ordinary$;

DO $postflight$
DECLARE function_name text; expected_role text; function_oid oid;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)',
    'cinatoken_gateway.expire_guardrail_budgets_v353(integer)',
    'cinatoken_gateway.forfeit_user_budget_dispatched_v354(text,timestamptz,text)',
    'cinatoken_gateway.expire_user_budget_leases_v354(timestamptz,integer)'
  ] LOOP
    function_oid:=pg_catalog.to_regprocedure(function_name);
    expected_role:=CASE WHEN function_name LIKE '%guardrail%'
      THEN 'cinatoken_gateway_budget_admission'
      ELSE 'cinatoken_gateway_budget_recovery' END;
    IF NOT pg_catalog.has_function_privilege(expected_role,function_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',function_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',function_oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        pg_catalog.aclexplode(coalesce(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) a
        WHERE p.oid=function_oid AND a.grantee=0
          AND a.privilege_type='EXECUTE')
    THEN RAISE EXCEPTION 'complete text reaper fence v366 function ACL differs'
      USING ERRCODE='P0001'; END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname IN ('complete_text_ordinary_hold_fence_v366',
        'complete_text_guardrail_hold_fence_v366')
        AND NOT tgisinternal AND tgenabled='O')<>2
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.reject_complete_text_enrolled_hold_mutation_v366()',
      'EXECUTE')
  THEN RAISE EXCEPTION 'complete text reaper fence v366 trigger differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
