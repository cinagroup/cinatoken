
import { dispatchOpenAiRoute } from './packages/proxy/src/services/egress/openai-driver.ts';
import { hasAuthoritativeTextUsage, textUsageCostIsUnknown } from './packages/proxy/src/services/text-usage-settlement.ts';
const streamPath = '/fixture/product-sse';
const minimalPath = '/fixture/minimal-readable';
function localURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw Error('owned loopback only');
  return url;
}
async function observe(env, caseId, kind, value) {
  const target = localURL(env.OBSERVATION_URL);
  const response = await fetch(target, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, kind, value, workerWallTime: Date.now() }) });
  if (response.status !== 204) throw Error('observation was not recorded');
  await response.body?.cancel();
}
function route(base) {
  return { targetId:'synthetic', providerId:'synthetic', providerName:'synthetic', providerModelName:'synthetic', gatewayModelId:'public/synthetic', upstreamProtocol:'openai', upstreamOperation:'chat', adapter:'passthrough', providerEndpoints:{openai:{base}}, providerApiKey:'synthetic-only', customParams:null, routeGroup:'default', routePriority:0, routeWeight:1 };
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture/warmup' && request.method === 'GET') return new Response('owned-worker-ready');
    if (request.method !== 'POST' || ![streamPath, minimalPath].includes(url.pathname)) return new Response(null, { status: 404 });
    const caseId = url.pathname === streamPath ? 'product' : 'minimal';
    request.signal.addEventListener('abort', () => { ctx.waitUntil(observe(env, caseId, 'request-signal-aborted', { aborted: request.signal.aborted })); }, { once: true });
    await observe(env, caseId, 'request-start', { signalInitiallyAborted: request.signal.aborted });
    if (caseId === 'minimal') {
      let timer;
      let chunks = 0;
      let stopped = false;
      const body = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            if (stopped) return;
            if (++chunks > 400) { stopped = true; clearInterval(timer); controller.error(Error('minimal stream ceiling')); return; }
            try { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ minimal: true, sequence: chunks }) + '\n\n')); }
            catch (error) { stopped = true; clearInterval(timer); ctx.waitUntil(observe(env, caseId, 'minimal-enqueue-error', { chunks, message: String(error.message) })); }
          }, 40);
        },
        cancel() {
          stopped = true;
          clearInterval(timer);
          return observe(env, caseId, 'minimal-source-cancel', { chunks, stopped: true });
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    }
    const upstream = localURL(env.UPSTREAM_BASE);
    const result = await dispatchOpenAiRoute(route(upstream.href), { stream: true }, request.signal);
    if (!result.resourceCompletion || typeof result.resourceCompletion.then !== 'function') throw Error('real driver resourceCompletion missing');
    const usageTask = result.usagePromise.then(usage => observe(env, caseId, 'usage-settled', {
      usage,
      costUnknown: textUsageCostIsUnknown({ upstreamResponseOk: result.response.ok, usageAvailable: hasAuthoritativeTextUsage(usage), cancelled: usage.cancelled === true, streamError: Boolean(usage.stream_error), upstreamOutcomeUnknown: result.meta?.upstreamOutcomeUnknown === true, responseBodyTooLarge: result.meta?.responseBodyTooLarge === true }),
    }));
    const resourceTask = result.resourceCompletion.then(outcome => observe(env, caseId, 'resource-completion-settled', { outcome }));
    ctx.waitUntil(Promise.all([usageTask, resourceTask]).catch(error => { console.error(JSON.stringify({ fixture:'product-sse-cancel', kind:'observer-failed', caseId, message:String(error.message) })); throw error; }));
    return result.response;
  },
};
