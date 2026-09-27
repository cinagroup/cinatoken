// Opt-in PostgreSQL 17+ server deadline evidence. Uses a new owned loopback
// cluster only; never reads an ambient database URL or production credential.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

function safeError(error) {
  return { name: error?.name ?? null, code: error?.code ?? null,
    severity: error?.severity ?? null };
}

async function backendGone(admin, pid) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const [row] = await admin.unsafe(
      'SELECT count(*)::int AS active FROM pg_catalog.pg_stat_activity WHERE pid = $1', [pid]);
    if (row.active === 0) return true;
    await delay(50);
  }
  return false;
}

test('native LOGIN transaction deadline terminates both implicit and explicit transactions',
  { timeout: 90_000 }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), 'report-recovery-server-deadline-' + randomUUID() + '.json');
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback-only PG17+ fixture; synthetic LOGIN and table; no production origin',
      stages: [], sourceSha256: {} };
    for (const [key, url] of [
      ['nativeTest', new URL(import.meta.url)],
      ['nativeCluster', new URL('../../../packages/core/src/test-support/postgres-native-cluster.mjs', import.meta.url)],
    ]) report.sourceSha256[key] = createHash('sha256').update(await readFile(url)).digest('hex');
    const clients = [];
    try {
      const { admin } = cluster;
      const [server] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num,
        current_setting('listen_addresses') AS listen_addresses`);
      assert.ok(server.version_num >= 170000);
      assert.equal(server.listen_addresses, '127.0.0.1');
      report.serverVersionNum = server.version_num;

      const password = randomBytes(24).toString('hex');
      await admin.unsafe(`CREATE ROLE cinatoken_deadline_probe LOGIN PASSWORD '${password}';
        GRANT CONNECT ON DATABASE postgres TO cinatoken_deadline_probe;
        CREATE TABLE public.cinatoken_deadline_probe (id integer PRIMARY KEY);
        GRANT INSERT, SELECT ON public.cinatoken_deadline_probe TO cinatoken_deadline_probe;
        ALTER ROLE cinatoken_deadline_probe IN DATABASE postgres SET transaction_timeout TO 500;
        ALTER ROLE cinatoken_deadline_probe IN DATABASE postgres SET statement_timeout TO 5000;
        ALTER ROLE cinatoken_deadline_probe IN DATABASE postgres SET lock_timeout TO 2000;
        ALTER ROLE cinatoken_deadline_probe IN DATABASE postgres SET idle_in_transaction_session_timeout TO 2000;`).simple();
      const open = () => {
        const client = postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
          username: 'cinatoken_deadline_probe', password, ssl: false, max: 1, max_pipeline: 1,
          prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
          max_lifetime: 0, backoff: 0, onnotice() {} });
        clients.push(client);
        return client;
      };
      async function login(client) {
        const [row] = await client.unsafe(`SELECT pg_catalog.pg_backend_pid() AS pid,
          current_user AS current_role, session_user AS session_role,
          (SELECT setting FROM pg_catalog.pg_settings WHERE name='transaction_timeout'
            AND unit='ms' AND source='database user') AS transaction_timeout_ms,
          (SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout'
            AND unit='ms' AND source='database user') AS statement_timeout_ms`);
        assert.equal(row.current_role, 'cinatoken_deadline_probe');
        assert.equal(row.session_role, row.current_role);
        assert.equal(row.transaction_timeout_ms, '500');
        assert.equal(row.statement_timeout_ms, '5000');
        return row.pid;
      }

      const implicit = open();
      const implicitPid = await login(implicit);
      let implicitError;
      try { await implicit.unsafe('SELECT pg_catalog.pg_sleep(1.5)'); }
      catch (error) { implicitError = error; }
      assert.ok(implicitError, 'An implicit transaction must reach the server deadline');
      assert.equal(await backendGone(admin, implicitPid), true,
        'A server transaction deadline must terminate the original backend');
      report.stages.push({ name: 'implicit-statement-server-termination', result: 'PASS',
        error: safeError(implicitError), backendGone: true });

      const explicit = open();
      const explicitPid = await login(explicit);
      await explicit.unsafe('BEGIN');
      await explicit.unsafe('INSERT INTO public.cinatoken_deadline_probe (id) VALUES (1)');
      let explicitError;
      try { await explicit.unsafe('SELECT pg_catalog.pg_sleep(1.5)'); }
      catch (error) { explicitError = error; }
      assert.ok(explicitError, 'An explicit transaction must reach the server deadline');
      assert.equal(await backendGone(admin, explicitPid), true,
        'The timed-out explicit transaction backend must terminate');
      const [persisted] = await admin.unsafe('SELECT count(*)::int AS rows FROM public.cinatoken_deadline_probe');
      assert.equal(persisted.rows, 0, 'Uncommitted work must roll back after server termination');
      report.stages.push({ name: 'explicit-transaction-server-termination-and-rollback', result: 'PASS',
        error: safeError(explicitError), backendGone: true, persistedRows: persisted.rows });

      const serverLog = await cluster.readLog();
      const transactionTimeouts = serverLog.match(/terminating connection due to transaction timeout/g) ?? [];
      assert.ok(transactionTimeouts.length >= 2,
        'Server log must attribute both backend terminations to transaction_timeout');
      report.stages.push({ name: 'server-log-timeout-attribution', result: 'PASS',
        transactionTimeoutTerminations: transactionTimeouts.length });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = safeError(error); throw error;
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = safeError(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      console.log('Native recovery server deadline evidence: ' + reportFile);
      console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, stages: report.stages }, null, 2));
      assert.equal(report.cleanup, 'PASS', 'Owned PostgreSQL fixture cleanup failed');
    }
  });
