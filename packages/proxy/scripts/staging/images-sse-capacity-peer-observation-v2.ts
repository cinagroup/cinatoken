/// <reference path="./images-env.d.ts" />
import type {HttpRequestCapacityPolicy} from '../../src/middleware/request-capacity';
import {
  observeImagesSseCapacity, SSE_CAPACITY_INSTANCE_HEADER, SSE_CAPACITY_ORIGIN, SSE_CAPACITY_PATH,
} from './images-sse-capacity-observation';

export const SSE_CAPACITY_WATCH_PATH = '/__staging/sse-capacity/watch-v2';
export const SSE_CAPACITY_WATCH_HEADER = 'x-c02-capacity-watch';
export const SSE_CAPACITY_PEER_HEADER = 'x-c02-capacity-peer';
export const SSE_CAPACITY_PEER_PROFILE = 'c02-sse-peer-v2';
export const SSE_CAPACITY_WATCH_INTERVAL_MS = 1_000;
export const SSE_CAPACITY_WATCH_LIFETIME_MS = 180_000;
export const SSE_CAPACITY_WATCH_MAX_SAMPLES = 180;
export const SSE_CAPACITY_BARRIER_PATH = '/__staging/sse-capacity/barrier-v2';
export const SSE_CAPACITY_BARRIER_HEADER = 'x-c02-capacity-barrier';
const stages = ['held', 'post-native', 'post-recovery'] as const;
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const peerPattern = new RegExp(`^(${uuidPattern}):([1-9][0-9]{0,15})$`);
type Handler = Pick<Required<ExportedHandler<ImagesStagingEnv>>, 'fetch'>;

function reject(status: number, reason: string): Response {
  return Response.json({status: 'rejected', reason, dispatch_started: false}, {
    status, headers: {'Cache-Control': 'no-store'},
  });
}

/** Staging-only observation of the SAME logical pool, not isolate affinity.
 * Shared state is numeric diagnostic admission metadata only. All stream I/O,
 * timers, signals and pending pulls belong to the individual watch invocation.
 * A peer is not authentication: Cloudflare Access must still protect this host.
 */
export function observeImagesSseCapacityPeerV2(build: (policy: HttpRequestCapacityPolicy) => Handler): Handler {
  let capturedPolicy: HttpRequestCapacityPolicy | undefined;
  const handler = observeImagesSseCapacity(policy => {
    capturedPolicy = policy;
    return build(policy);
  });
  if (!capturedPolicy) throw new Error('Capacity policy was not constructed');
  const pool = capturedPolicy.pool;
  let nextWatchEpoch = 0;
  let activeWatchEpoch = 0;
  let activeBarrier = 0;

  return {
    async fetch(request, bindings, context) {
      const url = new URL(request.url);
      if (url.origin !== SSE_CAPACITY_ORIGIN || bindings.DATABASE_DRIVER !== 'd1'
        || bindings.REQUEST_BODY_LOGGING !== 'off' || bindings.BATCH_API_ENABLED !== 'false')
        return reject(404, 'profile_unavailable');
      const watching = url.pathname === SSE_CAPACITY_WATCH_PATH;
      const barrierRequest = url.pathname === SSE_CAPACITY_BARRIER_PATH;
      const barrierValue = request.headers.get(SSE_CAPACITY_BARRIER_HEADER);
      if (!barrierRequest && barrierValue !== null) return reject(400, 'unexpected_barrier');
      if (barrierRequest && (request.method !== 'POST' || request.body !== null || url.search || url.hash
        || request.headers.has('upgrade') || request.headers.has(SSE_CAPACITY_WATCH_HEADER)
        || !stages.some(stage => stage === barrierValue))) return reject(400, 'invalid_barrier');
      const inference = url.pathname === '/v1/images/generations';
      const peer = request.headers.get(SSE_CAPACITY_PEER_HEADER);
      if (watching) {
        if (request.method !== 'GET' || url.search || url.hash || request.body !== null
          || request.headers.has('upgrade') || peer !== null
          || request.headers.get(SSE_CAPACITY_WATCH_HEADER) !== 'v2')
          return reject(400, 'invalid_watch');
      } else if (request.headers.has(SSE_CAPACITY_WATCH_HEADER)) {
        return reject(400, 'unexpected_watch_header');
      }
      if (!watching && !inference && !barrierRequest) {
        if (peer !== null) return reject(400, 'unexpected_peer');
        return handler.fetch(request, bindings, context);
      }
      const match = peer !== null && peer.length <= 53 ? peerPattern.exec(peer) : null;
      if ((inference || barrierRequest) && (request.method !== 'POST' || url.search || url.hash || request.headers.has('upgrade')
        || !match || !Number.isSafeInteger(Number(match[2]))))
        return reject(400, 'invalid_peer');
      if (request.signal.aborted) return reject(409, 'request_aborted');

      // Local function call to the frozen census: no network, DB, body read or
      // admission. Reuse its identity without changing historical artifacts.
      const census = await handler.fetch(new Request(SSE_CAPACITY_ORIGIN + SSE_CAPACITY_PATH), bindings, context);
      const instanceId = census.headers.get(SSE_CAPACITY_INSTANCE_HEADER);
      await census.body?.cancel();
      if (census.status !== 200 || !instanceId) return reject(503, 'identity_unavailable');
      if (request.signal.aborted) return reject(409, 'request_aborted');
      if (inference || barrierRequest) {
        if (!match || match[1] !== instanceId || Number(match[2]) !== activeWatchEpoch || activeWatchEpoch === 0)
          return reject(409, 'peer_not_active_here');
        if (barrierRequest) {
          if (stages[activeBarrier] !== barrierValue) return reject(409, 'barrier_order');
          // Synchronous same-pool marker. Subsequent samples carry this value;
          // a sample queued before this call cannot be relabeled by the client.
          activeBarrier++;
          return Response.json({profile: SSE_CAPACITY_PEER_PROFILE, kind: 'barrier', instanceId,
            watchEpoch: activeWatchEpoch, barrier: activeBarrier, stage: barrierValue}, {
            headers: {'Cache-Control': 'no-store', [SSE_CAPACITY_INSTANCE_HEADER]: instanceId,
              [SSE_CAPACITY_PEER_HEADER]: `${instanceId}:${activeWatchEpoch}`},
          });
        }
        // No body read/DB/upstream has occurred. Keep the original Request so
        // the host probe can observe its native abort signal. The inner adapter
        // removes diagnostic headers before entering the business handler.
        return handler.fetch(request, bindings, context);
      }
      if (activeWatchEpoch !== 0) return reject(409, 'watch_already_active');
      if (nextWatchEpoch === Number.MAX_SAFE_INTEGER) return reject(503, 'watch_epoch_exhausted');
      const watchEpoch = ++nextWatchEpoch;
      activeWatchEpoch = watchEpoch;
      activeBarrier = 0;

      let ended = false;
      let sequence = 0;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let interval: ReturnType<typeof setTimeout> | undefined;
      let wakePull: (() => void) | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const frame = (value: object) => {
        const bytes = encoder.encode(JSON.stringify(value) + '\n');
        if (bytes.byteLength > 512) throw new Error('Capacity peer frame exceeds fixed bound');
        return bytes;
      };
      const cleanup = () => {
        if (deadline !== undefined) clearTimeout(deadline);
        if (interval !== undefined) clearTimeout(interval);
        deadline = interval = undefined;
        request.signal.removeEventListener('abort', onAbort);
        const wake = wakePull;
        wakePull = undefined;
        if (activeWatchEpoch === watchEpoch) activeWatchEpoch = 0;
        wake?.();
      };
      const finish = (reason: 'deadline' | 'sample-limit' | 'abort' | 'cancel') => {
        if (ended) return;
        ended = true;
        cleanup();
        if (reason === 'cancel') return;
        if (reason === 'abort') {
          controller.error(new Error('Capacity peer observation aborted'));
          return;
        }
        // Diagnostic end, never SSE DONE or a settlement fact. With HWM=0,
        // at most the first sample and this terminal record may be queued.
        controller.enqueue(frame({profile: SSE_CAPACITY_PEER_PROFILE, kind: 'end', instanceId, watchEpoch, reason}));
        controller.close();
      };
      const onAbort = () => finish('abort');
      const sample = () => {
        controller.enqueue(frame({profile: SSE_CAPACITY_PEER_PROFILE, kind: 'sample', instanceId,
          watchEpoch, barrier: activeBarrier, sequence: ++sequence, ...pool.snapshot()}));
        if (sequence === SSE_CAPACITY_WATCH_MAX_SAMPLES) finish('sample-limit');
      };
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          request.signal.addEventListener('abort', onAbort, {once: true});
          if (request.signal.aborted) return onAbort();
          deadline = setTimeout(() => finish('deadline'), SSE_CAPACITY_WATCH_LIFETIME_MS);
          sample();
        },
        async pull() {
          if (ended) return;
          await new Promise<void>(resolve => {
            wakePull = resolve;
            interval = setTimeout(() => {
              interval = undefined;
              wakePull = undefined;
              resolve();
            }, SSE_CAPACITY_WATCH_INTERVAL_MS);
          });
          if (!ended) sample();
        },
        cancel() { finish('cancel'); },
      }, {highWaterMark: 0});
      return new Response(body, {headers: {
        'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store',
        [SSE_CAPACITY_INSTANCE_HEADER]: instanceId,
        [SSE_CAPACITY_PEER_HEADER]: `${instanceId}:${watchEpoch}`,
      }});
    },
  };
}
