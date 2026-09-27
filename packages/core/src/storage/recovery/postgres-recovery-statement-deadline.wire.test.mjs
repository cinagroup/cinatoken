import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { createPostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline.ts';

const candidate = Boolean(process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER);
const closed = { code: 'RECOVERY_ADMISSION_CLOSED' };
const option = deadline => ({ recovery_admission_deadline: deadline });
const statement = (raw, deadline, sql = 'select recovery ordinary', params = []) =>
  raw.unsafe(sql, params, option(deadline));

function captureFrontendMessages(raw) {
  const types = [];
  const originalFactory = raw.options.socket;
  assert.equal(typeof originalFactory, 'function');
  raw.options.socket = async (...args) => {
    const socket = await originalFactory(...args);
    const originalWrite = socket.write;
    let startup = true;
    socket.write = function(chunk, ...rest) {
      const bytes = Buffer.from(chunk);
      if (startup) {
        // StartupMessage is length-prefixed but has no one-byte message type.
        assert.ok(bytes.length >= 8);
        assert.equal(bytes.readUInt32BE(0), bytes.length);
        startup = false;
      } else {
        for (let at = 0; at < bytes.length;) {
          assert.ok(bytes.length - at >= 5);
          const length = bytes.readUInt32BE(at + 1);
          assert.ok(length >= 4 && at + 1 + length <= bytes.length);
          types.push(String.fromCharCode(bytes[at]));
          at += 1 + length;
        }
      }
      return Reflect.apply(originalWrite, this, [chunk, ...rest]);
    };
    return socket;
  };
  return types;
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' remained pending')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('v312 cold connection expires during socket setup before ordinary SQL dispatch',
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
    await assert.rejects(bounded(pending, 'cold ordinary SQL'), closed);
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v312 pool queued ordinary SQL checks its original deadline at dispatch',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdReady: query => query === 'select occupied', beforeSocket: () => {} });
    const occupied = Promise.resolve(p.raw.unsafe('select occupied'));
    await bounded(p.entered, 'occupied query');
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const pending = Promise.resolve(statement(p.raw, deadline));
    await tick();
    time = 10;
    p.release();
    await bounded(occupied, 'occupied query completion');
    await assert.rejects(bounded(pending, 'queued ordinary SQL'), closed);
    assert.deepEqual(p.queries, ['select occupied']);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v312 ordinary SQL debug callback expiry is checked after build',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let time = 0, calls = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    p.raw.options.debug = () => { calls++; time = 10; };
    await assert.rejects(bounded(statement(p.raw, deadline), 'debug ordinary SQL'), closed);
    assert.equal(calls, 1);
    assert.deepEqual(p.queries, []);
  });

test('v312 ordinary SQL flushes a small Query in the admission check turn',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let time = 0;
    const writtenAt = [];
    const originalFactory = p.raw.options.socket;
    p.raw.options.socket = async (...args) => {
      const socket = await originalFactory(...args);
      const write = socket.write;
      socket.write = function(bytes, ...rest) {
        if (Buffer.from(bytes).includes(Buffer.from('select recovery ordinary')))
          writtenAt.push(time);
        return Reflect.apply(write, this, [bytes, ...rest]);
      };
      return socket;
    };
    await bounded(p.raw.unsafe('select warm'), 'warm connection');
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const pending = Promise.resolve(statement(p.raw, deadline));
    const nextTurn = new Promise(resolve => setImmediate(() => { time = 10; resolve(); }));
    await bounded(pending, 'small ordinary SQL');
    await nextTurn;
    assert.deepEqual(writtenAt, [0]);
    assert.deepEqual(p.queries, ['select warm', 'select recovery ordinary']);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v312 expiry after Parse/Describe sends no ordinary Bind/Execute',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdDescribe: true, beforeSocket: () => {} });
    const frontend = captureFrontendMessages(p.raw);
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const pending = Promise.resolve(statement(p.raw, deadline, 'select $1', ['value']));
    await bounded(p.described, 'ordinary Parse/Describe');
    time = 10;
    p.releaseDescribe();
    await assert.rejects(bounded(pending, 'post-Describe ordinary SQL'), closed);
    assert.ok(frontend.includes('P') && frontend.includes('D'), 'Parse and Describe reached socket.write');
    assert.ok(!frontend.includes('B') && !frontend.includes('E'), 'no Bind or Execute reached socket.write');
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.cancelPackets, []);
  });

test('v312 ordinary Bind serializer expiry is checked before Execute',
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
    await assert.rejects(bounded(statement(p.raw, deadline, 'select $1', ['value']), 'Bind ordinary SQL'), closed);
    assert.equal(calls, 1);
    assert.deepEqual(p.queries, []);
  });

test('v312 ordinary deadline snapshot failure and malformed object fail closed',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    await assert.rejects(bounded(statement(p.raw, Object.freeze({ snapshot() {
      throw new Error('private clock fault');
    } })), 'throwing ordinary clock'), error =>
      error?.code === closed.code && !String(error.message).includes('private clock fault'));
    assert.deepEqual(p.queries, []);
    // A CF slot may remain quarantined until an authoritative raw.closed
    // receipt; use an independent pool to test a second invalid input.
    const second = await peer(t, { beforeSocket: () => {} });
    await assert.rejects(bounded(statement(second.raw, {}), 'malformed ordinary clock'), closed);
    assert.deepEqual(second.queries, []);
  });

test('v312 snapshot reentry pool end cannot dispatch ordinary SQL',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    let calls = 0, ending;
    const deadline = Object.freeze({ snapshot() {
      if (++calls === 1) ending = p.raw.end({ timeout: 0 });
      return Object.freeze({ status: 'open', remainingMs: 10 });
    } });
    await assert.rejects(bounded(statement(p.raw, deadline), 'end-reentered ordinary SQL'));
    await bounded(ending, 'reentrant end');
    assert.deepEqual(p.queries, []);
  });

test('v312 post-Describe snapshot reentry pool end cannot send ordinary Bind/Execute',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdDescribe: true, beforeSocket: () => {} });
    const frontend = captureFrontendMessages(p.raw);
    let calls = 0, ending;
    const deadline = Object.freeze({ snapshot() {
      if (++calls === 2) ending = p.raw.end({ timeout: 0 });
      return Object.freeze({ status: 'open', remainingMs: 10 });
    } });
    const pending = Promise.resolve(statement(p.raw, deadline, 'select $1', ['value']));
    await bounded(p.described, 'post-Describe reentry fixture');
    p.releaseDescribe();
    await assert.rejects(bounded(pending, 'post-Describe reentered SQL'));
    await bounded(ending, 'post-Describe end');
    assert.ok(frontend.includes('P') && frontend.includes('D'), 'Parse and Describe reached socket.write');
    assert.ok(!frontend.includes('B') && !frontend.includes('E'), 'no Bind or Execute reached socket.write');
    assert.deepEqual(p.queries, []);
  });

test('v312 already dispatched ordinary SQL completes and no-deadline SQL is unchanged',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { holdReady: query => query === 'select recovery ordinary', beforeSocket: () => {} });
    let time = 0;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    const dispatched = Promise.resolve(statement(p.raw, deadline));
    await bounded(p.entered, 'dispatched ordinary SQL');
    time = 10;
    p.release();
    await bounded(dispatched, 'already dispatched SQL');
    await bounded(p.raw.unsafe('select no deadline'), 'no-deadline SQL');
    assert.deepEqual(p.queries, ['select recovery ordinary', 'select no deadline']);
    assert.deepEqual(p.cancelPackets, []);
  });
