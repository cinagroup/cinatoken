-- REVIEW ONLY: one verified, flat-text target's conservative price ceiling.
-- This is a quote fragment, never a complete request quote, budget hold, or
-- dispatch grant. Install after v356 with a separately provisioned direct
-- NOINHERIT LOGIN cinatoken_gateway_request_route_ceiling_issuer.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923556);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.authenticated_request_capabilities_v356,
  cinatoken_gateway.users, cinatoken_gateway.api_keys,
  cinatoken_gateway.workspaces, cinatoken_gateway.providers,
  cinatoken_gateway.model_routes, cinatoken_gateway.route_pools,
  cinatoken_gateway.model_endpoint_routes,
  cinatoken_gateway.model_endpoints IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid; issuer_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO issuer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_request_route_ceiling_issuer';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.request_route_ceiling_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL OR issuer_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.request_text_route_ceilings_v357') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357()') IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.authenticated_request_capabilities_v356') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.issue_request_capability_v356(text,text,text)') IS NULL
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
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND pg_catalog.has_function_privilege(issuer_oid,p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'request route ceiling v357 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.request_text_route_ceilings_v357 (
  request_id text PRIMARY KEY REFERENCES
    cinatoken_gateway.authenticated_request_capabilities_v356(request_id),
  quote_id uuid NOT NULL UNIQUE,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  api_key_id text NOT NULL,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  budget_epoch bigint NOT NULL,
  key_limit_epoch integer NOT NULL,
  route_target_id text NOT NULL,
  model_id text NOT NULL,
  provider_id text NOT NULL,
  endpoint_id text NOT NULL,
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_algorithm text NOT NULL DEFAULT 'flat-text-capacity-v1'
    CHECK (pricing_algorithm='flat-text-capacity-v1'),
  context_tokens integer NOT NULL CHECK (context_tokens>0),
  input_ceiling_tokens integer NOT NULL CHECK (input_ceiling_tokens>=context_tokens),
  output_ceiling_tokens integer NOT NULL CHECK (output_ceiling_tokens>=context_tokens),
  per_attempt_ceiling_micros bigint NOT NULL
    CHECK (per_attempt_ceiling_micros BETWEEN 0 AND 9007199254740991),
  three_attempt_ceiling_micros bigint NOT NULL
    CHECK (three_attempt_ceiling_micros=per_attempt_ceiling_micros*3
      AND three_attempt_ceiling_micros BETWEEN 0 AND 9007199254740991),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at)
);
CREATE INDEX request_text_route_ceilings_v357_expiry
  ON cinatoken_gateway.request_text_route_ceilings_v357(expires_at);

CREATE FUNCTION cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'request route ceiling v357 is insert-only'
    USING ERRCODE='P0001';
END;
$immutable$;
CREATE TRIGGER request_text_route_ceilings_v357_no_mutation
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.request_text_route_ceilings_v357
  FOR EACH ROW EXECUTE FUNCTION
    cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357();

CREATE FUNCTION cinatoken_gateway.issue_request_text_route_ceiling_v357(
  p_request_id text,p_capability text,p_body_sha256 text,p_route_target_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $issue$
DECLARE issued record; key_row record; user_row record; workspace_row record;
DECLARE route_row record; pricing jsonb; pricing_key text; price_text text;
DECLARE input_price numeric := 0; output_price numeric := 0;
DECLARE request_price numeric := 0; candidate_price numeric;
DECLARE raw_micros numeric; per_attempt bigint; quote_uuid uuid;
DECLARE input_ceiling_tokens integer; output_ceiling_tokens integer;
DECLARE snapshot jsonb; snapshot_sha256 text; server_now timestamptz;
DECLARE quote_expires_at timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_request_route_ceiling_issuer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_capability IS NULL OR p_capability !~
      '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
    OR p_route_target_id IS NULL OR pg_catalog.length(p_route_target_id)
      NOT BETWEEN 1 AND 128
  THEN RAISE EXCEPTION 'invalid request route ceiling issue call'
    USING ERRCODE='23514',CONSTRAINT='request_route_ceiling_issue_call_v357'; END IF;
  SELECT * INTO issued FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR issued.capability_sha256<>pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_capability,'UTF8')),'hex')
    OR issued.body_sha256<>p_body_sha256
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
  -- This deliberately supports only the simplest flat-text path. A non-null
  -- user factor or route override, shared channel, or adapter needs a later
  -- complete route/credential quote. A private BYOK selection can still
  -- override this provider row; this fragment never proves credential class.
  IF user_row.charged_cost_factors IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  SELECT r.id AS route_target_id,r.model_id,r.provider_id,
      r.provider_model_name,r.route_group,
      r.upstream_protocol,r.upstream_operation,r.adapter,r.status AS route_status,
      r.price_override,r.custom_params,r.route_pool_id,
      po.status AS provider_status,po.shared_channel_type,
      rp.status AS pool_status,e.id AS endpoint_id,e.status AS endpoint_status,
      e.context_length,e.max_prompt_tokens,e.max_completion_tokens,
      e.pricing,e.evidence_url,e.verified_by,
      er.subject_fingerprint,
      e.verified_at,e.expires_at AS endpoint_expires_at
    INTO route_row
    FROM cinatoken_gateway.model_routes r
    JOIN cinatoken_gateway.providers po ON po.id=r.provider_id
    JOIN cinatoken_gateway.route_pools rp ON rp.id=r.route_pool_id
      AND rp.model_id=r.model_id AND rp.route_group=r.route_group
    JOIN cinatoken_gateway.model_endpoint_routes er
      ON er.route_target_id=r.id
    JOIN cinatoken_gateway.model_endpoints e ON e.id=er.endpoint_id
      AND e.model_id=r.model_id AND e.provider_id=r.provider_id
    WHERE r.id=p_route_target_id
    FOR SHARE OF r,po,rp,er,e;
  IF NOT FOUND OR route_row.route_status<>'active'
    OR route_row.provider_status<>'active'
    OR route_row.pool_status<>'active'
    OR route_row.shared_channel_type IS NOT NULL
    OR route_row.route_group<>'default'
    OR route_row.upstream_protocol<>'openai'
    OR route_row.upstream_operation<>'chat'
    OR route_row.adapter<>'passthrough'
    OR route_row.price_override IS NOT NULL
    OR route_row.custom_params IS NOT NULL
    OR route_row.endpoint_status<>'verified'
    OR route_row.subject_fingerprint IS NULL
    OR route_row.subject_fingerprint !~ '^[0-9a-f]{64}$'
    OR route_row.context_length IS NULL OR route_row.context_length<=0
    OR route_row.evidence_url IS NULL
    OR route_row.evidence_url !~ '^https://[A-Za-z0-9.-]+(/|$)'
    OR route_row.verified_by IS NULL OR route_row.verified_by=''
    OR route_row.verified_at IS NULL
    OR route_row.endpoint_expires_at IS NULL
  THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  BEGIN
    pricing:=route_row.pricing::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported');
  END;
  IF pg_catalog.jsonb_typeof(pricing)<>'object'
    OR pricing->>'currency' IS DISTINCT FROM 'USD'
    OR (pricing ? 'discount' AND (pg_catalog.jsonb_typeof(pricing->'discount')<>'number'
      OR (pricing->>'discount')::numeric<>0))
  THEN RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
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
  -- Recheck time after all lock waits, including route and endpoint rows.
  server_now:=pg_catalog.clock_timestamp();
  quote_expires_at:=least(issued.expires_at,
    route_row.endpoint_expires_at,
    coalesce(key_row.expires_at,'infinity'::timestamptz));
  IF issued.invalidated_at IS NOT NULL OR issued.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR route_row.verified_at>server_now OR quote_expires_at<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  -- Each side receives at least the full context window; independently
  -- declared prompt/completion maxima can only increase the bound.
  -- One micro covers intermediate six-decimal billing rounding per attempt.
  input_ceiling_tokens:=greatest(route_row.context_length,
    coalesce(route_row.max_prompt_tokens,0));
  output_ceiling_tokens:=greatest(route_row.context_length,
    coalesce(route_row.max_completion_tokens,0));
  raw_micros:=pg_catalog.ceil((input_ceiling_tokens::numeric*input_price
    +output_ceiling_tokens::numeric*output_price+request_price)*1000000);
  IF raw_micros>0 THEN raw_micros:=raw_micros+1; END IF;
  IF raw_micros>3002399751580330 THEN
    RETURN pg_catalog.jsonb_build_object('status','unsupported'); END IF;
  per_attempt:=raw_micros::bigint;
  snapshot:=pg_catalog.jsonb_build_object(
    'routeTargetId',route_row.route_target_id,
    'modelId',route_row.model_id,'providerId',route_row.provider_id,
    'providerModelName',route_row.provider_model_name,
    'persistedRouteSubjectFingerprint',route_row.subject_fingerprint,
    'routePoolId',route_row.route_pool_id,
    'routeStatus',route_row.route_status,
    'routeGroup',route_row.route_group,
    'upstreamProtocol',route_row.upstream_protocol,
    'upstreamOperation',route_row.upstream_operation,
    'adapter',route_row.adapter,
    'providerStatus',route_row.provider_status,
    'poolStatus',route_row.pool_status,
    'sharedChannelType',route_row.shared_channel_type,
    'endpointId',route_row.endpoint_id,
    'endpointStatus',route_row.endpoint_status,
    'endpointVerifiedAt',route_row.verified_at,
    'endpointExpiresAt',route_row.endpoint_expires_at,
    'endpointEvidenceUrl',route_row.evidence_url,
    'contextTokens',route_row.context_length,
    'maxPromptTokens',route_row.max_prompt_tokens,
    'maxCompletionTokens',route_row.max_completion_tokens,
    'inputCeilingTokens',input_ceiling_tokens,
    'outputCeilingTokens',output_ceiling_tokens,
    'pricing',pricing,
    'userChargedFactors',NULL,
    'routePriceOverride',NULL,
    'routeCustomParams',NULL);
  snapshot_sha256:=pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(snapshot::text,'UTF8')),'hex');
  quote_uuid:=pg_catalog.gen_random_uuid();
  INSERT INTO cinatoken_gateway.request_text_route_ceilings_v357
    (request_id,quote_id,body_sha256,api_key_id,user_id,workspace_id,
      budget_epoch,key_limit_epoch,route_target_id,model_id,provider_id,
      endpoint_id,source_snapshot,source_sha256,context_tokens,
      input_ceiling_tokens,output_ceiling_tokens,
      per_attempt_ceiling_micros,three_attempt_ceiling_micros,
      issued_at,expires_at)
    VALUES (p_request_id,quote_uuid,issued.body_sha256,issued.api_key_id,
      issued.user_id,issued.workspace_id,issued.budget_epoch,
      issued.key_limit_epoch,route_row.route_target_id,route_row.model_id,
      route_row.provider_id,route_row.endpoint_id,snapshot,snapshot_sha256,
      route_row.context_length,input_ceiling_tokens,output_ceiling_tokens,
      per_attempt,per_attempt*3,
      server_now,quote_expires_at);
  -- The insert can wait on a uniqueness or FK lock. Never claim a capability
  -- with a pre-wait timestamp after its Key/evidence/capability deadline.
  server_now:=pg_catalog.clock_timestamp();
  IF server_now>=quote_expires_at THEN
    RAISE EXCEPTION 'request route ceiling expired before commit'
      USING ERRCODE='23514',CONSTRAINT='request_route_ceiling_expiry_v357';
  END IF;
  UPDATE cinatoken_gateway.authenticated_request_capabilities_v356
    SET state='claimed',claimed_at=server_now WHERE request_id=p_request_id;
  RETURN pg_catalog.jsonb_build_object('status','quoted_fragment',
    'quoteId',quote_uuid,'requestId',p_request_id,
    'routeTargetId',route_row.route_target_id,
    'perAttemptCeilingMicros',per_attempt,
    'threeAttemptCeilingMicros',per_attempt*3,
    'sourceSha256',snapshot_sha256,'expiresAt',quote_expires_at);
END;
$issue$;

REVOKE ALL ON cinatoken_gateway.request_text_route_ceilings_v357
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_request_route_ceiling_issuer;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text),
  cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_request_route_ceiling_issuer;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_request_route_ceiling_issuer;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text)
  TO cinatoken_gateway_request_route_ceiling_issuer;

DO $postflight$
DECLARE issuer_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO issuer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_request_route_ceiling_issuer';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF NOT pg_catalog.has_function_privilege(issuer_oid,
      'cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(issuer_oid,
      'cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357()','EXECUTE')
    OR pg_catalog.has_table_privilege(issuer_oid,
      'cinatoken_gateway.request_text_route_ceilings_v357',
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.request_text_route_ceilings_v357',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname='request_text_route_ceilings_v357_no_mutation'
        AND t.tgenabled='O' AND NOT t.tgisinternal
        AND t.tgfoid='cinatoken_gateway.reject_request_text_route_ceiling_mutation_v357()'::pg_catalog.regprocedure)<>1
  THEN RAISE EXCEPTION 'request route ceiling v357 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
