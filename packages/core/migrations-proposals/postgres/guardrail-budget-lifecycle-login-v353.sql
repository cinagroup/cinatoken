-- REVIEW ONLY. PG73 + v348/v349 buyer split + v350 + v351 prerequisite.
-- Direct budget-admission LOGIN receives EXECUTE only. Install in one direct
-- migrator transaction after SET LOCAL
--   cinatoken.guardrail_budget_lifecycle_v353_activation='reviewed-v1'.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.guardrail_budget_reservations
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; admission_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.guardrail_budget_lifecycle_v353_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR admission_oid IS NULL OR runtime_oid IS NULL
    OR buyer_oid IS NULL
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n' ORDER BY version COLLATE "C"))
        FROM cinatoken_gateway.schema_migrations)<>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure('cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.release_guardrail_budgets_v351(text,timestamptz,text)') IS NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_gateway.expire_guardrail_budgets_v353(integer)') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class i
      JOIN pg_catalog.pg_index x ON x.indexrelid=i.oid
      WHERE i.oid=pg_catalog.to_regclass(
        'cinatoken_gateway.idx_guardrail_budget_reservations_expiry')
        AND x.indisvalid AND x.indisready AND x.indpred IS NULL
        AND pg_catalog.pg_get_indexdef(i.oid) LIKE '%(state, expires_at)%')
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
          AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
        FROM pg_catalog.pg_roles WHERE oid=admission_oid) IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=admission_oid OR member=admission_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN ('cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass,
                      'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
  THEN RAISE EXCEPTION 'Guardrail lifecycle v353 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- Unknown provider outcome after a confirmed dispatch boundary consumes the
-- full hold. A repeated call after an acknowledged or unacknowledged COMMIT is
-- harmless; neither path can turn a dispatched reservation into released.
CREATE FUNCTION cinatoken_gateway.forfeit_guardrail_budgets_v353(
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
CREATE FUNCTION cinatoken_gateway.expire_guardrail_budgets_v353(p_limit integer)
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
  -- Each branch can use the PG73 (state, expires_at) index and contributes at
  -- most 200 rows. A busy prefix can defer later candidates; that is a
  -- conservative availability limit, never permission to release a live hold.
  FOR candidate IN SELECT request_id,min(expires_at) AS first_expiry
    FROM (
      (SELECT request_id,expires_at FROM cinatoken_gateway.guardrail_budget_reservations
        WHERE state='reserved' AND expires_at<=server_now
        ORDER BY expires_at LIMIT 200)
      UNION ALL
      (SELECT request_id,expires_at FROM cinatoken_gateway.guardrail_budget_reservations
        WHERE state='dispatched' AND expires_at<=server_now
        ORDER BY expires_at LIMIT 200)
    ) bounded_candidates
    GROUP BY request_id ORDER BY first_expiry,request_id
  LOOP
    EXIT WHEN n>=p_limit;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(348,pg_catalog.hashtext(candidate.request_id))
    THEN CONTINUE; END IF;
    FOR reservation IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=candidate.request_id AND state IN ('reserved','dispatched')
        AND expires_at<=server_now
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

REVOKE ALL ON FUNCTION
  cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text),
  cinatoken_gateway.expire_guardrail_budgets_v353(integer)
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text),
  cinatoken_gateway.expire_guardrail_budgets_v353(integer)
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
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.expire_guardrail_budgets_v353(integer)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.forfeit_guardrail_budgets_v353(text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.expire_guardrail_budgets_v353(integer)','EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_gateway.expire_guardrail_budgets_v353(integer)','EXECUTE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_windows','INSERT,UPDATE')
    OR pg_catalog.has_table_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_any_column_privilege(admission_oid,
      'cinatoken_gateway.guardrail_budget_reservations','INSERT,UPDATE')
  THEN RAISE EXCEPTION 'Guardrail lifecycle v353 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
