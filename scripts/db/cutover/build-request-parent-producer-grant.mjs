// Review-only, default-disabled SQL generator. This grants the pre-provisioned
// dispatch producer only the request-parent function entry points.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const reviewedParentSha256 = '2e8c20088f72271ecf89bc4f43583ec3b2247893a11b84cc6a220563a72de8de';

const functions = [
  ['prepare', 'prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)'],
  ['claim', 'claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)'],
  ['classify', 'classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)'],
];

function functionBodyMd5(source, tag) {
  const start = `AS $${tag}$`;
  const end = `$${tag}$;`;
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) !== -1) {
    throw new Error(`Reviewed parent ${tag} function body is missing or ambiguous`);
  }
  return createHash('md5').update(source.slice(from + start.length, to).replaceAll('\r\n', '\n')).digest('hex');
}

export async function buildRequestParentProducerGrant({ activation } = {}) {
  if (!['reviewed-v1', 'reviewed-direct-login-v1'].includes(activation)) {
    throw new Error('Explicit reviewed-v1 or reviewed-direct-login-v1 request parent producer grant is required');
  }
  const directLogin = activation === 'reviewed-direct-login-v1';
  const loginCheck = directLogin ? 'rolcanlogin' : 'NOT rolcanlogin';
  const source = await readFile(parentProposal, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== reviewedParentSha256) {
    throw new Error('Request parent proposal changed; review and repin the producer grant');
  }
  const functionRows = functions.map(([tag, signature]) =>
    `    ('cinatoken_gateway.${signature}'::pg_catalog.regprocedure, '${functionBodyMd5(source, tag)}')`).join(',\n');
  const grants = functions.map(([, signature]) =>
    `GRANT EXECUTE ON FUNCTION cinatoken_gateway.${signature} TO cinatoken_gateway_dispatch_producer;`).join('\n');
  // The dispatch role must reach gateway data only through the three pinned
  // parent functions. Check effective privileges, including PUBLIC grants.
  const dispatchUnreviewedAccessCheck = `
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'cinatoken_gateway'
        AND ((c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (pg_catalog.has_table_privilege(dispatch_oid, c.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR pg_catalog.has_any_column_privilege(dispatch_oid, c.oid,
              'SELECT, INSERT, UPDATE, REFERENCES')))
          OR (c.relkind = 'S' AND pg_catalog.has_sequence_privilege(dispatch_oid,
            c.oid, 'USAGE, SELECT, UPDATE')))) THEN
    RAISE EXCEPTION 'Dispatch producer can access an unreviewed gateway relation';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'cinatoken_gateway' AND p.prosecdef
        AND p.oid NOT IN (
          ${functions.map(([, signature]) => `'cinatoken_gateway.${signature}'::pg_catalog.regprocedure`).join(',\n          ')})
        AND pg_catalog.has_function_privilege(dispatch_oid, p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'Dispatch producer can execute an unreviewed gateway definer';
  END IF;`;

  return `-- REVIEW ONLY. Requires the separately installed, pinned request parent.
-- Pre-provisioned ${directLogin ? 'LOGIN' : 'NOLOGIN'}/NOINHERIT dispatch and fact roles are required.
-- This bundle never creates a login, changes passwords or origins, or enters formal migrations.
-- Run with stop-on-error. After any error, ROLLBACK or close the connection.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL cinatoken.request_dispatch_parent_producer_grant = '${activation}';
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
LOCK TABLE cinatoken_gateway.request_dispatch_requests,
  cinatoken_gateway.request_dispatch_intents IN SHARE ROW EXCLUSIVE MODE;

DO $producer_parent_preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE dispatch_oid oid;
DECLARE fact_oid oid;
DECLARE checked_oid oid;
DECLARE function_row record;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  SELECT oid INTO dispatch_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_dispatch_producer';
  SELECT oid INTO fact_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  IF CURRENT_USER <> 'cinatoken_gateway_migrator'
      OR migrator_oid IS NULL OR runtime_oid IS NULL OR dispatch_oid IS NULL
      OR fact_oid IS NULL OR dispatch_oid = fact_oid
      OR pg_catalog.current_setting('cinatoken.request_dispatch_parent_producer_grant', true)
        IS DISTINCT FROM '${activation}'
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
        WHERE nspname = 'cinatoken_gateway' AND nspowner = migrator_oid)
      OR NOT EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
        WHERE version = '0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Request parent producer grant identity or migration differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid = dispatch_oid AND ${loginCheck} AND NOT rolinherit
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE oid = fact_oid AND ${loginCheck} AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member IN (dispatch_oid, fact_oid)
          OR roleid IN (dispatch_oid, fact_oid))
      OR pg_catalog.pg_has_role(fact_oid, migrator_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(runtime_oid, migrator_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(runtime_oid, dispatch_oid, 'MEMBER')
      OR pg_catalog.pg_has_role(runtime_oid, fact_oid, 'MEMBER') THEN
    RAISE EXCEPTION 'Request parent producer role separation differs';
  END IF;
  -- Check effective runtime access before producer access. A PUBLIC column
  -- grant reaches both roles and must be reported as an ordinary runtime leak.
  IF pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(runtime_oid,
        'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES') THEN
    RAISE EXCEPTION 'Ordinary runtime can access request parent table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class
      WHERE oid = 'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass
        AND relkind = 'r' AND relowner = migrator_oid
        AND NOT relrowsecurity AND NOT relforcerowsecurity) THEN
    RAISE EXCEPTION 'Request parent table ownership or policy differs';
  END IF;
  FOREACH checked_oid IN ARRAY ARRAY[dispatch_oid, fact_oid] LOOP
    IF pg_catalog.has_table_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES')
      OR pg_catalog.has_table_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'Request parent producer has direct parent or intent privilege';
    END IF;
    IF pg_catalog.has_schema_privilege(checked_oid,
      'cinatoken_gateway', 'CREATE')
      OR pg_catalog.has_table_privilege(checked_oid,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(checked_oid,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES')
      OR pg_catalog.has_function_privilege(checked_oid,
        'cinatoken_gateway.guard_request_dispatch_intent()'::pg_catalog.regprocedure,
        'EXECUTE') THEN
      RAISE EXCEPTION 'Request parent producer has schema, Key or trigger privilege';
    END IF;
  END LOOP;
  ${dispatchUnreviewedAccessCheck}
  FOR function_row IN
    SELECT expected.oid, expected.body_md5
    FROM (VALUES
${functionRows}
    ) AS expected(oid, body_md5)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_language language ON language.oid = p.prolang
        WHERE p.oid = function_row.oid AND p.proowner = migrator_oid
          AND p.prokind = 'f' AND language.lanname = 'plpgsql'
          AND p.prosecdef AND p.provolatile = 'v'
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
          AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\\r\\n', E'\\n'))
            = function_row.body_md5)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
            LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
              pg_catalog.acldefault('f', p.proowner))) acl
          WHERE p.oid = function_row.oid
            AND (acl.grantee NOT IN (migrator_oid, dispatch_oid)
              OR acl.privilege_type <> 'EXECUTE' OR acl.is_grantable))
        OR pg_catalog.has_function_privilege(runtime_oid, function_row.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege(fact_oid, function_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Request parent function source or ACL differs';
    END IF;
  END LOOP;
END;
$producer_parent_preflight$;

GRANT USAGE ON SCHEMA cinatoken_gateway TO cinatoken_gateway_dispatch_producer;
${grants}

DO $producer_parent_postflight$
DECLARE dispatch_oid oid;
DECLARE fact_oid oid;
DECLARE runtime_oid oid;
DECLARE checked_oid oid;
DECLARE function_oid oid;
BEGIN
  SELECT oid INTO STRICT dispatch_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_dispatch_producer';
  SELECT oid INTO STRICT fact_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_fact_producer';
  SELECT oid INTO STRICT runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'cinatoken_gateway_runtime';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid = dispatch_oid AND ${loginCheck} AND NOT rolinherit
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE oid = fact_oid AND ${loginCheck} AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member IN (dispatch_oid, fact_oid)
          OR roleid IN (dispatch_oid, fact_oid)) THEN
    RAISE EXCEPTION 'Request parent producer postflight role separation differs';
  END IF;
  IF NOT pg_catalog.has_schema_privilege(dispatch_oid,
      'cinatoken_gateway', 'USAGE') THEN
    RAISE EXCEPTION 'Request parent producer postflight schema privilege differs';
  END IF;
  FOREACH checked_oid IN ARRAY ARRAY[dispatch_oid, fact_oid] LOOP
    IF pg_catalog.has_schema_privilege(checked_oid,
        'cinatoken_gateway', 'CREATE')
      OR pg_catalog.has_table_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES')
      OR pg_catalog.has_table_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(checked_oid,
        'cinatoken_gateway.request_dispatch_intents'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES')
      OR pg_catalog.has_table_privilege(checked_oid,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(checked_oid,
        'cinatoken_gateway.api_keys'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES')
      OR pg_catalog.has_function_privilege(checked_oid,
        'cinatoken_gateway.guard_request_dispatch_intent()'::pg_catalog.regprocedure,
        'EXECUTE') THEN
      RAISE EXCEPTION 'Request parent producer postflight table privilege differs';
    END IF;
  END LOOP;
  ${dispatchUnreviewedAccessCheck}
  IF pg_catalog.has_table_privilege(runtime_oid,
      'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(runtime_oid,
        'cinatoken_gateway.request_dispatch_requests'::pg_catalog.regclass,
        'SELECT, INSERT, UPDATE, REFERENCES') THEN
    RAISE EXCEPTION 'Ordinary runtime postflight can access request parent table';
  END IF;
  FOREACH function_oid IN ARRAY ARRAY[
    ${functions.map(([, signature]) => `'cinatoken_gateway.${signature}'::pg_catalog.regprocedure`).join(',\n    ')}
  ] LOOP
    IF NOT pg_catalog.has_function_privilege(dispatch_oid, function_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege(runtime_oid, function_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege(fact_oid, function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Request parent producer postflight function privilege differs';
    END IF;
  END LOOP;
END;
$producer_parent_postflight$;
COMMIT;
`;
}
