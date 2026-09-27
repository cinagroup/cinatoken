-- REVIEW ONLY. Install in an owned PG73 test database after the v340/v341/v343
-- producer, v344 buyer receipt, and v346 buyer privilege split. It is not a
-- formal migration or deployable cutover. Apply as the direct migrator LOGIN
-- in one transaction with:
--   SET LOCAL cinatoken.shared_key_economic_buyer_login_activation = 'reviewed-v1';
-- A generated, static copy of the six-argument v2 producer appears below.
-- Its only body differences from v343 are the SESSION_USER equality and the
-- matching error text. Source hashes in preflight/postflight pin that promise.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users,
  cinatoken_gateway.user_earnings,
  cinatoken_gateway.shared_key_earnings,
  cinatoken_gateway.portal_ledger_entries,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.api_key_request_logs,
  cinatoken_economic_quotes.shared_key_dispatch_quote_attempts,
  cinatoken_economic_outbox.shared_key_economic_events,
  cinatoken_economic_outbox.shared_key_economic_event_attempts,
  cinatoken_economic_outbox.shared_key_economic_producer_tx_markers,
  cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts,
  cinatoken_economic_outbox.shared_key_buyer_reservation_admissions
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
DECLARE v2_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT pg_catalog.to_regprocedure(
    'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)')
    INTO v2_oid;
  IF pg_catalog.current_setting(
      'cinatoken.shared_key_economic_buyer_login_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR buyer_oid IS NULL
    OR v2_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_economic_outbox') IS DISTINCT FROM migrator_oid
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
        WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=buyer_oid)
        IS DISTINCT FROM true
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        FROM pg_catalog.pg_roles WHERE oid=runtime_oid) IS DISTINCT FROM true
    OR pg_catalog.pg_has_role(runtime_oid,buyer_oid,'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,runtime_oid,'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,
      'pg_read_all_data'::pg_catalog.regrole,'MEMBER')
    OR pg_catalog.pg_has_role(buyer_oid,
      'pg_write_all_data'::pg_catalog.regrole,'MEMBER')
    OR pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_economic_outbox','USAGE')
    OR pg_catalog.has_schema_privilege(runtime_oid,
      'cinatoken_economic_outbox','CREATE')
    OR pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_economic_outbox','CREATE')
    OR NOT pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_gateway','USAGE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.users','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_column_privilege(runtime_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.user_budget_reservations','INSERT,UPDATE,DELETE')
    OR NOT pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_spent','UPDATE')
    OR pg_catalog.has_column_privilege(buyer_oid,
      'cinatoken_gateway.users','budget_max','UPDATE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.user_earnings','INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.shared_key_earnings','INSERT')
    OR pg_catalog.has_table_privilege(buyer_oid,
      'cinatoken_gateway.portal_ledger_entries','INSERT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_reservation_admissions'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_reservation_admissions'::pg_catalog.regclass)
      AND (pg_catalog.has_table_privilege(runtime_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')
        OR pg_catalog.has_table_privilege(buyer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')))
    OR NOT pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(runtime_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,v2_oid,'EXECUTE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid IN (
        'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)'::pg_catalog.regprocedure,
        v2_oid)
        AND p.proowner=migrator_oid AND l.lanname='plpgsql'
        AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND p.procost=100
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))=
          CASE WHEN p.oid=v2_oid THEN 'a19fc565049023a5cde1079d4e33b36e'
          ELSE '42c713346904745b2c2cb1e0828bcc93' END)<>2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)'::pg_catalog.regprocedure,
        v2_oid)
        AND (acl.grantee NOT IN (migrator_oid,runtime_oid)
          OR (acl.grantee=runtime_oid AND
            (acl.privilege_type<>'EXECUTE' OR acl.is_grantable))))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_gateway.users'::pg_catalog.regclass
        AND tgname='users_capture_shared_key_buyer_budget_tx'
        AND tgenabled='O' AND NOT tgdeferrable
        AND tgfoid='cinatoken_economic_outbox.capture_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_verify_buyer_budget_tx'
        AND tgenabled='O' AND tgdeferrable AND tginitdeferred
        AND tgfoid='cinatoken_economic_outbox.verify_buyer_budget_tx_receipt()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass
        AND tgname='shared_key_economic_events_verify_buyer_debit_v2'
        AND tgenabled='O' AND tgdeferrable AND tginitdeferred
        AND tgfoid='cinatoken_economic_outbox.verify_buyer_debit_v2()'::pg_catalog.regprocedure)
  THEN
    RAISE EXCEPTION 'Economic buyer LOGIN handoff activation or dependency differs';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION cinatoken_economic_outbox.write_shared_key_economic_event_v2(
  p_request_log_id text, p_buyer_charge_basis text,
  p_buyer_usage_certainty text, p_buyer_debit_micros bigint,
  p_outcomes jsonb, p_mode text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $producer$
DECLARE buyer record;
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
          WHERE request_id=p_request_log_id)))
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

-- Disable the old v1 entry point for ordinary runtime. The buyer LOGIN gets
-- the existing six-argument call shape used by the critical writer, and no
-- direct private-table privileges.
REVOKE EXECUTE ON FUNCTION
  cinatoken_economic_outbox.write_shared_key_economic_event(
    text,text,text,jsonb,text),
  cinatoken_economic_outbox.write_shared_key_economic_event_v2(
    text,text,text,bigint,jsonb,text)
  FROM cinatoken_gateway_runtime;
REVOKE EXECUTE ON FUNCTION
  cinatoken_economic_outbox.write_shared_key_economic_event_v2(
    text,text,text,bigint,jsonb,text)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA cinatoken_economic_outbox
  TO cinatoken_gateway_buyer_settlement;
GRANT EXECUTE ON FUNCTION
  cinatoken_economic_outbox.write_shared_key_economic_event_v2(
    text,text,text,bigint,jsonb,text)
  TO cinatoken_gateway_buyer_settlement;

DO $postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE buyer_oid oid;
DECLARE v2_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO buyer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_buyer_settlement';
  SELECT 'cinatoken_economic_outbox.write_shared_key_economic_event_v2(text,text,text,bigint,jsonb,text)'::pg_catalog.regprocedure
    INTO v2_oid;
  IF pg_catalog.has_function_privilege(runtime_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(buyer_oid,v2_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(buyer_oid,
      'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)',
      'EXECUTE')
    OR NOT pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_economic_outbox','USAGE')
    OR pg_catalog.has_schema_privilege(buyer_oid,
      'cinatoken_economic_outbox','CREATE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=v2_oid AND p.proowner=migrator_oid
        AND l.lanname='plpgsql' AND p.prosecdef AND p.provolatile='v'
        AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND p.procost=100
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10)))
          ='132180ac28c093adc3fb07c38a769cab')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (
        'cinatoken_economic_outbox.write_shared_key_economic_event(text,text,text,jsonb,text)'::pg_catalog.regprocedure,
        v2_oid)
      AND (acl.grantee NOT IN (migrator_oid,buyer_oid)
        OR (acl.grantee=buyer_oid AND
          (p.oid<>v2_oid OR acl.privilege_type<>'EXECUTE'
            OR acl.is_grantable))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_economic_outbox.shared_key_economic_events'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_event_attempts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_economic_producer_tx_markers'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts'::pg_catalog.regclass,
        'cinatoken_economic_outbox.shared_key_buyer_reservation_admissions'::pg_catalog.regclass)
      AND (pg_catalog.has_table_privilege(runtime_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')
        OR pg_catalog.has_table_privilege(buyer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE')))
  THEN
    RAISE EXCEPTION 'Economic buyer LOGIN handoff postflight differs';
  END IF;
END;
$postflight$;
