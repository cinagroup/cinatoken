// Explicit local PostgreSQL fixture. Never connects to DATABASE_URL or an
// existing data directory; the proposal and activation remain review-only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const definerProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const oneClaimProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url);
const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const parentTable = `${schema}.request_dispatch_requests`;
const intentTable = `${schema}.request_dispatch_intents`;
const parentFunctions = [
  `${schema}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)`,
  `${schema}.claim_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,text)`,
  `${schema}.classify_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint)`,
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function localClient(cluster, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-parent-default-acl' },
    onnotice() {} });
}

async function defaultAcl(sql) {
  return sql.unsafe(`SELECT defaclnamespace::text AS namespace, defaclobjtype AS type,
      defaclacl::text AS acl
    FROM pg_catalog.pg_default_acl
    WHERE defaclrole = 'cinatoken_gateway_migrator'::pg_catalog.regrole
    ORDER BY defaclnamespace, defaclobjtype`);
}

async function parentExists(sql) {
  return (await sql.unsafe('SELECT pg_catalog.to_regclass($1) AS rel', [parentTable]))[0].rel !== null;
}

async function runBundle(sql, bundle) {
  try {
    await sql.unsafe(bundle).simple();
  } catch (cause) {
    // A multi-statement BEGIN bundle leaves a session in failed transaction
    // state after a statement error. The caller must explicitly roll it back.
    await sql.unsafe('ROLLBACK').simple();
    throw cause;
  }
}

async function parentAccess(sql) {
  const [row] = await sql.unsafe(`SELECT
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime', $1::pg_catalog.regclass,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS parent_table,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime', $2::pg_catalog.regclass,
      'INSERT, UPDATE, DELETE, TRUNCATE') AS intent_write,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime', $3::pg_catalog.regprocedure,
      'EXECUTE') AS prepare,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime', $4::pg_catalog.regprocedure,
      'EXECUTE') AS claim,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime', $5::pg_catalog.regprocedure,
      'EXECUTE') AS classify,
    pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
      '${schema}.users'::pg_catalog.regclass, 'SELECT') AS ordinary_select`,
  [parentTable, intentTable, ...parentFunctions]);
  return row;
}

function errorSummary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 500) };
}

test('request parent ACL bundle is default-disabled and pins the reviewed proposal', async () => {
  await assert.rejects(buildRequestParentDefaultAclActivation(), /Explicit reviewed-v1/);
  await assert.rejects(buildRequestParentDefaultAclActivation({ activation: 'enabled' }),
    /Explicit reviewed-v1/);
  const bundle = await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' });
  assert.match(bundle, /^-- REVIEW ONLY/);
  assert.match(bundle, /\nBEGIN;\n/);
  assert.match(bundle, /\nCOMMIT;\n$/);
  assert.equal((bundle.match(/\nCOMMIT;\n/g) ?? []).length, 1);
  assert.match(bundle, /Request parent default ACL restoration differs/);
});

test('native parent activation preserves runtime defaults and rolls back on preflight failure',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-parent-default-acl-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18; 73 formal migrations; three review-only proposals; actual runtime grant defaults',
      limitations: [
        'The activation is generated but never put in formal migrations or a production entry point.',
        'Only the exact known migrator/schema table SELECT and function EXECUTE defaults are admitted; other ACL layouts require separate review.',
        'Synthetic empty-schema fixture does not establish maintenance-window lock duration, old-row backfill, production identity, or external origin behavior.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let error;
    try {
      const sourceFiles = [
        ['generator', new URL('./build-request-parent-default-acl-activation.mjs', import.meta.url)],
        ['nativeTest', new URL(import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['definerProposal', definerProposal], ['singleClaimProposal', oneClaimProposal],
        ['parentProposal', parentProposal],
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
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE ROLE default_acl_shadow NOLOGIN;
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
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(definerProposal, 'utf8')).simple();
      });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(oneClaimProposal, 'utf8')).simple();
      });
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      const initialAcl = await defaultAcl(cluster.admin);
      assert.equal(initialAcl.filter(row => row.type === 'r' || row.type === 'f').length, 2);
      assert.match(initialAcl.find(row => row.type === 'r').acl, /cinatoken_gateway_runtime=r/);
      assert.match(initialAcl.find(row => row.type === 'f').acl, /cinatoken_gateway_runtime=X/);
      stage('actual-runtime-default-acl-installed', { formalMigrations: files.length,
        defaultAcl: initialAcl });

      const parentSql = await readFile(parentProposal, 'utf8');
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1'");
        await tx.unsafe(parentSql).simple();
      }), /New request parent table ACL exposes a nonowner/);
      assert.equal(await parentExists(cluster.admin), false);
      assert.deepEqual(await defaultAcl(cluster.admin), initialAcl);
      stage('plain-parent-proposal-rejects-copied-default-grant-atomically');

      const bundle = await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' });
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        GRANT EXECUTE ON FUNCTIONS TO default_acl_shadow`);
      const driftAcl = await defaultAcl(cluster.admin);
      await assert.rejects(runBundle(migrator, bundle),
        /Request parent default ACL differs from reviewed runtime grants/);
      assert.equal(await parentExists(cluster.admin), false);
      assert.deepEqual(await defaultAcl(cluster.admin), driftAcl);
      stage('unknown-schema-default-grant-fails-closed-without-mutation');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
        REVOKE EXECUTE ON FUNCTIONS FROM default_acl_shadow`);
      assert.deepEqual(await defaultAcl(cluster.admin), initialAcl);

      await migrator.unsafe('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO default_acl_shadow');
      const globalDriftAcl = await defaultAcl(cluster.admin);
      await assert.rejects(runBundle(migrator, bundle),
        /Request parent default ACL differs from reviewed runtime grants/);
      assert.equal(await parentExists(cluster.admin), false);
      assert.deepEqual(await defaultAcl(cluster.admin), globalDriftAcl);
      stage('unknown-global-default-grant-fails-closed-without-mutation');
      await migrator.unsafe('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM default_acl_shadow');
      assert.deepEqual(await defaultAcl(cluster.admin), initialAcl);

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('parent-user','parent-native@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('parent-space','personal','parent-user','Parent Native','parent-native','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('parent-key','parent-native-key','parent-user','parent-space');`).simple();
      const [clock] = await migrator.unsafe(`SELECT
        (floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 60000) AS expiry`);
      const oldId = `old-${randomUUID()}`;
      await migrator.unsafe(`INSERT INTO ${intentTable}
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ($1,1,'parent-user','parent-key','parent-space','images.generations',$2,$3)`,
      [oldId, 'a'.repeat(64), clock.expiry]);
      await assert.rejects(runBundle(migrator, bundle),
        /Existing dispatch intents need separately reviewed request backfill/);
      assert.equal(await parentExists(cluster.admin), false);
      assert.deepEqual(await defaultAcl(cluster.admin), initialAcl);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${intentTable}
        WHERE request_id=$1`, [oldId]))[0].n, 1);
      stage('parent-preflight-failure-rolls-back-temporary-default-revokes-and-preserves-row');
      await migrator.unsafe(`DELETE FROM ${intentTable} WHERE request_id=$1`, [oldId]);

      await runBundle(migrator, bundle);
      assert.equal(await parentExists(cluster.admin), true);
      assert.deepEqual(await defaultAcl(cluster.admin), initialAcl);
      const expectedAccess = { parent_table: false, intent_write: false,
        prepare: false, claim: false, classify: false, ordinary_select: true };
      assert.deepEqual(await parentAccess(cluster.admin), expectedAccess);
      const runtime = cluster.client('parent-default-acl-runtime');
      await runtime.unsafe('SET ROLE cinatoken_gateway_runtime');
      await assert.rejects(runtime.unsafe(`SELECT * FROM ${parentTable}`),
        cause => cause.code === '42501');
      await assert.rejects(runtime.unsafe(`SELECT ${schema}.claim_request_dispatch_intent_v1(
        'invalid',1,'user','key','space','images.generations',repeat('a',64),repeat('b',64),
        0::bigint,'00000000-0000-4000-8000-000000000000')`),
        cause => cause.code === '42501');
      stage('one-transaction-activation-restores-defaults-and-leaves-parent-closed',
        { parentAccess: await parentAccess(cluster.admin) });

      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      assert.deepEqual(await defaultAcl(cluster.admin), initialAcl);
      assert.deepEqual(await parentAccess(cluster.admin), expectedAccess);
      stage('runtime-grant-rerun-keeps-parent-closed-and-defaults-intact');

      for (const [key, url] of sourceFiles) {
        assert.equal(sha256(await readFile(url)), report.sourceSha256[key],
          `${key} changed during the native run`);
      }
      report.status = 'PASS';
    } catch (cause) {
      error = cause;
      report.status = 'FAIL'; report.fatal = errorSummary(cause);
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (cause) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(cause); error ??= cause; }
      if (report.status === 'PASS' && report.cleanup === 'PASS') {
        await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        console.log('Native parent default ACL evidence: ' + reportFile);
        console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
          stages: report.stages.map(value => value.name) }, null, 2));
      }
    }
    if (error) throw error;
  });
