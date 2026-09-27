import assert from 'node:assert/strict';
import test from 'node:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deferred, peer, tick } from './postgres-recovery-operation-owner.wire.test.mjs';

const endedMessage = 'CONNECTION_ENDED: Connection ended before dispatch';

function outcome(value) {
  return Promise.resolve(value).then(
    result => ({ status: 'fulfilled', result }),
    error => ({
      status: 'rejected',
      code: error?.code,
      message: error?.message,
      exposesAddress: error != null && Object.hasOwn(error, 'address'),
      exposesPort: error != null && Object.hasOwn(error, 'port'),
    }),
  );
}

async function bounded(value, label) {
  let timer;
  try {
    return await Promise.race([
      value,
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

test('local shutdown rejects initial Query held inside the socket factory before dispatch',
  { timeout: 5000 }, async t => {
    const setupEntered = deferred();
    const releaseSetup = deferred();
    const p = await peer(t, {
      beforeSocket: async ordinal => {
        if (ordinal === 1) {
          setupEntered.resolve();
          await releaseSetup.promise;
        }
      },
    });
    t.after(() => releaseSetup.resolve());

    const initial = outcome(p.raw.unsafe('select initial').execute());
    await bounded(setupEntered.promise, 'initial socket factory entry');
    assert.deepEqual(p.queries, []);

    const ending = p.raw.end();
    releaseSetup.resolve();
    const initialResult = await bounded(initial, 'initial Query after end');
    await bounded(ending, 'pool.end after initial setup');
    await tick();
    assert.deepEqual(p.queries, [], 'shutdown must not send initial SQL after end was invoked');
    assertEnded(initialResult);
  });

test('local shutdown rejects transaction-queued third Query and prevents a later COMMIT',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { maxPipeline: 1, holdReady: query => query === 'select tx_active', beforeSocket: () => {} });
    const locallyQueued = deferred();
    let statementOutcomes;
    const transaction = outcome(p.raw.begin(async tx => {
      const statements = ['select tx_active', 'select tx_sent', 'select tx_queued']
        .map(sql => outcome(tx.unsafe(sql).execute()));
      locallyQueued.resolve();
      statementOutcomes = await Promise.all(statements);
    }));
    await bounded(locallyQueued.promise, 'transaction local queue setup');
    await bounded(p.seen('select tx_sent'), 'second transaction statement dispatch');
    assert.deepEqual(p.queries.map(sql => sql.trim()), ['begin', 'select tx_active', 'select tx_sent']);

    const beforeEnd = p.queries.length;
    const ending = p.raw.end();
    p.release();
    const result = await bounded(transaction, 'transaction after end');
    await bounded(ending, 'pool.end after transaction');
    assert.equal(statementOutcomes?.length, 3);
    await tick();
    assert.deepEqual(p.queries.slice(beforeEnd), [], 'no queued SELECT, COMMIT, or ROLLBACK may dispatch after end');
    assertEnded(statementOutcomes[2]);
    assert.equal(result.status, 'rejected', 'the transaction must not commit after shutdown');
  });

test('local shutdown settles warm reserve-local third Query even after pool.end resolves',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { maxPipeline: 1, holdReady: query => query === 'select reserve_active', beforeSocket: () => {} });
    await bounded(p.raw.unsafe('select warm'), 'warm connection');
    const reserved = await bounded(p.raw.reserve(), 'explicit reserve');
    const active = outcome(reserved.unsafe('select reserve_active').execute());
    await bounded(p.seen('select reserve_active'), 'first reserve statement dispatch');
    const sent = outcome(reserved.unsafe('select reserve_sent').execute());
    await bounded(p.seen('select reserve_sent'), 'second reserve statement dispatch');
    const locallyQueued = outcome(reserved.unsafe('select reserve_queued').execute());
    await tick();
    assert.deepEqual(p.queries, ['select warm', 'select reserve_active', 'select reserve_sent']);

    const beforeEnd = p.queries.length;
    const ending = p.raw.end();
    reserved.release();
    p.release();
    await bounded(Promise.all([active, sent]), 'already-dispatched reserve statements');
    await bounded(ending, 'pool.end after reserve release');
    assertEnded(await bounded(locallyQueued, 'reserve-local queued Query after end'));
    await tick();
    assert.deepEqual(p.queries.slice(beforeEnd), [], 'the reserve-local queued Query cannot dispatch after end');
  });

test('local shutdown settles an idle reserved lease after release without admitting new SQL',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    await bounded(p.raw.unsafe('select warm'), 'warm connection');
    const reserved = await bounded(p.raw.reserve(), 'idle explicit reserve');
    assert.deepEqual(p.queries, ['select warm']);

    const ending = p.raw.end();
    // Let end() enter the driver's connection-level wait while the lease is
    // still held; releasing in the same turn masks the legacy deadlock.
    await tick();
    reserved.release();
    let endSettled = false;
    try {
      await bounded(ending, 'pool.end after idle reserve release');
      endSettled = true;
      assertEnded(await bounded(outcome(reserved.unsafe('select forbidden_after_end').execute()),
        'stale reserve handle Query'));
      await tick();
      assert.deepEqual(p.queries, ['select warm'], 'neither shutdown nor stale lease may send SQL');
    } finally {
      if (!endSettled) {
        // Legacy candidate escape hatch only: a response event releases its hung end()
        // so the fixture's after-hook can close. A passing candidate never runs this.
        await bounded(outcome(reserved.unsafe('select fixture_cleanup').execute()),
          'legacy idle-reserve cleanup Query');
        await bounded(ending, 'legacy idle-reserve cleanup end');
      }
    }
  });

test('local shutdown settles initial Query and end when its socket factory rejects',
  { timeout: 5000 }, async t => {
    const candidatePath = process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER;
    if (!candidatePath) return t.skip('requires an explicit isolated candidate');
    assert.ok(isAbsolute(candidatePath));
    const postgres = (await import(pathToFileURL(candidatePath).href)).default;
    const setupEntered = deferred();
    const releaseSetup = deferred();
    t.after(() => releaseSetup.resolve());
    let factoryCalls = 0;
    const raw = postgres({
      host: '127.0.0.1', port: 1, database: 'synthetic', username: 'synthetic',
      password: 'synthetic', ssl: false, fetch_types: false, prepare: false,
      max: 1, connect_timeout: 1, backoff: 0,
      socket: async () => {
        factoryCalls++;
        setupEntered.resolve();
        await releaseSetup.promise;
        throw new Error('synthetic private socket factory rejection');
      },
    });
    const initial = outcome(raw.unsafe('select never').execute());
    await bounded(setupEntered.promise, 'rejecting initial socket factory entry');
    const ending = raw.end();
    releaseSetup.resolve();
    const [queryResult, endResult] = await Promise.all([
      bounded(initial, 'initial Query after socket rejection')
        .catch(error => ({ status: 'timeout', message: error.message })),
      bounded(ending, 'pool.end after socket rejection')
        .then(() => ({ status: 'fulfilled' }), error => ({ status: 'timeout', message: error.message })),
    ]);
    assert.deepEqual(endResult, { status: 'fulfilled' });
    assertEnded(queryResult);
    assert.equal(factoryCalls, 1, 'shutdown must not retry the failed initial socket factory');
  });

test('local shutdown fences a stale reconnect timer after startup socket closure',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    const originalFactory = p.raw.options.socket;
    const firstClosed = deferred();
    let factoryCalls = 0;
    let ending;
    p.raw.options.socket = async options => {
      const socket = await originalFactory(options);
      if (++factoryCalls === 1) {
        let startupWrite = false;
        const nativeWrite = socket.write;
        socket.write = function(data, ...args) {
          if (!startupWrite) {
            startupWrite = true;
            setImmediate(() => socket.destroy());
            return true;
          }
          return Reflect.apply(nativeWrite, this, [data, ...args]);
        };
        socket.once('close', () => {
          // This listener precedes the driver's close handler. The latter may
          // schedule reconnect(), whose timer must see the already-set end gate.
          ending = outcome(p.raw.end());
          firstClosed.resolve();
        });
      }
      return socket;
    };

    const initial = outcome(p.raw.unsafe('select stale_reconnect').execute());
    await bounded(firstClosed.promise, 'first startup socket closure');
    assert.ok(ending, 'the close observer started pool.end');
    const [queryResult, endResult] = await bounded(Promise.all([initial, ending]),
      'initial Query and pool.end after startup closure');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(factoryCalls, 1, 'a reconnect timer must not create a post-end socket');
    assert.deepEqual(p.queries, [], 'stale reconnect must not replay initial SQL');
    assertEnded(queryResult);
    assert.equal(endResult.status, 'fulfilled');
  });

test('local shutdown prevents fetch_types startup metadata from dispatching after end',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    const originalFactory = p.raw.options.socket;
    const socketReady = deferred();
    p.raw.options.fetch_types = true;
    p.raw.options.socket = async options => {
      const socket = await originalFactory(options);
      socket.pause();
      socketReady.resolve(socket);
      return socket;
    };

    const initial = outcome(p.raw.unsafe('select after_metadata').execute());
    const socket = await bounded(socketReady.promise, 'metadata startup socket');
    let poll;
    try {
      await bounded(new Promise(resolve => {
        poll = setInterval(() => {
          if (socket.readableLength > 0) resolve();
        }, 1);
      }), 'buffered startup ReadyForQuery');
    } finally {
      clearInterval(poll);
    }
    assert.deepEqual(p.queries, [], 'startup response is buffered before metadata dispatch');

    const ending = p.raw.end();
    socket.resume();
    const [queryResult, endResult] = await bounded(Promise.all([initial, outcome(ending)]),
      'initial Query and end after startup metadata gate');
    await tick();
    assert.deepEqual(p.queries, [], 'fetch_types and initial SQL must not dispatch after end');
    assertEnded(queryResult);
    assert.equal(endResult.status, 'fulfilled');
  });

test('local shutdown prevents parameter Describe from sending delayed Bind and Execute',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { holdDescribe: true, beforeSocket: () => {} });
    const parameterized = outcome(p.raw.unsafe('select $1', [42]).execute());
    await bounded(p.described, 'parameter Describe request');
    assert.deepEqual(p.queries, [], 'Parse/Describe does not execute the statement');

    const ending = p.raw.end();
    p.releaseDescribe();
    const [queryResult, endResult] = await bounded(Promise.all([parameterized, outcome(ending)]),
      'parameterized Query and pool.end after Describe');
    await tick();
    assert.deepEqual(p.queries, [], 'no Bind/Execute may follow pool.end');
    assertEnded(queryResult);
    assert.equal(endResult.status, 'fulfilled');
  });

test('local shutdown reentered from debug callback cannot write the just-built Query',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    await bounded(p.raw.unsafe('select warm'), 'warm connection');
    let ending;
    let debugCalls = 0;
    p.raw.options.debug = (_connectionId, sql) => {
      if (sql === 'select reentrant') {
        debugCalls++;
        ending = outcome(p.raw.end());
      }
    };

    const query = outcome(p.raw.unsafe('select reentrant').execute());
    const queryResult = await bounded(query, 'reentrant debug Query');
    assert.equal(debugCalls, 1);
    assert.ok(ending, 'debug callback invoked end while build was active');
    const endResult = await bounded(ending, 'pool.end from debug callback');
    await tick();
    assert.deepEqual(p.queries, ['select warm'], 'the in-progress build may not write after reentrant end');
    assertEnded(queryResult);
    assert.equal(endResult.status, 'fulfilled');
  });

test('local shutdown reentered from parameter serializer cannot write prepared Bind and Execute',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    p.raw.options.prepare = true;
    await bounded(p.raw`select ${42}`, 'first prepared query');
    assert.deepEqual(p.queries, ['select $1']);

    // The loopback Description resolves an unknown parameter to PostgreSQL text (25).
    const originalSerializer = p.raw.options.serializers[25];
    let ending;
    let serializerCalls = 0;
    p.raw.options.serializers[25] = value => {
      serializerCalls++;
      ending = outcome(p.raw.end());
      return originalSerializer(value);
    };
    t.after(() => { p.raw.options.serializers[25] = originalSerializer; });

    const prepared = outcome(p.raw`select ${43}`.execute());
    const queryResult = await bounded(prepared, 'reentrant serializer Query');
    assert.equal(serializerCalls, 1);
    assert.ok(ending, 'serializer invoked end during Bind construction');
    const endResult = await bounded(ending, 'pool.end from parameter serializer');
    await tick();
    assert.deepEqual(p.queries, ['select $1'], 'serialized Bind/Execute may not write after reentrant end');
    assertEnded(queryResult);
    assert.equal(endResult.status, 'fulfilled');
  });

test('local shutdown preserves ownership of a pre-admitted buffered Query without replay',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    const originalFactory = p.raw.options.socket;
    let bufferedSocketWrites = 0;
    p.raw.options.socket = async options => {
      const socket = await originalFactory(options);
      const nativeWrite = socket.write;
      socket.write = function(data, ...args) {
        if (Buffer.from(data).includes(Buffer.from('select buffered'))) bufferedSocketWrites++;
        return Reflect.apply(nativeWrite, this, [data, ...args]);
      };
      return socket;
    };
    await bounded(p.raw.unsafe('select warm'), 'warm connection');
    let built = 0;
    p.raw.options.debug = (_connectionId, sql) => {
      if (sql === 'select buffered') built++;
    };

    const bufferedQuery = p.raw.unsafe('select buffered').execute();
    let settlements = 0;
    const buffered = outcome(bufferedQuery).then(result => {
      settlements++;
      return result;
    });
    // Query.handle() resumes in a microtask, while postgres.js flushes small
    // protocol chunks with setImmediate. This is after build but before I/O.
    await Promise.resolve();
    assert.equal(built, 1, 'the Query reached Connection.build before end');
    assert.equal(bufferedQuery.active, true, 'Connection.execute owns the Query before end');
    assert.ok(bufferedQuery.state, 'the Query has a connection state before end');
    assert.equal(bufferedSocketWrites, 0, 'no buffered Query bytes reached socket.write yet');
    assert.deepEqual(p.queries, ['select warm']);

    const ending = p.raw.end();
    const [queryResult, endResult] = await bounded(Promise.all([buffered, outcome(ending)]),
      'buffered Query and pool.end');
    await tick();
    assert.equal(settlements, 1, 'the admitted Query has one observable outcome');
    assert.ok(bufferedSocketWrites === 0 || bufferedSocketWrites === 1,
      'shutdown cannot replay a previously admitted write');
    if (bufferedSocketWrites === 0) {
      assert.deepEqual(p.queries, ['select warm']);
      assertEnded(queryResult);
    } else {
      // The physical flush may follow end(): this Query was admitted to the
      // connection before the barrier, so its successful completion is owned.
      assert.deepEqual(p.queries, ['select warm', 'select buffered']);
      assert.equal(p.trace[0].connectionId, p.trace[1].connectionId);
      assert.equal(queryResult.status, 'fulfilled');
    }
    assert.equal(endResult.status, 'fulfilled');
  });

test('local shutdown preserves a synchronous socket.end failure for repeated end calls',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    const originalFactory = p.raw.options.socket;
    const failure = Object.assign(new Error('synthetic socket.end failure'),
      { code: 'SYNTHETIC_SOCKET_END_FAILURE' });
    let socketEndCalls = 0;
    p.raw.options.socket = async options => {
      const socket = await originalFactory(options);
      socket.end = () => {
        socketEndCalls++;
        throw failure;
      };
      return socket;
    };
    await bounded(p.raw.unsafe('select warm'), 'warm connection');

    const rawEnd = p.raw.end;
    const settleEnd = () => Promise.resolve().then(() => rawEnd()).then(
      () => ({ status: 'fulfilled' }),
      error => ({ status: 'rejected', error }),
    );
    let first;
    let repeated;
    try {
      first = await bounded(settleEnd(), 'first pool.end with socket.end failure');
      repeated = await bounded(settleEnd(), 'repeated pool.end with socket.end failure');
    } finally {
      // The fixture's after-hook must still destroy its test-owned sockets;
      // do not let the intentionally rejected end Promise fail that teardown.
      p.raw.end = () => Promise.resolve();
    }
    assert.equal(first.status, 'rejected');
    assert.strictEqual(first.error, failure);
    assert.equal(repeated.status, 'rejected', 'a failed shutdown cannot later appear fulfilled');
    assert.strictEqual(repeated.error, failure, 'repeated end observes the same failure');
    assert.equal(socketEndCalls, 1, 'the failed close attempt must not be replayed');
    assert.deepEqual(p.queries, ['select warm']);
  });

test('local shutdown reentered from fetch_types debug contains metadata rejection without SQL',
  { timeout: 5000 }, async t => {
    const p = await peer(t, { beforeSocket: () => {} });
    p.raw.options.fetch_types = true;
    const metadataBuild = deferred();
    let ending;
    let metadataBuilds = 0;
    p.raw.options.debug = (_connectionId, sql) => {
      if (sql.includes('pg_catalog.pg_type')) {
        metadataBuilds++;
        ending = outcome(p.raw.end());
        metadataBuild.resolve();
      }
    };

    const initial = outcome(p.raw.unsafe('select after_types').execute());
    await bounded(metadataBuild.promise, 'fetch_types metadata build');
    assert.ok(ending, 'the metadata debug callback invoked pool.end');
    const [queryResult, endResult] = await bounded(Promise.all([initial, ending]),
      'initial Query and pool.end from metadata debug');
    await tick();
    assert.equal(metadataBuilds, 1);
    assert.deepEqual(p.queries, [], 'internal metadata and initial SQL stay off the wire after end');
    assertEnded(queryResult);
    assert.equal(endResult.status, 'fulfilled');
    // An unhandled rejection from fetchArrayTypes() also fails node:test.
  });

test('CF idle shutdown rejects an unconfirmed raw.closed without wrapper close',
  { timeout: 5000 }, async t => {
    if (!process.env.GATEWAY_POSTGRES_RECOVERY_DRIVER?.endsWith('postgres-cf.mjs'))
      return t.skip('requires the isolated CF bundle');
    const p = await peer(t, { beforeSocket: () => {} });
    const originalFactory = p.raw.options.socket;
    const rawClosed = deferred();
    const failure = new Error('synthetic raw.closed rejection');
    void rawClosed.promise.catch(() => {});
    let socket;
    let nativeEnd;
    let nativeDestroy;
    let wrapperCloseEvents = 0;
    let rawCloseCalls = 0;
    p.raw.options.socket = async options => {
      socket = await originalFactory(options);
      nativeEnd = socket.end;
      nativeDestroy = socket.destroy;
      socket.raw = {
        closed: rawClosed.promise,
        close: () => {
          rawCloseCalls++;
          rawClosed.reject(failure);
          return rawClosed.promise;
        },
      };
      socket.on('close', () => { wrapperCloseEvents++; });
      socket.end = () => {
        void Promise.resolve(socket.raw.close()).catch(() => {});
        return socket;
      };
      socket.destroy = () => socket;
      return socket;
    };
    await bounded(p.raw.unsafe('select warm'), 'warm CF-like socket');

    const rawEnd = p.raw.end;
    let result;
    try {
      result = await bounded(outcome(rawEnd()), 'CF pool.end after raw.closed rejection');
      assert.equal(result.status, 'rejected', 'raw.closed rejection is not a physical close receipt');
      assert.equal(result.exposesAddress, false);
      assert.equal(result.exposesPort, false);
      assert.ok(rawCloseCalls >= 1, 'raw close was attempted and rejected');
      assert.equal(wrapperCloseEvents, 0, 'the CF wrapper never emitted close');
      assert.equal(socket.destroyed, false, 'no physical close was proven');
      assert.deepEqual(p.queries, ['select warm']);
    } finally {
      // The negative fixture intentionally withholds all close receipts. Restore
      // its native socket methods before test-owned transport teardown.
      p.raw.end = () => Promise.resolve();
      if (socket) {
        socket.end = nativeEnd;
        socket.destroy = nativeDestroy;
        socket.destroy();
      }
    }
  });

test('local shutdown rejects a resolved reserve handoff before its async lease continuation',
  { timeout: 5000 }, async t => {
    let clientSocket;
    const p = await peer(t, {
      maxPipeline: 0,
      holdReady: query => query === 'select blocker',
      beforeSocket: () => {},
    });
    const originalFactory = p.raw.options.socket;
    p.raw.options.socket = async options => {
      clientSocket = await originalFactory(options);
      return clientSocket;
    };
    const active = outcome(p.raw.unsafe('select blocker').execute());
    await bounded(p.entered, 'blocking Query dispatch');
    const lease = outcome(p.raw.reserve());
    await tick();
    assert.deepEqual(p.queries, ['select blocker']);

    const readyFrame = Buffer.from([90, 0, 0, 0, 5, 73]);
    const readyObserved = deferred();
    let ending;
    const onReady = bytes => {
      if (!bytes.includes(readyFrame)) return;
      clientSocket.removeListener('data', onReady);
      // Registered after the driver's data handler: its onopen() has resolved
      // the reserve sentinel, but async reserve() has not resumed yet.
      ending = outcome(p.raw.end());
      readyObserved.resolve();
    };
    clientSocket.on('data', onReady);
    p.release();
    await bounded(readyObserved.promise, 'reserve handoff ReadyForQuery');
    assert.ok(ending);
    const [activeResult, leaseResult, endResult] = await bounded(
      Promise.all([active, lease, ending]), 'active Query, reserve handoff, and pool.end');
    if (leaseResult.status === 'fulfilled') leaseResult.result.release();
    assert.equal(activeResult.status, 'fulfilled', 'already-dispatched blocker remains owned');
    assertEnded(leaseResult);
    assert.equal(endResult.status, 'fulfilled');
    await tick();
    assert.deepEqual(p.queries, ['select blocker'], 'the ended connection cannot serve a lease');
  });

test('local shutdown rejects first listen without creating a child socket or SQL',
  { timeout: 5000 }, async t => {
    let socketFactoryCalls = 0;
    const p = await peer(t, {
      beforeSocket: () => {
        socketFactoryCalls++;
        throw new Error('a post-end listen must not open a socket');
      },
    });
    await bounded(p.raw.end(), 'idle pool.end before first listen');
    const listenResult = await bounded(outcome(p.raw.listen('fixture_channel', () => {})),
      'first listen after end');
    assertEnded(listenResult);
    await tick();
    assert.equal(socketFactoryCalls, 0, 'listen must reject before child socket creation');
    assert.deepEqual(p.queries, [], 'listen must not dispatch SQL after end');
  });
