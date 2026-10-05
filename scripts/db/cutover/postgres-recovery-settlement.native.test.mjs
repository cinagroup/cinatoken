// Opt-in PostgreSQL 17+ check: starts and removes an owned loopback-only cluster.
// GATEWAY_NATIVE_PG_BIN must point to local binaries; no ambient database URL is used.
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
import { createPostgresGuardrailBudgetsRepository } from '../../../packages/core/src/db/postgres/guardrail-budgets.impl.ts';
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { buildPostgresRecoveryRoleSql } from '../../../scripts/db/cutover/postgres-recovery-role-policy.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('../../../scripts/db/cutover/postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const nowMs = Date.parse('2026-09-23T10:00:00.000Z');
const sha256 = body => createHash('sha256').update(body).digest('hex');
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

function summarizeError(error) {
  const chain = [];
  for (let x = error, depth = 0; x && depth < 4; x = x.cause, depth++) {
    chain.push({ name: x.name, code: x.code ?? null, message: String(x.message ?? '').slice(0, 500),
      table: x.table_name ?? null, column: x.column_name ?? null, constraint: x.constraint_name ?? null });
  }
  return chain;
}

function guardrailIntent(scopeType, periodStart, periodEnd) {
  const id = scopeType === 'workspace' ? 'workspace-budget:budget'
    : scopeType === 'api_key' ? 'gateway-key-limit:key' : 'assignment';
  return { workspaceId: 'workspace', assignmentId: id,
    guardrailId: scopeType === 'user' ? 'guardrail' : id,
    guardrailVersion: 1, scopeType,
    scopeId: scopeType === 'user' ? 'user' : scopeType === 'api_key' ? 'key' : 'workspace',
    period: 'daily', periodStart, periodEnd,
    limitMicros: scopeType === 'user' ? 1000000 : scopeType === 'api_key' ? 3000000 : 2000000 };
}

async function main() {
  const cluster = await startNativePostgres();
  const reportFile = join(dirname(cluster.owned), 'report-recovery-settlement-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', binaryVersion: cluster.binaryVersion,
    node: process.version,
    scope: 'owned loopback-only native fixture; synthetic identities; fixture migrator produces facts; no production producer or authorization',
    stages: [], cleanup: 'PENDING', sourceSha256: {} };
  for (const [key, url] of [
    ['nativeTest', new URL(import.meta.url)],
    ['rolePolicy', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
    ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
    ['guardSwitch', guardSwitch],
    ['migration0068', new URL('../../../packages/core/migrations-postgres/0068_function_schema_resolution.sql', import.meta.url)],
    ['migration0073', new URL('../../../packages/core/migrations-postgres/0073_recovery_api_key_workspace_lock.sql', import.meta.url)],
    ['criticalWriter', new URL('../../../packages/core/src/db/postgres/critical-writes.impl.ts', import.meta.url)],
    ['settlementRepository', new URL('../../../packages/core/src/storage/recovery/usage-settlement-postgres.ts', import.meta.url)],
    ['recoveryJobs', new URL('../../../packages/core/src/storage/recovery/usage-recovery-jobs-postgres.ts', import.meta.url)],
  ]) report.sourceSha256[key] = sha256(await readFile(url));
  const clients = [];
  const ownClient = (user, password, label) => {
    const result = localClient(cluster, user, password, label); clients.push(result); return result;
  };
  const stage = (name, result, extra = {}) => report.stages.push({ name, result, ...extra });
  try {
    const { admin } = cluster;
    const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
      current_setting('listen_addresses') AS listen_addresses`);
    assert.ok(server.version_num >= 170000, 'Native fixture requires PostgreSQL 17 or later');
    assert.equal(server.listen_addresses, '127.0.0.1');
    report.serverVersionNum = server.version_num;
    const migratorPassword = randomBytes(24).toString('hex');
    const runtimePassword = randomBytes(24).toString('hex');
    await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
      CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
      CREATE SCHEMA cinatoken_gateway AUTHORIZATION cinatoken_gateway_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
    const migrator = ownClient('cinatoken_gateway_migrator', migratorPassword, 'migrator');
    const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
    await migrator.unsafe(`CREATE TABLE cinatoken_gateway.schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = await listPg73Migrations();
    assert.equal(files.length, 73);
    for (const name of files) {
      const body = await readFile(new URL(name, migrations), 'utf8');
      await migrator.begin(async tx => {
        await tx.unsafe(body).simple();
        await tx.unsafe('INSERT INTO cinatoken_gateway.schema_migrations(version) VALUES ($1)', [name]);
      });
    }
    stage('formal-migrations', 'PASS', { count: files.length });
    await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
    await migrator.unsafe(`INSERT INTO cinatoken_gateway.users(id,email,budget_max,budget_spent)
      VALUES ('user','native-financial@example.invalid',10,1),
        ('other','native-shadow@example.invalid',10,0);
      INSERT INTO cinatoken_gateway.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('workspace','personal','user','Native Financial','native-financial','active'),
        ('other-workspace','personal','other','Native Shadow','native-shadow','active');
      INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id)
      VALUES ('key','native-financial-key','user','workspace');`).simple();
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
    stage('role-and-guard', 'PASS', { login: false, runtimeCompatible: plan.runtimeCompatible });

    const producer = { driver: 'postgres', raw: migrator, drizzle: drizzle(migrator, { schema: pgCoreSchema }) };
    const recoveryRaw = cluster.client('financial-role');
    await recoveryRaw.unsafe('SET ROLE cinatoken_gateway_recovery');
    assert.equal((await recoveryRaw.unsafe('SELECT current_user AS role'))[0].role, 'cinatoken_gateway_recovery');
    const [roleAcl] = await recoveryRaw.unsafe(`SELECT
      pg_catalog.has_table_privilege(current_user,'cinatoken_gateway.api_keys','UPDATE') AS key_update,
      pg_catalog.has_table_privilege(current_user,'cinatoken_gateway.api_key_request_logs','UPDATE') AS log_update,
      pg_catalog.has_table_privilege(current_user,'cinatoken_gateway.api_key_request_logs','INSERT') AS log_insert,
      pg_catalog.has_table_privilege(current_user,'cinatoken_gateway.request_usage_settlements','INSERT') AS fact_insert,
      pg_catalog.has_table_privilege(current_user,'cinatoken_gateway.request_usage_commit_receipts','INSERT') AS receipt_insert,
      pg_catalog.has_table_privilege(current_user,'cinatoken_gateway.request_usage_recovery_jobs','INSERT') AS job_insert`);
    assert.deepEqual(roleAcl, { key_update: false, log_update: false, log_insert: true,
      fact_insert: false, receipt_insert: true, job_insert: true });
    await assert.rejects(recoveryRaw.unsafe(`UPDATE cinatoken_gateway.api_keys
      SET status='disabled' WHERE id='key'`), error => error.code === '42501');
    await assert.rejects(recoveryRaw.unsafe(`UPDATE cinatoken_gateway.api_key_request_logs
      SET status='failed' WHERE id='absent'`), error => error.code === '42501');
    stage('post-set-role-acl', 'PASS', { currentUser: 'cinatoken_gateway_recovery', ...roleAcl,
      directKeyAndLogUpdatesRejected: true });
    const recovery = { driver: 'postgres', raw: recoveryRaw, drizzle: drizzle(recoveryRaw, { schema: pgCoreSchema }) };
    const value = sample(0.25);
    Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    const recordedAtIso = new Date().toISOString();
    value.recordedAtIso = recordedAtIso;
    Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
      budgetAccountedAt: recordedAtIso });
    value.params.requestLog.providerAttempts[0].observedAtIso = recordedAtIso;
    value.params.userId = 'user'; value.params.beforeSpent = 1;
    value.params.audit.apiKeyId = 'key'; value.params.audit.beforeSpent = 1;
    delete value.params.userBudgetSettlement;
    const intents = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
    const deadline = Number((await admin.unsafe(`SELECT
      (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS n`))[0].n);
    await intents.prepare(value.intent, deadline);
    assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
    const facts = createUsageSettlementFactsRepositoryPostgres(producer);
    const ref = await facts.persist(value);
    stage('claimed-intent-and-fact', 'PASS', { requestId: ref.requestId });

    const recoveryJobs = createUsageRecoveryJobsPostgres(recovery);
    let lease;
    try {
      const ensured = await recoveryJobs.ensure(ref);
      assert.equal(ensured.state, 'pending');
      stage('recovery-role-ensure', 'PASS');
    } catch (error) {
      stage('recovery-role-ensure', 'FAIL', { error: summarizeError(error) });
    }
    const jobRows = await admin.unsafe('SELECT state,revision,attempts FROM cinatoken_gateway.request_usage_recovery_jobs WHERE request_id=$1', [ref.requestId]);
    if (jobRows.length === 0) {
      const producerJobs = createUsageRecoveryJobsPostgres(producer);
      await producerJobs.ensure(ref);
      stage('fixture-owner-ensure-fallback', 'PASS');
    }
    try {
      const claimed = await recoveryJobs.claim({ ref, revision: 0 }, 30);
      assert.equal(claimed.status, 'claimed');
      lease = claimed.lease;
      stage('recovery-role-claim', 'PASS');
    } catch (error) {
      stage('recovery-role-claim', 'FAIL', { error: summarizeError(error) });
    }
    if (!lease) {
      const job = (await admin.unsafe('SELECT state,revision,attempts FROM cinatoken_gateway.request_usage_recovery_jobs WHERE request_id=$1', [ref.requestId]))[0];
      if (job.state !== 'pending' || Number(job.revision) !== 0) throw new Error('Recovery claim outcome is ambiguous; no fallback');
      const producerJobs = createUsageRecoveryJobsPostgres(producer);
      const claimed = await producerJobs.claim({ ref, revision: 0 }, 30);
      assert.equal(claimed.status, 'claimed');
      lease = claimed.lease;
      stage('fixture-owner-claim-fallback', 'PASS');
    }
    const settlement = createUsageSettlementRepositoryPostgres(recovery);
    try {
      const result = await settlement.commit(ref, lease.proof);
      assert.equal(result, 'committed');
      stage('recovery-role-financial-commit', 'PASS');
    } catch (error) {
      stage('recovery-role-financial-commit', 'FAIL', { error: summarizeError(error) });
    }
    const final = (await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM cinatoken_gateway.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
      (SELECT count(*)::int FROM cinatoken_gateway.api_key_request_logs WHERE id=$1) AS logs,
      (SELECT count(*)::int FROM cinatoken_gateway.user_audit_logs WHERE request_log_id=$1) AS audits,
      (SELECT budget_spent::text FROM cinatoken_gateway.users WHERE id='user') AS spent,
      (SELECT state FROM cinatoken_gateway.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`, [ref.requestId]))[0];
    assert.deepEqual(final, { receipts: 1, logs: 1, audits: 1,
      spent: '1.250000', job_state: 'committed' });
    stage('unreserved-final-durable-state', 'PASS', { final });

    // A caller-controlled search_path and temporary table must not override
    // the real key association inside the legacy workspace trigger.
    const [workspaceGuard] = await admin.unsafe(`SELECT p.proconfig[1] AS search_path, p.prosecdef
      FROM pg_catalog.pg_proc p WHERE p.oid =
        'cinatoken_gateway.enforce_request_log_workspace()'::regprocedure`);
    assert.equal(workspaceGuard.search_path, 'search_path=pg_catalog, cinatoken_gateway, pg_temp');
    assert.equal(workspaceGuard.prosecdef, false);
    const mismatch = `INSERT INTO cinatoken_gateway.api_key_request_logs
      (id,user_id,api_key_id,workspace_id,request_operation,status)
      VALUES ($1,'user','key','other-workspace','images.generations','success')`;
    const ordinary = ownClient('cinatoken_gateway_runtime', runtimePassword, 'shadow-ordinary');
    await ordinary.unsafe('CREATE TEMP TABLE api_keys(id text PRIMARY KEY, workspace_id text)');
    await ordinary.unsafe("INSERT INTO api_keys(id,workspace_id) VALUES ('key','other-workspace')");
    await ordinary.unsafe('SET search_path TO pg_temp, cinatoken_gateway, pg_catalog');
    await assert.rejects(ordinary.unsafe(mismatch, ['ordinary-shadow']),
      error => error.code === '23503' && /request_log_workspace_mismatch/.test(error.message));
    stage('ordinary-temp-key-shadow', 'PASS', { tempCreated: true, rejectedSqlstate: '23503' });
    await recoveryRaw.unsafe('CREATE TEMP TABLE api_keys(id text PRIMARY KEY, workspace_id text)');
    await recoveryRaw.unsafe("INSERT INTO api_keys(id,workspace_id) VALUES ('key','other-workspace')");
    await recoveryRaw.unsafe('SET search_path TO pg_temp, cinatoken_gateway, pg_catalog');
    await assert.rejects(recoveryRaw.unsafe(mismatch, ['recovery-shadow']),
      error => error.code === '23503' && /request_log_workspace_mismatch/.test(error.message));
    stage('recovery-temp-key-shadow', 'PASS', { tempCreated: true, rejectedSqlstate: '23503' });
    await recoveryRaw.unsafe('SET search_path TO pg_catalog, cinatoken_gateway, pg_temp');
    assert.equal((await admin.unsafe(`SELECT count(*)::int AS n FROM cinatoken_gateway.api_key_request_logs
      WHERE id IN ('ordinary-shadow','recovery-shadow')`))[0].n, 0);

    // These five functions are reached only through existing triggers. Verify
    // native trigger execution after removing direct EXECUTE from recovery.
    const triggerOnly = [
      'guard_usage_recovery_job()', 'guard_usage_commit_receipt()',
      'check_usage_commit_transaction()', 'guard_fact_owned_usage_log()',
      'guard_fact_without_legacy_log()',
    ];
    for (const signature of triggerOnly) {
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION cinatoken_gateway.${signature}
        FROM cinatoken_gateway_recovery`);
      assert.equal((await admin.unsafe(`SELECT pg_catalog.has_function_privilege(
        'cinatoken_gateway_recovery', $1::regprocedure, 'EXECUTE') AS can_execute`,
      [`cinatoken_gateway.${signature}`]))[0].can_execute, false);
    }
    stage('trigger-only-execute-revoked', 'PASS', { functions: triggerOnly });
    const reduced = sample(0.25);
    const reducedIso = new Date().toISOString();
    const beforeReduced = Number((await admin.unsafe(`SELECT budget_spent::text AS spent
      FROM cinatoken_gateway.users WHERE id='user'`))[0].spent);
    Object.assign(reduced.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    reduced.recordedAtIso = reducedIso;
    Object.assign(reduced.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
      budgetAccountedAt: reducedIso });
    reduced.params.requestLog.providerAttempts[0].observedAtIso = reducedIso;
    reduced.params.userId = 'user'; reduced.params.beforeSpent = beforeReduced;
    reduced.params.audit.apiKeyId = 'key'; reduced.params.audit.beforeSpent = beforeReduced;
    delete reduced.params.userBudgetSettlement;
    await intents.prepare(reduced.intent, Number((await admin.unsafe(`SELECT
      (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS n`))[0].n));
    assert.equal(await intents.claim(reduced.intent, 0, reduced.dispatchClaimId), 'granted');
    const reducedRef = await facts.persist(reduced);
    assert.equal((await recoveryJobs.ensure(reducedRef)).state, 'pending');
    const reducedClaim = await recoveryJobs.claim({ ref: reducedRef, revision: 0 }, 30);
    assert.equal(reducedClaim.status, 'claimed');
    try {
      assert.equal(await settlement.commit(reducedRef, reducedClaim.lease.proof), 'committed');
      stage('recovery-role-commit-without-trigger-execute', 'PASS');
    } catch (error) {
      stage('recovery-role-commit-without-trigger-execute', 'FAIL', { error: summarizeError(error) });
    }
    const reducedFinal = (await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM cinatoken_gateway.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
      (SELECT count(*)::int FROM cinatoken_gateway.api_key_request_logs WHERE id=$1) AS logs,
      (SELECT state FROM cinatoken_gateway.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`,
    [reducedRef.requestId]))[0];
    assert.deepEqual(reducedFinal, { receipts: 1, logs: 1, job_state: 'committed' });
    stage('trigger-revocation-final-state', 'PASS', { final: reducedFinal });

    // Exercise both existing reservation ledgers as well as the ordinary buyer,
    // log, statistics and audit writes in a second financial transaction.
    await migrator.unsafe(`INSERT INTO cinatoken_gateway.guardrails
        (id,owner_user_id,workspace_id,name,status)
        VALUES ('guardrail','user','workspace','Guardrail','active');
      INSERT INTO cinatoken_gateway.guardrail_assignments
        (id,guardrail_id,workspace_id,scope_type,scope_id)
        VALUES ('assignment','guardrail','workspace','user','user');
      INSERT INTO cinatoken_gateway.workspace_budgets
        (id,workspace_id,reset_interval,limit_micros)
        VALUES ('budget','workspace','daily',2000000);
      UPDATE cinatoken_gateway.api_keys
        SET limit_micros=3000000,limit_reset='daily',include_byok_in_limit=TRUE
        WHERE id='key';`).simple();
    const guarded = sample(0.25);
    const guardedIso = new Date().toISOString();
    const guardDay = guardedIso.slice(0, 10) + 'T00:00:00.000Z';
    const guardEnd = new Date(Date.parse(guardDay) + 86_400_000).toISOString();
    const guardExpiry = new Date(Date.now() + 60_000).toISOString();
    Object.assign(guarded.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    guarded.recordedAtIso = guardedIso;
    Object.assign(guarded.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
      budgetAccountedAt: guardedIso });
    guarded.params.requestLog.providerAttempts[0].observedAtIso = guardedIso;
    const beforeGuarded = Number((await admin.unsafe(`SELECT budget_spent::text AS spent
      FROM cinatoken_gateway.users WHERE id='user'`))[0].spent);
    guarded.params.userId = 'user'; guarded.params.beforeSpent = beforeGuarded;
    guarded.params.audit.apiKeyId = 'key'; guarded.params.audit.beforeSpent = beforeGuarded;
    guarded.params.guardrailBudgetSettlement = { requestId: guarded.intent.requestId,
      mode: 'actual', reason: 'native_fixture_actual' };
    await intents.prepare(guarded.intent, Number((await admin.unsafe(`SELECT
      (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS n`))[0].n));
    assert.equal(await intents.claim(guarded.intent, 0, guarded.dispatchClaimId), 'granted');
    await migrator.unsafe(`INSERT INTO cinatoken_gateway.user_budget_reservations
      (request_id,user_id,api_key_id,budget_epoch,limit_micros,reserved_micros,state,
       expires_at,created_at,updated_at)
      VALUES ($1,'user','key',0,10000000,2000000,'dispatched',$2,$3,$3)`,
    [guarded.intent.requestId, guardExpiry, guardedIso]);
    await migrator.unsafe(`UPDATE cinatoken_gateway.users
      SET budget_reserved_micros=2000000 WHERE id='user'`);
    const guards = createPostgresGuardrailBudgetsRepository(producer);
    const reserved = await guards.reserveMany({ requestId: guarded.intent.requestId,
      intents: ['user', 'api_key', 'workspace'].map(scope => guardrailIntent(scope, guardDay, guardEnd)),
      reservedMicros: 500000, nowIso: guardedIso, expiresAtIso: guardExpiry });
    assert.equal(reserved.status, 'reserved');
    await guards.markDispatched(guarded.intent.requestId, guardedIso, guardExpiry);
    const guardedRef = await facts.persist(guarded);
    stage('reserved-guardrail-fact', 'PASS', { requestId: guardedRef.requestId });
    const guardedJob = await recoveryJobs.ensure(guardedRef);
    assert.equal(guardedJob.state, 'pending');
    const guardedClaim = await recoveryJobs.claim({ ref: guardedRef, revision: 0 }, 30);
    assert.equal(guardedClaim.status, 'claimed');
    try {
      assert.equal(await settlement.commit(guardedRef, guardedClaim.lease.proof), 'committed');
      stage('recovery-role-reserved-guardrail-commit', 'PASS');
    } catch (error) {
      stage('recovery-role-reserved-guardrail-commit', 'FAIL', { error: summarizeError(error) });
    }
    const guardedFinal = (await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM cinatoken_gateway.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
      (SELECT count(*)::int FROM cinatoken_gateway.api_key_request_logs WHERE id=$1) AS logs,
      (SELECT budget_spent::text FROM cinatoken_gateway.users WHERE id='user') AS spent,
      (SELECT budget_reserved_micros::text FROM cinatoken_gateway.users WHERE id='user') AS user_reserved,
      (SELECT state FROM cinatoken_gateway.user_budget_reservations WHERE request_id=$1) AS user_reservation,
      (SELECT state FROM cinatoken_gateway.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`,
    [guardedRef.requestId]))[0];
    assert.deepEqual(guardedFinal, { receipts: 1, logs: 1, spent: '1.750000',
      user_reserved: '0', user_reservation: 'settled', job_state: 'committed' });
    const guardrailReservations = await admin.unsafe(`SELECT scope_type, state,
      reserved_micros::text AS reserved, settled_micros::text AS settled
      FROM cinatoken_gateway.guardrail_budget_reservations
      WHERE request_id=$1 ORDER BY scope_type`, [guardedRef.requestId]);
    assert.deepEqual(guardrailReservations.map(row => ({ ...row })),
      ['api_key', 'user', 'workspace'].map(scope_type => ({
        scope_type, state: 'settled', reserved: '500000', settled: '250000' })));
    const guardrailWindows = await admin.unsafe(`SELECT scope_type,
      reserved_micros::text AS reserved, settled_micros::text AS settled
      FROM cinatoken_gateway.guardrail_budget_windows
      WHERE workspace_id='workspace' ORDER BY scope_type`);
    assert.deepEqual(guardrailWindows.map(row => ({ ...row })),
      ['api_key', 'user', 'workspace'].map(scope_type => ({
        scope_type, reserved: '0', settled: '250000' })));
    const totals = (await admin.unsafe(`SELECT
      (SELECT count(*)::int FROM cinatoken_gateway.request_usage_commit_receipts) AS receipts,
      (SELECT count(*)::int FROM cinatoken_gateway.api_key_request_logs) AS logs,
      (SELECT count(*)::int FROM cinatoken_gateway.user_audit_logs) AS audits`))[0];
    assert.deepEqual(totals, { receipts: 3, logs: 3, audits: 3 });
    stage('reserved-final-durable-state', 'PASS', {
      final: guardedFinal, guardrailReservations, guardrailWindows, totals });
    report.status = report.stages.some(x => x.result === 'FAIL') ? 'ACL_OR_BEHAVIOR_GAP' : 'PASS';
    assert.equal(report.status, 'PASS', 'One or more recovery role stages failed');
  } catch (error) {
    if (report.status === 'RUNNING') report.status = 'FAILED_SETUP_OR_ASSERTION';
    report.fatal = summarizeError(error);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
    try { await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (error) { report.cleanup = 'FAIL'; report.cleanupError = summarizeError(error); }
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Native settlement evidence: ' + reportFile);
    console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, stages: report.stages }, null, 2));
    assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
  }
}

test('native recovery role financial commits, trigger ACL and workspace isolation',
  { timeout: 240_000 }, main);
