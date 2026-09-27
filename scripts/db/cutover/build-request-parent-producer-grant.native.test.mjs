// Explicit local fixture. Never uses DATABASE_URL or an existing data directory.
// No production producer identity or automatic migration is activated.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { buildRequestParentProducerGrant } from './build-request-parent-producer-grant.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const producerRole = 'cinatoken_gateway_dispatch_producer';
const factRole = 'cinatoken_gateway_fact_producer';
const runtimeRole = 'cinatoken_gateway_runtime';
const parentTable = `${schema}.request_dispatch_requests`;
const intentTable = `${schema}.request_dispatch_intents`;
const functions = [
  `${schema}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)`,
  `${schema}.claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)`,
  `${schema}.classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)`,
];
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_parent_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url)],
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function localClient(cluster, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-parent-producer-grant' },
    onnotice() {} });
}

function producerClient(cluster, username, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-parent-direct-login' },
    onnotice() {} });
}

async function runBundle(sql, bundle) {
  try { await sql.unsafe(bundle).simple(); }
  catch (cause) {
    await sql.unsafe('ROLLBACK').simple();
    throw cause;
  }
}

async function privileges(sql) {
  const [row] = await sql.unsafe(`SELECT
    pg_catalog.has_schema_privilege($1::text, '${schema}', 'USAGE') AS producer_schema,
    pg_catalog.has_schema_privilege($1::text, '${schema}', 'CREATE') AS producer_schema_create,
    pg_catalog.has_table_privilege($1::text, $3::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS producer_parent_table,
    pg_catalog.has_any_column_privilege($1::text, $3::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS producer_parent_column,
    pg_catalog.has_table_privilege($1::text, $4::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS producer_intent_table,
    pg_catalog.has_any_column_privilege($1::text, $4::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS producer_intent_column,
    pg_catalog.has_table_privilege($1::text,
      '${schema}.api_keys'::pg_catalog.regclass, 'SELECT, INSERT, UPDATE, DELETE') AS producer_key_table,
    pg_catalog.has_any_column_privilege($1::text,
      '${schema}.api_keys'::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS producer_key_column,
    pg_catalog.has_function_privilege($1::text,
      '${schema}.guard_request_dispatch_intent()'::pg_catalog.regprocedure,
      'EXECUTE') AS producer_guard_execute,
    pg_catalog.has_function_privilege($1::text, $5::pg_catalog.regprocedure, 'EXECUTE') AS producer_prepare,
    pg_catalog.has_function_privilege($1::text, $6::pg_catalog.regprocedure, 'EXECUTE') AS producer_claim,
    pg_catalog.has_function_privilege($1::text, $7::pg_catalog.regprocedure, 'EXECUTE') AS producer_classify,
    pg_catalog.has_table_privilege($2::text, $3::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS runtime_parent_table,
    pg_catalog.has_any_column_privilege($2::text, $3::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS runtime_parent_column,
    pg_catalog.has_function_privilege($2::text, $5::pg_catalog.regprocedure, 'EXECUTE') AS runtime_prepare,
    pg_catalog.has_function_privilege($2::text, $6::pg_catalog.regprocedure, 'EXECUTE') AS runtime_claim,
    pg_catalog.has_function_privilege($2::text, $7::pg_catalog.regprocedure, 'EXECUTE') AS runtime_classify,
    pg_catalog.has_function_privilege($8::text, $5::pg_catalog.regprocedure, 'EXECUTE') AS fact_prepare,
    pg_catalog.has_function_privilege($8::text, $6::pg_catalog.regprocedure, 'EXECUTE') AS fact_claim,
    pg_catalog.has_function_privilege($8::text, $7::pg_catalog.regprocedure, 'EXECUTE') AS fact_classify,
    pg_catalog.has_table_privilege($8::text, $3::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS fact_parent_table,
    pg_catalog.has_any_column_privilege($8::text, $3::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS fact_parent_column,
    pg_catalog.has_table_privilege($8::text, $4::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS fact_intent_table,
    pg_catalog.has_any_column_privilege($8::text, $4::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS fact_intent_column,
    pg_catalog.has_table_privilege($8::text,
      '${schema}.api_keys'::pg_catalog.regclass, 'SELECT, INSERT, UPDATE, DELETE') AS fact_key_table,
    pg_catalog.has_any_column_privilege($8::text,
      '${schema}.api_keys'::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, REFERENCES') AS fact_key_column`,
  [producerRole, runtimeRole, parentTable, intentTable, ...functions, factRole]);
  return row;
}

function summary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 500) };
}

test('request parent producer grant is default-disabled and pins reviewed source', async () => {
  await assert.rejects(buildRequestParentProducerGrant(), /Explicit reviewed-v1/);
  await assert.rejects(buildRequestParentProducerGrant({ activation: 'enabled' }),
    /Explicit reviewed-v1/);
  const bundle = await buildRequestParentProducerGrant({ activation: 'reviewed-v1' });
  assert.match(bundle, /^-- REVIEW ONLY/);
  assert.match(bundle, /\nBEGIN;\n/);
  assert.match(bundle, /\nCOMMIT;\n$/);
  assert.equal((bundle.match(/\nGRANT EXECUTE ON FUNCTION /g) ?? []).length, 3);
  assert.match(bundle, /TO cinatoken_gateway_dispatch_producer;/);
  assert.doesNotMatch(bundle, /TO cinatoken_gateway_fact_producer;/);
  assert.doesNotMatch(bundle, /\nGRANT (?:INSERT|UPDATE|DELETE|SELECT) ON TABLE /);
  assert.match(bundle, /Ordinary runtime postflight can access request parent table/);
  const direct = await buildRequestParentProducerGrant({ activation: 'reviewed-direct-login-v1' });
  assert.match(direct, /SET LOCAL cinatoken.request_dispatch_parent_producer_grant = 'reviewed-direct-login-v1'/);
  assert.match(direct, /WHERE oid = dispatch_oid AND rolcanlogin AND NOT rolinherit/);
  assert.doesNotMatch(direct, /PASSWORD|ALTER ROLE|CREATE ROLE/);
});

test('native parent producer grant permits only pinned definer calls and rejects privilege drift',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-parent-producer-grant-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18; 73 formal migrations; three review-only proposals; separate synthetic NOLOGIN dispatch and fact roles',
      limitations: [
        'The generated grant remains outside formal migrations and any production entry point.',
        'The NOLOGIN roles are exercised through local superuser SET ROLE sessions; no distinct production credential or network identity is proven.',
        'Function ACL tests do not prove a real origin, financial settlement, legacy-row upgrade, or full C03.5 identity separation.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let error;
    try {
      const sourceFiles = [
        ['generator', new URL('./build-request-parent-producer-grant.mjs', import.meta.url)],
        ['nativeTest', new URL(import.meta.url)],
        ['parentActivation', new URL('./build-request-parent-default-acl-activation.mjs', import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ...proposals.map(([setting, url]) => [setting, url]),
      ];
      for (const [key, url] of sourceFiles) report.sourceSha256[key] = sha256(await readFile(url));
      const [server] = await cluster.admin.unsafe(`SELECT
        current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 180000 && server.version_num < 190000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;

      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE ${runtimeRole} NOLOGIN;
        CREATE ROLE ${producerRole} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        CREATE ROLE ${factRole} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        CREATE ROLE parent_producer_shadow NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = localClient(cluster, password);
      clients.push(migrator);
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres`;
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha256(corpus.join('\n'));
      for (const [setting, url] of proposals.slice(0, 2)) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
      }
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await runBundle(migrator,
        await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' }));
      stage('parent-installed-with-runtime-default-acl', { formalMigrations: files.length });

      const producer = cluster.client('parent-producer-role');
      await producer.unsafe(`SET ROLE ${producerRole}`);
      assert.equal((await producer.unsafe('SELECT current_user AS role'))[0].role, producerRole);
      const fact = cluster.client('parent-fact-role');
      await fact.unsafe(`SET ROLE ${factRole}`);
      assert.equal((await fact.unsafe('SELECT current_user AS role'))[0].role, factRole);
      const requestId = `producer-${randomUUID()}`;
      const args = [requestId, 1, 'parent-user', 'parent-key', 'parent-space',
        'images.generations', 'a'.repeat(64), 'b'.repeat(64)];
      const prepareSql = `SELECT ${schema}.prepare_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10) AS value`;
      let expiry = Number((await cluster.admin.unsafe(`SELECT
        (floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 120000)::text AS expiry`))[0].expiry);
      await assert.rejects(producer.unsafe(prepareSql, [...args, expiry, 1]),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(prepareSql, [...args, expiry, 1]),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,0::bigint,$9) AS value`, [...args, randomUUID()]),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(`SELECT ${schema}.classify_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,1::bigint) AS value`, args),
        cause => cause.code === '42501');
      assert.equal((await cluster.admin.unsafe(`SELECT count(*)::int AS n FROM ${parentTable}`))[0].n, 0);
      stage('dispatch-and-fact-cannot-call-parent-before-explicit-grant');

      const grant = await buildRequestParentProducerGrant({ activation: 'reviewed-v1' });
      await cluster.admin.unsafe(`GRANT parent_producer_shadow TO ${producerRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer role separation differs/);
      await cluster.admin.unsafe(`REVOKE parent_producer_shadow FROM ${producerRole}`);
      assert.equal((await privileges(cluster.admin)).producer_prepare, false);
      stage('unexpected-role-membership-rejects-entire-grant');

      await migrator.unsafe(`GRANT SELECT ON TABLE ${parentTable} TO ${producerRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer has direct parent or intent privilege/);
      await migrator.unsafe(`REVOKE SELECT ON TABLE ${parentTable} FROM ${producerRole}`);
      assert.equal((await privileges(cluster.admin)).producer_prepare, false);
      stage('direct-parent-table-grant-rejected-before-function-grant');

      await migrator.unsafe(`GRANT SELECT (request_id) ON TABLE ${parentTable} TO ${producerRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer has direct parent or intent privilege/);
      await migrator.unsafe(`REVOKE SELECT (request_id) ON TABLE ${parentTable} FROM ${producerRole}`);
      assert.equal((await privileges(cluster.admin)).producer_parent_column, false);
      stage('dispatch-parent-column-grant-rejected-before-function-grant');

      await migrator.unsafe(`GRANT SELECT (request_id) ON TABLE ${parentTable} TO ${factRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer has direct parent or intent privilege/);
      await migrator.unsafe(`REVOKE SELECT (request_id) ON TABLE ${parentTable} FROM ${factRole}`);
      assert.equal((await privileges(cluster.admin)).fact_parent_column, false);
      stage('fact-parent-column-grant-rejected-before-function-grant');

      await migrator.unsafe(`GRANT SELECT ON TABLE ${schema}.api_keys TO ${producerRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer has schema, Key or trigger privilege/);
      await migrator.unsafe(`REVOKE SELECT ON TABLE ${schema}.api_keys FROM ${producerRole}`);
      assert.equal((await privileges(cluster.admin)).producer_prepare, false);
      stage('direct-key-read-drift-rejected-before-function-grant');

      await migrator.unsafe(`GRANT SELECT (id) ON TABLE ${schema}.api_keys TO ${factRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer has schema, Key or trigger privilege/);
      await migrator.unsafe(`REVOKE SELECT (id) ON TABLE ${schema}.api_keys FROM ${factRole}`);
      assert.equal((await privileges(cluster.admin)).fact_key_column, false);
      stage('fact-key-column-drift-rejected-before-function-grant');

      const runtime = cluster.client('parent-runtime-column');
      await runtime.unsafe(`SET ROLE ${runtimeRole}`);
      async function assertRuntimeColumnDrift() {
        const access = await privileges(cluster.admin);
        assert.equal(access.runtime_parent_table, false);
        assert.equal(access.runtime_parent_column, true);
        await runtime.unsafe(`SELECT request_id FROM ${parentTable} LIMIT 1`);
        await assert.rejects(runBundle(migrator, grant),
          /Ordinary runtime can access request parent table/);
        assert.equal((await privileges(cluster.admin)).producer_prepare, false);
      }
      await migrator.unsafe(`GRANT SELECT (request_id) ON TABLE ${parentTable} TO ${runtimeRole}`);
      await assertRuntimeColumnDrift();
      await migrator.unsafe(`REVOKE SELECT (request_id) ON TABLE ${parentTable} FROM ${runtimeRole}`);
      assert.equal((await privileges(cluster.admin)).runtime_parent_column, false);
      stage('direct-runtime-parent-column-grant-rejected');

      await migrator.unsafe(`GRANT SELECT (request_id) ON TABLE ${parentTable} TO parent_producer_shadow`);
      await cluster.admin.unsafe(`GRANT parent_producer_shadow TO ${runtimeRole}`);
      await assertRuntimeColumnDrift();
      await cluster.admin.unsafe(`REVOKE parent_producer_shadow FROM ${runtimeRole}`);
      await migrator.unsafe(`REVOKE SELECT (request_id) ON TABLE ${parentTable} FROM parent_producer_shadow`);
      assert.equal((await privileges(cluster.admin)).runtime_parent_column, false);
      stage('inherited-runtime-parent-column-grant-rejected');

      await migrator.unsafe(`GRANT SELECT (request_id) ON TABLE ${parentTable} TO PUBLIC`);
      await assertRuntimeColumnDrift();
      await migrator.unsafe(`REVOKE SELECT (request_id) ON TABLE ${parentTable} FROM PUBLIC`);
      assert.equal((await privileges(cluster.admin)).runtime_parent_column, false);
      stage('public-parent-column-grant-rejected');

      await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${functions[0]} TO ${runtimeRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent function source or ACL differs/);
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION ${functions[0]} FROM ${runtimeRole}`);
      assert.equal((await privileges(cluster.admin)).producer_prepare, false);
      stage('ordinary-runtime-function-drift-rejected');

      await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${functions[0]} TO ${factRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent function source or ACL differs/);
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION ${functions[0]} FROM ${factRole}`);
      assert.equal((await privileges(cluster.admin)).fact_prepare, false);
      stage('fact-function-drift-rejected');

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
        VALUES ('parent-user','parent-producer@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('parent-space','personal','parent-user','Parent Producer','parent-producer','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('parent-key','parent-producer-key','parent-user','parent-space');`).simple();
      await runBundle(migrator, grant);
      const expected = { producer_schema: true, producer_schema_create: false,
        producer_parent_table: false,
        producer_parent_column: false, producer_intent_table: false,
        producer_intent_column: false, producer_key_table: false,
        producer_key_column: false, producer_guard_execute: false,
        producer_prepare: true, producer_claim: true, producer_classify: true,
        runtime_parent_table: false, runtime_parent_column: false,
        runtime_prepare: false,
        runtime_claim: false, runtime_classify: false,
        fact_prepare: false, fact_claim: false, fact_classify: false,
        fact_parent_table: false, fact_parent_column: false,
        fact_intent_table: false, fact_intent_column: false,
        fact_key_table: false, fact_key_column: false };
      assert.deepEqual(await privileges(cluster.admin), expected);
      await assert.rejects(producer.unsafe(`SELECT * FROM ${parentTable}`), cause => cause.code === '42501');
      await assert.rejects(producer.unsafe(`UPDATE ${parentTable} SET claim_count=1 WHERE request_id=$1`, [requestId]),
        cause => cause.code === '42501');
      await assert.rejects(producer.unsafe(`INSERT INTO ${intentTable} (request_id) VALUES ($1)`, [requestId]),
        cause => cause.code === '42501');
      await assert.rejects(producer.unsafe(`SELECT id FROM ${schema}.api_keys LIMIT 1`),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(prepareSql, [...args, expiry, 1]),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(`SELECT * FROM ${parentTable}`),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(`INSERT INTO ${intentTable} (request_id) VALUES ($1)`, [requestId]),
        cause => cause.code === '42501');
      await assert.rejects(fact.unsafe(`SELECT id FROM ${schema}.api_keys LIMIT 1`),
        cause => cause.code === '42501');
      await assert.rejects(runtime.unsafe(prepareSql, [...args, expiry, 1]),
        cause => cause.code === '42501');
      await assert.rejects(runtime.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,0::bigint,$9) AS value`, [...args, randomUUID()]),
        cause => cause.code === '42501');
      await assert.rejects(runtime.unsafe(`SELECT ${schema}.classify_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,1::bigint) AS value`, args),
        cause => cause.code === '42501');
      const [membership] = await cluster.admin.unsafe(`SELECT
        pg_catalog.pg_has_role('${producerRole}'::pg_catalog.regrole,
          'cinatoken_gateway_migrator'::pg_catalog.regrole, 'MEMBER') AS migrator,
        pg_catalog.pg_has_role('${producerRole}'::pg_catalog.regrole,
          '${runtimeRole}'::pg_catalog.regrole, 'MEMBER') AS runtime`);
      assert.deepEqual(membership, { migrator: false, runtime: false });
      assert.equal((await producer.unsafe('SELECT current_user AS role'))[0].role, producerRole);
      assert.equal((await fact.unsafe('SELECT current_user AS role'))[0].role, factRole);
      stage('effective-dispatch-only-functions-and-fact-runtime-direct-denials', { privilegeState: expected });

      expiry = Number((await cluster.admin.unsafe(`SELECT
        (floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 5000)::text AS expiry`))[0].expiry);
      const [prepared] = await producer.unsafe(prepareSql, [...args, expiry, 1]);
      assert.equal(prepared.value, true);
      const claimId = randomUUID();
      const [claimed] = await producer.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,0::bigint,$9) AS value`, [...args, claimId]);
      assert.equal(claimed.value, true);
      const [earlyClassification] = await producer.unsafe(`SELECT ${schema}.classify_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,1::bigint) AS value`, args);
      assert.equal(earlyClassification.value, false);
      const [wait] = await cluster.admin.unsafe(`SELECT GREATEST(0,
        ($1::bigint - floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 100)
          / 1000.0)::double precision AS seconds`, [expiry]);
      await cluster.admin.unsafe('SELECT pg_catalog.pg_sleep($1)', [wait.seconds]);
      const [classified] = await producer.unsafe(`SELECT ${schema}.classify_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,1::bigint) AS value`, args);
      assert.equal(classified.value, true);
      const [state] = await cluster.admin.unsafe(`SELECT parent.claim_count,
        parent.prepared_count, intent.state, intent.dispatch_claim_id
        FROM ${parentTable} parent JOIN ${intentTable} intent USING (request_id)
        WHERE parent.request_id=$1`, [requestId]);
      assert.deepEqual(state, { claim_count: 1, prepared_count: 1,
        state: 'outcome_unknown', dispatch_claim_id: claimId });
      stage('dispatch-prepares-claims-and-classifies-only-through-definers', { state });

      await runBundle(migrator, grant);
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      assert.deepEqual(await privileges(cluster.admin), expected);
      stage('producer-grant-idempotent-and-runtime-rerun-keeps-role-separation');

      await cluster.admin.unsafe(`GRANT ${runtimeRole} TO ${producerRole}`);
      await assert.rejects(runBundle(migrator, grant),
        /Request parent producer role separation differs/);
      await cluster.admin.unsafe(`REVOKE ${runtimeRole} FROM ${producerRole}`);
      assert.deepEqual(await privileges(cluster.admin), expected);
      stage('post-activation-inherited-runtime-drift-rejected');

      for (const [key, url] of sourceFiles) {
        assert.equal(sha256(await readFile(url)), report.sourceSha256[key],
          `${key} changed during the native run`);
      }
      report.status = 'PASS';
    } catch (cause) {
      error = cause;
      report.status = 'FAIL'; report.fatal = summary(cause);
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (cause) { report.cleanup = 'FAIL'; report.cleanupError = summary(cause); error ??= cause; }
      if (report.status === 'PASS' && report.cleanup === 'PASS') {
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        console.log('Native parent producer grant evidence: ' + reportFile);
        console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
          stages: report.stages.map(value => value.name) }, null, 2));
      }
    }
    if (error) throw error;
  });

test('native direct LOGIN dispatch producer uses its own password identity and cannot cross roles',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async t => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-parent-direct-login-grant-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18 SCRAM password-authenticated dispatch and fact LOGIN roles',
      limitations: [
        'This fixture proves local role authentication and ACL separation, not a production origin or credential rotation.',
        'The reviewed SQL remains default-disabled and outside formal migrations.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let completed = false;
    t.after(async () => {
      try {
        await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
        await cluster.cleanup();
        report.cleanup = 'PASS';
      } catch (error) {
        report.cleanup = 'FAIL';
        report.cleanupError = summary(error);
        throw error;
      } finally {
        report.status = completed && report.cleanup === 'PASS' ? 'PASS' : 'FAIL';
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        t.diagnostic('Native direct LOGIN evidence: ' + reportFile);
      }
    });
    for (const [key, url] of [
      ['generator', new URL('./build-request-parent-producer-grant.mjs', import.meta.url)],
      ['nativeTest', new URL(import.meta.url)],
      ['defaultAcl', new URL('./build-request-parent-default-acl-activation.mjs', import.meta.url)],
      ...proposals,
    ]) report.sourceSha256[key] = sha256(await readFile(url));
    const [server] = await cluster.admin.unsafe(`SELECT
      current_setting('server_version_num')::int AS version_num,
      current_setting('listen_addresses') AS listen_addresses`);
    assert.ok(server.version_num >= 180000 && server.version_num < 190000);
    assert.equal(server.listen_addresses, '127.0.0.1');
    report.serverVersionNum = server.version_num;
    const migratorPassword = randomBytes(32).toString('hex');
    const dispatchPassword = randomBytes(32).toString('hex');
    const factPassword = randomBytes(32).toString('hex');
    await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
      CREATE ROLE ${runtimeRole} NOLOGIN;
      CREATE ROLE ${producerRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${dispatchPassword}';
      CREATE ROLE ${factRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
        NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${factPassword}';
      CREATE ROLE parent_direct_shadow NOLOGIN;
      CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, ${producerRole}, ${factRole};`).simple();
    const migrator = localClient(cluster, migratorPassword);
    const dispatch = producerClient(cluster, producerRole, dispatchPassword);
    const fact = producerClient(cluster, factRole, factPassword);
    clients.push(migrator, dispatch, fact);
    const wrong = producerClient(cluster, producerRole, factPassword);
    clients.push(wrong);
    await assert.rejects(wrong.unsafe('SELECT 1'), error => error.code === '28P01');
    const identities = await Promise.all([dispatch, fact].map(async sql => {
      const [identity] = await sql.unsafe(`SELECT session_user, current_user,
        pg_catalog.host(inet_client_addr()) AS client_address`);
      assert.equal(identity.session_user, identity.current_user);
      assert.equal(identity.client_address, '127.0.0.1');
      return identity.session_user;
    }));
    assert.deepEqual(identities, [producerRole, factRole]);
    await assert.rejects(dispatch.unsafe(`SET ROLE ${factRole}`), error => error.code === '42501');
    await assert.rejects(fact.unsafe(`SET ROLE ${producerRole}`), error => error.code === '42501');
    stage('separate-scram-identities-and-cross-role-set-denied', { identities });

    const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
    await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
    assert.equal(files.length, 73);
    for (const name of files) {
      const body = await readFile(new URL(name, migrations), 'utf8');
      await migrator.begin(async tx => {
        await tx.unsafe(body).simple();
        await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
      });
    }
    for (const [setting, url] of proposals.slice(0, 2)) {
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
        await tx.unsafe(await readFile(url, 'utf8')).simple();
      });
    }
    await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
    await runBundle(migrator,
      await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' }));
    stage('pinned-migrations-and-parent-installed', { count: files.length });

    const directGrant = await buildRequestParentProducerGrant({ activation: 'reviewed-direct-login-v1' });
    const noLoginGrant = await buildRequestParentProducerGrant({ activation: 'reviewed-v1' });
    const initial = await privileges(cluster.admin);
    assert.equal(initial.producer_prepare, false);
    await assert.rejects(runBundle(migrator, noLoginGrant), /role separation differs/);
    await cluster.admin.unsafe(`ALTER ROLE ${factRole} NOLOGIN`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`ALTER ROLE ${factRole} LOGIN`);
    await cluster.admin.unsafe(`ALTER ROLE ${producerRole} INHERIT`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`ALTER ROLE ${producerRole} NOINHERIT`);
    await cluster.admin.unsafe(`GRANT parent_direct_shadow TO ${factRole}`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`REVOKE parent_direct_shadow FROM ${factRole}`);
    await cluster.admin.unsafe(`GRANT ${producerRole} TO parent_direct_shadow`);
    await assert.rejects(runBundle(migrator, directGrant), /role separation differs/);
    await cluster.admin.unsafe(`REVOKE ${producerRole} FROM parent_direct_shadow`);
    assert.deepEqual(await privileges(cluster.admin), initial);
    stage('wrong-mode-property-and-membership-refuse-atomically');

    await migrator.unsafe(`GRANT SELECT (payload_json) ON TABLE
      ${schema}.request_usage_settlements TO ${producerRole}`);
    await assert.rejects(runBundle(migrator, directGrant),
      /Dispatch producer can access an unreviewed gateway relation/);
    await migrator.unsafe(`REVOKE SELECT (payload_json) ON TABLE
      ${schema}.request_usage_settlements FROM ${producerRole}`);
    await migrator.unsafe(`CREATE FUNCTION ${schema}.parent_direct_unreviewed_probe()
      RETURNS integer LANGUAGE sql SECURITY DEFINER
      SET search_path TO pg_catalog AS 'SELECT 1';
      REVOKE ALL ON FUNCTION ${schema}.parent_direct_unreviewed_probe() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${schema}.parent_direct_unreviewed_probe()
        TO ${producerRole};`).simple();
    await assert.rejects(runBundle(migrator, directGrant),
      /Dispatch producer can execute an unreviewed gateway definer/);
    await migrator.unsafe(`DROP FUNCTION ${schema}.parent_direct_unreviewed_probe()`);
    assert.deepEqual(await privileges(cluster.admin), initial);
    stage('unreviewed-relation-and-definer-access-refuse-atomically');

    await runBundle(migrator, directGrant);
    await runBundle(migrator, directGrant);
    const after = await privileges(cluster.admin);
    assert.equal(after.producer_prepare, true);
    assert.equal(after.producer_claim, true);
    assert.equal(after.producer_classify, true);
    assert.equal(after.fact_prepare, false);
    assert.equal(after.fact_claim, false);
    assert.equal(after.fact_classify, false);
    assert.equal(after.producer_parent_column, false);
    assert.equal(after.producer_intent_column, false);
    assert.equal(after.producer_key_column, false);
    assert.equal(after.runtime_prepare, false);
    const requestId = `parent-direct-${randomUUID()}`;
    await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
      VALUES ('parent-direct-user','parent-direct@example.invalid',10,0);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('parent-direct-space','personal','parent-direct-user','Parent Direct','parent-direct','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
      VALUES ('parent-direct-key','parent-direct-key-value','parent-direct-user','parent-direct-space');`).simple();
    const args = [requestId, 1, 'parent-direct-user', 'parent-direct-key', 'parent-direct-space',
      'images.generations', 'a'.repeat(64), 'b'.repeat(64)];
    const [clock] = await cluster.admin.unsafe(`SELECT
      (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+120000)::text AS deadline`);
    const prepareSql = `SELECT ${schema}.prepare_request_dispatch_intent_v1(
      $1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10) AS value`;
    await assert.rejects(fact.unsafe(prepareSql, [...args, Number(clock.deadline), 1]),
      error => error.code === '42501');
    const [prepared] = await dispatch.unsafe(prepareSql, [...args, Number(clock.deadline), 1]);
    assert.equal(prepared.value, true);
    await assert.rejects(dispatch.unsafe(`SELECT request_id FROM ${parentTable}`),
      error => error.code === '42501');
    await assert.rejects(dispatch.unsafe(`SELECT request_id FROM ${schema}.request_usage_settlements`),
      error => error.code === '42501');
    await assert.rejects(fact.unsafe(`SELECT request_id FROM ${parentTable}`),
      error => error.code === '42501');
    assert.deepEqual(await privileges(cluster.admin), after);
    stage('password-authenticated-dispatch-definer-only-and-idempotent',
      { sessionUser: producerRole, factDeniedParent: true, dispatchDeniedFact: true });
    completed = true;
  });
