// Review-only PG18.6 fixture. It owns a new loopback cluster, never accepts
// an ambient database URL, and cleans the owned cluster after every run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';
import {
  readPostgresSharedUsageRepairDurableCursor,
  runPostgresSharedUsageRepairDurableCursorActivation,
  runPostgresSharedUsageRepairDurablePage,
} from './build-postgres-shared-usage-repair-durable-cursor.mjs';

const gateway = 'cinatoken_gateway';
const maintenance = 'cinatoken_repair_maintenance';
const cursor = `${maintenance}.shared_key_usage_repair_cursor`;
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const historyGuard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const repairJobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const digest = body => createHash('sha256').update(body).digest('hex');
const errorSummary = error => ({ code: error?.code ?? null,
  message: String(error?.message ?? error).slice(0, 450) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    onnotice() {}, connection: { application_name: `durable-backfill-${label}` } });
}

async function activate(sql, url, setting) {
  const body = await readFile(url, 'utf8');
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}

async function addEarning(sql, id, key) {
  const log = `log-${id}`;
  await sql.unsafe(`INSERT INTO ${gateway}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id)
    VALUES ($1,'buyer','buyer-key','buyer-space')`, [log]);
  await sql.unsafe(`INSERT INTO ${gateway}.shared_key_earnings
    (id,request_log_id,shared_key_id,seller_user_id,input_tokens,
      output_tokens,gross_amount,net_amount)
    VALUES ($1,$2,$3,'seller',10,2,0.02,0.01)`, [id, log, key]);
}

async function jobCount(sql) {
  return (await sql.unsafe(`SELECT count(*)::integer AS n
    FROM ${gateway}.shared_key_usage_repair_jobs`))[0].n;
}

async function waitForBlockedOperator(admin) {
  const start = performance.now();
  while (performance.now() - start < 1_500) {
    const [row] = await admin.unsafe(`SELECT wait_event_type, wait_event
      FROM pg_catalog.pg_stat_activity
      WHERE application_name = 'durable-backfill-second'
        AND state = 'active'`);
    if (row?.wait_event_type === 'Lock') return {
      observedWaitMs: Math.round(performance.now() - start), waitEvent: row.wait_event,
    };
    await sleep(20);
  }
  throw new Error('Second operator did not block on the durable cursor row');
}

async function readFromSeparateProcess(cluster, password) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./read-postgres-shared-usage-repair-cursor.child.mjs', import.meta.url)),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ port: cluster.port, password }));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, stderr.slice(0, 600));
  return JSON.parse(stdout);
}

test('native PG18 durable historical repair cursor serializes operators and survives unknown COMMIT',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-usage-durable-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6; 73 formal migrations; review-only history, repair jobs and private cursor',
      limitations: [
        'A simulated lost COMMIT acknowledgement discards a successful client result; no physical packet loss is induced.',
        'The isolated migrator receives database CREATE only after a negative test; provisioning does not grant it by default.',
        'A second operator waiting more than 2s gets 55P03 and must retry; separate physical hosts are not exercised.',
        'A late lower-sorting earning depends on the live enqueue trigger, not the advanced cursor.',
        'No production data scale, maintenance window, real Worker/Hyperdrive/Queue, remote SQL or deployment is exercised.',
      ], sourceSha256: {}, stages: [] };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const delegatePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE repair_cursor_delegate LOGIN PASSWORD '${delegatePassword}';
        GRANT cinatoken_gateway_migrator TO repair_cursor_delegate WITH SET TRUE;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime, repair_cursor_delegate;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'first');
      const second = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'second');
      const observer = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'observer');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      const delegate = client(cluster, 'repair_cursor_delegate', delegatePassword, 'delegate');
      clients.push(migrator, second, observer, runtime, delegate);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = digest(corpus.join('\n'));
      for (const [name, url] of [
        ['historyGuard', historyGuard], ['repairJobs', repairJobs],
        ['basePageGenerator', new URL('./build-postgres-shared-usage-repair-backfill.mjs', import.meta.url)],
        ['durableCursorGenerator', new URL('./build-postgres-shared-usage-repair-durable-cursor.mjs', import.meta.url)],
        ['childCursorReader', new URL('./read-postgres-shared-usage-repair-cursor.child.mjs', import.meta.url)],
        ['nativeTest', new URL(import.meta.url)],
      ]) report.sourceSha256[name] = digest(await readFile(url));
      await activate(migrator, historyGuard,
        'cinatoken.shared_key_earnings_history_guard_activation');
      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
          ('seller','seller@example.invalid'),('buyer','buyer@example.invalid');
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('buyer-space','personal','buyer','Buyer','buyer','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('buyer-key','synthetic-hash','buyer','buyer-space');
        INSERT INTO ${gateway}.user_earnings(user_id) VALUES ('seller');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint)
          SELECT 'key-' || k, 'seller', 'openai', 'secret-' || k,
            'fingerprint-' || k FROM unnest(ARRAY['a','b','c','d','e','f','g','h']) AS k;`).simple();
      for (let i = 1; i <= 7; i++) {
        const label = String(i).padStart(2, '0');
        await addEarning(migrator, `earning-${label}`, `key-${'abcdefg'[i - 1]}`);
      }
      await activate(migrator, repairJobs,
        'cinatoken.shared_key_usage_repair_activation');
      assert.equal(await jobCount(migrator), 0);
      stage('formal-schema-and-seven-credited-old-earnings', { migrations: files.length });

      const activation = { activation: 'reviewed-v1' };
      await assert.rejects(runPostgresSharedUsageRepairDurableCursorActivation(migrator,
        activation), /durable cursor activation or database CREATE differs/);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regnamespace('${maintenance}') AS n`))[0].n, null);
      await cluster.admin.unsafe('GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator');
      await delegate.unsafe('SET ROLE cinatoken_gateway_migrator');
      await assert.rejects(runPostgresSharedUsageRepairDurableCursorActivation(delegate,
        activation), /Historical shared-key repair backfill source contract differs/);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regnamespace('${maintenance}') AS n`))[0].n, null);
      stage('database-create-and-direct-migrator-login-required');

      await cluster.admin.unsafe(`GRANT cinatoken_gateway_migrator
        TO cinatoken_gateway_runtime WITH INHERIT FALSE, SET TRUE`);
      const [ownerMembership] = await cluster.admin.unsafe(`SELECT
        pg_catalog.pg_has_role('cinatoken_gateway_runtime',
          'cinatoken_gateway_migrator', 'USAGE') AS inherited,
        pg_catalog.pg_has_role('cinatoken_gateway_runtime',
          'cinatoken_gateway_migrator', 'SET') AS can_set,
        pg_catalog.pg_has_role('cinatoken_gateway_runtime',
          'cinatoken_gateway_migrator', 'MEMBER') AS member`);
      assert.deepEqual(ownerMembership,
        { inherited: false, can_set: true, member: true });
      await runtime.unsafe('BEGIN');
      try {
        await runtime.unsafe('SET ROLE cinatoken_gateway_migrator');
        assert.deepEqual((await runtime.unsafe(`SELECT current_user, session_user`))[0],
          { current_user: 'cinatoken_gateway_migrator',
            session_user: 'cinatoken_gateway_runtime' });
      } finally { await runtime.unsafe('ROLLBACK'); }
      await assert.rejects(runPostgresSharedUsageRepairDurableCursorActivation(migrator,
        activation), /Historical repair durable cursor owner or ACL differs/);
      assert.equal((await migrator.unsafe(`SELECT pg_catalog.to_regnamespace('${maintenance}') AS n`))[0].n, null);
      assert.equal(await jobCount(migrator), 0);
      await cluster.admin.unsafe(`REVOKE cinatoken_gateway_migrator
        FROM cinatoken_gateway_runtime`);
      stage('noninherited-set-role-migrator-membership-rolls-back-activation',
        { ownerMembership });

      await runPostgresSharedUsageRepairDurableCursorActivation(migrator, activation);
      await assert.rejects(runPostgresSharedUsageRepairDurableCursorActivation(migrator,
        activation), /durable cursor activation or database CREATE differs/);
      const [owners] = await migrator.unsafe(`SELECT
        (SELECT n.nspowner = 'cinatoken_gateway_migrator'::pg_catalog.regrole
          FROM pg_catalog.pg_namespace n WHERE n.nspname='${maintenance}') AS schema_owner,
        (SELECT c.relowner = 'cinatoken_gateway_migrator'::pg_catalog.regrole
          FROM pg_catalog.pg_class c WHERE c.oid='${cursor}'::pg_catalog.regclass) AS table_owner`);
      assert.deepEqual(owners, { schema_owner: true, table_owner: true });
      await assert.rejects(runtime.unsafe(`SELECT * FROM ${cursor}`),
        error => error?.code === '42501');
      assert.deepEqual(await readPostgresSharedUsageRepairDurableCursor(migrator),
        { lastEarningId: null, pagesCommitted: 0 });
      stage('private-migrator-owned-singleton-is-not-runtime-readable', { owners });

      const options = { activation: 'reviewed-v1', limit: 2 };
      await migrator.unsafe(`GRANT USAGE ON SCHEMA ${maintenance}
        TO cinatoken_gateway_runtime`);
      await assert.rejects(runPostgresSharedUsageRepairDurablePage(migrator,
        options), /Historical repair durable cursor owner or ACL differs/);
      await migrator.unsafe(`REVOKE USAGE ON SCHEMA ${maintenance}
        FROM cinatoken_gateway_runtime`);
      assert.equal(await jobCount(migrator), 0);
      stage('wide-runtime-schema-acl-rejected-before-page');

      const builtinMembership = {};
      for (const role of ['pg_read_all_data', 'pg_write_all_data']) {
        await cluster.admin.unsafe(`GRANT ${role}
          TO cinatoken_gateway_runtime WITH INHERIT FALSE, SET TRUE`);
        const [membership] = await cluster.admin.unsafe(`SELECT
          pg_catalog.pg_has_role('cinatoken_gateway_runtime',
            '${role}', 'USAGE') AS inherited,
          pg_catalog.pg_has_role('cinatoken_gateway_runtime',
            '${role}', 'SET') AS can_set,
          pg_catalog.pg_has_role('cinatoken_gateway_runtime',
            '${role}', 'MEMBER') AS member`);
        assert.deepEqual(membership,
          { inherited: false, can_set: true, member: true });
        await runtime.unsafe('BEGIN');
        try {
          await runtime.unsafe(`SET ROLE ${role}`);
          if (role === 'pg_read_all_data') {
            assert.equal((await runtime.unsafe(`SELECT last_earning_id
              FROM ${cursor} WHERE singleton=1`))[0].last_earning_id, null);
          } else {
            await runtime.unsafe(`UPDATE ${cursor}
              SET pages_committed=1`);
          }
        } finally { await runtime.unsafe('ROLLBACK'); }
        await assert.rejects(runPostgresSharedUsageRepairDurablePage(migrator,
          options), /Historical repair durable cursor owner or ACL differs/);
        await assert.rejects(readPostgresSharedUsageRepairDurableCursor(migrator),
          /Historical repair durable cursor owner or ACL differs/);
        assert.equal(await jobCount(migrator), 0);
        await cluster.admin.unsafe(`REVOKE ${role}
          FROM cinatoken_gateway_runtime`);
        builtinMembership[role] = membership;
      }
      assert.deepEqual(await readPostgresSharedUsageRepairDurableCursor(migrator),
        { lastEarningId: null, pagesCommitted: 0 });
      stage('noninherited-set-role-all-data-memberships-reject-page',
        { builtinMembership });

      const rollback = new Error('synthetic crash before COMMIT');
      await assert.rejects(migrator.begin(async tx => {
        const sameTransaction = { begin: callback => callback(tx) };
        const result = await runPostgresSharedUsageRepairDurablePage(sameTransaction, options);
        assert.deepEqual(result, { scanned: 2, enqueued: 2,
          afterEarningId: null, nextEarningId: 'earning-02', pagesCommitted: 1 });
        throw rollback;
      }), error => error === rollback);
      assert.deepEqual(await readPostgresSharedUsageRepairDurableCursor(migrator),
        { lastEarningId: null, pagesCommitted: 0 });
      assert.equal(await jobCount(migrator), 0);
      stage('rolled-back-page-keeps-jobs-and-cursor-unchanged');

      const first = await runPostgresSharedUsageRepairDurablePage(migrator, options);
      assert.deepEqual(first, { scanned: 2, enqueued: 2,
        afterEarningId: null, nextEarningId: 'earning-02', pagesCommitted: 1 });
      assert.equal(await jobCount(migrator), 2);
      stage('first-page-and-cursor-commit-together', { first });

      await migrator.unsafe('BEGIN');
      let timedWaitMs;
      try {
        await migrator.unsafe(`SELECT singleton FROM ${cursor}
          WHERE singleton = 1 FOR UPDATE`);
        const started = performance.now();
        await assert.rejects(runPostgresSharedUsageRepairDurablePage(second, options),
          error => error?.code === '55P03');
        timedWaitMs = Math.round(performance.now() - started);
      } finally { await migrator.unsafe('ROLLBACK'); }
      assert.ok(timedWaitMs >= 1_200 && timedWaitMs < 5_000,
        `bounded cursor wait ${timedWaitMs}ms`);
      assert.deepEqual(await readPostgresSharedUsageRepairDurableCursor(second),
        { lastEarningId: 'earning-02', pagesCommitted: 1 });
      assert.equal(await jobCount(second), 2);
      stage('cursor-lock-timeout-leaves-page-unchanged-for-retry', {
        code: '55P03', timedWaitMs,
      });

      // This wrapper discards a completed postgres.js begin result after the
      // actual COMMIT, modeling a lost acknowledgement at the caller boundary.
      const lostAck = { async begin(callback) {
        await migrator.begin(callback);
        throw new Error('simulated COMMIT acknowledgement lost');
      } };
      await assert.rejects(runPostgresSharedUsageRepairDurablePage(lostAck, options),
        /simulated COMMIT acknowledgement lost/);
      const separateProcess = await readFromSeparateProcess(cluster, migratorPassword);
      assert.notEqual(separateProcess.pid, process.pid);
      const afterUnknown = separateProcess.cursor;
      assert.deepEqual(afterUnknown, { lastEarningId: 'earning-04', pagesCommitted: 2 });
      assert.equal(await jobCount(second), 4);
      stage('lost-commit-ack-reads-authoritative-cursor-from-separate-process', {
        afterUnknown, separateProcessPid: separateProcess.pid,
      });

      let releaseFirst, firstReady;
      const ready = new Promise(resolve => { firstReady = resolve; });
      const release = new Promise(resolve => { releaseFirst = resolve; });
      const heldFirst = { begin: callback => migrator.begin(async tx => {
        const result = await callback(tx);
        firstReady();
        await release;
        return result;
      }) };
      const firstPending = runPostgresSharedUsageRepairDurablePage(heldFirst, options);
      await ready;
      const secondPending = runPostgresSharedUsageRepairDurablePage(second, options);
      let blocked;
      try {
        blocked = await waitForBlockedOperator(cluster.admin);
        const [committedBeforeRelease] = await observer.unsafe(`SELECT
          last_earning_id, pages_committed::integer AS pages_committed
          FROM ${cursor} WHERE singleton = 1`);
        assert.deepEqual(committedBeforeRelease,
          { last_earning_id: 'earning-04', pages_committed: 2 });
      } finally { releaseFirst(); }
      const [operatorA, operatorB] = await Promise.all([firstPending, secondPending]);
      assert.deepEqual(operatorA, { scanned: 2, enqueued: 2,
        afterEarningId: 'earning-04', nextEarningId: 'earning-06', pagesCommitted: 3 });
      assert.deepEqual(operatorB, { scanned: 1, enqueued: 1,
        afterEarningId: 'earning-06', nextEarningId: 'earning-07', pagesCommitted: 4 });
      assert.deepEqual(await readPostgresSharedUsageRepairDurableCursor(second),
        { lastEarningId: 'earning-07', pagesCommitted: 4 });
      assert.equal(await jobCount(second), 7);
      stage('two-operators-wait-and-consume-disjoint-pages', { blocked, operatorA, operatorB });

      await addEarning(migrator, '!late-h', 'key-h');
      assert.equal(await jobCount(migrator), 8);
      const empty = await runPostgresSharedUsageRepairDurablePage(second, options);
      assert.deepEqual(empty, { scanned: 0, enqueued: 0,
        afterEarningId: 'earning-07', nextEarningId: 'earning-07', pagesCommitted: 4 });
      const [late] = await second.unsafe(`SELECT request_log_id
        FROM ${gateway}.shared_key_usage_repair_jobs WHERE shared_key_id='key-h'`);
      assert.equal(late.request_log_id, 'log-!late-h');
      stage('late-low-sorting-earning-is-live-trigger-only', { empty, late });

      const [economic] = await second.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${gateway}.shared_key_earnings) AS earnings,
        (SELECT count(*)::integer FROM ${gateway}.portal_ledger_entries
          WHERE kind='shared_key_earning') AS credits,
        (SELECT count(*)::integer FROM ${gateway}.shared_key_usage_repair_jobs) AS jobs,
        (SELECT balance_micros::text FROM ${gateway}.user_earnings
          WHERE user_id='seller') AS balance`);
      assert.deepEqual(economic, { earnings: 8, credits: 8, jobs: 8, balance: '80000' });
      stage('repair-queueing-does-not-credit-seller-again', { economic });
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL'; report.error = errorSummary(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { report.cleanupDetails = await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key durable cursor report: ' + reportPath);
    }
    if (failure) throw failure;
  });
