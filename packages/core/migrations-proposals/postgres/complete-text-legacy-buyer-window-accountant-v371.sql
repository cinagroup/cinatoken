-- REVIEW ONLY. Successor to the v368 narrow non-grant held buyer writer.
-- This proposal is not a formal migration and does not authenticate the
-- caller's charged log amount against a Provider bill or immutable result.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.guardrail_budget_windows,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.api_key_request_logs
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; buyer_oid oid; old_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  old_oid:=pg_catalog.to_regprocedure(
    'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)');
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.legacy_buyer_window_accountant_v371_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR buyer_oid IS NULL OR old_oid IS NULL
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
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=old_oid AND p.proowner=migrator_oid AND p.prosecdef
        AND p.provolatile='v' AND p.proconfig=
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='abeb0cc33ab91be53a41e42c8f8aeb16')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,old_oid,'EXECUTE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR pg_catalog.has_any_column_privilege(buyer_oid,
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)')
      IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.seed_guardrail_window_unreserved_v371()')
      IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgname='seed_guardrail_window_unreserved_v371'
        AND tgrelid='cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass)
  THEN RAISE EXCEPTION 'legacy buyer window accountant v371 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- Every window creator (the v351/v355 admission functions, the older
-- repository, or privileged maintenance) must seed from committed logs.
-- The settlement function holds a conflicting table lock until its outer
-- COMMIT, so a creator after that lock observes the committed buyer log.
CREATE FUNCTION cinatoken_gateway.seed_guardrail_window_unreserved_v371()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $seed$
DECLARE historical numeric; mismatched_positive_charge boolean;
BEGIN
  IF NEW.unreserved_micros<>0
    OR (NEW.scope_type='workspace'
      AND NEW.scope_id IS DISTINCT FROM NEW.workspace_id) THEN
    RAISE EXCEPTION 'new Guardrail window cannot supply unreserved amount'
      USING ERRCODE='23514',CONSTRAINT='guardrail_window_seed_v371';
  END IF;
  SELECT COALESCE(pg_catalog.sum(COALESCE(l.budget_charged_micros,
      pg_catalog.round(GREATEST(l.charged_cost,0)*1000000)::bigint)),0),
      COALESCE(pg_catalog.bool_or(l.budget_charged_micros>0
        AND l.charged_cost*1000000::numeric
          <>l.budget_charged_micros::numeric),false)
    INTO historical,mismatched_positive_charge
    FROM cinatoken_gateway.api_key_request_logs l
    WHERE l.workspace_id=NEW.workspace_id
      AND (NEW.scope_type='workspace' AND NEW.scope_id=NEW.workspace_id
        OR (NEW.scope_type='user' AND l.user_id=NEW.scope_id)
        OR (NEW.scope_type='api_key' AND l.api_key_id=NEW.scope_id))
      AND COALESCE(l.budget_accounted_at,l.created_at)>=NEW.period_start
      AND COALESCE(l.budget_accounted_at,l.created_at)<NEW.period_end
      AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations r
        WHERE r.request_id=l.id AND r.workspace_id=NEW.workspace_id
          AND r.scope_type=NEW.scope_type AND r.scope_id=NEW.scope_id
          AND r.period=NEW.period AND r.period_start=NEW.period_start
          AND r.state IN ('reserved','dispatched','settled','expired'));
  IF mismatched_positive_charge OR historical<0
    OR historical>9007199254740991 THEN
    RAISE EXCEPTION 'new Guardrail window historical charge unsafe'
      USING ERRCODE='23514',CONSTRAINT='guardrail_window_seed_v371';
  END IF;
  NEW.unreserved_micros:=historical::bigint;
  RETURN NEW;
END;
$seed$;
REVOKE ALL ON FUNCTION cinatoken_gateway.seed_guardrail_window_unreserved_v371()
  FROM PUBLIC,cinatoken_gateway_buyer_settlement;
CREATE TRIGGER seed_guardrail_window_unreserved_v371
BEFORE INSERT ON cinatoken_gateway.guardrail_budget_windows
FOR EACH ROW EXECUTE FUNCTION
  cinatoken_gateway.seed_guardrail_window_unreserved_v371();

-- Call after inserting the append-only request log, before the v2 economic
-- event, on the same buyer LOGIN and outer transaction. The result confirms
-- only a staged transition; the caller must observe COMMIT separately.
CREATE FUNCTION cinatoken_gateway.settle_legacy_buyer_windowed_v371(
  p_request_id text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s' AS $settle$
DECLARE log_row record; candidate record; key_row record; account_row record;
DECLARE charge_micros bigint; held jsonb; unreserved_rows integer:=0;
DECLARE accounted_at timestamptz; server_now timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_reason IS NULL OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
  THEN RAISE EXCEPTION 'invalid windowed legacy buyer call'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_windowed_call_v371'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  SELECT * INTO log_row FROM cinatoken_gateway.api_key_request_logs
    WHERE id=p_request_id FOR SHARE;
  IF NOT FOUND OR log_row.user_id IS NULL OR log_row.api_key_id IS NULL
    OR log_row.workspace_id IS NULL OR log_row.is_byok IS DISTINCT FROM false
    OR log_row.status<>'success'
    OR log_row.budget_charged_micros IS NULL
    OR log_row.budget_charged_micros NOT BETWEEN 0 AND 9007199254740991
    OR log_row.charged_cost*1000000::numeric
      <>log_row.budget_charged_micros::numeric
  THEN RAISE EXCEPTION 'windowed buyer log is missing or differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_log_v371'; END IF;
  charge_micros:=log_row.budget_charged_micros;
  accounted_at:=COALESCE(log_row.budget_accounted_at,log_row.created_at);
  SELECT request_id,user_id,api_key_id,budget_epoch INTO candidate
    FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=p_request_id;
  IF NOT FOUND OR candidate.user_id IS DISTINCT FROM log_row.user_id
    OR candidate.api_key_id IS DISTINCT FROM log_row.api_key_id
  THEN RAISE EXCEPTION 'windowed buyer ordinary identity differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_identity_v371'; END IF;
  SELECT id,user_id,workspace_id INTO key_row
    FROM cinatoken_gateway.api_keys WHERE id=candidate.api_key_id FOR SHARE;
  IF NOT FOUND OR key_row.user_id IS DISTINCT FROM candidate.user_id
    OR key_row.workspace_id IS DISTINCT FROM log_row.workspace_id
  THEN RAISE EXCEPTION 'windowed buyer key identity differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_identity_v371'; END IF;
  SELECT id,budget_epoch INTO account_row FROM cinatoken_gateway.users
    WHERE id=candidate.user_id FOR UPDATE;
  IF NOT FOUND OR account_row.budget_epoch IS DISTINCT FROM candidate.budget_epoch
  THEN RAISE EXCEPTION 'windowed buyer account epoch differs'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_identity_v371'; END IF;

  -- A conflicting INSERT/UPDATE/DELETE ROW EXCLUSIVE lock on the whole
  -- window table serializes every scope creator with this buyer transaction.
  -- Take the account and reservation-table locks first, matching v368.
  LOCK TABLE cinatoken_gateway.user_budget_reservations,
    cinatoken_gateway.guardrail_budget_reservations IN ROW EXCLUSIVE MODE;
  LOCK TABLE cinatoken_gateway.guardrail_budget_windows
    IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_windows w
      WHERE accounted_at>=w.period_start AND accounted_at<w.period_end
        AND w.workspace_id=log_row.workspace_id
        AND ((w.scope_type='workspace' AND w.scope_id=log_row.workspace_id)
          OR (w.scope_type='user' AND w.scope_id=log_row.user_id)
          OR (w.scope_type='api_key' AND w.scope_id=log_row.api_key_id))
        AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations r
          WHERE r.request_id=p_request_id AND r.workspace_id=w.workspace_id
            AND r.scope_type=w.scope_type AND r.scope_id=w.scope_id
            AND r.period=w.period AND r.period_start=w.period_start
            AND r.state IN ('reserved','dispatched','settled','expired'))
        AND w.unreserved_micros>9007199254740991-charge_micros)
  THEN RAISE EXCEPTION 'windowed buyer unreserved counter unsafe'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_window_v371'; END IF;

  held:=cinatoken_gateway.settle_legacy_buyer_held_v368(
    p_request_id,charge_micros,charge_micros,p_reason);
  IF held->>'status'<>'legacy_settled' THEN
    RAISE EXCEPTION 'windowed buyer held transition differs'
      USING ERRCODE='23514',CONSTRAINT='legacy_buyer_hold_v371'; END IF;
  IF charge_micros>0 THEN
    server_now:=pg_catalog.clock_timestamp();
    UPDATE cinatoken_gateway.guardrail_budget_windows w
      SET unreserved_micros=w.unreserved_micros+charge_micros,
        updated_at=server_now
      WHERE accounted_at>=w.period_start AND accounted_at<w.period_end
        AND w.workspace_id=log_row.workspace_id
        AND ((w.scope_type='workspace' AND w.scope_id=log_row.workspace_id)
          OR (w.scope_type='user' AND w.scope_id=log_row.user_id)
          OR (w.scope_type='api_key' AND w.scope_id=log_row.api_key_id))
        AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations r
          WHERE r.request_id=p_request_id AND r.workspace_id=w.workspace_id
            AND r.scope_type=w.scope_type AND r.scope_id=w.scope_id
            AND r.period=w.period AND r.period_start=w.period_start
            AND r.state IN ('reserved','dispatched','settled','expired'));
    GET DIAGNOSTICS unreserved_rows=ROW_COUNT;
  END IF;
  RETURN pg_catalog.jsonb_build_object('status','windowed_legacy_settled',
    'requestId',p_request_id,'chargeMicros',charge_micros,
    'guardrailRows',(held->>'guardrailRows')::integer,
    'unreservedWindowRows',unreserved_rows);
END;
$settle$;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)
  TO cinatoken_gateway_buyer_settlement;
REVOKE EXECUTE ON FUNCTION
  cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)
  FROM cinatoken_gateway_buyer_settlement;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.guardrail_budget_windows','UPDATE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='seed_guardrail_window_unreserved_v371'
        AND tgrelid='cinatoken_gateway.guardrail_budget_windows'::pg_catalog.regclass
        AND tgenabled='O' AND NOT tgisinternal)<>1
  THEN RAISE EXCEPTION 'legacy buyer window accountant v371 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
