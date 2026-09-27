-- REVIEW ONLY. Holder-only read of one committed v360 strict flat-text route.
-- The v362 grant independently rechecks the entire manifest after this read.
-- Install after v356/v359/v360 as the migrator in one transaction with
-- complete_text_private_route_reader_activation=reviewed-v1. Provision a
-- distinct direct NOINHERIT LOGIN first. No production role is changed here.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923556);
SELECT pg_catalog.pg_advisory_xact_lock(746923559);
SELECT pg_catalog.pg_advisory_xact_lock(746923560);
SELECT pg_catalog.pg_advisory_xact_lock(746923566);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_quotes_v360,
  cinatoken_gateway.complete_text_quote_routes_v360,
  cinatoken_gateway.authenticated_request_capabilities_v356,
  cinatoken_gateway.route_source_generations_v359
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; reader_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_private_reader';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_private_route_reader_activation',true)
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
    OR pg_catalog.has_schema_privilege(reader_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE n.nspname LIKE 'cinatoken_economic_%'
        AND pg_catalog.has_schema_privilege(reader_oid,n.oid,'USAGE'))
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.read_private_complete_text_route_v366(text,uuid,integer,text)')
        IS NOT NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.complete_text_quotes_v360') IS NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.complete_text_quote_routes_v360') IS NULL
    OR pg_catalog.to_regclass('cinatoken_gateway.route_source_generations_v359') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(reader_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(reader_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(reader_oid,p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'complete text private route reader v366 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.read_private_complete_text_route_v366(
  p_request_id text,p_quote_id uuid,p_candidate_index integer,p_route_target_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $read$
DECLARE q record; m record; cap record; key_row record; user_row record;
DECLARE workspace_row record; live record; server_now timestamptz;
DECLARE route_count integer; max_ceiling bigint; endpoint_map jsonb;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_private_reader'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_quote_id IS NULL OR p_candidate_index IS NULL
    OR p_candidate_index NOT BETWEEN 0 AND 7
    OR p_route_target_id IS NULL OR pg_catalog.octet_length(p_route_target_id)
      NOT BETWEEN 1 AND 256
  THEN RAISE EXCEPTION 'invalid private complete text route read'
    USING ERRCODE='23514',CONSTRAINT='private_complete_text_route_call_v366'; END IF;
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=p_request_id AND quote_id=p_quote_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','not_found'); END IF;
  SELECT * INTO m FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=p_quote_id AND candidate_index=p_candidate_index
      AND route_target_id=p_route_target_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','target_not_in_manifest'); END IF;
  SELECT * INTO cap FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=q.request_id FOR SHARE;
  SELECT * INTO key_row FROM cinatoken_gateway.api_keys
    WHERE id=q.api_key_id FOR SHARE;
  SELECT * INTO user_row FROM cinatoken_gateway.users
    WHERE id=q.user_id FOR SHARE;
  SELECT * INTO workspace_row FROM cinatoken_gateway.workspaces
    WHERE id=q.workspace_id FOR SHARE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR q.credential_class IS DISTINCT FROM 'platform'
    OR cap.request_id IS NULL OR cap.state<>'claimed'
    OR cap.invalidated_at IS NOT NULL OR cap.expires_at<=server_now
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
    OR m.model_id IS DISTINCT FROM q.ordered_model_ids->>p_candidate_index
    OR m.credential_class IS DISTINCT FROM 'platform'
    OR m.credential_id IS DISTINCT FROM m.provider_id
    OR m.source_sha256 IS DISTINCT FROM pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(m.source_snapshot::text,'UTF8')),'hex')
    OR m.source_snapshot->>'modelId' IS DISTINCT FROM m.model_id
    OR m.source_snapshot->>'routeTargetId' IS DISTINCT FROM m.route_target_id
    OR m.source_snapshot->>'providerId' IS DISTINCT FROM m.provider_id
    OR m.source_snapshot->>'endpointId' IS DISTINCT FROM m.endpoint_id
    OR m.source_snapshot->>'providerModelName' IS NULL
    OR m.source_snapshot->>'providerCiphertextSha256'
      IS DISTINCT FROM m.provider_ciphertext_sha256
    OR m.source_snapshot->>'sourceGeneration'
      IS DISTINCT FROM m.source_generation::text
    OR m.source_snapshot->>'attestedSourceSha256'
      IS DISTINCT FROM m.attested_source_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT pg_catalog.count(*)::integer,pg_catalog.max(per_attempt_ceiling_micros)
    INTO route_count,max_ceiling
    FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id;
  IF route_count<>q.route_count OR route_count NOT BETWEEN 1 AND 100
    OR max_ceiling IS NULL OR max_ceiling<=0
    OR max_ceiling<>q.max_per_attempt_ceiling_micros
    OR q.three_attempt_ceiling_micros<>max_ceiling*3
  THEN RETURN pg_catalog.jsonb_build_object('status','invalid_manifest'); END IF;

  -- A table lock makes this selected source coherent through this read only.
  -- The later v362 grant must recheck it; this read cannot authorize a send.
  LOCK TABLE cinatoken_gateway.model_routes,
    cinatoken_gateway.route_pools,
    cinatoken_gateway.providers,
    cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.byok_keys IN SHARE MODE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.byok_keys b
      WHERE b.workspace_id=q.workspace_id AND b.deleted_at IS NULL
        AND NOT b.disabled)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT r.id AS route_target_id,r.model_id,r.provider_id,
    r.provider_model_name,r.route_pool_id,r.route_group,r.priority,r.weight,
    po.name AS provider_name,po.api_key AS provider_ciphertext,
    po.endpoints AS provider_endpoints,po.shared_channel_type,
    e.id AS endpoint_id,e.provider_slug,e.tag,e.endpoint_class,e.region,
    e.context_length,e.max_prompt_tokens,e.max_completion_tokens,
    e.quantization,e.supported_parameters,e.pricing,e.supports_tool_choice,
    e.image_capabilities,e.audio_capabilities,e.supports_implicit_caching,
    e.supports_voice_cloning,e.evidence_url,e.verified_by,e.verified_at,
    e.expires_at AS endpoint_expires_at,e.created_at AS endpoint_created_at,
    e.updated_at AS endpoint_updated_at,
    er.subject_fingerprint,f.generation,f.verified_generation,
    f.verified_subject_fingerprint,f.attested_source_sha256
    INTO live
    FROM cinatoken_gateway.model_routes r
    JOIN cinatoken_gateway.route_pools rp
      ON rp.id=r.route_pool_id AND rp.model_id=r.model_id
        AND rp.route_group=r.route_group
    JOIN cinatoken_gateway.providers po ON po.id=r.provider_id
    JOIN cinatoken_gateway.model_endpoint_routes er ON er.route_target_id=r.id
    JOIN cinatoken_gateway.model_endpoints e
      ON e.id=er.endpoint_id AND e.model_id=r.model_id
        AND e.provider_id=r.provider_id
    JOIN cinatoken_gateway.route_source_generations_v359 f
      ON f.route_target_id=r.id
    WHERE r.id=m.route_target_id AND r.model_id=m.model_id
      AND r.provider_id=m.provider_id AND r.status='active'
      AND r.route_group='default' AND r.upstream_protocol='openai'
      AND r.upstream_operation='chat' AND r.adapter='passthrough'
      AND r.price_override IS NULL AND r.custom_params IS NULL
      AND r.routing_metadata IS NULL AND rp.status='active'
      AND po.status='active' AND po.shared_channel_type IS NULL
      AND po.api_key LIKE 'enc:v2:%'
      AND pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(po.api_key,'UTF8')),'hex')
          =m.provider_ciphertext_sha256
      AND e.id=m.endpoint_id AND e.status='verified'
      AND e.expires_at>server_now AND e.verified_at<=server_now
      AND f.generation=m.source_generation
      AND f.verified_generation=f.generation
      AND f.attested_source_sha256=m.attested_source_sha256
      AND f.verified_subject_fingerprint=er.subject_fingerprint;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','stale_source'); END IF;
  IF live.provider_model_name IS DISTINCT FROM
       m.source_snapshot->>'providerModelName'
    OR live.subject_fingerprint IS DISTINCT FROM
       m.source_snapshot->>'persistedRouteSubjectFingerprint'
    OR live.context_length IS DISTINCT FROM
       (m.source_snapshot->>'contextTokens')::integer
    OR live.evidence_url IS DISTINCT FROM
       m.source_snapshot->>'endpointEvidenceUrl'
    OR pg_catalog.octet_length(live.provider_ciphertext)>4096
    OR (live.provider_endpoints IS NOT NULL AND
      pg_catalog.octet_length(live.provider_endpoints)>16384)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_source'); END IF;
  BEGIN
    endpoint_map:=CASE WHEN live.provider_endpoints IS NULL THEN '{}'::jsonb
      ELSE live.provider_endpoints::jsonb END;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('status','stale_source');
  END;
  IF pg_catalog.jsonb_typeof(endpoint_map)<>'object'
  THEN RETURN pg_catalog.jsonb_build_object('status','stale_source'); END IF;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.expires_at<=server_now
    OR live.endpoint_expires_at<=server_now
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status','private_route_loaded',
    'quote',pg_catalog.jsonb_build_object(
      'requestId',q.request_id,'quoteId',q.quote_id,
      'finalBodySha256',q.final_body_sha256,
      'modelIds',q.ordered_model_ids,'routeCount',q.route_count,
      'credentialClass',q.credential_class,
      'maxPerAttemptCeilingMicros',q.max_per_attempt_ceiling_micros,
      'threeAttemptCeilingMicros',q.three_attempt_ceiling_micros,
      'expiresAt',q.expires_at),
    'selected',pg_catalog.jsonb_build_object(
      'candidateIndex',m.candidate_index,'modelId',m.model_id,
      'routeTargetId',m.route_target_id,'routePoolId',live.route_pool_id,
      'routeGroup',live.route_group,'routePriority',live.priority,
      'routeWeight',live.weight,'providerId',m.provider_id,
      'providerName',live.provider_name,
      'providerModelName',live.provider_model_name,
      'providerCiphertext',live.provider_ciphertext,
      'providerEndpoints',CASE WHEN endpoint_map ? 'openai'
        THEN pg_catalog.jsonb_build_object('openai',endpoint_map->'openai')
        ELSE '{}'::jsonb END,'endpointId',m.endpoint_id,
      'endpointRow',pg_catalog.jsonb_build_object(
        'id',live.endpoint_id,'model_id',live.model_id,
        'provider_id',live.provider_id,'provider_slug',live.provider_slug,
        'tag',live.tag,'endpoint_class',live.endpoint_class,
        'region',live.region,'context_length',live.context_length,
        'max_prompt_tokens',live.max_prompt_tokens,
        'max_completion_tokens',live.max_completion_tokens,
        'quantization',live.quantization,
        'supported_parameters',live.supported_parameters,
        'pricing',live.pricing,
        'supports_tool_choice',live.supports_tool_choice,
        'image_capabilities',live.image_capabilities,
        'audio_capabilities',live.audio_capabilities,
        'supports_implicit_caching',live.supports_implicit_caching,
        'supports_voice_cloning',live.supports_voice_cloning,
        'evidence_url',live.evidence_url,'verified_by',live.verified_by,
        'verified_at',live.verified_at,'expires_at',live.endpoint_expires_at,
        'created_at',live.endpoint_created_at,
        'updated_at',live.endpoint_updated_at,'status','verified'),
      'sourceGeneration',m.source_generation::text,
      'attestedSourceSha256',m.attested_source_sha256,
      'sourceSha256',m.source_sha256,
      'providerCiphertextSha256',m.provider_ciphertext_sha256,
      'subjectFingerprint',live.subject_fingerprint));
END;
$read$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.read_private_complete_text_route_v366(text,uuid,integer,text)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_complete_text_private_reader;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_private_reader;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.read_private_complete_text_route_v366(text,uuid,integer,text)
  TO cinatoken_gateway_complete_text_private_reader;

DO $postflight$
DECLARE reader_oid oid;
BEGIN
  SELECT oid INTO reader_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_private_reader';
  IF NOT pg_catalog.has_function_privilege(reader_oid,
      'cinatoken_gateway.read_private_complete_text_route_v366(text,uuid,integer,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.read_private_complete_text_route_v366(text,uuid,integer,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_gateway.providers','SELECT')
    OR pg_catalog.has_column_privilege(reader_oid,
      'cinatoken_gateway.providers','api_key','SELECT')
    OR pg_catalog.has_column_privilege(reader_oid,
      'cinatoken_gateway.providers','endpoints','SELECT')
    OR pg_catalog.has_table_privilege(reader_oid,
      'cinatoken_gateway.complete_text_quote_routes_v360','SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=reader_oid OR member=reader_oid)
  THEN RAISE EXCEPTION 'complete text private route reader v366 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
