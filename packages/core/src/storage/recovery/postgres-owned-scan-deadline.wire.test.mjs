import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { createPostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline.ts';
import { postgresRecoveryScan } from './usage-recovery-jobs-postgres.ts';

const candidate = Boolean(process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER);
const all = Object.freeze({ kind: 'all' });
const admissionError = { code: 'RECOVERY_ADMISSION_CLOSED' };

function statement(raw, deadline, scope = all) {
  const spec = postgresRecoveryScan('unregistered', scope, 1);
  return raw.unsafe(spec.query, spec.params,
    { owned_cancel: true, admission_deadline: deadline });
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' remained pending')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('v311 cold connection expires during socket setup and never executes the fixed scan',
  { skip: !candidate, timeout: 5000 }, async t => {
    const opening = deferred();
    t.after(() => opening.resolve());
    const p = await peer(t, { beforeSocket: () => opening.promise });
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const pending = Promise.resolve(statement(p.raw, deadline));
    await tick();
    time = 10;
    opening.resolve();
    await assert.rejects(bounded(pending, 'cold scan'), admissionError);
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v311 pool queued scan checks the same deadline at connection dispatch',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdReady: query => query === 'select occupied', beforeSocket: () => {} });
    const occupied = Promise.resolve(p.raw.unsafe('select occupied'));
    await bounded(p.entered, 'occupied query');
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const queued = Promise.resolve(statement(p.raw, deadline));
    await tick();
    time = 10;
    p.release();
    await bounded(occupied, 'occupied query completion');
    await assert.rejects(bounded(queued, 'queued scan'), admissionError);
    assert.deepEqual(p.queries, ['select occupied']);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v311 debug callback expiry is checked after build and before its synchronous wire write',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let time = 0, calls = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    p.raw.options.debug = () => { calls++; time = 10; };
    await assert.rejects(bounded(Promise.resolve(statement(p.raw, deadline)), 'debug scan'), admissionError);
    assert.equal(calls, 1);
    assert.deepEqual(p.queries, []);
  });

test('v311 checks and writes a small scan in one turn without a deferred setImmediate dispatch',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let time = 0;
    const writtenAt = [];
    const originalFactory = p.raw.options.socket;
    p.raw.options.socket = async (...args) => {
      const socket = await originalFactory(...args);
      const write = socket.write;
      socket.write = function(bytes, ...rest) {
        if (Buffer.from(bytes).includes(Buffer.from('request_usage_settlements')))
          writtenAt.push(time);
        return Reflect.apply(write, this, [bytes, ...rest]);
      };
      return socket;
    };
    await bounded(Promise.resolve(p.raw.unsafe('select warm')), 'warm connection');
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const pending = Promise.resolve(statement(p.raw, deadline));
    const nextTurn = new Promise(resolve => setImmediate(() => { time = 10; resolve(); }));
    await assert.rejects(bounded(pending, 'small scan'), admissionError);
    await nextTurn;
    assert.deepEqual(writtenAt, [0], 'Parse reaches socket.write before the next turn expires');
    assert.deepEqual(p.queries[0], 'select warm');
    assert.equal(p.queries.length, 1, 'after expiry, Parse is not followed by Execute');
  });

test('v311 expiry after Parse/Describe sends no Bind/Execute and leaves the original query rejected',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdDescribe: true, beforeSocket: () => {} });
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const pending = Promise.resolve(statement(p.raw, deadline));
    await bounded(p.described, 'Parse/Describe');
    time = 10;
    p.releaseDescribe();
    await assert.rejects(bounded(pending, 'post-Describe scan'), admissionError);
    assert.deepEqual(p.queries, [], 'Parse/Describe may be sent, but no Execute is dispatched');
    assert.deepEqual(p.cancelPackets, []);
  });

test('v311 Bind serializer can expire admission without dispatching Execute',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let time = 0, calls = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const previous = p.raw.options.serializers[25];
    p.raw.options.serializers[25] = value => {
      calls++;
      time = 10;
      p.raw.options.serializers[25] = previous;
      return previous ? previous(value) : String(value);
    };
    const scope = { kind: 'tenant', userId: 'u', workspaceId: 'w' };
    await assert.rejects(bounded(Promise.resolve(statement(p.raw, deadline, scope)), 'Bind scan'), admissionError);
    assert.equal(calls, 1);
    assert.deepEqual(p.queries, []);
  });

test('v311 throwing deadline snapshot fails closed without surfacing its private error',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    const deadline = Object.freeze({ budgetMs: 10, snapshot() { throw new Error('private clock fault'); } });
    await assert.rejects(bounded(Promise.resolve(statement(p.raw, deadline)), 'throwing-clock scan'),
      error => error?.code === 'RECOVERY_ADMISSION_CLOSED' &&
        !String(error.message).includes('private clock fault'));
    assert.deepEqual(p.queries, []);
  });

test('v311 expired scan retires its connection before later pool work reuses the slot',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { rawCloseGate: true, beforeSocket: () => {} });
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    p.raw.options.debug = () => { time = 10; };
    await assert.rejects(bounded(Promise.resolve(statement(p.raw, deadline)), 'retiring scan'), admissionError);
    p.raw.options.debug = undefined;
    if (process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER.includes('postgres-cf.mjs')) {
      const queued = Promise.resolve(p.raw.unsafe('select after expired scan'));
      await tick();
      assert.deepEqual(p.queries, [], 'CF pool slot stays isolated until raw.closed');
      p.releaseRawClose();
      await bounded(queued, 'post-retirement query');
    } else {
      p.releaseRawClose();
      await bounded(Promise.resolve(p.raw.unsafe('select after expired scan')), 'post-retirement query');
    }
    assert.deepEqual(p.queries, ['select after expired scan']);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v311 snapshot reentry cancellation cannot bypass the pre-write gate or send a cancel packet',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {} });
    let query, calls = 0, handle;
    const deadline = Object.freeze({ budgetMs: 10, snapshot() {
      if (++calls === 1) handle = query.cancelOwned();
      return Object.freeze({ status: 'open', remainingMs: 10 });
    } });
    query = statement(p.raw, deadline);
    await assert.rejects(bounded(Promise.resolve(query), 'reentrant cancel scan'), { code: '57014' });
    assert.deepEqual(await bounded(handle.result, 'pre-dispatch cancellation'), { status: 'not_dispatched' });
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v311 post-Describe snapshot cancellation cannot send Bind/Execute or a stale cancel packet',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, holdDescribe: true, beforeSocket: () => {} });
    let query, calls = 0, handle;
    const deadline = Object.freeze({ budgetMs: 10, snapshot() {
      if (++calls === 2) handle = query.cancelOwned();
      return Object.freeze({ status: 'open', remainingMs: 10 });
    } });
    query = statement(p.raw, deadline);
    const pending = Promise.resolve(query);
    await bounded(p.described, 'post-Describe cancellation fixture');
    p.releaseDescribe();
    await assert.rejects(bounded(pending, 'post-Describe cancel scan'), { code: '57014' });
    assert.deepEqual(await bounded(handle.result, 'post-Describe cancellation'), { status: 'not_dispatched' });
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v311 post-Describe snapshot pool end cannot send Bind/Execute',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdDescribe: true, beforeSocket: () => {} });
    let calls = 0, ending;
    const deadline = Object.freeze({ budgetMs: 10, snapshot() {
      if (++calls === 2) ending = p.raw.end({ timeout: 0 });
      return Object.freeze({ status: 'open', remainingMs: 10 });
    } });
    const pending = Promise.resolve(statement(p.raw, deadline));
    await bounded(p.described, 'post-Describe end fixture');
    p.releaseDescribe();
    await assert.rejects(bounded(pending, 'post-Describe end scan'));
    await bounded(ending, 'post-Describe pool end');
    assert.deepEqual(p.queries, []);
  });

test('v311 snapshot reentry pool end cannot dispatch a new scan',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let calls = 0, ending;
    const deadline = Object.freeze({ budgetMs: 10, snapshot() {
      if (++calls === 1) ending = p.raw.end({ timeout: 0 });
      return Object.freeze({ status: 'open', remainingMs: 10 });
    } });
    await assert.rejects(bounded(Promise.resolve(statement(p.raw, deadline)), 'end-reentered scan'));
    await bounded(ending, 'reentrant end');
    assert.deepEqual(p.queries, []);
  });

test('v311 does not retroactively cancel an already dispatched scan or change no-deadline scans',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdReady: query => query.includes('NOT EXISTS'), beforeSocket: () => {} });
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const first = Promise.resolve(statement(p.raw, deadline));
    await bounded(p.entered, 'active scan');
    time = 10;
    assert.deepEqual(p.queries.length, 1);
    p.release();
    await bounded(first, 'active scan completion');
    const withoutDeadline = statement(p.raw, undefined);
    await bounded(Promise.resolve(withoutDeadline), 'legacy owned scan');
    assert.equal(p.queries.length, 2);
    assert.deepEqual(p.cancelPackets, []);
  });
