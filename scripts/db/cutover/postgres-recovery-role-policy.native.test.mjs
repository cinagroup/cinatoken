// Opt-in native PostgreSQL check. The fixture starts a new, owned loopback-only
// cluster; GATEWAY_NATIVE_PG_BIN must point to local PostgreSQL 17+ binaries.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createDispatchIntentRepositoryPostgres } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';
import { encodeUsageSettlement } from '../../../packages/core/src/storage/recovery/usage-settlement-codec.ts';
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { buildPostgresRecoveryRoleSql } from './postgres-recovery-role-policy.ts';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const nowMs = Date.parse('2026-09-23T10:00:00.000Z');
const gateway = 'cinatoken_gateway';
const logInsert = `INSERT INTO ${gateway}.api_key_request_logs
  (id,user_id,api_key_id,workspace_id,request_operation,status)
  VALUES ($1,'user','key','workspace','images.generations','success')`;
const factInsert = `INSERT INTO ${gateway}.request_usage_settlements
  (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,
   dispatch_claim_id,payload_sha256,payload_version,payload_json,recorded_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
const sha256 = body => createHash('sha256').update(body).digest('hex');

function budgetFacts() {
  return {
    schemaVersion: 1, capturedAt: new Date(nowMs - 60_000).toISOString(),
    instance: { id: 'disposable_pg17_or_later', serverVersionNum: 170006,
      maxConnections: 50, superuserReservedConnections: 3, reservedConnections: 2,
      observedClientConnections: 12, observedClientConnectionsScope: 'all_databases',
      nonHyperdriveConnectionBudget: 5, safetyHeadroomConnections: 3 },
    inventory: { complete: true, scope: 'all_hyperdrives_on_instance',
      instanceId: 'disposable_pg17_or_later', origins: [
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
}

function localClient(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: 0,
    connection: { application_name: 'cinatoken-native-' + label }, onnotice() {} });
}

async function blockedBy(admin, waiter, holder) {
  for (let i = 0; i < 120; i++) {
    const [row] = await admin.unsafe(`SELECT wait_event_type, wait_event,
      $2::integer = ANY(pg_catalog.pg_blocking_pids(pid)) AS blocked_by_holder
      FROM pg_catalog.pg_stat_activity WHERE pid = $1`, [waiter, holder]);
    if (row?.wait_event_type === 'Lock' && row.blocked_by_holder) return row;
    await delay(25);
  }
  assert.fail(`Native lock wait not observed for backend ${waiter}`);
}

async function factArgs(value) {
  const { json, sha256 } = await encodeUsageSettlement(value), intent = value.intent;
  return [intent.requestId, intent.attemptIndex, intent.userId, intent.apiKeyId,
    intent.workspaceId, intent.operation, intent.contextSha256,
    value.dispatchClaimId, sha256, value.version, json, value.recordedAtIso];
}

test('native recovery role, paired guard and ordinary log writer are isolated', { timeout: 240_000 }, async t => {
  const cluster = await startNativePostgres();
  const { admin } = cluster;
  const migratorPassword = randomBytes(24).toString('hex');
  const runtimePassword = randomBytes(24).toString('hex');
  const clients = [];
  const reportFile = join(dirname(cluster.owned), 'report-recovery-role-' + randomUUID() + '.json');
  const report = { status: 'RUNNING', binaryVersion: cluster.binaryVersion,
    node: process.version, scope: 'owned loopback-only native PostgreSQL fixture',
    checks: [], cleanup: 'PENDING', sourceSha256: {} };
  for (const [key, url] of [
    ['nativeTest', new URL(import.meta.url)],
    ['rolePolicy', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
    ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
    ['formal0069', new URL('0069_recovery_dispatch_intents.sql', migrations)],
  ]) report.sourceSha256[key] = sha256(await readFile(url));
  const checked = name => report.checks.push(name);
  const client = (username, password, label) => {
    const sql = localClient(cluster, username, password, label);
    clients.push(sql); return sql;
  };
  let completed = false;
  t.after(async () => {
    try {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      await cluster.cleanup();
      report.cleanup = 'PASS';
    } catch (error) {
      report.cleanup = 'FAIL';
      report.cleanupError = error.name;
      throw error;
    } finally {
      report.status = completed && report.cleanup === 'PASS' ? 'PASS' : 'FAIL';
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      t.diagnostic('Native evidence: ' + reportFile);
    }
  });
  assert.ok(Number((await admin.unsafe("SELECT current_setting('server_version_num')::integer AS version"))[0].version) >= 170000);
  await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
    CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
    CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
  const migrator = client('cinatoken_gateway_migrator', migratorPassword, 'migrator');
  const runtime = client('cinatoken_gateway_runtime', runtimePassword, 'ordinary');
  const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
  await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
  assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
  for (const name of files) {
    const body = await readFile(new URL(name, migrations), 'utf8');
    if (name === '0069_recovery_dispatch_intents.sql') {
      // A legacy writer's ROW EXCLUSIVE relation lock must make the first
      // formal recovery migration fail within its own 2s lock budget, with
      // both table creation and migration marker rolled back.
      const legacyWriter = cluster.client('legacy-relation-lock');
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      const held = legacyWriter.begin(async tx => {
        const holder = (await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
        await tx.unsafe(`LOCK TABLE ${gateway}.users IN ROW EXCLUSIVE MODE`);
        entered.resolve(holder); await release.promise;
      });
      held.catch(entered.reject);
      const holder = await entered.promise;
      const waiter = (await migrator.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      const blockedMigration = migrator.begin(async tx => {
        await tx.unsafe(body).simple();
        await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
      });
      blockedMigration.catch(() => {});
      try {
        await blockedBy(admin, waiter, holder);
        await assert.rejects(blockedMigration, error => error.code === '55P03');
      } finally { release.resolve(); await held; }
      assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regclass(
        '${gateway}.request_dispatch_intents') IS NULL AS absent`))[0].absent, true);
      assert.equal((await admin.unsafe(`SELECT count(*)::int AS n FROM ${gateway}.schema_migrations
        WHERE version=$1`, [name]))[0].n, 0);
      checked('0069 formal migration lock timeout rolls back table and marker under legacy write lock');
    }
    await migrator.begin(async tx => {
      await tx.unsafe(body).simple();
      await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
    });
  }
  assert.equal(files.length, 73);
  checked('73 formal migrations applied as migrator');
  await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
  await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email,budget_max,budget_spent)
    VALUES ('user','native-recovery@example.invalid',10,0);
    INSERT INTO ${gateway}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
    VALUES ('workspace','personal','user','Native Recovery','native-recovery','active');
    INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
    VALUES ('key','native-recovery-key','user','workspace');`).simple();

  const ordinaryLogId = 'ordinary-before-guard';
  await runtime.unsafe(logInsert, [ordinaryLogId]);
  assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM ${gateway}.api_key_request_logs WHERE id=$1`,
    [ordinaryLogId]))[0].n, 1);
  checked('ordinary runtime INSERT before optional guard');

  const plan = buildPostgresRecoveryRoleSql({ originBudgetFacts: budgetFacts(), nowMs });
  await admin.unsafe(plan.adminSql).simple();
  await assert.rejects(migrator.unsafe(plan.migratorSql).simple(),
    /Legacy log fence ownership or security contract differs: cinatoken_gateway\.guard_fact_owned_usage_log\(\)/);
  await migrator.unsafe('ROLLBACK').simple();

  const guardSql = await readFile(guardSwitch, 'utf8');
  report.sourceSha256.optionalGuard = sha256(guardSql);
  await assert.rejects(migrator.begin(async tx => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
    await tx.unsafe(guardSql).simple();
  }), /Recovery log guard activation requires READ COMMITTED/);
  assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regprocedure(
    '${gateway}.guard_fact_owned_usage_log()') IS NULL AS absent`))[0].absent, true);
  checked('REPEATABLE READ activation rejected before installing either guard');
  // An in-flight ordinary INSERT takes a conflicting relation lock. The switch
  // must time out promptly and leave no half-installed trigger/function pair.
  const enteredCutoverHold = Promise.withResolvers();
  const releaseCutoverHold = Promise.withResolvers();
  const heldOrdinaryInsert = runtime.begin(async tx => {
    const holder = (await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    await tx.unsafe(logInsert, ['ordinary-held-during-switch']);
    enteredCutoverHold.resolve(holder);
    await releaseCutoverHold.promise;
  });
  heldOrdinaryInsert.catch(enteredCutoverHold.reject);
  const cutoverHolder = await enteredCutoverHold.promise;
  const cutoverWaiter = (await migrator.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
  const blockedSwitch = migrator.begin(async tx => {
    await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
    await tx.unsafe(guardSql).simple();
  });
  blockedSwitch.catch(() => {});
  try {
    await blockedBy(admin, cutoverWaiter, cutoverHolder);
    await assert.rejects(blockedSwitch, error => error.code === '55P03');
  } finally {
    releaseCutoverHold.resolve();
    await heldOrdinaryInsert;
  }
  assert.equal((await admin.unsafe(`SELECT pg_catalog.to_regprocedure(
    '${gateway}.guard_fact_owned_usage_log()') IS NULL AS absent`))[0].absent, true);
  checked('held ordinary INSERT blocks cutover; 2s timeout rolls back whole guard switch');
  await migrator.begin(async tx => {
    await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
    await tx.unsafe(guardSql).simple();
  });
  await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
  const noDirectGuard = await admin.unsafe(`SELECT
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      '${gateway}.guard_fact_owned_usage_log()', 'EXECUTE') AS ordinary_log_guard,
    pg_catalog.has_function_privilege('cinatoken_gateway_runtime',
      '${gateway}.guard_fact_without_legacy_log()', 'EXECUTE') AS ordinary_fact_guard`);
  assert.deepEqual(noDirectGuard[0], { ordinary_log_guard: false, ordinary_fact_guard: false });
  checked('ordinary grant script rerun preserves both guard EXECUTE denials');
  await migrator.unsafe(plan.migratorSql).simple();
  const attributes = (await admin.unsafe(`SELECT rolcanlogin, rolinherit, rolconnlimit,
    rolpassword IS NULL AS password_is_null FROM pg_catalog.pg_authid
    WHERE rolname = 'cinatoken_gateway_recovery'`))[0];
  assert.deepEqual(attributes, { rolcanlogin: false, rolinherit: false,
    rolconnlimit: 2, password_is_null: true });
  const settings = (await admin.unsafe(`SELECT unnest(setconfig) AS setting
    FROM pg_catalog.pg_db_role_setting
    WHERE setrole = (SELECT oid FROM pg_catalog.pg_roles
      WHERE rolname = 'cinatoken_gateway_recovery') ORDER BY setting`)).map(row => row.setting);
  assert.deepEqual(settings, ['idle_in_transaction_session_timeout=10000',
    'lock_timeout=5000', 'search_path=pg_catalog, cinatoken_gateway',
    'statement_timeout=15000', 'transaction_timeout=30000']);
  const acl = (await admin.unsafe(`SELECT
    pg_catalog.has_table_privilege('cinatoken_gateway_recovery','${gateway}.api_keys','UPDATE') AS key_update,
    pg_catalog.has_table_privilege('cinatoken_gateway_recovery','${gateway}.api_key_request_logs','UPDATE') AS log_update,
    pg_catalog.has_table_privilege('cinatoken_gateway_recovery','${gateway}.request_usage_settlements','INSERT') AS fact_insert,
    pg_catalog.has_function_privilege('cinatoken_gateway_recovery',
      '${gateway}.recovery_api_key_workspace_matches(text,text)','EXECUTE') AS key_helper`))[0];
  assert.deepEqual(acl, { key_update: false, log_update: false, fact_insert: false, key_helper: true });
  await assert.rejects(runtime.unsafe(`SELECT request_id FROM ${gateway}.request_usage_settlements LIMIT 1`),
    error => error.code === '42501');
  checked('NOLOGIN recovery role, five timeout defaults, narrow catalog ACL and runtime fact denial');
  const recovery = cluster.client('recovery-role');
  await recovery.unsafe('SET ROLE cinatoken_gateway_recovery');
  assert.equal((await recovery.unsafe(`SELECT ${gateway}.recovery_api_key_workspace_matches('key','workspace') AS matches`))[0].matches, true);
  assert.equal((await recovery.unsafe(`SELECT ${gateway}.recovery_api_key_workspace_matches('key','other') AS matches`))[0].matches, false);
  const keyHolder = cluster.client('key-holder');
  const enteredKeyHold = Promise.withResolvers(), releaseKeyHold = Promise.withResolvers();
  const heldKeyUpdate = keyHolder.begin(async tx => {
    const holder = (await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    await tx.unsafe(`UPDATE ${gateway}.api_keys SET status='active' WHERE id='key'`);
    enteredKeyHold.resolve(holder); await releaseKeyHold.promise;
  });
  heldKeyUpdate.catch(enteredKeyHold.reject);
  const keyHolderPid = await enteredKeyHold.promise;
  const keyWaiterPid = (await recovery.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
  const pendingKeyMatch = recovery.unsafe(`SELECT ${gateway}.recovery_api_key_workspace_matches('key','workspace') AS matches`);
  pendingKeyMatch.catch(() => {});
  try { await blockedBy(admin, keyWaiterPid, keyHolderPid); }
  finally { releaseKeyHold.resolve(); await heldKeyUpdate; }
  assert.equal((await pendingKeyMatch)[0].matches, true);
  checked('recovery key helper waits on native row lock without direct key UPDATE');
  await assert.rejects(recovery.unsafe(`UPDATE ${gateway}.api_keys SET status='disabled' WHERE id='key'`),
    error => error.code === '42501');
  await assert.rejects(recovery.unsafe(`UPDATE ${gateway}.api_key_request_logs SET status='failed' WHERE id=$1`,
    [ordinaryLogId]), error => error.code === '42501');
  await runtime.unsafe(logInsert, ['ordinary-after-guard']);
  checked('ordinary runtime INSERT after optional guard without recovery SELECT');

  const intents = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
  async function claimedValue() {
    const value = sample(0);
    Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
    value.params.userId = 'user'; value.params.audit.apiKeyId = 'key';
    const deadline = Number((await admin.unsafe(`SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000)::text AS n`))[0].n);
    await intents.prepare(value.intent, deadline);
    assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
    return value;
  }
  const factFirst = await claimedValue();
  const enteredFact = Promise.withResolvers(), releaseFact = Promise.withResolvers();
  const factTransaction = migrator.begin(async tx => {
    const holder = (await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    await tx.unsafe(factInsert, await factArgs(factFirst));
    enteredFact.resolve(holder); await releaseFact.promise;
  });
  factTransaction.catch(enteredFact.reject);
  const factHolder = await enteredFact.promise;
  const competingLog = client('cinatoken_gateway_runtime', runtimePassword, 'log-after-fact');
  const logWaiter = (await competingLog.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
  const pendingLog = competingLog.unsafe(logInsert, [factFirst.intent.requestId]);
  pendingLog.catch(() => {});
  try { await blockedBy(admin, logWaiter, factHolder); }
  finally { releaseFact.resolve(); await factTransaction; }
  await assert.rejects(pendingLog, /Fact-owned usage log requires an active fenced receipt/);
  checked('fact-first advisory lock serializes and rejects unfenced ordinary log');

  const logFirst = await claimedValue();
  const firstLog = client('cinatoken_gateway_runtime', runtimePassword, 'log-holder');
  const enteredLog = Promise.withResolvers(), releaseLog = Promise.withResolvers();
  const logTransaction = firstLog.begin(async tx => {
    const holder = (await tx.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
    await tx.unsafe(logInsert, [logFirst.intent.requestId]);
    enteredLog.resolve(holder); await releaseLog.promise;
  });
  logTransaction.catch(enteredLog.reject);
  const logHolder = await enteredLog.promise;
  const factWaiter = (await migrator.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
  const pendingFact = migrator.begin(async tx => tx.unsafe(factInsert, await factArgs(logFirst)));
  pendingFact.catch(() => {});
  try { await blockedBy(admin, factWaiter, logHolder); }
  finally { releaseLog.resolve(); await logTransaction; }
  await assert.rejects(pendingFact, /Existing legacy log cannot become a recovery fact/);
  checked('legacy-log-first advisory lock serializes and rejects later fact');
  completed = true;
});
