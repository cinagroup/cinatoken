import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createRequestDeadline, RequestExecutionStoppedError } from './request-deadline.ts';

for (const stop of ['client', 'deadline']) for (const result of ['resolve', 'reject']) for (const nested of [false, true]) {
  test(`preparation receipt ${stop}/${result}/nested=${nested}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const parent = new AbortController(), entered = Promise.withResolvers(), raw = Promise.withResolvers(), receipts = [];
    const owner = createRequestDeadline(1100, parent.signal, undefined, receipt => receipts.push(receipt));
    const operation = () => { entered.resolve(); return raw.promise; };
    const waiting = owner.wait(nested ? () => owner.wait(operation) : operation);
    const rejected = assert.rejects(waiting, RequestExecutionStoppedError);
    await entered.promise;
    if (stop === 'client') parent.abort(); else t.mock.timers.tick(100);
    await rejected;
    assert.equal(receipts.length, nested ? 2 : 1);
    let finished = false; const all = Promise.all(receipts).then(() => { finished = true; });
    owner.dispose(); await tick(); assert.equal(finished, false, 'dispose is not operation completion');
    if (result === 'resolve') raw.resolve('private late result'); else raw.reject(Error('PRIVATE_READ_FAILURE'));
    await all; assert.equal(finished, true); assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  });
}

for (const cleanup of ['resolve', 'reject', 'throw']) test(`preparation receipt includes late cleanup ${cleanup}`, async () => {
  const parent = new AbortController(), entered = Promise.withResolvers(), raw = Promise.withResolvers(), ack = Promise.withResolvers();
  let receipt, cleanups = 0;
  const owner = createRequestDeadline(Date.now() + 10000, parent.signal, undefined, task => { receipt = task; });
  const pending = owner.wait(() => { entered.resolve(); return raw.promise; }, async value => {
    assert.equal(value, 'late'); cleanups++; if (cleanup === 'throw') throw Error('PRIVATE_CLEANUP'); await ack.promise;
  });
  const rejected = assert.rejects(pending, RequestExecutionStoppedError);
  await entered.promise; parent.abort(); await rejected; owner.dispose();
  let finished = false; void receipt.then(() => { finished = true; }, () => { finished = true; });
  raw.resolve('late');
  if (cleanup !== 'throw') { await tick(); assert.equal(finished, false); }
  if (cleanup === 'resolve') { ack.resolve(); await receipt; }
  else { if (cleanup === 'reject') ack.reject(Error('PRIVATE_CLEANUP')); await assert.rejects(receipt, /PRIVATE_CLEANUP/); }
  assert.equal(cleanups, 1);
});

test('preparation registration failure never starts work', async () => {
  let calls = 0;
  const owner = createRequestDeadline(Date.now() + 10000, undefined, undefined, () => { throw Error('registration failed'); });
  await assert.rejects(owner.wait(async () => { calls++; }), /registration failed/); assert.equal(calls, 0); owner.dispose();
});

for (const mode of ['pre-abort', 'queued-abort', 'sync-throw', 'success']) test(`preparation receipt ${mode}`, async () => {
  const parent = new AbortController(), receipts = []; let calls = 0;
  if (mode === 'pre-abort') parent.abort();
  const owner = createRequestDeadline(Date.now() + 10000, parent.signal, undefined, receipt => receipts.push(receipt));
  const pending = owner.wait(() => { calls++; if (mode === 'sync-throw') throw Error('synthetic'); return Promise.resolve(17); });
  if (mode === 'queued-abort') parent.abort();
  if (mode === 'success') assert.equal(await pending, 17); else await assert.rejects(pending);
  await Promise.all(receipts); assert.equal(receipts.length, mode === 'pre-abort' ? 0 : 1);
  assert.equal(calls, mode.endsWith('abort') ? 0 : 1); owner.dispose();
});
