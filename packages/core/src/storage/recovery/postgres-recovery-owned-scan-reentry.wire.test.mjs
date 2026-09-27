import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { createPostgresRecoveryRun } from './run-usage-recovery-postgres.ts';
import { postgresRecoveryScan } from './usage-recovery-jobs-postgres.ts';

const candidate = Boolean(process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER);
const options = Object.freeze({ scope: Object.freeze({ kind: 'all' }), maxRegistrations: 1,
  maxItems: 1, concurrency: 1, leaseSeconds: 30, runBudgetMs: 60_000,
  reservedBytesPerScan: 512, reservedBytesPerConsumer: 1024 });
const expectedSql = postgresRecoveryScan('unregistered', options.scope, 1).query;

function capacity() {
  let held = 0, released = 0;
  return {
    tryAcquire() {
      held++;
      let done = false;
      return { release() { assert.equal(done, false); done = true; held--; released++; } };
    },
    held: () => held, released: () => released,
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

function capturePrimaryWrites(raw) {
  const writes = [];
  const socketFactory = raw.options.socket;
  let socketOrdinal = 0;
  raw.options.socket = async (...args) => {
    const socket = await socketFactory(...args);
    if (++socketOrdinal === 1) {
      const write = socket.write;
      socket.write = function(data, ...rest) {
        writes.push(Buffer.from(data));
        return Reflect.apply(write, this, [data, ...rest]);
      };
    }
    return socket;
  };
  return writes;
}

function assertNoPrimaryExecution(writes) {
  const bytes = Buffer.concat(writes);
  assert.ok(bytes.length >= 8, 'the primary connection must have sent startup');
  let offset = bytes.readUInt32BE(0);
  assert.ok(offset >= 8 && offset <= bytes.length, 'valid startup frame');
  while (offset < bytes.length) {
    assert.ok(offset + 5 <= bytes.length, 'complete frontend frame header');
    const type = bytes[offset];
    const length = bytes.readUInt32BE(offset + 1);
    assert.ok(length >= 4 && offset + 1 + length <= bytes.length, 'complete frontend frame');
    assert.notEqual(type, 69, 'primary Execute frame must not be written after pre-dispatch cancellation');
    assert.notEqual(type, 81, 'primary simple Query frame must not be written after pre-dispatch cancellation');
    offset += 1 + length;
  }
}

test('v307 fixed scan: build debug reentry cancellation prevents dispatch',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {}, holdReady: true });
    const holds = capacity();
    const primaryWrites = capturePrimaryWrites(p.raw);
    const reentered = deferred();
    let run, handle, debugCalls = 0;
    p.raw.options.debug = (_id, sql) => {
      if (sql !== expectedSql) return;
      debugCalls++;
      assert.equal(p.queries.length, 0, 'main SELECT is not yet at the peer during build');
      handle = run.cancelActiveScan();
      assert.ok(handle);
      reentered.resolve();
    };
    run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    await bounded(reentered.promise, 'build debug reentry');
    assert.deepEqual(await bounded(handle.result, 'build cancellation outcome'), { status: 'not_dispatched' });
    p.release();
    const result = await bounded(run.completion, 'build-reentry run completion');
    await tick();
    assert.equal(debugCalls, 1);
    assert.deepEqual(p.queries, [], 'cancellation before build finishes must not send the fixed SELECT');
    assertNoPrimaryExecution(primaryWrites);
    assert.deepEqual(p.cancelPackets, [], 'not-dispatched cancellation must not send a cancel packet');
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(holds.released(), 1);
  });

test('v307 fixed scan: Bind serializer reentry cancellation prevents dispatch',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {}, holdReady: true });
    const holds = capacity();
    const input = { ...options, scope: { kind: 'tenant', userId: 'u'.repeat(200), workspaceId: 'w'.repeat(200) } };
    const reentered = deferred();
    let run, handle, serializerCalls = 0;
    const primaryWrites = capturePrimaryWrites(p.raw);
    const serialize = p.raw.options.serializers[25];
    p.raw.options.serializers[25] = value => {
      serializerCalls++;
      assert.equal(p.queries.length, 0, 'Bind is still being encoded before Execute reaches the peer');
      handle = run.cancelActiveScan();
      assert.ok(handle);
      reentered.resolve();
      p.raw.options.serializers[25] = serialize;
      return serialize ? serialize(value) : String(value);
    };
    run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, input, holds,
      { ownedScans: true });
    await bounded(reentered.promise, 'Bind serializer reentry');
    assert.deepEqual(await bounded(handle.result, 'serializer cancellation outcome'), { status: 'not_dispatched' });
    p.release();
    const result = await bounded(run.completion, 'serializer-reentry run completion');
    await tick();
    assert.equal(serializerCalls, 1);
    assert.deepEqual(p.queries, [], 'cancellation during Bind encoding must not execute the fixed SELECT');
    assertNoPrimaryExecution(primaryWrites);
    assert.deepEqual(p.cancelPackets, [], 'not-dispatched cancellation must not send a cancel packet');
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(holds.released(), 1);
  });
