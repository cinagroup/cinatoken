// Opt-in PostgreSQL 17+ failure/replay check. Uses only a new owned loopback cluster.
// GATEWAY_NATIVE_PG_BIN is required; no ambient DATABASE_URL is used.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createDispatchIntentRepositoryPostgres } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts';
import { createUsageRecoveryJobsPostgres } from '../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts';
import { createUsageSettlementRepositoryPostgres } from '../../../packages/core/src/storage/recovery/usage-settlement-postgres.ts';
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { buildPostgresRecoveryRoleSql } from './postgres-recovery-role-policy.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const nowMs = Date.parse('2026-09-23T10:00:00.000Z');
const roleFacts = {
  schemaVersion: 1, capturedAt: new Date(nowMs - 60_000).toISOString(),
  instance: { id: 'disposable_pg17_or_later', serverVersionNum: 170006,
    maxConnections: 50, superuserReservedConnections: 3, reservedConnections: 2,
    observedClientConnections: 12, observedClientConnectionsScope: 'all_databases',
    nonHyperdriveConnectionBudget: 5, safetyHeadroomConnections: 3 },
  inventory: { complete: true, scope: 'all_hyperdrives_on_instance', instanceId: 'disposable_pg17_or_later', origins: [
    { id: 'cinaauth', instanceId: 'disposable_pg17_or_later', roleName: 'cinaauth_runtime', originConnectionLimit: 15 },
    { id: 'gateway_runtime', instanceId: 'disposable_pg17_or_later', roleName: 'cinatoken_gateway_runtime', originConnectionLimit: 5 },
    { id: 'gateway_migrator', instanceId: 'disposable_pg17_or_later', roleName: 'cinatoken_gateway_migrator', originConnectionLimit: 5 },
  ] },
  recovery: { role: { name: 'cinatoken_gateway_recovery', login: false, connectionLimit: 2,
    timeoutDefaults: { transactionMs: 30_000, statementMs: 15_000, lockMs: 5_000,
      idleInTransactionMs: 10_000 } },
    hyperdrive: { id: 'gateway_recovery', instanceId: 'disposable_pg17_or_later', originConnectionLimit: 5 },
    peakConnectionsNeeded: 2, runBudgetMs: 60_000 },
};

function localClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}

function errorSummary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 500) };
}

async function main() {
  const cluster = await startNativePostgres();
  const reportFile = join(dirname(cluster.owned), 'report-recovery-financial-negative-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
    scope: 'owned loopback-only native fixture; fixture migrator produces facts; SET ROLE recovery; no production authorization',
    stages: [], sourceSha256: {} };
  for (const [key, url] of [
    ['nativeTest', new URL(import.meta.url)], ['rolePolicy', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
    ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)], ['guardSwitch', guardSwitch],
    ['settlementRepository', new URL('../../../packages/core/src/storage/recovery/usage-settlement-postgres.ts', import.meta.url)],
    ['financialWriter', new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)],
  ]) report.sourceSha256[key] = createHash('sha256').update(await readFile(url)).digest('hex');
  const clients = [];
  const ownClient = (username, password, label) => {
    const client = localClient(cluster, username, password, label);
    clients.push(client); return client;
  };
  const stage = (name, details) => report.stages.push({ name, result: 'PASS', ...details });
  try {
    const { admin } = cluster;
    const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
      current_setting('listen_addresses') AS listen_addresses`);
    assert.ok(server.version_num >= 170000);
    assert.equal(server.listen_addresses, '127.0.0.1');
    report.serverVersionNum = server.version_num;
    const password = randomBytes(24).toString('hex');
    await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
      CREATE ROLE cinatoken_gateway_runtime LOGIN;
      CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
    const migrator = ownClient('cinatoken_gateway_migrator', password, 'negative-migrator');
    const migratorUrl = `postgres://cinatoken_gateway_migrator:${password}@127.0.0.1:${cluster.port}/postgres`;
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
    stage('formal-migrations', { count: files.length });
    await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
    await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
      VALUES ('user','native-negative@example.invalid',10,1);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('workspace','personal','user','Native Negative','native-negative','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
      VALUES ('key','native-negative-key','user','workspace');`).simple();
    const plan = buildPostgresRecoveryRoleSql({ originBudgetFacts: roleFacts, nowMs });
    assert.equal(plan.runtimeCompatible, false);
    await admin.unsafe(plan.adminSql).simple();
    const guard = await readFile(guardSwitch, 'utf8');
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
      await tx.unsafe(guard).simple();
    });
    await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
    await migrator.unsafe(plan.migratorSql).simple();
    stage('role-and-guard', { login: false, runtimeCompatible: plan.runtimeCompatible });

    const producer = { driver: 'postgres', raw: migrator, drizzle: drizzle(migrator, { schema: pgCoreSchema }) };
    const recoveryRaw = cluster.client('financial-negative-role');
    await recoveryRaw.unsafe('SET ROLE cinatoken_gateway_recovery');
    assert.equal((await recoveryRaw.unsafe('SELECT current_user AS role'))[0].role, 'cinatoken_gateway_recovery');
    const recovery = { driver: 'postgres', raw: recoveryRaw, drizzle: drizzle(recoveryRaw, { schema: pgCoreSchema }) };
    const intents = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
    const facts = createUsageSettlementFactsRepositoryPostgres(producer);
    const jobs = createUsageRecoveryJobsPostgres(recovery);
    const settlement = createUsageSettlementRepositoryPostgres(recovery);

    async function snapshot(requestId) {
      const [row] = await admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
        (SELECT count(*)::int FROM ${schema}.provider_attempt_availability WHERE request_log_id=$1) AS attempts,
        (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE request_log_id=$1) AS audits,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='user') AS spent,
        (SELECT state FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job_state,
        (SELECT revision::text FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS revision`, [requestId]);
      return { ...row };
    }
    async function fixture(leaseSeconds = 30) {
      const value = sample(0.25);
      const recordedAtIso = new Date().toISOString();
      const spent = Number((await admin.unsafe(`SELECT budget_spent::text AS value
        FROM ${schema}.users WHERE id='user'`))[0].value);
      Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
      value.recordedAtIso = recordedAtIso;
      Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
        budgetAccountedAt: recordedAtIso });
      value.params.requestLog.providerAttempts[0].observedAtIso = recordedAtIso;
      value.params.userId = 'user'; value.params.beforeSpent = spent;
      value.params.audit.apiKeyId = 'key'; value.params.audit.beforeSpent = spent;
      delete value.params.userBudgetSettlement;
      const [clock] = await admin.unsafe(`SELECT
        (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS deadline`);
      await intents.prepare(value.intent, Number(clock.deadline));
      assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
      const ref = await facts.persist(value);
      assert.equal((await jobs.ensure(ref)).state, 'pending');
      const claim = await jobs.claim({ ref, revision: 0 }, leaseSeconds);
      assert.equal(claim.status, 'claimed');
      return { ref, lease: claim.lease };
    }
    function wrapped({ beforeCommit, afterCommit }) {
      const raw = { ...recoveryRaw, async begin(run) {
        const result = await recoveryRaw.begin(async tx => {
          assert.equal((await tx.unsafe('SELECT current_user AS role'))[0].role,
            'cinatoken_gateway_recovery');
          const value = await run(tx);
          await beforeCommit?.(tx);
          return value;
        });
        await afterCommit?.();
        return result;
      } };
      return createUsageSettlementRepositoryPostgres({ driver: 'postgres', raw,
        drizzle: drizzle(raw, { schema: pgCoreSchema }) });
    }

    {
      const { ref, lease } = await fixture();
      assert.equal(await settlement.commit(ref, lease.proof), 'committed');
      const committed = await snapshot(ref.requestId);
      assert.deepEqual(committed, { receipts: 1, logs: 1, attempts: 1, audits: 1,
        spent: '1.250000', job_state: 'committed', revision: '2' });
      assert.equal(await settlement.commit(ref, lease.proof), 'committed');
      assert.deepEqual(await snapshot(ref.requestId), committed);
      assert.equal(await jobs.fail(lease, 'execution_error'), 'not_owned');
      stage('same-receipt-replay', { requestId: ref.requestId,
        result: 'PASS', durableState: committed });
    }
    {
      const { ref, lease } = await fixture(1);
      const before = await snapshot(ref.requestId);
      await admin.unsafe('SELECT pg_sleep(1.1)');
      await assert.rejects(settlement.commit(ref, lease.proof));
      assert.deepEqual(await snapshot(ref.requestId), before);
      const next = await jobs.claim({ ref, revision: lease.revision }, 30);
      assert.equal(next.status, 'claimed');
      assert.equal(await settlement.commit(ref, next.lease.proof), 'committed');
      const committed = await snapshot(ref.requestId);
      assert.deepEqual(committed, { receipts: 1, logs: 1, attempts: 1, audits: 1,
        spent: '1.500000', job_state: 'committed', revision: '3' });
      assert.equal(await settlement.commit(ref, lease.proof), 'committed');
      assert.deepEqual(await snapshot(ref.requestId), committed);
      stage('expired-lease-and-new-claim', { requestId: ref.requestId,
        expiredProofWroteNothing: true, oldProofAfterCommitReadOnly: true, durableState: committed });
    }
    {
      const { ref, lease } = await fixture();
      const before = await snapshot(ref.requestId);
      await assert.rejects(wrapped({ beforeCommit() { throw new Error('injected pre-COMMIT failure'); } })
        .commit(ref, lease.proof), /injected pre-COMMIT failure/);
      assert.deepEqual(await snapshot(ref.requestId), before);
      assert.equal(await settlement.commit(ref, lease.proof), 'committed');
      const committed = await snapshot(ref.requestId);
      assert.deepEqual(committed, { receipts: 1, logs: 1, attempts: 1, audits: 1,
        spent: '1.750000', job_state: 'committed', revision: '2' });
      stage('pre-commit-rollback', { requestId: ref.requestId,
        injectedFailureWroteNothing: true, subsequentCommit: committed });
    }
    {
      const { ref, lease } = await fixture();
      let committed = false;
      // This throws after postgres.js has acknowledged COMMIT. It tests the
      // application's lost result/readback path, not a dropped TCP COMMIT ACK.
      assert.equal(await wrapped({ afterCommit() { committed = true; throw new Error('injected application result loss'); } })
        .commit(ref, lease.proof), 'committed');
      assert.equal(committed, true);
      const durable = await snapshot(ref.requestId);
      assert.deepEqual(durable, { receipts: 1, logs: 1, attempts: 1, audits: 1,
        spent: '2.000000', job_state: 'committed', revision: '2' });
      assert.equal(await settlement.commit(ref, lease.proof), 'committed');
      assert.deepEqual(await snapshot(ref.requestId), durable);
      stage('post-commit-application-result-loss', { requestId: ref.requestId,
        readbackConfirmedSingleCommit: true, durableState: durable });
    }
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.fatal = errorSummary(error);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
    try { await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Native financial negative evidence: ' + reportFile);
    console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, stages: report.stages }, null, 2));
    assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
  }
}

test('native recovery role financial replay and failures leave one durable result',
  { timeout: 240_000 }, main);
