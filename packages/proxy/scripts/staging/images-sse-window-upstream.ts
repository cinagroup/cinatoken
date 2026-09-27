/// <reference path="./images-upstream-env.d.ts" />
import { createHash } from 'node:crypto';
import legacy, { UPSTREAM_ORIGIN, SYNTHETIC_PROVIDER_MARKER } from './images-upstream';
import { IMAGE_SSE_PATH, parseImageSseProbe } from './images-sse-probe-contract';
import { imageSseProbeResponse } from './images-sse-probe';
import { imageSseWindowProbeResponse } from './images-sse-window-probe';

/** Independent completed-window entry; legacy/non-window profiles remain unchanged.
 * Only success and hold select the fixed completed-window producer; no request-supplied timing. */
export default {
  async fetch(request: Request, env: ImagesUpstreamEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== UPSTREAM_ORIGIN || url.search || url.hash || url.username || url.password) return new Response(null, { status: 404 });
    if (url.pathname !== IMAGE_SSE_PATH) return legacy.fetch(request, env, context);
    if (request.method !== 'POST') return new Response(null, { status: 404 });
    const declared = request.headers.get('Content-Length');
    // Non-secret fixture marker, not authentication. Only the service binding may reach this Worker.
    if (request.headers.get('Authorization') !== `Bearer ${SYNTHETIC_PROVIDER_MARKER}`
      || !/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('Content-Type') ?? '')
      || !declared || !/^\d{1,4}$/.test(declared) || Number(declared) < 1) return new Response(null, { status: 422 });
    if (Number(declared) > 4096) return new Response(null, { status: 413 });
    if (!request.body) return new Response(null, { status: 422 });
    const reader = request.body.getReader(), bytes = new Uint8Array(4096);
    let size = 0, stopped = false, cancellation = Promise.resolve();
    const cancel = () => { stopped = true; cancellation = reader.cancel().catch(() => undefined); };
    const timer = setTimeout(cancel, 10000);
    request.signal.addEventListener('abort', cancel, { once: true });
    try {
      if (request.signal.aborted) cancel();
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        if (size + next.value.byteLength > bytes.length) return new Response(null, { status: 413 });
        bytes.set(next.value, size); size += next.value.byteLength;
      }
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', cancel);
      await cancellation; await reader.cancel().catch(() => undefined); reader.releaseLock();
    }
    if (stopped) return new Response(null, { status: 408 });
    if (size !== Number(declared)) return new Response(null, { status: 422 });
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size))); }
    catch { return new Response(null, { status: 422 }); }
    if (!body || typeof body !== 'object' || !('stream' in body) || body.stream !== true || !('prompt' in body)) return new Response(null, { status: 422 });
    const probe = parseImageSseProbe(body.prompt);
    if (!probe) return new Response(null, { status: 422 });
    const receipt = `c02-sse-${probe.probeId}-${createHash('sha256').update(bytes.subarray(0, size)).digest('hex')}`;
    const createResponse = probe.mode === 'success' || probe.mode === 'hold' ? imageSseWindowProbeResponse : imageSseProbeResponse;
    const response = createResponse({ probe, request, db: env.PROBE_DB, context, receipt });
    // Own the initial CAS even if the caller disconnects before response headers.
    context.waitUntil(response.then(() => undefined));
    return response;
  },
} satisfies ExportedHandler<ImagesUpstreamEnv>;
