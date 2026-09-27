import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';

const MAX_PACKET_BYTES = 65_536;
const MAX_BUFFER_BYTES = 131_072;
const RESPONSE_COMMIT = Buffer.from('COMMIT\0');

function cstring(packet, start, label) {
  const end = packet.indexOf(0, start);
  assert.ok(end >= start, `invalid PostgreSQL ${label} frame`);
  return { value: packet.toString('utf8', start, end), next: end + 1 };
}

function commitSql(sql) {
  if (!/^\s*COMMIT\b/i.test(sql)) return false;
  assert.match(sql, /^\s*COMMIT\s*;?\s*$/i,
    'delayed COMMIT proxy requires one plain COMMIT command');
  return true;
}

/**
 * Local cleartext PostgreSQL wire proxy for the interval before COMMIT is sent.
 * It holds one original Simple Query COMMIT frame or one extended-protocol
 * Execute + Flush/Sync group, closes its client socket, and leaves the real
 * backend transaction open until release() forwards those bytes exactly once.
 * Parse and Bind may reach PostgreSQL before capture, but Execute cannot.
 * The proxy never executes SQL itself or synthesizes a response.
 */
export async function delayedCommitProxy(targetPort) {
  assert.ok(Number.isSafeInteger(targetPort) && targetPort > 0 && targetPort < 65_536);
  const held = Promise.withResolvers();
  const committed = Promise.withResolvers();
  // An assertion may inspect either promise after a transport failure.
  held.promise.catch(() => {});
  committed.promise.catch(() => {});

  const observations = {
    connections: 0,
    commitCommands: 0,
    heldCommits: 0,
    releasedCommits: 0,
    commitCompletes: 0,
  };
  const sockets = new Set();
  let heldPacket, heldBackend, captureTimer, holdTimer, commitTimer;
  let released = false, releaseCalled = false, closed = false, failure, closePromise;

  function fail(error) {
    if (failure || observations.commitCompletes) return;
    failure = error instanceof Error ? error : new Error(String(error));
    clearTimeout(captureTimer);
    clearTimeout(holdTimer);
    clearTimeout(commitTimer);
    held.reject(failure);
    committed.reject(failure);
    for (const socket of sockets) socket.destroy();
  }

  const server = createServer(front => {
    observations.connections++;
    const back = createConnection({ host: '127.0.0.1', port: targetPort });
    for (const socket of [front, back]) {
      sockets.add(socket);
      socket.on('error', error => {
        if (socket === heldBackend || (socket === front && !heldBackend)) fail(error);
      });
      socket.on('close', () => sockets.delete(socket));
    }
    // Closing the front after capture is intentional: the backend connection
    // must survive so that the pending transaction can later receive COMMIT.
    front.on('close', () => {
      if (back === heldBackend) held.resolve();
      else back.destroy();
    });
    back.on('close', () => {
      if (back === heldBackend && !closed && !observations.commitCompletes) {
        fail(new Error('PostgreSQL backend closed before delayed COMMIT completed'));
      }
      front.destroy();
    });

    let startup = true;
    let requestBuffer = Buffer.alloc(0);
    let responseBuffer = Buffer.alloc(0);
    const commitStatements = new Set();
    const commitPortals = new Set();
    let pendingCommitExecute = null;
    function capture(packets) {
      assert.equal(observations.heldCommits, 0,
        'delayed COMMIT proxy can hold only one COMMIT');
      heldPacket = Buffer.concat(packets);
      heldBackend = back;
      observations.heldCommits++;
      clearTimeout(captureTimer);
      holdTimer = setTimeout(() => fail(new Error(
        'Timed out waiting to release delayed COMMIT')), 12_000);
      // Do not forward bytes after the captured command from a retired
      // client. The test owns one transaction and its release.
      requestBuffer = Buffer.alloc(0);
      front.destroy();
    }
    front.on('data', chunk => {
      try {
        requestBuffer = Buffer.concat([requestBuffer, chunk]);
        assert.ok(requestBuffer.length <= MAX_BUFFER_BYTES, 'request buffer too large');
        while (requestBuffer.length >= (startup ? 4 : 5)) {
          const size = requestBuffer.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
          assert.ok(size >= (startup ? 8 : 5) && size <= MAX_PACKET_BYTES,
            'invalid PostgreSQL request frame length');
          if (requestBuffer.length < size) break;
          const packet = requestBuffer.subarray(0, size);
          requestBuffer = requestBuffer.subarray(size);

          if (startup) {
            assert.equal(packet.readUInt32BE(4), 196608,
              'delayed COMMIT proxy requires a cleartext PostgreSQL v3 startup');
            startup = false;
          } else if (pendingCommitExecute) {
            assert.ok(packet[0] === 72 || packet[0] === 83,
              'expected Flush or Sync after held COMMIT Execute');
            assert.equal(packet.length, 5,
              'invalid Flush or Sync after held COMMIT Execute');
            pendingCommitExecute.push(Buffer.from(packet));
            while (requestBuffer.length >= 5) {
              const trailingSize = requestBuffer.readUInt32BE(1) + 1;
              assert.equal(trailingSize, 5,
                'unexpected frontend frame after COMMIT Execute');
              assert.ok(requestBuffer[0] === 72 || requestBuffer[0] === 83,
                'unexpected frontend frame after COMMIT Execute');
              pendingCommitExecute.push(Buffer.from(requestBuffer.subarray(0, 5)));
              requestBuffer = requestBuffer.subarray(5);
            }
            assert.equal(requestBuffer.length, 0,
              'incomplete frontend frame after COMMIT Execute');
            capture(pendingCommitExecute);
            pendingCommitExecute = null;
            return;
          } else if (packet[0] === 80) { // Parse
            const name = cstring(packet, 5, 'Parse statement');
            const sql = cstring(packet, name.next, 'Parse SQL').value;
            if (commitSql(sql)) commitStatements.add(name.value);
            else commitStatements.delete(name.value);
          } else if (packet[0] === 66) { // Bind
            const portal = cstring(packet, 5, 'Bind portal');
            const statement = cstring(packet, portal.next, 'Bind statement');
            if (commitStatements.has(statement.value)) {
              assert.ok(commitPortals.size === 0 || commitPortals.has(portal.value),
                'multiple COMMIT portals are not supported');
              commitPortals.add(portal.value);
            } else commitPortals.delete(portal.value);
          } else if (packet[0] === 69) { // Execute
            const portal = cstring(packet, 5, 'Execute portal');
            assert.equal(portal.next + 4, packet.length,
              'invalid PostgreSQL Execute frame');
            assert.ok(commitPortals.size === 0 || commitPortals.has(portal.value),
              'Execute portal does not match the bound COMMIT portal');
            if (commitPortals.has(portal.value)) {
              observations.commitCommands++;
              pendingCommitExecute = [Buffer.from(packet)];
              // postgres.js sends Execute followed by Flush in the same
              // write. Hold both original frames; neither reaches PG yet.
              continue;
            }
          } else if (packet[0] === 67) { // Close statement or portal
            const kind = packet[5];
            const name = cstring(packet, 6, 'Close target');
            if (kind === 83) commitStatements.delete(name.value);
            if (kind === 80) commitPortals.delete(name.value);
          } else if (packet[0] === 81) { // Simple Query
            assert.equal(packet.at(-1), 0, 'invalid PostgreSQL Query frame');
            const sql = packet.toString('utf8', 5, packet.length - 1);
            if (commitSql(sql)) {
              observations.commitCommands++;
              assert.equal(requestBuffer.length, 0,
                'unexpected frontend bytes after Simple Query COMMIT');
              capture([Buffer.from(packet)]);
              return;
            }
            // A Simple Query discards the unnamed prepared statement/portal.
            commitStatements.delete('');
            commitPortals.delete('');
          }
          back.write(packet);
        }
      } catch (error) { fail(error); }
    });
    back.on('data', chunk => {
      try {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        assert.ok(responseBuffer.length <= MAX_BUFFER_BYTES, 'response buffer too large');
        while (responseBuffer.length >= 5) {
          const size = responseBuffer.readUInt32BE(1) + 1;
          assert.ok(size >= 5 && size <= MAX_PACKET_BYTES,
            'invalid PostgreSQL response frame length');
          if (responseBuffer.length < size) break;
          const packet = responseBuffer.subarray(0, size);
          responseBuffer = responseBuffer.subarray(size);
          if (back === heldBackend) {
            if (packet[0] === 69 && !observations.commitCompletes) {
              fail(new Error('PostgreSQL rejected the delayed COMMIT'));
              return;
            }
            if (released && packet[0] === 67
                && packet.subarray(5).equals(RESPONSE_COMMIT)) {
              observations.commitCompletes++;
              clearTimeout(commitTimer);
              committed.resolve();
            }
            // The client is already gone; retain only the completion signal.
          } else {
            front.write(packet);
          }
        }
      } catch (error) { fail(error); }
    });
  });
  server.on('error', fail);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  captureTimer = setTimeout(() => fail(new Error(
    'Timed out waiting to capture COMMIT execution')), 30_000);

  return {
    port: server.address().port,
    held: held.promise,
    committed: committed.promise,
    observations,
    async release() {
      assert.equal(releaseCalled, false, 'delayed COMMIT release may run once');
      releaseCalled = true;
      await held.promise;
      if (failure) throw failure;
      assert.ok(heldBackend && !heldBackend.destroyed && heldPacket,
        'held PostgreSQL backend must remain connected');
      clearTimeout(holdTimer);
      released = true;
      observations.releasedCommits++;
      commitTimer = setTimeout(() => fail(new Error(
        'Timed out waiting for real COMMIT CommandComplete')), 12_000);
      heldBackend.write(heldPacket, error => { if (error) fail(error); });
      return committed.promise;
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(captureTimer);
      clearTimeout(holdTimer);
      clearTimeout(commitTimer);
      if (!heldBackend) held.reject(new Error('Delayed COMMIT proxy closed before capture'));
      if (!observations.commitCompletes) committed.reject(new Error(
        'Delayed COMMIT proxy closed before completion'));
      closePromise = (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
}
