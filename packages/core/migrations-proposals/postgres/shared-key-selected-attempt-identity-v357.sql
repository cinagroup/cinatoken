-- REVIEW ONLY. Install after PG73, the v339/v340/v2 economic producer and
-- v351 selected-event gate, with
--   SET LOCAL cinatoken.shared_key_selected_attempt_activation='reviewed-v1';
-- This pins the exact selected quote attempt carried by the buyer log. It does
-- not prove a physical provider send or authorize a budget/earning transfer.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_economic_event_attempts
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.shared_key_selected_attempt_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.require_selected_shared_key_attempt_v357()') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.guard_selected_shared_key_trace_v357()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND tgname IN ('api_key_request_logs_selected_attempt_v357',
          'api_key_request_logs_selected_trace_immutable_v357'))
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.require_selected_shared_key_event_v351()') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass,
      'cinatoken_economic_quotes.shared_key_dispatch_quote_attempts'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR pg_catalog.has_schema_privilege(runtime_oid,'cinatoken_economic_outbox','CREATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
      'SELECT,INSERT,UPDATE,DELETE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname='api_key_request_logs_selected_event_v351'
        AND t.tgenabled='O' AND t.tgdeferrable AND t.tginitdeferred
        AND t.tgfoid='cinatoken_economic_outbox.require_selected_shared_key_event_v351()'
          ::pg_catalog.regprocedure)
  THEN RAISE EXCEPTION 'Selected attempt v357 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- The request-local selectedReference is serialized into route_trace by the
-- buyer writer. The deferred check observes the event and exact attempt in
-- this transaction. A prior attempt using the same Key cannot satisfy the
-- check merely by sharing its Key ID.
CREATE FUNCTION cinatoken_economic_outbox.require_selected_shared_key_attempt_v357()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $gate$
DECLARE selected_key text; selected_id text; trace jsonb; selected record;
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_selected_attempt_v357'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Selected attempt trigger binding differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_attempt_binding_v357';
  END IF;
  IF pg_catalog.left(NEW.provider_key_id,10) IS DISTINCT FROM 'sharedkey:'
  THEN RETURN NULL; END IF;
  selected_key:=pg_catalog.substr(NEW.provider_key_id,11);
  BEGIN trace:=NEW.route_trace::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Selected shared-key route trace is invalid'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_attempt_trace_v357';
  END;
  selected_id:=trace->>'selected_shared_quote_attempt_id';
  IF pg_catalog.jsonb_typeof(trace) IS DISTINCT FROM 'object'
    OR selected_id IS NULL
    OR selected_id !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR selected_key=''
    OR NEW.route_target_id IS NULL THEN
    RAISE EXCEPTION 'Selected shared-key attempt reference is missing'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_attempt_trace_v357';
  END IF;
  SELECT e.buyer_charge_basis,a.usage_certainty,a.input_tokens,
    a.output_tokens,a.cache_read_tokens,a.cache_write_tokens,
    a.evidence_kind,a.evidence_sha256 INTO selected
    FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts q
    JOIN cinatoken_economic_outbox.shared_key_economic_events e
      ON e.request_log_id=q.request_log_id
    JOIN cinatoken_economic_outbox.shared_key_economic_event_attempts a
      ON a.event_id=e.event_id AND a.request_log_id=e.request_log_id
        AND a.attempt_id=q.attempt_id
    WHERE q.attempt_id=selected_id::uuid
      AND q.request_log_id=NEW.id
      AND q.shared_key_id=selected_key
      AND q.route_target_id=NEW.route_target_id
      AND e.event_version=2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected quote attempt differs from buyer route or event'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_attempt_mismatch_v357';
  END IF;
  IF selected.buyer_charge_basis='actual'
    AND (selected.usage_certainty IS DISTINCT FROM 'actual'
      OR selected.evidence_kind IS DISTINCT FROM 'provider_usage'
      OR selected.input_tokens IS DISTINCT FROM NEW.input_tokens
      OR selected.output_tokens IS DISTINCT FROM NEW.output_tokens
      OR selected.cache_read_tokens IS DISTINCT FROM NEW.cache_read_tokens
      OR selected.cache_write_tokens IS DISTINCT FROM NEW.cache_write_tokens
      OR NEW.raw_usage IS NULL
      OR selected.evidence_sha256 IS DISTINCT FROM pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(NEW.raw_usage,'UTF8')),'hex')) THEN
    RAISE EXCEPTION 'Actual buyer usage differs from selected provider fact'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_attempt_usage_v357';
  END IF;
  RETURN NULL;
END;
$gate$;
CREATE CONSTRAINT TRIGGER api_key_request_logs_selected_attempt_v357
  AFTER INSERT ON cinatoken_gateway.api_key_request_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.require_selected_shared_key_attempt_v357();

-- Keep the selected identity and final route fixed after the buyer COMMIT.
CREATE FUNCTION cinatoken_economic_outbox.guard_selected_shared_key_trace_v357()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
    OR TG_NAME<>'api_key_request_logs_selected_trace_immutable_v357'
    OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Selected trace immutability trigger binding differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_trace_binding_v357';
  END IF;
  IF pg_catalog.left(OLD.provider_key_id,10)='sharedkey:'
    AND (OLD.route_trace IS DISTINCT FROM NEW.route_trace
      OR OLD.route_target_id IS DISTINCT FROM NEW.route_target_id) THEN
    RAISE EXCEPTION 'Selected shared-key route identity is immutable'
      USING ERRCODE='23514',CONSTRAINT='shared_key_selected_trace_immutable_v357';
  END IF;
  RETURN NEW;
END;
$immutable$;
CREATE TRIGGER api_key_request_logs_selected_trace_immutable_v357
  BEFORE UPDATE ON cinatoken_gateway.api_key_request_logs FOR EACH ROW
  EXECUTE FUNCTION cinatoken_economic_outbox.guard_selected_shared_key_trace_v357();

REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.require_selected_shared_key_attempt_v357(),
  cinatoken_economic_outbox.guard_selected_shared_key_trace_v357()
  FROM PUBLIC,cinatoken_gateway_runtime;

DO $postflight$
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.require_selected_shared_key_attempt_v357()',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.guard_selected_shared_key_trace_v357()',
      'EXECUTE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='cinatoken_gateway.api_key_request_logs'::pg_catalog.regclass
        AND t.tgname IN ('api_key_request_logs_selected_attempt_v357',
          'api_key_request_logs_selected_trace_immutable_v357')
        AND t.tgenabled='O' AND NOT t.tgisinternal)<>2
  THEN RAISE EXCEPTION 'Selected attempt v357 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
