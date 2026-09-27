-- REVIEW ONLY. Install only after formal PG73 plus the v339 shared-key quote,
-- dispatch-attempt and economic-outbox proposals. Activation is one migrator
-- transaction with:
--   SET LOCAL cinatoken.shared_key_selected_event_gate_activation = 'reviewed-v1';
-- This extends v339's deferred quote-attempt enrollment check. It creates no
-- payout, route switch, consumer, runtime grant or automatic deployment.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
-- Share the later finance/grant activation lock before taking relation locks.
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_economic_event_attempts
  IN SHARE ROW EXCLUSIVE MODE;

-- Pin the v339 proof while inspecting it; an unchanged COST update takes each
-- pg_proc tuple lock, in addition to the table locks that fence trigger DDL.
ALTER FUNCTION cinatoken_economic_outbox.lock_request_economic_enrollment() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.require_event_for_buyer_log() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.verify_economic_event() COST 100;
ALTER FUNCTION cinatoken_economic_outbox.guard_legacy_earning_insert() COST 100;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF pg_catalog.current_setting(
      'cinatoken.shared_key_selected_event_gate_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator'
    OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=migrator_oid)
      IS DISTINCT FROM TRUE
    OR (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE oid=runtime_oid)
      IS DISTINCT FROM TRUE
    OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE oid=runtime_oid) IS TRUE
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR (SELECT count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.require_selected_shared_key_event_v351()')
      IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.reject_provider_key_mutation_v351()')
      IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND tgname IN ('api_key_request_logs_selected_event_v351',
          'api_key_request_logs_provider_key_immutable_v351'))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND attname='provider_key_id' AND atttypid='pg_catalog.text'::pg_catalog.regtype
        AND NOT attisdropped)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
        'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass,
        'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    -- v340 grants USAGE solely so runtime can call its reviewed producer;
    -- v347 later revokes producer EXECUTE. CREATE would permit replacement.
    OR pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_outbox','CREATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
      'SELECT,INSERT,UPDATE,DELETE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole=migrator_oid
        AND (d.defaclnamespace=0 OR
          d.defaclnamespace='cinatoken_economic_outbox'::pg_catalog.regnamespace)
        AND d.defaclobjtype IN ('f','r') AND acl.grantee<>migrator_oid)
    OR (SELECT count(*) FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (
        'cinatoken_economic_outbox.lock_request_economic_enrollment()'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.require_event_for_buyer_log()'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.verify_economic_event()'::pg_catalog.regprocedure,
        'cinatoken_economic_outbox.guard_legacy_earning_insert()'::pg_catalog.regprocedure)
        AND p.proowner=migrator_oid AND l.lanname='plpgsql'
        AND p.prosecdef AND p.provolatile='v' AND p.procost=100
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=
          CASE p.proname
            WHEN 'lock_request_economic_enrollment' THEN
              '55e9e7b94e2099548dfbec23425c9fc0'
            WHEN 'require_event_for_buyer_log' THEN
              'dedde60c7696048bdedb9c2459aa83a7'
            WHEN 'verify_economic_event' THEN
              '6f9368aa5d93c4af204d9aad5dda3e77'
            WHEN 'guard_legacy_earning_insert' THEN
              '41d9eaeee437ffbce83ac06ff7fe3921'
            ELSE '' END)<>4
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname='api_key_request_logs_lock_shared_quote_attempts'
        AND t.tgenabled='O' AND t.tgtype=7 AND NOT t.tgdeferrable
        AND t.tgfoid='cinatoken_economic_outbox.lock_request_economic_enrollment()'
          ::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname='api_key_request_logs_require_shared_key_economic_event'
        AND t.tgenabled='O' AND t.tgtype=5
        AND t.tgdeferrable AND t.tginitdeferred
        AND t.tgfoid='cinatoken_economic_outbox.require_event_for_buyer_log()'
          ::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_economic_outbox.shared_key_economic_events'
          ::pg_catalog.regclass
        AND t.tgname='shared_key_economic_events_verify'
        AND t.tgenabled='O' AND t.tgtype=5
        AND t.tgdeferrable AND t.tginitdeferred
        AND t.tgfoid='cinatoken_economic_outbox.verify_economic_event()'
          ::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname='shared_key_earnings_reject_economic_event'
        AND t.tgenabled='O' AND t.tgtype=7
        AND t.tgfoid='cinatoken_economic_outbox.guard_legacy_earning_insert()'
          ::pg_catalog.regprocedure)
  THEN RAISE EXCEPTION 'Selected shared-key event gate activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- The v339 deferred trigger remains intact and continues to cover any
-- pre-dispatch quote attempt, even if the selected log key is not shared.
-- This additional check closes the no-quote legacy writer path. The event
-- and its immutable attempt facts must be visible in the inserting TX before
-- COMMIT. v339's own deferred verifier checks the complete quote coverage.
CREATE FUNCTION cinatoken_economic_outbox.require_selected_shared_key_event_v351()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $gate$
DECLARE selected_key text;
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_selected_event_v351'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Selected shared-key event trigger binding differs'
      USING ERRCODE='23514', CONSTRAINT='shared_key_selected_event_binding_v351';
  END IF;
  IF pg_catalog.left(NEW.provider_key_id,10) IS DISTINCT FROM 'sharedkey:'
  THEN RETURN NULL; END IF;
  selected_key:=pg_catalog.substr(NEW.provider_key_id,11);
  IF selected_key='' OR NOT EXISTS (SELECT 1
      FROM cinatoken_economic_outbox.shared_key_economic_events AS e
      WHERE e.request_log_id=NEW.id) THEN
    RAISE EXCEPTION 'Selected shared-key buyer log has no typed economic event'
      USING ERRCODE='23514', CONSTRAINT='shared_key_selected_event_required_v351';
  END IF;
  IF NOT EXISTS (SELECT 1
      FROM cinatoken_economic_outbox.shared_key_economic_events AS e
      JOIN cinatoken_economic_outbox.shared_key_economic_event_attempts AS a
        ON a.event_id=e.event_id AND a.request_log_id=e.request_log_id
      WHERE e.request_log_id=NEW.id AND a.shared_key_id=selected_key) THEN
    RAISE EXCEPTION 'Selected shared-key id has no typed quote attempt'
      USING ERRCODE='23514', CONSTRAINT='shared_key_selected_attempt_mismatch_v351';
  END IF;
  RETURN NULL;
END;
$gate$;
CREATE CONSTRAINT TRIGGER api_key_request_logs_selected_event_v351
  AFTER INSERT ON cinatoken_gateway.api_key_request_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.require_selected_shared_key_event_v351();

-- A later UPDATE must not turn a committed ordinary log into a selected
-- shared-key log, nor erase the selected key after event enrollment. Use a
-- whole-row UPDATE trigger: UPDATE OF provider_key_id would miss modifications
-- made by an earlier BEFORE UPDATE trigger when the column was not in SET.
CREATE FUNCTION cinatoken_economic_outbox.reject_provider_key_mutation_v351()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_provider_key_immutable_v351'
    OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Provider key immutability trigger binding differs'
      USING ERRCODE='23514', CONSTRAINT='shared_key_provider_key_binding_v351';
  END IF;
  IF OLD.provider_key_id IS DISTINCT FROM NEW.provider_key_id THEN
    RAISE EXCEPTION 'Request log provider key is immutable after insertion'
      USING ERRCODE='23514', CONSTRAINT='shared_key_provider_key_immutable_v351';
  END IF;
  RETURN NEW;
END;
$immutable$;
CREATE TRIGGER api_key_request_logs_provider_key_immutable_v351
  BEFORE UPDATE ON cinatoken_gateway.api_key_request_logs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.reject_provider_key_mutation_v351();

REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.require_selected_shared_key_event_v351(),
  cinatoken_economic_outbox.reject_provider_key_mutation_v351()
  FROM PUBLIC,cinatoken_gateway_runtime;

DO $postflight$
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.require_selected_shared_key_event_v351()',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.reject_provider_key_mutation_v351()',
      'EXECUTE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname='api_key_request_logs_selected_event_v351'
        AND t.tgenabled='O' AND t.tgtype=5
        AND t.tgdeferrable AND t.tginitdeferred
        AND t.tgfoid='cinatoken_economic_outbox.require_selected_shared_key_event_v351()'
          ::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname='api_key_request_logs_provider_key_immutable_v351'
        AND t.tgenabled='O' AND t.tgtype=19
        AND NOT t.tgdeferrable
        AND t.tgfoid='cinatoken_economic_outbox.reject_provider_key_mutation_v351()'
          ::pg_catalog.regprocedure)
  THEN RAISE EXCEPTION 'Selected shared-key event gate postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
