-- REVIEW ONLY. Post-reservation Guardrail denial bridge after v347 buyer LOGIN.
-- Direct migrator LOGIN, one transaction, explicit activation; no production grant.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_buyer_reservation_admissions
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF pg_catalog.current_setting('cinatoken.shared_key_guardrail_denial_v348_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','UPDATE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.user_budget_reservations','state','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_economic_outbox.shared_key_economic_events','INSERT')
    OR pg_catalog.has_schema_privilege(buyer_oid,'cinatoken_economic_outbox','CREATE')
    OR pg_catalog.to_regclass('cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials') IS NOT NULL
    OR pg_catalog.to_regprocedure('cinatoken_economic_outbox.verified_guardrail_pre_send_denial(text,text,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
      'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass,
      'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r' OR c.relrowsecurity OR c.relforcerowsecurity))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (
      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)'::pg_catalog.regprocedure,
      'cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure,
      'cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)
      AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=
        CASE p.proname
          WHEN 'write_shared_key_economic_event_v2' THEN '132180ac28c093adc3fb07c38a769cab'
          WHEN 'verify_buyer_debit_v2' THEN 'f58977880d4f575264a2eb7110902b2b'
          WHEN 'verify_buyer_budget_tx_receipt' THEN '8500d7bd0074b28e101873c41e4a79ce'
          ELSE '' END)<>3
  THEN RAISE EXCEPTION 'Guardrail denial v348 activation or dependency differs'; END IF;
END;
$preflight$;

-- This private receipt is born only on the budget repository's reserved -> released
-- transition with its exact Guardrail rejection reason, before any dispatch mark.
CREATE TABLE cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials (
  request_id text PRIMARY KEY REFERENCES cinatoken_gateway.user_budget_reservations(request_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id text NOT NULL,
  api_key_id text NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros>0),
  release_xact_id xid8 NOT NULL,
  released_at timestamptz NOT NULL
);
CREATE FUNCTION cinatoken_economic_outbox.capture_guardrail_pre_send_denial()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $capture$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
    OR TG_NAME<>'user_budget_reservations_capture_guardrail_pre_send_denial'
    OR TG_OP<>'UPDATE' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Guardrail denial receipt trigger binding differs';
  END IF;
  IF OLD.state='reserved' AND NEW.state='released' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(NEW.request_id));
  END IF;
  IF SESSION_USER<>'cinatoken_gateway_buyer_settlement'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR OLD.state<>'reserved' OR NEW.state<>'released'
    OR OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL
    OR OLD.settled_micros<>0 OR NEW.settled_micros<>0
    OR NEW.terminal_reason IS DISTINCT FROM 'guardrail_budget_admission_rejected'
    OR NEW.terminal_at IS NULL
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id
    OR OLD.reserved_micros IS DISTINCT FROM NEW.reserved_micros
    OR NOT EXISTS (SELECT 1 FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
      WHERE request_log_id=NEW.request_id)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=NEW.request_id) THEN RETURN NULL; END IF;
  INSERT INTO cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials
    (request_id,user_id,api_key_id,reserved_micros,release_xact_id,released_at)
    VALUES (NEW.request_id,NEW.user_id,NEW.api_key_id,NEW.reserved_micros,
      pg_catalog.pg_current_xact_id(),NEW.terminal_at);
  RETURN NULL;
END;
$capture$;
CREATE TRIGGER user_budget_reservations_capture_guardrail_pre_send_denial
  AFTER UPDATE ON cinatoken_gateway.user_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.capture_guardrail_pre_send_denial();

CREATE FUNCTION cinatoken_economic_outbox.verified_guardrail_pre_send_denial(
  p_request_id text,p_user_id text,p_api_key_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $proof$
  SELECT EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations r
    JOIN cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials d
      ON d.request_id=r.request_id AND d.user_id=r.user_id
      AND d.api_key_id=r.api_key_id AND d.reserved_micros=r.reserved_micros
    WHERE r.request_id=p_request_id AND r.user_id=p_user_id
      AND r.api_key_id=p_api_key_id AND r.state='released'
      AND r.settled_micros=0 AND r.dispatched_at IS NULL
      AND r.terminal_reason='guardrail_budget_admission_rejected'
      AND r.terminal_at=d.released_at
      AND NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations g
        WHERE g.request_id=r.request_id));
$proof$;

CREATE FUNCTION cinatoken_economic_outbox.guard_guardrail_pre_send_denial()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
    OR TG_NAME<>'user_budget_reservations_guard_guardrail_pre_send_denial'
    OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Guardrail denial reservation guard binding differs';
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials
      WHERE request_id=OLD.request_id) AND (TG_OP='DELETE' OR
      OLD.request_id IS DISTINCT FROM NEW.request_id OR
      OLD.user_id IS DISTINCT FROM NEW.user_id OR
      OLD.api_key_id IS DISTINCT FROM NEW.api_key_id OR
      OLD.reserved_micros IS DISTINCT FROM NEW.reserved_micros OR
      OLD.settled_micros IS DISTINCT FROM NEW.settled_micros OR
      OLD.state IS DISTINCT FROM NEW.state OR
      OLD.dispatched_at IS DISTINCT FROM NEW.dispatched_at OR
      OLD.terminal_at IS DISTINCT FROM NEW.terminal_at OR
      OLD.terminal_reason IS DISTINCT FROM NEW.terminal_reason) THEN
    RAISE EXCEPTION 'Guardrail denial proof cannot change'
      USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER user_budget_reservations_guard_guardrail_pre_send_denial
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.user_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.guard_guardrail_pre_send_denial();
CREATE FUNCTION cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'Guardrail denial receipt is immutable'
    USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_immutable';
END;
$reject$;
CREATE TRIGGER shared_key_guardrail_pre_send_denials_no_change
  BEFORE UPDATE OR DELETE ON cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials
  FOR EACH ROW EXECUTE FUNCTION cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change();

-- All three old validators remain exact copies except their narrow released/0 proof branch.
CREATE OR REPLACE FUNCTION cinatoken_economic_outbox.write_shared_key_economic_event_v2(
  p_request_log_id text, p_buyer_charge_basis text,
  p_buyer_usage_certainty text, p_buyer_debit_micros bigint,
  p_outcomes jsonb, p_mode text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $producer$
DECLARE buyer record;
DECLARE pre_send_denial boolean := false;
DECLARE stored record;
DECLARE item jsonb;
DECLARE outcome_count integer;
DECLARE unresolved_count integer := 0;
DECLARE claimed_count integer;
DECLARE seen_ids uuid[] := ARRAY[]::uuid[];
DECLARE seen_indices integer[] := ARRAY[]::integer[];
DECLARE a_id uuid;
DECLARE a_index integer;
DECLARE a_shared_key text;
DECLARE a_transition text;
DECLARE a_quote text;
DECLARE a_usage text;
DECLARE a_input bigint;
DECLARE a_output bigint;
DECLARE a_cache_read bigint;
DECLARE a_cache_write bigint;
DECLARE a_cost_certainty text;
DECLARE a_cost bigint;
DECLARE a_evidence text;
DECLARE a_sha text;
DECLARE a_observed timestamptz;
DECLARE expected_keys text[] := ARRAY[
  'attempt_id','attempt_index','cache_read_tokens','cache_write_tokens',
  'evidence_kind','evidence_sha256','input_tokens','observed_at',
  'output_tokens','provider_cost_certainty','provider_cost_micros',
  'quote_version_id','shared_key_id','transition_id','usage_certainty']::text[];
BEGIN
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR SESSION_USER <> 'cinatoken_gateway_buyer_settlement' THEN
    RAISE EXCEPTION 'Dedicated buyer settlement LOGIN required for economic producer'
      USING ERRCODE='42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Economic producer requires READ COMMITTED'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_isolation';
  END IF;
  IF p_request_log_id IS NULL OR pg_catalog.length(p_request_log_id) NOT BETWEEN 1 AND 128
    OR p_request_log_id <> pg_catalog.btrim(p_request_log_id)
    OR p_mode NOT IN ('create','verify')
    OR p_buyer_charge_basis NOT IN ('actual','reserved','none')
    OR p_buyer_usage_certainty NOT IN ('actual','unknown')
    OR (p_buyer_charge_basis='actual' AND p_buyer_usage_certainty<>'actual')
    OR p_buyer_debit_micros IS NULL
    OR p_buyer_debit_micros NOT BETWEEN 0 AND 9007199254740991
    OR pg_catalog.jsonb_typeof(p_outcomes) <> 'array'
    OR pg_catalog.jsonb_array_length(p_outcomes) NOT BETWEEN 1 AND 1000
    OR pg_catalog.octet_length(p_outcomes::text) > 4194304
    OR p_mode IS NULL OR p_buyer_charge_basis IS NULL
    OR p_buyer_usage_certainty IS NULL OR p_outcomes IS NULL THEN
    RAISE EXCEPTION 'Invalid shared-key economic producer input'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_input';
  END IF;
  outcome_count := pg_catalog.jsonb_array_length(p_outcomes);

  SELECT l.id,l.user_id,l.api_key_id,l.workspace_id,l.charged_cost,
    l.budget_charged_micros,l.input_tokens,l.output_tokens,
    l.cache_read_tokens,l.cache_write_tokens
    INTO buyer FROM cinatoken_gateway.api_key_request_logs AS l
    WHERE l.id=p_request_log_id FOR UPDATE;
  IF NOT FOUND OR buyer.user_id IS NULL OR buyer.workspace_id IS NULL
    OR (p_buyer_charge_basis='none'
      AND (p_buyer_debit_micros<>0 OR buyer.budget_charged_micros<>0
        OR buyer.charged_cost<>0
        OR EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations
          WHERE request_id=p_request_log_id
            AND (p_buyer_usage_certainty<>'unknown'
              OR buyer.input_tokens IS DISTINCT FROM 0
              OR buyer.output_tokens IS DISTINCT FROM 0
              OR buyer.cache_read_tokens IS DISTINCT FROM 0
              OR buyer.cache_write_tokens IS DISTINCT FROM 0
              OR NOT cinatoken_economic_outbox.verified_guardrail_pre_send_denial(p_request_log_id,buyer.user_id,buyer.api_key_id)))))
    OR (p_buyer_charge_basis='actual'
      AND (p_buyer_debit_micros::numeric<>buyer.charged_cost*1000000::numeric
        OR EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations
          WHERE request_id=p_request_log_id
            AND (state<>'settled' OR settled_micros<>p_buyer_debit_micros))))
    OR (p_buyer_charge_basis='reserved'
      AND (p_buyer_usage_certainty<>'unknown'
        OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations
          WHERE request_id=p_request_log_id AND state='expired'
            AND reserved_micros=p_buyer_debit_micros
            AND settled_micros=p_buyer_debit_micros))) THEN
    RAISE EXCEPTION 'Economic producer buyer log or basis differs'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_buyer';
  END IF;
  pre_send_denial := p_buyer_charge_basis='none' AND EXISTS (
    SELECT 1 FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=p_request_log_id);
  SELECT count(*) INTO claimed_count
    FROM cinatoken_economic_quotes.shared_key_dispatch_quote_attempts
    WHERE request_log_id=p_request_log_id;
  IF claimed_count<>outcome_count THEN
    RAISE EXCEPTION 'Economic producer does not cover every quote attempt'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_coverage';
  END IF;

  -- Reject extras and JSON strings masquerading as numeric facts before cast.
  -- SQL table constraints then validate certainty, zero and evidence shapes.
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_outcomes) AS e(value)
  LOOP
    IF pg_catalog.jsonb_typeof(item)<>'object'
      OR ARRAY(SELECT key FROM pg_catalog.jsonb_object_keys(item) AS k(key)
        ORDER BY key COLLATE "C") IS DISTINCT FROM expected_keys
      OR pg_catalog.jsonb_typeof(item->'attempt_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'attempt_index')<>'number'
      OR pg_catalog.jsonb_typeof(item->'shared_key_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'transition_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'quote_version_id')<>'string'
      OR pg_catalog.jsonb_typeof(item->'usage_certainty')<>'string'
      OR pg_catalog.jsonb_typeof(item->'provider_cost_certainty')<>'string'
      OR pg_catalog.jsonb_typeof(item->'evidence_kind')<>'string'
      OR pg_catalog.jsonb_typeof(item->'observed_at')<>'string'
      OR pg_catalog.jsonb_typeof(item->'evidence_sha256') NOT IN ('string','null')
      OR pg_catalog.jsonb_typeof(item->'input_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'output_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'cache_read_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'cache_write_tokens') NOT IN ('number','null')
      OR pg_catalog.jsonb_typeof(item->'provider_cost_micros') NOT IN ('number','null')
      OR (item->>'attempt_id') COLLATE "C" !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (item->>'observed_at') COLLATE "C" !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      OR (item->>'attempt_index')::numeric NOT BETWEEN 1 AND 1000
      OR pg_catalog.mod((item->>'attempt_index')::numeric,1)<>0 THEN
      RAISE EXCEPTION 'Invalid shared-key economic outcome JSON shape'
        USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_outcome_shape';
    END IF;
    FOREACH a_evidence IN ARRAY ARRAY['input_tokens','output_tokens',
      'cache_read_tokens','cache_write_tokens','provider_cost_micros'] LOOP
      IF item->>a_evidence IS NOT NULL
        AND ((item->>a_evidence)::numeric NOT BETWEEN 0 AND 9007199254740991
          OR pg_catalog.mod((item->>a_evidence)::numeric,1)<>0) THEN
        RAISE EXCEPTION 'Unsafe shared-key economic numeric outcome'
          USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_outcome_number';
      END IF;
    END LOOP;
    a_id := (item->>'attempt_id')::uuid;
    a_index := (item->>'attempt_index')::integer;
    a_shared_key := item->>'shared_key_id';
    a_transition := item->>'transition_id';
    a_quote := item->>'quote_version_id';
    a_usage := item->>'usage_certainty';
    a_input := (item->>'input_tokens')::bigint;
    a_output := (item->>'output_tokens')::bigint;
    a_cache_read := (item->>'cache_read_tokens')::bigint;
    a_cache_write := (item->>'cache_write_tokens')::bigint;
    a_cost_certainty := item->>'provider_cost_certainty';
    a_cost := (item->>'provider_cost_micros')::bigint;
    a_evidence := item->>'evidence_kind';
    a_sha := item->>'evidence_sha256';
    a_observed := (item->>'observed_at')::timestamptz;
    IF pre_send_denial AND (a_usage IS DISTINCT FROM 'unknown'
      OR a_cost_certainty IS DISTINCT FROM 'unknown'
      OR a_input IS NOT NULL OR a_output IS NOT NULL
      OR a_cache_read IS NOT NULL OR a_cache_write IS NOT NULL
      OR a_cost IS NOT NULL) THEN
      RAISE EXCEPTION 'Pre-send Guardrail denial cannot claim actual attempt usage'
        USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_attempt_not_actual';
    END IF;
    IF a_id=ANY(seen_ids) OR a_index=ANY(seen_indices)
      OR a_shared_key IS NULL OR a_transition IS NULL OR a_quote IS NULL
      OR a_usage IS NULL OR a_cost_certainty IS NULL OR a_evidence IS NULL
      OR pg_catalog.length(a_shared_key) NOT BETWEEN 1 AND 512
      OR pg_catalog.length(a_transition) NOT BETWEEN 1 AND 512
      OR pg_catalog.length(a_quote) NOT BETWEEN 1 AND 512
      OR a_shared_key<>pg_catalog.btrim(a_shared_key)
      OR a_transition<>pg_catalog.btrim(a_transition)
      OR a_quote<>pg_catalog.btrim(a_quote)
      OR NOT EXISTS (SELECT 1 FROM
          cinatoken_economic_quotes.shared_key_dispatch_quote_attempts AS q
        WHERE q.attempt_id=a_id AND q.request_log_id=p_request_log_id
          AND q.attempt_index=a_index AND q.shared_key_id=a_shared_key
          AND q.transition_id=a_transition AND q.quote_version_id=a_quote) THEN
      RAISE EXCEPTION 'Economic outcome quote identity or uniqueness differs'
        USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_attempt';
    END IF;
    seen_ids:=pg_catalog.array_append(seen_ids,a_id);
    seen_indices:=pg_catalog.array_append(seen_indices,a_index);
    IF a_usage IN ('estimated','unknown') OR a_cost_certainty IN ('estimated','unknown') THEN
      unresolved_count:=unresolved_count+1;
    END IF;

    IF p_mode='verify' THEN
      IF NOT EXISTS (SELECT 1 FROM
          cinatoken_economic_outbox.shared_key_economic_event_attempts AS o
        WHERE o.event_id=p_request_log_id AND o.request_log_id=p_request_log_id
          AND o.attempt_id=a_id AND o.attempt_index=a_index
          AND o.shared_key_id=a_shared_key AND o.transition_id=a_transition
          AND o.quote_version_id=a_quote AND o.usage_certainty=a_usage
          AND o.input_tokens IS NOT DISTINCT FROM a_input
          AND o.output_tokens IS NOT DISTINCT FROM a_output
          AND o.cache_read_tokens IS NOT DISTINCT FROM a_cache_read
          AND o.cache_write_tokens IS NOT DISTINCT FROM a_cache_write
          AND o.provider_cost_certainty=a_cost_certainty
          AND o.provider_cost_micros IS NOT DISTINCT FROM a_cost
          AND o.evidence_kind=a_evidence
          AND o.evidence_sha256 IS NOT DISTINCT FROM a_sha
          AND o.observed_at=a_observed) THEN
        RAISE EXCEPTION 'Conflicting economic outcome replay'
          USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_replay';
      END IF;
    END IF;
  END LOOP;

  IF p_mode='verify' THEN
    SELECT e.event_version,e.buyer_debit_micros,
      e.buyer_charge_basis,e.buyer_usage_certainty,e.buyer_user_id,
      e.buyer_api_key_id,e.workspace_id,e.buyer_charged_cost,
      e.buyer_budget_charged_micros,e.buyer_input_tokens,e.buyer_output_tokens,
      e.buyer_cache_read_tokens,e.buyer_cache_write_tokens,
      e.attempt_count,e.event_certainty INTO stored
      FROM cinatoken_economic_outbox.shared_key_economic_events AS e
      WHERE e.request_log_id=p_request_log_id;
    IF NOT FOUND OR stored.event_version IS DISTINCT FROM 2
      OR stored.buyer_debit_micros IS DISTINCT FROM p_buyer_debit_micros
      OR stored.buyer_charge_basis IS DISTINCT FROM p_buyer_charge_basis
      OR stored.buyer_usage_certainty IS DISTINCT FROM p_buyer_usage_certainty
      OR stored.buyer_user_id IS DISTINCT FROM buyer.user_id
      OR stored.buyer_api_key_id IS DISTINCT FROM buyer.api_key_id
      OR stored.workspace_id IS DISTINCT FROM buyer.workspace_id
      OR stored.buyer_charged_cost IS DISTINCT FROM buyer.charged_cost
      OR stored.buyer_budget_charged_micros IS DISTINCT FROM buyer.budget_charged_micros
      OR stored.buyer_input_tokens IS DISTINCT FROM buyer.input_tokens
      OR stored.buyer_output_tokens IS DISTINCT FROM buyer.output_tokens
      OR stored.buyer_cache_read_tokens IS DISTINCT FROM buyer.cache_read_tokens
      OR stored.buyer_cache_write_tokens IS DISTINCT FROM buyer.cache_write_tokens
      OR stored.attempt_count IS DISTINCT FROM outcome_count
      OR stored.event_certainty IS DISTINCT FROM
        (CASE WHEN unresolved_count=0 THEN 'confirmed' ELSE 'unresolved' END) THEN
      RAISE EXCEPTION 'Conflicting economic event replay'
        USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_replay';
    END IF;
    RETURN 'verified';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM
      cinatoken_economic_outbox.shared_key_economic_producer_tx_markers AS m
    WHERE m.request_log_id=p_request_log_id
      AND m.log_xact_id=pg_catalog.pg_current_xact_id())
    OR EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_economic_events
      WHERE request_log_id=p_request_log_id) THEN
    RAISE EXCEPTION 'Economic event creation requires this buyer-log transaction'
      USING ERRCODE='23514', CONSTRAINT='shared_key_economic_producer_tx';
  END IF;
  INSERT INTO cinatoken_economic_outbox.shared_key_economic_events
    (event_id,request_log_id,event_type,event_version,buyer_user_id,
      buyer_api_key_id,workspace_id,buyer_charge_basis,buyer_usage_certainty,
      buyer_charged_cost,buyer_budget_charged_micros,buyer_input_tokens,
      buyer_output_tokens,buyer_cache_read_tokens,buyer_cache_write_tokens,
      attempt_count,event_certainty,buyer_debit_micros)
    VALUES (p_request_log_id,p_request_log_id,'shared_key_usage_settled',2,
      buyer.user_id,buyer.api_key_id,buyer.workspace_id,p_buyer_charge_basis,
      p_buyer_usage_certainty,buyer.charged_cost,buyer.budget_charged_micros,
      buyer.input_tokens,buyer.output_tokens,buyer.cache_read_tokens,
      buyer.cache_write_tokens,outcome_count,
      CASE WHEN unresolved_count=0 THEN 'confirmed' ELSE 'unresolved' END,
      p_buyer_debit_micros);
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_outcomes) AS e(value)
  LOOP
    INSERT INTO cinatoken_economic_outbox.shared_key_economic_event_attempts
      (event_id,request_log_id,attempt_id,attempt_index,shared_key_id,
        transition_id,quote_version_id,usage_certainty,input_tokens,output_tokens,
        cache_read_tokens,cache_write_tokens,provider_cost_certainty,
        provider_cost_micros,evidence_kind,evidence_sha256,observed_at)
      VALUES (p_request_log_id,p_request_log_id,(item->>'attempt_id')::uuid,
        (item->>'attempt_index')::integer,item->>'shared_key_id',
        item->>'transition_id',item->>'quote_version_id',
        item->>'usage_certainty',(item->>'input_tokens')::bigint,
        (item->>'output_tokens')::bigint,(item->>'cache_read_tokens')::bigint,
        (item->>'cache_write_tokens')::bigint,item->>'provider_cost_certainty',
        (item->>'provider_cost_micros')::bigint,item->>'evidence_kind',
        item->>'evidence_sha256',(item->>'observed_at')::timestamptz);
  END LOOP;
  RETURN 'inserted';
END;
$producer$;
CREATE OR REPLACE FUNCTION cinatoken_economic_outbox.verify_buyer_debit_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,pg_temp AS $verify$
DECLARE r cinatoken_gateway.user_budget_reservations%ROWTYPE;
DECLARE marker cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers%ROWTYPE;
DECLARE reservation_found boolean;
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_verify_buyer_debit_v2'
    OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Buyer debit v2 verification binding differs';
  END IF;
  IF NEW.event_version=1 THEN RETURN NULL; END IF;
  IF NEW.event_version<>2
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Buyer debit v2 requires version 2 and READ COMMITTED'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_protocol';
  END IF;
  SELECT * INTO r FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=NEW.request_log_id FOR UPDATE;
  reservation_found:=FOUND;
  IF reservation_found AND (r.user_id IS DISTINCT FROM NEW.buyer_user_id
    OR r.api_key_id IS DISTINCT FROM NEW.buyer_api_key_id) THEN
    RAISE EXCEPTION 'Buyer debit v2 reservation identity differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_identity';
  END IF;
  IF reservation_found AND NOT (NEW.buyer_charge_basis='none'
    AND cinatoken_economic_outbox.verified_guardrail_pre_send_denial(NEW.request_log_id,NEW.buyer_user_id,NEW.buyer_api_key_id)) THEN
    SELECT * INTO marker FROM
      cinatoken_economic_outbox.shared_key_buyer_settlement_tx_markers
      WHERE request_id=NEW.request_log_id;
    IF NOT FOUND OR marker.settlement_xact_id<>pg_catalog.pg_current_xact_id()
      OR marker.settled_micros IS DISTINCT FROM r.settled_micros
      OR marker.state IS DISTINCT FROM r.state THEN
      RAISE EXCEPTION 'Buyer debit v2 requires same-transaction reservation settlement'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_same_tx';
    END IF;
  END IF;
  IF NEW.buyer_charge_basis='reserved' THEN
    IF NOT reservation_found OR r.state<>'expired' OR r.reserved_micros<>r.settled_micros
      OR r.settled_micros IS DISTINCT FROM NEW.buyer_debit_micros THEN
      RAISE EXCEPTION 'Reserved buyer debit must equal the expired ceiling settlement'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_reserved';
    END IF;
  ELSIF NEW.buyer_charge_basis='actual' THEN
    IF NEW.buyer_usage_certainty<>'actual'
      OR NEW.buyer_debit_micros::numeric
        IS DISTINCT FROM NEW.buyer_charged_cost*1000000::numeric
      OR (reservation_found AND (r.state NOT IN ('settled','expired')
        OR r.settled_micros IS DISTINCT FROM NEW.buyer_debit_micros)) THEN
      RAISE EXCEPTION 'Actual buyer debit differs from settled amount'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_actual';
    END IF;
  ELSIF NEW.buyer_charge_basis='none' THEN
    IF (reservation_found AND NOT
      cinatoken_economic_outbox.verified_guardrail_pre_send_denial(NEW.request_log_id,NEW.buyer_user_id,NEW.buyer_api_key_id))
      OR NEW.buyer_debit_micros<>0
      OR NEW.buyer_charged_cost<>0 OR NEW.buyer_budget_charged_micros<>0 THEN
      RAISE EXCEPTION 'No-charge buyer debit must be zero without reservation'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_none';
    END IF;
  ELSE
    RAISE EXCEPTION 'Buyer debit v2 basis differs'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_debit_v2_basis';
  END IF;
  RETURN NULL;
END;
$verify$;
CREATE OR REPLACE FUNCTION cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $verify$
DECLARE account record;
DECLARE reservation record;
DECLARE admission record;
DECLARE receipt record;
DECLARE needed_spent numeric;
DECLARE needed_release numeric;
BEGIN
  IF TG_RELID<>'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
    OR TG_NAME<>'shared_key_economic_events_verify_buyer_budget_tx'
    OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Buyer budget receipt verifier binding differs';
  END IF;
  IF NEW.event_version=1 THEN RETURN NULL; END IF;
  IF NEW.event_version<>2
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR NOT EXISTS (SELECT 1 FROM
        cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
      WHERE m.request_log_id=NEW.request_log_id
        AND m.log_xact_id=pg_catalog.pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Buyer budget receipt requires same buyer-log transaction'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_protocol';
  END IF;
  SELECT user_id,api_key_id,budget_epoch,reserved_micros
    INTO reservation FROM cinatoken_gateway.user_budget_reservations
    WHERE request_id=NEW.request_log_id;
  SELECT id,budget_epoch INTO account FROM cinatoken_gateway.users
    WHERE id=NEW.buyer_user_id FOR SHARE;
  SELECT budget_epoch,spent_delta_micros,reserved_delta_micros,
      lifecycle_changed INTO receipt
    FROM cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts
    WHERE xact_id=pg_catalog.pg_current_xact_id()
      AND user_id=NEW.buyer_user_id;
  IF account.id IS NULL OR receipt.lifecycle_changed IS TRUE
    OR (receipt.budget_epoch IS NOT NULL
      AND receipt.budget_epoch<>account.budget_epoch) THEN
    RAISE EXCEPTION 'Buyer account identity or epoch changed in event transaction'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_epoch';
  END IF;
  IF reservation.user_id IS NOT NULL THEN
    IF reservation.user_id IS DISTINCT FROM NEW.buyer_user_id
      OR reservation.api_key_id IS DISTINCT FROM NEW.buyer_api_key_id THEN
      RAISE EXCEPTION 'Buyer reservation identity differs from account receipt'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_identity';
    END IF;
    SELECT user_id,api_key_id,budget_epoch,reserved_micros,hold_verified
      INTO admission FROM
      cinatoken_economic_outbox.shared_key_buyer_reservation_admissions
      WHERE request_id=NEW.request_log_id;
    IF admission.hold_verified IS DISTINCT FROM true
      OR admission.user_id IS DISTINCT FROM reservation.user_id
      OR admission.api_key_id IS DISTINCT FROM reservation.api_key_id
      OR admission.budget_epoch IS DISTINCT FROM reservation.budget_epoch
      OR admission.reserved_micros IS DISTINCT FROM reservation.reserved_micros THEN
      RAISE EXCEPTION 'Buyer debit lacks proven reservation admission'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_admission';
    END IF;
    IF reservation.budget_epoch IS DISTINCT FROM account.budget_epoch THEN
      RAISE EXCEPTION 'Old-epoch reservation hold is not a buyer spend receipt'
        USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_old_epoch';
    END IF;
  END IF;
  SELECT COALESCE(pg_catalog.sum(e.buyer_debit_micros),0)::numeric,
    COALESCE(pg_catalog.sum(r.reserved_micros) FILTER
      (WHERE r.request_id IS NOT NULL AND e.buyer_charge_basis<>'none'),0)::numeric
    INTO needed_spent,needed_release
    FROM cinatoken_economic_outbox.shared_key_economic_events e
    JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
      ON m.request_log_id=e.request_log_id
    LEFT JOIN cinatoken_gateway.user_budget_reservations r
      ON r.request_id=e.request_log_id
    WHERE m.log_xact_id=pg_catalog.pg_current_xact_id()
      AND e.event_version=2 AND e.buyer_user_id=NEW.buyer_user_id;
  IF COALESCE(receipt.spent_delta_micros,0)<needed_spent
    OR COALESCE(receipt.reserved_delta_micros,0)>-needed_release THEN
    RAISE EXCEPTION 'Buyer debit lacks same-transaction net account charge or hold release'
      USING ERRCODE='23514',CONSTRAINT='shared_key_buyer_receipt_net_debit';
  END IF;
  RETURN NULL;
END;
$verify$;
REVOKE ALL ON TABLE cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;
REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.capture_guardrail_pre_send_denial(),
  cinatoken_economic_outbox.verified_guardrail_pre_send_denial(text,text,text),
  cinatoken_economic_outbox.guard_guardrail_pre_send_denial(),
  cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;

-- Serialize Guardrail insertion with the ordinary-release proof for this request.
-- Without the shared advisory key, an uncommitted Guardrail INSERT could be
-- invisible to release and commit after the zero-buyer event.
CREATE FUNCTION cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_RELID<>'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass
    OR TG_NAME<>'guardrail_budget_reservations_guard_pre_send_denial'
    OR TG_LEVEL<>'ROW' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'Guardrail reservation denial guard binding differs';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(NEW.request_id));
  IF EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials
      WHERE request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Guardrail reservation cannot follow pre-send denial proof'
      USING ERRCODE='23514',CONSTRAINT='shared_key_guardrail_denial_guardrail_late';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER guardrail_budget_reservations_guard_pre_send_denial
  BEFORE INSERT OR UPDATE ON cinatoken_gateway.guardrail_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_economic_outbox.guard_guardrail_reservation_after_denial();
REVOKE ALL ON FUNCTION
  cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()
  FROM PUBLIC,cinatoken_gateway_runtime,cinatoken_gateway_buyer_settlement;

DO $postflight$
DECLARE migrator_oid oid; runtime_oid oid; buyer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_buyer_settlement';
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)'::pg_catalog.regprocedure,
    'cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure,
    'cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)
    AND p.proowner=migrator_oid AND p.prosecdef AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
    AND pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=
      CASE p.proname
        WHEN 'write_shared_key_economic_event_v2' THEN '60a5e195951633119537e913169abb5e'
        WHEN 'verify_buyer_debit_v2' THEN '4fad800586f0f75bf00f254c79fd392d'
        WHEN 'verify_buyer_budget_tx_receipt' THEN '84ae6d785faee4b5ea334f5d3ba29a7e'
        ELSE '' END)<>3
    OR NOT pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid='cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials'::pg_catalog.regclass
        AND (c.relowner<>migrator_oid OR acl.grantee<>migrator_oid))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t WHERE
      NOT t.tgisinternal AND t.tgenabled='O' AND (
        (t.tgname='user_budget_reservations_capture_guardrail_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.capture_guardrail_pre_send_denial()'::pg_catalog.regprocedure
          AND t.tgtype=17)
        OR (t.tgname='user_budget_reservations_guard_guardrail_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.guard_guardrail_pre_send_denial()'::pg_catalog.regprocedure
          AND t.tgtype=27)
        OR (t.tgname='shared_key_guardrail_pre_send_denials_no_change'
          AND t.tgrelid='cinatoken_economic_outbox.shared_key_guardrail_pre_send_denials'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.reject_guardrail_pre_send_denial_change()'::pg_catalog.regprocedure
          AND t.tgtype=27)
        OR (t.tgname='guardrail_budget_reservations_guard_pre_send_denial'
          AND t.tgrelid='cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass
          AND t.tgfoid='cinatoken_economic_outbox.guard_guardrail_reservation_after_denial()'::pg_catalog.regprocedure
          AND t.tgtype=23)))<>4
  THEN RAISE EXCEPTION 'Guardrail denial v348 postflight differs'; END IF;
END;
$postflight$;
