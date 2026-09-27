// Review-only, default-disabled SQL plan for a separate financial consumer LOGIN.
// Rendering never connects to PostgreSQL or reads an ambient credential.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  POSTGRES_RECOVERY_SCHEMA, RECOVERY_FUNCTION_GRANTS,
  RECOVERY_TABLE_GRANTS, REQUIRED_TRIGGERS,
  REPLAY_PARENT_GATE_TRIGGERS, REPLAY_RESERVATION_TRIGGERS,
} from './postgres-recovery-role-policy';

export const FINANCIAL_CONSUMER_GRANT_ACTIVATION = 'reviewed-financial-direct-login-v1';
export const FINANCIAL_CONSUMER_ROLE = 'cinatoken_gateway_financial_recovery_consumer';
const MIGRATOR_ROLE = 'cinatoken_gateway_migrator';
const RUNTIME_ROLE = 'cinatoken_gateway_runtime';
const SCHEMA = POSTGRES_RECOVERY_SCHEMA;

const reviewedSources = [
  ['catalogue', './postgres-recovery-role-policy.ts', '8110d641d3d19fce2bfe9c4bd691bbf7927c15dd33ecd297be843d51f10b8ca5'],
  ['logGuard', './postgres-recovery-legacy-log-guard.activate.sql', '24a601dbafd66f16cdd14dcc81017bc26199c6b833e311d389cdb07103010763'],
  ['migration0068', '../../../packages/core/migrations-postgres/0068_function_schema_resolution.sql', 'cf49030dac3b851788438ff80a2859dd17eadc819db5adcb6f4225b22b8663ec'],
  ['migration0069', '../../../packages/core/migrations-postgres/0069_recovery_dispatch_intents.sql', '0cca7e371a63cdc44c746202909293761aefa226cf221ce48752cb7d2fff646d'],
  ['migration0070', '../../../packages/core/migrations-postgres/0070_recovery_settlement_facts.sql', 'b45741ed725181e96c16c944f2d8f02bcd8c415c8046da6f36617844bd24e5e7'],
  ['migration0071', '../../../packages/core/migrations-postgres/0071_recovery_jobs.sql', 'a694e7d44fd93024603d09931ea2c3b03d4737a5933f3a3748c25b43e55e5cf2'],
  ['migration0072', '../../../packages/core/migrations-postgres/0072_recovery_commit_receipts.sql', 'f96d03a30f32faddbb3f8a3d652b78dbc7deef860461dea7f81f7317247e505d'],
  ['migration0073', '../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql', '07025d295d1cf672235c9d45cea77c4bbef8f3859199708206833d945345593b'],
  ['replayBase', '../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', 'c288bbc43fad3bbb8b3b1a88fa1b1d01b9e5f2f9f520753873e0cdf21643c3d8'],
  ['replayGate', '../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', '1079eb858811c70dd850b95be68f64e5c7b8361926e8c3f0a9e80621f6125b10'],
] as const;

export interface FinancialConsumerGrantInput {
  activation: typeof FINANCIAL_CONSUMER_GRANT_ACTIVATION;
  /** Must be explicitly supplied and equal the fixed, reviewable consumer identity. */
  role: typeof FINANCIAL_CONSUMER_ROLE;
  database: string;
  /** Externally generated SCRAM verifier. The plaintext password is never accepted. */
  scramVerifier: string;
  /** Must be reconciled with the live, instance-wide origin budget separately. */
  roleConnectionLimit: number;
  /** Optional fully gated replay reservation schema; absent means no replay schema. */
  replayReservationPhase?: 'parent-gated';
}

export interface FinancialConsumerGrantPlan {
  role: typeof FINANCIAL_CONSUMER_ROLE;
  database: string;
  roleConnectionLimit: number;
  verifierSha256: string;
  adminSql: string;
  migratorSql: string;
  runtimeCompatible: false;
  activation: typeof FINANCIAL_CONSUMER_GRANT_ACTIVATION;
  replayReservationPhase: 'none' | 'parent-gated';
}

function canonicalBase64(value: string, byteLength: number | [number, number]): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  const correctLength = typeof byteLength === 'number'
    ? decoded.length === byteLength
    : decoded.length >= byteLength[0] && decoded.length <= byteLength[1];
  return correctLength && decoded.toString('base64') === value;
}

/** Validate the verifier format, work factor and salt/key lengths; entropy is external evidence. */
export function assertStrongFinancialScramVerifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 400 || value.includes('\n')) {
    throw new TypeError('A strong, externally generated SCRAM-SHA-256 verifier is required.');
  }
  const match = /^SCRAM-SHA-256\$([1-9][0-9]{0,6}):([^$]+)\$([^:]+):([^:]+)$/.exec(value);
  if (!match || Number(match[1]) < 32768 || Number(match[1]) > 1_000_000 ||
      !canonicalBase64(match[2], [16, 64]) ||
      !canonicalBase64(match[3], 32) || !canonicalBase64(match[4], 32)) {
    throw new TypeError('The SCRAM verifier must use 32768–1000000 iterations, a 16–64 byte salt and 32 byte keys.');
  }
  return value;
}

function sqlValue(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function sqlRows(rows: string[][]): string {
  if (!rows.length) throw new Error('A reviewed SQL catalogue cannot be empty.');
  return rows.map(row => `(${row.map(sqlValue).join(', ')})`).join(',\n      ');
}

async function assertReviewedSources(): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const [name, path, expected] of reviewedSources) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const actual = createHash('sha256').update(source).digest('hex');
    if (actual !== expected) throw new Error(`Reviewed ${name} source changed; repin the financial grant after review.`);
    contents.set(name, source);
  }
  return contents;
}

function functionBodyMd5(source: string, tag: string): string {
  const pattern = new RegExp(`AS \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Pinned financial ${tag} function body missing or ambiguous.`);
  return createHash('md5').update(matches[0][1].replaceAll('\r\n', '\n')).digest('hex');
}

function replayFunctionBodyMd5(source: string, name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid replay function name.');
  const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${SCHEMA}\\.${name}\\(\\)[\\s\\S]*?AS \\$(\\w+)\\$([\\s\\S]*?)\\$\\1\\$;`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Pinned replay function ${name} missing or ambiguous.`);
  return createHash('md5').update(matches[0][2].replaceAll('\r\n', '\n')).digest('hex');
}

function assertInput(input: FinancialConsumerGrantInput): void {
  if (!input || input.activation !== FINANCIAL_CONSUMER_GRANT_ACTIVATION ||
      input.role !== FINANCIAL_CONSUMER_ROLE) {
    throw new TypeError('Explicit reviewed financial direct-LOGIN activation and fixed role identity are required.');
  }
  if (typeof input.database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(input.database)) {
    throw new TypeError('An explicit, simple PostgreSQL database identifier is required.');
  }
  if (!Number.isSafeInteger(input.roleConnectionLimit) ||
      input.roleConnectionLimit < 1 || input.roleConnectionLimit > 10) {
    throw new TypeError('A reviewed role connection limit from 1 to 10 is required.');
  }
  if (input.replayReservationPhase !== undefined &&
      input.replayReservationPhase !== 'parent-gated') {
    throw new TypeError('Only the explicitly reviewed parent-gated replay phase is supported.');
  }
  assertStrongFinancialScramVerifier(input.scramVerifier);
}

function aclAudit(required: boolean, tableVerbRows: string, columnRows: string,
  functionRows: string): string {
  return `
  IF pg_catalog.has_schema_privilege(consumer_oid, '${SCHEMA}', 'USAGE') IS DISTINCT FROM ${required}
      OR pg_catalog.has_schema_privilege(consumer_oid, '${SCHEMA}', 'CREATE') THEN
    RAISE EXCEPTION 'Financial consumer schema ACL differs';
  END IF;
  FOR object_row IN
    SELECT c.oid, c.relname, c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='${SCHEMA}'
  LOOP
    IF object_row.relkind IN ('r','p','v','m','f') THEN
      FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
        SELECT EXISTS (SELECT 1 FROM (VALUES
          ${tableVerbRows}
        ) AS expected(table_name, privilege)
          WHERE expected.table_name=object_row.relname AND expected.privilege=privilege_name)
          INTO expected_privilege;
        IF pg_catalog.has_table_privilege(consumer_oid, object_row.oid, privilege_name)
            IS DISTINCT FROM (${required} AND expected_privilege) THEN
          RAISE EXCEPTION 'Financial consumer table ACL differs: %.%', object_row.relname, privilege_name;
        END IF;
      END LOOP;
      FOR attribute_row IN SELECT attnum, attname FROM pg_catalog.pg_attribute
        WHERE attrelid=object_row.oid AND attnum>0 AND NOT attisdropped LOOP
        FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
          SELECT EXISTS (SELECT 1 FROM (VALUES
            ${tableVerbRows}
          ) AS expected(table_name, privilege)
            WHERE expected.table_name=object_row.relname AND expected.privilege=privilege_name)
            OR EXISTS (SELECT 1 FROM (VALUES
              ${columnRows}
            ) AS expected(table_name, column_name, privilege)
              WHERE expected.table_name=object_row.relname
                AND expected.column_name=attribute_row.attname
                AND expected.privilege=privilege_name)
            INTO expected_privilege;
          IF pg_catalog.has_column_privilege(consumer_oid, object_row.oid,
              attribute_row.attnum, privilege_name)
              IS DISTINCT FROM (${required} AND expected_privilege) THEN
            RAISE EXCEPTION 'Financial consumer column ACL differs: %.%.%',
              object_row.relname, attribute_row.attname, privilege_name;
          END IF;
        END LOOP;
      END LOOP;
    ELSIF object_row.relkind='S' THEN
      FOREACH privilege_name IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
        IF pg_catalog.has_sequence_privilege(consumer_oid, object_row.oid, privilege_name) THEN
          RAISE EXCEPTION 'Financial consumer sequence ACL differs: %.%', object_row.relname, privilege_name;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  FOR object_row IN
    SELECT p.oid, p.oid::pg_catalog.regprocedure::text AS signature
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='${SCHEMA}'
  LOOP
    SELECT EXISTS (SELECT 1 FROM (VALUES
      ${functionRows}
    ) AS expected(signature) WHERE expected.signature=object_row.signature)
      INTO expected_privilege;
    IF pg_catalog.has_function_privilege(consumer_oid, object_row.oid, 'EXECUTE')
        IS DISTINCT FROM (${required} AND expected_privilege) THEN
      RAISE EXCEPTION 'Financial consumer function ACL differs: %', object_row.signature;
    END IF;
  END LOOP;`;
}

/** Returns SQL only; callers must review live budget, origin binding, server config and each phase. */
export async function buildFinancialConsumerDirectLoginGrant(
  input: FinancialConsumerGrantInput,
): Promise<FinancialConsumerGrantPlan> {
  assertInput(input);
  const reviewed = await assertReviewedSources();
  const role = FINANCIAL_CONSUMER_ROLE;
  const database = input.database;
  const verifier = input.scramVerifier;
  const limit = input.roleConnectionLimit;
  const replayGate = input.replayReservationPhase === 'parent-gated';
  const triggers = replayGate
    ? [...REQUIRED_TRIGGERS, ...REPLAY_RESERVATION_TRIGGERS, ...REPLAY_PARENT_GATE_TRIGGERS]
    : [...REQUIRED_TRIGGERS];
  const tableNames = [
    ...RECOVERY_TABLE_GRANTS.map(entry => entry.table),
    ...(replayGate ? ['request_dispatch_requests', 'request_dispatch_replay_tombstones'] : []),
  ];
  if (new Set(tableNames).size !== tableNames.length ||
      new Set(RECOVERY_FUNCTION_GRANTS).size !== RECOVERY_FUNCTION_GRANTS.length) {
    throw new Error('Financial grant catalogue has duplicate objects.');
  }
  const tableVerbRows = sqlRows(RECOVERY_TABLE_GRANTS.flatMap(entry =>
    entry.privileges.map(privilege => [entry.table, privilege])));
  const columnRows = sqlRows(RECOVERY_TABLE_GRANTS.flatMap(entry => [
    ...('selectColumns' in entry ? entry.selectColumns.map(column => [entry.table, column, 'SELECT']) : []),
    ...entry.updateColumns.map(column => [entry.table, column, 'UPDATE']),
  ]));
  const functionRows = sqlRows(RECOVERY_FUNCTION_GRANTS.map(signature => [`${SCHEMA}.${signature}`]));
  const source0072 = reviewed.get('migration0072')!;
  const source0073 = reviewed.get('migration0073')!;
  const pinnedFunctionRows = sqlRows([
    ['recovery_api_key_workspace_matches(text,text)', 'plpgsql', 'v', 'true', 'false',
      'boolean', 'search_path=pg_catalog, pg_temp', functionBodyMd5(source0073, 'recovery_api_key_workspace_matches')],
    ['usage_commit_matches(text,text)', 'sql', 's', 'false', 'false',
      'boolean', 'search_path=pg_catalog, pg_temp', functionBodyMd5(source0072, 'match')],
    ['usage_round_nonnegative_v1(double precision)', 'plpgsql', 'i', 'false', 'true',
      'double precision', 'search_path=pg_catalog, pg_temp', functionBodyMd5(source0072, 'round')],
    ['usage_money_v1(text)', 'sql', 'i', 'false', 'true',
      'numeric', 'search_path=pg_catalog, pg_temp;extra_float_digits=3', functionBodyMd5(source0072, 'money')],
    ['usage_budget_units_v1(text)', 'plpgsql', 'i', 'false', 'true',
      'bigint', 'search_path=pg_catalog, pg_temp', functionBodyMd5(source0072, 'units')],
    ...(replayGate ? [
      ['guard_request_dispatch_replay_insert()', 'plpgsql', 'v', 'false', 'false',
        'trigger', 'search_path=pg_catalog, pg_temp',
        replayFunctionBodyMd5(reviewed.get('replayBase')!, 'guard_request_dispatch_replay_insert')],
      ['reject_request_dispatch_replay_mutation()', 'plpgsql', 'v', 'false', 'false',
        'trigger', 'search_path=pg_catalog, pg_temp',
        replayFunctionBodyMd5(reviewed.get('replayBase')!, 'reject_request_dispatch_replay_mutation')],
      ['reserve_request_dispatch_intent_id()', 'plpgsql', 'v', 'true', 'false',
        'trigger', 'search_path=pg_catalog, pg_temp',
        replayFunctionBodyMd5(reviewed.get('replayGate')!, 'reserve_request_dispatch_intent_id')],
      ['reserve_request_log_replay_id()', 'plpgsql', 'v', 'true', 'false',
        'trigger', 'search_path=pg_catalog, pg_temp',
        replayFunctionBodyMd5(reviewed.get('replayBase')!, 'reserve_request_log_replay_id')],
      ['guard_request_log_replay_id_update()', 'plpgsql', 'v', 'false', 'false',
        'trigger', 'search_path=pg_catalog, pg_temp',
        replayFunctionBodyMd5(reviewed.get('replayBase')!, 'guard_request_log_replay_id_update')],
      ['reserve_request_dispatch_parent_id()', 'plpgsql', 'v', 'false', 'false',
        'trigger', 'search_path=pg_catalog, pg_temp',
        replayFunctionBodyMd5(reviewed.get('replayGate')!, 'reserve_request_dispatch_parent_id')],
    ] : []),
  ].map(([signature, ...metadata]) => [`${SCHEMA}.${signature}`, ...metadata]));
  const triggerRows = sqlRows(triggers.map(([
    table, name, functionName, triggerType, deferrable, initiallyDeferred,
  ]) => [table, name, `${SCHEMA}.${functionName}`, String(triggerType), String(deferrable), String(initiallyDeferred)]));
  const replayFunctionRows = replayGate ? sqlRows([
    'guard_request_dispatch_replay_insert()',
    'reject_request_dispatch_replay_mutation()',
    'reserve_request_dispatch_intent_id()',
    'reserve_request_log_replay_id()',
    'guard_request_log_replay_id_update()',
    'reserve_request_dispatch_parent_id()',
  ].map(signature => [`${SCHEMA}.${signature}`])) : '';
  const tableRows = sqlRows(tableNames.map(name => [name]));
  const grantSql = [
    `GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role};`,
    ...RECOVERY_TABLE_GRANTS.flatMap(entry => [
      ...('selectColumns' in entry && entry.selectColumns.length
        ? [`GRANT SELECT (${entry.selectColumns.join(', ')}) ON TABLE ${SCHEMA}.${entry.table} TO ${role};`] : []),
      ...(entry.privileges.length
        ? [`GRANT ${entry.privileges.join(', ')} ON TABLE ${SCHEMA}.${entry.table} TO ${role};`] : []),
      ...(entry.updateColumns.length
        ? [`GRANT UPDATE (${entry.updateColumns.join(', ')}) ON TABLE ${SCHEMA}.${entry.table} TO ${role};`] : []),
    ]),
    ...RECOVERY_FUNCTION_GRANTS.map(signature =>
      `GRANT EXECUTE ON FUNCTION ${SCHEMA}.${signature} TO ${role};`),
  ].join('\n');
  const roleCheck = `
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles WHERE rolname='${role}';
  IF consumer_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE oid=consumer_oid
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolvaliduntil IS NULL AND rolconnlimit=${limit})
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE roleid=consumer_oid OR member=consumer_oid)
      OR NOT pg_catalog.has_database_privilege(consumer_oid, current_database(), 'CONNECT')
      OR pg_catalog.has_database_privilege(consumer_oid, current_database(), 'CREATE')
      OR pg_catalog.has_database_privilege(consumer_oid, current_database(), 'TEMP')
      OR (pg_catalog.to_regnamespace('public') IS NOT NULL AND
        (pg_catalog.has_schema_privilege(consumer_oid, 'public', 'USAGE')
          OR pg_catalog.has_schema_privilege(consumer_oid, 'public', 'CREATE')))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace namespace
        WHERE namespace.nspname<>'${SCHEMA}'
          AND namespace.nspname<>'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND (pg_catalog.has_schema_privilege(consumer_oid, namespace.oid, 'USAGE')
            OR pg_catalog.has_schema_privilege(consumer_oid, namespace.oid, 'CREATE')))
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_db_role_setting setting
        JOIN pg_catalog.pg_database database ON database.oid=setting.setdatabase
        WHERE setting.setrole=consumer_oid AND database.datname='${database}'
          AND pg_catalog.cardinality(setting.setconfig)=5
          AND setting.setconfig @> ARRAY[
            'transaction_timeout=30000', 'statement_timeout=15000',
            'lock_timeout=5000', 'idle_in_transaction_session_timeout=10000',
            'search_path=pg_catalog, pg_temp']::text[])
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_database other_database
        WHERE other_database.datallowconn AND other_database.datname<>current_database()
          AND pg_catalog.has_database_privilege(consumer_oid, other_database.oid, 'CONNECT')) THEN
    RAISE EXCEPTION 'Financial consumer direct LOGIN, defaults or database isolation differs';
  END IF;`;
  const adminSql = `-- REVIEW ONLY. Execute this phase as a direct PostgreSQL superuser after an instance-wide origin budget review.
-- Contains a SCRAM verifier, which is credential material; keep the plan in a controlled channel.
-- A failed phase must be rolled back or the connection closed before retrying.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
SELECT pg_catalog.pg_advisory_xact_lock(746923558);
DO $financial_login_preflight$
BEGIN
  IF current_user<>session_user OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
      OR pg_catalog.current_setting('server_version_num')::integer<170000
      OR current_database()<>'${database}'
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
        JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner
        WHERE n.nspname='${SCHEMA}' AND owner.rolname='${MIGRATOR_ROLE}')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${role}') THEN
    RAISE EXCEPTION 'Financial LOGIN DBA identity, database, schema or absent role differs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_database database,
      LATERAL pg_catalog.aclexplode(COALESCE(database.datacl,
        pg_catalog.acldefault('d', database.datdba))) acl
    WHERE database.datname=current_database() AND acl.grantee=0
      AND acl.privilege_type IN ('CONNECT','CREATE','TEMPORARY'))
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_database database,
        LATERAL pg_catalog.aclexplode(COALESCE(database.datacl,
          pg_catalog.acldefault('d', database.datdba))) acl
      WHERE database.datallowconn AND database.datname<>current_database()
        AND acl.grantee=0 AND acl.privilege_type='CONNECT')
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,
          pg_catalog.acldefault('n', n.nspowner))) acl
      WHERE n.nspname='public' AND acl.grantee=0
        AND acl.privilege_type IN ('USAGE','CREATE')) THEN
    RAISE EXCEPTION 'PUBLIC database or public-schema ambient privileges must be removed first';
  END IF;
END;
$financial_login_preflight$;
CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT ${limit} PASSWORD '${verifier}';
GRANT CONNECT ON DATABASE ${database} TO ${role};
ALTER ROLE ${role} IN DATABASE ${database} SET transaction_timeout TO 30000;
ALTER ROLE ${role} IN DATABASE ${database} SET statement_timeout TO 15000;
ALTER ROLE ${role} IN DATABASE ${database} SET lock_timeout TO 5000;
ALTER ROLE ${role} IN DATABASE ${database} SET idle_in_transaction_session_timeout TO 10000;
ALTER ROLE ${role} IN DATABASE ${database} SET search_path TO pg_catalog, pg_temp;
DO $financial_login_postflight$
DECLARE consumer_oid oid;
BEGIN
  SELECT oid INTO consumer_oid FROM pg_catalog.pg_roles WHERE rolname='${role}';
  IF consumer_oid IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid=consumer_oid OR member=consumer_oid)
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_authid
        WHERE oid=consumer_oid AND rolpassword='${verifier}')
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE oid=consumer_oid AND rolcanlogin AND NOT rolinherit AND NOT rolsuper
          AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
          AND NOT rolbypassrls AND rolvaliduntil IS NULL AND rolconnlimit=${limit})
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting
        JOIN pg_catalog.pg_database database ON database.oid=setting.setdatabase
        WHERE setting.setrole=consumer_oid AND database.datname='${database}'
          AND pg_catalog.cardinality(setting.setconfig)=5
          AND setting.setconfig @> ARRAY[
            'transaction_timeout=30000', 'statement_timeout=15000',
            'lock_timeout=5000', 'idle_in_transaction_session_timeout=10000',
            'search_path=pg_catalog, pg_temp']::text[])
      OR pg_catalog.has_database_privilege(consumer_oid, current_database(), 'CREATE')
      OR pg_catalog.has_database_privilege(consumer_oid, current_database(), 'TEMP')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace namespace
        WHERE namespace.nspname<>'${SCHEMA}'
          AND namespace.nspname<>'information_schema'
          AND namespace.nspname !~ '^pg_'
          AND (pg_catalog.has_schema_privilege(consumer_oid, namespace.oid, 'USAGE')
            OR pg_catalog.has_schema_privilege(consumer_oid, namespace.oid, 'CREATE'))) THEN
    RAISE EXCEPTION 'Financial LOGIN catalog verification failed';
  END IF;
END;
$financial_login_postflight$;
COMMIT;`;
  const migratorSql = `-- REVIEW ONLY. Execute this phase as a direct gateway migrator LOGIN after the DBA phase.
-- Fixed catalogue grants only; a failed phase must be rolled back or the connection closed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
SELECT pg_catalog.pg_advisory_xact_lock(746923558);
LOCK TABLE ${tableNames.map(name => `${SCHEMA}.${name}`).join(',\n  ')} IN SHARE ROW EXCLUSIVE MODE;
DO $financial_grant_preflight$
DECLARE consumer_oid oid;
DECLARE migrator_oid oid;
DECLARE object_row record;
DECLARE attribute_row record;
DECLARE expected_trigger record;
DECLARE privilege_name text;
DECLARE expected_privilege boolean;
BEGIN
  IF current_user<>'${MIGRATOR_ROLE}' OR session_user<>current_user
      OR current_database()<>'${database}'
      OR pg_catalog.current_setting('server_version_num')::integer<170000
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
        JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner
        WHERE n.nspname='${SCHEMA}' AND owner.rolname='${MIGRATOR_ROLE}')
      OR NOT EXISTS (SELECT 1 FROM ${SCHEMA}.schema_migrations
        WHERE version='0073_recovery_api_key_workspace_lock.sql')
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN
    RAISE EXCEPTION 'Financial grant migrator identity, database or migration differs';
  END IF;
  ${replayGate ? `
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid='${SCHEMA}.request_dispatch_replay_tombstones'::pg_catalog.regclass
        AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles
          WHERE rolname='${MIGRATOR_ROLE}') AND c.relkind='r'
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity)
    OR (SELECT count(*) FROM pg_catalog.pg_attribute a
      WHERE a.attrelid='${SCHEMA}.request_dispatch_replay_tombstones'::pg_catalog.regclass
        AND a.attnum>0 AND NOT a.attisdropped)<>3
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint replay_pk
      JOIN pg_catalog.pg_attribute replay_pk_attribute
        ON replay_pk_attribute.attrelid=replay_pk.conrelid
          AND replay_pk.conkey=ARRAY[replay_pk_attribute.attnum]::smallint[]
      WHERE replay_pk.conrelid='${SCHEMA}.request_dispatch_replay_tombstones'::pg_catalog.regclass
        AND replay_pk.contype='p' AND replay_pk_attribute.attname='request_id')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class relation,
      LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
        pg_catalog.acldefault('r', relation.relowner))) privilege_row
      WHERE relation.oid='${SCHEMA}.request_dispatch_replay_tombstones'::pg_catalog.regclass
        AND privilege_row.grantee<>(SELECT oid FROM pg_catalog.pg_roles
          WHERE rolname='${MIGRATOR_ROLE}')) THEN
    RAISE EXCEPTION 'Financial grant replay tombstone relation or ACL differs';
  END IF;
  FOR object_row IN SELECT signature FROM (VALUES
      ${replayFunctionRows}
    ) AS required(signature) LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) privilege_row
      WHERE p.oid=pg_catalog.to_regprocedure(object_row.signature)
        AND privilege_row.grantee<>(SELECT oid FROM pg_catalog.pg_roles
          WHERE rolname='${MIGRATOR_ROLE}')) THEN
      RAISE EXCEPTION 'Financial grant replay trigger function ACL differs: %', object_row.signature;
    END IF;
  END LOOP;` : `
  IF pg_catalog.to_regclass('${SCHEMA}.request_dispatch_replay_tombstones') IS NOT NULL
    OR pg_catalog.to_regprocedure('${SCHEMA}.reserve_request_dispatch_parent_id()') IS NOT NULL
    OR pg_catalog.to_regprocedure('${SCHEMA}.reserve_request_dispatch_intent_id()') IS NOT NULL
    OR pg_catalog.to_regprocedure('${SCHEMA}.reserve_request_log_replay_id()') IS NOT NULL
    OR pg_catalog.to_regprocedure('${SCHEMA}.guard_request_log_replay_id_update()') IS NOT NULL THEN
    RAISE EXCEPTION 'Financial grant requires explicit parent-gated replay phase';
  END IF;`}
  ${roleCheck}
  FOR object_row IN SELECT name FROM (VALUES
      ${tableRows}
    ) AS expected(name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${SCHEMA}' AND c.relname=object_row.name
        AND c.relkind IN ('r','p') AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles
          WHERE rolname='${MIGRATOR_ROLE}')
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'Financial grant table contract differs: %', object_row.name;
    END IF;
  END LOOP;
  FOR object_row IN SELECT signature FROM (VALUES
      ${functionRows}
    ) AS expected(signature) LOOP
    IF pg_catalog.to_regprocedure(object_row.signature) IS NULL THEN
      RAISE EXCEPTION 'Financial grant function missing: %', object_row.signature;
    END IF;
  END LOOP;
  FOR object_row IN SELECT signature, language_name, volatility, definer,
      is_strict, result_type, function_config, body_md5 FROM (VALUES
      ${pinnedFunctionRows}
    ) AS reviewed(signature, language_name, volatility, definer,
      is_strict, result_type, function_config, body_md5) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
      JOIN pg_catalog.pg_language language ON language.oid=p.prolang
      WHERE p.oid=pg_catalog.to_regprocedure(object_row.signature)
        AND owner.rolname='${MIGRATOR_ROLE}'
        AND language.lanname=object_row.language_name
        AND p.prokind='f' AND p.provolatile=object_row.volatility
        AND p.prosecdef=object_row.definer::boolean
        AND p.proisstrict=object_row.is_strict::boolean
        AND NOT p.proretset
        AND p.prorettype=pg_catalog.to_regtype(object_row.result_type)
        AND pg_catalog.array_to_string(p.proconfig, ';')=object_row.function_config
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))=object_row.body_md5) THEN
      RAISE EXCEPTION 'Financial grant callable function contract differs: %', object_row.signature;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
    JOIN pg_catalog.pg_language language ON language.oid=p.prolang
    WHERE p.oid=pg_catalog.to_regprocedure('${SCHEMA}.recovery_api_key_workspace_matches(text,text)')
      AND owner.rolname='${MIGRATOR_ROLE}' AND language.lanname='plpgsql'
      AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
      AND NOT p.proretset AND p.prorettype='pg_catalog.bool'::pg_catalog.regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[])
    OR pg_catalog.has_function_privilege('${RUNTIME_ROLE}',
      pg_catalog.to_regprocedure('${SCHEMA}.recovery_api_key_workspace_matches(text,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'Financial grant API key lock helper security differs';
  END IF;
  FOR object_row IN SELECT signature, definer, function_path FROM (VALUES
      ('${SCHEMA}.enforce_request_log_workspace()', false,
        ARRAY['search_path=pg_catalog, cinatoken_gateway, pg_temp']::text[]),
      ('${SCHEMA}.guard_fact_owned_usage_log()', true,
        ARRAY['search_path=pg_catalog, pg_temp']::text[]),
      ('${SCHEMA}.guard_fact_without_legacy_log()', true,
        ARRAY['search_path=pg_catalog, pg_temp']::text[])
    ) AS required(signature, definer, function_path) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
      JOIN pg_catalog.pg_language language ON language.oid=p.prolang
      WHERE p.oid=pg_catalog.to_regprocedure(object_row.signature)
        AND owner.rolname='${MIGRATOR_ROLE}' AND language.lanname='plpgsql'
        AND p.prokind='f' AND p.prosecdef=object_row.definer
        AND p.provolatile='v' AND NOT p.proretset
        AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
        AND p.proconfig=object_row.function_path) THEN
      RAISE EXCEPTION 'Financial grant legacy guard function security differs: %', object_row.signature;
    END IF;
  END LOOP;
  FOR expected_trigger IN SELECT table_name, trigger_name, function_signature,
      trigger_type, is_deferrable, initially_deferred FROM (VALUES
      ${triggerRows}
    ) AS required(table_name, trigger_name, function_signature,
      trigger_type, is_deferrable, initially_deferred) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger trigger
      JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=relation.relnamespace
      WHERE n.nspname='${SCHEMA}' AND relation.relname=expected_trigger.table_name
        AND trigger.tgname=expected_trigger.trigger_name AND NOT trigger.tgisinternal
        AND trigger.tgenabled IN ('O','A')
        AND trigger.tgfoid=pg_catalog.to_regprocedure(expected_trigger.function_signature)
        AND trigger.tgtype=expected_trigger.trigger_type::smallint
        AND trigger.tgdeferrable=expected_trigger.is_deferrable::boolean
        AND trigger.tginitdeferred=expected_trigger.initially_deferred::boolean
        AND trigger.tgqual IS NULL
        AND (CASE WHEN expected_trigger.trigger_name='api_key_request_logs_replay_id_immutable'
          THEN trigger.tgattr::text=(SELECT a.attnum::text FROM pg_catalog.pg_attribute a
            WHERE a.attrelid=trigger.tgrelid AND a.attname='id' AND NOT a.attisdropped)
          ELSE pg_catalog.cardinality(trigger.tgattr)=0 END)
        AND trigger.tgnargs=0 AND trigger.tgoldtable IS NULL AND trigger.tgnewtable IS NULL) THEN
      RAISE EXCEPTION 'Financial grant trigger contract differs: %', expected_trigger.trigger_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid=trigger.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=relation.relnamespace
    WHERE n.nspname='${SCHEMA}' AND NOT trigger.tgisinternal
      AND relation.relname IN (SELECT DISTINCT table_name FROM (VALUES
        ${triggerRows}
      ) AS required(table_name, trigger_name, function_signature,
        trigger_type, is_deferrable, initially_deferred)))<>${triggers.length} THEN
    RAISE EXCEPTION 'Financial grant reviewed relation has an extra trigger';
  END IF;
  ${aclAudit(false, tableVerbRows, columnRows, functionRows)}
END;
$financial_grant_preflight$;
${grantSql}
DO $financial_grant_postflight$
DECLARE consumer_oid oid;
DECLARE object_row record;
DECLARE attribute_row record;
DECLARE privilege_name text;
DECLARE expected_privilege boolean;
BEGIN
  ${roleCheck}
  ${aclAudit(true, tableVerbRows, columnRows, functionRows)}
END;
$financial_grant_postflight$;
COMMIT;`;
  return Object.freeze({
    role, database, roleConnectionLimit: limit,
    verifierSha256: createHash('sha256').update(verifier).digest('hex'),
    adminSql, migratorSql, runtimeCompatible: false,
    activation: FINANCIAL_CONSUMER_GRANT_ACTIVATION,
    replayReservationPhase: replayGate ? 'parent-gated' : 'none',
  });
}
