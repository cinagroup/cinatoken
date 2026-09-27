-- REVIEW ONLY: first authenticated-request boundary, not a price quote,
-- financial reservation, dispatch grant, or formal migration.
-- Install only in an explicit transaction on PG73 after provisioning two
-- separate direct LOGINs: cinatoken_gateway_request_capability_issuer and
-- cinatoken_gateway_request_capability_claim. Neither role inherits another.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;
-- Serialize with grantPostgresRuntime's pre-broad-grant existence check.
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923556);
LOCK TABLE cinatoken_gateway.schema_migrations,
  cinatoken_gateway.users, cinatoken_gateway.api_keys,
  cinatoken_gateway.workspaces IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid; runtime_oid oid; issuer_oid oid; claim_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO issuer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_request_capability_issuer';
  SELECT oid INTO claim_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_request_capability_claim';
  IF CURRENT_USER<>'cinatoken_gateway_migrator' OR SESSION_USER<>CURRENT_USER
    OR pg_catalog.current_setting('cinatoken.request_capability_login_activation',true)
      IS DISTINCT FROM 'reviewed-v1'
    OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR issuer_oid IS NULL OR claim_oid IS NULL OR issuer_oid=claim_oid
    OR (SELECT pg_catalog.count(*) FROM cinatoken_gateway.schema_migrations)<>73
    OR (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations)
      <>'ca1ea96a1b4bcd0675642f30dcf48042'
    OR (SELECT nspowner FROM pg_catalog.pg_namespace
      WHERE nspname='cinatoken_gateway') IS DISTINCT FROM migrator_oid
    OR pg_catalog.to_regclass(
      'cinatoken_gateway.authenticated_request_capabilities_v356') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.issue_request_capability_v356(text,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.claim_request_capability_v356(text,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'cinatoken_gateway.invalidate_request_capabilities_v356()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid IN (issuer_oid,claim_oid)
        AND NOT (rolcanlogin AND NOT rolsuper AND NOT rolcreaterole
          AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
          AND NOT rolinherit))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid IN (issuer_oid,claim_oid) OR member IN (issuer_oid,claim_oid))
    OR pg_catalog.has_schema_privilege(issuer_oid,'cinatoken_gateway','CREATE')
    OR pg_catalog.has_schema_privilege(claim_oid,'cinatoken_gateway','CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND c.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(issuer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(issuer_oid,c.oid,
            'SELECT,INSERT,UPDATE')
          OR pg_catalog.has_table_privilege(claim_oid,c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(claim_oid,c.oid,
            'SELECT,INSERT,UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('cinatoken_gateway','cinatoken_economic_outbox',
        'cinatoken_economic_quotes','cinatoken_economic_consumer')
        AND (pg_catalog.has_function_privilege(issuer_oid,p.oid,'EXECUTE')
          OR pg_catalog.has_function_privilege(claim_oid,p.oid,'EXECUTE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid IN (
      'cinatoken_gateway.users'::pg_catalog.regclass,
      'cinatoken_gateway.api_keys'::pg_catalog.regclass,
      'cinatoken_gateway.workspaces'::pg_catalog.regclass)
      AND (c.relowner<>migrator_oid OR c.relkind<>'r'
        OR c.relrowsecurity OR c.relforcerowsecurity))
  THEN RAISE EXCEPTION 'request capability v356 activation or dependency differs'
    USING ERRCODE='P0001'; END IF;
END;
$preflight$;

CREATE TABLE cinatoken_gateway.authenticated_request_capabilities_v356 (
  request_id text PRIMARY KEY CHECK (pg_catalog.length(request_id) BETWEEN 1 AND 128),
  capability_sha256 text NOT NULL UNIQUE
    CHECK (capability_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  api_key_id text NOT NULL,
  key_hash text NOT NULL CHECK (key_hash ~ '^sha256:[0-9a-f]{64}$'),
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  budget_epoch bigint NOT NULL
    CHECK (budget_epoch BETWEEN 0 AND 9007199254740991),
  key_limit_epoch integer NOT NULL CHECK (key_limit_epoch>=0),
  state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','claimed')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  invalidated_at timestamptz,
  CHECK (expires_at>issued_at AND expires_at<=issued_at+INTERVAL '60 seconds'),
  CHECK ((state='issued' AND claimed_at IS NULL)
    OR (state='claimed' AND claimed_at IS NOT NULL
      AND claimed_at>=issued_at AND claimed_at<expires_at))
);
CREATE INDEX authenticated_request_capabilities_v356_expiry
  ON cinatoken_gateway.authenticated_request_capabilities_v356(expires_at);
CREATE INDEX authenticated_request_capabilities_v356_key_issued
  ON cinatoken_gateway.authenticated_request_capabilities_v356(api_key_id,expires_at)
  WHERE state='issued' AND invalidated_at IS NULL;
CREATE INDEX authenticated_request_capabilities_v356_user_issued
  ON cinatoken_gateway.authenticated_request_capabilities_v356(user_id,expires_at)
  WHERE state='issued' AND invalidated_at IS NULL;
CREATE INDEX authenticated_request_capabilities_v356_workspace_issued
  ON cinatoken_gateway.authenticated_request_capabilities_v356(workspace_id,expires_at)
  WHERE state='issued' AND invalidated_at IS NULL;

-- A transient revoke/disable is still revocation. Current-row comparisons
-- alone cannot distinguish the state after an ABA reactivation. These triggers
-- permanently invalidate any issued capability on security-relevant changes.
CREATE FUNCTION cinatoken_gateway.invalidate_request_capabilities_v356()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s' AS $invalidate$
DECLARE invalidate boolean := false;
DECLARE server_now timestamptz;
BEGIN
  server_now:=pg_catalog.clock_timestamp();
  IF TG_TABLE_SCHEMA<>'cinatoken_gateway' THEN
    RAISE EXCEPTION 'unexpected request capability trigger schema'
      USING ERRCODE='P0001'; END IF;
  IF TG_TABLE_NAME='api_keys' THEN
    IF TG_OP='DELETE' THEN invalidate:=true;
    ELSIF TG_OP='UPDATE' THEN
      invalidate:=OLD.id IS DISTINCT FROM NEW.id
        OR OLD.key IS DISTINCT FROM NEW.key
        OR OLD.key_hash IS DISTINCT FROM NEW.key_hash
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
        OR OLD.limit_epoch IS DISTINCT FROM NEW.limit_epoch
        OR OLD.limit_micros IS DISTINCT FROM NEW.limit_micros
        OR OLD.limit_reset IS DISTINCT FROM NEW.limit_reset
        OR OLD.include_byok_in_limit IS DISTINCT FROM NEW.include_byok_in_limit;
    ELSE RAISE EXCEPTION 'unexpected request capability trigger operation'
      USING ERRCODE='P0001'; END IF;
    IF invalidate THEN
      UPDATE cinatoken_gateway.authenticated_request_capabilities_v356
        SET invalidated_at=server_now
        WHERE api_key_id=OLD.id AND expires_at>server_now
          AND state='issued' AND invalidated_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME='users' THEN
    IF TG_OP='DELETE' THEN invalidate:=true;
    ELSIF TG_OP='UPDATE' THEN
      invalidate:=OLD.id IS DISTINCT FROM NEW.id
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.budget_epoch IS DISTINCT FROM NEW.budget_epoch
        OR OLD.budget_max IS DISTINCT FROM NEW.budget_max
        OR OLD.budget_period IS DISTINCT FROM NEW.budget_period
        OR OLD.budget_reset_at IS DISTINCT FROM NEW.budget_reset_at;
    ELSE RAISE EXCEPTION 'unexpected request capability trigger operation'
      USING ERRCODE='P0001'; END IF;
    IF invalidate THEN
      UPDATE cinatoken_gateway.authenticated_request_capabilities_v356
        SET invalidated_at=server_now
        WHERE user_id=OLD.id AND expires_at>server_now
          AND state='issued' AND invalidated_at IS NULL;
    END IF;
  ELSIF TG_TABLE_NAME='workspaces' THEN
    IF TG_OP='DELETE' THEN invalidate:=true;
    ELSIF TG_OP='UPDATE' THEN
      invalidate:=OLD.id IS DISTINCT FROM NEW.id
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.scope_type IS DISTINCT FROM NEW.scope_type
        OR OLD.personal_owner_user_id IS DISTINCT FROM NEW.personal_owner_user_id;
    ELSE RAISE EXCEPTION 'unexpected request capability trigger operation'
      USING ERRCODE='P0001'; END IF;
    IF invalidate THEN
      UPDATE cinatoken_gateway.authenticated_request_capabilities_v356
        SET invalidated_at=server_now
        WHERE workspace_id=OLD.id AND expires_at>server_now
          AND state='issued' AND invalidated_at IS NULL;
    END IF;
  ELSE RAISE EXCEPTION 'unexpected request capability trigger table'
    USING ERRCODE='P0001'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$invalidate$;
CREATE TRIGGER invalidate_request_capabilities_key_v356
  AFTER UPDATE OR DELETE ON cinatoken_gateway.api_keys
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_request_capabilities_v356();
CREATE TRIGGER invalidate_request_capabilities_user_v356
  AFTER UPDATE OR DELETE ON cinatoken_gateway.users
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_request_capabilities_v356();
CREATE TRIGGER invalidate_request_capabilities_workspace_v356
  AFTER UPDATE OR DELETE ON cinatoken_gateway.workspaces
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.invalidate_request_capabilities_v356();

CREATE FUNCTION cinatoken_gateway.issue_request_capability_v356(
  p_request_id text,p_bearer text,p_body_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $issue$
DECLARE key_row record; user_row record; workspace_row record;
DECLARE bearer_hash text; capability text; server_now timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_request_capability_issuer'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_bearer IS NULL OR pg_catalog.length(p_bearer) NOT BETWEEN 16 AND 512
    OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid request capability issue call'
    USING ERRCODE='23514',CONSTRAINT='request_capability_issue_call_v356'; END IF;
  -- The inference and Management credential namespaces are disjoint even if
  -- a malformed/imported api_keys row carries a Management secret hash.
  IF pg_catalog.left(p_bearer,13)='sk-cina-mgmt-' THEN
    RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  server_now:=pg_catalog.clock_timestamp();
  bearer_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_bearer,'UTF8')),'hex');
  -- A hash-only argument is not accepted. Require the actual bearer and the
  -- modern hashref pair; old plaintext rows must be backfilled first.
  SELECT k.id,k.key_hash,k.user_id,k.workspace_id,k.limit_epoch,k.expires_at
    INTO key_row FROM cinatoken_gateway.api_keys k
    WHERE k.key_hash=bearer_hash AND k.key='hashref:' || bearer_hash
      AND k.status='active' AND (k.expires_at IS NULL OR k.expires_at>server_now)
    FOR SHARE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  SELECT u.id,u.budget_epoch,u.status INTO user_row
    FROM cinatoken_gateway.users u WHERE u.id=key_row.user_id FOR SHARE;
  IF NOT FOUND OR user_row.status<>'active' THEN
    RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  SELECT w.id,w.status,w.scope_type,w.personal_owner_user_id INTO workspace_row
    FROM cinatoken_gateway.workspaces w WHERE w.id=key_row.workspace_id FOR SHARE;
  -- Initial phase deliberately covers personal workspaces only. An
  -- organization membership proof needs a separate, versioned contract.
  IF NOT FOUND OR workspace_row.status IS DISTINCT FROM 'active'
    OR workspace_row.scope_type IS DISTINCT FROM 'personal'
    OR workspace_row.personal_owner_user_id IS DISTINCT FROM key_row.user_id THEN
    RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  -- Row-lock waits may cross the Key deadline after the initial indexed lookup.
  server_now:=pg_catalog.clock_timestamp();
  IF key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  capability:=pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text;
  INSERT INTO cinatoken_gateway.authenticated_request_capabilities_v356
    (request_id,capability_sha256,body_sha256,api_key_id,key_hash,user_id,
     workspace_id,budget_epoch,key_limit_epoch,issued_at,expires_at)
    VALUES (p_request_id,pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(capability,'UTF8')),'hex'),p_body_sha256,
      key_row.id,key_row.key_hash,key_row.user_id,key_row.workspace_id,
      user_row.budget_epoch,key_row.limit_epoch,
      server_now,server_now+INTERVAL '60 seconds')
    ON CONFLICT (request_id) DO NOTHING;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','conflict'); END IF;
  RETURN pg_catalog.jsonb_build_object('status','issued',
    'requestId',p_request_id,'capability',capability,
    'apiKeyId',key_row.id,'userId',key_row.user_id,
    'workspaceId',key_row.workspace_id,'budgetEpoch',user_row.budget_epoch,
    'keyLimitEpoch',key_row.limit_epoch,
    'expiresAt',server_now+INTERVAL '60 seconds');
END;
$issue$;

CREATE FUNCTION cinatoken_gateway.claim_request_capability_v356(
  p_request_id text,p_capability text,p_body_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '2s'
SET statement_timeout TO '15s' AS $claim$
DECLARE issued record; key_row record; user_row record; workspace_row record;
DECLARE server_now timestamptz;
BEGIN
  IF SESSION_USER<>'cinatoken_gateway_request_capability_claim'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR p_request_id IS NULL OR pg_catalog.length(p_request_id) NOT BETWEEN 1 AND 128
    OR p_capability IS NULL OR p_capability !~
      '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR p_body_sha256 IS NULL OR p_body_sha256 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid request capability claim call'
    USING ERRCODE='23514',CONSTRAINT='request_capability_claim_call_v356'; END IF;
  server_now:=pg_catalog.clock_timestamp();
  SELECT * INTO issued FROM cinatoken_gateway.authenticated_request_capabilities_v356
    WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR issued.capability_sha256<>pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_capability,'UTF8')),'hex')
    OR issued.body_sha256<>p_body_sha256
  THEN RETURN pg_catalog.jsonb_build_object('status','unauthorized'); END IF;
  IF issued.invalidated_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  IF issued.state<>'issued' THEN
    RETURN pg_catalog.jsonb_build_object('status','already_claimed'); END IF;
  IF issued.expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','expired'); END IF;
  SELECT k.id,k.key,k.key_hash,k.user_id,k.workspace_id,k.limit_epoch,
      k.status,k.expires_at
    INTO key_row FROM cinatoken_gateway.api_keys k
    WHERE k.id=issued.api_key_id FOR SHARE;
  IF NOT FOUND OR key_row.key_hash IS DISTINCT FROM issued.key_hash
    OR key_row.key IS DISTINCT FROM 'hashref:' || issued.key_hash
    OR key_row.status IS DISTINCT FROM 'active'
    OR (key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now)
    OR key_row.user_id IS DISTINCT FROM issued.user_id
    OR key_row.workspace_id IS DISTINCT FROM issued.workspace_id
    OR key_row.limit_epoch IS DISTINCT FROM issued.key_limit_epoch
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT u.id,u.budget_epoch,u.status INTO user_row
    FROM cinatoken_gateway.users u WHERE u.id=issued.user_id FOR SHARE;
  IF NOT FOUND OR user_row.status IS DISTINCT FROM 'active'
    OR user_row.budget_epoch IS DISTINCT FROM issued.budget_epoch
  THEN RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  SELECT w.id,w.status,w.scope_type,w.personal_owner_user_id INTO workspace_row
    FROM cinatoken_gateway.workspaces w WHERE w.id=issued.workspace_id FOR SHARE;
  IF NOT FOUND OR workspace_row.status IS DISTINCT FROM 'active'
    OR workspace_row.scope_type IS DISTINCT FROM 'personal'
    OR workspace_row.personal_owner_user_id IS DISTINCT FROM issued.user_id THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  -- Recheck after every lock wait, including the one-shot row lock. The first
  -- clock read cannot authorize a claim that resumes after the deadline.
  server_now:=pg_catalog.clock_timestamp();
  IF issued.expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','expired'); END IF;
  IF key_row.expires_at IS NOT NULL AND key_row.expires_at<=server_now THEN
    RETURN pg_catalog.jsonb_build_object('status','stale'); END IF;
  UPDATE cinatoken_gateway.authenticated_request_capabilities_v356
    SET state='claimed',claimed_at=server_now WHERE request_id=p_request_id;
  RETURN pg_catalog.jsonb_build_object('status','claimed',
    'requestId',issued.request_id,'apiKeyId',issued.api_key_id,
    'userId',issued.user_id,'workspaceId',issued.workspace_id,
    'budgetEpoch',issued.budget_epoch,'keyLimitEpoch',issued.key_limit_epoch,
    'bodySha256',issued.body_sha256);
END;
$claim$;

REVOKE ALL ON cinatoken_gateway.authenticated_request_capabilities_v356
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_request_capability_issuer,
    cinatoken_gateway_request_capability_claim;
REVOKE ALL ON FUNCTION
  cinatoken_gateway.invalidate_request_capabilities_v356(),
  cinatoken_gateway.issue_request_capability_v356(text,text,text),
  cinatoken_gateway.claim_request_capability_v356(text,text,text)
  FROM PUBLIC,cinatoken_gateway_runtime,
    cinatoken_gateway_request_capability_issuer,
    cinatoken_gateway_request_capability_claim;
GRANT USAGE ON SCHEMA cinatoken_gateway
  TO cinatoken_gateway_request_capability_issuer,
    cinatoken_gateway_request_capability_claim;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.issue_request_capability_v356(text,text,text)
  TO cinatoken_gateway_request_capability_issuer;
GRANT EXECUTE ON FUNCTION
  cinatoken_gateway.claim_request_capability_v356(text,text,text)
  TO cinatoken_gateway_request_capability_claim;

DO $postflight$
DECLARE issuer_oid oid; claim_oid oid; runtime_oid oid;
BEGIN
  SELECT oid INTO issuer_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_request_capability_issuer';
  SELECT oid INTO claim_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_request_capability_claim';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname='cinatoken_gateway_runtime';
  IF NOT pg_catalog.has_function_privilege(issuer_oid,
      'cinatoken_gateway.issue_request_capability_v356(text,text,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(claim_oid,
      'cinatoken_gateway.claim_request_capability_v356(text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(issuer_oid,
      'cinatoken_gateway.claim_request_capability_v356(text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(claim_oid,
      'cinatoken_gateway.issue_request_capability_v356(text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.issue_request_capability_v356(text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.claim_request_capability_v356(text,text,text)','EXECUTE')
    OR pg_catalog.has_function_privilege(issuer_oid,
      'cinatoken_gateway.invalidate_request_capabilities_v356()','EXECUTE')
    OR pg_catalog.has_function_privilege(claim_oid,
      'cinatoken_gateway.invalidate_request_capabilities_v356()','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,
      'cinatoken_gateway.invalidate_request_capabilities_v356()','EXECUTE')
    OR pg_catalog.has_table_privilege(issuer_oid,
      'cinatoken_gateway.authenticated_request_capabilities_v356',
      'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(claim_oid,
      'cinatoken_gateway.authenticated_request_capabilities_v356',
      'SELECT,INSERT,UPDATE,DELETE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgname IN ('invalidate_request_capabilities_key_v356',
        'invalidate_request_capabilities_user_v356',
        'invalidate_request_capabilities_workspace_v356')
        AND t.tgenabled='O' AND NOT t.tgisinternal
        AND t.tgfoid='cinatoken_gateway.invalidate_request_capabilities_v356()'::pg_catalog.regprocedure)<>3
  THEN RAISE EXCEPTION 'request capability v356 postflight differs'
    USING ERRCODE='P0001'; END IF;
END;
$postflight$;
