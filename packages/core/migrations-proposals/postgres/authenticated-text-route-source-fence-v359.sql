-- REVIEW ONLY. Install after v356/v357 with a separately provisioned direct
-- NOINHERIT LOGIN cinatoken_gateway_route_source_verifier.
--
-- This is a freshness fence for the one-target v357 fragment. It does not
-- complete the fallback manifest, bind a physical credential, reserve money,
-- or grant upstream egress. Existing links start unverified.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923556);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
SELECT pg_catalog.pg_advisory_xact_lock(746923559);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.model_routes, cinatoken_gateway.providers,
  cinatoken_gateway.route_pools, cinatoken_gateway.model_endpoints,
  cinatoken_gateway.model_endpoint_routes,
  cinatoken_gateway.request_text_route_ceilings_v357
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; verifier_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO verifier_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_route_source_verifier';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.route_source_fence_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR verifier_oid IS NULL OR runtime_oid IS NULL
    OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=runtime_oid
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication
        OR rolbypassrls))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles
      WHERE rolname IN ('cinatoken_gateway_request_capability_issuer',
        'cinatoken_gateway_request_capability_claim',
        'cinatoken_gateway_request_route_ceiling_issuer'))<>3
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname IN ('cinatoken_gateway_request_capability_issuer',
        'cinatoken_gateway_request_capability_claim',
        'cinatoken_gateway_request_route_ceiling_issuer')
        AND (pg_catalog.pg_has_role(oid,migrator_oid,'MEMBER')
          OR rolsuper OR rolcreaterole OR rolcreatedb
          OR rolreplication OR rolbypassrls))
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='cinatoken_gateway'
        AND c.relname IN ('model_routes','providers','route_pools',
          'model_endpoints','model_endpoint_routes',
          'request_text_route_ceilings_v357')
        AND c.relowner IS DISTINCT FROM migrator_oid)
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.request_text_route_ceilings_v357') IS NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.issue_request_text_route_ceiling_v357(text,text,text,text)') IS NULL
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.route_source_generations_v359') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=verifier_oid
      AND NOT (rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        AND NOT rolinherit))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=verifier_oid OR member=verifier_oid)
    OR pg_catalog.has_schema_privilege(verifier_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='cinatoken_gateway' AND c.relkind IN ('r','p')
        AND pg_catalog.has_table_privilege(verifier_oid,c.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cinatoken_gateway'
        AND pg_catalog.has_function_privilege(verifier_oid,p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'route source fence v359 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

-- No route FK: DELETE then INSERT of the same ID must advance its generation,
-- never reset it to an old number. Orphans are deliberately retained.
CREATE TABLE cinatoken_gateway.route_source_generations_v359 (
  route_target_id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9223372036854775806),
  verified_generation bigint,
  verified_subject_fingerprint text,
  attested_source_sha256 text,
  verified_at timestamptz,
  CHECK (
    (verified_generation IS NULL AND verified_subject_fingerprint IS NULL
      AND attested_source_sha256 IS NULL AND verified_at IS NULL)
    OR
    (verified_generation=generation
      AND verified_subject_fingerprint ~ '^[0-9a-f]{64}$'
      AND attested_source_sha256 ~ '^[0-9a-f]{64}$'
      AND verified_at IS NOT NULL)
  )
);
INSERT INTO cinatoken_gateway.route_source_generations_v359
  (route_target_id,generation)
  SELECT id,1 FROM cinatoken_gateway.model_routes;

-- Every row mutation, including a no-op or ABA update, invalidates the
-- attestation. The source row's write lock precedes this generation write.
CREATE FUNCTION cinatoken_gateway.invalidate_route_source_v359()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $invalidate$
DECLARE old_id text; new_id text; affected text[]; target_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'cinatoken_gateway' THEN
    RAISE EXCEPTION 'invalid route source trigger schema' USING ERRCODE='P0001';
  END IF;
  IF TG_OP<>'INSERT' THEN old_id:=OLD.id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.id; END IF;
  IF TG_TABLE_NAME='model_routes' THEN
    SELECT pg_catalog.array_agg(id ORDER BY id) INTO affected FROM (
      SELECT old_id AS id UNION SELECT new_id AS id
    ) s WHERE id IS NOT NULL;
  ELSIF TG_TABLE_NAME='providers' THEN
    SELECT pg_catalog.array_agg(id ORDER BY id) INTO affected
      FROM cinatoken_gateway.model_routes
      WHERE provider_id=old_id OR provider_id=new_id;
  ELSIF TG_TABLE_NAME='route_pools' THEN
    SELECT pg_catalog.array_agg(id ORDER BY id) INTO affected
      FROM cinatoken_gateway.model_routes
      WHERE route_pool_id=old_id OR route_pool_id=new_id;
  ELSIF TG_TABLE_NAME='model_endpoints' THEN
    SELECT pg_catalog.array_agg(DISTINCT er.route_target_id
      ORDER BY er.route_target_id) INTO affected
      FROM cinatoken_gateway.model_endpoint_routes er
      WHERE er.endpoint_id=old_id OR er.endpoint_id=new_id;
  ELSE
    RAISE EXCEPTION 'invalid route source trigger table' USING ERRCODE='P0001';
  END IF;
  FOREACH target_id IN ARRAY coalesce(affected,ARRAY[]::text[]) LOOP
    INSERT INTO cinatoken_gateway.route_source_generations_v359
      (route_target_id,generation) VALUES(target_id,1)
      ON CONFLICT (route_target_id) DO UPDATE
      SET generation=cinatoken_gateway.route_source_generations_v359.generation+1,
        verified_generation=NULL,verified_subject_fingerprint=NULL,
        attested_source_sha256=NULL,verified_at=NULL;
  END LOOP;
  RETURN NULL;
END;
$invalidate$;

CREATE FUNCTION cinatoken_gateway.invalidate_route_link_v359()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $invalidate$
DECLARE old_id text; new_id text; target_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'cinatoken_gateway'
    OR TG_TABLE_NAME<>'model_endpoint_routes' THEN
    RAISE EXCEPTION 'invalid route link trigger table' USING ERRCODE='P0001';
  END IF;
  IF TG_OP<>'INSERT' THEN old_id:=OLD.route_target_id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.route_target_id; END IF;
  FOR target_id IN SELECT id FROM (
    SELECT old_id AS id UNION SELECT new_id AS id
  ) s WHERE id IS NOT NULL ORDER BY id LOOP
    INSERT INTO cinatoken_gateway.route_source_generations_v359
      (route_target_id,generation) VALUES(target_id,1)
      ON CONFLICT (route_target_id) DO UPDATE
      SET generation=cinatoken_gateway.route_source_generations_v359.generation+1,
        verified_generation=NULL,verified_subject_fingerprint=NULL,
        attested_source_sha256=NULL,verified_at=NULL;
  END LOOP;
  RETURN NULL;
END;
$invalidate$;

CREATE TRIGGER route_source_v359_route
  AFTER INSERT OR UPDATE OR DELETE ON cinatoken_gateway.model_routes
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_route_source_v359();
CREATE TRIGGER route_source_v359_provider
  AFTER INSERT OR UPDATE OR DELETE ON cinatoken_gateway.providers
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_route_source_v359();
CREATE TRIGGER route_source_v359_pool
  AFTER INSERT OR UPDATE OR DELETE ON cinatoken_gateway.route_pools
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_route_source_v359();
CREATE TRIGGER route_source_v359_endpoint
  AFTER INSERT OR UPDATE OR DELETE ON cinatoken_gateway.model_endpoints
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_route_source_v359();
CREATE TRIGGER route_source_v359_link
  AFTER INSERT OR UPDATE OR DELETE ON cinatoken_gateway.model_endpoint_routes
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_route_link_v359();

-- TRUNCATE does not fire row triggers. A later reinsert of the same route ID
-- could otherwise resurrect a prior generation, so refuse it explicitly.
CREATE FUNCTION cinatoken_gateway.reject_route_source_truncate_v359()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  RAISE EXCEPTION 'route source truncate requires an offline fence migration'
    USING ERRCODE='23514',CONSTRAINT='route_source_truncate_v359';
END;
$reject$;
CREATE TRIGGER route_source_v359_route_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.model_routes
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_route_source_truncate_v359();
CREATE TRIGGER route_source_v359_provider_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.providers
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_route_source_truncate_v359();
CREATE TRIGGER route_source_v359_pool_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.route_pools
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_route_source_truncate_v359();
CREATE TRIGGER route_source_v359_endpoint_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.model_endpoints
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_route_source_truncate_v359();
CREATE TRIGGER route_source_v359_link_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.model_endpoint_routes
  FOR EACH STATEMENT EXECUTE FUNCTION
    cinatoken_gateway.reject_route_source_truncate_v359();

-- The verifier must read generation FIRST, then derive
-- p_subject_fingerprint independently from current decrypted provider/route
-- configuration, then pass that first generation here. This function does
-- not trust the persisted link fingerprint as proof of that computation.
CREATE FUNCTION cinatoken_gateway.attest_text_route_source_v359(
  p_route_target_id text,p_expected_generation bigint,
  p_subject_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $attest$
DECLARE source_row record; fence_row record; source_sha text;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_route_source_verifier'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_route_target_id IS NULL
    OR pg_catalog.length(p_route_target_id) NOT BETWEEN 1 AND 128
    OR p_expected_generation IS NULL OR p_expected_generation<1
    OR p_subject_fingerprint IS NULL
    OR p_subject_fingerprint !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid route source attestation call'
    USING ERRCODE='23514',CONSTRAINT='route_source_attestation_call_v359'; END IF;
  SELECT pg_catalog.to_jsonb(r) AS route_json,
      pg_catalog.to_jsonb(po) AS provider_json,
      pg_catalog.to_jsonb(rp) AS pool_json,
      pg_catalog.to_jsonb(e) AS endpoint_json,
      pg_catalog.to_jsonb(er) AS link_json,
      er.subject_fingerprint AS link_fingerprint
    INTO source_row
    FROM cinatoken_gateway.model_routes r
    JOIN cinatoken_gateway.providers po ON po.id=r.provider_id
    JOIN cinatoken_gateway.route_pools rp ON rp.id=r.route_pool_id
      AND rp.model_id=r.model_id AND rp.route_group=r.route_group
    JOIN cinatoken_gateway.model_endpoint_routes er ON er.route_target_id=r.id
    JOIN cinatoken_gateway.model_endpoints e ON e.id=er.endpoint_id
      AND e.model_id=r.model_id AND e.provider_id=r.provider_id
    WHERE r.id=p_route_target_id
    FOR SHARE OF r,po,rp,er,e;
  IF NOT FOUND OR source_row.link_fingerprint IS DISTINCT FROM
      p_subject_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT * INTO fence_row
    FROM cinatoken_gateway.route_source_generations_v359
    WHERE route_target_id=p_route_target_id FOR UPDATE;
  IF NOT FOUND OR fence_row.generation<>p_expected_generation THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  source_sha:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('route',source_row.route_json,
      'provider',source_row.provider_json,'pool',source_row.pool_json,
      'endpoint',source_row.endpoint_json,'link',source_row.link_json)::text,
    'UTF8')),'hex');
  UPDATE cinatoken_gateway.route_source_generations_v359
    SET verified_generation=p_expected_generation,
      verified_subject_fingerprint=p_subject_fingerprint,
      attested_source_sha256=source_sha,verified_at=pg_catalog.clock_timestamp()
    WHERE route_target_id=p_route_target_id;
  RETURN pg_catalog.jsonb_build_object('status','attested',
    'routeTargetId',p_route_target_id,'generation',p_expected_generation,
    'sourceSha256',source_sha);
END;
$attest$;

ALTER TABLE cinatoken_gateway.request_text_route_ceilings_v357
  ADD COLUMN source_generation_v359 bigint,
  ADD COLUMN attested_source_sha256_v359 text;
ALTER TABLE cinatoken_gateway.request_text_route_ceilings_v357
  ADD CONSTRAINT request_text_route_source_v359_chk CHECK (
    (source_generation_v359 IS NULL AND attested_source_sha256_v359 IS NULL)
    OR (source_generation_v359>=1
      AND attested_source_sha256_v359 ~ '^[0-9a-f]{64}$')
  );

CREATE FUNCTION cinatoken_gateway.require_text_route_source_v359()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $require$
DECLARE fence_row record; link_fingerprint text;
BEGIN
  SELECT * INTO fence_row
    FROM cinatoken_gateway.route_source_generations_v359
    WHERE route_target_id=NEW.route_target_id FOR SHARE;
  IF NOT FOUND OR fence_row.verified_generation IS DISTINCT FROM
      fence_row.generation OR fence_row.verified_subject_fingerprint IS NULL
  THEN RAISE EXCEPTION 'route source attestation is stale'
    USING ERRCODE='23514',CONSTRAINT='request_text_route_source_freshness_v359';
  END IF;
  SELECT er.subject_fingerprint INTO link_fingerprint
    FROM cinatoken_gateway.model_endpoint_routes er
    WHERE er.route_target_id=NEW.route_target_id
      AND er.endpoint_id=NEW.endpoint_id FOR SHARE;
  IF NOT FOUND OR link_fingerprint IS DISTINCT FROM
      fence_row.verified_subject_fingerprint
    OR NEW.source_snapshot->>'persistedRouteSubjectFingerprint'
      IS DISTINCT FROM fence_row.verified_subject_fingerprint
    OR NEW.source_generation_v359 IS NOT NULL
    OR NEW.attested_source_sha256_v359 IS NOT NULL
  THEN RAISE EXCEPTION 'route source attestation differs'
    USING ERRCODE='23514',CONSTRAINT='request_text_route_source_freshness_v359';
  END IF;
  NEW.source_generation_v359:=fence_row.generation;
  NEW.attested_source_sha256_v359:=fence_row.attested_source_sha256;
  RETURN NEW;
END;
$require$;
CREATE TRIGGER request_text_route_source_v359
  BEFORE INSERT ON cinatoken_gateway.request_text_route_ceilings_v357
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.require_text_route_source_v359();

REVOKE ALL ON cinatoken_gateway.route_source_generations_v359
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_route_source_verifier,
    cinatoken_gateway_request_route_ceiling_issuer;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.invalidate_route_source_v359(),
  cinatoken_gateway.invalidate_route_link_v359(),
  cinatoken_gateway.reject_route_source_truncate_v359(),
  cinatoken_gateway.attest_text_route_source_v359(text,bigint,text),
  cinatoken_gateway.require_text_route_source_v359()
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_route_source_verifier,
    cinatoken_gateway_request_route_ceiling_issuer;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_route_source_verifier;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)
  TO cinatoken_gateway_route_source_verifier;
-- The verifier reads the generation before ciphertext and route metadata,
-- computes the JS subject with the application decryption key, and passes
-- that original generation to attest(). If a source changed in between, its
-- trigger advances the generation and this function rejects the attempt.
GRANT SELECT ON cinatoken_gateway.route_source_generations_v359,
  cinatoken_gateway.model_routes,cinatoken_gateway.providers,
  cinatoken_gateway.route_pools,cinatoken_gateway.model_endpoints,
  cinatoken_gateway.model_endpoint_routes
  TO cinatoken_gateway_route_source_verifier;

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
      'cinatoken_gateway_route_source_verifier',
      'cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.attest_text_route_source_v359(text,bigint,text)',
      'EXECUTE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.route_source_generations_v359',
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('cinatoken_gateway_route_source_verifier',
      'cinatoken_gateway.route_source_generations_v359',
      'INSERT,UPDATE,DELETE')
    OR NOT pg_catalog.has_table_privilege('cinatoken_gateway_route_source_verifier',
      'cinatoken_gateway.providers','SELECT')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname LIKE 'route_source_v359_%'
        AND t.tgenabled='O' AND NOT t.tgisinternal)<>10
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname='request_text_route_source_v359'
        AND t.tgenabled='O' AND NOT t.tgisinternal)<>1
  THEN RAISE EXCEPTION 'route source fence v359 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
