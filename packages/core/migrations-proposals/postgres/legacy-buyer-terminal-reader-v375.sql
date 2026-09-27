-- REVIEW ONLY / DEFAULT OFF. A separate LOGIN may confirm one already
-- committed narrow v371/v372 buyer transaction. No write or retry occurs.
-- Install only after the PG73 schema, v2 economic producer/budget receipt,
-- v368/v371 buyer functions and their ACLs have been reviewed together.
-- The caller supplies the exact expected economic facts. This does not
-- authenticate those facts against an independent Provider result or bill.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; reader_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_terminal_reader';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.legacy_buyer_terminal_reader_v375_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR reader_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=reader_oid)
      IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=reader_oid OR member=reader_oid)
    OR pg_catalog.to_regnamespace('cinatoken_buyer_terminal') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_buyer_terminal.read_windowed_v375(text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)')
      IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_economic_events') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_economic_event_attempts') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.settle_legacy_buyer_windowed_v371(text,text)') IS NULL
    OR pg_catalog.has_schema_privilege(reader_oid,'cinatoken_gateway','USAGE')
    OR pg_catalog.has_schema_privilege(reader_oid,
      'cinatoken_economic_outbox','USAGE')
    OR pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_gateway.api_key_request_logs','SELECT')
    OR pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_economic_outbox.shared_key_economic_events','SELECT')
  THEN RAISE EXCEPTION 'legacy buyer terminal reader v375 dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE SCHEMA cinatoken_buyer_terminal
  AUTHORIZATION cinatoken_gateway_migrator;
REVOKE ALL ON SCHEMA cinatoken_buyer_terminal FROM PUBLIC;

-- A missing log or pruned transaction receipt stays unconfirmed. A committed
-- log with incompatible facts is a conflict. Neither status authorizes a
-- second debit. The function has no DML and returns no account/Provider data.
CREATE FUNCTION cinatoken_buyer_terminal.read_windowed_v375(
  p_request_id text,p_user_id text,p_api_key_id text,p_workspace_id text,
  p_charge_micros bigint,p_input_tokens bigint,p_output_tokens bigint,
  p_cache_read_tokens bigint,p_cache_write_tokens bigint,p_reason text,
  p_outcomes jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $read$
DECLARE stored record; actual_attempts integer; expected_attempts integer;
DECLARE guardrail_rows integer; guardrail_matches boolean;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_buyer_terminal_reader'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_request_id<>pg_catalog.btrim(p_request_id)
    OR p_user_id IS NULL OR pg_catalog.length(p_user_id) NOT BETWEEN 1 AND 128
    OR p_api_key_id IS NULL OR pg_catalog.length(p_api_key_id) NOT BETWEEN 1 AND 128
    OR p_workspace_id IS NULL OR pg_catalog.length(p_workspace_id) NOT BETWEEN 1 AND 128
    OR p_reason IS NULL OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 128
    OR p_reason<>pg_catalog.btrim(p_reason)
    OR p_charge_micros IS NULL
    OR p_charge_micros NOT BETWEEN 0 AND 9007199254740991
    OR p_input_tokens IS NULL OR p_input_tokens<0
    OR p_output_tokens IS NULL OR p_output_tokens<0
    OR p_cache_read_tokens IS NULL OR p_cache_read_tokens<0
    OR p_cache_write_tokens IS NULL OR p_cache_write_tokens<0
    OR p_outcomes IS NULL OR pg_catalog.jsonb_typeof(p_outcomes)<>'array'
    OR pg_catalog.jsonb_array_length(p_outcomes) NOT BETWEEN 1 AND 1000
    OR pg_catalog.octet_length(p_outcomes::text)>4194304
  THEN RAISE EXCEPTION 'invalid legacy buyer terminal read'
    USING ERRCODE='23514',CONSTRAINT='legacy_buyer_terminal_input_v375'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_outcomes)
      AS o(item) WHERE pg_catalog.jsonb_typeof(o.item)<>'object'
        OR ARRAY(SELECT key FROM pg_catalog.jsonb_object_keys(o.item)
          AS k(key) ORDER BY key COLLATE "C") IS DISTINCT FROM ARRAY[
          'attempt_id','attempt_index','cache_read_tokens',
          'cache_write_tokens','evidence_kind','evidence_sha256',
          'input_tokens','observed_at','output_tokens',
          'provider_cost_certainty','provider_cost_micros',
          'quote_version_id','shared_key_id','transition_id',
          'usage_certainty']::text[]) THEN
    RAISE EXCEPTION 'invalid legacy buyer terminal outcomes'
      USING ERRCODE='23514',CONSTRAINT='legacy_buyer_terminal_outcomes_v375';
  END IF;

  SELECT l.id,l.user_id,l.api_key_id,l.workspace_id,l.status,l.is_byok,
      l.charged_cost,l.budget_charged_micros,l.input_tokens,l.output_tokens,
      l.cache_read_tokens,l.cache_write_tokens,
      e.event_id,e.event_version,e.event_type,e.buyer_user_id,
      e.buyer_api_key_id,e.workspace_id AS event_workspace_id,
      e.buyer_charge_basis,e.buyer_usage_certainty,e.buyer_debit_micros,
      e.buyer_charged_cost,e.buyer_budget_charged_micros,
      e.buyer_input_tokens,e.buyer_output_tokens,
      e.buyer_cache_read_tokens,e.buyer_cache_write_tokens,
      e.attempt_count,e.event_certainty,m.log_xact_id,
      b.xact_id AS budget_xact_id,b.user_id AS budget_user_id,
      b.budget_epoch AS receipt_epoch,b.spent_delta_micros,
      b.reserved_delta_micros,b.lifecycle_changed,
      r.user_id AS hold_user_id,r.api_key_id AS hold_api_key_id,
      r.budget_epoch AS hold_epoch,r.reserved_micros AS held_micros,
      r.settled_micros AS hold_settled_micros,r.state AS hold_state,
      r.terminal_reason AS hold_reason
    INTO stored
    FROM cinatoken_gateway.api_key_request_logs l
    LEFT JOIN cinatoken_economic_outbox.shared_key_economic_events e
      ON e.request_log_id=l.id
    LEFT JOIN cinatoken_economic_outbox.shared_key_economic_producer_tx_markers m
      ON m.request_log_id=l.id
    LEFT JOIN cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts b
      ON b.xact_id=m.log_xact_id AND b.user_id=e.buyer_user_id
    LEFT JOIN cinatoken_gateway.user_budget_reservations r
      ON r.request_id=l.id
    WHERE l.id=p_request_id;
  IF NOT FOUND THEN RETURN 'unconfirmed'; END IF;
  IF stored.log_xact_id IS NULL OR stored.event_id IS NULL
  THEN RETURN 'conflict'; END IF;
  IF stored.budget_xact_id IS NULL THEN RETURN 'unconfirmed'; END IF;
  IF stored.user_id IS DISTINCT FROM p_user_id
    OR stored.api_key_id IS DISTINCT FROM p_api_key_id
    OR stored.workspace_id IS DISTINCT FROM p_workspace_id
    OR stored.status IS DISTINCT FROM 'success'
    OR stored.is_byok IS DISTINCT FROM false
    OR stored.charged_cost*1000000::numeric IS DISTINCT FROM p_charge_micros::numeric
    OR stored.budget_charged_micros IS DISTINCT FROM p_charge_micros
    OR stored.input_tokens IS DISTINCT FROM p_input_tokens
    OR stored.output_tokens IS DISTINCT FROM p_output_tokens
    OR stored.cache_read_tokens IS DISTINCT FROM p_cache_read_tokens
    OR stored.cache_write_tokens IS DISTINCT FROM p_cache_write_tokens
    OR stored.event_id IS DISTINCT FROM p_request_id
    OR stored.event_version IS DISTINCT FROM 2
    OR stored.event_type IS DISTINCT FROM 'shared_key_usage_settled'
    OR stored.buyer_user_id IS DISTINCT FROM p_user_id
    OR stored.buyer_api_key_id IS DISTINCT FROM p_api_key_id
    OR stored.event_workspace_id IS DISTINCT FROM p_workspace_id
    OR stored.buyer_charge_basis IS DISTINCT FROM 'actual'
    OR stored.buyer_usage_certainty IS DISTINCT FROM 'actual'
    OR stored.buyer_debit_micros IS DISTINCT FROM p_charge_micros
    OR stored.buyer_charged_cost IS DISTINCT FROM stored.charged_cost
    OR stored.buyer_budget_charged_micros IS DISTINCT FROM p_charge_micros
    OR stored.buyer_input_tokens IS DISTINCT FROM p_input_tokens
    OR stored.buyer_output_tokens IS DISTINCT FROM p_output_tokens
    OR stored.buyer_cache_read_tokens IS DISTINCT FROM p_cache_read_tokens
    OR stored.buyer_cache_write_tokens IS DISTINCT FROM p_cache_write_tokens
    OR stored.budget_xact_id IS DISTINCT FROM stored.log_xact_id
    OR stored.budget_user_id IS DISTINCT FROM p_user_id
    OR stored.receipt_epoch IS DISTINCT FROM stored.hold_epoch
    OR stored.spent_delta_micros IS DISTINCT FROM p_charge_micros::numeric
    OR stored.reserved_delta_micros IS DISTINCT FROM -stored.held_micros::numeric
    OR stored.lifecycle_changed IS DISTINCT FROM false
    OR stored.hold_user_id IS DISTINCT FROM p_user_id
    OR stored.hold_api_key_id IS DISTINCT FROM p_api_key_id
    OR stored.held_micros IS NULL OR stored.held_micros<1
    OR stored.held_micros<p_charge_micros
    OR stored.hold_settled_micros IS DISTINCT FROM p_charge_micros
    OR stored.hold_state IS DISTINCT FROM 'settled'
    OR stored.hold_reason IS DISTINCT FROM p_reason
  THEN RETURN 'conflict'; END IF;

  SELECT pg_catalog.count(*)::integer,
      pg_catalog.bool_and(g.workspace_id=p_workspace_id
        AND g.state='settled' AND g.settlement_basis='charged'
        AND g.settled_micros=p_charge_micros
        AND g.terminal_reason=p_reason)
    INTO guardrail_rows,guardrail_matches
    FROM cinatoken_gateway.guardrail_budget_reservations g
    WHERE g.request_id=p_request_id;
  IF guardrail_rows NOT BETWEEN 1 AND 32
    OR guardrail_matches IS DISTINCT FROM true THEN RETURN 'conflict'; END IF;

  SELECT pg_catalog.count(*)::integer INTO actual_attempts
    FROM cinatoken_economic_outbox.shared_key_economic_event_attempts a
    WHERE a.request_log_id=p_request_id AND a.event_id=p_request_id;
  SELECT pg_catalog.count(*)::integer INTO expected_attempts
    FROM pg_catalog.jsonb_array_elements(p_outcomes);
  IF actual_attempts IS DISTINCT FROM stored.attempt_count
    OR expected_attempts IS DISTINCT FROM actual_attempts
    OR EXISTS (SELECT 1 FROM
      cinatoken_economic_outbox.shared_key_economic_event_attempts a
      WHERE a.request_log_id=p_request_id AND a.event_id=p_request_id
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(p_outcomes)
          AS x(attempt_id uuid,attempt_index integer,shared_key_id text,
            transition_id text,quote_version_id text,usage_certainty text,
            input_tokens bigint,output_tokens bigint,cache_read_tokens bigint,
            cache_write_tokens bigint,provider_cost_certainty text,
            provider_cost_micros bigint,evidence_kind text,
            evidence_sha256 text,observed_at timestamptz)
          WHERE x.attempt_id=a.attempt_id
            AND x.attempt_index=a.attempt_index
            AND x.shared_key_id=a.shared_key_id
            AND x.transition_id=a.transition_id
            AND x.quote_version_id=a.quote_version_id
            AND x.usage_certainty=a.usage_certainty
            AND x.input_tokens IS NOT DISTINCT FROM a.input_tokens
            AND x.output_tokens IS NOT DISTINCT FROM a.output_tokens
            AND x.cache_read_tokens IS NOT DISTINCT FROM a.cache_read_tokens
            AND x.cache_write_tokens IS NOT DISTINCT FROM a.cache_write_tokens
            AND x.provider_cost_certainty=a.provider_cost_certainty
            AND x.provider_cost_micros IS NOT DISTINCT FROM a.provider_cost_micros
            AND x.evidence_kind=a.evidence_kind
            AND x.evidence_sha256 IS NOT DISTINCT FROM a.evidence_sha256
            AND x.observed_at=a.observed_at))
  THEN RETURN 'conflict'; END IF;
  RETURN 'confirmed';
END;
$read$;
REVOKE ALL ON FUNCTION cinatoken_buyer_terminal.read_windowed_v375(
  text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA cinatoken_buyer_terminal
  TO cinatoken_gateway_buyer_terminal_reader;
GRANT EXECUTE ON FUNCTION cinatoken_buyer_terminal.read_windowed_v375(
  text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)
  TO cinatoken_gateway_buyer_terminal_reader;

DO $postflight$
DECLARE reader_oid oid;
BEGIN
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_terminal_reader';
  IF NOT pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_buyer_terminal.read_windowed_v375(text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)',
      'EXECUTE')
    OR NOT pg_catalog.has_schema_privilege(reader_oid,
      'cinatoken_buyer_terminal','USAGE')
    OR pg_catalog.has_schema_privilege(reader_oid,
      'cinatoken_gateway','USAGE')
    OR pg_catalog.has_schema_privilege(reader_oid,
      'cinatoken_economic_outbox','USAGE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
          pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.relnamespace='cinatoken_buyer_terminal'::pg_catalog.regnamespace
        AND acl.grantee=reader_oid)
  THEN RAISE EXCEPTION 'legacy buyer terminal reader v375 ACL differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
