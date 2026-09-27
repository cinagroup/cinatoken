import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';

/** Local transparent PostgreSQL proxy: drop one real COMMIT CommandComplete, not a fake SQL server. */
export async function commitAckProxy(targetPort) {
  assert.ok(Number.isSafeInteger(targetPort) && targetPort > 0 && targetPort < 65536);
  const sockets = new Set(), dropped = Promise.withResolvers();
  const observations = { connections: 0, commitCommands: 0, claimUpdates: 0, droppedCommitAcks: 0 };
  let armed = false, failure;
  const server = createServer(front => {
    observations.connections++;
    const back = createConnection({ host: '127.0.0.1', port: targetPort });
    for (const socket of [front, back]) {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    }
    front.on('close', () => back.destroy()); back.on('close', () => front.destroy());
    let startup = true, requestBuffer = Buffer.alloc(0), responseBuffer = Buffer.alloc(0);
    function abort(error) { failure ??= error; front.destroy(); back.destroy(); dropped.reject(error); }
    front.on('data', chunk => {
      try {
        requestBuffer = Buffer.concat([requestBuffer, chunk]); assert.ok(requestBuffer.length <= 131072);
        while (requestBuffer.length >= (startup ? 4 : 5)) {
          const size = requestBuffer.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
          assert.ok(size >= (startup ? 8 : 5) && size <= 65536);
          if (requestBuffer.length < size) break;
          const packet = requestBuffer.subarray(0, size); requestBuffer = requestBuffer.subarray(size);
          if (startup) { assert.equal(packet.readUInt32BE(4), 196608); startup = false; }
          else if (packet[0] === 80 || packet[0] === 81) {
            // Parse / simple-query frames only; authentication and bind values are never logged.
            const start = packet[0] === 80 ? packet.indexOf(0, 5) + 1 : 5;
            const sql = packet.subarray(start, packet.indexOf(0, start)).toString();
            if (/^commit\s*$/i.test(sql)) observations.commitCommands++;
            if (sql.includes("SET state='dispatch_claimed'")) observations.claimUpdates++;
          }
          back.write(packet);
        }
      } catch (error) { abort(error); }
    });
    back.on('data', chunk => {
      try {
        responseBuffer = Buffer.concat([responseBuffer, chunk]); assert.ok(responseBuffer.length <= 131072);
        while (responseBuffer.length >= 5) {
          const size = responseBuffer.readUInt32BE(1) + 1; assert.ok(size >= 5 && size <= 65536);
          if (responseBuffer.length < size) break;
          const packet = responseBuffer.subarray(0, size); responseBuffer = responseBuffer.subarray(size);
          if (armed && packet[0] === 67 && packet.subarray(5).equals(Buffer.from('COMMIT\0'))) {
            observations.droppedCommitAcks++; armed = false;
            // PostgreSQL has committed; neither CommandComplete nor ReadyForQuery reaches the caller.
            front.destroy(); back.destroy(); dropped.resolve(); return;
          }
          front.write(packet);
        }
      } catch (error) { abort(error); }
    });
  });
  // Install a rejection handler immediately; tests still await the original promise and assert it.
  dropped.promise.catch(() => {});
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  return { port: server.address().port, observations, dropped: dropped.promise,
    arm() { assert.ok(!armed); assert.equal(observations.droppedCommitAcks, 0); armed = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
      if (failure) throw failure;
    } };
}
