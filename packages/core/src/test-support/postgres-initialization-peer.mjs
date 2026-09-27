import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Bounded local PostgreSQL protocol peer; no SQL execution, TLS, auth or pooler.
const frame = (type, data) => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data), result = Buffer.alloc(5 + body.length);
  result[0] = type.charCodeAt(0); result.writeUInt32BE(4 + body.length, 1); body.copy(result, 5); return result;
};
const ready = frame('Z', 'I');
const failure = frame('E', 'SERROR\0CXX000\0MPRIVATE_WIRE_FAILURE\0\0');

export async function postgresInitializationPeer(t, mode) {
  const sockets = new Set(), observations = { connections: 0, closes: 0, queries: [] };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const server = createServer(socket => {
    observations.connections++; sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); observations.closes++; });
    let buffer = Buffer.alloc(0), startup = true;
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]); assert.ok(buffer.length < 32768);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = buffer.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        assert.ok(length >= 4 && length < 32768); if (buffer.length < length) return;
        const packet = buffer.subarray(0, length); buffer = buffer.subarray(length);
        if (startup) {
          startup = false; assert.equal(packet.readUInt32BE(4), 196608); // postgres.js protocol 3.0
          socket.write(Buffer.concat([frame('R', Buffer.alloc(4)), ready]));
        } else if (packet[0] === 81) {
          observations.queries.push(packet.subarray(5, -1).toString()); entered.resolve();
          if (mode === 'disconnect') socket.destroy();
          else if (mode === 'hold-error') {
            void release.promise.then(() => { if (!socket.destroyed) socket.write(Buffer.concat([failure, ready])); }).catch(() => socket.destroy());
          } else socket.write(Buffer.concat([mode === 'error' ? failure : frame('C', 'SET\0'), ready]));
        } else if (packet[0] === 88) socket.end();
        else assert.fail('Unexpected wire message ' + packet[0]);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { release.resolve(); for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); });
  return { observations, entered: entered.promise, release: () => release.resolve(),
    url: `postgres://synthetic:synthetic@127.0.0.1:${server.address().port}/synthetic?sslmode=disable` };
}

export async function assertOneClosedInitialization(peer) {
  // Server socket-close notification may trail the client's by one event turn.
  for (let i = 0; i < 20 && peer.observations.closes < peer.observations.connections; i++) await delay(5);
  assert.equal(peer.observations.connections, 1, 'one initialization attempt');
  assert.equal(peer.observations.closes, 1, 'failed initialization releases its real local socket');
  assert.deepEqual(peer.observations.queries, ['SET search_path TO cinatoken_gateway, public']);
}
