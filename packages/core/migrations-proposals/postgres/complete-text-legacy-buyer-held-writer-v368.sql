-- REVIEW ONLY. Narrow prototype for a non-grant, current-epoch, charged-basis
-- held buyer settlement. This cannot replace the existing multi-path critical
-- writer yet: no request-log/economic-event fact is bound here, and BYOK,
-- unreserved charges, old epochs, late actuals and provider-bill closure are
-- outside this function. Install only in the owned native fixture after v366.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_attempt_grants_v362,
  cinatoken_gateway.users,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.guardrail_budget_windows
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; buyer_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.legacy_buyer_held_writer_v368_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR buyer_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=buyer_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=buyer_oid OR member=buyer_oid)
    OR pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_gateway','CREATE')
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)')
      IS NOT NULL
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_reserved_micros','UPDATE')
    OR NOT pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname IN ('complete_text_ordinary_hold_fence_v366',
        'complete_text_guardrail_hold_fence_v366')
        AND tgenabled='O' AND NOT tgisinternal)<>2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_attempt_grants_v362'::pg_catalog.regclass,
        'cinatoken_gateway.users'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'legacy buyer held writer v368 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.settle_legacy_buyer_held_v368(
  p_request_id text,p_ordinary_micros bigint,p_guardrail_micros bigint,
  p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $settle$
DECLARE candidate record; account record; ordinary record; key_row record;
DECLARE held record; window_row record; active_micros bigint;
DECLARE guardrail_rows integer:=0; server_now timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_reason IS NULL OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
    OR p_ordinary_micros IS NULL
    OR p_ordinary_micros NOT BETWEEN 0 AND 9007199254740991
    OR p_guardrail_micros IS NULL
    OR p_guardrail_micros NOT BETWEEN 0 AND 9007199254740991
  THEN RAISE EXCEPTION 'invalid legacy buyer held call'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_held_call_v368'; END IF;

  -- v362 grants and v366 reapers use this request key. A later v362 grant
  -- cannot attach to the terminal rows committed by this function.
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE request_id=p_request_id)
  THEN RAISE EXCEPTION 'grant-linked buyer settlement needs verified closer'
    USING ERRCODE='23514',CONSTRAINT='complete_text_enrolled_buyer_v368'; END IF;
  SELECT request_id,user_id,api_key_id,budget_epoch INTO candidate
    FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object(
    'status','missing_ordinary_hold'); END IF;
  SELECT id,user_id,workspace_id INTO key_row
    FROM cinatoken_gateway.api_keys WHERE id=candidate.api_key_id FOR SHARE;
  IF NOT FOUND OR key_row.user_id IS DISTINCT FROM candidate.user_id
  THEN RAISE EXCEPTION 'legacy buyer key identity differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_identity_v368'; END IF;
  SELECT id,budget_epoch,budget_max,budget_spent,budget_reserved_micros
    INTO account FROM cinatoken_gateway.users
    WHERE id=candidate.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy buyer user account missing'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_identity_v368'; END IF;

  -- v362/v365 take the account before reservation-table locks. Obtain the
  -- eventual writer table locks before touching any Guardrail window row.
  LOCK TABLE cinatoken_gateway.user_budget_reservations,
    cinatoken_gateway.guardrail_budget_reservations IN ROW EXCLUSIVE MODE;
  SELECT * INTO ordinary FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR ordinary.user_id IS DISTINCT FROM candidate.user_id
    OR ordinary.api_key_id IS DISTINCT FROM candidate.api_key_id
    OR ordinary.budget_epoch IS DISTINCT FROM candidate.budget_epoch
    OR ordinary.state NOT IN ('reserved','dispatched')
    OR ordinary.settled_micros<>0
    OR p_ordinary_micros>ordinary.reserved_micros
    OR account.budget_epoch IS DISTINCT FROM ordinary.budget_epoch
    OR account.budget_max IS NULL
  THEN RAISE EXCEPTION 'legacy buyer ordinary hold state differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_hold_v368'; END IF;
  SELECT COALESCE(pg_catalog.sum(reserved_micros),0)::bigint
    INTO active_micros FROM cinatoken_gateway.user_budget_reservations
    WHERE user_id=ordinary.user_id AND budget_epoch=ordinary.budget_epoch
      AND state IN ('reserved','dispatched');
  IF active_micros<>account.budget_reserved_micros
    OR account.budget_reserved_micros<ordinary.reserved_micros
  THEN RAISE EXCEPTION 'legacy buyer ordinary counter differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_counter_v368'; END IF;

  -- The prototype covers the current charged-basis held route only. Every
  -- Guardrail reservation for this request must be present and current.
  FOR held IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,assignment_id
    FOR UPDATE
  LOOP
    IF held.state NOT IN ('reserved','dispatched') OR held.settled_micros<>0
      OR p_guardrail_micros>held.reserved_micros
      OR held.workspace_id IS DISTINCT FROM key_row.workspace_id
      OR held.settlement_basis<>'charged'
    THEN RAISE EXCEPTION 'legacy buyer Guardrail hold state differs'
      USING ERRCODE='23514',CONSTRAINT='legacy_buyer_hold_v368'; END IF;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start FOR UPDATE;
    SELECT COALESCE(pg_catalog.sum(reserved_micros),0)::bigint
      INTO active_micros FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start
        AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL
      OR active_micros<>window_row.reserved_micros
      OR window_row.reserved_micros<held.reserved_micros
      OR window_row.settled_micros>9007199254740991-p_guardrail_micros
    THEN RAISE EXCEPTION 'legacy buyer Guardrail window counter differs'
      USING ERRCODE='23514',CONSTRAINT='legacy_buyer_counter_v368'; END IF;
    guardrail_rows:=guardrail_rows+1;
  END LOOP;
  IF guardrail_rows<1 OR guardrail_rows>32
  THEN RAISE EXCEPTION 'legacy buyer Guardrail set differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_hold_v368'; END IF;

  server_now:=pg_catalog.clock_timestamp();
  UPDATE cinatoken_gateway.users SET
    budget_reserved_micros=budget_reserved_micros-ordinary.reserved_micros,
    budget_spent=pg_catalog.round(GREATEST(budget_spent+
      p_ordinary_micros::numeric/1000000::numeric,0::numeric),6),
    updated_at=server_now
    WHERE id=ordinary.user_id AND budget_epoch=ordinary.budget_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy buyer account transition raced'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_counter_v368'; END IF;
  UPDATE cinatoken_gateway.user_budget_reservations SET
    state='settled',settled_micros=p_ordinary_micros,
    terminal_at=server_now,terminal_reason=p_reason,updated_at=server_now
    WHERE request_id=p_request_id AND state=ordinary.state;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy buyer ordinary transition raced'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_hold_v368'; END IF;

  FOR held IN SELECT * FROM cinatoken_gateway.guardrail_budget_reservations
    WHERE request_id=p_request_id
    ORDER BY workspace_id,scope_type,scope_id,period,period_start,assignment_id
    FOR UPDATE
  LOOP
    UPDATE cinatoken_gateway.guardrail_budget_reservations SET
      state='settled',settled_micros=p_guardrail_micros,
      terminal_at=server_now,terminal_reason=p_reason,updated_at=server_now
      WHERE id=held.id AND state=held.state;
    IF NOT FOUND THEN RAISE EXCEPTION 'legacy buyer Guardrail transition raced'
      USING ERRCODE='23514',CONSTRAINT='legacy_buyer_hold_v368'; END IF;
    UPDATE cinatoken_gateway.guardrail_budget_windows SET
      reserved_micros=reserved_micros-held.reserved_micros,
      settled_micros=settled_micros+p_guardrail_micros,
      updated_at=server_now
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start;
    IF NOT FOUND THEN RAISE EXCEPTION 'legacy buyer window transition raced'
      USING ERRCODE='23514',CONSTRAINT='legacy_buyer_counter_v368'; END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('status','legacy_settled',
    'requestId',p_request_id,'ordinarySettledMicros',p_ordinary_micros,
    'guardrailSettledMicros',p_guardrail_micros,
    'guardrailRows',guardrail_rows);
END;
$settle$;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_budget_recovery,
    cinatoken_gateway_complete_text_attempt_granter,
    cinatoken_gateway_complete_text_send_holder;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)
  TO cinatoken_gateway_buyer_settlement;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
      'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid='cinatoken_gateway.settle_legacy_buyer_held_v368(
        text,bigint,bigint,text)'::pg_catalog.regprocedure
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'legacy buyer held writer v368 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
