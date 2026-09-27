import assert from 'node:assert/strict';
import test from 'node:test';
import { peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { createPostgresRecoveryRun } from './run-usage-recovery-postgres.ts';

const candidate = Boolean(process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER);
const options = Object.freeze({ scope: { kind: 'tenant', userId: 'u'.repeat(200), workspaceId: 'w'.repeat(200) },
  maxRegistrations: 1, maxItems: 1, concurrency: 1, leaseSeconds: 30, runBudgetMs: 60_000,
  reservedBytesPerScan: 512, reservedBytesPerConsumer: 1024 });

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
    assert.notEqual(type, 69, 'primary Execute frame must not be written');
    assert.notEqual(type, 81, 'primary simple Query frame must not be written');
    offset += 1 + length;
  }
}

test('v307 fixed scan negative: pool.end reentered during Bind suppresses execution',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {}, holdReady: true });
    const holds = capacity();
    const writes = capturePrimaryWrites(p.raw);
    const originalSerializer = p.raw.options.serializers[25];
    let serializerCalls = 0, ending;
    p.raw.options.serializers[25] = value => {
      serializerCalls++;
      ending = Promise.resolve(p.raw.end({ timeout: 0 })).then(
        () => ({ status: 'fulfilled' }), error => ({ status: 'rejected', error }));
      p.raw.options.serializers[25] = originalSerializer;
      return originalSerializer ? originalSerializer(value) : String(value);
    };
    t.after(() => { p.raw.options.serializers[25] = originalSerializer; });
    const run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    const result = await bounded(run.completion, 'pool.end reentry run completion');
    assert.equal(serializerCalls, 1);
    assert.ok(ending, 'Bind serializer must invoke pool.end');
    const endResult = await bounded(ending, 'pool.end reentry result');
    assert.equal(endResult.status, 'fulfilled', String(endResult.error));
    await tick();
    assertNoPrimaryExecution(writes);
    assert.deepEqual(p.queries, [], 'pool shutdown must not execute the fixed SELECT');
    assert.deepEqual(p.cancelPackets, [], 'pool shutdown must not send a cancel packet');
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(holds.released(), 1);
  });

test('v307 fixed scan negative: serializer throw after cancel suppresses execution',
  { skip: !candidate, timeout: 5000 }, async t => {
    const p = await peer(t, { backendIdentity: true, beforeSocket: () => {}, holdReady: true });
    const holds = capacity();
    const writes = capturePrimaryWrites(p.raw);
    const originalSerializer = p.raw.options.serializers[25];
    let serializerCalls = 0, run, handle;
    p.raw.options.serializers[25] = () => {
      serializerCalls++;
      handle = run.cancelActiveScan();
      assert.ok(handle);
      p.raw.options.serializers[25] = originalSerializer;
      throw new Error('synthetic Bind serializer failure after cancellation');
    };
    t.after(() => { p.raw.options.serializers[25] = originalSerializer; });
    run = createPostgresRecoveryRun({ driver: 'postgres', raw: p.raw }, options, holds,
      { ownedScans: true });
    const result = await bounded(run.completion, 'serializer throw run completion');
    assert.equal(serializerCalls, 1);
    assert.deepEqual(await bounded(handle.result, 'serializer cancel result'), { status: 'not_dispatched' });
    assert.deepEqual(await handle.transportClosed, { status: 'not_started' });
    assert.deepEqual(await handle.transportRawClosed, { status: 'not_started' });
    assert.deepEqual(await handle.primaryCloseObserved, { status: 'not_started' });
    assert.deepEqual(await handle.primaryRawClosed, { status: 'not_started' });
    await tick();
    assertNoPrimaryExecution(writes);
    assert.deepEqual(p.queries, [], 'failed Bind must not execute the fixed SELECT');
    assert.deepEqual(p.cancelPackets, [], 'pre-dispatch cancel must not send a cancel packet');
    assert.equal(result.resources, 'unconfirmed');
    assert.equal(result.retainedHolds, 1);
    assert.equal(holds.held(), 1);
    assert.equal(holds.released(), 1);
  });
