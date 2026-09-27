import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';

const endedMessage = 'CONNECTION_ENDED: Connection ended before dispatch';
const retiring = {
  backendIdentity: true,
  holdReady: query => query === 'select first',
  holdPrimaryClose: true,
  rawCloseGate: true,
};

function outcome(value) {
  return Promise.resolve(value).then(
    result => {
      result?.release?.();
      return { status: 'fulfilled' };
    },
    error => ({
      status: 'rejected',
      code: error?.code,
      message: error?.message,
      exposesAddress: error != null && Object.hasOwn(error, 'address'),
      exposesPort: error != null && Object.hasOwn(error, 'port'),
    }),
  );
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' did not settle')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertEnded(value) {
  assert.deepEqual(value, {
    status: 'rejected',
    code: 'CONNECTION_ENDED',
    message: endedMessage,
    exposesAddress: false,
    exposesPort: false,
  });
}

test('shutdown rejects globally queued Query and reserve behind retired owned-cancel connection',
  { timeout: 5000 }, async t => {
    const p = await peer(t, retiring);
    const statement = p.owner.ownedStatement('select first');
    await p.entered;
    const cancel = statement.cancel();
    await p.cancelled;

    const queuedQuery = outcome(p.raw.unsafe('select queued'));
    const queuedReserve = outcome(p.raw.reserve());
    await tick();
    assert.deepEqual(p.queries, ['select first']);

    p.release();
    await bounded(outcome(statement.completion), 'primary statement');
    p.emitSyntheticPrimaryClose();
    await bounded(p.rawCloseRequested, 'retiring raw.close request');
    await bounded(p.raw.end(), 'pool.end');

    p.releaseRawClose();
    assert.deepEqual(await bounded(cancel.primaryRawClosed, 'primary raw.closed'), { status: 'raw_closed' });
    const [query, reserve] = await bounded(Promise.all([queuedQuery, queuedReserve]), 'queued Query/reserve');
    assertEnded(query);
    assertEnded(reserve);
    await tick();
    assert.deepEqual(p.queries, ['select first'], 'raw.closed must not dispatch SQL after pool.end');
  });

test('shutdown rejects newly executed lazy Query and new reserve without dispatch',
  { timeout: 5000 }, async t => {
    const p = await peer(t);
    await bounded(p.raw.end(), 'pool.end');

    const lazyQuery = p.raw.unsafe('select after end');
    const [query, reserve] = await bounded(Promise.all([
      outcome(lazyQuery),
      outcome(p.raw.reserve()),
    ]), 'new Query/reserve after end');
    assertEnded(query);
    assertEnded(reserve);
    assert.deepEqual(p.queries, []);
  });

test('shutdown settles after rejected retiring raw.closed without releasing the owner',
  { timeout: 5000 }, async t => {
    const p = await peer(t, retiring);
    const statement = p.owner.ownedStatement('select first');
    await p.entered;
    const cancel = statement.cancel();
    await p.cancelled;

    const queuedQuery = outcome(p.raw.unsafe('select queued'));
    await tick();
    assert.deepEqual(p.queries, ['select first']);

    p.emitSyntheticPrimaryClose();
    const primary = await bounded(outcome(statement.completion), 'closed primary statement');
    assert.equal(primary.status, 'rejected');
    await bounded(p.rawCloseRequested, 'retiring raw.close request');
    p.rejectRawClose();
    assert.deepEqual(await bounded(cancel.primaryRawClosed, 'rejected primary raw.closed'),
      { status: 'raw_close_rejected' });

    await bounded(p.raw.end(), 'pool.end after rejected raw.closed');
    assertEnded(await bounded(queuedQuery, 'queued Query after rejected raw.closed'));
    assert.equal(await bounded(p.owner.drain(), 'owner drain'), 'unconfirmed');
    assert.equal(p.owner.unconfirmed(), true);
    p.releaseRawClose();
    await tick();
    assert.deepEqual(p.queries, ['select first'], 'failed raw.closed must not dispatch late SQL');
  });

test('shutdown settles the wait queue when retiring raw.closed is unavailable',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { ...retiring, omitPrimaryRawClosed: true });
    const statement = p.owner.ownedStatement('select first');
    await p.entered;
    const cancel = statement.cancel();
    await p.cancelled;

    const queuedQuery = outcome(p.raw.unsafe('select queued'));
    await tick();
    p.emitSyntheticPrimaryClose();
    assert.equal((await bounded(outcome(statement.completion), 'closed primary statement')).status, 'rejected');
    assert.deepEqual(await bounded(cancel.primaryRawClosed, 'missing primary raw.closed'),
      { status: 'not_observable' });
    await bounded(p.raw.end(), 'pool.end without raw.closed');
    assertEnded(await bounded(queuedQuery, 'queued Query without raw.closed'));
    assert.equal(await bounded(p.owner.drain(), 'owner drain'), 'unconfirmed');
    p.releaseRawClose();
    await tick();
    assert.deepEqual(p.queries, ['select first'], 'missing raw.closed must not dispatch late SQL');
  });

test('portable shutdown keeps active SQL owned while rejecting the global wait queue',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { holdReady: query => query === 'select first', beforeSocket: () => {} });
    const active = outcome(p.raw.unsafe('select first'));
    await p.entered;
    const queued = outcome(p.raw.unsafe('select queued'));
    await tick();
    assert.deepEqual(p.queries, ['select first']);

    const firstEnd = p.raw.end();
    const repeatedEnd = p.raw.end();
    assertEnded(await bounded(queued, 'globally queued Query'));
    assert.deepEqual(p.queries, ['select first']);
    p.release();
    assert.deepEqual(await bounded(active, 'already active SQL'), { status: 'fulfilled' });
    await bounded(Promise.all([firstEnd, repeatedEnd]), 'repeated graceful end');
    assert.deepEqual(p.queries, ['select first'], 'shutdown cannot dispatch the old wait queue');
  });
