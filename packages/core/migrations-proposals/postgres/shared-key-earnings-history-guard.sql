-- REVIEW ONLY. Protect an already credited seller earning from direct mutation
-- and from the ON DELETE CASCADE paths left on shared_keys and users by 0027.
-- Apply as cinatoken_gateway_migrator in one explicit transaction after 0073,
-- with SET LOCAL cinatoken.shared_key_earnings_history_guard_activation = 'reviewed-v1'.
-- This does not create an immutable quote, economic outbox or retention policy.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path TO pg_catalog, pg_temp;

DO $activation$
BEGIN
  IF pg_catalog.current_setting('cinatoken.shared_key_earnings_history_guard_activation', true)
       IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator' THEN
    RAISE EXCEPTION 'Shared-key earning history activation or owner contract differs';
  END IF;
END;
$activation$;

-- CREATE TRIGGER itself needs a write-blocking table lock. Acquire it before
-- the catalogue checks so concurrent earning INSERTs cannot cross activation.
LOCK TABLE cinatoken_gateway.shared_key_earnings IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE migrator_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  IF pg_catalog.current_setting('cinatoken.shared_key_earnings_history_guard_activation', true)
       IS DISTINCT FROM 'reviewed-v1'
    OR CURRENT_USER <> 'cinatoken_gateway_migrator' OR migrator_oid IS NULL
    OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
      WHERE version = '0073_recovery_api_key_workspace_lock.sql')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND relowner = migrator_oid AND relkind = 'r'
        AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname = 'shared_key_earnings_credit_after_insert' AND tgenabled = 'O')
    OR pg_catalog.to_regprocedure('cinatoken_gateway.reject_shared_key_earnings_history_mutation()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
        AND tgname IN ('shared_key_earnings_history_immutable',
          'shared_key_earnings_history_no_truncate')) THEN
    RAISE EXCEPTION 'Shared-key earning history activation or owner contract differs';
  END IF;
END;
$preflight$;

CREATE FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp AS $reject$
BEGIN
  IF TG_RELID <> 'cinatoken_gateway.shared_key_earnings'::pg_catalog.regclass
    OR (TG_NAME = 'shared_key_earnings_history_immutable'
      AND TG_OP NOT IN ('UPDATE','DELETE'))
    OR (TG_NAME = 'shared_key_earnings_history_no_truncate'
      AND TG_OP <> 'TRUNCATE')
    OR TG_NAME NOT IN ('shared_key_earnings_history_immutable',
      'shared_key_earnings_history_no_truncate') THEN
    RAISE EXCEPTION 'Shared-key earning history trigger binding differs';
  END IF;
  RAISE EXCEPTION 'Credited shared-key earning history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'shared_key_earnings_history_immutable';
END;
$reject$;

CREATE TRIGGER shared_key_earnings_history_immutable
  BEFORE UPDATE OR DELETE ON cinatoken_gateway.shared_key_earnings
  FOR EACH ROW EXECUTE FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation();
CREATE TRIGGER shared_key_earnings_history_no_truncate
  BEFORE TRUNCATE ON cinatoken_gateway.shared_key_earnings
  FOR EACH STATEMENT EXECUTE FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation();

REVOKE ALL ON FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION cinatoken_gateway.reject_shared_key_earnings_history_mutation()
  FROM cinatoken_gateway_runtime;
