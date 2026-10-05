// Review-only PG18.6 fixture. It creates and cleans a private loopback cluster;
// no ambient database URL, cloud binding, real account or deployment is used.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const historyGuard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const repairJobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');

function client(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-shared-usage-job-${label}` } });
}

async function activate(sql, body, activationSetting) {
  await sql.begin(async tx => {
    if (activationSetting) await tx.unsafe(`SET LOCAL ${activationSetting} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}

async function state(sql) {
  const [row] = await sql.unsafe(`SELECT
    (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='used-key') AS jobs,
    (SELECT count(*)::int FROM ${schema}.shared_key_earnings WHERE shared_key_id='used-key') AS earnings,
    (SELECT count(*)::int FROM ${schema}.portal_ledger_entries WHERE kind='shared_key_earning') AS ledger,
    (SELECT balance_micros::text FROM ${schema}.user_earnings WHERE user_id='seller') AS balance,
    (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='used-key') AS input,
    (SELECT served_output_tokens::text FROM ${schema}.shared_keys WHERE id='used-key') AS output,
    (SELECT earned_total::text FROM ${schema}.shared_keys WHERE id='used-key') AS net`);
  return row;
}

async function addLogAndEarning(sql, n, amount = '0.04') {
  await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
    VALUES ($1,'buyer','buyer-key','buyer-workspace')`, [`log-${n}`]);
  await sql.unsafe(`INSERT INTO ${schema}.shared_key_earnings
    (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,gross_amount,net_amount)
    VALUES ($1,$2,'used-key','seller',100,20,0.05,$3)`, [`earning-${n}`, `log-${n}`, amount]);
}

test('native PG18 credited earning enqueues a durable, atomic summary repair',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-usage-jobs-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, 73 formal migrations and two review-only proposals',
      stages: [], limitations: [
        'The job and history guard proposals are not formal migrations or deployed.',
        'No dedicated runtime role, scheduler, bounded backfill or failure backoff is installed.',
        'The fixture does not test Cloudflare Workers, Hyperdrive or MySQL.',
      ], sourceSha256: {} };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const password = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_extra NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, password, 'migrator');
      const holder = client(cluster, password, 'holder');
      clients.push(migrator, holder);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      const guardBody = await readFile(historyGuard, 'utf8');
      const jobsBody = await readFile(repairJobs, 'utf8');
      const runtimeGrantBody = await readFile(new URL('./grant-postgres-runtime.ts', import.meta.url), 'utf8');
      report.sourceSha256 = { historyGuardProposal: digest(guardBody),
        repairJobsProposal: digest(jobsBody), runtimeGrantSource: digest(runtimeGrantBody) };
      await activate(migrator, guardBody, 'cinatoken.shared_key_earnings_history_guard_activation');
      stage('formal-schema-and-history-guard-installed', { formalMigrations: files.length });

      await assert.rejects(activate(migrator, jobsBody, null),
        /Shared-key usage repair activation or owner contract differs/);
      assert.equal((await migrator.unsafe(`SELECT to_regclass('${schema}.shared_key_usage_repair_jobs') AS name`))[0].name, null);
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_credit_after_insert`);
      await assert.rejects(activate(migrator, jobsBody, 'cinatoken.shared_key_usage_repair_activation'),
        /Shared-key usage repair preflight differs/);
      assert.equal((await migrator.unsafe(`SELECT to_regclass('${schema}.shared_key_usage_repair_jobs') AS name`))[0].name, null);
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_credit_after_insert`);
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_history_no_truncate`);
      await assert.rejects(activate(migrator, jobsBody, 'cinatoken.shared_key_usage_repair_activation'),
        /Shared-key usage repair preflight differs/);
      assert.equal((await migrator.unsafe(`SELECT to_regclass('${schema}.shared_key_usage_repair_jobs') AS name`))[0].name, null);
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_history_no_truncate`);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.shared_key_earnings_credit_after_insert_fn()
          RETURNS trigger LANGUAGE plpgsql
          SET search_path TO pg_catalog, ${schema}, pg_temp
          AS $no_credit$ BEGIN RETURN NEW; END; $no_credit$`);
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_usage_repair_activation = 'reviewed-v1'`);
        await tx.unsafe(jobsBody).simple();
      }), /Shared-key usage repair preflight differs/);
      assert.equal((await migrator.unsafe(`SELECT to_regclass('${schema}.shared_key_usage_repair_jobs') AS name`))[0].name, null);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE cinatoken_gateway_migrator IN SCHEMA ${schema}
        GRANT EXECUTE ON FUNCTIONS TO cinatoken_gateway_extra`);
      await assert.rejects(activate(migrator, jobsBody, 'cinatoken.shared_key_usage_repair_activation'),
        /Shared-key usage repair ACL differs/);
      assert.equal((await migrator.unsafe(`SELECT to_regclass('${schema}.shared_key_usage_repair_jobs') AS name`))[0].name, null);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE cinatoken_gateway_migrator IN SCHEMA ${schema}
        REVOKE EXECUTE ON FUNCTIONS FROM cinatoken_gateway_extra`);
      await activate(migrator, jobsBody, 'cinatoken.shared_key_usage_repair_activation');
      stage('activation-trigger-body-and-default-acl-drift-rollback');

      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl:
        `postgresql://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres` });
      const [runtimeAcl] = await migrator.unsafe(`SELECT
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.shared_key_usage_repair_jobs', 'SELECT') AS table_read,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.shared_key_usage_repair_jobs', 'INSERT') AS table_insert,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.shared_key_usage_repair_jobs', 'UPDATE') AS table_update,
        pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
          '${schema}.shared_key_usage_repair_jobs', 'DELETE') AS table_delete,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${schema}.enqueue_shared_key_usage_repair()', 'EXECUTE') AS enqueue_execute,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
          '${schema}.repair_one_shared_key_usage()', 'EXECUTE') AS repair_execute`);
      assert.deepEqual(runtimeAcl, { table_read: false, table_insert: false,
        table_update: false, table_delete: false, enqueue_execute: false,
        repair_execute: false });
      const runtime = postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
        username: 'cinatoken_gateway_runtime', password: runtimePassword, ssl: false,
        max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
        idle_timeout: 0, max_lifetime: 0, backoff: 0 });
      clients.push(runtime);
      await assert.rejects(runtime.unsafe(`SELECT 1 FROM ${schema}.shared_key_usage_repair_jobs`),
        error => error?.code === '42501');
      await assert.rejects(runtime.unsafe(`SELECT ${schema}.repair_one_shared_key_usage()`),
        error => error?.code === '42501');
      stage('runtime-grant-rerun-keeps-job-and-definers-closed');

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES
          ('seller','seller@example.invalid'),('buyer','buyer@example.invalid');
        INSERT INTO ${schema}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('buyer-workspace','personal','buyer','Buyer','buyer','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('buyer-key','synthetic-hash','buyer','buyer-workspace');
        INSERT INTO ${schema}.user_earnings(user_id) VALUES ('seller');
        INSERT INTO ${schema}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint)
          VALUES ('used-key','seller','openai','synthetic-secret','fingerprint');`).simple();
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_usage_repair_jobs
        ADD CONSTRAINT fixture_reject_enqueue CHECK (false)`);
      await assert.rejects(migrator.begin(async tx => addLogAndEarning(tx, 0)),
        error => error?.code === '23514');
      assert.deepEqual(await state(migrator), { jobs: 0, earnings: 0, ledger: 0,
        balance: '0', input: '0', output: '0', net: '0.000000' });
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_usage_repair_jobs
        DROP CONSTRAINT fixture_reject_enqueue`);
      stage('enqueue-failure-rolls-back-earning-credit-and-ledger');
      await addLogAndEarning(migrator, 1);
      assert.deepEqual(await state(migrator), { jobs: 1, earnings: 1, ledger: 1,
        balance: '40000', input: '0', output: '0', net: '0.000000' });
      stage('earning-credit-and-repair-job-commit-together');

      await assert.rejects(migrator.begin(async tx => {
        assert.equal((await tx.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id, 'used-key');
        assert.deepEqual(await state(tx), { jobs: 0, earnings: 1, ledger: 1,
          balance: '40000', input: '100', output: '20', net: '0.040000' });
        throw new Error('synthetic crash before repair commit');
      }), /synthetic crash before repair commit/);
      assert.deepEqual(await state(migrator), { jobs: 1, earnings: 1, ledger: 1,
        balance: '40000', input: '0', output: '0', net: '0.000000' });
      assert.equal((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id, 'used-key');
      assert.deepEqual(await state(migrator), { jobs: 0, earnings: 1, ledger: 1,
        balance: '40000', input: '100', output: '20', net: '0.040000' });
      assert.equal((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id, null);
      stage('repair-rollback-retains-job-and-retry-does-not-credit-again');

      await addLogAndEarning(migrator, 2, '0.05');
      assert.equal((await state(migrator)).jobs, 1);
      let releaseHolder;
      let holderReady;
      const ready = new Promise(resolve => { holderReady = resolve; });
      const release = new Promise(resolve => { releaseHolder = resolve; });
      const holding = holder.begin(async tx => {
        await addLogAndEarning(tx, 3, '0.06');
        holderReady();
        await release;
      });
      await ready;
      try {
        assert.equal((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id, null);
      } finally { releaseHolder(); await holding; }
      assert.equal((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id, 'used-key');
      assert.deepEqual(await state(migrator), { jobs: 0, earnings: 3, ledger: 3,
        balance: '150000', input: '300', output: '60', net: '0.150000' });
      stage('concurrent-earning-lock-order-and-keyset-repair');

      await migrator.unsafe(`INSERT INTO ${schema}.shared_keys
        (id,seller_user_id,channel_type,api_key,key_fingerprint)
        SELECT 'queue-key-' || lpad(g::text,2,'0'), 'seller', 'openai',
          'queue-secret-' || g::text, 'queue-fingerprint-' || g::text
        FROM generate_series(1,33) AS g`);
      await migrator.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id)
        SELECT 'queue-log-' || lpad(g::text,2,'0'), 'buyer', 'buyer-key',
          'buyer-workspace' FROM generate_series(1,33) AS g`);
      await migrator.unsafe(`INSERT INTO ${schema}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,input_tokens,
          output_tokens,gross_amount,net_amount)
        SELECT 'queue-earning-' || lpad(g::text,2,'0'),
          'queue-log-' || lpad(g::text,2,'0'),
          'queue-key-' || lpad(g::text,2,'0'), 'seller', 1, 1, 0.02, 0.01
        FROM generate_series(1,33) AS g`);
      await migrator.unsafe(`UPDATE ${schema}.shared_key_usage_repair_jobs
        SET available_at = '2020-01-01'::timestamptz
        WHERE shared_key_id LIKE 'queue-key-%'`);
      let releaseQueueHolder;
      let queueHolderReady;
      const queueReady = new Promise(resolve => { queueHolderReady = resolve; });
      const queueRelease = new Promise(resolve => { releaseQueueHolder = resolve; });
      const queueHolding = holder.begin(async tx => {
        const locked = await tx.unsafe(`SELECT id FROM ${schema}.shared_keys
          WHERE id LIKE 'queue-key-%' AND id <> 'queue-key-33'
          ORDER BY id FOR UPDATE`);
        assert.equal(locked.length, 32);
        queueHolderReady();
        await queueRelease;
      });
      await queueReady;
      try {
        assert.equal((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id,
          'queue-key-33');
      } finally { releaseQueueHolder(); await queueHolding; }
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS jobs
        FROM ${schema}.shared_key_usage_repair_jobs
        WHERE shared_key_id LIKE 'queue-key-%'`))[0].jobs, 32);
      stage('skip-locked-keyset-does-not-hide-33rd-due-job');

      const extraExecute = await migrator.unsafe(`SELECT pg_catalog.has_function_privilege(
        'cinatoken_gateway_runtime', '${schema}.repair_one_shared_key_usage()', 'EXECUTE') AS runtime,
        pg_catalog.has_function_privilege('cinatoken_gateway_extra',
          '${schema}.repair_one_shared_key_usage()', 'EXECUTE') AS extra`);
      assert.deepEqual(extraExecute[0], { runtime: false, extra: false });
      stage('definer-execute-confined-to-owner');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.message ?? error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key usage job report: ' + reportPath);
    }
    if (failure) throw failure;
  });
