-- A recovery settlement must hold the API-key row through its entire financial
-- transaction, but the dedicated recovery role must not be able to UPDATE keys.
-- This narrow definer function retains the existing lock-and-compare semantics.
-- The migrator owns this function and the target table; the caller only receives
-- a boolean and cannot choose an arbitrary SQL statement or table.

SET LOCAL lock_timeout = '2s';

CREATE FUNCTION cinatoken_gateway.recovery_api_key_workspace_matches(
  p_api_key_id text,
  p_workspace_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $recovery_api_key_workspace_matches$
DECLARE
  locked_workspace_id text;
BEGIN
  SELECT key.workspace_id INTO locked_workspace_id
  FROM cinatoken_gateway.api_keys AS key
  WHERE key.id = p_api_key_id
  FOR UPDATE;

  RETURN COALESCE(locked_workspace_id = p_workspace_id, false);
END;
$recovery_api_key_workspace_matches$;

-- CREATE FUNCTION normally gives PUBLIC EXECUTE. Keep creation and this revoke
-- in the same migration transaction so no public execution window exists.
REVOKE ALL ON FUNCTION cinatoken_gateway.recovery_api_key_workspace_matches(text,text)
  FROM PUBLIC;
-- The migrator's default privileges can also grant new functions to the
-- ordinary runtime role before the runtime grant phase is rerun.
DO $revoke_recovery_api_key_workspace_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cinatoken_gateway_runtime') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION cinatoken_gateway.recovery_api_key_workspace_matches(text,text)
      FROM cinatoken_gateway_runtime';
  END IF;
END;
$revoke_recovery_api_key_workspace_runtime$;
