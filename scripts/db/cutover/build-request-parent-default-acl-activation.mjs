// Review-only SQL generator. Importing this module neither connects to a database
// nor emits SQL. The caller must explicitly request the pinned V1 bundle.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const reviewedParentSha256 = '2e8c20088f72271ecf89bc4f43583ec3b2247893a11b84cc6a220563a72de8de';

export async function buildRequestParentDefaultAclActivation({ activation } = {}) {
  if (activation !== 'reviewed-v1') {
    throw new Error('Explicit reviewed-v1 request parent activation is required');
  }
  const parentSql = await readFile(parentProposal, 'utf8');
  const actualSha256 = createHash('sha256').update(parentSql).digest('hex');
  if (actualSha256 !== reviewedParentSha256) {
    throw new Error('Request parent proposal changed; review and repin the activation bundle');
  }

  return `-- REVIEW ONLY. Explicit one-transaction installation of pinned request parent SQL.
-- Never put this bundle into automatic migrations or a production factory.
-- The ordinary runtime defaults are narrowed only inside this transaction;
-- other sessions never observe an intermediate committed default ACL.
-- Run with stop-on-error; after any error, ROLLBACK or close the connection.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);

DO $parent_default_acl_preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE schema_oid oid;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO schema_oid FROM pg_catalog.pg_namespace
    WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid;
  IF migrator_oid IS NULL OR runtime_oid IS NULL OR schema_oid IS NULL
      OR CURRENT_USER <> 'cinatoken_gateway_migrator' THEN
    RAISE EXCEPTION 'Request parent default ACL activation identity differs';
  END IF;
  -- grant-postgres-runtime installs exactly these two migrator/schema defaults.
  -- Unknown entries, grant options, or absent rows must be reviewed separately.
  IF (SELECT count(*) FROM pg_catalog.pg_default_acl d
      WHERE d.defaclrole = migrator_oid AND d.defaclnamespace = schema_oid
        AND d.defaclobjtype IN ('r', 'f')) <> 2
    OR (SELECT count(*) FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migrator_oid AND d.defaclnamespace = schema_oid
        AND d.defaclobjtype IN ('r', 'f')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migrator_oid AND d.defaclnamespace = schema_oid
        AND d.defaclobjtype IN ('r', 'f')
        AND NOT (acl.grantee = runtime_oid AND acl.grantor = migrator_oid
          AND NOT acl.is_grantable AND (
            (d.defaclobjtype = 'r' AND acl.privilege_type = 'SELECT')
            OR (d.defaclobjtype = 'f' AND acl.privilege_type = 'EXECUTE'))))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d,
        LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migrator_oid AND d.defaclnamespace = 0
        AND d.defaclobjtype IN ('r', 'f') AND acl.grantee <> migrator_oid
        AND NOT (d.defaclobjtype = 'f' AND acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE' AND NOT acl.is_grantable)) THEN
    RAISE EXCEPTION 'Request parent default ACL differs from reviewed runtime grants';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_default_acl d,
      LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migrator_oid AND d.defaclnamespace = schema_oid
        AND d.defaclobjtype = 'r' AND acl.grantee = runtime_oid
        AND acl.privilege_type = 'SELECT') <> 1
    OR (SELECT count(*) FROM pg_catalog.pg_default_acl d,
      LATERAL pg_catalog.aclexplode(d.defaclacl) acl
      WHERE d.defaclrole = migrator_oid AND d.defaclnamespace = schema_oid
        AND d.defaclobjtype = 'f' AND acl.grantee = runtime_oid
        AND acl.privilege_type = 'EXECUTE') <> 1 THEN
    RAISE EXCEPTION 'Request parent default ACL expected grants are missing';
  END IF;
END;
$parent_default_acl_preflight$;

-- Snapshot every default ACL owned by the migrator, including unaffected
-- object types and namespaces, so restoration is checked without weakening them.
CREATE TEMP TABLE parent_default_acl_snapshot ON COMMIT DROP AS
  SELECT defaclnamespace, defaclobjtype, defaclacl::text AS acl_text
  FROM pg_catalog.pg_default_acl
  WHERE defaclrole = (SELECT oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator');

ALTER DEFAULT PRIVILEGES IN SCHEMA cinatoken_gateway
  REVOKE SELECT ON TABLES FROM cinatoken_gateway_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA cinatoken_gateway
  REVOKE EXECUTE ON FUNCTIONS FROM cinatoken_gateway_runtime;

SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1';
${parentSql}

ALTER DEFAULT PRIVILEGES IN SCHEMA cinatoken_gateway
  GRANT SELECT ON TABLES TO cinatoken_gateway_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA cinatoken_gateway
  GRANT EXECUTE ON FUNCTIONS TO cinatoken_gateway_runtime;

DO $parent_default_acl_restore$
BEGIN
  IF EXISTS (
    (SELECT defaclnamespace, defaclobjtype, acl_text
       FROM pg_temp.parent_default_acl_snapshot
     EXCEPT ALL
     SELECT defaclnamespace, defaclobjtype, defaclacl::text
       FROM pg_catalog.pg_default_acl
       WHERE defaclrole = (SELECT oid FROM pg_catalog.pg_roles
         WHERE rolname = 'cinatoken_gateway_migrator'))
    UNION ALL
    (SELECT defaclnamespace, defaclobjtype, defaclacl::text
       FROM pg_catalog.pg_default_acl
       WHERE defaclrole = (SELECT oid FROM pg_catalog.pg_roles
         WHERE rolname = 'cinatoken_gateway_migrator')
     EXCEPT ALL
     SELECT defaclnamespace, defaclobjtype, acl_text
       FROM pg_temp.parent_default_acl_snapshot)
  ) THEN
    RAISE EXCEPTION 'Request parent default ACL restoration differs';
  END IF;
END;
$parent_default_acl_restore$;
COMMIT;
`;
}
