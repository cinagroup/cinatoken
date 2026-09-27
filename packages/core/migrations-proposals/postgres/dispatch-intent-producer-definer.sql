-- REVIEW-ONLY C03.5 proposal. Deliberately outside migrations-postgres.
-- It repairs the 0069 INSERT trigger's api_keys FOR SHARE ACL without granting
-- a future producer direct SELECT/UPDATE on api_keys. It does not create or
-- activate a producer role, fact writer, Worker, origin or Queue consumer.
-- Execute as the gateway migrator in one explicit transaction after a separate
-- review; first SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
DO $activation$
BEGIN
  IF pg_catalog.current_setting('cinatoken.dispatch_intent_definer_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit dispatch intent definer activation assertion is missing';
  END IF;
END;
$activation$;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
LOCK TABLE cinatoken_gateway.request_dispatch_intents IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE producer_oid oid;
BEGIN
  IF pg_catalog.current_setting('cinatoken.dispatch_intent_definer_activation', true)
      IS DISTINCT FROM 'reviewed-v1' THEN
    RAISE EXCEPTION 'Explicit dispatch intent definer activation assertion is missing';
  END IF;
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  IF migrator_oid IS NULL OR runtime_oid IS NULL OR CURRENT_USER <> 'cinatoken_gateway_migrator'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid) THEN
    RAISE EXCEPTION 'Dispatch intent definer requires the gateway migrator and runtime roles';
  END IF;
  IF pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
    OR (producer_oid IS NOT NULL AND (
      pg_catalog.pg_has_role(producer_oid, migrator_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(producer_oid, runtime_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(runtime_oid, producer_oid, 'MEMBER'))) THEN
    RAISE EXCEPTION 'Dispatch intent definer role membership contract differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Formal recovery migration 0073 is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND c.relkind = 'r' AND c.relowner = migrator_oid
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'Dispatch intent relation contract differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
        AND t.tgname = 'request_dispatch_intents_guard'
        AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 23
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgfoid = pg_catalog.to_regprocedure('cinatoken_gateway.guard_request_dispatch_intent()')
        AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr) = 0
        AND t.tgnargs = 0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL) THEN
    RAISE EXCEPTION 'Dispatch intent trigger binding differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language language ON language.oid = p.prolang
      WHERE p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.guard_request_dispatch_intent()')
        AND p.proowner = migrator_oid AND language.lanname = 'plpgsql'
        AND p.prokind = 'f' AND NOT p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proretset AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        -- Hash the normalized 0069 body, so an old database with a changed
        -- guard cannot be silently overwritten by CREATE OR REPLACE.
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
          = 'd8a89494930000d0178d34c08672af46') THEN
    RAISE EXCEPTION 'Dispatch intent guard source contract differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) acl
      WHERE p.oid = pg_catalog.to_regprocedure('cinatoken_gateway.guard_request_dispatch_intent()')
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee NOT IN (0, migrator_oid, runtime_oid)
        AND (producer_oid IS NULL OR acl.grantee <> producer_oid)) THEN
    RAISE EXCEPTION 'Dispatch intent guard has an unknown EXECUTE grantee';
  END IF;
  IF producer_oid IS NOT NULL AND (
    pg_catalog.has_table_privilege(producer_oid,
      'cinatoken_gateway.api_keys'::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
    OR pg_catalog.has_any_column_privilege(producer_oid,
      'cinatoken_gateway.api_keys'::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE')) THEN
    RAISE EXCEPTION 'Dispatch intent producer has effective Key read or write privilege';
  END IF;
END;
$preflight$;

-- Replace the existing trigger function in place. CREATE OR REPLACE retains
-- its OID and trigger binding. Reject another relation/event before inspecting
-- NEW/OLD or touching api_keys, even if EXECUTE is later misgranted.
CREATE OR REPLACE FUNCTION cinatoken_gateway.guard_request_dispatch_intent() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp AS $guard$
DECLARE checked_at_ms bigint;
DECLARE checked_at timestamptz;
DECLARE key_expires_at timestamptz;
DECLARE user_external_system text;
DECLARE user_subject text;
DECLARE workspace_scope text;
DECLARE workspace_owner text;
DECLARE workspace_organization text;
DECLARE workspace_is_default boolean;
BEGIN
  IF TG_RELID <> 'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass
    OR TG_NAME <> 'request_dispatch_intents_guard'
    OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW' OR TG_NARGS <> 0
    OR TG_OP NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'Dispatch intent guard relation or event mismatch';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'prepared' OR NEW.revision IS DISTINCT FROM 0
      OR NEW.dispatch_claim_id IS NOT NULL OR NEW.claimed_at_ms IS NOT NULL
      OR NEW.created_at_ms IS DISTINCT FROM 0 OR NEW.updated_at_ms IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'Invalid initial dispatch intent';
    END IF;
    PERFORM 1 FROM cinatoken_gateway.api_keys
      WHERE id = NEW.api_key_id AND user_id = NEW.user_id AND workspace_id = NEW.workspace_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent scope mismatch'; END IF;
    checked_at_ms := pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
    IF NEW.expires_at_ms <= checked_at_ms THEN RAISE EXCEPTION 'Dispatch intent deadline elapsed'; END IF;
    NEW.created_at_ms := checked_at_ms;
    NEW.updated_at_ms := checked_at_ms;
    RETURN NEW;
  END IF;

  IF ROW(NEW.request_id, NEW.attempt_index, NEW.user_id, NEW.api_key_id, NEW.workspace_id,
      NEW.operation, NEW.context_sha256, NEW.expires_at_ms, NEW.created_at_ms)
    IS DISTINCT FROM ROW(OLD.request_id, OLD.attempt_index, OLD.user_id, OLD.api_key_id, OLD.workspace_id,
      OLD.operation, OLD.context_sha256, OLD.expires_at_ms, OLD.created_at_ms)
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1
    OR NEW.updated_at_ms IS DISTINCT FROM OLD.updated_at_ms
    OR NEW.claimed_at_ms IS DISTINCT FROM OLD.claimed_at_ms THEN
    RAISE EXCEPTION 'Immutable dispatch intent or invalid revision';
  END IF;
  checked_at_ms := pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint;
  IF checked_at_ms < OLD.updated_at_ms THEN RETURN NULL; END IF;
  IF OLD.state = 'prepared' AND NEW.state = 'dispatch_claimed' THEN
    IF checked_at_ms >= OLD.expires_at_ms THEN RETURN NULL; END IF;
    -- INSERT freezes only the Key association. Claim must revalidate the same
    -- tenant conditions as the active gateway Key lookup. Hold each matched row
    -- through claim commit so a concurrent revoke/archive cannot overtake it.
    SELECT key.expires_at INTO key_expires_at
      FROM cinatoken_gateway.api_keys AS key
      WHERE key.id = OLD.api_key_id AND key.user_id = OLD.user_id
        AND key.workspace_id = OLD.workspace_id AND key.status = 'active'
      FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent authorization revoked'; END IF;
    SELECT account.external_system, account.external_user_id
      INTO user_external_system, user_subject
      FROM cinatoken_gateway.users AS account
      WHERE account.id = OLD.user_id AND account.status = 'active'
      FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent authorization revoked'; END IF;
    SELECT space.scope_type, space.personal_owner_user_id,
        space.organization_id, space.is_default
      INTO workspace_scope, workspace_owner, workspace_organization,
        workspace_is_default
      FROM cinatoken_gateway.workspaces AS space
      WHERE space.id = OLD.workspace_id AND space.status = 'active'
      FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent authorization revoked'; END IF;
    IF workspace_scope = 'personal' THEN
      IF workspace_owner IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Dispatch intent authorization revoked';
      END IF;
    ELSIF workspace_scope = 'organization' THEN
      IF user_external_system IS DISTINCT FROM 'cinaauth' OR user_subject IS NULL THEN
        RAISE EXCEPTION 'Dispatch intent authorization revoked';
      END IF;
      PERFORM 1 FROM cinatoken_gateway.organizations AS organization
        WHERE organization.id = workspace_organization
          AND organization.status IN ('active', 'pending') FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent authorization revoked'; END IF;
      PERFORM 1 FROM cinatoken_gateway.organization_memberships AS membership
        WHERE membership.organization_id = workspace_organization
          AND membership.subject = user_subject AND membership.status = 'active'
        FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent authorization revoked'; END IF;
      IF workspace_is_default IS NULL THEN
        RAISE EXCEPTION 'Dispatch intent authorization revoked';
      END IF;
      IF workspace_is_default IS NOT TRUE THEN
        PERFORM 1 FROM cinatoken_gateway.workspace_memberships AS membership
          WHERE membership.workspace_id = OLD.workspace_id
            AND membership.subject = user_subject AND membership.status = 'active'
          FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch intent authorization revoked'; END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Dispatch intent authorization revoked';
    END IF;
    -- The locks above can wait past either deadline. Use one fresh database
    -- timestamp after they are acquired, including the Key's expiry instant.
    checked_at := pg_catalog.clock_timestamp();
    checked_at_ms := pg_catalog.floor(extract(epoch FROM checked_at) * 1000)::bigint;
    IF checked_at_ms < OLD.updated_at_ms OR checked_at_ms >= OLD.expires_at_ms
      OR (key_expires_at IS NOT NULL AND key_expires_at <= checked_at) THEN
      RETURN NULL;
    END IF;
    NEW.claimed_at_ms := checked_at_ms;
  ELSIF OLD.state = 'prepared' AND NEW.state = 'expired_before_dispatch' THEN
    IF checked_at_ms < OLD.expires_at_ms THEN RETURN NULL; END IF;
  ELSIF OLD.state = 'dispatch_claimed' AND NEW.state = 'outcome_unknown'
    AND NEW.dispatch_claim_id IS NOT DISTINCT FROM OLD.dispatch_claim_id THEN
    IF checked_at_ms < OLD.expires_at_ms THEN RETURN NULL; END IF;
  ELSE
    RAISE EXCEPTION 'Invalid dispatch intent transition';
  END IF;
  NEW.updated_at_ms := checked_at_ms;
  RETURN NEW;
END;
$guard$;

REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_dispatch_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_dispatch_intent()
  FROM cinatoken_gateway_runtime;
DO $revoke_optional_producer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = 'cinatoken_gateway_fact_producer') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION cinatoken_gateway.guard_request_dispatch_intent()
      FROM cinatoken_gateway_fact_producer';
  END IF;
END;
$revoke_optional_producer$;
DO $verify_effective_acl$
DECLARE producer_oid oid;
BEGIN
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  IF pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      'cinatoken_gateway.guard_request_dispatch_intent()', 'EXECUTE')
    OR (producer_oid IS NOT NULL AND pg_catalog.has_function_privilege(producer_oid,
      'cinatoken_gateway.guard_request_dispatch_intent()'::pg_catalog.regprocedure,
      'EXECUTE')) THEN
    RAISE EXCEPTION 'Dispatch intent definer still has effective runtime or producer EXECUTE';
  END IF;
END;
$verify_effective_acl$;

-- This proposal is not deployable until the broad runtime grant rerun also
-- re-revokes this definer function and the producer role/origin is separately
-- specified, capacity-reviewed and tested on native PostgreSQL.
