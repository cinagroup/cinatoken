// Opt-in cost and lock fixture. It owns a new loopback PostgreSQL cluster and
// never accepts an ambient database URL. Measurements describe this synthetic
// dataset only; they are not a production maintenance-window estimate.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
import { buildPostgresReplayReservationBackfill } from './build-postgres-replay-reservation-backfill.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_parent_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url)],
];
const reservationUrl = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url);
const gateUrl = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', import.meta.url);
const outputUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C03-postgres-native-replay-scale-lock-v333-report.json', import.meta.url);
const sha = body => createHash('sha256').update(body).digest('hex');
const errorSummary = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) });
const round = n => Math.round(n * 1000) / 1000;
const elapsed = start => round(performance.now() - start);
const id = number => `old-log-${String(number).padStart(8, '0')}`;
function planNodes(plan, result = []) {
  result.push({ type: plan['Node Type'], relation: plan['Relation Name'] ?? null,
    index: plan['Index Name'] ?? null });
  for (const child of plan.Plans ?? []) planNodes(child, result);
  return result;
}
async function explain(sql, query) {
  const [result] = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
  const data = result['QUERY PLAN'][0];
  return { executionMs: round(data['Execution Time']),
    nodes: planNodes(data.Plan), topSharedHitBlocks: data.Plan['Shared Hit Blocks'] ?? null };
}

function client(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0,
    connection: { application_name: `cinatoken-scale-${label}` }, onnotice() {} });
}

async function activate(sql, setting, url) {
  const body = await readFile(url, 'utf8');
  const start = performance.now();
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
    await tx.unsafe(body).simple();
  });
  return elapsed(start);
}

async function page(sql, cursor, limit) {
  const { batchSql } = buildPostgresReplayReservationBackfill({
    source: 'legacy_log', afterRequestId: cursor, limit });
  const start = performance.now();
  const [row] = await sql.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '2s'");
    await tx.unsafe("SET LOCAL statement_timeout = '15s'");
    return tx.unsafe(batchSql);
  });
  return { ...row, ms: elapsed(start) };
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

test('native PostgreSQL replay backfill scale, bounded lock and resume',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const rowCount = 25_000;
    const batchSize = 500;
    const report = {
      status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'fresh owned loopback PostgreSQL 18.6; 73 formal migrations; 25,000 nonempty legacy logs plus one empty ID; review-only proposals',
      limitations: [
        'Synthetic local timings do not establish a production data-size, hardware, traffic, collation or maintenance-window budget.',
        'No production lock wait, Worker, Queue, Hyperdrive or remote database was exercised.',
        'No deletion or archival is authorized; permanent replay reservations have unbounded growth pending reviewed policy.',
      ],
      fixture: { nonemptyRows: rowCount, emptyIdRows: 1, batchSize,
        listenAddress: '127.0.0.1', fsync: 'on', sharedBuffers: '16MB' },
      sourceSha256: {}, stages: [],
    };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const sql = client(cluster, password, 'migrator');
      const holder = client(cluster, password, 'holder');
      clients.push(sql, holder);
      await sql.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await sql.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha(corpus.join('\n'));
      for (const [name, url] of [
        ['nativeTest', new URL(import.meta.url)],
        ['reservationProposal', reservationUrl], ['parentGateProposal', gateUrl],
        ['backfillGenerator', new URL('./build-postgres-replay-reservation-backfill.mjs', import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
      ]) report.sourceSha256[name] = sha(await readFile(url));
      const [configuration] = await sql.unsafe(`SELECT
        (SELECT datcollate FROM pg_catalog.pg_database
          WHERE datname=pg_catalog.current_database()) AS collation,
        current_setting('shared_buffers') AS shared_buffers,
        current_setting('fsync') AS fsync`);
      report.fixture.configuration = configuration;
      stage('formal-schema-and-owned-postgresql-identity', { migrations: files.length, configuration });

      await sql.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('scale-user','scale@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('scale-space','personal','scale-user','Scale','scale-native','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('scale-key','scale-native-key','scale-user','scale-space');`).simple();
      const seedStart = performance.now();
      await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,request_operation)
        SELECT 'old-log-' || pg_catalog.lpad(n::text,8,'0'),
          'scale-user','scale-key','scale-space','images.generations'
        FROM pg_catalog.generate_series(1,$1::integer) AS n`, [rowCount]);
      // Formal 0001 permits an empty TEXT primary key. It is the smallest
      // possible legacy ID and must be included before any saved cursor.
      await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,request_operation)
        VALUES ('','scale-user','scale-key','scale-space','images.generations')`);
      const seedMs = elapsed(seedStart);
      const [sizeBefore] = await sql.unsafe(`SELECT
        pg_catalog.pg_total_relation_size('${schema}.api_key_request_logs'::regclass)::bigint AS log_bytes`);
      stage('synthetic-legacy-log-history-created', { rows: rowCount + 1, seedMs,
        logBytes: Number(sizeBefore.log_bytes) });
      await sql.unsafe(`ANALYZE ${schema}.api_key_request_logs`);
      stage('synthetic-log-planner-statistics-refreshed');

      for (const [setting, url] of proposals) await activate(sql, setting, url);
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
      await grantPg73RuntimeFixture({ cluster, migrator: sql, migratorUrl });
      stage('review-only-parent-and-runtime-default-acl-installed');

      await holder.unsafe('BEGIN');
      let expandWaitMs;
      try {
        await holder.unsafe(`LOCK TABLE ${schema}.api_key_request_logs IN ROW EXCLUSIVE MODE`);
        const start = performance.now();
        await assert.rejects(activate(sql,
          'cinatoken.request_dispatch_replay_reservations_activation', reservationUrl),
        error => error?.code === '55P03');
        expandWaitMs = elapsed(start);
      } finally { await holder.unsafe('ROLLBACK'); }
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_replay_tombstones') IS NULL AS absent`))[0].absent, true);
      const expandMs = await activate(sql,
        'cinatoken.request_dispatch_replay_reservations_activation', reservationUrl);
      stage('expand-lock-timeout-rolls-back-then-retries', { expandWaitMs, expandMs });

      const middle = id(Math.floor(rowCount / 2));
      const sample = buildPostgresReplayReservationBackfill({
        source: 'legacy_log', afterRequestId: middle, limit: batchSize });
      assert.match(sample.batchSql, /SELECT id AS request_id/);
      assert.doesNotMatch(sample.batchSql, /COLLATE|DISTINCT/);
      assert.match(buildPostgresReplayReservationBackfill({
        source: 'intent', afterRequestId: null, limit: batchSize }).batchSql,
      /SELECT DISTINCT request_id AS request_id/);
      const cursorSql = `'${middle}'`;
      const from = `FROM ${schema}.api_key_request_logs`;
      report.fixture.midpointPlans = {
        priorExplicitCAndDistinct: await explain(sql, `SELECT DISTINCT id COLLATE "C" AS request_id ${from}
          WHERE id COLLATE "C" > ${cursorSql} COLLATE "C" ORDER BY request_id LIMIT ${batchSize}`),
        explicitCWithoutDistinct: await explain(sql, `SELECT id COLLATE "C" AS request_id ${from}
          WHERE id COLLATE "C" > ${cursorSql} COLLATE "C" ORDER BY request_id LIMIT ${batchSize}`),
        nativeCollationWithDistinct: await explain(sql, `SELECT DISTINCT id AS request_id ${from}
          WHERE id > ${cursorSql} ORDER BY request_id LIMIT ${batchSize}`),
        generatedNativeKeyset: await explain(sql, `SELECT id AS request_id ${from}
          WHERE id > ${cursorSql} ORDER BY request_id LIMIT ${batchSize}`),
      };
      stage('native-collation-indexed-keyset-plan', { midpointPlans: report.fixture.midpointPlans });
      const firstPage = await page(sql, null, batchSize);
      assert.equal(firstPage.scanned, batchSize);
      assert.equal(firstPage.reserved, batchSize);
      assert.equal(firstPage.next_request_id, id(batchSize - 1));
      assert.equal((await sql.unsafe(`SELECT count(*)::integer AS n FROM
        ${schema}.request_dispatch_replay_tombstones WHERE request_id=''`))[0].n, 1);
      const afterEmpty = buildPostgresReplayReservationBackfill({
        source: 'legacy_log', afterRequestId: '', limit: 1 });
      assert.match(afterEmpty.batchSql, /WHERE id > pg_catalog\.convert_from/);
      const [afterEmptyPage] = await sql.unsafe(afterEmpty.batchSql);
      assert.equal(afterEmptyPage.next_request_id, id(1));
      assert.equal(afterEmptyPage.reserved, 0);
      stage('empty-legacy-id-included-and-empty-cursor-resumes-after-it',
        { firstPageLastId: firstPage.next_request_id, resumedNextId: afterEmptyPage.next_request_id });
      const cursor = firstPage.next_request_id;
      const [beforeRollback] = await sql.unsafe(`SELECT count(*)::integer AS n
        FROM ${schema}.request_dispatch_replay_tombstones`);
      await assert.rejects(sql.begin(async tx => {
        await tx.unsafe(sample.batchSql);
        throw new Error('deliberate page rollback');
      }), /deliberate page rollback/);
      const [afterRollback] = await sql.unsafe(`SELECT count(*)::integer AS n
        FROM ${schema}.request_dispatch_replay_tombstones`);
      assert.equal(afterRollback.n, beforeRollback.n);
      stage('first-batch-commits-and-interrupted-batch-rolls-back', {
        firstPage, savedCursor: cursor, rowsAfterRollback: afterRollback.n });

      // Simulate a process restart with only the last committed cursor saved.
      let nextCursor = cursor;
      let scanned = firstPage.scanned, reserved = firstPage.reserved;
      const pageMs = [firstPage.ms];
      let pages = 1;
      while (true) {
        const next = await page(sql, nextCursor, batchSize);
        pages++; pageMs.push(next.ms);
        if (!next.scanned) break;
        assert.ok(next.scanned <= batchSize);
        assert.ok(next.next_request_id > nextCursor);
        scanned += next.scanned; reserved += next.reserved;
        nextCursor = next.next_request_id;
      }
      assert.equal(scanned, rowCount + 1);
      assert.equal(reserved, rowCount + 1);
      assert.equal(nextCursor, id(rowCount));
      const sorted = [...pageMs].sort((a, b) => a - b);
      const [sizes] = await sql.unsafe(`SELECT
        pg_catalog.pg_total_relation_size('${schema}.api_key_request_logs'::regclass)::bigint AS log_bytes,
        pg_catalog.pg_total_relation_size('${schema}.request_dispatch_replay_tombstones'::regclass)::bigint AS reservation_bytes`);
      stage('bounded-resume-covers-all-history', { scanned, reserved, pages,
        savedCursor: cursor, finalCursor: nextCursor,
        pageMs: { min: sorted[0], median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95),
          max: sorted.at(-1), total: round(pageMs.reduce((a, b) => a + b, 0)) },
        relationBytes: { log: Number(sizes.log_bytes), reservation: Number(sizes.reservation_bytes) } });

      await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,request_operation)
        VALUES ('old-log-00000000','scale-user','scale-key','scale-space','images.generations')`);
      const [late] = await sql.unsafe(`SELECT count(*)::integer AS n
        FROM ${schema}.request_dispatch_replay_tombstones WHERE request_id='old-log-00000000'`);
      assert.equal(late.n, 1);
      stage('post-cursor-low-sorting-live-log-reserved', { late });

      await holder.unsafe('BEGIN');
      let gateWaitMs;
      try {
        await holder.unsafe(`LOCK TABLE ${schema}.api_key_request_logs IN ROW EXCLUSIVE MODE`);
        const start = performance.now();
        await assert.rejects(activate(sql,
          'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl),
        error => error?.code === '55P03');
        gateWaitMs = elapsed(start);
      } finally { await holder.unsafe('ROLLBACK'); }
      assert.equal((await sql.unsafe(`SELECT count(*)::integer AS n FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.request_dispatch_requests'::regclass
          AND tgname='request_dispatch_requests_replay_reserve'`))[0].n, 0);
      const gateMs = await activate(sql,
        'cinatoken.request_dispatch_replay_parent_gate_activation', gateUrl);
      assert.equal((await sql.unsafe(`SELECT count(*)::integer AS n FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.request_dispatch_requests'::regclass
          AND tgname='request_dispatch_requests_replay_reserve'`))[0].n, 1);
      stage('seven-source-gate-lock-timeout-rollback-and-retry', {
        gateWaitMs, gateMs, sourceTablesLocked: 7 });

      const [final] = await sql.unsafe(`SELECT
        (SELECT count(*)::integer FROM ${schema}.api_key_request_logs) AS logs,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_replay_tombstones) AS reservations`);
      assert.deepEqual(final, { logs: rowCount + 2, reservations: rowCount + 2 });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = errorSummary(error);
      failure = error;
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
      await writeFile(outputUrl, JSON.stringify(report, null, 2) + '\n');
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });
