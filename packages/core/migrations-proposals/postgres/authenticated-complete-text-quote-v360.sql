-- REVIEW ONLY. Atomic, complete flat-text Chat quote for a deliberately strict
-- platform-credential class. Install after v356, v357 and v359 with a separate
-- direct NOINHERIT LOGIN cinatoken_gateway_complete_text_quote_issuer.
-- This is a quote, not a reservation or permission to send upstream traffic.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923556);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
SELECT pg_catalog.pg_advisory_xact_lock(746923559);
SELECT pg_catalog.pg_advisory_xact_lock(746923560);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.authenticated_request_capabilities_v356,
  cinatoken_gateway.route_source_generations_v359,
  cinatoken_gateway.models, cinatoken_gateway.model_surfaces,
  cinatoken_gateway.model_routes, cinatoken_gateway.route_pools,
  cinatoken_gateway.providers, cinatoken_gateway.model_endpoints,
  cinatoken_gateway.model_endpoint_routes, cinatoken_gateway.byok_keys,
  cinatoken_gateway.shared_keys IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid; issuer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO issuer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_quote_issuer';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.complete_text_quote_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR issuer_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR pg_catalog.to_regclass('cinatoken_gateway.complete_text_quotes_v360') IS NOT NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.complete_text_quote_routes_v360') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text)') IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.authenticated_request_capabilities_v356') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.route_source_generations_v359') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=issuer_oid
      AND NOT (rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=issuer_oid OR member=issuer_oid)
    OR pg_catalog.has_schema_privilege(issuer_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(issuer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(issuer_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(issuer_oid,p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'complete text quote v360 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.complete_text_quotes_v360 (
  request_id text PRIMARY KEY REFERENCES
    cinatoken_gateway.authenticated_request_capabilities_v356(request_id),
  quote_id uuid NOT NULL UNIQUE,
  original_body_sha256 text NOT NULL CHECK (original_body_sha256 ~ '^[0-9a-f]{64}$'),
  final_body_sha256 text NOT NULL CHECK (final_body_sha256 ~ '^[0-9a-f]{64}$'),
  ordered_model_ids jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(ordered_model_ids)='array'
    AND pg_catalog.jsonb_array_length(ordered_model_ids) BETWEEN 1 AND 8),
  api_key_id text NOT NULL,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  budget_epoch bigint NOT NULL,
  key_limit_epoch integer NOT NULL,
  credential_class text NOT NULL DEFAULT 'platform'
    CHECK (credential_class='platform'),
  route_count integer NOT NULL CHECK (route_count BETWEEN 1 AND 100),
  max_per_attempt_ceiling_micros bigint NOT NULL
    CHECK (max_per_attempt_ceiling_micros BETWEEN 0 AND 3002399751580330),
  three_attempt_ceiling_micros bigint NOT NULL
    CHECK (three_attempt_ceiling_micros=max_per_attempt_ceiling_micros*3
      AND three_attempt_ceiling_micros BETWEEN 0 AND 9007199254740991),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at)
);
CREATE INDEX complete_text_quotes_v360_expiry
  ON cinatoken_gateway.complete_text_quotes_v360(expires_at);

CREATE TABLE cinatoken_gateway.complete_text_quote_routes_v360 (
  quote_id uuid NOT NULL REFERENCES
    cinatoken_gateway.complete_text_quotes_v360(quote_id),
  candidate_index integer NOT NULL CHECK (candidate_index BETWEEN 0 AND 7),
  model_id text NOT NULL,
  route_target_id text NOT NULL,
  provider_id text NOT NULL,
  endpoint_id text NOT NULL,
  credential_class text NOT NULL CHECK (credential_class='platform'),
  credential_id text NOT NULL,
  provider_ciphertext_sha256 text NOT NULL
    CHECK (provider_ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  source_generation bigint NOT NULL CHECK (source_generation>=1),
  attested_source_sha256 text NOT NULL
    CHECK (attested_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  per_attempt_ceiling_micros bigint NOT NULL
    CHECK (per_attempt_ceiling_micros BETWEEN 0 AND 3002399751580330),
  PRIMARY KEY (quote_id,candidate_index,route_target_id,credential_class,
    credential_id)
);

CREATE FUNCTION cinatoken_gateway.reject_complete_text_quote_mutation_v360()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'complete text quote v360 is insert-only' USING ERRCODE='P0001';
END;
$immutable$;
CREATE TRIGGER complete_text_quotes_v360_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_quotes_v360
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_quote_mutation_v360();
CREATE TRIGGER complete_text_quote_routes_v360_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.complete_text_quote_routes_v360
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_complete_text_quote_mutation_v360();

CREATE FUNCTION cinatoken_gateway.issue_complete_flat_text_quote_v360(
  p_request_id text,p_capability text,p_original_body_sha256 text,
  p_final_body_utf8 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $issue$
DECLARE issued record; key_row record; user_row record; workspace_row record;
DECLARE body jsonb; model_ids text[] := ARRAY[]::text[]; raw_model text;
DECLARE body_key text; message jsonb; message_key text; index_no integer;
DECLARE model_row record; route_row record; pricing jsonb; pricing_key text;
DECLARE price_text text; candidate_price numeric;
DECLARE input_price numeric; output_price numeric; request_price numeric;
DECLARE raw_micros numeric; per_attempt bigint; max_per_attempt bigint := 0;
DECLARE input_ceiling_tokens integer; output_ceiling_tokens integer;
DECLARE requested_output_tokens integer := 0;
DECLARE source_snapshot jsonb; source_sha text; pending_rows jsonb := '[]'::jsonb;
DECLARE pending jsonb; quote_uuid uuid; final_sha text;
DECLARE server_now timestamptz; quote_expires_at timestamptz;
DECLARE route_count integer := 0; candidate_count integer;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_quote_issuer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_capability IS NULL OR p_capability !~
      '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR p_original_body_sha256 IS NULL
    OR p_original_body_sha256 !~ '^[0-9a-f]{64}$'
    OR p_final_body_utf8 IS NULL
    OR pg_catalog.octet_length(p_final_body_utf8) NOT BETWEEN 2 AND 1048576
  THEN RAISE EXCEPTION 'invalid complete text quote issue call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_quote_issue_call_v360'; END IF;

  SELECT * INTO issued FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR issued.capability_sha256<>pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_capability,'UTF8')),'hex')
    OR issued.body_sha256<>p_original_body_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF issued.invalidated_at IS NOT NULL OR issued.state<>'issued'
    OR issued.expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT k.* INTO key_row FROM cinatoken_gateway.api_keys k
    WHERE k.id=issued.api_key_id FOR SHARE;
  IF NOT FOUND OR key_row.key_hash IS DISTINCT FROM issued.key_hash
    OR key_row.key IS DISTINCT FROM 'hashref:' || issued.key_hash
    OR key_row.status IS DISTINCT FROM 'active'
    OR key_row.user_id IS DISTINCT FROM issued.user_id
    OR key_row.workspace_id IS DISTINCT FROM issued.workspace_id
    OR key_row.limit_epoch IS DISTINCT FROM issued.key_limit_epoch
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT u.* INTO user_row FROM cinatoken_gateway.users u
    WHERE u.id=issued.user_id FOR SHARE;
  IF NOT FOUND OR user_row.status IS DISTINCT FROM 'active'
    OR user_row.budget_epoch IS DISTINCT FROM issued.budget_epoch
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT w.* INTO workspace_row FROM cinatoken_gateway.workspaces w
    WHERE w.id=issued.workspace_id FOR SHARE;
  IF NOT FOUND OR workspace_row.status IS DISTINCT FROM 'active'
    OR workspace_row.scope_type IS DISTINCT FROM 'personal'
    OR workspace_row.personal_owner_user_id IS DISTINCT FROM issued.user_id
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;

  -- Authenticate before acquiring broad writer-blocking locks. A table-level
  -- source lock then gives this review candidate a complete route predicate
  -- snapshot: no route or credential INSERT can appear before COMMIT.
  -- This sacrifices throughput; a production revision scheme must preserve
  -- the same no-phantom property without table-level locks.
  LOCK TABLE cinatoken_gateway.models,
    cinatoken_gateway.model_surfaces,
    cinatoken_gateway.model_routes,
    cinatoken_gateway.route_pools,
    cinatoken_gateway.providers,
    cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.byok_keys,
    cinatoken_gateway.shared_keys IN SHARE MODE;
  server_now:=pg_catalog.clock_timestamp();
  IF issued.invalidated_at IS NOT NULL OR issued.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now) THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  IF user_row.charged_cost_factors IS NOT NULL
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.byok_keys b
      WHERE b.workspace_id=issued.workspace_id AND b.deleted_at IS NULL
        AND NOT b.disabled)
  THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;

  BEGIN body:=p_final_body_utf8::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported'); END;
  IF pg_catalog.jsonb_typeof(body) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  FOR body_key IN SELECT pg_catalog.jsonb_object_keys(body) LOOP
    IF body_key NOT IN ('model','models','messages','max_tokens',
      'max_completion_tokens','stream','temperature','top_p',
      'presence_penalty','frequency_penalty','seed','stop','user') THEN
      RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(body->'model') IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(body->'models') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(body->'messages') IS DISTINCT FROM 'array'
  THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  IF pg_catalog.jsonb_array_length(body->'models') NOT BETWEEN 1 AND 8
    OR pg_catalog.jsonb_array_length(body->'messages') NOT BETWEEN 1 AND 1024
  THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  raw_model:=pg_catalog.btrim(body->>'model');
  IF raw_model='' OR pg_catalog.length(raw_model)>240 THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  FOR index_no IN 0..pg_catalog.jsonb_array_length(body->'models')-1 LOOP
    IF pg_catalog.jsonb_typeof(body->'models'->index_no) IS DISTINCT FROM 'string' THEN
      RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    raw_model:=pg_catalog.btrim(body->'models'->>index_no);
    IF raw_model='' OR pg_catalog.length(raw_model)>240
      OR raw_model=ANY(model_ids) THEN
      RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    model_ids:=pg_catalog.array_append(model_ids,raw_model);
  END LOOP;
  IF model_ids[1] IS DISTINCT FROM pg_catalog.btrim(body->>'model') THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  FOR message IN SELECT value
      FROM pg_catalog.jsonb_array_elements(body->'messages') LOOP
    IF pg_catalog.jsonb_typeof(message) IS DISTINCT FROM 'object'
      OR message->>'role' IS NULL
      OR message->>'role' NOT IN ('system','developer','user','assistant')
      OR pg_catalog.jsonb_typeof(message->'content') IS DISTINCT FROM 'string' THEN
      RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    FOR message_key IN SELECT pg_catalog.jsonb_object_keys(message) LOOP
      IF message_key NOT IN ('role','content') THEN
        RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    END LOOP;
  END LOOP;
  IF (body ? 'stream' AND pg_catalog.jsonb_typeof(body->'stream')<>'boolean')
    OR (body ? 'max_tokens' AND (pg_catalog.jsonb_typeof(body->'max_tokens')<>'number'
      OR (body->>'max_tokens') !~ '^[0-9]{1,9}$'))
    OR (body ? 'max_completion_tokens' AND
      (pg_catalog.jsonb_typeof(body->'max_completion_tokens')<>'number'
        OR (body->>'max_completion_tokens') !~ '^[0-9]{1,9}$'))
  THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  IF body ? 'max_tokens' THEN
    requested_output_tokens:=greatest(requested_output_tokens,
      (body->>'max_tokens')::integer); END IF;
  IF body ? 'max_completion_tokens' THEN
    requested_output_tokens:=greatest(requested_output_tokens,
      (body->>'max_completion_tokens')::integer); END IF;
  final_sha:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_final_body_utf8,'UTF8')),'hex');
  candidate_count:=pg_catalog.array_length(model_ids,1);
  quote_expires_at:=least(issued.expires_at,
    coalesce(key_row.expires_at,'infinity'::timestamptz));

  FOR index_no IN 1..candidate_count LOOP
    SELECT m.* INTO model_row FROM cinatoken_gateway.models m
      WHERE m.id=model_ids[index_no] FOR SHARE;
    -- Suffix resolution and variants are excluded. An exact models.id match
    -- is the same direct-model branch used by resolveModelRouting.
    IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    -- A surface can point to a pool containing another model's route because
    -- route_pool_id is only a single-column FK. The Worker would select that
    -- cross-model target even though an enumeration by r.model_id misses it.
    -- Reject such topology; otherwise all active own-model rows are a safe
    -- superset of exact/wildcard surface and legacy fallback selection.
    IF EXISTS (SELECT 1 FROM cinatoken_gateway.model_surfaces s
      JOIN cinatoken_gateway.route_pools rp ON rp.id=s.route_pool_id
      WHERE s.model_id=model_row.id AND lower(s.route_group)='default'
        AND lower(s.request_protocol)='openai'
        AND s.request_operation IN ('chat','*')
        AND s.status='active' AND rp.status='active'
        AND (rp.model_id<>model_row.id OR EXISTS (
          SELECT 1 FROM cinatoken_gateway.model_routes sr
          WHERE sr.route_pool_id=s.route_pool_id AND sr.status='active'
            AND sr.model_id<>model_row.id))) THEN
      RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    IF (SELECT pg_catalog.count(*) FROM cinatoken_gateway.model_routes r
        WHERE r.model_id=model_row.id AND r.status='active')=0 THEN
      RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
    FOR route_row IN
      SELECT r.id AS route_target_id,r.model_id,r.provider_id,
        r.provider_model_name,r.route_group,r.upstream_protocol,
        r.upstream_operation,r.adapter,r.price_override,r.custom_params,
        r.routing_metadata,r.route_pool_id,
        po.status AS provider_status,po.api_key AS provider_api_key,
        po.shared_channel_type,rp.status AS pool_status,
        er.subject_fingerprint,e.id AS endpoint_id,e.status AS endpoint_status,
        e.context_length,e.max_prompt_tokens,e.max_completion_tokens,
        e.pricing,e.evidence_url,e.verified_by,e.verified_at,
        e.expires_at AS endpoint_expires_at,
        f.generation,f.verified_generation,
        f.verified_subject_fingerprint,f.attested_source_sha256
      FROM cinatoken_gateway.model_routes r
      LEFT JOIN cinatoken_gateway.providers po ON po.id=r.provider_id
      LEFT JOIN cinatoken_gateway.route_pools rp ON rp.id=r.route_pool_id
        AND rp.model_id=r.model_id AND rp.route_group=r.route_group
      LEFT JOIN cinatoken_gateway.model_endpoint_routes er
        ON er.route_target_id=r.id
      LEFT JOIN cinatoken_gateway.model_endpoints e ON e.id=er.endpoint_id
        AND e.model_id=r.model_id AND e.provider_id=r.provider_id
      LEFT JOIN cinatoken_gateway.route_source_generations_v359 f
        ON f.route_target_id=r.id
      WHERE r.model_id=model_row.id AND r.status='active'
      ORDER BY r.id
    LOOP
      route_count:=route_count+1;
      IF route_count>100 OR route_row.provider_status IS DISTINCT FROM 'active'
        OR route_row.provider_api_key IS NULL
        OR route_row.provider_api_key NOT LIKE 'enc:v2:%'
        OR route_row.shared_channel_type IS NOT NULL
        OR route_row.pool_status IS DISTINCT FROM 'active'
        OR route_row.route_group<>'default'
        OR route_row.upstream_protocol<>'openai'
        OR route_row.upstream_operation<>'chat'
        OR route_row.adapter<>'passthrough'
        OR route_row.price_override IS NOT NULL
        OR route_row.custom_params IS NOT NULL
        OR route_row.routing_metadata IS NOT NULL
        OR route_row.endpoint_status IS DISTINCT FROM 'verified'
        OR route_row.context_length IS NULL OR route_row.context_length<=0
        OR route_row.evidence_url IS NULL
        OR route_row.evidence_url !~ '^https://[A-Za-z0-9.-]+(/|$)'
        OR route_row.verified_by IS NULL OR route_row.verified_by=''
        OR route_row.verified_at IS NULL
        OR route_row.endpoint_expires_at IS NULL
        OR route_row.generation IS NULL
        OR route_row.verified_generation IS DISTINCT FROM route_row.generation
        OR route_row.subject_fingerprint IS DISTINCT FROM
          route_row.verified_subject_fingerprint
        OR route_row.attested_source_sha256 IS NULL
      THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
      BEGIN pricing:=route_row.pricing::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        RETURN pg_catalog.jsonb_build_object('status','unsupported'); END;
      IF pg_catalog.jsonb_typeof(pricing)<>'object'
        OR pricing->>'currency' IS DISTINCT FROM 'USD'
        OR (pricing ? 'discount' AND (pg_catalog.jsonb_typeof(pricing->'discount')<>'number'
          OR (pricing->>'discount')::numeric<>0))
      THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
      input_price:=0; output_price:=0; request_price:=0;
      FOR pricing_key IN SELECT pg_catalog.jsonb_object_keys(pricing) LOOP
        IF pricing_key NOT IN ('currency','prompt','completion',
          'input_cache_read','input_cache_write','input_cache_write_1h',
          'request','discount') THEN
          RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
      END LOOP;
      FOREACH pricing_key IN ARRAY ARRAY['prompt','completion',
        'input_cache_read','input_cache_write','input_cache_write_1h','request'] LOOP
        IF NOT pricing ? pricing_key THEN
          IF pricing_key IN ('prompt','completion') THEN
            RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
          CONTINUE;
        END IF;
        IF pg_catalog.jsonb_typeof(pricing->pricing_key)<>'string' THEN
          RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
        price_text:=pricing->>pricing_key;
        IF pg_catalog.length(price_text)>64 OR price_text !~
          '^[0-9]{1,20}(\.[0-9]{1,18})?$' THEN
          RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
        candidate_price:=price_text::numeric;
        IF pricing_key='completion' THEN output_price:=candidate_price;
        ELSIF pricing_key='request' THEN request_price:=candidate_price;
        ELSE input_price:=greatest(input_price,candidate_price); END IF;
      END LOOP;
      server_now:=pg_catalog.clock_timestamp();
      IF route_row.verified_at>server_now
        OR route_row.endpoint_expires_at<=server_now THEN
        RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
      quote_expires_at:=least(quote_expires_at,
        route_row.endpoint_expires_at);
      input_ceiling_tokens:=greatest(route_row.context_length,
        coalesce(route_row.max_prompt_tokens,0));
      output_ceiling_tokens:=greatest(route_row.context_length,
        coalesce(route_row.max_completion_tokens,0),requested_output_tokens);
      raw_micros:=pg_catalog.ceil((input_ceiling_tokens::numeric*input_price
        +output_ceiling_tokens::numeric*output_price+request_price)*1000000);
      IF raw_micros>0 THEN raw_micros:=raw_micros+1; END IF;
      IF raw_micros>3002399751580330 THEN
        RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
      per_attempt:=raw_micros::bigint;
      max_per_attempt:=greatest(max_per_attempt,per_attempt);
      source_snapshot:=pg_catalog.jsonb_build_object(
        'modelId',route_row.model_id,'routeTargetId',route_row.route_target_id,
        'providerId',route_row.provider_id,
        'providerModelName',route_row.provider_model_name,
        'providerCiphertextSha256',pg_catalog.encode(pg_catalog.sha256(
          pg_catalog.convert_to(route_row.provider_api_key,'UTF8')),'hex'),
        'credentialClass','platform','credentialId',route_row.provider_id,
        'endpointId',route_row.endpoint_id,'sourceGeneration',route_row.generation,
        'attestedSourceSha256',route_row.attested_source_sha256,
        'persistedRouteSubjectFingerprint',route_row.subject_fingerprint,
        'contextTokens',route_row.context_length,
        'requestedOutputTokens',requested_output_tokens,
        'inputCeilingTokens',input_ceiling_tokens,
        'outputCeilingTokens',output_ceiling_tokens,
        'endpointExpiresAt',route_row.endpoint_expires_at,
        'endpointEvidenceUrl',route_row.evidence_url,'pricing',pricing);
      source_sha:=pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(source_snapshot::text,'UTF8')),'hex');
      pending_rows:=pending_rows || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('candidateIndex',index_no-1,
          'modelId',route_row.model_id,'routeTargetId',route_row.route_target_id,
          'providerId',route_row.provider_id,'endpointId',route_row.endpoint_id,
          'providerCiphertextSha256',source_snapshot->>'providerCiphertextSha256',
          'sourceGeneration',route_row.generation,
          'attestedSourceSha256',route_row.attested_source_sha256,
          'sourceSnapshot',source_snapshot,'sourceSha256',source_sha,
          'perAttemptCeilingMicros',per_attempt));
    END LOOP;
  END LOOP;
  server_now:=pg_catalog.clock_timestamp();
  IF issued.invalidated_at IS NOT NULL OR issued.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR quote_expires_at<=server_now OR route_count<1 THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  quote_uuid:=pg_catalog.gen_random_uuid();
  INSERT INTO cinatoken_gateway.complete_text_quotes_v360
    (request_id,quote_id,original_body_sha256,final_body_sha256,
      ordered_model_ids,api_key_id,user_id,workspace_id,budget_epoch,
      key_limit_epoch,route_count,max_per_attempt_ceiling_micros,
      three_attempt_ceiling_micros,issued_at,expires_at)
    VALUES (p_request_id,quote_uuid,issued.body_sha256,final_sha,
      pg_catalog.to_jsonb(model_ids),issued.api_key_id,issued.user_id,
      issued.workspace_id,issued.budget_epoch,issued.key_limit_epoch,
      route_count,max_per_attempt,max_per_attempt*3,server_now,quote_expires_at);
  FOR pending IN SELECT value FROM pg_catalog.jsonb_array_elements(pending_rows) LOOP
    INSERT INTO cinatoken_gateway.complete_text_quote_routes_v360
      (quote_id,candidate_index,model_id,route_target_id,provider_id,
        endpoint_id,credential_class,credential_id,provider_ciphertext_sha256,
        source_generation,attested_source_sha256,source_snapshot,
        source_sha256,per_attempt_ceiling_micros)
      VALUES (quote_uuid,(pending->>'candidateIndex')::integer,
        pending->>'modelId',pending->>'routeTargetId',pending->>'providerId',
        pending->>'endpointId','platform',pending->>'providerId',
        pending->>'providerCiphertextSha256',
        (pending->>'sourceGeneration')::bigint,
        pending->>'attestedSourceSha256',pending->'sourceSnapshot',
        pending->>'sourceSha256',(pending->>'perAttemptCeilingMicros')::bigint);
  END LOOP;
  server_now:=pg_catalog.clock_timestamp();
  IF server_now>=quote_expires_at THEN
    RAISE EXCEPTION 'complete text quote expired before claim'
      USING ERRCODE='23514',CONSTRAINT='complete_text_quote_expiry_v360'; END IF;
  UPDATE cinatoken_gateway.authenticated_request_capabilities_v356
    SET state='claimed',claimed_at=server_now WHERE request_id=p_request_id;
  RETURN pg_catalog.jsonb_build_object('status','quoted_complete_subset',
    'quoteId',quote_uuid,'requestId',p_request_id,
    'finalBodySha256',final_sha,'modelIds',pg_catalog.to_jsonb(model_ids),
    'routeCount',route_count,'credentialClass','platform',
    'maxPerAttemptCeilingMicros',max_per_attempt,
    'threeAttemptCeilingMicros',max_per_attempt*3,
    'expiresAt',quote_expires_at);
END;
$issue$;

REVOKE ALL ON cinatoken_gateway.complete_text_quotes_v360,
  cinatoken_gateway.complete_text_quote_routes_v360
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_complete_text_quote_issuer;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text),
  cinatoken_gateway.reject_complete_text_quote_mutation_v360()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_complete_text_quote_issuer;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_quote_issuer;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text)
  TO cinatoken_gateway_complete_text_quote_issuer;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_complete_text_quote_issuer',
      'cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.issue_complete_flat_text_quote_v360(text,text,text,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(
      'cinatoken_gateway_complete_text_quote_issuer',
      'cinatoken_gateway.complete_text_quotes_v360','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.complete_text_quote_routes_v360',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname IN ('complete_text_quotes_v360_no_mutation',
        'complete_text_quote_routes_v360_no_mutation')
        AND t.tgenabled='O' AND NOT t.tgisinternal)<>2
  THEN RAISE EXCEPTION 'complete text quote v360 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
