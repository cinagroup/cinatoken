import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { createPostgresRecoveryRun } from './run-usage-recovery-postgres.ts';
import { supervisePostgresRecoveryRun } from './supervise-usage-recovery-postgres.ts';
import { postgresRecoveryScan } from './usage-recovery-jobs-postgres.ts';

const candidate = Boolean(process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER);
const options = Object.freeze({ scope: Object.freeze({ kind: 'all' }), maxRegistrations: 1,
  maxItems: 1, concurrency: 1, leaseSeconds: 30, runBudgetMs: 60_000,
  reservedBytesPerScan: 512, reservedBytesPerConsumer: 1024 });

function capacity() {
  let held = 0, released = 0;
  return {
    tryAcquire() {
      held++;
      let done = false;
      return { release() { assert.equal(done, false); done = true; held--; released++; } };
    },
    held: () => held,
    released: () => released,
  };
}
async function bounded(value, label) {
  let timer;
  try {
    return await Promise.race([value, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' did not settle')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('v307 wire pre-dispatch cancel of the fixed scan starts no SQL and retains its lane',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {} });
    const holds = capacity();
    const run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    const handle = run.cancelActiveScan();
    assert.ok(handle);
    assert.deepEqual(await bounded(handle.result, 'pre-dispatch cancel result'), { status: 'not_dispatched' });
    assert.deepEqual(await handle.transportClosed, { status: 'not_started' });
    assert.deepEqual(await handle.transportRawClosed, { status: 'not_started' });
    assert.deepEqual(await handle.primaryCloseObserved, { status: 'not_started' });
    assert.deepEqual(await handle.primaryRawClosed, { status: 'not_started' });
    const result = await bounded(run.completion, 'pre-dispatch run completion');
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.cancelPackets, []);
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
  });

test('v307 wire fixed recovery scan owns the same Query and manual cancel cannot release its lane',
  { skip: !candidate, timeout: 5000 }, async t => {
    // beforeSocket forces the CF bundle's injected Node socket path; this is NOT workerd.
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {},
      holdReady: sql => sql.includes('NOT EXISTS') });
    const holds = capacity();
    const run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    await bounded(p.entered, 'fixed scan SQL entry');
    const expected = postgresRecoveryScan('unregistered', options.scope, options.maxRegistrations);
    assert.deepEqual(p.queries, [expected.query]);
    assert.equal(holds.held(), 2);
    assert.equal(run.snapshot().pending.statement, 1);
    const handle = run.cancelActiveScan();
    assert.ok(handle);
    assert.equal(run.cancelActiveScan(), handle);
    await bounded(p.cancelled, 'cancel packet');
    assert.deepEqual(p.cancelPackets, [{ pid: 1001, secret: 2001 }]);
    assert.deepEqual(await bounded(handle.result, 'cancel transport'), { status: 'transport_closed' });
    assert.deepEqual(await bounded(handle.transportClosed, 'cancel wrapper close'), { status: 'close_observed' });
    assert.deepEqual(await bounded(handle.transportRawClosed, 'cancel raw observation'), { status: 'not_observable' });
    let finished = false;
    void run.completion.then(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    assert.equal(holds.held(), 2, 'cancel transport does not settle primary SQL');
    p.release();
    const result = await bounded(run.completion, 'owned recovery completion');
    assert.deepEqual(await handle.primaryCloseObserved, { status: 'close_observed' });
    assert.deepEqual(await handle.primaryRawClosed, { status: 'not_observable' });
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(holds.released(), 1);
    assert.deepEqual(p.queries, [expected.query], 'no second scan or money write after cancel');
    assert.equal(run.cancelActiveScan(), null);
  });

test('v307 wire cancel setup failure stays distinct from a successful primary recovery read',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, holdReady: true,
      beforeSocket: ordinal => ordinal === 2 ? Promise.reject(new Error('synthetic cancel setup failure')) : undefined });
    const holds = capacity();
    const run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    await bounded(p.entered, 'fixed scan SQL entry');
    const handle = run.cancelActiveScan();
    assert.ok(handle);
    await assert.rejects(bounded(handle.result, 'cancel setup outcome'), { code: 'CANCEL_TRANSPORT_FAILED' });
    assert.deepEqual(await handle.transportClosed, { status: 'not_started' });
    assert.deepEqual(await handle.transportRawClosed, { status: 'not_started' });
    assert.equal(holds.held(), 2);
    p.release();
    const result = await bounded(run.completion, 'recovery completion after failed cancel');
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(p.cancelPackets.length, 0);
    assert.equal(p.queries.length, 1);
  });

test('v307 wire observation expiry never automatically sends a cancel packet or replays SQL',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {}, holdReady: true });
    const holds = capacity();
    const run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    const watch = supervisePostgresRecoveryRun(run,
      { observationBudgetMs: 10, cleanupObservationMs: 5 });
    await bounded(p.entered, 'fixed scan SQL entry');
    const expired = await bounded(watch.observation, 'bounded observation');
    assert.equal(expired.status, 'observation_expired');
    assert.equal(expired.snapshot.heldLanes, 2);
    assert.equal(holds.held(), 2);
    assert.deepEqual(p.cancelPackets, []);
    assert.equal(watch.completion, run.completion);
    assert.throws(() => supervisePostgresRecoveryRun(run,
      { observationBudgetMs: 10, cleanupObservationMs: 5 }), /already has an observation owner/);
    p.release();
    const result = await bounded(watch.completion, 'same recovery completion');
    assert.equal(result.resources, 'confirmed');
    assert.equal(holds.held(), 0);
    assert.equal(p.queries.length, 1);
    assert.deepEqual(p.cancelPackets, []);
  });
