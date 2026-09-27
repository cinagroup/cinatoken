import assert from 'node:assert/strict';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';
import {parseCapacityPeer} from './staging-sse-capacity-peer-protocol.mjs';

export const PEER_V3_PROFILE = 'c02-sse-peer-v3';
export const PEER_V3_PRIMARY_URL = 'https://cinatoken-proxy-staging.cinagroup.workers.dev/v1/images/generations';
export const PEER_V3_WATCH_URL = 'wss://cinatoken-proxy-staging.cinagroup.workers.dev/__staging/sse-capacity/watch-v3';
export const PEER_V3_STAGES = Object.freeze(['held', 'post-native', 'post-recovery']);
export const PEER_V3_LIMITS = Object.freeze({frameBytes:512, frames:184, bytes:184*512, samples:180, commandChars:128});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
};
const copy = value => Object.freeze(structuredClone(value));
const jsonType = value => /^application\/json(?:;\s*charset=utf-8)?$/i.test(value ?? '');
const decoder = () => new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});

/** Capture headers from the actual fetch Response, without reading, cloning,
 * teeing or cancelling its body. Caller retains sole ownership of the SSE reader.
 * Receipt must come from the original request clock. This is not native evidence.
 */
export function captureSseCapacityPrimaryV3(response, received, clockId) {
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.redirected, false);
  assert.ok(response.url === '' || response.url === PEER_V3_PRIMARY_URL);
  assert.ok(response.body && !response.bodyUsed && !response.body.locked);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream(?:;\s*charset=utf-8)?$/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-c02-capacity-primary'), 'v3');
  assert.equal(response.headers.get('x-c02-capacity-before'), '0/0');
  const peer = response.headers.get('x-c02-capacity-peer');
  const {instanceId} = parseCapacityPeer(peer);
  assert.equal(response.headers.get('x-c02-capacity-instance'), instanceId);
  const requestId = response.headers.get('x-generation-id');
  assert.ok(typeof requestId === 'string' && requestId.startsWith('gen-') && uuid.test(requestId.slice(4)));
  assertOperatorSample(received, clockId);
  return copy({profile:PEER_V3_PROFILE, requestId, status:200, peer, instanceId, before:'0/0', received});
}

export function assertSseCapacityPrimaryV3(value, clockId) {
  keys(value, ['profile', 'requestId', 'status', 'peer', 'instanceId', 'before', 'received']);
  assert.equal(value.profile, PEER_V3_PROFILE);
  assert.equal(value.status, 200);
  assert.equal(value.before, '0/0');
  assert.equal(parseCapacityPeer(value.peer).instanceId, value.instanceId);
  assert.ok(typeof value.requestId === 'string' && value.requestId.startsWith('gen-') && uuid.test(value.requestId.slice(4)));
  assertOperatorSample(value.received, clockId);
  return copy(value);
}

/** Completed bounded rejection only. The future transport must separately prove
 * actual EOF, no redirect, and no earlier successful/uncertain upgrade. A true
 * result is a server declaration, NOT proof about inference or settlement and
 * NOT authority to replay inference or reconnect an established observer.
 */
export function isSseCapacityPeerV3Mismatch({status, headers, body, complete}) {
  if (complete !== true || status !== 409 || !(headers instanceof Headers)
    || !(body instanceof Uint8Array) || body.byteLength === 0 || body.byteLength > 512) return false;
  if (headers.get('cache-control') !== 'no-store' || !jsonType(headers.get('content-type'))
    || headers.has('x-generation-id') || headers.has('x-c02-capacity-watch') || headers.has('location')) return false;
  try {
    return decoder().decode(body) === '{"status":"rejected","reason":"peer_not_active_here","dispatch_started":false}';
  } catch { return false; }
}

export function assertSseCapacityPeerV3Record(value, peer) {
  const identity = parseCapacityPeer(peer);
  const common = ['profile', 'instanceId', 'watchEpoch', 'kind'];
  assert.equal(value?.profile, PEER_V3_PROFILE);
  assert.equal(value.instanceId, identity.instanceId);
  assert.equal(value.watchEpoch, identity.watchEpoch);
  if (value.kind === 'sample') {
    keys(value, [...common, 'barrier', 'sequence', 'maxRequests', 'maxReservedBytes', 'requests', 'reservedBytes']);
    assert.ok(Number.isInteger(value.sequence) && value.sequence >= 1 && value.sequence <= 180);
    assert.ok(Number.isInteger(value.barrier) && value.barrier >= 0 && value.barrier <= 3);
    assert.equal(value.maxRequests, 1);
    assert.equal(value.maxReservedBytes, 1024);
    assert.ok(value.requests === 0 || value.requests === 1);
    assert.equal(value.reservedBytes, value.requests * 1024);
  } else if (value.kind === 'barrier') {
    keys(value, [...common, 'barrier', 'stage']);
    assert.ok(Number.isInteger(value.barrier) && value.barrier >= 1 && value.barrier <= 3);
    assert.equal(value.stage, PEER_V3_STAGES[value.barrier - 1]);
  } else {
    keys(value, [...common, 'reason']);
    assert.equal(value.kind, 'end');
    assert.ok(value.reason === 'deadline' || value.reason === 'sample-limit');
  }
  return Object.freeze({...value});
}

/** Node WebSocket message parser, not a network client. Pass ws's isBinary flag
 * unchanged. maxPayload must also be set on the future socket: this application
 * bound cannot constrain bytes the transport buffered before callback dispatch.
 * Keeps numeric state only, never a history/queue. Every error permanently seals
 * it. One mark() call consumes a marker; lost send/ACK must NOT be retried.
 */
export function createSseCapacityPeerV3Parser(peer) {
  parseCapacityPeer(peer);
  const decode = decoder();
  let frames = 0, bytes = 0, sequence = 0, barrier = 0, issued = 0;
  let awaitingSample = false, ended = false, failed = false;
  const usable = () => assert.ok(!ended && !failed, 'Peer parser is terminal');
  const failClosed = work => {
    try { usable(); return work(); }
    catch (error) { failed = true; throw error; }
  };
  return Object.freeze({
    mark(stage) {
      return failClosed(() => {
        assert.ok(sequence > 0 && sequence < PEER_V3_LIMITS.samples);
        assert.equal(issued, barrier, 'Previous marker ACK still pending');
        assert.equal(awaitingSample, false, 'Previous marker sample still pending');
        assert.ok(issued < 3);
        assert.equal(stage, PEER_V3_STAGES[issued]);
        const command = JSON.stringify({profile:PEER_V3_PROFILE, kind:'mark', barrier:++issued, stage});
        assert.ok(command.length <= PEER_V3_LIMITS.commandChars);
        return command;
      });
    },
    pushMessage(data, isBinary) {
      return failClosed(() => {
        assert.equal(isBinary, false, 'Binary/unknown message type');
        assert.ok(data instanceof Uint8Array && data.byteLength > 0 && data.byteLength <= PEER_V3_LIMITS.frameBytes);
        assert.ok(frames < PEER_V3_LIMITS.frames && bytes + data.byteLength <= PEER_V3_LIMITS.bytes);
        frames++; bytes += data.byteLength;
        const raw = decode.decode(data), value = JSON.parse(raw);
        assert.equal(JSON.stringify(value), raw, 'Noncanonical JSON message');
        const row = assertSseCapacityPeerV3Record(value, peer);
        if (row.kind === 'sample') {
          assert.equal(row.sequence, sequence + 1);
          assert.equal(row.barrier, barrier, 'Sample must follow its ACK');
          if (sequence === 0) { assert.equal(row.barrier, 0); assert.equal(row.requests, 1, 'V3 starts occupied'); }
          sequence = row.sequence;
          awaitingSample = false;
        } else if (row.kind === 'barrier') {
          assert.ok(sequence > 0 && !awaitingSample && issued === barrier + 1);
          assert.equal(row.barrier, issued, 'Unissued, duplicate or regressed marker ACK');
          barrier = row.barrier;
          awaitingSample = true;
        } else {
          assert.ok(sequence > 0 && !awaitingSample);
          if (row.reason === 'sample-limit') assert.equal(sequence, PEER_V3_LIMITS.samples);
          ended = true;
        }
        // An old barrier sample while awaiting an ACK is permitted, but its
        // unchanged barrier cannot satisfy the newly issued phase.
        return row;
      });
    },
    finish() {
      // Transport EOF/close does not manufacture a protocol end or native event.
      try { assert.ok(!failed && ended && !awaitingSample); }
      catch (error) { failed = true; throw error; }
    },
    stats() { return Object.freeze({frames, bytes, sequence, barrier, issued, awaitingSample, ended, failed}); },
  });
}
