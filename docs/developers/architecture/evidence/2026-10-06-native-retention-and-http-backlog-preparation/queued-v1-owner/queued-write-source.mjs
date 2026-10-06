// Candidate diagnostic only. One finite payload, no production holder import.
const encoder = new TextEncoder();
const PAYLOAD_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const CHUNK_COUNT = PAYLOAD_BYTES / CHUNK_BYTES;
const emit = (event, fields = {}) => {
  console.log('V364_QWRITE ' + JSON.stringify({ boundary: 'queued-source', event, wallMs: Date.now(), ...fields }));
};
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/fixture/complete-text' || request.method !== 'POST') return new Response(null, { status: 404 });
    if (request.headers.get('Content-Type') !== 'application/json') return new Response(null, { status: 415 });
    const input = await request.json();
    if (!input || typeof input.attemptNonce !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.attemptNonce)) return new Response(null, { status: 400 });
    const attemptNonce = input.attemptNonce;
    await env.OBSERVATIONS.put(`accepted:${attemptNonce}`, 'one');
    let allocation = null;
    let enqueued = false;
    let cleanupCalls = 0;
    const diagnosticCleanupHook = () => {
      emit('cleanup-hook-invoke', { syntheticOnly: true, businessCleanupProof: false });
      cleanupCalls++;
      // Drop only this local reference. Stream queues/native buffers may retain data.
      // This neither cancels the reader nor writes any KV observation.
      allocation = null;
      emit('cleanup-hook-return', { cleanupCalls, synchronousOnly: true, payloadFreedProven: false });
    };
    emit('signal-initial', { aborted: request.signal.aborted });
    request.signal.addEventListener('abort', () => {
      emit('signal-abort', { aborted: request.signal.aborted });
      diagnosticCleanupHook();
    }, { once: true });
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(': holder-ready\n\n')); },
      async pull(controller) {
        if (enqueued) return;
        let triggered = false;
        // New pre-disconnect admission only; never changes the original cancel poll.
        for (let n = 0; n < 100; n++) {
          if (await env.OBSERVATIONS.get(`queued-trigger:${attemptNonce}`) === 'yes') { triggered = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!triggered) { controller.error(new Error('queued diagnostic trigger absent')); return; }
        enqueued = true;
        allocation = new Uint8Array(PAYLOAD_BYTES);
        allocation.fill(0x78);
        for (let n = 0; n < CHUNK_COUNT; n++) {
          const chunk = allocation.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES);
          chunk.set(encoder.encode('data: '));
          chunk[CHUNK_BYTES - 2] = 10;
          chunk[CHUNK_BYTES - 1] = 10;
          controller.enqueue(chunk);
        }
        emit('queued-enqueue-end', { payloadBytes: PAYLOAD_BYTES, chunkBytes: CHUNK_BYTES, chunkCount: CHUNK_COUNT, desiredSize: controller.desiredSize, streamClosedBySource: false });
        // Do not close: cancel on a closed source is not a comparable callback.
      },
      async cancel() {
        emit('source-cancel-hook-invoke');
        const observation = env.OBSERVATIONS.put(`cancel:${attemptNonce}`, 'observed');
        ctx?.waitUntil(observation);
        await observation;
        emit('source-cancel-hook-fulfilled');
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  },
};
