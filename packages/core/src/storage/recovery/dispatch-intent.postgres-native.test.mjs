import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startNativePostgres } from '../../test-support/postgres-native-cluster.mjs';
import { commitAckProxy } from '../../test-support/postgres-commit-ack-proxy.mjs';
import { createDispatchIntentRepositoryPostgres, PostgresDispatchClaimUncertainError } from './dispatch-intent-postgres.ts';

const table = 'cinatoken_gateway.request_dispatch_intents';
const proposal = await readFile(new URL('../../../migrations-proposals/postgres/request-dispatch-intents.sql', import.meta.url), 'utf8');
const migrationDir = new URL('../../../migrations-postgres/', import.meta.url);
const id = () => ({ requestId: 'native-' + randomUUID(), attemptIndex: 1, userId: 'user', apiKeyId: 'key',
  workspaceId: 'workspace', operation: 'images.generations', contextSha256: 'a'.repeat(64) });
const repository = raw => createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw });

test('native local PostgreSQL independent sessions and real COMMIT ACK loss', { timeout: 150_000 }, async t => {
  const cluster = await startNativePostgres(), admin = cluster.admin;
  const report = { status: 'RUNNING', createdAt: new Date().toISOString(), binaryVersion: cluster.binaryVersion,
    server: cluster.identity, node: process.version, cases: [], shutdown: null,
    scope: 'isolated native localhost PostgreSQL; not Hyperdrive/Workers, production roles or full C03 acceptance' };
  const reportFile = join(dirname(cluster.owned), 'report-' + randomUUID() + '.json');
  t.after(async () => {
    try {
      report.shutdown = await cluster.stop();
      await cluster.cleanup(); report.fixtureRemoved = true;
      report.status = report.cases.length && report.cases.every(x => x.status === 'PASS') ? 'PASS' : 'FAIL';
    } catch (error) { report.status = 'FAIL_CLEANUP'; report.cleanupError = error.name; throw error; }
    finally { await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); t.diagnostic('Native evidence: ' + reportFile); }
  });
  await admin.unsafe('CREATE SCHEMA cinatoken_gateway');
  const migrations = (await readdir(migrationDir)).filter(x => x.endsWith('.sql') && x <= '0068_function_schema_resolution.sql').sort();
  assert.equal(migrations.length, 68);
  for (const migration of migrations) {
    const sql = await readFile(new URL(migration, migrationDir), 'utf8');
    await admin.begin(tx => tx.unsafe(sql).simple());
  }
  await admin.begin(tx => tx.unsafe(proposal).simple()); report.baseMigrations = migrations.length;
  await admin.unsafe(`INSERT INTO cinatoken_gateway.users(id,email,budget_max,budget_spent) VALUES ('user','native@example.invalid',10,1),('other','other@example.invalid',10,0);
    INSERT INTO cinatoken_gateway.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('workspace','personal','user','Fixture','fixture','active'),('other-workspace','personal','other','Other','other','active');
    INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id) VALUES ('key','native-fixture-key','user','workspace'),('other-key','native-fixture-other-key','other','other-workspace');`).simple();
  const repo = repository(admin);
  const deadline = async (ms = 60_000) => Number((await admin.unsafe('SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + $1)::text AS n', [ms]))[0].n);
  const financialSnapshot = async () => (await admin.unsafe(`SELECT
    (SELECT jsonb_agg(to_jsonb(u) ORDER BY id)::text FROM cinatoken_gateway.users u) AS users,
    (SELECT count(*)::text FROM cinatoken_gateway.api_key_request_logs) AS logs,
    (SELECT count(*)::text FROM cinatoken_gateway.user_audit_logs) AS audits,
    (SELECT count(*)::text FROM cinatoken_gateway.user_budget_reservations) AS reservations`))[0];
  const initialFinancial = await financialSnapshot();
  function session(tcase, label, options) {
    const raw = cluster.client(label, options); tcase.after(() => raw.end({ timeout: 1 })); return raw;
  }
  async function check(name, run) {
    await t.test(name, { timeout: 20_000 }, async tcase => {
      const record = { name, status: 'RUNNING' }; report.cases.push(record);
      try { await run(tcase, record); record.status = 'PASS'; }
      catch (error) { record.status = 'FAIL'; record.error = error.name; record.code = error.code; throw error; }
    });
  }
  async function blocked(pid, holderPid) {
    for (let i = 0; i < 100; i++) {
      const rows = await admin.unsafe(`SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid)::text AS blockers,
        $2::integer=ANY(pg_blocking_pids(pid)) AS held_by_expected_session
        FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [pid, holderPid]);
      if (rows[0]?.held_by_expected_session === true) return rows[0];
      await delay(25);
    }
    assert.fail('Native lock wait not observed');
  }
  async function hold(tcase, ref, run) {
    const locker = session(tcase, 'holder'), [{ pid }] = await locker.unsafe('SELECT pg_backend_pid() AS pid');
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const transaction = locker.begin(async tx => {
      await tx.unsafe(`SELECT request_id FROM ${table} WHERE request_id=$1 AND attempt_index=$2 FOR UPDATE`, [ref.requestId, ref.attemptIndex]);
      entered.resolve(); await release.promise;
    });
    transaction.catch(entered.reject);
    await entered.promise;
    try { return await run(pid); }
    finally { release.resolve(); await transaction; }
  }
  async function expire(expiry) {
    await admin.unsafe('SELECT pg_sleep(GREATEST(($1::bigint - floor(extract(epoch FROM clock_timestamp())*1000))/1000.0 + 0.05,0)::double precision)', [expiry]);
    assert.ok(await deadline(0) >= expiry);
  }

  await check('isolated native identity and eight independent sessions produce one grant', async (tc, record) => {
    assert.match(cluster.binaryVersion, /^postgres \(PostgreSQL\) /); assert.doesNotMatch(cluster.identity.version, /PGlite|wasm/);
    const ref = id(); await repo.prepare(ref, await deadline());
    const clients = Array.from({ length: 8 }, (_, index) => session(tc, 'racer-' + index));
    record.pids = await Promise.all(clients.map(async raw => (await raw.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid));
    assert.equal(new Set(record.pids).size, 8); assert.ok(!record.pids.includes(cluster.identity.pid));
    const claim = randomUUID(); record.results = await Promise.all(clients.map(raw => repository(raw).claim(ref, 0, claim)));
    assert.equal(record.results.filter(x => x === 'granted').length, 1);
    assert.equal(record.results.filter(x => x === 'not_granted').length, 7);
    assert.equal(await repository(clients[0]).claim(ref, 1, claim), 'not_granted');
  });
  await check('unchanged row lock waits past expiry: fresh database clock rejects claim', async (tc, record) => {
    const ref = id(), expiry = await deadline(3_000); await repo.prepare(ref, expiry);
    const raw = session(tc, 'expired-claim'), [{ pid }] = await raw.unsafe('SELECT pg_backend_pid() AS pid');
    let pending;
    await hold(tc, ref, async holderPid => {
      pending = repository(raw).claim(ref, 0, randomUUID()); pending.catch(() => {});
      record.wait = await blocked(pid, holderPid); await expire(expiry);
    });
    assert.equal(await pending, 'not_granted');
    assert.equal((await repo.inspect(ref)).state, 'prepared');
    assert.equal(await repo.classifyOverdue(ref, 0), true);
    assert.equal((await repo.inspect(ref)).state, 'expired_before_dispatch');
  });
  await check('native negative control: transaction-start timestamp grants incorrectly after lock wait', async (tc, record) => {
    const [{ sql }] = await admin.unsafe("SELECT pg_get_functiondef('cinatoken_gateway.guard_request_dispatch_intent()'::regprocedure) AS sql");
    assert.match(sql, /clock_timestamp\(\)/);
    await admin.unsafe(sql.replaceAll('clock_timestamp()', 'transaction_timestamp()')).simple();
    try {
      const ref = id(), expiry = await deadline(3_000); await repo.prepare(ref, expiry);
      const raw = session(tc, 'wrong-clock'), [{ pid }] = await raw.unsafe('SELECT pg_backend_pid() AS pid');
      let pending;
      await hold(tc, ref, async holderPid => {
        pending = repository(raw).claim(ref, 0, randomUUID()); pending.catch(() => {});
        record.wait = await blocked(pid, holderPid); await expire(expiry);
      });
      assert.equal(await pending, 'granted', 'Negative control must expose an expired grant');
      record.expectedBadGrant = true;
    } finally { await admin.unsafe(sql).simple(); }
  });
  await check('real lock_timeout is uncertain, has no write and performs no implicit claim replay', async (tc, record) => {
    const ref = id(); await repo.prepare(ref, await deadline());
    const raw = session(tc, 'lock-timeout', { settings: { lock_timeout: '250ms' } });
    const [{ pid }] = await raw.unsafe('SELECT pg_backend_pid() AS pid');
    await hold(tc, ref, async holderPid => {
      const pending = repository(raw).claim(ref, 0, randomUUID()); pending.catch(() => {});
      record.wait = await blocked(pid, holderPid); await assert.rejects(pending, PostgresDispatchClaimUncertainError);
    });
    const after = await repo.inspect(ref); assert.equal(after.state, 'prepared'); assert.equal(after.revision, 0);
    await delay(100); assert.equal((await repo.inspect(ref)).revision, 0);
  });
  await check('terminating a blocked native backend before UPDATE grants nothing and rolls back', async (tc, record) => {
    const ref = id(); await repo.prepare(ref, await deadline());
    const raw = session(tc, 'terminated'), [{ pid }] = await raw.unsafe('SELECT pg_backend_pid() AS pid');
    await hold(tc, ref, async holderPid => {
      const pending = repository(raw).claim(ref, 0, randomUUID()); pending.catch(() => {});
      record.wait = await blocked(pid, holderPid);
      assert.equal((await admin.unsafe('SELECT pg_terminate_backend($1) AS terminated', [pid]))[0].terminated, true);
      await assert.rejects(pending, PostgresDispatchClaimUncertainError);
    });
    assert.equal((await repo.inspect(ref)).state, 'prepared');
    assert.equal((await admin.unsafe('SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid=$1', [pid]))[0].n, 0);
  });
  await check('native uniqueness conflict across distinct attempts rolls back one transaction', async tc => {
    const refs = [id(), id()], claim = randomUUID(); for (const ref of refs) await repo.prepare(ref, await deadline());
    const results = await Promise.allSettled(refs.map((ref, index) => repository(session(tc, 'duplicate-' + index)).claim(ref, 0, claim)));
    assert.equal(results.filter(x => x.status === 'fulfilled' && x.value === 'granted').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected' && x.reason instanceof PostgresDispatchClaimUncertainError).length, 1);
    assert.deepEqual((await Promise.all(refs.map(ref => repo.inspect(ref)))).map(x => x.state).sort(), ['dispatch_claimed', 'prepared']);
  });
  for (const prepare of [true, false]) {
    await check(`actual COMMIT ACK dropped over TCP, prepare=${prepare}: no grant and no replay`, async (tc, record) => {
      const ref = id(), claim = randomUUID(); await repo.prepare(ref, await deadline());
      const proxy = await commitAckProxy(cluster.port); tc.after(() => proxy.close());
      const raw = session(tc, 'ack-loss-' + prepare, { throughPort: proxy.port, prepare });
      await raw.unsafe('SELECT pg_backend_pid()'); proxy.arm();
      const pending = repository(raw).claim(ref, 0, claim); pending.catch(() => {});
      await proxy.dropped;
      await assert.rejects(pending, PostgresDispatchClaimUncertainError);
      const stored = await repo.inspect(ref); assert.equal(stored.state, 'dispatch_claimed'); assert.equal(stored.dispatch_claim_id, claim);
      await delay(100); record.proxy = { ...proxy.observations };
      assert.deepEqual(record.proxy, { connections: 1, commitCommands: 1, claimUpdates: 1, droppedCommitAcks: 1 });
      const fresh = repository(session(tc, 'fresh-' + prepare));
      assert.equal(await fresh.claim(ref, 0, claim), 'not_granted');
      assert.equal(await fresh.claim(ref, 1, claim), 'not_granted');
    });
  }
  await check('scope, context and revision mismatches do not grant over native wire', async tc => {
    const ref = id(); await repo.prepare(ref, await deadline()); const other = repository(session(tc, 'scope'));
    for (const patch of [{ userId: 'other' }, { workspaceId: 'other-workspace' }, { apiKeyId: 'other-key' },
      { contextSha256: 'b'.repeat(64) }, { operation: 'images.edits' }, { attemptIndex: 2 }]) {
      assert.equal(await other.inspect({ ...ref, ...patch }), null);
      assert.equal(await other.claim({ ...ref, ...patch }, 0, randomUUID()), 'not_granted');
    }
    assert.equal(await other.claim(ref, 1, randomUUID()), 'not_granted');
    assert.equal((await repo.inspect(ref)).state, 'prepared');
  });
  await check('permission probe exposes creation key-lock privilege gap without granting it', async (tc, record) => {
    await admin.unsafe(`CREATE ROLE intent_probe NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
      GRANT USAGE ON SCHEMA cinatoken_gateway TO intent_probe;
      GRANT SELECT, INSERT, UPDATE ON ${table} TO intent_probe;
      GRANT SELECT ON cinatoken_gateway.api_keys TO intent_probe;`).simple();
    const raw = session(tc, 'permission'); await raw.unsafe('SET ROLE intent_probe');
    const ref = id(), expiry = await deadline();
    await assert.rejects(raw.unsafe(`INSERT INTO ${table}
      (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
      VALUES ($1,1,'user','key','workspace','images.generations',$2,$3)`, [ref.requestId, ref.contextSha256, expiry]), error => {
      record.sqlstate = error.code; assert.equal(error.code, '42501'); assert.match(error.message, /api_keys/); return true;
    });
    assert.equal(await repo.inspect(ref), null);
    record.openFinding = 'C03.5: SECURITY INVOKER creation FOR SHARE requires API-key UPDATE privilege; no such privilege granted, production role design remains open';
    await assert.rejects(raw.unsafe(`DELETE FROM ${table}`), error => error.code === '42501');
    await assert.rejects(raw.unsafe(`TRUNCATE ${table}`), error => error.code === '42501');
    await assert.rejects(raw.unsafe('UPDATE cinatoken_gateway.api_keys SET status=$1', ['disabled']), error => error.code === '42501');
  });
  await check('expired claimed rows classify as unknown without mutating financial state', async () => {
    const ref = id(), expiry = await deadline(500); await repo.prepare(ref, expiry);
    assert.equal(await repo.claim(ref, 0, randomUUID()), 'granted'); await expire(expiry);
    assert.equal(await repo.classifyOverdue(ref, 1), true); assert.equal((await repo.inspect(ref)).state, 'outcome_unknown');
    assert.equal(await repo.classifyOverdue(ref, 2), false);
    assert.deepEqual(await financialSnapshot(), initialFinancial);
  });
  t.diagnostic(cluster.identity.version);
});
