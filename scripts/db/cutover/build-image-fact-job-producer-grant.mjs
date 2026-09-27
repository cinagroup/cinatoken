// Review-only, default-disabled fact/outbox/job grant for the Images producer.
// Rendering this SQL does not connect to a database or activate an origin.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sources = [
  ['facts', new URL('../../../packages/core/migrations-postgres/0070_recovery_settlement_facts.sql', import.meta.url),
    'b45741ed725181e96c16c944f2d8f02bcd8c415c8046da6f36617844bd24e5e7'],
  ['jobs', new URL('../../../packages/core/migrations-postgres/0071_recovery_jobs.sql', import.meta.url),
    'a694e7d44fd93024603d09931ea2c3b03d4737a5933f3a3748c25b43e55e5cf2'],
  ['receipts', new URL('../../../packages/core/migrations-postgres/0072_recovery_commit_receipts.sql', import.meta.url),
    'f96d03a30f32faddbb3f8a3d652b78dbc7deef860461dea7f81f7317247e505d'],
  ['keyLock', new URL('../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql', import.meta.url),
    '07025d295d1cf672235c9d45cea77c4bbef8f3859199708206833d945345593b'],
  ['outboxDefiner', new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url),
    'c3995e07159d4fe0b2aac5ab96ee2d14e6e11fddc3bf9868d258d43620612f52'],
  ['legacyLogGuard', new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url),
    '24a601dbafd66f16cdd14dcc81017bc26199c6b833e311d389cdb07103010763'],
];

const schema = 'cinatoken_gateway';
const producer = 'cinatoken_gateway_fact_producer';
const tables = {
  request_usage_settlements: {
    select: ['request_id', 'attempt_index', 'user_id', 'api_key_id', 'workspace_id',
      'operation', 'context_sha256', 'dispatch_claim_id', 'payload_version',
      'payload_json', 'payload_sha256', 'recorded_at', 'created_at_ms'],
    insert: ['request_id', 'attempt_index', 'user_id', 'api_key_id', 'workspace_id',
      'operation', 'context_sha256', 'dispatch_claim_id', 'payload_version',
      'payload_json', 'payload_sha256', 'recorded_at'],
  },
  request_usage_settlement_outbox: {
    select: ['request_id', 'payload_sha256', 'created_at_ms'],
    insert: [],
  },
  request_usage_recovery_jobs: {
    select: ['request_id', 'payload_sha256', 'fact_created_at_ms', 'user_id',
      'workspace_id', 'state', 'revision', 'attempts', 'last_transition',
      'lease_token', 'lease_seconds', 'lease_expires_at_ms', 'available_at_ms',
      'last_error', 'created_at_ms', 'updated_at_ms'],
    insert: ['request_id', 'payload_sha256', 'fact_created_at_ms', 'user_id',
      'workspace_id'],
  },
};
const parentFunctions = [
  'prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)',
  'claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)',
  'classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)',
];

function bodyMd5(source, tag) {
  const match = [...source.matchAll(new RegExp(`AS \\\$${tag}\\\$([\\s\\S]*?)\\\$${tag}\\\$;`, 'gu'))];
  if (match.length !== 1) throw new Error(`Pinned ${tag} function body missing or ambiguous`);
  return createHash('md5').update(match[0][1].replaceAll('\r\n', '\n')).digest('hex');
}

function columns(table, privilege) {
  return tables[table][privilege].map(column => `('${table}','${column}','${privilege.toUpperCase()}')`);
}

function attnums(table, columnsList) {
  return `ARRAY(SELECT a.attnum FROM (VALUES ${columnsList.map((name, index) =>
    `(${index + 1},'${name}')`).join(',')}) AS expected(position,name)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid='${schema}.${table}'::pg_catalog.regclass
      AND a.attname=expected.name AND NOT a.attisdropped
    ORDER BY expected.position)`;
}

function fkCondition(name, from, fromColumns, to, toColumns, deferred = false) {
  return `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint fk
    WHERE fk.conrelid='${schema}.${from}'::pg_catalog.regclass
      AND fk.confrelid='${schema}.${to}'::pg_catalog.regclass
      ${name ? `AND fk.conname='${name}'` : ''}
      AND fk.contype='f' AND fk.convalidated
      AND fk.condeferrable=${deferred} AND fk.condeferred=${deferred}
      AND fk.confupdtype='a' AND fk.confdeltype='a' AND fk.confmatchtype='s'
      AND fk.conkey=${attnums(from, fromColumns)}
      AND fk.confkey=${attnums(to, toColumns)})`;
}

function aclChecks(required) {
  const allowedRows = Object.entries(tables).flatMap(([table, config]) =>
    ['select', 'insert'].flatMap(privilege => columns(table, privilege))).join(',\n      ');
  const expectedRows = Object.entries(tables).flatMap(([table, config]) =>
    ['select', 'insert'].flatMap(privilege =>
      config[privilege].map(column => `('${table}','${column}','${privilege.toUpperCase()}')`))).join(',\n      ');
  return `
  -- No table-level ACL: every permitted operation is limited to reviewed columns.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relname IN (
        'request_usage_settlements','request_usage_settlement_outbox','request_usage_recovery_jobs')
        AND (pg_catalog.has_table_privilege(producer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_table_privilege(runtime_oid,c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(runtime_oid,c.oid,
            'SELECT,INSERT,UPDATE,REFERENCES')
          OR pg_catalog.has_table_privilege(dispatch_oid,c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(dispatch_oid,c.oid,
            'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
    RAISE EXCEPTION 'Fact/job producer, dispatch producer or ordinary runtime table ACL differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relkind IN ('r','p','v','m','f')
        AND c.relname NOT IN (
          'request_usage_settlements','request_usage_settlement_outbox','request_usage_recovery_jobs')
        AND (pg_catalog.has_table_privilege(producer_oid,c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(producer_oid,c.oid,
            'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
    RAISE EXCEPTION 'Fact/job producer can access an unrelated gateway relation';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
        AND a.attnum>0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) AS operation(name)
      WHERE n.nspname='${schema}' AND c.relname IN (
        'request_usage_settlements','request_usage_settlement_outbox','request_usage_recovery_jobs')
        AND pg_catalog.has_column_privilege(producer_oid,c.oid,a.attname,operation.name)
        AND NOT EXISTS (SELECT 1 FROM (VALUES
      ${allowedRows}
        ) AS allowed(table_name,column_name,privilege)
          WHERE allowed.table_name=c.relname AND allowed.column_name=a.attname
            AND allowed.privilege=operation.name)) THEN
    RAISE EXCEPTION 'Fact/job producer has an unreviewed column privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a,
      LATERAL pg_catalog.aclexplode(a.attacl) acl
      WHERE a.attrelid IN (
        '${schema}.request_usage_settlements'::pg_catalog.regclass,
        '${schema}.request_usage_settlement_outbox'::pg_catalog.regclass,
        '${schema}.request_usage_recovery_jobs'::pg_catalog.regclass)
        AND a.attnum>0 AND NOT a.attisdropped AND acl.grantee=producer_oid
        AND (acl.is_grantable OR acl.grantor<>migrator_oid)) THEN
    RAISE EXCEPTION 'Fact/job producer column grant option or grantor differs';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='${schema}' AND p.prosecdef
        AND pg_catalog.has_function_privilege(producer_oid,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Fact/job producer can execute a gateway definer function';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
      ${parentFunctions.map(name => `('${schema}.${name}'::pg_catalog.regprocedure)`).join(',\n      ')}
    ) AS parent(oid)
    WHERE pg_catalog.has_function_privilege(producer_oid,parent.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Fact/job producer can execute request parent functions';
  END IF;
  ${required ? `IF NOT pg_catalog.has_schema_privilege(producer_oid,'${schema}','USAGE')
      OR pg_catalog.has_schema_privilege(producer_oid,'${schema}','CREATE')
      OR EXISTS (SELECT 1 FROM (VALUES
      ${expectedRows}
        ) AS required(table_name,column_name,privilege)
        WHERE NOT pg_catalog.has_column_privilege(producer_oid,
          ('${schema}.'||required.table_name)::pg_catalog.regclass,
          required.column_name,required.privilege)) THEN
    RAISE EXCEPTION 'Required fact/job producer column grants are missing';
  END IF;` : ''}`;
}

/**
 * A complete transactional SQL bundle. Activation is explicit, requires the
 * migrator role, and never alters the ordinary runtime or recovery roles.
 */
export async function buildImageFactJobProducerGrant({ activation } = {}) {
  if (!['reviewed-v1', 'reviewed-direct-login-v1'].includes(activation)) {
    throw new Error('Explicit reviewed-v1 or reviewed-direct-login-v1 Images fact/job producer grant is required');
  }
  const directLogin = activation === 'reviewed-direct-login-v1';
  const loginCheck = directLogin ? 'rolcanlogin' : 'NOT rolcanlogin';
  const bodies = Object.fromEntries(await Promise.all(sources.map(async ([name, url, sha256]) => {
    const value = await readFile(url, 'utf8');
    if (createHash('sha256').update(value).digest('hex') !== sha256) {
      throw new Error(`Reviewed ${name} source changed; review and repin the fact/job grant`);
    }
    return [name, value];
  })));
  const functions = [
    ['guard_usage_settlement_fact()', bodyMd5(bodies.facts, 'guard'), false],
    ['enqueue_usage_settlement_fact()', bodyMd5(bodies.outboxDefiner, 'enqueue'), true],
    ['reject_usage_settlement_mutation()', bodyMd5(bodies.facts, 'immutable'), false],
    ['guard_usage_recovery_job()', bodyMd5(bodies.receipts, 'guard'), false],
  ];
  const triggers = [
    ['request_usage_settlements', 'request_usage_settlements_guard', 7, 'guard_usage_settlement_fact()'],
    ['request_usage_settlements', 'request_usage_settlements_enqueue', 5, 'enqueue_usage_settlement_fact()'],
    ['request_usage_settlements', 'request_usage_settlements_immutable', 27, 'reject_usage_settlement_mutation()'],
    ['request_usage_settlement_outbox', 'request_usage_settlement_outbox_immutable', 27, 'reject_usage_settlement_mutation()'],
    ['request_usage_recovery_jobs', 'request_usage_recovery_guard', 31, 'guard_usage_recovery_job()'],
  ];
  const legacyGuardFunctionMd5 = bodyMd5(bodies.legacyLogGuard, 'fact');
  const fks = [
    fkCondition('request_usage_settlements_claim', 'request_usage_settlements',
      ['request_id','attempt_index','user_id','api_key_id','workspace_id','operation','context_sha256','dispatch_claim_id'],
      'request_dispatch_intents',
      ['request_id','attempt_index','user_id','api_key_id','workspace_id','operation','context_sha256','dispatch_claim_id']),
    fkCondition('request_usage_settlements_require_outbox', 'request_usage_settlements',
      ['request_id','payload_sha256','created_at_ms'], 'request_usage_settlement_outbox',
      ['request_id','payload_sha256','created_at_ms'], true),
    fkCondition('request_usage_settlement_outbox_fact', 'request_usage_settlement_outbox',
      ['request_id','payload_sha256','created_at_ms'], 'request_usage_settlements',
      ['request_id','payload_sha256','created_at_ms']),
    fkCondition(null, 'request_usage_recovery_jobs',
      ['request_id','payload_sha256','fact_created_at_ms','user_id','workspace_id'],
      'request_usage_settlements',
      ['request_id','payload_sha256','created_at_ms','user_id','workspace_id']),
  ];
  const grants = Object.entries(tables).flatMap(([table, config]) =>
    ['select','insert'].filter(verb => config[verb].length).map(verb =>
      `GRANT ${verb.toUpperCase()} (${config[verb].join(', ')})
  ON TABLE ${schema}.${table} TO ${producer};`)).join('\n');

  return `-- REVIEW ONLY. Exact-column Images fact/outbox/job producer role activation.
-- Requires installed pinned formal migrations and optional outbox definer.
-- Accepts the already-installed legacy-log guard only with its pinned function and trigger shape.
-- Requires pre-provisioned ${directLogin ? 'LOGIN' : 'NOLOGIN'}/NOINHERIT dispatch and fact roles.
-- No origin, credential, financial writer, parent claimant or automatic migration.
-- Run with stop-on-error; after any error ROLLBACK or close the connection.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL cinatoken.image_fact_job_producer_grant = '${activation}';
SELECT pg_catalog.pg_advisory_xact_lock(746923551);
SELECT pg_catalog.pg_advisory_xact_lock(746923553);
SELECT pg_catalog.pg_advisory_xact_lock(746923557);
LOCK TABLE ${schema}.request_usage_settlements,
  ${schema}.request_usage_settlement_outbox,
  ${schema}.request_usage_recovery_jobs IN SHARE ROW EXCLUSIVE MODE;

DO $image_fact_job_preflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE producer_oid oid;
DECLARE dispatch_oid oid;
DECLARE guard_present boolean;
DECLARE expected_trigger_count integer;
BEGIN
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO producer_oid FROM pg_catalog.pg_roles WHERE rolname='${producer}';
  SELECT oid INTO dispatch_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_dispatch_producer';
  IF CURRENT_USER<>'cinatoken_gateway_migrator'
      OR migrator_oid IS NULL OR runtime_oid IS NULL OR producer_oid IS NULL OR dispatch_oid IS NULL
      OR pg_catalog.current_setting('cinatoken.image_fact_job_producer_grant',true)
        IS DISTINCT FROM '${activation}'
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace
        WHERE nspname='${schema}' AND nspowner=migrator_oid)
      OR NOT EXISTS (SELECT 1 FROM ${schema}.schema_migrations
        WHERE version='0073_recovery_api_key_workspace_lock.sql') THEN
    RAISE EXCEPTION 'Images fact/job grant identity or migration differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=producer_oid AND ${loginCheck} AND NOT rolinherit
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE oid=dispatch_oid AND ${loginCheck} AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member IN (producer_oid,dispatch_oid)
          OR roleid IN (producer_oid,dispatch_oid))
      OR pg_catalog.pg_has_role(runtime_oid,migrator_oid,'MEMBER')
      OR pg_catalog.pg_has_role(runtime_oid,producer_oid,'MEMBER')
      OR pg_catalog.has_schema_privilege(producer_oid,'${schema}','CREATE') THEN
    RAISE EXCEPTION 'Images fact/job producer role separation differs';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
      ${Object.entries(tables).map(([table, config]) =>
        `('${table}','${config.select.join(',')}')`).join(',\n      ')}
    ) AS reviewed(table_name,column_names)
    JOIN pg_catalog.pg_class c ON c.oid=('${schema}.'||reviewed.table_name)::pg_catalog.regclass
    WHERE c.relkind<>'r' OR c.relowner<>migrator_oid
      OR c.relrowsecurity OR c.relforcerowsecurity
      OR (SELECT pg_catalog.string_agg(a.attname,',' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid
          AND a.attnum>0 AND NOT a.attisdropped)<>reviewed.column_names) THEN
    RAISE EXCEPTION 'Images fact/outbox/job relation or column contract differs';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES
      ${functions.map(([name, md5, definer]) =>
        `('${schema}.${name}'::pg_catalog.regprocedure,'${md5}',${definer})`).join(',\n      ')}
    ) AS reviewed(oid,body_md5,definer)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid=reviewed.oid
    LEFT JOIN pg_catalog.pg_language language ON language.oid=p.prolang
    WHERE p.oid IS NULL OR p.proowner<>migrator_oid OR language.lanname<>'plpgsql'
      OR p.prokind<>'f' OR p.prosecdef<>reviewed.definer
      OR p.provolatile<>'v' OR p.proretset
      OR p.prorettype<>'pg_catalog.trigger'::pg_catalog.regtype
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))
        IS DISTINCT FROM reviewed.body_md5) THEN
    RAISE EXCEPTION 'Images fact/outbox/job trigger function source differs';
  END IF;
  guard_present := pg_catalog.to_regprocedure('${schema}.guard_fact_without_legacy_log()') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid='${schema}.request_usage_settlements'::pg_catalog.regclass
        AND t.tgname='request_usage_settlements_legacy_log_fence' AND NOT t.tgisinternal);
  IF guard_present AND (
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_language language ON language.oid=p.prolang
        WHERE p.oid=pg_catalog.to_regprocedure('${schema}.guard_fact_without_legacy_log()')
          AND p.proowner=migrator_oid AND language.lanname='plpgsql'
          AND p.prokind='f' AND p.prosecdef AND p.provolatile='v'
          AND NOT p.proretset AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
          AND pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r\\n',E'\\n'))='${legacyGuardFunctionMd5}')
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid='${schema}.request_usage_settlements'::pg_catalog.regclass
          AND t.tgname='request_usage_settlements_legacy_log_fence'
          AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=7
          AND t.tgfoid=pg_catalog.to_regprocedure('${schema}.guard_fact_without_legacy_log()')
          AND NOT t.tgdeferrable AND NOT t.tginitdeferred
          AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr)=0
          AND t.tgnargs=0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
          AND t.tgconstraint=0)) THEN
    RAISE EXCEPTION 'Images legacy-log guard function or trigger differs';
  END IF;
  expected_trigger_count := 5;
  IF guard_present THEN expected_trigger_count := 6; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgrelid IN (
        '${schema}.request_usage_settlements'::pg_catalog.regclass,
        '${schema}.request_usage_settlement_outbox'::pg_catalog.regclass,
        '${schema}.request_usage_recovery_jobs'::pg_catalog.regclass))
        <> expected_trigger_count
      OR EXISTS (SELECT 1 FROM (VALUES
      ${triggers.map(([table, name, type, fn]) =>
        `('${table}','${name}',${type},'${schema}.${fn}'::pg_catalog.regprocedure)`).join(',\n      ')}
      ) AS reviewed(table_name,trigger_name,trigger_type,function_oid)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid=('${schema}.'||reviewed.table_name)::pg_catalog.regclass
          AND t.tgname=reviewed.trigger_name AND NOT t.tgisinternal
          AND t.tgenabled='O' AND t.tgtype=reviewed.trigger_type::smallint
          AND t.tgfoid=reviewed.function_oid
          AND NOT t.tgdeferrable AND NOT t.tginitdeferred
          AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr)=0
          AND t.tgnargs=0 AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
          AND t.tgconstraint=0)) THEN
    RAISE EXCEPTION 'Images fact/outbox/job trigger binding differs';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_constraint fk
      WHERE fk.contype='f' AND fk.conrelid IN (
        '${schema}.request_usage_settlements'::pg_catalog.regclass,
        '${schema}.request_usage_settlement_outbox'::pg_catalog.regclass,
        '${schema}.request_usage_recovery_jobs'::pg_catalog.regclass))<>4
      OR ${fks.join('\n      OR ')} THEN
    RAISE EXCEPTION 'Images fact/outbox/job foreign key contract differs';
  END IF;
  ${aclChecks(false)}
END;
$image_fact_job_preflight$;

GRANT USAGE ON SCHEMA ${schema} TO ${producer};
${grants}

DO $image_fact_job_postflight$
DECLARE migrator_oid oid;
DECLARE runtime_oid oid;
DECLARE producer_oid oid;
DECLARE dispatch_oid oid;
BEGIN
  SELECT oid INTO STRICT migrator_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_migrator';
  SELECT oid INTO STRICT runtime_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_runtime';
  SELECT oid INTO STRICT producer_oid FROM pg_catalog.pg_roles WHERE rolname='${producer}';
  SELECT oid INTO STRICT dispatch_oid FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_dispatch_producer';
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE oid=producer_oid AND ${loginCheck} AND NOT rolinherit
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
        WHERE oid=dispatch_oid AND ${loginCheck} AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member IN (producer_oid,dispatch_oid)
          OR roleid IN (producer_oid,dispatch_oid)) THEN
    RAISE EXCEPTION 'Images fact/job producer postflight role separation differs';
  END IF;
  ${aclChecks(true)}
END;
$image_fact_job_postflight$;
COMMIT;
`;
}
