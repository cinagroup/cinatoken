// Owned diagnostic only: no Service Binding and no holder import.
// The SSE source matches the frozen holder's async KV/timer pull and cancel lifetime.
const encoder = new TextEncoder();
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/fixture/complete-text' || request.method !== 'POST') return new Response(null, { status: 404 });
    if (request.headers.get('Content-Type') !== 'application/json') return new Response(null, { status: 415 });
    const input = await request.json();
    if (!input || typeof input.attemptNonce !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.attemptNonce)) return new Response(null, { status: 400 });
    const attemptNonce = input.attemptNonce;
    await env.OBSERVATIONS.put(`accepted:${attemptNonce}`, 'one');
    let phase = 0;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(': holder-ready\n\n')); },
      async pull(controller) {
        if (phase !== 0) return;
        phase = 1;
        for (let n = 0; n < 300; n++) {
          if (await env.OBSERVATIONS.get(`release:${attemptNonce}`) === 'yes') {
            controller.enqueue(encoder.encode('data: {"text":"synthetic streamed answer"}\n\ndata: [DONE]\n\n'));
            controller.close();
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        controller.error(new Error('synthetic stream release timed out'));
      },
      async cancel() {
        const observation = env.OBSERVATIONS.put(`cancel:${attemptNonce}`, 'observed');
        ctx?.waitUntil(observation);
        await observation;
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  },
};
