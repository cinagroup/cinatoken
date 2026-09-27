import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresRecoveryRun, runUsageRecoveryPostgres } from './run-usage-recovery-postgres.ts';
import { ownPostgresRecoveryOperations, POSTGRES_RECOVERY_DEADLINE_FENCE,
  POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE } from './postgres-recovery-operation-owner.ts';
import { supervisePostgresRecoveryRun } from './supervise-usage-recovery-postgres.ts';
import { postgresRecoveryScan } from './usage-recovery-jobs-postgres.ts';
import { createPostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline.ts';

const marker = 'postgres-js-3.4.9-owned-cancel-v302';
const scanFence = 'postgres-js-3.4.9-owned-scan-v307';
const options = Object.freeze({
  scope: Object.freeze({ kind: 'all' }), maxRegistrations: 1, maxItems: 1,
  concurrency: 1, leaseSeconds: 30, runBudgetMs: 60_000,
  reservedBytesPerScan: 512, reservedBytesPerConsumer: 1024,
});
const profile = Object.freeze({ observationBudgetMs: 10, cleanupObservationMs: 5 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function thrown(fn) {
  try { fn(); } catch (error) { return error; }
  assert.fail('expected a synchronous failure');
}
function clock() {
  let time = 0, serial = 0;
  const timers = new Map();
  const api = {
    now: () => time,
    set(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clear(id) { timers.delete(id); },
  };
  return {
    api,
    advance(to) {
      time = to;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
    count: () => timers.size,
  };
}
function capacity() {
  let held = 0, released = 0;
  const byBytes = new Map();
  return {
    tryAcquire(bytes) {
      held++;
      byBytes.set(bytes, (byBytes.get(bytes) ?? 0) + 1);
      let done = false;
      return { release() { assert.equal(done, false, 'hold released at most once'); done = true;
        held--; released++; byBytes.set(bytes, byBytes.get(bytes) - 1); } };
    },
    held: () => held,
    heldFor: bytes => byBytes.get(bytes) ?? 0,
    released: () => released,
  };
}
function receiptFixture() {
  const primary = deferred();
  const result = deferred();
  const transportClosed = deferred();
  const transportRawClosed = deferred();
  const primaryCloseObserved = deferred();
  const primaryRawClosed = deferred();
  let cancelled = 0;
  const handle = Object.freeze({
    result: result.promise, transportClosed: transportClosed.promise,
    transportRawClosed: transportRawClosed.promise,
    primaryCloseObserved: primaryCloseObserved.promise,
    primaryRawClosed: primaryRawClosed.promise,
    snapshot: () => Object.freeze({ result: 'pending', transportClose: 'pending',
      transportRawClose: 'pending', primaryClose: 'pending', primaryRawClose: 'pending' }),
  });
  const query = {
    then: (yes, no) => primary.promise.then(yes, no),
    values: () => primary.promise,
    cancelOwned() { cancelled++; return handle; },
  };
  return {
    query, handle, primary, result, transportClosed, transportRawClosed,
    primaryCloseObserved, primaryRawClosed, cancelled: () => cancelled,
    settleReceipts() {
      result.resolve({ status: 'transport_closed' });
      transportClosed.resolve({ status: 'close_observed' });
      transportRawClosed.resolve({ status: 'not_observable' });
      primaryCloseObserved.resolve({ status: 'close_observed' });
      primaryRawClosed.resolve({ status: 'not_observable' });
    },
  };
}
function client({ candidate = true, fenced = true, deadlineFenced = false, statementFenced = false,
  first = null, second = null, throwFirst = false } = {}) {
  const calls = [];
  const raw = {
    options: { parsers: {}, serializers: {} },
    ...(candidate ? { ownedCancellation: marker, ...(fenced ? { ownedRecoveryScanFence: scanFence } : {}),
      ...(deadlineFenced ? { ownedRecoveryDeadlineFence: POSTGRES_RECOVERY_DEADLINE_FENCE } : {}),
      ...(statementFenced ? { recoveryStatementDeadlineFence: POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE } : {}) } : {}),
    unsafe(query, params = [], extra) {
      calls.push({ query, params, extra });
      assert.match(query, /^SELECT\s/i, 'controlled run issues only recovery reads in this fixture');
      if (calls.length === 1 && throwFirst) throw new Error('private synchronous driver failure');
      if (calls.length === 1 && first) return first.query;
      if (calls.length === 2 && second) return second.query;
      const response = Promise.resolve([]);
      return { then: (yes, no) => response.then(yes, no), values: () => response,
        cancelOwned: () => { throw new Error('unexpected cancellation of settled scan'); } };
    },
    begin() { throw new Error('no transaction or financial write expected'); },
    end() { throw new Error('caller shared pool must remain open'); },
  };
  return { db: { driver: 'postgres', raw }, calls };
}

test('v307 default recovery run keeps both scans ordinary without requiring candidate marker', async () => {
  const f = client({ candidate: false }), holds = capacity();
  const run = createPostgresRecoveryRun(f.db, options, holds);
  const result = await run.completion;
  assert.equal(result.resources, 'confirmed');
  assert.equal(holds.held(), 0);
  assert.equal(holds.released(), 2);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.extra), [undefined, undefined]);
  assert.deepEqual(f.calls.map(call => call.query), [
    postgresRecoveryScan('unregistered', options.scope, options.maxRegistrations).query,
    postgresRecoveryScan('due', options.scope, options.maxItems).query,
  ]);
  assert.equal(run.cancelActiveScan(), null);
});

for (const scope of [options.scope, Object.freeze({ kind: 'tenant', userId: 'user-1', workspaceId: 'workspace:2' })]) {
  test('v307 owned recovery run sends only catalogued '+scope.kind+' scans with bound parameters', async () => {
    const f = client(), holds = capacity(), input = { ...options, scope };
    const run = createPostgresRecoveryRun(f.db, input, holds, { ownedScans: true });
    assert.equal((await run.completion).resources, 'confirmed');
    assert.equal(f.calls.length, 2);
    for (const [index, kind, limit] of [[0, 'unregistered', options.maxRegistrations], [1, 'due', options.maxItems]]) {
      const expected = postgresRecoveryScan(kind, scope, limit);
      assert.equal(f.calls[index].query, expected.query);
      assert.deepEqual(f.calls[index].params, expected.params);
      assert.deepEqual(f.calls[index].extra, { owned_cancel: true });
      assert.ok(!f.calls[index].query.includes(scope.userId ?? '__absent_user__'));
      assert.ok(!f.calls[index].query.includes(scope.workspaceId ?? '__absent_workspace__'));
    }
    assert.equal(holds.held(), 0);
    assert.equal(run.cancelActiveScan(), null);
  });
}

test('v307 owned scan rejects missing candidate before SQL or capacity acquisition', async () => {
  const f = client({ candidate: false }), holds = capacity();
  assert.throws(() => createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true }),
    /Owned cancellation driver required/);
  assert.deepEqual(f.calls, []);
  assert.equal(holds.held(), 0);
});

test('v307 old cancellation marker without scan fence rejects ownedScans before SQL or capacity', () => {
  const f = client({ fenced: false }), holds = capacity();
  assert.throws(() => createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true }),
    /Owned recovery scan driver required/);
  assert.deepEqual(f.calls, []);
  assert.equal(holds.held(), 0);
});

test('v311 rejects an old scan candidate before capacity or SQL when a deadline must reach final dispatch', () => {
  const f = client(), holds = capacity();
  const deadline = createPostgresRecoveryInvocationDeadline(options.runBudgetMs, () => 0);
  assert.throws(() => createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true, deadline }),
    /Owned recovery scan deadline driver required/);
  assert.deepEqual(f.calls, []);assert.equal(holds.held(), 0);
  const direct = client({ statementFenced: true });
  const owner = ownPostgresRecoveryOperations(direct.db, () => {}, deadline);
  assert.throws(() => owner.ownedRecoveryScan('unregistered', options.scope, 1),
    /Owned recovery scan deadline driver required/);
  assert.equal(owner.pending(), 0);
  assert.deepEqual(direct.calls, []);
});

test('v311 passes the same deadline to both fixed scans through the owned driver option', async () => {
  const f = client({ deadlineFenced: true, statementFenced: true }), holds = capacity();
  const deadline = createPostgresRecoveryInvocationDeadline(options.runBudgetMs, () => 0);
  const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true, deadline });
  assert.equal((await run.completion).resources, 'confirmed');
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.extra.owned_cancel, true);
    assert.equal(call.extra.admission_deadline, deadline);
  }
  assert.equal(holds.held(), 0);
});

test('v307 owner also rejects an old-marker-only fixed scan before constructing a Query', async () => {
  const f = client({ fenced: false });
  const owner = ownPostgresRecoveryOperations(f.db, () => {});
  assert.throws(() => owner.ownedRecoveryScan('unregistered', options.scope, 1),
    /Owned recovery scan driver required/);
  assert.deepEqual(f.calls, []);
  assert.equal(owner.pending(), 0);
  assert.equal(await owner.drain(), 'confirmed');
});

test('v307 legacy wait-only runner rejects owned scans before SQL or capacity acquisition', async () => {
  const f = client(), holds = capacity();
  await assert.rejects(runUsageRecoveryPostgres(f.db, options, holds, { ownedScans: true }),
    /single-execution handle/);
  assert.deepEqual(f.calls, []);
  assert.equal(holds.held(), 0);
});

test('v307 owner construction failure after capacity acquisition retains an uncertain hold', async () => {
  const holds = capacity();
  let sqlCalls = 0;
  const raw = { ownedCancellation: marker, ownedRecoveryScanFence: scanFence,
    get options() { throw new Error('private owner constructor failure'); },
    unsafe() { sqlCalls++; throw new Error('SQL must not start'); } };
  const run = createPostgresRecoveryRun({ driver: 'postgres', raw }, options, holds,
    { ownedScans: true });
  const result = await run.completion;
  assert.equal(sqlCalls, 0);
  assert.equal(result.resources, 'unconfirmed');
  assert.equal(result.retainedHolds, 1);
  assert.equal(result.stopReason, 'database_unconfirmed');
  assert.equal(holds.held(), 1);
  assert.equal(holds.released(), 0);
  assert.equal(run.snapshot().uncertainLanes, 1);
  assert.equal(run.snapshot().heldLanes, 1);
  assert.ok(!JSON.stringify(run.snapshot()).includes('private owner constructor failure'));
});

test('v307 caller SQL injection cannot become a controlled recovery scan', () => {
  const f = client(), holds = capacity();
  const poisoned = { ...options, scope: { kind: 'tenant', userId: "user'; DELETE FROM ledger; --", workspaceId: 'workspace' } };
  assert.throws(() => createPostgresRecoveryRun(f.db, poisoned, holds, { ownedScans: true }), /Invalid recovery scope/);
  assert.deepEqual(f.calls, []);
  assert.equal(holds.held(), 0);
  assert.throws(() => postgresRecoveryScan('DELETE FROM ledger', options.scope, 1), /Invalid recovery scan kind/);
});

test('v307 synchronous driver throw after controlled SQL admission retains the scan hold', async () => {
  const f = client({ throwFirst: true }), holds = capacity();
  const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
  const result = await run.completion;
  assert.equal(result.resources, 'unconfirmed');
  assert.equal(result.retainedHolds, 1);
  assert.equal(holds.held(), 1);
  assert.equal(holds.released(), 1);
  assert.equal(f.calls.length, 1, 'no readback, registration, claim or financial write');
  assert.deepEqual(f.calls[0].extra, { owned_cancel: true });
  assert.equal(run.snapshot().uncertainLanes, 1);
  assert.ok(!JSON.stringify(run.snapshot()).includes('private synchronous driver failure'));
});

test('v307 synchronous cancelOwned throw is one attempt with a cached sanitized failure', async () => {
  const primary = deferred();
  let attempts = 0;
  const query = { then: (yes, no) => primary.promise.then(yes, no),
    cancelOwned() { attempts++; throw new Error('sensitive transport endpoint and SQL'); } };
  const f = client({ first: { query } }), holds = capacity();
  const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
  const first = thrown(() => run.cancelActiveScan());
  const second = thrown(() => run.cancelActiveScan());
  assert.equal(attempts, 1);
  assert.equal(first, second, 'repeated cancellation returns the same sanitized failure');
  assert.equal(first.code, 'CANCEL_TRANSPORT_FAILED');
  assert.equal(first.message, 'Cancellation transport failed');
  assert.ok(!JSON.stringify(run.snapshot()).includes('sensitive'));
  assert.equal(holds.heldFor(options.reservedBytesPerScan), 1);
  primary.resolve([]);
  const result = await run.completion;
  assert.equal(result.resources, 'unconfirmed');
  assert.equal(result.retainedHolds, 1);
  assert.equal(holds.heldFor(options.reservedBytesPerScan), 1);
  assert.equal(f.calls.length, 1);
});

for (const [label, malformed] of [
  ['null', null], ['empty', {}], ['partial', { result: Promise.resolve({ status: 'transport_closed' }) }],
]) {
  test('v307 malformed cancelOwned handle is not retried: '+label, async () => {
    const primary = deferred();
    let attempts = 0;
    const query = { then: (yes, no) => primary.promise.then(yes, no),
      cancelOwned() { attempts++; return malformed; } };
    const f = client({ first: { query } }), holds = capacity();
    const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
    const first = thrown(() => run.cancelActiveScan());
    const second = thrown(() => run.cancelActiveScan());
    assert.equal(first, second);
    assert.equal(first.code, 'CANCEL_TRANSPORT_FAILED');
    assert.equal(first.message, 'Cancellation transport failed');
    assert.equal(attempts, 1);
    primary.resolve([]);
    const result = await run.completion;
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.heldFor(options.reservedBytesPerScan), 1);
    assert.equal(f.calls.length, 1);
  });
}

for (const absentQuery of [true, false]) {
  test('v307 immediate cancel after '+(absentQuery?'sync unsafe throw':'missing cancelOwned')+' yields fixed no-driver error', async () => {
    const f = absentQuery ? client({ throwFirst: true })
      : client({ first: { query: { then: (yes, no) => Promise.resolve([]).then(yes, no) } } });
    const holds = capacity();
    const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
    const error = thrown(() => run.cancelActiveScan());
    assert.equal(error.constructor, TypeError);
    assert.equal(error.message, 'Owned cancellation driver required');
    const result = await run.completion;
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.heldFor(options.reservedBytesPerScan), 1);
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(run.snapshot()).includes('private synchronous driver failure'));
  });
}

test('v307 a nonempty owned scan keeps ensure/read and claim lock on ordinary SQL', async () => {
  const identity = { request_id: 'request', attempt_index: 1, user_id: 'user', api_key_id: 'key',
    workspace_id: 'workspace', operation: 'images.generations', context_sha256: 'a'.repeat(64),
    dispatch_claim_id: '00000000-0000-4000-8000-000000000001', payload_sha256: 'b'.repeat(64) };
  const job = { ...identity, state: 'pending', revision: '0', attempts: 0,
    last_transition: 'enqueued', lease_seconds: null, lease_expires_at_ms: null,
    available_at_ms: '1000', last_error: null, created_at_ms: '1000', updated_at_ms: '1000' };
  const calls = [];
  const raw = { ownedCancellation: marker, ownedRecoveryScanFence: scanFence,
    options: { parsers: {}, serializers: {} },
    unsafe(query, params = [], extra) {
      calls.push({ query, params, extra });
      const rows = query.includes('NOT EXISTS') ? [identity]
        : query.startsWith('INSERT INTO') ? []
          : query.includes('FOR UPDATE OF j') ? []
            : query.includes('j.state IN') ? [{ ...identity, revision: '0' }]
              : query.startsWith('SELECT') ? [job] : null;
      assert.ok(rows, 'fixture must classify every SQL without accepting a financial write');
      const promise = Promise.resolve(rows);
      return { then: (yes, no) => promise.then(yes, no), values: () => promise,
        cancelOwned() { throw new Error('no automatic cancellation expected'); } };
    },
    begin(run) { return run(raw); },
    end() { throw new Error('shared pool must stay open'); } };
  const holds = capacity();
  const run = createPostgresRecoveryRun({ driver: 'postgres', raw }, options, holds,
    { ownedScans: true });
  const result = await run.completion;
  assert.equal(result.discovered, 1);
  assert.equal(result.registered, 1);
  assert.equal(result.scanned, 1);
  assert.equal(result.skipped, 1, 'synthetic lock returned no lease; finance path was not exercised');
  assert.equal(result.claimed, 0);
  assert.equal(result.committed, 0);
  assert.equal(result.resources, 'confirmed');
  assert.equal(holds.held(), 0);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => call.extra), [
    { owned_cancel: true }, undefined, undefined, { owned_cancel: true }, undefined,
  ]);
  assert.equal(calls[0].query, postgresRecoveryScan('unregistered', options.scope, 1).query);
  assert.match(calls[1].query, /^INSERT INTO/);
  assert.match(calls[2].query, /^SELECT/);
  assert.equal(calls[3].query, postgresRecoveryScan('due', options.scope, 1).query);
  assert.match(calls[4].query, /FOR UPDATE OF j/);
  assert.ok(calls.every(call => !/\b(?:COMMIT|UPDATE .*SET|COPY)\b/i.test(call.query)));
});

test('v307 one observation expires without auto-cancel, SQL replay or early hold release', async () => {
  const first = receiptFixture(), f = client({ first }), holds = capacity(), time = clock();
  const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
  const watch = supervisePostgresRecoveryRun(run, profile, { clock: time.api });
  assert.equal('ownedStatement' in run, false, 'run does not expose caller SQL or Query mode');
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(holds.held(), 2);
  assert.equal(first.cancelled(), 0);
  assert.throws(() => supervisePostgresRecoveryRun(run, profile, { clock: time.api }), /already has an observation owner/);
  time.advance(15);
  const expired = await watch.observation;
  assert.equal(expired.status, 'observation_expired');
  assert.equal(expired.snapshot.heldLanes, 2);
  assert.equal(holds.held(), 2);
  assert.equal(first.cancelled(), 0);
  assert.equal(watch.completion, run.completion);
  assert.equal(time.count(), 0);
  assert.throws(() => supervisePostgresRecoveryRun(run, profile, { clock: time.api }), /already has an observation owner/);
  first.primary.resolve([]);
  assert.equal((await watch.completion).resources, 'confirmed');
  assert.equal(f.calls.length, 1, 'stopped run must not start due scan or writes');
  assert.equal(holds.held(), 0);
  assert.equal(first.cancelled(), 0);
  assert.equal(expired.snapshot.heldLanes, 2, 'earlier observation remains frozen');
});

test('v307 after first scan settles, manual cancellation targets only the active due Query', async () => {
  const due = receiptFixture(), f = client({ second: due }), holds = capacity();
  const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].query, postgresRecoveryScan('due', options.scope, options.maxItems).query);
  const handle = run.cancelActiveScan();
  assert.equal(handle, due.handle);
  assert.equal(due.cancelled(), 1);
  due.primary.resolve([]);
  due.settleReceipts();
  const result = await run.completion;
  assert.equal(result.resources, 'unconfirmed');
  assert.equal(result.retainedHolds, 1);
  assert.equal(holds.heldFor(options.reservedBytesPerScan), 1);
  assert.equal(f.calls.length, 2, 'no claim or financial work follows cancelled due scan');
  assert.equal(run.cancelActiveScan(), null);
});

for (const transportFailure of [false, true]) {
  test('v307 manual scan cancel keeps main SQL and five receipts separate '+(transportFailure?'after transport failure':'after transport success'), async () => {
    const first = receiptFixture(), f = client({ first }), holds = capacity();
    const run = createPostgresRecoveryRun(f.db, options, holds, { ownedScans: true });
    await tick();
    assert.equal(f.calls.length, 1);
    const handle = run.cancelActiveScan();
    assert.equal(handle, first.handle, 'same Query cancellation handle is returned');
    for (const method of ['cursor', 'describe', 'forEach', 'readable', 'unsafe'])
      assert.equal(method in handle, false, 'cancellation receipt must not expose '+method);
    assert.equal(run.cancelActiveScan(), handle, 'repeated cancel is idempotent');
    assert.equal(first.cancelled(), 1);
    assert.equal(holds.held(), 2);
    let completed = false;
    void run.completion.then(() => { completed = true; });
    first.primary.resolve([]);
    await tick();
    assert.equal(completed, false, 'main success is not a transport/close receipt');
    assert.equal(holds.heldFor(options.reservedBytesPerScan), 1, 'cancelled scan hold remains retained');
    if (transportFailure) first.result.reject(new Error('private synthetic cancel failure'));
    else first.result.resolve({ status: 'transport_closed' });
    await tick();
    assert.equal(completed, false, 'cancel transport result is not a main/close receipt');
    assert.equal(holds.heldFor(options.reservedBytesPerScan), 1);
    first.transportClosed.resolve({ status: 'close_observed' });
    first.transportRawClosed.resolve({ status: 'not_observable' });
    first.primaryCloseObserved.resolve({ status: 'close_observed' });
    await tick();
    assert.equal(completed, false, 'primary raw-close receipt remains separately owned');
    first.primaryRawClosed.resolve({ status: 'not_observable' });
    const result = await run.completion;
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(holds.released(), 1);
    assert.equal(f.calls.length, 1, 'no later scan, registration, claim or financial write');
    assert.equal(run.snapshot().uncertainLanes, 1);
    assert.ok(!JSON.stringify(run.snapshot()).includes('private synthetic cancel failure'));
    assert.equal(run.cancelActiveScan(), null);
    if (transportFailure) await assert.rejects(handle.result, /private synthetic cancel failure/);
  });
}
