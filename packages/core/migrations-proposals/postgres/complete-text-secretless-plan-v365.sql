-- REVIEW ONLY. Secretless ingress projection for an already committed v360
-- strict flat-text quote. Install after v356/v359/v360 as the migrator in one
-- transaction with complete_text_secretless_plan_activation=reviewed-v1.
-- Provision a separate direct NOINHERIT LOGIN before installing. This is
-- planning data, not a reservation, grant, credential, URL or send right.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923556);
SELECT pg_catalog.pg_advisory_xact_lock(746923559);
SELECT pg_catalog.pg_advisory_xact_lock(746923560);
SELECT pg_catalog.pg_advisory_xact_lock(746923565);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.complete_text_quotes_v360,
  cinatoken_gateway.complete_text_quote_routes_v360,
  cinatoken_gateway.authenticated_request_capabilities_v356,
  cinatoken_gateway.route_source_generations_v359
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; planner_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO planner_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_ingress_planner';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting(
      'cinatoken.complete_text_secretless_plan_activation',true)
        IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR planner_oid IS NULL OR runtime_oid IS NULL
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR (SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
      AND NOT rolinherit FROM pg_catalog.pg_roles WHERE oid=planner_oid)
        IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=planner_oid OR member=planner_oid)
    OR pg_catalog.has_schema_privilege(planner_oid,'cinatoken_gateway','CREATE')
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.plan_complete_flat_text_quote_v365(text,uuid)')
        IS NOT NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_quotes_v360') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.complete_text_quote_routes_v360') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.route_source_generations_v359') IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(planner_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(planner_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(planner_oid,p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'complete text secretless plan v365 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.plan_complete_flat_text_quote_v365(
  p_request_id text,p_quote_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $plan$
DECLARE q record; cap record; key_row record; user_row record;
DECLARE workspace_row record; manifest record; server_now timestamptz;
DECLARE candidate_count integer; manifest_count integer; active_count integer;
DECLARE max_ceiling bigint; routes jsonb:='[]'::jsonb;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_complete_text_ingress_planner'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_quote_id IS NULL
  THEN RAISE EXCEPTION 'invalid complete text plan call'
    USING ERRCODE='23514',CONSTRAINT='complete_text_plan_call_v365'; END IF;
  SELECT * INTO q FROM cinatoken_gateway.complete_text_quotes_v360
    WHERE request_id=p_request_id AND quote_id=p_quote_id FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','not_found'); END IF;

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
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;

  -- A complete current route predicate is needed even for a read projection.
  -- v362 repeats all authority checks at grant time; this lock only gives the
  -- planner a coherent snapshot for this transaction, not a send lease.
  LOCK TABLE cinatoken_gateway.models,
    cinatoken_gateway.model_surfaces,
    cinatoken_gateway.model_routes,
    cinatoken_gateway.route_pools,
    cinatoken_gateway.providers,
    cinatoken_gateway.model_endpoints,
    cinatoken_gateway.model_endpoint_routes,
    cinatoken_gateway.route_source_generations_v359,
    cinatoken_gateway.byok_keys
    IN SHARE MODE;
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR EXISTS (SELECT 1 FROM cinatoken_gateway.byok_keys b
      WHERE b.workspace_id=q.workspace_id AND b.deleted_at IS NULL
        AND NOT b.disabled)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  candidate_count:=pg_catalog.jsonb_array_length(q.ordered_model_ids);
  SELECT pg_catalog.count(*)::integer,pg_catalog.max(per_attempt_ceiling_micros)
    INTO manifest_count,max_ceiling
    FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id;
  IF candidate_count NOT BETWEEN 1 AND 8 OR manifest_count<>q.route_count
    OR manifest_count NOT BETWEEN 1 AND 100 OR max_ceiling IS NULL
    OR max_ceiling<=0 OR max_ceiling<>q.max_per_attempt_ceiling_micros
    OR q.three_attempt_ceiling_micros<>max_ceiling*3
  THEN RETURN pg_catalog.jsonb_build_object('status','invalid_manifest'); END IF;

  FOR manifest IN SELECT * FROM cinatoken_gateway.complete_text_quote_routes_v360
    WHERE quote_id=q.quote_id ORDER BY candidate_index,route_target_id
  LOOP
    IF manifest.candidate_index NOT BETWEEN 0 AND candidate_count-1
      OR manifest.model_id IS DISTINCT FROM
        q.ordered_model_ids->>manifest.candidate_index
      OR pg_catalog.octet_length(manifest.model_id)>240
      OR pg_catalog.octet_length(manifest.route_target_id)>256
      OR manifest.credential_class IS DISTINCT FROM 'platform'
      OR manifest.credential_id IS DISTINCT FROM manifest.provider_id
      OR manifest.source_sha256 IS DISTINCT FROM pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          manifest.source_snapshot::text,'UTF8')),'hex')
      OR manifest.source_snapshot->>'modelId' IS DISTINCT FROM manifest.model_id
      OR manifest.source_snapshot->>'routeTargetId' IS DISTINCT FROM
        manifest.route_target_id
      OR manifest.source_snapshot->>'providerId' IS DISTINCT FROM
        manifest.provider_id
      OR manifest.source_snapshot->>'endpointId' IS DISTINCT FROM
        manifest.endpoint_id
      OR manifest.source_snapshot->>'providerCiphertextSha256' IS DISTINCT FROM
        manifest.provider_ciphertext_sha256
      OR manifest.source_snapshot->>'sourceGeneration' IS DISTINCT FROM
        manifest.source_generation::text
      OR manifest.source_snapshot->>'attestedSourceSha256' IS DISTINCT FROM
        manifest.attested_source_sha256
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
    routes:=routes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'candidateIndex',manifest.candidate_index,
      'modelId',manifest.model_id,
      'routeTargetId',manifest.route_target_id,
      'sourceGeneration',manifest.source_generation::text,
      'attestedSourceSha256',manifest.attested_source_sha256));
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
  server_now:=pg_catalog.clock_timestamp();
  IF q.expires_at<=server_now OR cap.expires_at<=server_now
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status','planned_complete_subset',
    'requestId',q.request_id,'quoteId',q.quote_id,
    'finalBodySha256',q.final_body_sha256,
    'orderedModelIds',q.ordered_model_ids,
    'candidateCount',candidate_count,'routeCount',manifest_count,
    'expiresAt',q.expires_at,'routes',routes);
END;
$plan$;

REVOKE ALL ON FUNCTION
  cinatoken_gateway.plan_complete_flat_text_quote_v365(text,uuid)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_complete_text_ingress_planner;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_complete_text_ingress_planner;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.plan_complete_flat_text_quote_v365(text,uuid)
  TO cinatoken_gateway_complete_text_ingress_planner;

DO $postflight$
DECLARE planner_oid oid;
BEGIN
  SELECT oid INTO planner_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_complete_text_ingress_planner';
  IF NOT pg_catalog.has_function_privilege(planner_oid,
      'cinatoken_gateway.plan_complete_flat_text_quote_v365(text,uuid)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.plan_complete_flat_text_quote_v365(text,uuid)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege(planner_oid,
      'cinatoken_gateway.providers','SELECT')
    OR pg_catalog.has_column_privilege(planner_oid,
      'cinatoken_gateway.providers','api_key','SELECT')
    OR pg_catalog.has_column_privilege(planner_oid,
      'cinatoken_gateway.providers','endpoints','SELECT')
    OR pg_catalog.has_table_privilege(planner_oid,
      'cinatoken_gateway.complete_text_quote_routes_v360','SELECT')
    OR pg_catalog.has_column_privilege(planner_oid,
      'cinatoken_gateway.complete_text_quote_routes_v360',
      'provider_ciphertext_sha256','SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=planner_oid OR member=planner_oid)
  THEN RAISE EXCEPTION 'complete text secretless plan v365 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
