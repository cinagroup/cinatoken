-- Review-only successor. Activate inside one migrator transaction with
-- SET LOCAL cinatoken.complete_text_legacy_buyer_admission_fence_v380_activation='reviewed-v1'.
-- It fences the current v372 legacy buyer LOGIN, not a future platform closer.
-- Keep the v368/v371 bodies and their reviewed source hashes unchanged.

DO $preflight$
BEGIN
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER IS DISTINCT FROM CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_legacy_buyer_admission_fence_v380_activation',
      true) IS DISTINCT FROM 'reviewed-v1'
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_admissions_v361') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.api_key_request_logs') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.user_budget_reservations') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.settle_legacy_buyer_held_v368(text,bigint,bigint,text)') IS NULL
    OR NOT pg_catalog.has_table_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.api_key_request_logs','INSERT')
    OR NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)',
      'EXECUTE')
    OR pg_catalog.has_any_column_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.user_budget_reservations','UPDATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid IN (
        'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_admissions_v361'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass)
        AND t.tgname IN (
          'legacy_buyer_admitted_log_fence_v380',
          'complete_text_preexisting_log_fence_v380',
          'legacy_buyer_admitted_hold_fence_v380'))
  THEN RAISE EXCEPTION 'complete text legacy buyer v380 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.reject_legacy_buyer_admitted_log_v380()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $fence$
BEGIN
  IF SESSION_USER='cinatoken_gateway_buyer_settlement' THEN
    -- v361 uses this exact advisory key before checking/creating its holds.
    -- Limit this new lock to the current v372 buyer LOGIN. Other writers
    -- require an explicit lock-order review before joining this protocol.
    PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(NEW.id));
    IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_admissions_v361
        WHERE request_id=NEW.id)
    THEN RAISE EXCEPTION 'v361 admission is not a legacy buyer request'
      USING ERRCODE='23514',
        CONSTRAINT='legacy_buyer_admitted_log_v380'; END IF;
  END IF;
  RETURN NEW;
END;
$fence$;

CREATE FUNCTION cinatoken_gateway.reject_complete_text_preexisting_log_v380()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $fence$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(348,
    pg_catalog.hashtext(NEW.request_id));
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.api_key_request_logs
      WHERE id=NEW.request_id)
  THEN RAISE EXCEPTION 'v361 admission request already has a buyer log'
    USING ERRCODE='23514',
      CONSTRAINT='complete_text_preexisting_log_v380'; END IF;
  RETURN NEW;
END;
$fence$;

CREATE FUNCTION cinatoken_gateway.reject_legacy_buyer_admitted_hold_v380()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $fence$
BEGIN
  -- Backstop for a preexisting/privileged log or direct v371 invocation.
  -- A future platform closer needs its own isolated LOGIN and transition.
  IF SESSION_USER='cinatoken_gateway_buyer_settlement'
    AND EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_admissions_v361
      WHERE request_id=OLD.request_id)
  THEN RAISE EXCEPTION 'v361 hold needs platform buyer closer'
    USING ERRCODE='23514',
      CONSTRAINT='legacy_buyer_admitted_hold_v380'; END IF;
  RETURN NEW;
END;
$fence$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.reject_legacy_buyer_admitted_log_v380(),
  cinatoken_gateway.reject_complete_text_preexisting_log_v380(),
  cinatoken_gateway.reject_legacy_buyer_admitted_hold_v380()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_buyer_settlement;

CREATE TRIGGER legacy_buyer_admitted_log_fence_v380
BEFORE INSERT ON cinatoken_gateway.api_key_request_logs
FOR EACH ROW EXECUTE FUNCTION
  cinatoken_gateway.reject_legacy_buyer_admitted_log_v380();

CREATE TRIGGER complete_text_preexisting_log_fence_v380
BEFORE INSERT ON cinatoken_gateway.complete_text_admissions_v361
FOR EACH ROW EXECUTE FUNCTION
  cinatoken_gateway.reject_complete_text_preexisting_log_v380();

CREATE TRIGGER legacy_buyer_admitted_hold_fence_v380
BEFORE UPDATE ON cinatoken_gateway.user_budget_reservations
FOR EACH ROW EXECUTE FUNCTION
  cinatoken_gateway.reject_legacy_buyer_admitted_hold_v380();

DO $postflight$
DECLARE matched integer; buyer_exec boolean; runtime_exec boolean;
BEGIN
  SELECT count(*) INTO matched FROM pg_catalog.pg_trigger t
    WHERE (t.tgrelid,t.tgname,t.tgfoid,t.tgenabled,t.tgtype) IN (
      ('cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
        'legacy_buyer_admitted_log_fence_v380',
        'cinatoken_gateway.reject_legacy_buyer_admitted_log_v380()'
          ::pg_catalog.regprocedure,'O',7),
      ('cinatoken_gateway.complete_text_admissions_v361'::pg_catalog.regclass,
        'complete_text_preexisting_log_fence_v380',
        'cinatoken_gateway.reject_complete_text_preexisting_log_v380()'
          ::pg_catalog.regprocedure,'O',7),
      ('cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'legacy_buyer_admitted_hold_fence_v380',
        'cinatoken_gateway.reject_legacy_buyer_admitted_hold_v380()'
          ::pg_catalog.regprocedure,'O',19))
      AND NOT t.tgisinternal AND t.tgqual IS NULL
      AND t.tgattr::text=''
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL;
  SELECT pg_catalog.has_function_privilege(
      'cinatoken_gateway_buyer_settlement',
      'cinatoken_gateway.reject_legacy_buyer_admitted_log_v380()',
      'EXECUTE') INTO buyer_exec;
  SELECT pg_catalog.has_function_privilege(
      'cinatoken_gateway_runtime',
      'cinatoken_gateway.reject_legacy_buyer_admitted_log_v380()',
      'EXECUTE') INTO runtime_exec;
  IF matched<>3 OR buyer_exec OR runtime_exec
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        'cinatoken_gateway.reject_legacy_buyer_admitted_log_v380()'
          ::pg_catalog.regprocedure,
        'cinatoken_gateway.reject_complete_text_preexisting_log_v380()'
          ::pg_catalog.regprocedure,
        'cinatoken_gateway.reject_legacy_buyer_admitted_hold_v380()'
          ::pg_catalog.regprocedure)
        AND acl.privilege_type='EXECUTE'
        AND acl.grantee<>p.proowner)
  THEN RAISE EXCEPTION 'complete text legacy buyer v380 postflight differs: triggers %, buyer execute %, runtime execute %',
      matched,buyer_exec,runtime_exec
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
