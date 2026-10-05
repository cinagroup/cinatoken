// Review-only native fixture: historical earnings are paged into the durable
// usage-repair jobs after the live enqueue trigger is installed. Loopback only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';
import {
  buildPostgresSharedUsageRepairBackfillPage,
  runPostgresSharedUsageRepairBackfillPage,
} from './build-postgres-shared-usage-repair-backfill.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const historyGuard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const repairJobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const errorSummary = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 450) });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    onnotice() {}, connection: { application_name: `cinatoken-usage-backfill-${label}` } });
}

async function activate(sql, body, setting) {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
}

async function addEarning(sql, { id, key, log }) {
  await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id) VALUES ($1,'buyer','buyer-key','buyer-workspace')`, [log]);
  await sql.unsafe(`INSERT INTO ${schema}.shared_key_earnings
    (id,request_log_id,shared_key_id,seller_user_id,input_tokens,
      output_tokens,gross_amount,net_amount)
    VALUES ($1,$2,$3,'seller',10,2,0.02,0.01)`, [id, log, key]);
}

async function job(sql, key) {
  return (await sql.unsafe(`SELECT request_log_id FROM ${schema}.shared_key_usage_repair_jobs
    WHERE shared_key_id=$1`, [key]))[0]?.request_log_id ?? null;
}

async function jobCount(sql) {
  return (await sql.unsafe(`SELECT count(*)::int AS n
    FROM ${schema}.shared_key_usage_repair_jobs`))[0].n;
}

test('native PG18 bounded historical usage repair backfill survives rollback and cursor replay',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-usage-backfill-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, 73 formal migrations, history guard and repair job review-only proposals',
      limitations: [
        'No cross-host durable cursor store, scheduler or automatic full-history completion observation is installed.',
        'A lost COMMIT acknowledgement requires replay from the previously committed cursor; the SQL page itself cannot identify an external cursor file.',
        'Late lower-sorting earnings are covered by the live enqueue trigger, not by the already-passed keyset cursor.',
        'No production-size lock window, real Workers/Hyperdrive, remote SQL or deployment is exercised.',
      ], sourceSha256: {}, stages: [] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const delegatePassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE repair_backfill_delegate LOGIN PASSWORD '${delegatePassword}';
        GRANT cinatoken_gateway_migrator TO repair_backfill_delegate WITH SET TRUE;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime, repair_backfill_delegate;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const holder = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'holder');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      const delegate = client(cluster, 'repair_backfill_delegate', delegatePassword, 'delegate');
      clients.push(migrator, holder, runtime, delegate);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = digest(corpus.join('\n'));
      for (const [name, url] of [
        ['historyGuard', historyGuard], ['repairJobs', repairJobs],
        ['pageGenerator', new URL('./build-postgres-shared-usage-repair-backfill.mjs', import.meta.url)],
        ['nativeTest', new URL(import.meta.url)],
      ]) report.sourceSha256[name] = digest(await readFile(url));
      await activate(migrator, await readFile(historyGuard, 'utf8'),
        'cinatoken.shared_key_earnings_history_guard_activation');
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
          SELECT 'key-' || k, 'seller', 'openai', 'secret-' || k,
            'fingerprint-' || k FROM unnest(ARRAY['a','b','c','d','e']) AS k;`).simple();
      for (const row of [
        { id: 'earning-01', key: 'key-a', log: 'log-01' },
        { id: 'earning-02', key: 'key-b', log: 'log-02' },
        { id: 'earning-03', key: 'key-d', log: 'log-03' },
        { id: 'earning-04', key: 'key-e', log: 'log-04' },
        { id: 'earning-05', key: 'key-a', log: 'log-05' },
      ]) await addEarning(migrator, row);
      await activate(migrator, await readFile(repairJobs, 'utf8'),
        'cinatoken.shared_key_usage_repair_activation');
      assert.equal(await jobCount(migrator), 0);
      stage('five-credited-historical-earnings-have-no-implicit-jobs', { formalMigrations: files.length });

      const options = (afterEarningId = null) => ({
        activation: 'reviewed-v1', afterEarningId, limit: 2 });
      await delegate.unsafe('SET ROLE cinatoken_gateway_migrator');
      assert.deepEqual((await delegate.unsafe(`SELECT current_user AS current_user,
        session_user AS session_user`))[0],
      { current_user: 'cinatoken_gateway_migrator', session_user: 'repair_backfill_delegate' });
      await assert.rejects(runPostgresSharedUsageRepairBackfillPage(delegate, options()),
        /Historical shared-key repair backfill source contract differs/);
      assert.equal(await jobCount(migrator), 0);
      stage('set-role-delegate-cannot-run-migrator-backfill');
      const firstPageSql = await buildPostgresSharedUsageRepairBackfillPage(options());
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.enqueue_shared_key_usage_repair()
          RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
          SET search_path TO pg_catalog, pg_temp
          AS $drift$ BEGIN RETURN NEW; END; $drift$`);
        await tx.unsafe(firstPageSql.preflightSql).simple();
      }), /Historical shared-key repair backfill source contract differs/);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.reject_shared_key_earnings_history_mutation()
          RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
          SET search_path TO pg_catalog, pg_temp
          AS $drift$ BEGIN RETURN OLD; END; $drift$`);
        await tx.unsafe(firstPageSql.preflightSql).simple();
      }), /Historical shared-key repair backfill source contract differs/);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`CREATE OR REPLACE TRIGGER shared_key_earnings_enqueue_usage_repair
          AFTER INSERT ON ${schema}.shared_key_earnings
          FOR EACH ROW WHEN (false)
          EXECUTE FUNCTION ${schema}.enqueue_shared_key_usage_repair()`);
        await tx.unsafe(firstPageSql.preflightSql).simple();
      }), /Historical shared-key repair backfill source contract differs/);
      assert.equal(await jobCount(migrator), 0);
      stage('target-function-body-or-trigger-when-drift-rejects-page');
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_enqueue_usage_repair`);
      await assert.rejects(runPostgresSharedUsageRepairBackfillPage(migrator, options()),
        /Historical shared-key repair backfill source contract differs/);
      assert.equal(await jobCount(migrator), 0);
      await migrator.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_enqueue_usage_repair`);
      await migrator.unsafe(`GRANT SELECT ON ${schema}.shared_key_usage_repair_jobs
        TO cinatoken_gateway_runtime`);
      await assert.rejects(runPostgresSharedUsageRepairBackfillPage(migrator, options()),
        /Historical shared-key repair backfill job ACL differs/);
      assert.equal(await jobCount(migrator), 0);
      await migrator.unsafe(`REVOKE SELECT ON ${schema}.shared_key_usage_repair_jobs
        FROM cinatoken_gateway_runtime`);
      await assert.rejects(runPostgresSharedUsageRepairBackfillPage(runtime, options()),
        error => error?.code === '42501' || /owner|permission/i.test(String(error?.message)));
      stage('disabled-enqueue-or-wide-runtime-acl-rejects-page-before-write');

      const first = await runPostgresSharedUsageRepairBackfillPage(migrator, options());
      assert.deepEqual(first, { scanned: 2, enqueued: 2,
        nextEarningId: 'earning-02', afterEarningId: null });
      assert.equal(await jobCount(migrator), 2);
      assert.equal(await job(migrator, 'key-a'), 'log-01');
      stage('first-page-commits-before-cursor-is-returned', { first });

      await addEarning(migrator, { id: '!late-a', key: 'key-a', log: 'new-log-a' });
      assert.equal(await job(migrator, 'key-a'), 'new-log-a');
      // Simulate losing the first page's COMMIT acknowledgement and therefore
      // retaining null as the only durable caller cursor. The replay now sees
      // lower-sorting new IDs; it must not overwrite the newer trigger job.
      const replay = await runPostgresSharedUsageRepairBackfillPage(migrator, options());
      assert.deepEqual(replay, { scanned: 2, enqueued: 0,
        nextEarningId: 'earning-01', afterEarningId: null });
      assert.equal(await job(migrator, 'key-a'), 'new-log-a');
      assert.equal(await job(migrator, 'key-b'), 'log-02');
      stage('old-page-replay-cannot-overwrite-newer-trigger-job',
        { retainedRequestLog: await job(migrator, 'key-a') });

      const secondPage = await buildPostgresSharedUsageRepairBackfillPage(options(replay.nextEarningId));
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(secondPage.preflightSql).simple();
        const [inside] = await tx.unsafe(secondPage.batchSql);
        assert.deepEqual({ scanned: inside.scanned, enqueued: inside.enqueued,
          next: inside.next_earning_id },
        { scanned: 2, enqueued: 1, next: 'earning-03' });
        throw new Error('synthetic crash before page commit');
      }), /synthetic crash before page commit/);
      assert.equal(await jobCount(migrator), 2);
      const second = await runPostgresSharedUsageRepairBackfillPage(migrator,
        options(replay.nextEarningId));
      assert.deepEqual(second, { scanned: 2, enqueued: 1,
        nextEarningId: 'earning-03', afterEarningId: 'earning-01' });
      assert.equal(await jobCount(migrator), 3);
      stage('rolled-back-page-keeps-old-cursor-and-retry-enqueues-once', { second });

      const third = await runPostgresSharedUsageRepairBackfillPage(migrator,
        options(second.nextEarningId));
      assert.deepEqual(third, { scanned: 2, enqueued: 1,
        nextEarningId: 'earning-05', afterEarningId: 'earning-03' });
      assert.equal(await jobCount(migrator), 4);

      let releaseHolder, holderReady;
      const ready = new Promise(resolve => { holderReady = resolve; });
      const release = new Promise(resolve => { releaseHolder = resolve; });
      const holding = holder.begin(async tx => {
        await addEarning(tx, { id: '!late-c', key: 'key-c', log: 'new-log-c' });
        holderReady();
        await release;
      });
      await ready;
      let finished;
      try {
        finished = await runPostgresSharedUsageRepairBackfillPage(migrator,
          options(third.nextEarningId));
        assert.deepEqual(finished, { scanned: 0, enqueued: 0,
          nextEarningId: null, afterEarningId: 'earning-05' });
      } finally { releaseHolder(); await holding; }
      assert.equal(await job(migrator, 'key-c'), 'new-log-c');
      assert.equal(await jobCount(migrator), 5);
      stage('concurrent-low-sorting-earning-covered-only-by-live-trigger',
        { scannedAfterCursor: finished.scanned, liveJob: await job(migrator, 'key-c') });

      for (let i = 0; i < 5; i++) {
        assert.ok((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id);
      }
      assert.equal((await migrator.unsafe(`SELECT ${schema}.repair_one_shared_key_usage() AS id`))[0].id, null);
      assert.equal(await jobCount(migrator), 0);
      const diffs = await migrator.unsafe(`SELECT sk.id
        FROM ${schema}.shared_keys sk
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(input_tokens),0) AS input_tokens,
            COALESCE(sum(output_tokens),0) AS output_tokens,
            COALESCE(sum(net_amount),0) AS net_amount,
            max(created_at) AS last_used_at
          FROM ${schema}.shared_key_earnings e WHERE e.shared_key_id=sk.id
        ) totals ON true
        WHERE sk.served_input_tokens <> totals.input_tokens
          OR sk.served_output_tokens <> totals.output_tokens
          OR sk.earned_total <> totals.net_amount
          OR sk.last_used_at IS DISTINCT FROM totals.last_used_at`);
      assert.equal(diffs.length, 0);
      const [credit] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.shared_key_earnings) AS earnings,
        (SELECT count(*)::int FROM ${schema}.portal_ledger_entries
          WHERE kind='shared_key_earning') AS ledger,
        (SELECT balance_micros::text FROM ${schema}.user_earnings
          WHERE user_id='seller') AS balance`);
      assert.deepEqual(credit, { earnings: 7, ledger: 7, balance: '70000' });
      stage('all-five-key-projections-repaired-without-second-credit', { credit });
      report.status = 'PASS';
    } catch (error) {
      failure = error; report.status = 'FAIL'; report.error = errorSummary(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { report.cleanupDetails = await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key historical backfill report: ' + reportPath);
    }
    if (failure) throw failure;
  });
