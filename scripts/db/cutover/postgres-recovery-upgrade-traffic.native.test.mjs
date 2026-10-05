// Opt-in native PostgreSQL check of review-only C03 producer proposal locks.
// Starts and removes only an owned loopback cluster; never uses DATABASE_URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createDispatchIntentRepositoryPostgres } from '../../../packages/core/src/storage/recovery/dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../../../packages/core/src/storage/recovery/usage-settlement-facts-postgres.ts';
import { sample } from '../../../packages/core/src/storage/recovery/usage-settlement-test-support.mjs';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const intentProposal = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const outboxProposal = new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url);
const sha256 = body => createHash('sha256').update(body).digest('hex');

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

async function functionState(admin, name) {
  const [row] = await admin.unsafe(`SELECT p.prosecdef AS security_definer,
      pg_catalog.md5(p.prosrc) AS source_md5,
      pg_catalog.has_function_privilege('cinatoken_gateway_runtime', p.oid, 'EXECUTE') AS runtime_execute
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)`,
  [`${schema}.${name}()`]);
  assert.ok(row, `${name} function missing`);
  return row;
}

async function relationLockEvidence(admin, table, waiterPid, holderPid) {
  const tableName = `${schema}.${table}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    const [activity] = await admin.unsafe(`SELECT wait_event_type, wait_event,
      pg_catalog.pg_blocking_pids(pid)::text AS blocking_pids,
      $2::integer = ANY(pg_catalog.pg_blocking_pids(pid)) AS held_by_expected_session
      FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [waiterPid, holderPid]);
    if (activity?.wait_event_type === 'Lock' && activity.held_by_expected_session) {
      const locks = await admin.unsafe(`SELECT pid, locktype, mode, granted
        FROM pg_catalog.pg_locks
        WHERE pid IN ($1,$2) AND relation=$3::pg_catalog.regclass
        ORDER BY pid,granted,mode`, [waiterPid, holderPid, tableName]);
      assert.ok(locks.some(lock => lock.pid === waiterPid
        && lock.locktype === 'relation' && lock.mode === 'ShareRowExclusiveLock'
        && lock.granted === false), `${tableName} proposal relation lock missing`);
      assert.ok(locks.some(lock => lock.pid === holderPid
        && lock.locktype === 'relation' && lock.mode === 'RowExclusiveLock'
        && lock.granted === true), `${tableName} active writer lock missing`);
      return { relation: tableName, waiterPid, holderPid,
        waitEventType: activity.wait_event_type, waitEvent: activity.wait_event,
        blockingPids: activity.blocking_pids, locks };
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${tableName} did not show a proposal wait behind the active writer`);
}

function factValue() {
  const value = sample(0);
  const now = new Date().toISOString();
  Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
  value.recordedAtIso = now;
  Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
    budgetAccountedAt: now });
  value.params.requestLog.providerAttempts[0].observedAtIso = now;
  value.params.userId = 'user';
  value.params.audit.apiKeyId = 'key';
  delete value.params.userBudgetSettlement;
  return value;
}

test('native existing-layout producer upgrade locks preserve ordinary log traffic',
  { timeout: 240_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), 'report-upgrade-traffic-' + randomUUID() + '.json');
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'seeded existing-layout database in owned loopback PG; review-only proposals, no production identity or remote database',
      limitations: ['Synthetic data volume and local latency do not establish a production maintenance window.',
        'A held transaction after proposal SQL intentionally extends successful lock duration.'],
      stages: [], sourceSha256: {} };
    const sources = [
      ['nativeTest', new URL(import.meta.url)], ['optionalGuard', guardSwitch],
      ['intentProposal', intentProposal], ['outboxProposal', outboxProposal],
      ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
      ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
    ];
    const clients = [];
    const ownClient = (username, password, label) => {
      const client = localClient(cluster, username, password, label);
      clients.push(client); return client;
    };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    try {
      for (const [key, url] of sources) report.sourceSha256[key] = sha256(await readFile(url));
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 170000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, cinatoken_gateway_runtime;`).simple();
      const migrator = ownClient('cinatoken_gateway_migrator', migratorPassword, 'upgrade-seed');
      const writer = ownClient('cinatoken_gateway_migrator', migratorPassword, 'upgrade-holder');
      const upgrade = ownClient('cinatoken_gateway_migrator', migratorPassword, 'upgrade-candidate');
      const runtimeRead = ownClient('cinatoken_gateway_runtime', runtimePassword, 'upgrade-log-read');
      const runtimeWrite = ownClient('cinatoken_gateway_runtime', runtimePassword, 'upgrade-log-write');
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${migratorPassword}@127.0.0.1:${cluster.port}/postgres`;
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha256(corpus.join('\n'));
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
        VALUES ('user','native-upgrade@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('workspace','personal','user','Native Upgrade','native-upgrade','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('key','native-upgrade-key','user','workspace');`).simple();
      // A populated old layout, including legacy request logs, before the optional switch.
      await migrator.unsafe(`INSERT INTO ${schema}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,request_operation,status)
        SELECT 'legacy-' || g::text,'user','key','workspace','images.generations','success'
        FROM pg_catalog.generate_series(1,512) AS g`);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(guardSwitch, 'utf8')).simple();
      });
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      await runtimeRead.unsafe("SET statement_timeout = '1200ms'");
      await runtimeWrite.unsafe("SET statement_timeout = '1200ms'");
      const [seed] = await admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs) AS legacy_logs,
        (SELECT count(*)::int FROM ${schema}.request_dispatch_intents) AS intents,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlements) AS facts`);
      assert.deepEqual(seed, { legacy_logs: 512, intents: 0, facts: 0 });
      stage('populated-existing-layout', { formalMigrations: files.length, seed,
        optionalLegacyGuardActivated: true });

      async function ordinaryTraffic(label, count = 3) {
        const probes = [];
        for (let index = 0; index < count; index++) {
          const readStart = performance.now();
          const [read] = await runtimeRead.unsafe(`SELECT count(*)::int AS n
            FROM ${schema}.api_key_request_logs WHERE id LIKE 'legacy-%'`);
          const readMs = performance.now() - readStart;
          assert.equal(read.n, 512);
          const id = `upgrade-${label}-${index}-${randomUUID()}`;
          const writeStart = performance.now();
          await runtimeWrite.unsafe(`INSERT INTO ${schema}.api_key_request_logs
            (id,user_id,api_key_id,workspace_id,request_operation,status)
            VALUES ($1,'user','key','workspace','images.generations','success')`, [id]);
          const writeMs = performance.now() - writeStart;
          const [durable] = await admin.unsafe(`SELECT count(*)::int AS n
            FROM ${schema}.api_key_request_logs WHERE id=$1`, [id]);
          assert.equal(durable.n, 1);
          probes.push({ id, readMs: Math.round(readMs * 1000) / 1000,
            writeMs: Math.round(writeMs * 1000) / 1000 });
        }
        return { completed: probes.length, statementTimeoutMs: 1200,
          maxReadMs: Math.max(...probes.map(probe => probe.readMs)),
          maxWriteMs: Math.max(...probes.map(probe => probe.writeMs)), probes };
      }
      stage('ordinary-baseline', { traffic: await ordinaryTraffic('baseline') });

      const intentRepository = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: migrator });
      const writerPid = (await writer.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      const upgradePid = (await upgrade.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
      const proposalCases = [
        { name: 'intent', table: 'request_dispatch_intents', activation: 'dispatch_intent_definer_activation',
          url: intentProposal, function: 'guard_request_dispatch_intent',
          hold: async tx => {
            const identity = { requestId: 'upgrade-intent-' + randomUUID(), attemptIndex: 1,
              userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
              operation: 'images.generations', contextSha256: 'a'.repeat(64) };
            const repository = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: tx });
            assert.equal((await repository.prepare(identity, Date.now() + 120000)).state, 'prepared');
            return identity.requestId;
          } },
        { name: 'outbox', table: 'request_usage_settlements', activation: 'settlement_outbox_definer_activation',
          url: outboxProposal, function: 'enqueue_usage_settlement_fact',
          hold: async tx => {
            const value = factValue();
            assert.equal((await intentRepository.prepare(value.intent, Date.now() + 120000)).state, 'prepared');
            assert.equal(await intentRepository.claim(value.intent, 0, value.dispatchClaimId), 'granted');
            const facts = createUsageSettlementFactsRepositoryPostgres({ driver: 'postgres', raw: tx });
            const ref = await facts.persist(value);
            return ref.requestId;
          } },
      ];
      for (const candidate of proposalCases) {
        const before = await functionState(admin, candidate.function);
        assert.equal(before.security_definer, false);
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const held = writer.begin(async tx => {
          const id = await candidate.hold(tx);
          entered.resolve(id);
          await release.promise;
        });
        held.catch(entered.reject);
        const heldId = await entered.promise;
        const started = performance.now();
        const blocked = upgrade.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${candidate.activation} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(candidate.url, 'utf8')).simple();
        });
        blocked.catch(() => {});
        let lockEvidence, traffic, timeoutMs;
        try {
          lockEvidence = await relationLockEvidence(admin, candidate.table, upgradePid, writerPid);
          traffic = await ordinaryTraffic(`${candidate.name}-wait`);
          const [stillWaiting] = await admin.unsafe(`SELECT wait_event_type,
            $2::integer = ANY(pg_catalog.pg_blocking_pids(pid)) AS held_by_expected_session
            FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [upgradePid, writerPid]);
          assert.equal(stillWaiting?.wait_event_type, 'Lock');
          assert.equal(stillWaiting.held_by_expected_session, true);
          await assert.rejects(blocked, error => error.code === '55P03');
          timeoutMs = Math.round((performance.now() - started) * 1000) / 1000;
          assert.ok(timeoutMs >= 1500 && timeoutMs < 6500, `lock timeout took ${timeoutMs}ms`);
        } finally {
          release.resolve();
          await held;
        }
        const after = await functionState(admin, candidate.function);
        assert.deepEqual(after, before, 'failed proposal must leave the original function unchanged');
        const [committed] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${schema}.${candidate.table}
          WHERE request_id=$1`, [heldId]);
        assert.equal(committed.n, 1);
        stage(`${candidate.name}-proposal-lock-timeout-rollback`, {
          lockTimeoutSqlState: '55P03', observedTimeoutMs: timeoutMs,
          lockEvidence, ordinaryTrafficDuringWait: traffic,
          originalFunctionUnchanged: true, heldWriterCommitted: true });
      }

      const ready = Promise.withResolvers(), releaseUpgrade = Promise.withResolvers();
      const successStart = performance.now();
      const successfulUpgrade = upgrade.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.unsafe("SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(intentProposal, 'utf8')).simple();
        await tx.unsafe(await readFile(outboxProposal, 'utf8')).simple();
        ready.resolve(Math.round((performance.now() - successStart) * 1000) / 1000);
        await releaseUpgrade.promise;
      });
      successfulUpgrade.catch(ready.reject);
      const proposalSqlMs = await ready.promise;
      let heldLocks, heldTraffic;
      try {
        heldLocks = await admin.unsafe(`SELECT relation::pg_catalog.regclass::text AS relation,mode,granted
          FROM pg_catalog.pg_locks WHERE pid=$1 AND granted
            AND relation IN ('${schema}.request_dispatch_intents'::pg_catalog.regclass,
              '${schema}.request_usage_settlements'::pg_catalog.regclass,
              '${schema}.request_usage_settlement_outbox'::pg_catalog.regclass)
          ORDER BY relation`, [upgradePid]);
        for (const table of ['request_dispatch_intents', 'request_usage_settlements', 'request_usage_settlement_outbox']) {
          assert.ok(heldLocks.some(lock => lock.relation.endsWith(table)
            && lock.mode === 'ShareRowExclusiveLock'), `${table} proposal lock not held through COMMIT`);
        }
        heldTraffic = await ordinaryTraffic('bundle-held');
      } finally {
        releaseUpgrade.resolve();
        await successfulUpgrade;
      }
      const totalUpgradeMs = Math.round((performance.now() - successStart) * 1000) / 1000;
      const finalFunctions = {
        intent: await functionState(admin, 'guard_request_dispatch_intent'),
        outbox: await functionState(admin, 'enqueue_usage_settlement_fact'),
      };
      assert.equal(finalFunctions.intent.security_definer, true);
      assert.equal(finalFunctions.outbox.security_definer, true);
      assert.equal(finalFunctions.intent.runtime_execute, false);
      assert.equal(finalFunctions.outbox.runtime_execute, false);
      stage('paired-proposals-single-transaction', { proposalSqlMs, totalUpgradeMs,
        intentionallyHeldForTrafficProbe: true, heldLocks, ordinaryTrafficDuringHold: heldTraffic,
        finalFunctions });
      stage('ordinary-after-upgrade', { traffic: await ordinaryTraffic('after') });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = errorSummary(error);
      throw error;
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native upgrade traffic evidence: ' + reportFile);
      console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup,
        stages: report.stages.map(stage => stage.name) }, null, 2));
      assert.equal(report.cleanup, 'PASS', 'Owned cluster cleanup failed');
    }
  });
