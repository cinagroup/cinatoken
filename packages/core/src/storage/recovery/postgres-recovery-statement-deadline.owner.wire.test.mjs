import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { ownPostgresRecoveryOperations } from './postgres-recovery-operation-owner.ts';
import { createPostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline.ts';

const candidate = Boolean(process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER);

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' remained pending')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('v312 recovery owner executes an admitted ordinary statement through the tagged driver',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const owner = ownPostgresRecoveryOperations({ driver: 'postgres', raw: p.raw }, () => {}, deadline);
    await bounded(Promise.resolve(owner.client.raw.unsafe('SELECT recovery admitted')), 'admitted read');
    time = 10;
    assert.equal(await owner.drain(), 'confirmed');
    assert.deepEqual(p.queries, ['SELECT recovery admitted']);
  });

test('v312 queued ordinary statement expires at final dispatch and keeps its owner uncertain',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdReady: query => query === 'SELECT occupied', beforeSocket: () => {} });
    const occupied = Promise.resolve(p.raw.unsafe('SELECT occupied'));
    await bounded(p.entered, 'occupied statement');
    let time = 0, alarms = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const owner = ownPostgresRecoveryOperations({ driver: 'postgres', raw: p.raw }, () => { alarms++; }, deadline);
    const pending = Promise.resolve(owner.client.raw.unsafe('SELECT recovery queued'));
    await tick();
    assert.equal(owner.pending(), 1);
    time = 10;
    p.release();
    await bounded(occupied, 'occupied completion');
    await assert.rejects(bounded(pending, 'queued recovery statement'), { code: 'RECOVERY_ADMISSION_CLOSED' });
    assert.deepEqual(p.queries, ['SELECT occupied']);
    assert.equal(await owner.drain(), 'unconfirmed');
    assert.equal(alarms, 1);
  });
