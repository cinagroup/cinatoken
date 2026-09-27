import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const COMMIT_COMPLETE = Buffer.from('COMMIT\0');

function cstring(frame, start, label) {
  const end = frame.indexOf(0, start);
  assert.ok(end >= start && end < frame.length,
    `invalid PostgreSQL ${label} frame`);
  return { value: frame.toString('utf8', start, end), next: end + 1 };
}

function isPlainCommit(sql) {
  if (!/^\s*COMMIT\b/i.test(sql)) return false;
  assert.match(sql, /^\s*COMMIT\s*;?\s*$/i,
    'journal ACK proxy requires one plain COMMIT command');
  return true;
}

/**
 * Local cleartext PostgreSQL v3 wire proxy for one journal PREPARE transaction.
 * It forwards the client's original COMMIT frames to the real backend. Only
 * after PostgreSQL emits CommandComplete(COMMIT) does it suppress that server
 * frame and close the client socket. It does not execute SQL or fake a COMMIT.
 *
 * The backend CommandComplete is a stronger boundary than a client-side
 * injected exception. This helper does not manipulate TCP acknowledgments or
 * prove anything about a remote pooler, Worker, or financial writer.
 */
export async function startJournalCommitAckDropProxyV381({
  upstreamHost = '127.0.0.1', upstreamPort,
} = {}) {
  assert.ok(typeof upstreamHost === 'string' && upstreamHost.length > 0);
  assert.ok(Number.isSafeInteger(upstreamPort)
    && upstreamPort > 0 && upstreamPort < 65_536);

  const dropped = Promise.withResolvers();
  // A failed proxy may be closed before a fixture awaits the drop promise.
  dropped.promise.catch(() => {});
  const facts = {
    connections: 0,
    commitCommands: 0,
    commitProtocol: null,
    backendCommitCompletes: 0,
    droppedCommitAcks: 0,
    forwardedBackendFrames: 0,
  };
  const sockets = new Set();
  let closed = false;
  let dropObserved = false;
  let failure;
  let timeout;
  let closePromise;

  function fail(error) {
    if (failure || dropObserved || closed) return;
    failure = error instanceof Error ? error : new Error(String(error));
    clearTimeout(timeout);
    dropped.reject(failure);
    for (const socket of sockets) socket.destroy();
  }

  const server = createServer(front => {
    facts.connections++;
    if (facts.connections !== 1) {
      fail(new Error('journal ACK proxy accepts one client connection'));
      front.destroy();
      return;
    }
    const back = createConnection({ host: upstreamHost, port: upstreamPort });
    for (const socket of [front, back]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', error => fail(error));
    }
    front.on('close', () => {
      if (!dropObserved && !closed && !failure) {
        fail(new Error('journal client closed before COMMIT acknowledgement drop'));
      }
      back.destroy();
    });
    back.on('close', () => {
      if (!dropObserved && !closed && !failure) {
        fail(new Error('PostgreSQL backend closed before COMMIT completed'));
      }
      front.destroy();
    });

    let startup = true;
    let requestBuffer = Buffer.alloc(0);
    let responseBuffer = Buffer.alloc(0);
    const commitStatements = new Set();
    const commitPortals = new Set();

    front.on('data', chunk => {
      try {
        requestBuffer = Buffer.concat([requestBuffer, chunk]);
        assert.ok(requestBuffer.length <= MAX_BUFFER_BYTES,
          'PostgreSQL frontend buffer exceeded');
        while (requestBuffer.length >= (startup ? 4 : 5)) {
          const size = requestBuffer.readUInt32BE(startup ? 0 : 1)
            + (startup ? 0 : 1);
          assert.ok(size >= (startup ? 8 : 5) && size <= MAX_FRAME_BYTES,
            'invalid PostgreSQL frontend frame length');
          if (requestBuffer.length < size) break;
          const frame = requestBuffer.subarray(0, size);
          requestBuffer = requestBuffer.subarray(size);

          if (startup) {
            assert.equal(frame.readUInt32BE(4), 196608,
              'journal ACK proxy requires cleartext PostgreSQL v3 startup');
            startup = false;
          } else if (frame[0] === 80) { // Parse
            const statement = cstring(frame, 5, 'Parse statement');
            const sql = cstring(frame, statement.next, 'Parse SQL').value;
            if (isPlainCommit(sql)) commitStatements.add(statement.value);
            else commitStatements.delete(statement.value);
          } else if (frame[0] === 66) { // Bind
            const portal = cstring(frame, 5, 'Bind portal');
            const statement = cstring(frame, portal.next, 'Bind statement');
            if (commitStatements.has(statement.value)) {
              commitPortals.add(portal.value);
            } else {
              commitPortals.delete(portal.value);
            }
          } else if (frame[0] === 69) { // Execute
            const portal = cstring(frame, 5, 'Execute portal');
            assert.equal(portal.next + 4, frame.length,
              'invalid PostgreSQL Execute frame');
            if (commitPortals.has(portal.value)) {
              facts.commitCommands++;
              facts.commitProtocol = 'extended';
              assert.equal(facts.commitCommands, 1,
                'journal ACK proxy saw more than one executed COMMIT');
            }
          } else if (frame[0] === 67) { // Close statement or portal
            const target = cstring(frame, 6, 'Close target');
            if (frame[5] === 83) commitStatements.delete(target.value);
            if (frame[5] === 80) commitPortals.delete(target.value);
          } else if (frame[0] === 81) { // Simple Query
            assert.equal(frame.at(-1), 0, 'invalid PostgreSQL Query frame');
            const sql = frame.toString('utf8', 5, frame.length - 1);
            if (isPlainCommit(sql)) {
              facts.commitCommands++;
              facts.commitProtocol = 'simple';
              assert.equal(facts.commitCommands, 1,
                'journal ACK proxy saw more than one executed COMMIT');
            }
            // Simple Query discards the unnamed prepared statement and portal.
            commitStatements.delete('');
            commitPortals.delete('');
          }
          back.write(frame);
        }
      } catch (error) { fail(error); }
    });

    back.on('data', chunk => {
      try {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        assert.ok(responseBuffer.length <= MAX_BUFFER_BYTES,
          'PostgreSQL backend buffer exceeded');
        while (responseBuffer.length >= 5) {
          const size = responseBuffer.readUInt32BE(1) + 1;
          assert.ok(size >= 5 && size <= MAX_FRAME_BYTES,
            'invalid PostgreSQL backend frame length');
          if (responseBuffer.length < size) break;
          const frame = responseBuffer.subarray(0, size);
          responseBuffer = responseBuffer.subarray(size);
          if (frame[0] === 69 && facts.commitCommands === 1) {
            fail(new Error('PostgreSQL rejected the journal COMMIT'));
            return;
          }
          if (frame[0] === 67 && frame.subarray(5).equals(COMMIT_COMPLETE)) {
            assert.equal(facts.commitCommands, 1,
              'backend COMMIT completion lacked one frontend execution');
            facts.backendCommitCompletes++;
            assert.equal(facts.backendCommitCompletes, 1,
              'journal ACK proxy saw more than one backend COMMIT');
            facts.droppedCommitAcks++;
            dropObserved = true;
            clearTimeout(timeout);
            // Suppress CommandComplete(COMMIT) and the rest of this connection.
            // Every earlier backend frame has already been forwarded unchanged.
            front.destroy();
            back.destroy();
            dropped.resolve();
            return;
          }
          facts.forwardedBackendFrames++;
          front.write(frame);
        }
      } catch (error) { fail(error); }
    });
  });
  server.on('error', fail);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  timeout = setTimeout(() => fail(new Error(
    'Timed out waiting for real journal COMMIT CommandComplete')), 60_000);

  return {
    host: '127.0.0.1',
    port: server.address().port,
    facts,
    waitForDrop: () => dropped.promise,
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(timeout);
      if (!dropObserved) dropped.reject(new Error(
        'Journal ACK proxy closed before COMMIT acknowledgement drop'));
      closePromise = (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close(error =>
          error ? reject(error) : resolve()));
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
}
