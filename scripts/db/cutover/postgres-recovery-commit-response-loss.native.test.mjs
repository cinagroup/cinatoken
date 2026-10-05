// Opt-in native PostgreSQL 17+ test. Only a new owned loopback cluster and a
// loopback wire proxy are used. GATEWAY_NATIVE_PG_BIN is mandatory.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
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

/**
 * Loss is injected at the PostgreSQL wire boundary. The proxy forwards the
 * client's COMMIT, observes the server's CommandComplete(COMMIT), independently
 * verifies the committed rows using another backend, then drops that server
 * frame and its ReadyForQuery by closing both sockets. No TCP ACK packet is
 * manipulated: this loses the PostgreSQL protocol response to COMMIT.
 * A later connection passes through unchanged for readback.
 */
async function startCommitResponseLossProxy(upstreamPort, verifyBackendCommit) {
  const peers = new Set();
  const observations = { connections: 0, commitFramesForwarded: 0,
    beginFramesForwarded: 0, commitResponsesDropped: 0,
    backendProofBeforeDisconnect: null, backendProofError: null };
  let armed = false, countFinancialFrames = false;
  let dropResolve;
  const dropped = new Promise(resolve => { dropResolve = resolve; });
  const server = createServer(downstream => {
    observations.connections++;
    const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort });
    peers.add(downstream); peers.add(upstream);
    downstream.on('close', () => { peers.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { peers.delete(upstream); downstream.destroy(); });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    let startup = true, fromClient = Buffer.alloc(0), fromServer = Buffer.alloc(0),
      commitPending = false, suppressServerResponse = false;
    downstream.on('data', chunk => {
      fromClient = Buffer.concat([fromClient, chunk]);
      while (true) {
        if (startup) {
          if (fromClient.length < 4) return;
          const size = fromClient.readUInt32BE(0);
          assert.ok(size >= 8 && size <= 1_048_576, 'Invalid startup frame');
          if (fromClient.length < size) return;
          upstream.write(fromClient.subarray(0, size));
          fromClient = fromClient.subarray(size);
          startup = false;
        }
        if (fromClient.length < 5) return;
        const size = fromClient.readUInt32BE(1);
        assert.ok(size >= 4 && size <= 64 * 1024 * 1024, 'Invalid client frame');
        if (fromClient.length < size + 1) return;
        const frame = fromClient.subarray(0, size + 1);
        fromClient = fromClient.subarray(size + 1);
        let query;
        if (frame[0] === 81) query = frame.toString('utf8', 5, frame.indexOf(0, 5)); // Q
        if (frame[0] === 80) { // P: statement name, then query
          const nameEnd = frame.indexOf(0, 5);
          query = frame.toString('utf8', nameEnd + 1, frame.indexOf(0, nameEnd + 1));
        }
        const normalizedQuery = query?.trim().toLowerCase();
        if (countFinancialFrames && normalizedQuery === 'begin') observations.beginFramesForwarded++;
        if (countFinancialFrames && normalizedQuery === 'commit') {
          observations.commitFramesForwarded++;
          if (armed) commitPending = true;
        }
        upstream.write(frame);
      }
    });
    upstream.on('data', chunk => {
      if (suppressServerResponse) return;
      fromServer = Buffer.concat([fromServer, chunk]);
      while (fromServer.length >= 5) {
        const size = fromServer.readUInt32BE(1);
        assert.ok(size >= 4 && size <= 64 * 1024 * 1024, 'Invalid server frame');
        if (fromServer.length < size + 1) return;
        const frame = fromServer.subarray(0, size + 1);
        fromServer = fromServer.subarray(size + 1);
        const command = frame[0] === 67 ? frame.toString('utf8', 5, frame.indexOf(0, 5)) : null; // C
        if (armed && commitPending && command === 'COMMIT') {
          armed = false;
          suppressServerResponse = true;
          observations.commitResponsesDropped++;
          void (async () => {
            try { observations.backendProofBeforeDisconnect = await verifyBackendCommit(); }
            catch (error) { observations.backendProofError = errorSummary(error); }
            downstream.destroy();
            upstream.destroy();
            dropResolve();
          })();
          return;
        }
        downstream.write(frame);
      }
    });
  });
  server.on('error', () => { for (const peer of peers) peer.destroy(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: server.address().port, observations, dropped,
    arm() { assert.equal(armed, false); armed = true; countFinancialFrames = true; },
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

async function main() {
  const cluster = await startNativePostgres();
  const reportFile = join(dirname(cluster.owned), 'report-commit-response-loss-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
    scope: 'owned loopback-only PG cluster and wire proxy; fixture migrator produces facts; NOLOGIN recovery via SET ROLE',
    lossMechanism: 'Proxy forwards COMMIT and withholds PostgreSQL CommandComplete(COMMIT) and ReadyForQuery; independent backend verifies rows before client connection is severed; no TCP ACK packets are manipulated',
    stages: [], sourceSha256: {} };
  for (const [key, url] of [
    ['nativeTest', new URL(import.meta.url)], ['rolePolicy', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
    ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)], ['guardSwitch', guardSwitch],
    ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
    ['recoveryJobs', new URL('../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts', import.meta.url)],
    ['migration0073', new URL('../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql', import.meta.url)],
    ['settlementRepository', new URL('../../../packages/core/src/storage/recovery/usage-settlement-postgres.ts', import.meta.url)],
    ['financialWriter', new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)],
  ]) report.sourceSha256[key] = createHash('sha256').update(await readFile(url)).digest('hex');
  const clients = [];
  let proxy;
  const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
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
    const migrator = localClient(cluster, 'cinatoken_gateway_migrator', password, 'tcp-migrator');
    clients.push(migrator);
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
      VALUES ('user','native-response-loss@example.invalid',10,1);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('workspace','personal','user','Native Response Loss','native-response-loss','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
      VALUES ('key','native-response-loss-key','user','workspace');`).simple();
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

    const value = sample(0.25);
    const recordedAtIso = new Date().toISOString();
    Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    value.recordedAtIso = recordedAtIso;
    Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
      budgetAccountedAt: recordedAtIso });
    value.params.requestLog.providerAttempts[0].observedAtIso = recordedAtIso;
    value.params.userId = 'user'; value.params.beforeSpent = 1;
    value.params.audit.apiKeyId = 'key'; value.params.audit.beforeSpent = 1;
    delete value.params.userBudgetSettlement;
    const producer = { driver: 'postgres', raw: migrator, drizzle: drizzle(migrator, { schema: pgCoreSchema }) };
    const intents = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
    const deadline = Number((await admin.unsafe(`SELECT
      (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS n`))[0].n);
    await intents.prepare(value.intent, deadline);
    assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
    const ref = await createUsageSettlementFactsRepositoryPostgres(producer).persist(value);
    stage('claimed-intent-and-fact', { requestId: ref.requestId });

    proxy = await startCommitResponseLossProxy(cluster.port, async () => {
      const [proof] = await admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='user') AS spent,
        (SELECT state FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`, [ref.requestId]);
      assert.deepEqual(proof, { receipts: 1, logs: 1,
        spent: '1.250000', job_state: 'committed' });
      return proof;
    });
    const wireRaw = cluster.client('response-loss-recovery', { throughPort: proxy.port, prepare: false });
    await wireRaw.unsafe('SET ROLE cinatoken_gateway_recovery');
    assert.equal((await wireRaw.unsafe('SELECT current_user AS role'))[0].role, 'cinatoken_gateway_recovery');
    // SET ROLE is session-local. Restore it explicitly on the new readback
    // connection after the proxy cuts the COMMIT connection. Financial writes
    // still run as the restricted NOLOGIN recovery role.
    const confirmationRoles = [];
    let observedCommitTransportError = null;
    const raw = { ...wireRaw, async unsafe(query, args) {
      if (String(query).includes('FROM cinatoken_gateway.request_usage_commit_receipts')) {
        await wireRaw.unsafe('SET ROLE cinatoken_gateway_recovery');
        confirmationRoles.push((await wireRaw.unsafe('SELECT current_user AS role'))[0].role);
      }
      return wireRaw.unsafe(query, args);
    }, async begin(...args) {
      try { return await wireRaw.begin(...args); }
      catch (error) {
        if (proxy.observations.commitResponsesDropped === 1) {
          observedCommitTransportError = errorSummary(error);
        }
        throw error;
      }
    } };
    const recovery = { driver: 'postgres', raw, drizzle: drizzle(raw, { schema: pgCoreSchema }) };
    const jobs = createUsageRecoveryJobsPostgres(recovery);
    assert.equal((await jobs.ensure(ref)).state, 'pending');
    const claim = await jobs.claim({ ref, revision: 0 }, 30);
    assert.equal(claim.status, 'claimed');
    const settlement = createUsageSettlementRepositoryPostgres(recovery);
    proxy.arm();
    assert.equal(await settlement.commit(ref, claim.lease.proof), 'committed');
    await proxy.dropped;
    assert.equal(proxy.observations.connections, 2);
    assert.equal(proxy.observations.beginFramesForwarded, 1);
    assert.equal(proxy.observations.commitFramesForwarded, 1);
    assert.equal(proxy.observations.commitResponsesDropped, 1);
    assert.equal(proxy.observations.backendProofError, null);
    assert.deepEqual(proxy.observations.backendProofBeforeDisconnect,
      { receipts: 1, logs: 1, spent: '1.250000', job_state: 'committed' });
    assert.ok(observedCommitTransportError, 'postgres.js must observe a real COMMIT transport error');
    assert.ok(confirmationRoles.length >= 2, 'Both initial and renewed confirmation use recovery role');
    assert.ok(confirmationRoles.every(role => role === 'cinatoken_gateway_recovery'));
    assert.equal((await wireRaw.unsafe('SELECT current_user AS role'))[0].role, 'cinatoken_gateway_recovery');
    const [durable] = await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
      (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
      (SELECT count(*)::int FROM ${schema}.provider_attempt_availability WHERE request_log_id=$1) AS attempts,
      (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE request_log_id=$1) AS audits,
      (SELECT budget_spent::text FROM ${schema}.users WHERE id='user') AS spent,
      (SELECT state FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`, [ref.requestId]);
    assert.deepEqual(durable, { receipts: 1, logs: 1, attempts: 1, audits: 1,
      spent: '1.250000', job_state: 'committed' });
    assert.equal(await settlement.commit(ref, claim.lease.proof), 'committed');
    const [replay] = await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
      (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
      (SELECT budget_spent::text FROM ${schema}.users WHERE id='user') AS spent`, [ref.requestId]);
    assert.deepEqual(replay, { receipts: 1, logs: 1, spent: '1.250000' });
    assert.equal(proxy.observations.beginFramesForwarded, 1,
      'Readback and replay must not start another financial transaction');
    assert.equal(proxy.observations.commitFramesForwarded, 1,
      'Readback and replay must not issue another COMMIT');
    stage('postgres-commit-response-withheld-and-reconciled', {
      ...proxy.observations, observedCommitTransportError,
      confirmationRoles, durableState: durable, replay });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.fatal = errorSummary(error);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
    try { if (proxy) await proxy.close(); await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log('Native PostgreSQL COMMIT response loss evidence: ' + reportFile);
    console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, stages: report.stages }, null, 2));
    assert.equal(report.cleanup, 'PASS', 'Owned proxy or cluster cleanup failed');
  }
}

test('native recovery role reconciles one charge after PostgreSQL COMMIT response is withheld',
  { timeout: 240_000 }, main);
