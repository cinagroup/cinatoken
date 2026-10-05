// Review-only, opt-in native PostgreSQL fixture. Always creates its own private
// loopback cluster; no ambient DATABASE_URL, provider, remote SQL or deployment.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import postgres from 'postgres';
import { createPostgresPortalLedgerRepository } from '../../../packages/core/src/db/postgres/portal-marketplace.impl.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-projection-index.sql', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) });

function client(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-projection-${label}` } });
}

async function waitForLock(observer, label) {
  const until = performance.now() + 5_000;
  while (performance.now() < until) {
    const [activity] = await observer.unsafe(`SELECT wait_event_type, wait_event
      FROM pg_catalog.pg_stat_activity WHERE application_name=$1`, [`cinatoken-projection-${label}`]);
    if (activity?.wait_event_type === 'Lock') return activity.wait_event;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`${label} did not reach a PostgreSQL lock wait`);
}

async function plan(sql) {
  const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS)
    SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
      COALESCE(SUM(net_amount),0), MAX(created_at)
    FROM ${schema}.shared_key_earnings WHERE shared_key_id='projection-key-1'`);
  return rows.map(row => row['QUERY PLAN']).join('\n');
}

test('native PG18 shared-key projection index scale, bounded lock and multi-session rebuild',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-earning-projection-index-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18; 73 formal migrations, 10000 synthetic earnings, review-only index',
      stages: [], limitations: [
        'Synthetic data, local hardware and planner statistics do not predict a production build window.',
        'The index proposal is not a formal migration and was not deployed.',
        'This fixture covers the PG repository lock and index only; no durable repair scanner is installed.',
      ], sourceSha256: {} };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, password, 'migrator');
      const indexer = client(cluster, password, 'indexer');
      const blocker = client(cluster, password, 'blocker');
      const writer = client(cluster, password, 'writer');
      const repair = client(cluster, password, 'repair');
      clients.push(migrator, indexer, blocker, writer, repair);
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
      const proposalSql = await readFile(proposal, 'utf8');
      const createIndex = proposalSql.match(/^CREATE INDEX CONCURRENTLY[\s\S]*?;/mu)?.[0];
      assert.ok(createIndex);
      assert.ok(!/IF NOT EXISTS/u.test(createIndex));
      report.sourceSha256 = {
        formalMigrationCorpus: hash(corpus.join('\n')),
        indexProposal: hash(proposalSql),
        nativeTest: hash(await readFile(new URL(import.meta.url))),
      };
      stage('formal-schema-installed', { migrations: files.length });

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES
          ('projection-seller','projection-seller@example.invalid');
        INSERT INTO ${schema}.user_earnings(user_id) VALUES ('projection-seller');
        INSERT INTO ${schema}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('projection-workspace','personal','projection-seller','Projection','projection','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('projection-api-key','synthetic-key','projection-seller','projection-workspace');
        INSERT INTO ${schema}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint)
          SELECT 'projection-key-'||g,'projection-seller','openai','synthetic-'||g,'fingerprint-'||g
          FROM generate_series(0,199) AS g;
        INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
          SELECT 'projection-log-'||g,'projection-seller','projection-api-key','projection-workspace'
          FROM generate_series(1,10000) AS g;
        INSERT INTO ${schema}.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,net_amount,created_at)
          SELECT 'projection-earning-'||g,'projection-log-'||g,
            'projection-key-'||((g-1)%200),'projection-seller',g%17,g%23,0.01,
            '2026-09-24T00:00:00.000Z'::timestamptz
          FROM generate_series(1,10000) AS g;`).simple();
      await migrator.unsafe(`VACUUM (ANALYZE) ${schema}.shared_key_earnings`);
      const beforePlan = await plan(migrator);
      const [counts] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.shared_key_earnings) AS earnings,
        (SELECT count(*)::int FROM ${schema}.portal_ledger_entries
          WHERE kind='shared_key_earning') AS ledger`);
      assert.deepEqual(counts, { earnings: 10_000, ledger: 10_000 });
      stage('synthetic-earning-scale-baseline', { ...counts, beforePlan });

      let releaseBlocker, blockerReady;
      const blocked = new Promise(resolve => { blockerReady = resolve; });
      const held = new Promise(resolve => { releaseBlocker = resolve; });
      const blocking = blocker.begin(async tx => {
        await tx.unsafe(`LOCK TABLE ${schema}.shared_key_earnings IN ACCESS EXCLUSIVE MODE`);
        blockerReady();
        await held;
      });
      await blocked;
      await indexer.unsafe("SET lock_timeout = '500ms'");
      const started = performance.now();
      try {
        await assert.rejects(indexer.unsafe(createIndex), error => error?.code === '55P03');
      } finally {
        await indexer.unsafe('RESET lock_timeout');
        releaseBlocker();
        await blocking;
      }
      const blockedMs = Math.round(performance.now() - started);
      const [absent] = await migrator.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_class
        WHERE oid=pg_catalog.to_regclass('${schema}.idx_shared_key_earnings_key_projection')`);
      assert.equal(absent.n, 0);
      stage('exclusive-lock-timeout-leaves-no-index', { blockedMs });

      let releaseWriter, writerReady;
      const ready = new Promise(resolve => { writerReady = resolve; });
      const holdWriter = new Promise(resolve => { releaseWriter = resolve; });
      const writing = writer.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
          VALUES ('projection-log-index-writer','projection-seller','projection-api-key','projection-workspace');
          INSERT INTO ${schema}.shared_key_earnings
            (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,net_amount,created_at)
          VALUES ('projection-earning-index-writer','projection-log-index-writer',
            'projection-key-1','projection-seller',3,5,0.01,'2026-09-24T00:30:00Z');`).simple();
        writerReady();
        await holdWriter;
      });
      await ready;
      const indexStarted = performance.now();
      // postgres.js queries are lazy thenables: attaching a continuation sends
      // CREATE INDEX before the observer starts polling its lock wait.
      const building = indexer.unsafe(createIndex).then(() => null, error => error);
      let indexWait;
      let buildFailure;
      try { indexWait = await waitForLock(cluster.admin, 'indexer'); }
      finally { releaseWriter(); await writing; buildFailure = await building; }
      if (buildFailure) throw buildFailure;
      const buildMs = Math.round(performance.now() - indexStarted);
      const [index] = await migrator.unsafe(`SELECT i.indisvalid, i.indisready,
        pg_catalog.pg_relation_size(i.indexrelid)::bigint AS bytes
        FROM pg_catalog.pg_index AS i WHERE i.indexrelid=
          '${schema}.idx_shared_key_earnings_key_projection'::regclass`);
      assert.equal(index.indisvalid, true);
      assert.equal(index.indisready, true);
      await migrator.unsafe(`VACUUM (ANALYZE) ${schema}.shared_key_earnings`);
      const afterPlan = await plan(migrator);
      assert.match(afterPlan, /idx_shared_key_earnings_key_projection/u);
      stage('concurrent-index-build-waits-for-writer-then-validates', {
        indexWait, buildMs, indexBytes: Number(index.bytes), afterPlan,
      });

      let releaseEarning, earningReady;
      const earningInserted = new Promise(resolve => { earningReady = resolve; });
      const earningHeld = new Promise(resolve => { releaseEarning = resolve; });
      const earningWriter = writer.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
          VALUES ('projection-log-repair-writer','projection-seller','projection-api-key','projection-workspace');
          INSERT INTO ${schema}.shared_key_earnings
            (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,net_amount,created_at)
          VALUES ('projection-earning-repair-writer','projection-log-repair-writer',
            'projection-key-1','projection-seller',7,11,0.02,'2026-09-24T00:45:00Z');`).simple();
        earningReady();
        await earningHeld;
      });
      await earningInserted;
      const ledger = createPostgresPortalLedgerRepository({ driver: 'postgres', raw: repair, drizzle: {} });
      const rebuilding = ledger.rebuildSharedKeyUsageFromEarnings(
        'projection-log-2', 'projection-key-1', '2026-09-24T01:00:00Z')
        .then(() => null, error => error);
      let repairWait;
      let rebuildFailure;
      try { repairWait = await waitForLock(cluster.admin, 'repair'); }
      finally { releaseEarning(); await earningWriter; rebuildFailure = await rebuilding; }
      if (rebuildFailure) throw rebuildFailure;
      const [expected] = await migrator.unsafe(`SELECT sum(input_tokens)::text AS input,
        sum(output_tokens)::text AS output, sum(net_amount)::text AS net,
        max(created_at)::text AS last_used_at
        FROM ${schema}.shared_key_earnings WHERE shared_key_id='projection-key-1'`);
      const [actual] = await migrator.unsafe(`SELECT served_input_tokens::text AS input,
        served_output_tokens::text AS output, earned_total::text AS net,
        last_used_at::text AS last_used_at
        FROM ${schema}.shared_keys WHERE id='projection-key-1'`);
      assert.deepEqual(actual, expected);
      const [finalCounts] = await migrator.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.shared_key_earnings) AS earnings,
        (SELECT count(*)::int FROM ${schema}.portal_ledger_entries
          WHERE kind='shared_key_earning') AS ledger`);
      assert.deepEqual(finalCounts, { earnings: 10_002, ledger: 10_002 });
      stage('writer-first-commit-then-rebuild-includes-detail-once', {
        repairWait, projection: actual, ...finalCounts,
      });
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL'; report.error = errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorInfo(error); failure ??= error; }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key projection index report: ' + reportFile);
    }
    if (failure) throw failure;
  });
