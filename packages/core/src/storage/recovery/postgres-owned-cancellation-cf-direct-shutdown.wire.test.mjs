import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// This process-local hook exercises the bundled CF polyfill's direct
// import('cloudflare:sockets') path. It does not open a network connection.
const socketModule = 'data:text/javascript,' + encodeURIComponent(
  'export const connect = (...args) => globalThis.__gatewayCfShutdownProbe.connect(...args)',
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'cloudflare:sockets'
      ? { url: socketModule, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const candidatePath = process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER;
if (candidatePath && !isAbsolute(candidatePath)) {
  throw new Error('Candidate driver must be an absolute local path');
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function bounded(promise, label, milliseconds = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' did not settle')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rawSocket({ rejectClose = false, throwClose = false }) {
  const connected = deferred();
  const closed = deferred();
  // The polyfill observes closed itself; this is also safe if setup fails early.
  void closed.promise.catch(() => {});
  let reader;
  let state = 'pending';
  let closeCalls = 0;
  const writes = [];
  const raw = {
    closed: closed.promise,
    readable: new ReadableStream({ start(controller) { reader = controller; } }),
    // A zero high-water mark keeps the polyfill's writer.ready pending. The
    // wrapper remains in 'opening' even after its connect() Promise resolves.
    writable: new WritableStream({ write(chunk) { writes.push(chunk); } }, { highWaterMark: 0 }),
    close() {
      closeCalls++;
      if (throwClose) throw new Error('synthetic synchronous raw.close failure');
      if (state === 'pending') {
        state = rejectClose ? 'rejected' : 'fulfilled';
        if (rejectClose) closed.reject(new Error('synthetic raw.closed rejection'));
        else {
          reader.close();
          closed.resolve();
        }
      }
      return closed.promise;
    },
  };
  return {
    raw,
    connected: connected.promise,
    connectCalled: () => connected.resolve(),
    closeCalls: () => closeCalls,
    writes,
    forceWrapperClose() {
      if (state === 'pending') {
        state = 'rejected';
        closed.reject(new Error('synthetic cleanup rejection'));
      }
      try { reader.error(new Error('synthetic read-loop closure')); } catch {}
    },
  };
}

async function directClient() {
  const postgres = (await import(pathToFileURL(candidatePath).href)).default;
  return postgres({
    host: '127.0.0.1', port: 5432, database: 'synthetic',
    username: 'synthetic', password: 'synthetic', ssl: false,
    fetch_types: false, prepare: false, max: 1, connect_timeout: 1, backoff: 0,
  });
}

const resultOf = promise => Promise.resolve(promise).then(
  () => ({ status: 'fulfilled' }),
  error => ({ status: 'rejected', code: error?.code }),
);

test('CF direct shutdown closes raw already present while wrapper is still opening',
  { timeout: 5000, skip: !candidatePath }, async () => {
    const socket = rawSocket({ rejectClose: false });
    globalThis.__gatewayCfShutdownProbe = {
      connect() { socket.connectCalled(); return socket.raw; },
    };
    const sql = await directClient();
    const query = resultOf(sql.unsafe('select never').execute());
    await bounded(socket.connected, 'direct raw connect');
    // Let the polyfill's connect() and the candidate's connectAttempt.then
    // finish before end(). writer.ready deliberately remains pending.
    await new Promise(resolve => setTimeout(resolve, 20));
    const ending = resultOf(sql.end());
    try {
      assert.deepEqual(await bounded(ending, 'opening-wrapper pool.end'), { status: 'fulfilled' });
      assert.ok(socket.closeCalls() >= 1, 'shutdown must close the already-present raw Socket');
      assert.deepEqual(await bounded(query, 'initial Query'),
        { status: 'rejected', code: 'CONNECTION_ENDED' });
      assert.equal(socket.writes.length, 0, 'no startup or SQL bytes may be written after shutdown');
    } finally {
      // Old candidates hang here. Close only this test's synthetic raw Socket.
      if (socket.closeCalls() === 0) await socket.raw.close();
      await bounded(ending, 'opening-wrapper cleanup', 1000).catch(() => {});
    }
  });

test('CF direct shutdown reports synchronous raw.close failure without hanging',
  { timeout: 5000, skip: !candidatePath }, async () => {
    const socket = rawSocket({ throwClose: true });
    globalThis.__gatewayCfShutdownProbe = {
      connect() { socket.connectCalled(); return socket.raw; },
    };
    const sql = await directClient();
    const query = resultOf(sql.unsafe('select never').execute());
    await bounded(socket.connected, 'throwing direct raw connect');
    await new Promise(resolve => setTimeout(resolve, 20));
    const ending = resultOf(sql.end());
    try {
      assert.deepEqual(await bounded(ending, 'synchronous raw.close failure'),
        { status: 'rejected', code: 'CONNECTION_CLOSE_UNCONFIRMED' });
      assert.ok(socket.closeCalls() >= 1);
      assert.deepEqual(await bounded(query, 'throwing initial Query'),
        { status: 'rejected', code: 'CONNECTION_ENDED' });
      assert.equal(socket.writes.length, 0);
    } finally {
      socket.forceWrapperClose();
      await bounded(ending, 'throwing raw cleanup', 1000).catch(() => {});
    }
  });

test('CF direct close after failed end retains the unconfirmed close error',
  { timeout: 5000, skip: !candidatePath }, async () => {
    const socket = rawSocket({ throwClose: true });
    globalThis.__gatewayCfShutdownProbe = {
      connect() { socket.connectCalled(); return socket.raw; },
    };
    const sql = await directClient();
    const query = resultOf(sql.unsafe('select never').execute());
    await bounded(socket.connected, 'failed-end direct raw connect');
    await new Promise(resolve => setTimeout(resolve, 20));
    const ending = resultOf(sql.end());
    let closing;
    try {
      assert.deepEqual(await bounded(ending, 'first failed pool.end'),
        { status: 'rejected', code: 'CONNECTION_CLOSE_UNCONFIRMED' });
      closing = resultOf(sql.close());
      assert.deepEqual(await bounded(closing, 'close after failed end'),
        { status: 'rejected', code: 'CONNECTION_CLOSE_UNCONFIRMED' });
      assert.ok(socket.closeCalls() >= 1);
      assert.deepEqual(await bounded(query, 'failed-end initial Query'),
        { status: 'rejected', code: 'CONNECTION_ENDED' });
      assert.equal(socket.writes.length, 0);
    } finally {
      socket.forceWrapperClose();
      await bounded(Promise.all([ending, closing].filter(Boolean)), 'failed-end cleanup', 1000)
        .catch(() => {});
    }
  });

test('CF direct shutdown observes rejected raw.closed when raw arrives after end',
  { timeout: 5000, skip: !candidatePath }, async () => {
    const socket = rawSocket({ rejectClose: true });
    let ending;
    let sql;
    globalThis.__gatewayCfShutdownProbe = {
      connect() {
        // The real polyfill has set readyState='opening' but has not assigned
        // tcp.raw yet. Reentering end here makes raw arrive strictly afterward.
        ending = resultOf(sql.end());
        socket.connectCalled();
        return socket.raw;
      },
    };
    sql = await directClient();
    const query = resultOf(sql.unsafe('select never').execute());
    await bounded(socket.connected, 'late direct raw connect');
    try {
      assert.ok(ending, 'end must be invoked before the raw Socket is returned');
      assert.deepEqual(await bounded(ending, 'late raw.closed rejection'),
        { status: 'rejected', code: 'CONNECTION_CLOSE_UNCONFIRMED' });
      assert.ok(socket.closeCalls() >= 1, 'the late raw Socket must be closed');
      assert.deepEqual(await bounded(query, 'late initial Query'),
        { status: 'rejected', code: 'CONNECTION_ENDED' });
      assert.equal(socket.writes.length, 0, 'late raw must not send startup or SQL bytes');
    } finally {
      // A rejected raw.closed does not emit a wrapper close in the pinned CF
      // polyfill. Force only the synthetic reader's error to release old tests.
      socket.forceWrapperClose();
      await bounded(ending, 'late raw cleanup', 1000).catch(() => {});
    }
  });

test('CF direct concurrent end and close both observe late raw.closed rejection',
  { timeout: 5000, skip: !candidatePath }, async () => {
    const socket = rawSocket({ rejectClose: true });
    let ending;
    let closing;
    let sql;
    globalThis.__gatewayCfShutdownProbe = {
      connect() {
        // Both connection-level receipts are registered before tcp.raw exists.
        // A single mutable observer loses the first receipt in this sequence.
        ending = resultOf(sql.end());
        closing = resultOf(sql.close());
        socket.connectCalled();
        return socket.raw;
      },
    };
    sql = await directClient();
    const query = resultOf(sql.unsafe('select never').execute());
    await bounded(socket.connected, 'concurrent late direct raw connect');
    try {
      assert.ok(ending && closing, 'both shutdown calls must precede raw assignment');
      assert.deepEqual(await bounded(Promise.all([ending, closing]), 'concurrent close receipts'), [
        { status: 'rejected', code: 'CONNECTION_CLOSE_UNCONFIRMED' },
        { status: 'rejected', code: 'CONNECTION_CLOSE_UNCONFIRMED' },
      ]);
      assert.ok(socket.closeCalls() >= 1);
      assert.deepEqual(await bounded(query, 'concurrent initial Query'),
        { status: 'rejected', code: 'CONNECTION_ENDED' });
      assert.equal(socket.writes.length, 0);
    } finally {
      socket.forceWrapperClose();
      await bounded(Promise.all([ending, closing]), 'concurrent raw cleanup', 1000).catch(() => {});
    }
  });
