-- REVIEW ONLY. Derive a strict flat-text Chat admission from the committed
-- v360 COMPLETE quote. Apply after v350, v351, v356, v357, v359 and v360 in
-- one direct-migrator transaction with
--   SET LOCAL cinatoken.complete_text_budget_admission_activation='reviewed-v1'.
-- This revokes the old amount-taking reserve entrypoints from the separate
-- budget-admission LOGIN. Existing opt-in callers must cut over atomically.
-- Admission is not a dispatch grant, secret-holder check, or settlement.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923561);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_quotes_v360,
  cinatoken_gateway.complete_text_quote_routes_v360,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; admission_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO admission_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_budget_admission';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_budget_admission_activation',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR admission_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
       AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
       AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=admission_oid)
         IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=admission_oid OR member=admission_oid)
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_admissions_v361') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)')
       IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text)') IS NULL
    OR NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(admission_oid,
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_quotes_v360'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_quote_routes_v360'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(admission_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(admission_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
  THEN RAISE EXCEPTION 'complete text admission v361 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_admissions_v361 (
  request_id text PRIMARY KEY REFERENCES
    cinatoken_gateway.complete_text_quotes_v360(request_id),
  quote_id uuid NOT NULL UNIQUE REFERENCES
    cinatoken_gateway.complete_text_quotes_v360(quote_id),
  final_body_sha256 text NOT NULL CHECK (final_body_sha256 ~ '^[0-9a-f]{64}$'),
  reserved_micros bigint NOT NULL CHECK (reserved_micros BETWEEN 1 AND 9007199254740991),
  ordinary_status text NOT NULL CHECK (ordinary_status IN ('reserved','unlimited')),
  guardrail_intents jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(guardrail_intents)='array'
    AND pg_catalog.jsonb_array_length(guardrail_intents) BETWEEN 0 AND 7),
  guardrail_count integer NOT NULL CHECK (guardrail_count BETWEEN 0 AND 7),
  admitted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>admitted_at)
);
CREATE FUNCTION cinatoken_gateway.reject_complete_text_admission_mutation_v361()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text admission v361 is insert-only'
    USING ERRCODE='P0001';
END;
$immutable$;
CREATE TRIGGER complete_text_admissions_v361_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_admissions_v361
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_admission_mutation_v361();

CREATE FUNCTION cinatoken_gateway.admit_complete_flat_text_quote_v361(
  p_request_id text,p_quote_id uuid,p_intents jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $admit$
DECLARE q record; cap record; key_row record; user_row record; workspace_row record;
DECLARE manifest record; prior record; ordinary record; guardrail record;
DECLARE held record; n integer; manifest_count integer; candidate_count integer;
DECLARE active_count integer; max_ceiling bigint; amount bigint;
DECLARE server_now timestamptz; hold_expires_at timestamptz;
DECLARE rejection text;
BEGIN
  n:=CASE WHEN pg_catalog.jsonb_typeof(p_intents)='array'
    THEN pg_catalog.jsonb_array_length(p_intents) ELSE -1 END;
  IF SESSION_USER<>'cinatoken_gateway_budget_admission'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_quote_id IS NULL OR n NOT BETWEEN 0 AND 7
  THEN RAISE EXCEPTION 'invalid complete text admission call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_admission_call_v361'; END IF;

  -- The same request advisory key is used by the v351 reservation path.
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(p_request_id));
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=p_request_id AND quote_id=p_quote_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_quote'); END IF;
  SELECT * INTO cap FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=q.request_id FOR SHARE;
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys
    WHERE id=q.api_key_id FOR SHARE;
  SELECT * INTO user_row FROM cinatoken_gateway.users
    WHERE id=q.user_id FOR SHARE;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces
    WHERE id=q.workspace_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.request_id IS NULL
    OR cap.state<>'claimed' OR cap.invalidated_at IS NOT NULL
    OR cap.body_sha256 IS DISTINCT FROM q.original_body_sha256
    OR cap.api_key_id IS DISTINCT FROM q.api_key_id
    OR cap.user_id IS DISTINCT FROM q.user_id
    OR cap.workspace_id IS DISTINCT FROM q.workspace_id
    OR cap.budget_epoch IS DISTINCT FROM q.budget_epoch
    OR cap.key_limit_epoch IS DISTINCT FROM q.key_limit_epoch
    OR key_row.id IS NULL OR key_row.status IS DISTINCT FROM 'active'
    OR key_row.key_hash IS DISTINCT FROM cap.key_hash
    OR key_row.key IS DISTINCT FROM 'hashref:'||cap.key_hash
    OR key_row.user_id IS DISTINCT FROM q.user_id
    OR key_row.workspace_id IS DISTINCT FROM q.workspace_id
    OR key_row.limit_epoch IS DISTINCT FROM q.key_limit_epoch
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR user_row.id IS NULL OR user_row.status IS DISTINCT FROM 'active'
    OR user_row.budget_epoch IS DISTINCT FROM q.budget_epoch
    OR user_row.charged_cost_factors IS NOT NULL
    OR workspace_row.id IS NULL OR workspace_row.status IS DISTINCT FROM 'active'
    OR workspace_row.scope_type IS DISTINCT FROM 'personal'
    OR workspace_row.personal_owner_user_id IS DISTINCT FROM q.user_id
    OR q.credential_class IS DISTINCT FROM 'platform'
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;

  -- Broad predicate locks are deliberately conservative for this review
  -- candidate. They prevent active-route, credential, budget-config and BYOK
  -- phantoms while the manifest and source-intent set are checked.
  LOCK TABLE cinatoken_gateway.models,cinatoken_gateway.model_surfaces,
    cinatoken_gateway.model_routes,cinatoken_gateway.route_pools,
    cinatoken_gateway.providers,cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.byok_keys,cinatoken_gateway.guardrails,
    cinatoken_gateway.guardrail_versions,
    cinatoken_gateway.guardrail_assignments,
    cinatoken_gateway.workspace_budgets
    IN SHARE MODE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.byok_keys b
      WHERE b.workspace_id=q.workspace_id AND b.deleted_at IS NULL
        AND NOT b.disabled)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;

  candidate_count:=pg_catalog.jsonb_array_length(q.ordered_model_ids);
  SELECT pg_catalog.count(*)::integer,
    pg_catalog.max(per_attempt_ceiling_micros)
    INTO manifest_count,max_ceiling
    FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id;
  IF candidate_count NOT BETWEEN 1 AND 8 OR manifest_count<>q.route_count
    OR manifest_count<1 OR max_ceiling IS NULL OR max_ceiling<=0
    OR max_ceiling<>q.max_per_attempt_ceiling_micros
    OR q.three_attempt_ceiling_micros<>max_ceiling*3
  THEN RETURN pg_catalog.jsonb_build_object('status','invalid_manifest'); END IF;
  amount:=q.three_attempt_ceiling_micros;
  FOR manifest IN SELECT * FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id ORDER BY candidate_index,route_target_id
  LOOP
    IF manifest.candidate_index>=candidate_count
      OR manifest.model_id IS DISTINCT FROM
        q.ordered_model_ids->>manifest.candidate_index
      OR manifest.credential_class IS DISTINCT FROM 'platform'
      OR manifest.credential_id IS DISTINCT FROM manifest.provider_id
      OR manifest.source_sha256 IS DISTINCT FROM pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          manifest.source_snapshot::text,'UTF8')),'hex')
      OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.model_routes r
        JOIN cinatoken_gateway.route_pools rp
          ON rp.id=r.route_pool_id AND rp.model_id=r.model_id
            AND rp.route_group=r.route_group
        JOIN cinatoken_gateway.providers po ON po.id=r.provider_id
        JOIN cinatoken_gateway.model_endpoint_routes er
          ON er.route_target_id=r.id
        JOIN cinatoken_gateway.model_endpoints e
          ON e.id=er.endpoint_id AND e.model_id=r.model_id
            AND e.provider_id=r.provider_id
        JOIN cinatoken_gateway.route_source_generations_v359 f
          ON f.route_target_id=r.id
        WHERE r.id=manifest.route_target_id AND r.model_id=manifest.model_id
          AND r.provider_id=manifest.provider_id
          AND r.status='active' AND r.route_group='default'
          AND r.upstream_protocol='openai' AND r.upstream_operation='chat'
          AND r.adapter='passthrough' AND r.price_override IS NULL
          AND r.custom_params IS NULL AND r.routing_metadata IS NULL
          AND rp.status='active' AND po.status='active'
          AND po.shared_channel_type IS NULL AND po.api_key LIKE 'enc:v2:%'
          AND pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(po.api_key,'UTF8')),'hex')
              =manifest.provider_ciphertext_sha256
          AND e.id=manifest.endpoint_id AND e.status='verified'
          AND e.expires_at>server_now
          AND f.generation=manifest.source_generation
          AND f.verified_generation=f.generation
          AND f.attested_source_sha256=manifest.attested_source_sha256
          AND f.verified_subject_fingerprint=er.subject_fingerprint)
    THEN RETURN pg_catalog.jsonb_build_object('status','stale_manifest'); END IF;
  END LOOP;
  -- Every active route for every candidate must still have a manifest row.
  SELECT pg_catalog.count(*)::integer INTO active_count
    FROM pg_catalog.jsonb_array_elements_text(q.ordered_model_ids)
      WITH ORDINALITY AS candidates(model_id,ordinal)
    JOIN cinatoken_gateway.model_routes r
      ON r.model_id=candidates.model_id AND r.status='active';
  IF active_count<>manifest_count OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements_text(q.ordered_model_ids)
      WITH ORDINALITY AS candidates(model_id,ordinal)
    JOIN cinatoken_gateway.model_routes r
      ON r.model_id=candidates.model_id AND r.status='active'
    WHERE NOT EXISTS (SELECT 1
      FROM cinatoken_gateway.complete_text_quote_routes_v360 m
      WHERE m.quote_id=q.quote_id AND m.candidate_index=candidates.ordinal-1
        AND m.route_target_id=r.id))
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.model_surfaces s
      JOIN cinatoken_gateway.route_pools rp ON rp.id=s.route_pool_id
      WHERE s.model_id IN (SELECT value FROM pg_catalog.jsonb_array_elements_text(
          q.ordered_model_ids)) AND lower(s.route_group)='default'
        AND lower(s.request_protocol)='openai'
        AND s.request_operation IN ('chat','*') AND s.status='active'
        AND rp.status='active' AND (rp.model_id<>s.model_id OR EXISTS (
          SELECT 1 FROM cinatoken_gateway.model_routes sr
          WHERE sr.route_pool_id=s.route_pool_id AND sr.status='active'
            AND sr.model_id<>s.model_id)))
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_manifest'); END IF;

  -- v351 validates all configured source intents when at least one exists.
  -- For an empty array, prove under the same source locks that none exists.
  IF n=0 AND (key_row.limit_micros IS NOT NULL
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.workspace_budgets wb
      WHERE wb.workspace_id=q.workspace_id)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.guardrails g
      JOIN cinatoken_gateway.guardrail_versions v
        ON v.guardrail_id=g.id AND v.version=g.designated_version
      LEFT JOIN cinatoken_gateway.guardrail_assignments a
        ON NOT g.is_workspace_default AND a.guardrail_id=g.id
          AND a.workspace_id=q.workspace_id
          AND ((a.scope_type='user' AND a.scope_id=q.user_id)
            OR (a.scope_type='api_key' AND a.scope_id=q.api_key_id))
      WHERE g.workspace_id=q.workspace_id AND g.status='active'
        AND NOT g.is_account_default
        AND (g.is_workspace_default OR a.id IS NOT NULL)
        AND v.config_json::jsonb->'budget' IS NOT NULL
        AND v.config_json::jsonb->'budget'<>'null'::jsonb))
  THEN RETURN pg_catalog.jsonb_build_object('status','missing_guardrail_intents'); END IF;

  SELECT * INTO prior FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE request_id=p_request_id FOR SHARE;
  IF FOUND THEN
    IF prior.quote_id IS DISTINCT FROM q.quote_id
      OR prior.final_body_sha256 IS DISTINCT FROM q.final_body_sha256
      OR prior.reserved_micros IS DISTINCT FROM amount
      OR prior.guardrail_intents IS DISTINCT FROM p_intents
      OR prior.guardrail_count<>n OR prior.expires_at<=server_now
    THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    IF prior.ordinary_status='reserved' THEN
      SELECT * INTO held FROM cinatoken_gateway.user_budget_reservations
        WHERE request_id=p_request_id FOR SHARE;
      IF NOT FOUND OR held.state NOT IN ('reserved','dispatched')
        OR held.reserved_micros<>amount OR held.expires_at<=server_now
      THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    END IF;
    IF n>0 AND ((SELECT pg_catalog.count(*) FROM
      cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=p_request_id AND state IN ('reserved','dispatched')
        AND reserved_micros=amount AND expires_at>server_now)<>n)
    THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
    RETURN pg_catalog.jsonb_build_object('status','idempotent',
      'quoteId',q.quote_id,'finalBodySha256',q.final_body_sha256,
      'reservedMicros',amount,'ordinary',prior.ordinary_status,
      'guardrailCount',n,
      'expiresAt',prior.expires_at);
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=p_request_id)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=p_request_id)
  THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;

  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  hold_expires_at:=least(q.expires_at,server_now+INTERVAL '90 seconds');
  IF hold_expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  BEGIN
    SELECT cinatoken_gateway.reserve_user_budget_v350(
      p_request_id,q.user_id,q.api_key_id,q.budget_epoch,
      amount,server_now,hold_expires_at) INTO ordinary;
    IF ordinary.reserve_user_budget_v350->>'status' NOT IN ('reserved','unlimited')
    THEN RAISE EXCEPTION '%',ordinary.reserve_user_budget_v350->>'status'
      USING ERRCODE='P0361'; END IF;
    IF n>0 THEN
      SELECT cinatoken_gateway.reserve_guardrail_budgets_v351(
        p_request_id,q.user_id,q.api_key_id,p_intents,amount,'charged',
        server_now,hold_expires_at) INTO guardrail;
      IF guardrail.reserve_guardrail_budgets_v351->>'status'<>'reserved'
      THEN RAISE EXCEPTION '%',guardrail.reserve_guardrail_budgets_v351->>'status'
        USING ERRCODE='P0361'; END IF;
    END IF;
    server_now:=pg_catalog.clock_timestamp();
    IF server_now>=hold_expires_at OR server_now>=q.expires_at
    THEN RAISE EXCEPTION 'stale' USING ERRCODE='P0361'; END IF;
    INSERT INTO cinatoken_gateway.complete_text_admissions_v361
      (request_id,quote_id,final_body_sha256,reserved_micros,
        ordinary_status,guardrail_intents,guardrail_count,admitted_at,expires_at)
      VALUES (p_request_id,q.quote_id,q.final_body_sha256,amount,
        ordinary.reserve_user_budget_v350->>'status',p_intents,n,
        server_now,hold_expires_at);
  EXCEPTION WHEN SQLSTATE 'P0361' THEN
    GET STACKED DIAGNOSTICS rejection=MESSAGE_TEXT;
    RETURN pg_catalog.jsonb_build_object('status',rejection);
  END;
  RETURN pg_catalog.jsonb_build_object('status','admitted',
    'quoteId',q.quote_id,'finalBodySha256',q.final_body_sha256,
    'reservedMicros',amount,
    'ordinary',ordinary.reserve_user_budget_v350->>'status',
    'guardrailCount',n,'expiresAt',hold_expires_at);
END;
$admit$;

-- Close direct one-micro (or other caller amount) substitution in the same
-- transaction that publishes the no-amount v361 wrapper.
REVOKE ALL ON FUNCTION
  cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz),
  cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission;
REVOKE ALL ON cinatoken_gateway.complete_text_admissions_v361
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb),
  cinatoken_gateway.reject_complete_text_admission_mutation_v361()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)
  TO cinatoken_gateway_budget_admission;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_budget_admission',
      'cinatoken_gateway.reserve_user_budget_v350(text,text,text,bigint,bigint,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_budget_admission',
      'cinatoken_gateway.reserve_guardrail_budgets_v351(text,text,text,jsonb,bigint,text,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_budget_admission',
      'cinatoken_gateway.complete_text_admissions_v361',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_admissions_v361_no_mutation'
        AND tgenabled='O' AND NOT tgisinternal)<>1
  THEN RAISE EXCEPTION 'complete text admission v361 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
