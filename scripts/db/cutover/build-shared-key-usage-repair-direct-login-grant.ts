// Review-only two-phase SQL plan. Rendering does not connect or read credentials.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION = 'reviewed-shared-key-usage-repair-login-v3';
export const SHARED_KEY_USAGE_REPAIR_ROLE = 'cinatoken_gateway_shared_key_usage_repair_consumer';
const MIGRATOR = 'cinatoken_gateway_migrator';
const RUNTIME = 'cinatoken_gateway_runtime';
const SCHEMA = 'cinatoken_gateway';
const REPAIR = `${SCHEMA}.attempt_one_shared_key_usage_repair()`;
const CLAIM = `${SCHEMA}.claim_one_shared_key_usage_repair()`;
const FINISH = `${SCHEMA}.finish_claimed_shared_key_usage_repair(text,uuid)`;
const LEGACY_REPAIR = `${SCHEMA}.repair_one_shared_key_usage()`;
const REQUEUE = `${SCHEMA}.requeue_shared_key_usage_repair_dead_letter(text,text)`;
const ENQUEUE = `${SCHEMA}.enqueue_shared_key_usage_repair()`;
const PROPOSAL_URL = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const REVIEWED_PROPOSAL_SHA256 = '7b2f288ecb83e34207bcfd5a2a4eec934c0d6e156190826816ab033716c173d4';
const ISOLATION_URL = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-failure-isolation.sql', import.meta.url);
const REVIEWED_ISOLATION_SHA256 = '14a9be7e9ed354f63b7d74c81303502a0217c9be080f541009466804d3e19b63';
const CLAIM_URL = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-durable-claim.sql', import.meta.url);
const REVIEWED_CLAIM_SHA256 = 'b90fa530433a632280c91837b3981eba026e50ccf863cebc8d161871cc349338';

export interface SharedKeyUsageRepairLoginGrantInput {
  activation: typeof SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION;
  role: typeof SHARED_KEY_USAGE_REPAIR_ROLE;
  database: string;
  /** Externally generated SCRAM verifier; no plaintext password is accepted. */
  scramVerifier: string;
  /** Reconcile this limit with the live instance-wide connection budget. */
  roleConnectionLimit: number;
}

export interface SharedKeyUsageRepairLoginGrantPlan {
  activation: typeof SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION;
  role: typeof SHARED_KEY_USAGE_REPAIR_ROLE;
  database: string;
  roleConnectionLimit: number;
  verifierSha256: string;
  proposalSha256: string;
  isolationProposalSha256: string;
  claimProposalSha256: string;
  adminSql: string;
  migratorSql: string;
  runtimeCompatible: false;
}

function canonicalBase64(value: string, min: number, max = min): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length >= min && decoded.length <= max && decoded.toString('base64') === value;
}

function assertVerifier(input: unknown): asserts input is string {
  if (typeof input !== 'string' || input.length > 400) throw new TypeError('Strong SCRAM verifier required');
  const match = /^SCRAM-SHA-256\$([1-9][0-9]{0,6}):([^$]+)\$([^:]+):([^:]+)$/u.exec(input);
  if (!match || Number(match[1]) < 32768 || Number(match[1]) > 1_000_000 ||
      !canonicalBase64(match[2], 16, 64) || !canonicalBase64(match[3], 32) ||
      !canonicalBase64(match[4], 32)) throw new TypeError('Strong SCRAM verifier required');
}

function assertInput(input: SharedKeyUsageRepairLoginGrantInput): void {
  if (input?.activation !== SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION ||
      input.role !== SHARED_KEY_USAGE_REPAIR_ROLE ||
      typeof input.database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(input.database) ||
      !Number.isSafeInteger(input.roleConnectionLimit) || input.roleConnectionLimit < 1 ||
      input.roleConnectionLimit > 10) throw new TypeError('Explicit reviewed repair LOGIN contract required');
  assertVerifier(input.scramVerifier);
}

function functionBodyMd5(source: string, tag: string): string {
  const pattern = new RegExp(`AS \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`, 'gu');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Reviewed ${tag} function is missing or ambiguous`);
  return createHash('md5').update(matches[0][1].replaceAll('\r\n', '\n')).digest('hex');
}

/** Emits SQL only. DBA and migrator phases require separately authenticated direct LOGINs. */
export async function buildSharedKeyUsageRepairDirectLoginGrant(
  input: SharedKeyUsageRepairLoginGrantInput,
): Promise<SharedKeyUsageRepairLoginGrantPlan> {
  assertInput(input);
  const [proposal, isolation, claimSource] = await Promise.all([
    readFile(PROPOSAL_URL, 'utf8'), readFile(ISOLATION_URL, 'utf8'),
    readFile(CLAIM_URL, 'utf8')]);
  const proposalSha256 = createHash('sha256').update(proposal).digest('hex');
  if (proposalSha256 !== REVIEWED_PROPOSAL_SHA256) throw new Error('Reviewed repair proposal changed; repin after review');
  const isolationProposalSha256 = createHash('sha256').update(isolation).digest('hex');
  if (isolationProposalSha256 !== REVIEWED_ISOLATION_SHA256) throw new Error('Reviewed failure-isolation proposal changed; repin after review');
  const claimProposalSha256 = createHash('sha256').update(claimSource).digest('hex');
  if (claimProposalSha256 !== REVIEWED_CLAIM_SHA256) throw new Error('Reviewed durable-claim proposal changed; repin after review');
  const repairBodyMd5 = functionBodyMd5(isolation, 'attempt');
  const claimBodyMd5 = functionBodyMd5(claimSource, 'claim');
  const finishBodyMd5 = functionBodyMd5(claimSource, 'finish');
  const legacyRepairBodyMd5 = functionBodyMd5(proposal, 'repair');
  const requeueBodyMd5 = functionBodyMd5(claimSource, 'requeue_v3');
  const enqueueBodyMd5 = functionBodyMd5(proposal, 'enqueue');
  const { database, scramVerifier: verifier, roleConnectionLimit: limit } = input;
  const role = SHARED_KEY_USAGE_REPAIR_ROLE;
  const adminSql = `-- REVIEW ONLY. Execute as direct DBA LOGIN, after instance-wide origin-budget review.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923559);
DO $repair_login_dba_preflight$
BEGIN
  IF current_user<>session_user OR current_database()<>'${database}'
    OR pg_catalog.current_setting('server_version_num')::integer<180000
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${role}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${MIGRATOR}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${RUNTIME}')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d,
      LATERAL pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d',d.datdba))) acl
      WHERE d.datallowconn AND acl.grantee=0
        AND acl.privilege_type IN ('CONNECT','CREATE','TEMPORARY'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
      LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n',n.nspowner))) acl
      WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type IN ('USAGE','CREATE')) THEN
    RAISE EXCEPTION 'Repair LOGIN DBA identity, defaults, or isolated database differs';
  END IF;
END;
$repair_login_dba_preflight$;
CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT ${limit} PASSWORD '${verifier}';
GRANT CONNECT ON DATABASE ${database} TO ${role};
ALTER ROLE ${role} IN DATABASE ${database} SET transaction_timeout TO 30000;
ALTER ROLE ${role} IN DATABASE ${database} SET statement_timeout TO 15000;
ALTER ROLE ${role} IN DATABASE ${database} SET lock_timeout TO 5000;
ALTER ROLE ${role} IN DATABASE ${database} SET idle_in_transaction_session_timeout TO 10000;
ALTER ROLE ${role} IN DATABASE ${database} SET search_path TO pg_catalog, pg_temp;
DO $repair_login_dba_postflight$
DECLARE role_oid oid;
BEGIN
  SELECT oid INTO role_oid FROM pg_catalog.pg_roles WHERE rolname='${role}';
  IF role_oid IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=role_oid OR member=role_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_authid
      WHERE oid=role_oid AND rolpassword='${verifier}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=role_oid
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolvaliduntil IS NULL AND rolconnlimit=${limit})
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
      JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase
      WHERE s.setrole=role_oid AND d.datname='${database}' AND pg_catalog.cardinality(s.setconfig)=5
      AND s.setconfig @> ARRAY['transaction_timeout=30000','statement_timeout=15000',
        'lock_timeout=5000','idle_in_transaction_session_timeout=10000',
        'search_path=pg_catalog, pg_temp']::text[])
    OR pg_catalog.has_database_privilege(role_oid, current_database(), 'CREATE')
    OR pg_catalog.has_database_privilege(role_oid, current_database(), 'TEMP')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datallowconn
      AND d.datname<>current_database() AND pg_catalog.has_database_privilege(role_oid,d.oid,'CONNECT')) THEN
    RAISE EXCEPTION 'Repair LOGIN DBA postflight differs';
  END IF;
END;
$repair_login_dba_postflight$;
COMMIT;`;
  const migratorSql = `-- REVIEW ONLY. Execute as direct gateway migrator LOGIN after DBA phase and C04 repair proposal.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923559);
DO $repair_login_preflight$
DECLARE role_oid oid;
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE repair_oid oid;
DECLARE claim_oid oid;
DECLARE finish_oid oid;
DECLARE legacy_repair_oid oid;
DECLARE requeue_oid oid;
DECLARE enqueue_oid oid;
DECLARE job_oid oid;
BEGIN
  SELECT oid INTO role_oid FROM pg_catalog.pg_roles WHERE rolname='${role}';
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='${MIGRATOR}';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='${RUNTIME}';
  repair_oid := pg_catalog.to_regprocedure('${REPAIR}');
  claim_oid := pg_catalog.to_regprocedure('${CLAIM}');
  finish_oid := pg_catalog.to_regprocedure('${FINISH}');
  legacy_repair_oid := pg_catalog.to_regprocedure('${LEGACY_REPAIR}');
  requeue_oid := pg_catalog.to_regprocedure('${REQUEUE}');
  enqueue_oid := pg_catalog.to_regprocedure('${ENQUEUE}');
  job_oid := pg_catalog.to_regclass('${SCHEMA}.shared_key_usage_repair_jobs');
  IF current_user<>'${MIGRATOR}' OR session_user<>current_user
    OR current_database()<>'${database}' OR role_oid IS NULL OR migrator_oid IS NULL
    OR runtime_oid IS NULL OR repair_oid IS NULL OR claim_oid IS NULL
    OR finish_oid IS NULL OR legacy_repair_oid IS NULL
    OR requeue_oid IS NULL OR enqueue_oid IS NULL OR job_oid IS NULL
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR NOT EXISTS (SELECT 1 FROM ${SCHEMA}.schema_migrations
      WHERE version='0073_recovery_api_key_workspace_lock.sql')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='${SCHEMA}.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname='shared_key_earnings_history_immutable' AND t.tgenabled='O'
        AND NOT t.tgisinternal AND t.tgtype=27 AND t.tgqual IS NULL
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid='${SCHEMA}.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc)='208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='${SCHEMA}.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname='shared_key_earnings_history_no_truncate' AND t.tgenabled='O'
        AND NOT t.tgisinternal AND t.tgtype=34 AND t.tgqual IS NULL
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid='${SCHEMA}.reject_shared_key_earnings_history_mutation()'::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc)='208738196cf07b4dc3b5164b8dea0f48')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='${SCHEMA}.shared_key_earnings'::pg_catalog.regclass
        AND t.tgname='shared_key_earnings_credit_after_insert' AND t.tgenabled='O'
        AND NOT t.tgisinternal AND t.tgtype=5 AND t.tgqual IS NULL
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND p.oid='${SCHEMA}.shared_key_earnings_credit_after_insert_fn()'::pg_catalog.regprocedure
        AND p.proowner=migrator_oid AND NOT p.prosecdef
        AND pg_catalog.md5(p.prosrc)='5f4867439aca9484551b83af6bb7c7f6')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
      WHERE nspname='${SCHEMA}' AND nspowner=migrator_oid)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=role_oid
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolvaliduntil IS NULL AND rolconnlimit=${limit})
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=role_oid OR member=role_oid)
    OR NOT pg_catalog.has_database_privilege(role_oid,current_database(),'CONNECT')
    OR pg_catalog.has_database_privilege(role_oid,current_database(),'CREATE')
    OR pg_catalog.has_database_privilege(role_oid,current_database(),'TEMP')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datallowconn
      AND d.datname<>current_database() AND pg_catalog.has_database_privilege(role_oid,d.oid,'CONNECT'))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
      JOIN pg_catalog.pg_database d ON d.oid=s.setdatabase
      WHERE s.setrole=role_oid AND d.datname='${database}' AND pg_catalog.cardinality(s.setconfig)=5
      AND s.setconfig @> ARRAY['transaction_timeout=30000','statement_timeout=15000',
        'lock_timeout=5000','idle_in_transaction_session_timeout=10000',
        'search_path=pg_catalog, pg_temp']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid=job_oid
      AND relkind='r' AND relowner=migrator_oid AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=repair_oid
      AND p.proowner=migrator_oid AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
      AND p.proretset AND p.pronargs=0 AND p.prorettype='pg_catalog.record'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${repairBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=claim_oid
      AND p.proowner=migrator_oid AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
      AND p.proretset AND p.pronargs=0 AND p.prorettype='pg_catalog.record'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.proallargtypes=ARRAY[
        'pg_catalog.text'::pg_catalog.regtype::oid,
        'pg_catalog.uuid'::pg_catalog.regtype::oid,
        'pg_catalog.int4'::pg_catalog.regtype::oid]::oid[]
      AND p.proargmodes=ARRAY['t','t','t']::"char"[]
      AND p.proargnames=ARRAY['shared_key_id','claim_token','attempt_count']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${claimBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=finish_oid
      AND p.proowner=migrator_oid AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
      AND p.proretset AND p.pronargs=2 AND p.prorettype='pg_catalog.record'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.proallargtypes=ARRAY[
        'pg_catalog.text'::pg_catalog.regtype::oid,
        'pg_catalog.uuid'::pg_catalog.regtype::oid,
        'pg_catalog.text'::pg_catalog.regtype::oid,
        'pg_catalog.text'::pg_catalog.regtype::oid,
        'pg_catalog.int4'::pg_catalog.regtype::oid,
        'pg_catalog.timestamptz'::pg_catalog.regtype::oid]::oid[]
      AND p.proargmodes=ARRAY['i','i','t','t','t','t']::"char"[]
      AND p.proargnames=ARRAY['key_id','expected_claim_token','shared_key_id',
        'outcome','attempt_count','retry_at']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${finishBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=legacy_repair_oid
      AND p.proowner=migrator_oid AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
      AND NOT p.proretset AND p.pronargs=0 AND p.prorettype='pg_catalog.text'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${legacyRepairBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=requeue_oid
      AND p.proowner=migrator_oid AND p.prokind='f' AND NOT p.prosecdef AND p.provolatile='v'
      AND NOT p.proretset AND p.pronargs=2 AND p.prorettype='pg_catalog.bool'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${requeueBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=enqueue_oid
      AND p.proowner=migrator_oid AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
      AND NOT p.proretset AND p.pronargs=0 AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${enqueueBodyMd5}')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='${SCHEMA}.shared_key_earnings'::pg_catalog.regclass
      AND t.tgname='shared_key_earnings_enqueue_usage_repair' AND t.tgenabled='O'
      AND NOT t.tgisinternal AND t.tgtype=5 AND t.tgfoid=enqueue_oid
      AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
    OR pg_catalog.has_table_privilege(runtime_oid,job_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_function_privilege(runtime_oid,repair_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,claim_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,finish_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,legacy_repair_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,requeue_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,enqueue_oid,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE c.oid=job_oid AND acl.grantee<>migrator_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN (repair_oid,claim_oid,finish_oid,legacy_repair_oid,requeue_oid,enqueue_oid)
        AND acl.grantee<>migrator_oid) THEN
    RAISE EXCEPTION 'Repair LOGIN proposal, role or pre-grant ACL differs';
  END IF;
END;
$repair_login_preflight$;
GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role};
GRANT EXECUTE ON FUNCTION ${CLAIM} TO ${role};
GRANT EXECUTE ON FUNCTION ${FINISH} TO ${role};
DO $repair_login_postflight$
DECLARE role_oid oid;
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE object_row record;
DECLARE attribute_row record;
DECLARE privilege_name text;
BEGIN
  SELECT oid INTO role_oid FROM pg_catalog.pg_roles WHERE rolname='${role}';
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='${MIGRATOR}';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='${RUNTIME}';
  IF role_oid IS NULL OR migrator_oid IS NULL OR runtime_oid IS NULL
    OR NOT pg_catalog.has_schema_privilege(role_oid,'${SCHEMA}','USAGE')
    OR pg_catalog.has_schema_privilege(role_oid,'${SCHEMA}','CREATE')
    OR pg_catalog.has_schema_privilege(role_oid,'public','USAGE')
    OR pg_catalog.has_schema_privilege(role_oid,'public','CREATE')
    OR pg_catalog.has_function_privilege(runtime_oid,'${REPAIR}','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,'${CLAIM}','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,'${FINISH}','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,'${LEGACY_REPAIR}','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,'${REQUEUE}','EXECUTE')
    OR pg_catalog.has_function_privilege(runtime_oid,'${ENQUEUE}','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(role_oid,'${CLAIM}','EXECUTE')
    OR NOT pg_catalog.has_function_privilege(role_oid,'${FINISH}','EXECUTE')
    OR pg_catalog.has_function_privilege(role_oid,'${REPAIR}','EXECUTE')
    OR pg_catalog.has_function_privilege(role_oid,'${LEGACY_REPAIR}','EXECUTE')
    OR pg_catalog.has_function_privilege(role_oid,'${REQUEUE}','EXECUTE')
    OR pg_catalog.has_function_privilege(role_oid,'${ENQUEUE}','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname<>'${SCHEMA}'
      AND n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.has_schema_privilege(role_oid,n.oid,'USAGE')
        OR pg_catalog.has_schema_privilege(role_oid,n.oid,'CREATE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid IN ('${CLAIM}'::pg_catalog.regprocedure,
        '${FINISH}'::pg_catalog.regprocedure)
        AND (acl.grantee NOT IN (migrator_oid,role_oid)
          OR (acl.grantee=role_oid AND acl.privilege_type<>'EXECUTE')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid='${ENQUEUE}'::pg_catalog.regprocedure AND acl.grantee<>migrator_oid) THEN
    RAISE EXCEPTION 'Repair LOGIN schema, function, or runtime ACL differs';
  END IF;
  FOR object_row IN SELECT c.oid,c.relname,c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${SCHEMA}' LOOP
    IF object_row.relkind IN ('r','p','v','m','f') THEN
      FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE',
        'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
        IF pg_catalog.has_table_privilege(role_oid,object_row.oid,privilege_name) THEN
          RAISE EXCEPTION 'Repair LOGIN table privilege differs: %.%',object_row.relname,privilege_name;
        END IF;
      END LOOP;
      FOR attribute_row IN SELECT attnum,attname FROM pg_catalog.pg_attribute
        WHERE attrelid=object_row.oid AND attnum>0 AND NOT attisdropped LOOP
        FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
          IF pg_catalog.has_column_privilege(role_oid,object_row.oid,
            attribute_row.attnum,privilege_name) THEN
            RAISE EXCEPTION 'Repair LOGIN column privilege differs: %.%.%',
              object_row.relname,attribute_row.attname,privilege_name;
          END IF;
        END LOOP;
      END LOOP;
    ELSIF object_row.relkind='S' THEN
      FOREACH privilege_name IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
        IF pg_catalog.has_sequence_privilege(role_oid,object_row.oid,privilege_name) THEN
          RAISE EXCEPTION 'Repair LOGIN sequence privilege differs: %.%',object_row.relname,privilege_name;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  FOR object_row IN SELECT p.oid,p.oid::pg_catalog.regprocedure::text AS signature
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='${SCHEMA}' LOOP
    IF pg_catalog.has_function_privilege(role_oid,object_row.oid,'EXECUTE')
      IS DISTINCT FROM (object_row.oid IN ('${CLAIM}'::pg_catalog.regprocedure,
        '${FINISH}'::pg_catalog.regprocedure)) THEN
      RAISE EXCEPTION 'Repair LOGIN function privilege differs: %',object_row.signature;
    END IF;
  END LOOP;
END;
$repair_login_postflight$;
COMMIT;`;
  return { activation: SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION, role, database,
    roleConnectionLimit: limit, verifierSha256: createHash('sha256').update(verifier).digest('hex'),
    proposalSha256, isolationProposalSha256, claimProposalSha256,
    adminSql, migratorSql, runtimeCompatible: false };
}
