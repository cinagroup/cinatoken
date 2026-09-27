-- REVIEW ONLY. Install after v360/v361 with a separately provisioned direct
-- NOINHERIT LOGIN cinatoken_gateway_complete_text_attempt_granter. Run in one
-- migrator transaction with complete_text_attempt_grant_activation=reviewed-v1.
-- This records a durable possible-send/unknown obligation and marks the exact
-- v361 holds dispatched before a caller can receive a grant claim result.
-- The SQL result is not a COMMIT/connection-close acknowledgement and cannot
-- by itself authorize physical fetch. An independent secret holder must prove
-- the public-to-wire transform, URL, credential and upload bytes.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923562);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_quotes_v360,
  cinatoken_gateway.complete_text_quote_routes_v360,
  cinatoken_gateway.complete_text_admissions_v361,
  cinatoken_gateway.user_budget_reservations,
  cinatoken_gateway.guardrail_budget_reservations
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; granter_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO granter_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_attempt_granter';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_attempt_grant_activation',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR granter_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
       AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
       AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=granter_oid)
         IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=granter_oid OR member=granter_oid)
    OR pg_catalog.has_schema_privilege(granter_oid,'cinatoken_gateway','CREATE')
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_attempt_grants_v362') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)')
       IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_quotes_v360') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_quote_routes_v360') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_admissions_v361') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.admit_complete_flat_text_quote_v361(text,uuid,jsonb)')
       IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)')
       IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)')
       IS NULL
    OR NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid IN (
        'cinatoken_gateway.complete_text_quotes_v360'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_quote_routes_v360'::pg_catalog.regclass,
        'cinatoken_gateway.complete_text_admissions_v361'::pg_catalog.regclass,
        'cinatoken_gateway.user_budget_reservations'::pg_catalog.regclass,
        'cinatoken_gateway.guardrail_budget_reservations'::pg_catalog.regclass)
        AND (c.relowner<>migrator_oid OR c.relkind<>'r'
          OR c.relrowsecurity OR c.relforcerowsecurity))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(granter_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(granter_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(granter_oid,p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'complete text attempt grant v362 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_attempt_grants_v362 (
  grant_id uuid PRIMARY KEY,
  request_id text NOT NULL REFERENCES
    cinatoken_gateway.complete_text_admissions_v361(request_id),
  quote_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_quotes_v360(quote_id),
  attempt_nonce uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  final_body_sha256 text NOT NULL CHECK (final_body_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_index integer NOT NULL CHECK (candidate_index BETWEEN 0 AND 7),
  model_id text NOT NULL,
  route_target_id text NOT NULL,
  provider_id text NOT NULL,
  endpoint_id text NOT NULL,
  credential_class text NOT NULL CHECK (credential_class='platform'),
  credential_id text NOT NULL,
  provider_ciphertext_sha256 text NOT NULL
    CHECK (provider_ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_source_generation bigint NOT NULL CHECK (manifest_source_generation>=1),
  manifest_attested_source_sha256 text NOT NULL
    CHECK (manifest_attested_source_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_source_sha256 text NOT NULL
    CHECK (manifest_source_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_route_source_sha256 text NOT NULL
    CHECK (prepared_route_source_sha256 ~ '^[0-9a-f]{64}$'),
  method text NOT NULL CHECK (method='POST'),
  upstream_url_sha256 text NOT NULL
    CHECK (upstream_url_sha256 ~ '^[0-9a-f]{64}$'),
  outbound_body_sha256 text NOT NULL
    CHECK (outbound_body_sha256 ~ '^[0-9a-f]{64}$'),
  outbound_body_canonical_sha256 text NOT NULL
    CHECK (outbound_body_canonical_sha256 ~ '^[0-9a-f]{64}$'),
  outbound_body_bytes integer NOT NULL
    CHECK (outbound_body_bytes BETWEEN 2 AND 2097152),
  credential_fingerprint_sha256 text NOT NULL
    CHECK (credential_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  claim_sha256 text NOT NULL CHECK (claim_sha256 ~ '^[0-9a-f]{64}$'),
  obligation_state text NOT NULL DEFAULT 'unknown'
    CHECK (obligation_state='unknown'),
  granted_at timestamptz NOT NULL,
  send_expires_at timestamptz NOT NULL CHECK (send_expires_at>granted_at),
  hold_recovery_expires_at timestamptz NOT NULL
    CHECK (hold_recovery_expires_at>=send_expires_at),
  UNIQUE (request_id,attempt_nonce),
  UNIQUE (request_id,attempt_number)
);
CREATE INDEX complete_text_attempt_grants_v362_unknown
  ON cinatoken_gateway.complete_text_attempt_grants_v362
    (obligation_state,granted_at,request_id);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_grant_mutation_v362()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text attempt grant v362 is insert-only'
    USING ERRCODE='P0001';
END;
$immutable$;
CREATE TRIGGER complete_text_attempt_grants_v362_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_attempt_grants_v362
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_grant_mutation_v362();

CREATE FUNCTION cinatoken_gateway.grant_complete_flat_text_attempt_v362(
  p_attempt_nonce uuid,p_claim jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $grant$
DECLARE required_key text; key_count integer; v_request_id text; v_quote_id uuid;
DECLARE claim_sha text; prior record; q record; admission record; cap record;
DECLARE key_row record; user_row record; workspace_row record;
DECLARE manifest record; chosen record; ordinary record; held record;
DECLARE intent record; source_row record; window_row record;
DECLARE server_now timestamptz; send_expires timestamptz;
DECLARE recovery_expires timestamptz; expected_start timestamptz;
DECLARE expected_end timestamptz; active_micros bigint; expected_count integer;
DECLARE manifest_count integer; active_count integer; candidate_count integer;
DECLARE max_ceiling bigint; guardrail_count integer:=0; supplied_key integer:=0;
DECLARE supplied_workspace integer:=0; supplied_configured integer:=0;
DECLARE seen_assignments text[]:=ARRAY[]::text[];
DECLARE grant_uuid uuid; v_attempt_number integer;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_attempt_granter'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_attempt_nonce IS NULL
    OR pg_catalog.jsonb_typeof(p_claim) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'invalid complete text attempt grant call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_attempt_grant_call_v362'; END IF;
  SELECT pg_catalog.count(*)::integer INTO key_count
    FROM pg_catalog.jsonb_object_keys(p_claim);
  IF key_count<>18 THEN RAISE EXCEPTION 'invalid complete text attempt claim shape'
    USING ERRCODE='23514',CONSTRAINT='complete_text_attempt_claim_v362'; END IF;
  FOREACH required_key IN ARRAY ARRAY['requestId','quoteId','finalBodySha256',
    'candidateIndex','modelId','routeTargetId','providerId','endpointId',
    'credentialClass','credentialId','providerCiphertextSha256',
    'preparedRouteSourceSha256','method','upstreamUrlSha256',
    'outboundBodySha256','outboundBodyCanonicalSha256','outboundBodyBytes',
    'credentialFingerprintSha256'] LOOP
    IF NOT p_claim ? required_key OR p_claim->required_key='null'::jsonb
    THEN RAISE EXCEPTION 'missing complete text attempt claim field'
      USING ERRCODE='23514',CONSTRAINT='complete_text_attempt_claim_v362'; END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(p_claim->'requestId')<>'string'
    OR pg_catalog.length(p_claim->>'requestId') NOT BETWEEN 1 AND 128
    OR pg_catalog.jsonb_typeof(p_claim->'quoteId')<>'string'
    OR (p_claim->>'quoteId') !~
      '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR pg_catalog.jsonb_typeof(p_claim->'candidateIndex')<>'number'
    OR (p_claim->>'candidateIndex') !~ '^[0-7]$'
    OR pg_catalog.jsonb_typeof(p_claim->'outboundBodyBytes')<>'number'
    OR (p_claim->>'outboundBodyBytes') !~ '^[0-9]{1,7}$'
    OR (p_claim->>'outboundBodyBytes')::integer NOT BETWEEN 2 AND 2097152
    OR p_claim->>'credentialClass' IS DISTINCT FROM 'platform'
    OR p_claim->>'method' IS DISTINCT FROM 'POST'
  THEN RAISE EXCEPTION 'invalid complete text attempt claim value'
    USING ERRCODE='23514',CONSTRAINT='complete_text_attempt_claim_v362'; END IF;
  FOREACH required_key IN ARRAY ARRAY['finalBodySha256',
    'providerCiphertextSha256','preparedRouteSourceSha256',
    'upstreamUrlSha256','outboundBodySha256','outboundBodyCanonicalSha256',
    'credentialFingerprintSha256'] LOOP
    IF pg_catalog.jsonb_typeof(p_claim->required_key)<>'string'
      OR (p_claim->>required_key) !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid complete text attempt claim digest'
      USING ERRCODE='23514',CONSTRAINT='complete_text_attempt_claim_v362'; END IF;
  END LOOP;
  FOREACH required_key IN ARRAY ARRAY['modelId','routeTargetId',
    'providerId','endpointId','credentialId'] LOOP
    IF pg_catalog.jsonb_typeof(p_claim->required_key)<>'string'
      OR pg_catalog.length(p_claim->>required_key) NOT BETWEEN 1 AND 512
    THEN RAISE EXCEPTION 'invalid complete text attempt claim identity'
      USING ERRCODE='23514',CONSTRAINT='complete_text_attempt_claim_v362'; END IF;
  END LOOP;
  v_request_id:=p_claim->>'requestId';
  v_quote_id:=(p_claim->>'quoteId')::uuid;
  claim_sha:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_claim::text,'UTF8')),'hex');

  -- v361 and v351 use this key. Unknown ACK replay cannot obtain another
  -- fresh grant, even through a separate direct LOGIN connection.
  PERFORM pg_catalog.pg_advisory_xact_lock(348,pg_catalog.hashtext(v_request_id));
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=v_request_id AND quote_id=v_quote_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','missing_quote'); END IF;
  SELECT * INTO prior FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE request_id=v_request_id AND attempt_nonce=p_attempt_nonce FOR SHARE;
  IF FOUND THEN
    IF prior.quote_id IS DISTINCT FROM v_quote_id
      OR prior.claim_sha256 IS DISTINCT FROM claim_sha
    THEN RETURN pg_catalog.jsonb_build_object('status','nonce_conflict'); END IF;
    RETURN pg_catalog.jsonb_build_object('status','already_recorded_unknown',
      'grantId',prior.grant_id,'attemptNumber',prior.attempt_number);
  END IF;
  IF EXISTS (SELECT 1 FROM cinatoken_gateway.complete_text_attempt_grants_v362
      WHERE request_id=v_request_id)
  THEN RETURN pg_catalog.jsonb_build_object('status','pending_unknown'); END IF;
  SELECT * INTO admission FROM cinatoken_gateway.complete_text_admissions_v361
    WHERE request_id=v_request_id AND quote_id=v_quote_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','admission_required'); END IF;
  SELECT * INTO cap FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=v_request_id FOR SHARE;
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys
    WHERE id=q.api_key_id FOR SHARE;
  SELECT * INTO user_row FROM cinatoken_gateway.users
    WHERE id=q.user_id FOR UPDATE;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces
    WHERE id=q.workspace_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR admission.expires_at<=server_now
    OR admission.final_body_sha256 IS DISTINCT FROM q.final_body_sha256
    OR admission.reserved_micros IS DISTINCT FROM q.three_attempt_ceiling_micros
    OR admission.ordinary_status NOT IN ('reserved','unlimited')
    OR cap.request_id IS NULL OR cap.state<>'claimed'
    OR cap.invalidated_at IS NOT NULL
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
    OR p_claim->>'finalBodySha256' IS DISTINCT FROM q.final_body_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;

  -- Conservative predicate locks prevent a new route, BYOK source, surface,
  -- Guardrail config or extra reservation from appearing between validation
  -- and COMMIT. This serializes unrelated budget writes in the review proof.
  LOCK TABLE cinatoken_gateway.models,cinatoken_gateway.model_surfaces,
    cinatoken_gateway.model_routes,cinatoken_gateway.route_pools,
    cinatoken_gateway.providers,cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.byok_keys,cinatoken_gateway.guardrails,
    cinatoken_gateway.guardrail_versions,
    cinatoken_gateway.guardrail_assignments,
    cinatoken_gateway.workspace_budgets IN SHARE MODE;
  LOCK TABLE cinatoken_gateway.user_budget_reservations,
    cinatoken_gateway.guardrail_budget_reservations,
    cinatoken_gateway.guardrail_budget_windows IN SHARE ROW EXCLUSIVE MODE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR admission.expires_at<=server_now
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
      OR manifest.source_snapshot->>'modelId' IS DISTINCT FROM manifest.model_id
      OR manifest.source_snapshot->>'routeTargetId' IS DISTINCT FROM manifest.route_target_id
      OR manifest.source_snapshot->>'providerId' IS DISTINCT FROM manifest.provider_id
      OR manifest.source_snapshot->>'endpointId' IS DISTINCT FROM manifest.endpoint_id
      OR manifest.source_snapshot->>'providerCiphertextSha256'
        IS DISTINCT FROM manifest.provider_ciphertext_sha256
      OR manifest.source_snapshot->>'attestedSourceSha256'
        IS DISTINCT FROM manifest.attested_source_sha256
      OR manifest.source_snapshot->>'sourceGeneration'
        IS DISTINCT FROM manifest.source_generation::text
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
  SELECT * INTO chosen FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id
      AND candidate_index=(p_claim->>'candidateIndex')::integer
      AND route_target_id=p_claim->>'routeTargetId';
  IF NOT FOUND OR chosen.model_id IS DISTINCT FROM p_claim->>'modelId'
    OR chosen.provider_id IS DISTINCT FROM p_claim->>'providerId'
    OR chosen.endpoint_id IS DISTINCT FROM p_claim->>'endpointId'
    OR chosen.credential_class IS DISTINCT FROM p_claim->>'credentialClass'
    OR chosen.credential_id IS DISTINCT FROM p_claim->>'credentialId'
    OR chosen.provider_ciphertext_sha256 IS DISTINCT FROM
      p_claim->>'providerCiphertextSha256'
  THEN RETURN pg_catalog.jsonb_build_object('status','target_not_in_manifest'); END IF;

  -- v361's recorded source intents are rechecked against current sources.
  -- The empty-intent case must prove there is still no applicable source.
  IF admission.guardrail_count=0 AND (key_row.limit_micros IS NOT NULL
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.workspace_budgets wb
      WHERE wb.workspace_id=q.workspace_id)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.guardrails g
      JOIN cinatoken_gateway.guardrail_versions v
        ON v.guardrail_id=g.id AND v.version=g.designated_version
      LEFT JOIN cinatoken_gateway.guardrail_assignments ga
        ON NOT g.is_workspace_default AND ga.guardrail_id=g.id
          AND ga.workspace_id=q.workspace_id
          AND ((ga.scope_type='user' AND ga.scope_id=q.user_id)
            OR (ga.scope_type='api_key' AND ga.scope_id=q.api_key_id))
      WHERE g.workspace_id=q.workspace_id AND g.status='active'
        AND NOT g.is_account_default
        AND (g.is_workspace_default OR ga.id IS NOT NULL)
        AND v.config_json::jsonb->'budget' IS NOT NULL
        AND v.config_json::jsonb->'budget'<>'null'::jsonb))
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
  IF admission.guardrail_count<>pg_catalog.jsonb_array_length(
      admission.guardrail_intents)
  THEN RETURN pg_catalog.jsonb_build_object('status','invalid_admission'); END IF;
  FOR intent IN SELECT * FROM pg_catalog.jsonb_to_recordset(
      admission.guardrail_intents) AS x(
      "workspaceId" text,"assignmentId" text,"guardrailId" text,
      "guardrailVersion" integer,"scopeType" text,"scopeId" text,
      period text,"periodStart" timestamptz,"periodEnd" timestamptz,
      "limitMicros" bigint)
    ORDER BY "workspaceId","scopeType","scopeId",period,"periodStart",
      "assignmentId"
  LOOP
    guardrail_count:=guardrail_count+1;
    IF intent."workspaceId" IS DISTINCT FROM q.workspace_id
      OR intent."assignmentId" IS NULL
      OR intent."assignmentId"=ANY(seen_assignments)
      OR intent."periodStart" IS NULL OR intent."periodEnd" IS NULL
      OR intent."scopeType" NOT IN ('user','api_key','workspace')
      OR intent."scopeId" IS NULL
      OR intent.period NOT IN ('daily','weekly','monthly','lifetime')
    THEN RETURN pg_catalog.jsonb_build_object('status','invalid_admission'); END IF;
    seen_assignments:=pg_catalog.array_append(seen_assignments,
      intent."assignmentId");
    IF intent."assignmentId"='gateway-key-limit:'||q.api_key_id THEN
      supplied_key:=supplied_key+1;
      IF intent."scopeType"<>'api_key' OR intent."scopeId"<>q.api_key_id
        OR intent."guardrailId"<>intent."assignmentId"
        OR key_row.limit_micros IS NULL
        OR intent."limitMicros"<>key_row.limit_micros
        OR intent."guardrailVersion"<>key_row.limit_epoch+1
        OR intent.period<>coalesce(key_row.limit_reset,'lifetime')
      THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
      expected_start:=key_row.created_at;
    ELSIF pg_catalog.left(intent."assignmentId",17)='workspace-budget:' THEN
      supplied_workspace:=supplied_workspace+1;
      SELECT * INTO source_row FROM cinatoken_gateway.workspace_budgets b
        WHERE b.id=pg_catalog.substr(intent."assignmentId",18) FOR SHARE;
      IF NOT FOUND OR intent."scopeType"<>'workspace'
        OR intent."scopeId"<>q.workspace_id
        OR intent."guardrailId"<>intent."assignmentId"
        OR source_row.workspace_id<>q.workspace_id
        OR source_row.limit_micros<>intent."limitMicros"
        OR source_row.config_epoch+1<>intent."guardrailVersion"
        OR source_row.reset_interval<>intent.period
      THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
      expected_start:=workspace_row.created_at;
    ELSE
      supplied_configured:=supplied_configured+1;
      IF intent.period='lifetime' OR intent."scopeType"='workspace'
        OR (intent."scopeType"='user' AND intent."scopeId"<>q.user_id)
        OR (intent."scopeType"='api_key' AND intent."scopeId"<>q.api_key_id)
      THEN RETURN pg_catalog.jsonb_build_object('status','invalid_admission'); END IF;
      SELECT g.id,g.designated_version,g.is_workspace_default,
        g.is_account_default,v.config_json::jsonb AS config
        INTO source_row FROM cinatoken_gateway.guardrails g
        JOIN cinatoken_gateway.guardrail_versions v
          ON v.guardrail_id=g.id AND v.version=g.designated_version
        WHERE g.id=intent."guardrailId" AND g.workspace_id=q.workspace_id
          AND g.status='active' FOR SHARE OF g,v;
      IF NOT FOUND OR source_row.is_account_default
        OR source_row.designated_version<>intent."guardrailVersion"
        OR source_row.config->'budget' IS NULL
        OR source_row.config->'budget'='null'::jsonb
        OR source_row.config->'budget'->>'period'<>intent.period
        OR pg_catalog.round((source_row.config->'budget'->>'limit')::numeric
          *1000000)::bigint<>intent."limitMicros"
      THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
      IF source_row.is_workspace_default THEN
        IF (intent."scopeType"='user' AND intent."assignmentId"
              IS DISTINCT FROM 'workspace-default:'||source_row.id||':user')
          OR (intent."scopeType"='api_key' AND intent."assignmentId"
              IS DISTINCT FROM 'workspace-default:'||source_row.id||':api-key')
        THEN RETURN pg_catalog.jsonb_build_object('status','invalid_admission'); END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_assignments ga
          WHERE ga.id=intent."assignmentId" AND ga.guardrail_id=source_row.id
            AND ga.workspace_id=q.workspace_id
            AND ga.scope_type=intent."scopeType"
            AND ga.scope_id=intent."scopeId")
      THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
      expected_start:=NULL;
    END IF;
    IF intent.period='lifetime' THEN
      expected_end:='9999-12-31T23:59:59.999Z'::timestamptz;
    ELSE
      expected_start:=CASE intent.period
        WHEN 'daily' THEN pg_catalog.date_trunc('day',server_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        WHEN 'weekly' THEN pg_catalog.date_trunc('week',server_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ELSE pg_catalog.date_trunc('month',server_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END;
      expected_end:=CASE intent.period
        WHEN 'daily' THEN expected_start+INTERVAL '1 day'
        WHEN 'weekly' THEN expected_start+INTERVAL '7 days'
        ELSE expected_start+INTERVAL '1 month' END;
    END IF;
    IF intent."periodStart" IS DISTINCT FROM expected_start
      OR intent."periodEnd" IS DISTINCT FROM expected_end
      OR NOT (server_now>=intent."periodStart"
        AND server_now<intent."periodEnd")
    THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
    SELECT * INTO held FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=v_request_id AND assignment_id=intent."assignmentId"
      FOR UPDATE;
    IF NOT FOUND OR held.workspace_id IS DISTINCT FROM q.workspace_id
      OR held.guardrail_id IS DISTINCT FROM intent."guardrailId"
      OR held.guardrail_version IS DISTINCT FROM intent."guardrailVersion"
      OR held.scope_type IS DISTINCT FROM intent."scopeType"
      OR held.scope_id IS DISTINCT FROM intent."scopeId"
      OR held.period IS DISTINCT FROM intent.period
      OR held.period_start IS DISTINCT FROM intent."periodStart"
      OR held.period_end IS DISTINCT FROM intent."periodEnd"
      OR held.limit_micros IS DISTINCT FROM intent."limitMicros"
      OR held.reserved_micros IS DISTINCT FROM admission.reserved_micros
      OR held.settlement_basis IS DISTINCT FROM 'charged'
      OR held.state IS DISTINCT FROM 'reserved'
      OR held.dispatched_at IS NOT NULL OR held.expires_at<=server_now
    THEN RETURN pg_catalog.jsonb_build_object('status','missing_hold'); END IF;
    SELECT * INTO window_row FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start FOR UPDATE;
    SELECT coalesce(pg_catalog.sum(reserved_micros),0)::bigint INTO active_micros
      FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE workspace_id=held.workspace_id AND scope_type=held.scope_type
        AND scope_id=held.scope_id AND period=held.period
        AND period_start=held.period_start
        AND state IN ('reserved','dispatched');
    IF window_row.workspace_id IS NULL
      OR window_row.reserved_micros<>active_micros
      OR window_row.period_end IS DISTINCT FROM held.period_end
    THEN RETURN pg_catalog.jsonb_build_object('status','hold_counter_differs'); END IF;
  END LOOP;
  IF guardrail_count<>admission.guardrail_count
    OR (SELECT pg_catalog.count(*) FROM
      cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=v_request_id)<>guardrail_count
  THEN RETURN pg_catalog.jsonb_build_object('status','missing_hold'); END IF;
  SELECT pg_catalog.count(*) INTO expected_count
    FROM cinatoken_gateway.workspace_budgets
    WHERE workspace_id=q.workspace_id;
  IF supplied_workspace<>expected_count
    OR (key_row.limit_micros IS NULL AND supplied_key<>0)
    OR (key_row.limit_micros IS NOT NULL AND supplied_key<>1)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;
  SELECT coalesce(pg_catalog.sum(CASE WHEN g.is_workspace_default
      THEN 2 ELSE 1 END),0)::integer INTO expected_count
    FROM cinatoken_gateway.guardrails g
    JOIN cinatoken_gateway.guardrail_versions v
      ON v.guardrail_id=g.id AND v.version=g.designated_version
    LEFT JOIN cinatoken_gateway.guardrail_assignments ga
      ON NOT g.is_workspace_default AND ga.guardrail_id=g.id
      AND ga.workspace_id=q.workspace_id
      AND ((ga.scope_type='user' AND ga.scope_id=q.user_id)
        OR (ga.scope_type='api_key' AND ga.scope_id=q.api_key_id))
    WHERE g.workspace_id=q.workspace_id AND g.status='active'
      AND NOT g.is_account_default
      AND (g.is_workspace_default OR ga.id IS NOT NULL)
      AND v.config_json::jsonb->'budget' IS NOT NULL
      AND v.config_json::jsonb->'budget'<>'null'::jsonb;
  IF supplied_configured<>expected_count
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_guardrail_source'); END IF;

  IF admission.ordinary_status='reserved' THEN
    SELECT * INTO ordinary FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=v_request_id FOR UPDATE;
    IF NOT FOUND OR ordinary.user_id IS DISTINCT FROM q.user_id
      OR ordinary.api_key_id IS DISTINCT FROM q.api_key_id
      OR ordinary.budget_epoch IS DISTINCT FROM q.budget_epoch
      OR ordinary.reserved_micros IS DISTINCT FROM admission.reserved_micros
      OR ordinary.state IS DISTINCT FROM 'reserved'
      OR ordinary.dispatched_at IS NOT NULL OR ordinary.expires_at<=server_now
      OR user_row.budget_max IS NULL
      OR user_row.budget_reserved_micros<ordinary.reserved_micros
      OR (user_row.budget_period<>'none'
        AND user_row.budget_reset_at IS NOT NULL
        AND user_row.budget_reset_at<=server_now)
    THEN RETURN pg_catalog.jsonb_build_object('status','missing_hold'); END IF;
    SELECT coalesce(pg_catalog.sum(reserved_micros),0)::bigint
      INTO active_micros FROM cinatoken_gateway.user_budget_reservations
      WHERE user_id=q.user_id AND budget_epoch=q.budget_epoch
        AND state IN ('reserved','dispatched');
    IF active_micros<>user_row.budget_reserved_micros
      OR ordinary.limit_micros<>LEAST(pg_catalog.round(
        GREATEST(user_row.budget_max,0::numeric)*1000000::numeric),
        9007199254740991::numeric)::bigint
    THEN RETURN pg_catalog.jsonb_build_object('status','hold_counter_differs'); END IF;
  ELSE
    IF user_row.budget_max IS NOT NULL OR EXISTS (
      SELECT 1 FROM cinatoken_gateway.user_budget_reservations
        WHERE request_id=v_request_id)
    THEN RETURN pg_catalog.jsonb_build_object('status','missing_hold'); END IF;
  END IF;

  -- Every lock wait above can cross a deadline. No caller clock is trusted.
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR admission.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR (admission.ordinary_status='reserved'
      AND ordinary.expires_at<=server_now)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=v_request_id AND expires_at<=server_now)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  send_expires:=LEAST(q.expires_at,admission.expires_at,
    server_now+INTERVAL '30 seconds');
  recovery_expires:=server_now+INTERVAL '15 minutes';
  IF send_expires<=server_now OR recovery_expires<send_expires
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT coalesce(pg_catalog.max(attempt_number),0)+1 INTO v_attempt_number
    FROM cinatoken_gateway.complete_text_attempt_grants_v362
    WHERE request_id=v_request_id;
  IF v_attempt_number NOT BETWEEN 1 AND 3
  THEN RETURN pg_catalog.jsonb_build_object('status','attempt_exhausted'); END IF;

  -- Exact hold state/lease transition and unknown obligation are one COMMIT.
  -- Existing v350/v351 mark functions require the admission SESSION_USER;
  -- the granter therefore performs their counter/limit/window checks above.
  IF admission.ordinary_status='reserved' THEN
    UPDATE cinatoken_gateway.user_budget_reservations SET
      state='dispatched',dispatched_at=server_now,
      expires_at=recovery_expires,updated_at=server_now
      WHERE request_id=v_request_id AND state='reserved';
    IF NOT FOUND THEN RAISE EXCEPTION 'ordinary hold changed before grant'
      USING ERRCODE='P0001'; END IF;
  END IF;
  IF guardrail_count>0 THEN
    UPDATE cinatoken_gateway.guardrail_budget_reservations SET
      state='dispatched',dispatched_at=server_now,
      expires_at=recovery_expires,updated_at=server_now
      WHERE request_id=v_request_id AND state='reserved';
    GET DIAGNOSTICS expected_count=ROW_COUNT;
    IF expected_count<>guardrail_count THEN
      RAISE EXCEPTION 'Guardrail hold changed before grant'
        USING ERRCODE='P0001'; END IF;
  END IF;
  IF (admission.ordinary_status='reserved' AND NOT EXISTS (
      SELECT 1 FROM cinatoken_gateway.user_budget_reservations
      WHERE request_id=v_request_id AND state='dispatched'
        AND expires_at>=recovery_expires))
    OR (SELECT pg_catalog.count(*) FROM
      cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=v_request_id AND state='dispatched'
        AND expires_at>=recovery_expires)<>guardrail_count
  THEN RAISE EXCEPTION 'complete text grant hold coverage differs'
    USING ERRCODE='P0001'; END IF;
  grant_uuid:=pg_catalog.gen_random_uuid();
  INSERT INTO cinatoken_gateway.complete_text_attempt_grants_v362
    (grant_id,request_id,quote_id,attempt_nonce,attempt_number,
      final_body_sha256,candidate_index,model_id,route_target_id,
      provider_id,endpoint_id,credential_class,credential_id,
      provider_ciphertext_sha256,manifest_source_generation,
      manifest_attested_source_sha256,manifest_source_sha256,
      prepared_route_source_sha256,method,upstream_url_sha256,
      outbound_body_sha256,outbound_body_canonical_sha256,
      outbound_body_bytes,credential_fingerprint_sha256,claim_sha256,
      obligation_state,granted_at,send_expires_at,hold_recovery_expires_at)
    VALUES(grant_uuid,v_request_id,v_quote_id,p_attempt_nonce,v_attempt_number,
      q.final_body_sha256,chosen.candidate_index,chosen.model_id,
      chosen.route_target_id,chosen.provider_id,chosen.endpoint_id,
      chosen.credential_class,chosen.credential_id,
      chosen.provider_ciphertext_sha256,chosen.source_generation,
      chosen.attested_source_sha256,chosen.source_sha256,
      p_claim->>'preparedRouteSourceSha256','POST',
      p_claim->>'upstreamUrlSha256',p_claim->>'outboundBodySha256',
      p_claim->>'outboundBodyCanonicalSha256',
      (p_claim->>'outboundBodyBytes')::integer,
      p_claim->>'credentialFingerprintSha256',claim_sha,
      'unknown',server_now,send_expires,recovery_expires);
  -- The DB cannot know its own COMMIT/connection-close acknowledgement.
  RETURN p_claim || pg_catalog.jsonb_build_object(
    'status','grant_recorded','grantId',grant_uuid,
    'attemptNumber',v_attempt_number,
    'manifestSourceGeneration',chosen.source_generation,
    'currentSourceGeneration',chosen.source_generation,
    'manifestAttestedSourceSha256',chosen.attested_source_sha256,
    'currentAttestedSourceSha256',chosen.attested_source_sha256,
    'manifestSourceSha256',chosen.source_sha256,
    'expiresAt',send_expires,
    'holdRecoveryExpiresAt',recovery_expires);
END;
$grant$;

-- Close the older admission LOGIN's mark-without-grant side door in the same
-- transaction that publishes this committed-attempt path. Pre-grant release
-- remains available; released holds cannot pass this grant's row-state check.
REVOKE ALL ON FUNCTION
  cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz),
  cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)
  FROM cinatoken_gateway_budget_admission;
REVOKE ALL ON cinatoken_gateway.complete_text_attempt_grants_v362
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_complete_text_attempt_granter;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb),
  cinatoken_gateway.reject_complete_text_grant_mutation_v362()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_budget_admission,
    cinatoken_gateway_complete_text_attempt_granter;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_attempt_granter;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)
  TO cinatoken_gateway_complete_text_attempt_granter;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_attempt_granter',
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_runtime',
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.grant_complete_flat_text_attempt_v362(uuid,jsonb)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_attempt_granter',
      'cinatoken_gateway.complete_text_attempt_grants_v362',
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.mark_user_budget_dispatched_v350(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_budget_admission',
      'cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(text,timestamptz,timestamptz)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_attempt_granter',
      'cinatoken_gateway.reject_complete_text_grant_mutation_v362()',
      'EXECUTE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
      WHERE tgname='complete_text_attempt_grants_v362_no_mutation'
        AND tgenabled='O' AND NOT tgisinternal)<>1
  THEN RAISE EXCEPTION 'complete text attempt grant v362 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
