import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { withUnpublishedPostgresClient } from '@octafuse/core';
import { createSharedStorageInitializer } from './shared-storage-initializer.ts';

for (const mode of ['success', 'confirmed', 'unconfirmed', 'generic', 'sync-throw']) {
  test(`Node shared storage ${mode}: one owner, no internal replay`, async () => {
    const gate = Promise.withResolvers(), entered = Promise.withResolvers(), ack = Promise.withResolvers();
    let calls = 0, closes = 0; const value = { shared: true };
    const resolve = createSharedStorageInitializer(input => {
      calls++; assert.equal(input, 'first');
      if (mode === 'sync-throw') throw Error('synthetic');
      if (mode === 'success') return gate.promise.then(() => value);
      if (mode === 'generic') return gate.promise;
      return withUnpublishedPostgresClient({ end: async () => { closes++; entered.resolve(); await ack.promise; } }, 'session', () => gate.promise);
    });
    const a = resolve('first'), b = resolve('ignored'); assert.equal(a, b);
    const results = Promise.allSettled([a, b]); await tick(); assert.equal(calls, 1);
    if (mode === 'success') gate.resolve(); else gate.reject(Error('synthetic initialization'));
    // sync-throw never consumes gate.
    void gate.promise.catch(() => {});
    if (mode === 'confirmed' || mode === 'unconfirmed') {
      await entered.promise; assert.equal(resolve('ignored'), a); assert.equal(calls, 1);
      if (mode === 'confirmed') ack.resolve(); else ack.reject(Error('synthetic close'));
    }
    const settled = await results;
    assert.equal(settled[0].status, mode === 'success' ? 'fulfilled' : 'rejected');
    assert.equal(settled[1].status, settled[0].status); assert.equal(calls, 1);
    if (mode === 'success') { assert.equal(await resolve('ignored'), value); assert.equal(closes, 0); }
    else if (mode === 'unconfirmed') { assert.equal(resolve('ignored'), a); await assert.rejects(resolve('ignored')); assert.equal(calls, 1); }
    else { const next = resolve('first'); assert.notEqual(next, a); await assert.rejects(next); assert.equal(calls, 2); }
  });
}
