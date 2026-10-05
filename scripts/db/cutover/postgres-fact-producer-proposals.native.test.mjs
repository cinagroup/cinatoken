// Opt-in PostgreSQL 17+ check of two review-only producer proposals.
// Starts and removes only an owned loopback cluster; no ambient DATABASE_URL is used.
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
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const producerRole = 'cinatoken_gateway_fact_producer';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const intentProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const outboxProposal = new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url);

const selectIntent = [
  'request_id', 'attempt_index', 'user_id', 'api_key_id', 'workspace_id', 'operation',
  'context_sha256', 'state', 'revision', 'dispatch_claim_id', 'expires_at_ms',
  'created_at_ms', 'updated_at_ms', 'claimed_at_ms',
];
const insertIntent = [
  'request_id', 'attempt_index', 'user_id', 'api_key_id', 'workspace_id', 'operation',
  'context_sha256', 'expires_at_ms',
];
const selectFact = [
  'request_id', 'attempt_index', 'user_id', 'api_key_id', 'workspace_id', 'operation',
  'context_sha256', 'dispatch_claim_id', 'payload_sha256', 'payload_version',
  'payload_json', 'recorded_at', 'created_at_ms',
];
const insertFact = selectFact.filter(column => column !== 'created_at_ms');
const selectOutbox = ['request_id', 'payload_sha256', 'created_at_ms'];
const grantColumns = (privilege, columns, table) =>
  `GRANT ${privilege} (${columns.join(',')}) ON TABLE ${schema}.${table} TO ${producerRole};`;

function localClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForLock(admin, pid, expectedHolderPid, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [activity] = await admin.unsafe(`SELECT wait_event_type,wait_event,
      pg_catalog.pg_blocking_pids(pid)::text AS blockers,
      $2::integer=ANY(pg_catalog.pg_blocking_pids(pid)) AS held_by_expected_session
      FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`,
    [pid, expectedHolderPid]);
    if (activity?.held_by_expected_session === true) return activity;
    await delay(50);
  }
  throw new Error(`${label} did not reach a lock wait behind PID ${expectedHolderPid}`);
}

function errorSummary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 500) };
}

async function main() {
  const cluster = await startNativePostgres();
  const reportFile = join(dirname(cluster.owned), 'report-fact-producer-proposals-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
    scope: 'owned loopback-only PG fixture; two proposal SQL files outside formal migrations; synthetic NOLOGIN producer only',
    stages: [], sourceSha256: {} };
  for (const [key, url] of [
    ['nativeTest', new URL(import.meta.url)], ['intentProposal', intentProposal],
    ['outboxProposal', outboxProposal], ['guardSwitch', guardSwitch],
    ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
    ['intentRepository', new URL('../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts', import.meta.url)],
    ['factRepository', new URL('../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts', import.meta.url)],
  ]) report.sourceSha256[key] = createHash('sha256').update(await readFile(url)).digest('hex');
  const clients = [];
  const ownClient = (username, password, label) => {
    const client = localClient(cluster, username, password, label);
    clients.push(client); return client;
  };
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
      CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
      CREATE ROLE ${producerRole} NOLOGIN;
      CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, ${producerRole};`).simple();
    const migrator = ownClient('cinatoken_gateway_migrator', password, 'producer-migrator');
    const reassignment = ownClient('cinatoken_gateway_migrator', password, 'key-reassignment');
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
      VALUES ('user','native-producer@example.invalid',10,1);
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('workspace','personal','user','Native Producer','native-producer','active'),
        ('other-workspace','personal','user','Other Native','other-native','active');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
      VALUES ('key','native-producer-key','user','workspace');`).simple();
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(guardSwitch, 'utf8')).simple();
    });
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(intentProposal, 'utf8')).simple();
    });
    await migrator.begin(async tx => {
      await tx.unsafe("SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'");
      await tx.unsafe(await readFile(outboxProposal, 'utf8')).simple();
    });
    await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
    stage('optional-proposals-applied', { formalChainUntouched: true });

    await migrator.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${producerRole};
      ${grantColumns('SELECT', selectIntent, 'request_dispatch_intents')}
      ${grantColumns('INSERT', insertIntent, 'request_dispatch_intents')}
      ${grantColumns('UPDATE', ['state', 'revision', 'dispatch_claim_id'], 'request_dispatch_intents')}
      ${grantColumns('SELECT', selectFact, 'request_usage_settlements')}
      ${grantColumns('INSERT', insertFact, 'request_usage_settlements')}
      ${grantColumns('SELECT', selectOutbox, 'request_usage_settlement_outbox')}`).simple();
    const producerRaw = cluster.client('fact-producer-role');
    await producerRaw.unsafe(`SET ROLE ${producerRole}`);
    assert.equal((await producerRaw.unsafe('SELECT current_user AS role'))[0].role, producerRole);
    const producer = { driver: 'postgres', raw: producerRaw, drizzle: drizzle(producerRaw, { schema: pgCoreSchema }) };
    const intents = createDispatchIntentRepositoryPostgres(producer);
    const facts = createUsageSettlementFactsRepositoryPostgres(producer);
    const [acl] = await producerRaw.unsafe(`SELECT
      pg_catalog.has_table_privilege(current_user,'${schema}.api_keys','SELECT') AS key_select,
      pg_catalog.has_table_privilege(current_user,'${schema}.api_keys','UPDATE') AS key_update,
      pg_catalog.has_table_privilege(current_user,'${schema}.request_usage_settlement_outbox','INSERT') AS outbox_insert,
      pg_catalog.has_table_privilege(current_user,'${schema}.request_usage_settlements','UPDATE') AS fact_update,
      pg_catalog.has_function_privilege(current_user,
        '${schema}.guard_request_dispatch_intent()','EXECUTE') AS intent_guard_execute,
      pg_catalog.has_function_privilege(current_user,
        '${schema}.enqueue_usage_settlement_fact()','EXECUTE') AS enqueue_execute`);
    assert.deepEqual(acl, { key_select: false, key_update: false, outbox_insert: false,
      fact_update: false, intent_guard_execute: false, enqueue_execute: false });
    const [runtimeAcl] = await admin.unsafe(`SELECT
      pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
        '${schema}.guard_request_dispatch_intent()','EXECUTE') AS intent_guard_execute,
      pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
        '${schema}.enqueue_usage_settlement_fact()','EXECUTE') AS enqueue_execute`);
    assert.deepEqual(runtimeAcl, { intent_guard_execute: false, enqueue_execute: false });
    await assert.rejects(producerRaw.unsafe(`SELECT id FROM ${schema}.api_keys WHERE id='key'`),
      error => error.code === '42501');
    await assert.rejects(producerRaw.unsafe(`UPDATE ${schema}.api_keys SET status='disabled' WHERE id='key'`),
      error => error.code === '42501');
    await assert.rejects(producerRaw.unsafe(`INSERT INTO ${schema}.request_usage_settlement_outbox
      (request_id,payload_sha256,created_at_ms) VALUES ('unowned',repeat('a',64),1)`),
      error => error.code === '42501');
    stage('narrow-producer-acl', { currentUser: producerRole, ...acl, runtimeAclAfterGrantRerun: runtimeAcl,
      directDenials: ['api_keys SELECT', 'api_keys UPDATE', 'outbox INSERT'] });

    async function deadline() {
      const [row] = await admin.unsafe(`SELECT
        (floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 120000)::text AS ms`);
      return Number(row.ms);
    }
    function identity() {
      return { requestId: 'gen-' + randomUUID(), attemptIndex: 1, userId: 'user', apiKeyId: 'key',
        workspaceId: 'workspace', operation: 'images.generations', contextSha256: 'a'.repeat(64) };
    }
    {
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
      const prepared = await intents.prepare(value.intent, await deadline());
      assert.equal(prepared.state, 'prepared');
      assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
      const ref = await facts.persist(value);
      assert.deepEqual(await facts.load(ref), value);
      const [durable] = await admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_settlements WHERE request_id=$1) AS facts,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox WHERE request_id=$1) AS outbox,
        (SELECT state FROM ${schema}.request_dispatch_intents WHERE request_id=$1) AS intent_state,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='user') AS spent`, [ref.requestId]);
      assert.deepEqual(durable, { facts: 1, outbox: 1, intent_state: 'dispatch_claimed', spent: '1.000000' });
      stage('producer-intent-fact-outbox', { requestId: ref.requestId, durable,
        outboxInsertedByTriggerWithoutDirectGrant: true });
    }

    const producerPid = (await producerRaw.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    const reassignPid = (await reassignment.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    {
      const ref = identity();
      const held = deferred(), release = deferred();
      const producerTxn = producerRaw.begin(async tx => {
        const row = await createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: tx })
          .prepare(ref, await deadline());
        held.resolve();
        await release.promise;
        return row;
      });
      producerTxn.catch(error => held.reject(error));
      await held.promise;
      const update = reassignment.unsafe(`UPDATE ${schema}.api_keys
        SET workspace_id='other-workspace' WHERE id='key'`).then(rows => rows);
      let wait;
      try { wait = await waitForLock(admin, reassignPid, producerPid,
        'key reassignment behind producer'); }
      finally { release.resolve(); }
      assert.equal((await producerTxn).state, 'prepared');
      await update;
      assert.equal((await admin.unsafe(`SELECT workspace_id FROM ${schema}.api_keys WHERE id='key'`))[0].workspace_id,
        'other-workspace');
      assert.equal((await admin.unsafe(`SELECT workspace_id FROM ${schema}.request_dispatch_intents
        WHERE request_id=$1`, [ref.requestId]))[0].workspace_id, 'workspace');
      stage('intent-key-lock-first', { waitEvent: wait.wait_event, blockers: wait.blockers,
        heldByExpectedSession: wait.held_by_expected_session, committedOrder: 'intent before reassignment',
        historicalIntentWorkspace: 'workspace', currentKeyWorkspace: 'other-workspace' });
    }
    await migrator.unsafe(`UPDATE ${schema}.api_keys SET workspace_id='workspace' WHERE id='key'`);
    {
      const ref = identity();
      const held = deferred(), release = deferred();
      const updateTxn = reassignment.begin(async tx => {
        await tx.unsafe(`UPDATE ${schema}.api_keys SET workspace_id='other-workspace' WHERE id='key'`);
        held.resolve();
        await release.promise;
      });
      updateTxn.catch(error => held.reject(error));
      await held.promise;
      const prepare = intents.prepare(ref, await deadline());
      let wait;
      try { wait = await waitForLock(admin, producerPid, reassignPid,
        'producer behind key reassignment'); }
      finally { release.resolve(); }
      await updateTxn;
      await assert.rejects(prepare, /Dispatch intent persistence unconfirmed|scope mismatch/);
      const [count] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_intents
        WHERE request_id=$1`, [ref.requestId]);
      assert.equal(count.n, 0);
      stage('key-reassignment-lock-first', { waitEvent: wait.wait_event,
        blockers: wait.blockers, heldByExpectedSession: wait.held_by_expected_session,
        staleWorkspaceIntentRejected: true, committedIntents: count.n });
    }

    await producerRaw.unsafe('CREATE TEMP TABLE fake_dispatch_guard(id text)');
    await assert.rejects(producerRaw.unsafe(`CREATE TRIGGER fake_dispatch_guard
      BEFORE INSERT OR UPDATE ON pg_temp.fake_dispatch_guard FOR EACH ROW
      EXECUTE FUNCTION ${schema}.guard_request_dispatch_intent()`), error => error.code === '42501');
    await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${schema}.guard_request_dispatch_intent()
      TO ${producerRole}`);
    try {
      await producerRaw.unsafe(`CREATE TRIGGER fake_dispatch_guard
        BEFORE INSERT OR UPDATE ON pg_temp.fake_dispatch_guard FOR EACH ROW
        EXECUTE FUNCTION ${schema}.guard_request_dispatch_intent()`);
      await assert.rejects(producerRaw.unsafe("INSERT INTO pg_temp.fake_dispatch_guard(id) VALUES ('probe')"),
        /Dispatch intent guard relation or event mismatch/);
    } finally {
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION ${schema}.guard_request_dispatch_intent()
        FROM ${producerRole}`);
    }
    stage('intent-definer-temp-trigger', { attachmentWithoutExecuteDenied: true,
      misgrantStillFailsOnRelation: true });

    await producerRaw.unsafe('CREATE TEMP TABLE fake_outbox_guard(id text)');
    await assert.rejects(producerRaw.unsafe(`CREATE TRIGGER request_usage_settlements_enqueue
      AFTER INSERT ON pg_temp.fake_outbox_guard FOR EACH ROW
      EXECUTE FUNCTION ${schema}.enqueue_usage_settlement_fact()`), error => error.code === '42501');
    await migrator.unsafe(`GRANT EXECUTE ON FUNCTION ${schema}.enqueue_usage_settlement_fact()
      TO ${producerRole}`);
    try {
      await producerRaw.unsafe(`CREATE TRIGGER request_usage_settlements_enqueue
        AFTER INSERT ON pg_temp.fake_outbox_guard FOR EACH ROW
        EXECUTE FUNCTION ${schema}.enqueue_usage_settlement_fact()`);
      await assert.rejects(producerRaw.unsafe("INSERT INTO pg_temp.fake_outbox_guard(id) VALUES ('probe')"),
        /Settlement outbox enqueue relation or event mismatch/);
    } finally {
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION ${schema}.enqueue_usage_settlement_fact()
        FROM ${producerRole}`);
    }
    stage('outbox-definer-temp-trigger', { attachmentWithoutExecuteDenied: true,
      misgrantStillFailsOnRelation: true });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.fatal = errorSummary(error);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
    try { await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Native fact producer proposal evidence: ' + reportFile);
    console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, stages: report.stages }, null, 2));
    assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
  }
}

test('native narrow fact producer proposal and key reassignment lock orders',
  { timeout: 240_000 }, main);
