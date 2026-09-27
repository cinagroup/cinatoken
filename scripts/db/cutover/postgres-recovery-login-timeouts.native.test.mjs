// Opt-in PostgreSQL 17+ check of recovery role login defaults. Starts only an
// owned loopback cluster; it never uses an ambient DATABASE_URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { buildPostgresRecoveryRoleSql } from './postgres-recovery-role-policy.ts';

const nowMs = Date.parse('2026-09-23T10:00:00.000Z');
const roleFacts = {
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

function errorSummary(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 300) };
}

test('native recovery NOLOGIN settings do not apply through SET ROLE; new-login defaults do',
  { timeout: 90_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), 'report-recovery-login-timeouts-' + randomUUID() + '.json');
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback-only PG fixture; no recovery origin or production login',
      stages: [], sourceSha256: {} };
    for (const [key, url] of [
      ['nativeTest', new URL(import.meta.url)],
      ['rolePolicy', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
      ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
    ]) report.sourceSha256[key] = createHash('sha256').update(await readFile(url)).digest('hex');
    let probe;
    try {
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 170000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;
      await admin.unsafe('CREATE ROLE cinatoken_gateway_migrator NOLOGIN');
      const plan = buildPostgresRecoveryRoleSql({ originBudgetFacts: roleFacts, nowMs });
      assert.equal(plan.runtimeCompatible, false);
      await admin.unsafe(plan.adminSql).simple();
      const [recovery] = await admin.unsafe(`SELECT rolcanlogin,
        (SELECT setconfig FROM pg_catalog.pg_db_role_setting
          WHERE setrole=pg_catalog.to_regrole('cinatoken_gateway_recovery')
            AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) AS settings
        FROM pg_catalog.pg_roles WHERE rolname='cinatoken_gateway_recovery'`);
      assert.equal(recovery.rolcanlogin, false);
      assert.ok(recovery.settings.includes('statement_timeout=15000'));
      assert.ok(recovery.settings.includes('transaction_timeout=30000'));
      await admin.unsafe("SET statement_timeout TO '4s'");
      const [before] = await admin.unsafe(`SELECT current_user AS role,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('transaction_timeout') AS transaction_timeout`);
      assert.equal(before.statement_timeout, '4s');
      assert.equal(before.transaction_timeout, '0');
      await admin.unsafe('SET ROLE cinatoken_gateway_recovery');
      let afterSetRole;
      try {
        [afterSetRole] = await admin.unsafe(`SELECT current_user AS role,
          current_setting('statement_timeout') AS statement_timeout,
          current_setting('transaction_timeout') AS transaction_timeout`);
        assert.equal(afterSetRole.role, 'cinatoken_gateway_recovery');
        assert.equal(afterSetRole.statement_timeout, before.statement_timeout);
        assert.equal(afterSetRole.transaction_timeout, before.transaction_timeout);
      } finally {
        await admin.unsafe('RESET ROLE');
        await admin.unsafe('RESET statement_timeout');
      }
      report.stages.push({ name: 'set-role-does-not-load-login-defaults', result: 'PASS',
        before, afterSetRole, recoveryRoleLogin: recovery.rolcanlogin,
        catalogTimeouts: ['statement_timeout=15000', 'transaction_timeout=30000'] });

      const password = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_timeout_login_probe LOGIN PASSWORD '${password}';
        GRANT CONNECT ON DATABASE postgres TO cinatoken_timeout_login_probe;
        ALTER ROLE cinatoken_timeout_login_probe IN DATABASE postgres SET statement_timeout TO 200;`).simple();
      probe = postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
        username: 'cinatoken_timeout_login_probe', password, ssl: false, max: 1,
        prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
        max_lifetime: 0, backoff: 0, onnotice() {} });
      const [login] = await probe.unsafe(`SELECT current_user AS role,
        current_setting('statement_timeout') AS statement_timeout`);
      assert.deepEqual(login, { role: 'cinatoken_timeout_login_probe', statement_timeout: '200ms' });
      await assert.rejects(probe.unsafe('SELECT pg_catalog.pg_sleep(0.6)'),
        error => error?.code === '57014');
      report.stages.push({ name: 'new-login-default-enforced-by-server', result: 'PASS',
        login, longStatementSqlstate: '57014' });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = errorSummary(error); throw error;
    } finally {
      if (probe) await probe.end({ timeout: 1 }).catch(() => {});
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      console.log('Native recovery login timeout evidence: ' + reportFile);
      console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, stages: report.stages }, null, 2));
      assert.equal(report.cleanup, 'PASS', 'Owned PostgreSQL fixture cleanup failed');
    }
  });
