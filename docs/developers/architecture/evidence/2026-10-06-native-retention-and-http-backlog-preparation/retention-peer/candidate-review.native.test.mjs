// Review-only PG18.6 receipt retention proof in an owned loopback cluster.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const gateway = 'cinatoken_gateway';
const outbox = 'cinatoken_economic_outbox';
const proposalDir = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation', 'reviewed-v2'],
  ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation', 'reviewed-v1'],
  ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation', 'reviewed-v1'],
  ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation', 'reviewed-v1'],
  ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-maintenance.sql', 'shared_key_buyer_receipt_maintenance_install', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-retention-v346.sql', 'shared_key_buyer_receipt_retention_install', 'reviewed-v1'],
];
const sha = text => createHash('sha256').update(text).digest('hex');
const client = (cluster, username, password, label) => postgres({
  host: '127.0.0.1', port: cluster.port, database: 'postgres',
  username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
  connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
  onnotice() {}, connection: { application_name: `buyer-receipt-retention-${label}` },
});
async function expectCode(promise, code, constraint) {
  await assert.rejects(promise, error => {
    const cause = error?.cause ?? error;
    assert.equal(cause?.code, code, String(cause));
    if (constraint) assert.equal(cause?.constraint_name, constraint, String(cause));
    return true;
  });
}

test('native PG18 buyer receipt retention starts only after committed-row observation',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-buyer-receipt-retention-v346-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only SQL and synthetic loopback facts; no production migration or cutoff is selected.',
        'Index plan is one local 20000-row synthetic shape, not production scale or lock-window proof.',
        'A zero SKIP LOCKED page is not a completion certificate; an independent census and retry are required.',
        'Admission, event, attempt, quote, and producer marker evidence is not pruned.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const quotePassword = randomBytes(24).toString('hex');
      const consumerPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${quotePassword}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${consumerPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,cinatoken_gateway_shared_quote_attempt_producer,
          cinatoken_gateway_shared_earning_consumer;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime',
        runtimePassword, 'runtime');
      const peer = client(cluster, 'cinatoken_gateway_migrator',
        migratorPassword, 'peer');
      clients.push(migrator, runtime, peer);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const formal = await listPg73Migrations();
      assert.equal(formal.length, 73);
      const corpus = [];
      for (const name of formal) {
        const body = await readFile(new URL(name, migrationDir), 'utf8');
        corpus.push(name + '\n' + body);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha(corpus.join('\n'));
      stage('formal-pg73-installed');
      await migrator.unsafe(`GRANT USAGE ON SCHEMA ${gateway} TO cinatoken_gateway_runtime;
        GRANT SELECT, UPDATE ON ${gateway}.api_keys,${gateway}.users,
          ${gateway}.guardrail_budget_windows TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT ON ${gateway}.api_key_request_logs
          TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT, UPDATE ON ${gateway}.public_model_daily_stats
          TO cinatoken_gateway_runtime;
        GRANT SELECT ON ${gateway}.guardrail_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT SELECT, INSERT, UPDATE ON ${gateway}.user_budget_reservations
          TO cinatoken_gateway_runtime;
        GRANT INSERT ON ${gateway}.user_audit_logs,
          ${gateway}.provider_attempt_availability TO cinatoken_gateway_runtime;
        INSERT INTO ${gateway}.users(id,email)
          VALUES('retention-buyer','buyer-retention@example.invalid');`).simple();
      for (const [name, marker, value] of proposals.slice(0, -1)) {
        const body = await readFile(new URL(name, proposalDir), 'utf8');
        report.sourceSha256[name] = sha(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${marker}='${value}'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('v344-receipt-and-v345-maintenance-installed-after-producer');

      const retentionName = proposals.at(-1)[0];
      const retention = await readFile(new URL(retentionName, proposalDir), 'utf8');
      report.sourceSha256[retentionName] = sha(retention);
      const install = () => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.${proposals.at(-1)[1]}='reviewed-v1'`);
        await tx.unsafe(retention).simple();
      });
      await expectCode(migrator.begin(tx => tx.unsafe(retention).simple()),
        '23514', 'shared_key_buyer_receipt_retention_install');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        pg_catalog.pg_attribute WHERE attrelid=
          '${outbox}.shared_key_buyer_budget_tx_receipts'::regclass
          AND attname='finalized_observed_at' AND NOT attisdropped`))[0].n, 0);
      stage('retention-install-default-off-and-transactional');
      let releaseInstallLock;
      let signalInstallLock;
      const installLockReady = new Promise(resolve => { signalInstallLock = resolve; });
      const installLockWait = new Promise(resolve => { releaseInstallLock = resolve; });
      const installLock = runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=
          budget_spent+0.000001 WHERE id='retention-buyer'`);
        signalInstallLock();
        await installLockWait;
        throw new Error('fixture rollback of lock holder');
      });
      await installLockReady;
      try {
        await expectCode(install(), '55P03');
        assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
          pg_catalog.pg_attribute WHERE attrelid=
            '${outbox}.shared_key_buyer_budget_tx_receipts'::regclass
            AND attname='finalized_observed_at' AND NOT attisdropped`))[0].n, 0);
      } finally {
        releaseInstallLock();
        await assert.rejects(installLock, /fixture rollback/u);
      }
      stage('busy-receipt-table-bounds-install-lock-wait-and-rolls-back');
      await install();
      await expectCode(runtime.unsafe(`SELECT ${outbox}.
        observe_buyer_budget_receipt_finalization(1)`), '42501');
      const run = (name, args) => migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_buyer_receipt_maintenance_run='reviewed-v1'`);
        return tx.unsafe(`SELECT ${outbox}.${name}(${args.map((_, i) => name === 'prune_buyer_budget_receipts' && i === 0 ? '$1::text::timestamptz' : `$${i + 1}`)
          .join(',')}) AS n`, args);
      });
      const observe = limit => run('observe_buyer_budget_receipt_finalization', [limit]);
      const prune = (before, limit) => run('prune_buyer_budget_receipts', [before, limit]);
      await expectCode(observe(1), '23514',
        'shared_key_buyer_receipt_retention_run');
      stage('maintenance-needs-valid-concurrent-indexes-and-denies-runtime');

      const indexBodies = [];
      for (const name of [
        'shared-key-buyer-budget-receipt-unobserved-index-v346.sql',
        'shared-key-buyer-budget-receipt-due-index-v346.sql',
      ]) {
        const body = await readFile(new URL(name, proposalDir), 'utf8');
        report.sourceSha256[name] = sha(body);
        indexBodies.push(body);
        await migrator.unsafe(body).simple();
      }
      report.indexDefinitions = (await migrator.unsafe(`SELECT c.relname,
        pg_catalog.pg_get_indexdef(c.oid) AS definition
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i
          ON i.indexrelid=c.oid
        WHERE c.relname IN (
          'shared_key_buyer_budget_receipts_unobserved_v346',
          'shared_key_buyer_budget_receipts_retention_due_v346')
        ORDER BY c.relname`)).map(({ relname,definition }) => ({ relname,definition }));
      assert.equal((await migrator.unsafe(`SELECT ${outbox}.
        buyer_receipt_retention_indexes_ready() AS ready`))[0].ready, true);
      stage('both-concurrent-partial-indexes-valid');
      await migrator.unsafe(`DROP INDEX ${outbox}.
        shared_key_buyer_budget_receipts_retention_due_v346`);
      await migrator.unsafe(`CREATE INDEX shared_key_buyer_budget_receipts_retention_due_v346
        ON ${outbox}.shared_key_buyer_budget_tx_receipts(user_id)
        WHERE finalized_observed_at IS NOT NULL`);
      assert.equal((await migrator.unsafe(`SELECT ${outbox}.
        buyer_receipt_retention_indexes_ready() AS ready`))[0].ready, false);
      await expectCode(observe(1), '23514',
        'shared_key_buyer_receipt_retention_run');
      await migrator.unsafe(`DROP INDEX ${outbox}.
        shared_key_buyer_budget_receipts_retention_due_v346`);
      await migrator.unsafe(indexBodies[1]).simple();
      assert.equal((await migrator.unsafe(`SELECT ${outbox}.
        buyer_receipt_retention_indexes_ready() AS ready`))[0].ready, true);
      stage('wrong-shape-same-name-index-fails-closed-until-rebuilt');

      let releaseLong;
      let signalLong;
      const longReady = new Promise(resolve => { signalLong = resolve; });
      const longWait = new Promise(resolve => { releaseLong = resolve; });
      const longTx = runtime.begin(async tx => {
        await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=
          budget_spent+0.000001 WHERE id='retention-buyer'`);
        const xid = (await tx.unsafe(`SELECT pg_catalog.pg_current_xact_id()::text AS xid`))[0].xid;
        signalLong(xid);
        await longWait;
      });
      const longXid = await longReady;
      const cutoffBeforeCommit = (await migrator.unsafe(`SELECT
        pg_catalog.clock_timestamp()::text AS at`))[0].at;
      try {
        assert.equal((await observe(1000))[0].n, 0);
      } finally {
        releaseLong();
        await longTx;
      }
      const firstSeen = (await migrator.unsafe(`SELECT first_seen_at<
        $1::text::timestamptz AS before_cutoff,finalized_observed_at IS NULL AS unobserved
        FROM ${outbox}.shared_key_buyer_budget_tx_receipts
        WHERE xact_id=$2::xid8 AND user_id='retention-buyer'`,
      [cutoffBeforeCommit, longXid]))[0];
      assert.equal(firstSeen.before_cutoff, true);
      assert.equal(firstSeen.unobserved, true);
      assert.equal((await prune(cutoffBeforeCommit, 1000))[0].n, 0);
      assert.equal((await observe(1000))[0].n, 1);
      assert.equal((await migrator.unsafe(`SELECT finalized_observed_at>
        $1::text::timestamptz AS after_commit_cutoff FROM
        ${outbox}.shared_key_buyer_budget_tx_receipts
        WHERE xact_id=$2::xid8 AND user_id='retention-buyer'`,
      [cutoffBeforeCommit, longXid]))[0].after_commit_cutoff, true);
      assert.equal((await prune(cutoffBeforeCommit, 1000))[0].n, 0);
      stage('long-transaction-insertion-age-cannot-shortcut-post-commit-retention');

      for (let i = 0; i < 2; i++) {
        await migrator.unsafe(`UPDATE ${gateway}.users SET budget_spent=
          budget_spent+0.000001 WHERE id='retention-buyer'`);
      }
      assert.equal((await observe(1))[0].n, 1);
      assert.equal((await observe(1))[0].n, 1);
      assert.equal((await observe(1))[0].n, 0);
      const due = (await migrator.unsafe(`SELECT pg_catalog.clock_timestamp()::text AS at`))[0].at;
      assert.equal((await prune(due, 1))[0].n, 1);
      assert.equal((await prune(due, 1))[0].n, 1);
      assert.equal((await prune(due, 1))[0].n, 1);
      assert.equal((await prune(due, 1))[0].n, 0);
      stage('observation-and-prune-pages-are-bounded');

      for (let i = 0; i < 2; i++) {
        await migrator.unsafe(`UPDATE ${gateway}.users SET budget_spent=
          budget_spent+0.000001 WHERE id='retention-buyer'`);
      }
      assert.equal((await observe(1000))[0].n, 2);
      // postgres-js binds timestamptz parameters at millisecond precision.
      await new Promise(resolve => setTimeout(resolve, 10));
      const lockDue = (await migrator.unsafe(`SELECT pg_catalog.clock_timestamp()::text AS at`))[0].at;
      const locked = (await migrator.unsafe(`SELECT xact_id::text AS xid,user_id
        FROM ${outbox}.shared_key_buyer_budget_tx_receipts
        ORDER BY xact_id,user_id LIMIT 1`))[0];
      let releaseLock;
      let signalLock;
      const lockReady = new Promise(resolve => { signalLock = resolve; });
      const lockWait = new Promise(resolve => { releaseLock = resolve; });
      const hold = peer.begin(async tx => {
        await tx.unsafe(`SELECT 1 FROM ${outbox}.
          shared_key_buyer_budget_tx_receipts WHERE xact_id=$1::xid8
          AND user_id=$2 FOR UPDATE`, [locked.xid, locked.user_id]);
        signalLock();
        await lockWait;
      });
      await lockReady;
      try {
        report.lockDebug = {
          cutoff: lockDue, locked,
          parsedCutoff: (await migrator.unsafe(`SELECT
            $1::text::timestamptz::text AS at`, [lockDue]))[0].at,
          candidates: await migrator.unsafe(`SELECT xact_id::text AS xid,user_id,
            finalized_observed_at::text AS observed_at,
            finalized_observed_at<$1::text::timestamptz AS before_cutoff,
            xact_id<pg_catalog.pg_snapshot_xmin(
              pg_catalog.pg_current_snapshot()) AS before_xmin
            FROM ${outbox}.shared_key_buyer_budget_tx_receipts
            ORDER BY xact_id,user_id`, [lockDue]),
        };
        assert.equal((await prune(lockDue, 1))[0].n, 1);
        assert.equal((await prune(lockDue, 1))[0].n, 0);
        assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
          ${outbox}.shared_key_buyer_budget_tx_receipts
          WHERE finalized_observed_at<$1::text::timestamptz`, [lockDue]))[0].n, 1);
      } finally {
        releaseLock();
        await hold;
      }
      assert.equal((await prune(lockDue, 1))[0].n, 1);
      stage('skip-locked-zero-page-requires-independent-census-and-retry');

      let releaseOlder;
      let signalOlder;
      const olderReady = new Promise(resolve => { signalOlder = resolve; });
      const olderWait = new Promise(resolve => { releaseOlder = resolve; });
      const older = runtime.begin(async tx => {
        const xid = (await tx.unsafe(`SELECT pg_catalog.pg_current_xact_id()::text AS xid`))[0].xid;
        signalOlder(xid);
        await olderWait;
      });
      const olderXid = await olderReady;
      try {
        const newerXid = await migrator.begin(async tx => {
          await tx.unsafe(`UPDATE ${gateway}.users SET budget_spent=
            budget_spent+0.000001 WHERE id='retention-buyer'`);
          return (await tx.unsafe(`SELECT pg_catalog.pg_current_xact_id()::text AS xid`))[0].xid;
        });
        assert.ok(BigInt(newerXid) > BigInt(olderXid));
        assert.equal((await observe(1000))[0].n, 0);
      } finally {
        releaseOlder();
        await older;
      }
      assert.equal((await observe(1000))[0].n, 1);
      stage('oldest-active-xid-fences-committed-newer-receipt');

      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${outbox}.shared_key_buyer_budget_tx_receipts
          (xact_id,user_id,budget_epoch,finalized_observed_at)
          SELECT pg_catalog.pg_current_xact_id(),'scale-'||s::text,0,
            CASE WHEN s<=10000 THEN pg_catalog.clock_timestamp()-interval '180 days'
              ELSE NULL END FROM pg_catalog.generate_series(1,20000) s`);
      });
      await migrator.unsafe(`ANALYZE ${outbox}.shared_key_buyer_budget_tx_receipts`);
      const xmin = (await migrator.unsafe(`SELECT pg_catalog.pg_snapshot_xmin(
        pg_catalog.pg_current_snapshot())::text AS xid`))[0].xid;
      const planCutoff = (await migrator.unsafe(`SELECT
        pg_catalog.clock_timestamp()::text AS at`))[0].at;
      const plans = [];
      for (const [query,params] of [
        [`SELECT xact_id,user_id FROM ${outbox}.shared_key_buyer_budget_tx_receipts
          WHERE finalized_observed_at IS NULL AND xact_id<$1::xid8
          ORDER BY xact_id,user_id FOR UPDATE SKIP LOCKED LIMIT 1000`, [xmin]],
        [`SELECT xact_id,user_id FROM ${outbox}.shared_key_buyer_budget_tx_receipts
          WHERE finalized_observed_at<$2::text::timestamptz
            AND xact_id<$1::xid8
          ORDER BY finalized_observed_at,xact_id,user_id
          FOR UPDATE SKIP LOCKED LIMIT 1000`, [xmin,planCutoff]],
      ]) {
        const plan = (await migrator.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params))[0]['QUERY PLAN'];
        plans.push(JSON.stringify(plan));
      }
      assert.match(plans[0], /shared_key_buyer_budget_receipts_unobserved_v346/u);
      assert.match(plans[1], /shared_key_buyer_budget_receipts_retention_due_v346/u);
      report.indexPlans = plans.map(text => JSON.parse(text));
      stage('local-20000-row-planner-uses-both-partial-indexes');
      report.sourceSha256.nativeTest = sha(await readFile(new URL(import.meta.url)));
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 3500) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`buyer-receipt-retention-v346-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });
