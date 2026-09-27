// Opt-in local ACL regression. Starts only a new owned loopback cluster.
// The request-parent proposal remains outside formal migrations and production.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const parentTable = `${schema}.request_dispatch_requests`;
const parentFunctions = [
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
    max_lifetime: 0, backoff: 0, connection: { application_name: 'cinatoken-native-parent-runtime-grant' },
    onnotice() {} });
}

async function runtimePrivileges(sql) {
  const [row] = await sql.unsafe(`SELECT
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime', $1::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS parent_table,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime', $2::pg_catalog.regprocedure,
      'EXECUTE') AS prepare,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime', $3::pg_catalog.regprocedure,
      'EXECUTE') AS claim,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime', $4::pg_catalog.regprocedure,
      'EXECUTE') AS classify,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.users'::pg_catalog.regclass, 'SELECT') AS ordinary_users_select`,
  [parentTable, ...parentFunctions]);
  return row;
}

function assertParentClosed(row) {
  assert.deepEqual(row, { parent_table: false, prepare: false, claim: false,
    classify: false, ordinary_users_select: true });
}

function summary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 400) };
}

test('native runtime grant rerun cannot expose optional request-parent table or definers',
  { timeout: 240_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-parent-runtime-grant-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL; 73 formal migrations and three review-only proposals; ordinary runtime grant reruns',
      limitations: [
        'The parent proposal is installed before the ordinary runtime default grants; this does not prove a live old-schema activation path.',
        'No producer EXECUTE grant, Worker, Hyperdrive, origin or financial settlement is enabled.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let error;
    try {
      for (const [key, url] of [
        ['nativeTest', new URL(import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['migrationContract', new URL('../../ci/verify-postgres-migration-contract.mjs', import.meta.url)],
        ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
        ...proposals.map(([setting, url]) => [setting, url]),
      ]) report.sourceSha256[key] = sha256(await readFile(url));
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 180000 && server.version_num < 190000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;

      const password = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
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
      for (const [setting, url] of proposals) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
      }
      stage('formal-migrations-and-three-review-only-proposals', { formalMigrations: files.length });

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      assertParentClosed(await runtimePrivileges(admin));
      const runtimeSession = cluster.client('runtime-acl');
      await runtimeSession.unsafe('SET ROLE cinatoken_gateway_runtime');
      await assert.rejects(runtimeSession.unsafe(`SELECT * FROM ${parentTable}`),
        cause => cause.code === '42501');
      await assert.rejects(runtimeSession.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
        'invalid',1,'user','key','space','images.generations',repeat('a',64),repeat('b',64),
        0::bigint,'00000000-0000-4000-8000-000000000000')`),
        cause => cause.code === '42501');
      stage('first-broad-grant-keeps-parent-closed', { privilegeState: await runtimePrivileges(admin) });

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      assertParentClosed(await runtimePrivileges(admin));
      stage('second-broad-grant-remains-closed');

      await admin.unsafe('CREATE ROLE parent_acl_shadow NOLOGIN');
      await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${parentFunctions[1]} TO parent_acl_shadow`);
      await admin.unsafe('GRANT parent_acl_shadow TO cinatoken_gateway_runtime');
      assert.equal((await runtimePrivileges(admin)).claim, true);
      await assert.rejects(grantPostgresRuntime({ DATABASE_URL: migratorUrl }),
        /Ordinary runtime retains request parent privilege/);
      stage('inherited-execute-drift-rejected-transactionally');
      await admin.unsafe('REVOKE parent_acl_shadow FROM cinatoken_gateway_runtime');
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION ${parentFunctions[1]} FROM parent_acl_shadow`);
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      assertParentClosed(await runtimePrivileges(admin));
      stage('drift-removal-and-rerun-restore-closed-acl');

      for (const [key, url] of [
        ['nativeTest', new URL(import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
      ]) assert.equal(sha256(await readFile(url)), report.sourceSha256[key],
        `${key} changed during the native run`);
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
        console.log('Native parent runtime grant evidence: ' + reportFile);
        console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
          stages: report.stages.map(value => value.name) }, null, 2));
      }
    }
    if (error) throw error;
  });
