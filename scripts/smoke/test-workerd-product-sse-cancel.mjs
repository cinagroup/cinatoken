// Linux-only owned transport acceptance. Preparation never starts workerd.
// This does not exercise authentication, database leases, charges, or deployed Workers.
import assert from 'node:assert/strict';
import { builtinModules, createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(repo, 'package.json'));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const prepare = args.includes('--prepare-only');
const execute = args.includes('--execute-linux');
assert.notEqual(prepare, execute, 'choose exactly one of --prepare-only / --execute-linux');
assert.ok(option('--out'), 'provide a fresh, exclusively owned --out directory');
const output = resolve(option('--out'));
assert.equal(existsSync(output), false, 'output must not exist');
const sourceSHA = option('--source-sha');
assert.match(sourceSHA ?? '', /^[a-f0-9]{40}$/, 'provide the checkout --source-sha');
if (process.env.GITHUB_SHA) assert.equal(sourceSHA, process.env.GITHUB_SHA);
if (execute) {
  assert.equal(process.platform, 'linux', 'native workerd is admitted only on Linux');
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'repository .nvmrc requires Node 22');
}
assert.equal(process.env.MINIFLARE_WORKERD_PATH, undefined, 'runtime overrides are not admitted');
mkdirSync(output);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const writeJSON = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const startedAt = new Date().toISOString();
const started = performance.now();
const events = [];
const observations = new Map();
const fatal = [];
const cleanupErrors = [];
const cases = [];
const event = (kind, fields = {}) => {
  const row = { sequence: events.length + 1, kind, wallTime: new Date().toISOString(), elapsedMs: performance.now() - started, ...fields };
  if (events.length >= 6000) throw new Error('diagnostic event bound exceeded');
  events.push(row);
  appendFileSync(join(output, 'events.ndjson'), JSON.stringify(row) + '\n');
  return row;
};
const errorDetails = error => ({ name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error), stack: error?.stack ?? null });
const delay = ms => new Promise(done => setTimeout(done, ms));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' deadline ' + ms + 'ms')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, ms, label) {
  const deadline = performance.now() + ms;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error(label + ' deadline ' + ms + 'ms'); await delay(25); }
  return predicate();
}

// Exact original sources are pinned before and after both phases. The original strict
// tests retain their independent failure; this fixture does not execute or edit them.
const protectedPaths = [
  'packages/proxy/src/services/egress/openai-driver.ts',
  'packages/proxy/src/services/request-deadline.ts',
  'packages/proxy/src/services/text-usage-settlement.ts',
  'packages/proxy/src/services/resource-completion.ts',
  'packages/proxy/src/services/egress/text-sse-cancellation-wire.test.mjs',
  'packages/proxy/scripts/staging/chat-holder-binding-v364.test.mjs',
  'packages/proxy/scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs',
  'scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs',
  'package-lock.json',
];
const pin = path => { const bytes = readFileSync(resolve(repo, path)); return { path, bytes: bytes.length, sha256: sha256(bytes) }; };
const protectedBefore = protectedPaths.map(pin);
const versions = Object.fromEntries(['esbuild', 'miniflare', 'workerd'].map(name => [name, require(name + '/package.json').version]));
assert.equal(versions.miniflare, '5.20260828.0-alpha');
assert.equal(versions.workerd, '1.20260828.1');
const compatibilityDate = '2026-08-28';
const compatibilityFlags = ['nodejs_compat', 'enable_request_signal'];

const workerSource = String.raw`
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
  const response = await fetch(target, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, kind, value, workerWallTime: Date.now() }) });
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
    console.log(JSON.stringify({ fixture:'product-sse-cancel', kind:'worker-entry', caseId, path:url.pathname, method:request.method, signalAvailable:Boolean(request.signal), upstreamBindingPresent:typeof env.UPSTREAM_BASE==='string', observationBindingPresent:typeof env.OBSERVATION_URL==='string' }));
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
`;
writeFileSync(join(output, 'worker-source.mjs'), workerSource, { flag: 'wx' });
const { build } = require('esbuild');
const bundled = await build({
  stdin: { contents: workerSource, resolveDir: repo, sourcefile: 'product-sse-cancel-worker.mjs', loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
  external: [...builtinModules, ...builtinModules.map(name => 'node:' + name)], metafile: true, write: false,
});
assert.equal(bundled.outputFiles.length, 1);
const bundle = bundled.outputFiles[0].contents;
writeFileSync(join(output, 'worker-bundle.mjs'), bundle, { flag: 'wx' });
const bundlePaths = Object.keys(bundled.metafile.inputs).filter(path => path !== 'product-sse-cancel-worker.mjs').sort();
assert.ok(bundlePaths.includes('packages/core/src/index.ts'), 'Wrangler Worker conditions must select Core source');
assert.equal(bundlePaths.some(path => path.startsWith('packages/core/dist/')), false, 'do not bundle Node Core dist');
const bundleInputs = bundlePaths.map(pin);
writeJSON('bundle-metafile.json', bundled.metafile);
const common = {
  schema: 'workerd-product-sse-cancel-v1', sourceSHA, startedAt, node: process.version, platform: process.platform,
  compatibilityDate, compatibilityFlags, versions, protectedBefore, bundleInputs,
  workerSource: { bytes: Buffer.byteLength(workerSource), sha256: sha256(workerSource) },
  bundle: { bytes: bundle.length, sha256: sha256(bundle) },
  scope: { origins: 'owned 127.0.0.1 only', productionRequests: 0, databaseRequests: 0, realIdentity: false, credentials: 'fixed synthetic-only', nativeDriver: 'dispatchOpenAiRoute', databaseLeaseReleaseProven: false, fullG7G8: false, originalStrictResultSuperseded: false },
  limitations: [
    'resourceCompletion confirms the actual driver cleanup channel; it does not prove database lease release, charge settlement, heap reclamation, or graceful workerd exit.',
    'The minimal ReadableStream.cancel probe has its own HTTP RST result; request.signal or product success cannot substitute for its cancel callback.',
    'Pinned runtime and supported compatibility date are fixture inputs; no native C++ cause is inferred.',
    'The outer owned Linux executor must enforce a process-group deadline/fallback if Miniflare disposal does not settle.',
  ],
};
if (prepare) {
  assert.deepEqual(protectedPaths.map(pin), protectedBefore);
  assert.deepEqual(bundlePaths.map(pin), bundleInputs);
  writeJSON('report.json', { ...common, endedAt: new Date().toISOString(), preparationPassed: true, runtimeExecuted: false, cases: [], nativePass: null, sourceUnchanged: true });
  console.log(JSON.stringify({ output, preparationPassed: true, runtimeExecuted: false, nativePass: null, bundleSHA256: sha256(bundle) }));
} else {
  let mf;
  let server;
  let upstream;
  const sockets = new Set();
  const clients = new Set();
  const intervals = new Set();
  let cleanupStarted = false;
  const recordObservation = row => {
    assert.ok(['product', 'minimal'].includes(row.caseId));
    assert.ok(['request-start', 'request-signal-aborted', 'minimal-enqueue-error', 'minimal-source-cancel', 'usage-settled', 'resource-completion-settled'].includes(row.kind));
    const key = row.caseId + ':' + row.kind;
    const records = observations.get(key) ?? [];
    records.push(row); observations.set(key, records);
    event('worker-observation', row);
  };
  const finishCase = async (name, fn) => {
    const result = { name, status: 'RUNNING', beganAt: new Date().toISOString() };
    cases.push(result);
    try { Object.assign(result, await fn()); result.status = 'PASS'; }
    catch (error) { result.status = 'FAIL'; result.error = errorDetails(error); event('case-error', { caseId: name, error: result.error }); }
    finally { result.endedAt = new Date().toISOString(); }
  };
  async function clientRST(url, caseId) {
    assert.equal(url.hostname, '127.0.0.1');
    let response;
    let socket;
    let rst = false;
    let bytes = '';
    const frames = [];
    const body = '{}';
    const first = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const request = httpRequest(url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    const client = { request, get response() { return response; }, get socket() { return socket; } };
    clients.add(client);
    request.once('socket', value => {
      socket = value;
      socket.once('close', hadError => { event('client-socket-close', { caseId, hadError, bytesRead: socket.bytesRead }); closed.resolve(); });
      socket.on('error', error => { event('client-socket-error', { caseId, error: errorDetails(error) }); if (!rst) first.reject(error); });
    });
    request.on('error', error => { event('client-request-error', { caseId, afterRST: rst, error: errorDetails(error) }); if (!rst) first.reject(error); });
    request.setTimeout(8000, () => request.destroy(new Error('client socket idle deadline')));
    request.once('response', value => {
      response = value;
      const contentType = response.headers['content-type'] ?? '';
      const accepted = response.statusCode === 200 && /^text\/event-stream/.test(contentType);
      event('client-response-headers', { caseId, path:url.pathname, method:'POST', status: response.statusCode, statusMessage:response.statusMessage, contentType, contentLength:response.headers['content-length']??null, connection:response.headers.connection??null, accepted });
      if (!accepted) {
        let diagnosticBody = '';
        response.on('data', chunk => { diagnosticBody += chunk.toString('utf8'); if (Buffer.byteLength(diagnosticBody) > 4096) { diagnosticBody = diagnosticBody.slice(0, 4096); first.reject(new Error('non-SSE response body ceiling')); request.destroy(); } });
        response.on('error', error => first.reject(error));
        response.once('end', () => { event('client-non-sse-response', { caseId, status: response.statusCode, contentType, body: diagnosticBody }); first.reject(new Error('expected HTTP 200 SSE; received ' + response.statusCode)); });
        return;
      }
      response.on('error', error => { event('client-response-error', { caseId, afterRST: rst, error: errorDetails(error) }); if (!rst) first.reject(error); });
      response.once('end', () => { if (!rst) first.reject(new Error('SSE ended before RST')); });
      response.on('data', chunk => {
        try {
        bytes += chunk.toString('utf8');
        if (Buffer.byteLength(bytes) > 65536) { first.reject(new Error('client SSE buffer bound')); request.destroy(); return; }
        let boundary;
        while ((boundary = bytes.indexOf('\n\n')) >= 0) {
          const frame = bytes.slice(0, boundary); bytes = bytes.slice(boundary + 2);
          if (!frame.startsWith('data: ')) continue;
          const data = JSON.parse(frame.slice(6));
          const sequence = caseId === 'product' ? Number(data.choices?.[0]?.delta?.content) : data.sequence;
          assert.ok(Number.isInteger(sequence) && sequence > 0, 'actual downstream SSE sequence');
          frames.push(sequence); event('client-sse-frame', { caseId, sequence, count: frames.length });
          if (frames.length === 3) first.resolve();
        }
        } catch (error) { first.reject(error); request.destroy(); }
      });
    });
    request.end(body);
    try {
      await bounded(first.promise, 10000, caseId + ' three SSE frames');
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] ?? '', /^text\/event-stream/);
      assert.deepEqual(frames.slice(0, 3), [1, 2, 3]);
      assert.equal(response.complete, false, 'RST occurs during an unfinished response');
      assert.equal(socket.destroyed, false);
      assert.equal(socket.remoteAddress, '127.0.0.1');
      assert.equal(typeof socket.resetAndDestroy, 'function');
      rst = true;
      event('client-rst-invoke', { caseId, receivedSseFrames: frames.length, responseComplete: response.complete });
      socket.resetAndDestroy();
      await bounded(closed.promise, 3000, caseId + ' client RST socket close');
      return { receivedSseFrames: frames.length, firstSequences: frames.slice(0, 3), rstInvoked: true, clientSocketClosed: true };
    } finally { request.destroy(); response?.destroy(); socket?.destroy(); clients.delete(client); }
  }
  const observation = (name, kind) => observations.get(name + ':' + kind)?.[0];
  try {
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      event('owned-http-request', { path, method:request.method });
      let body = '';
      request.on('error', error => event('owned-request-error', { path, error: errorDetails(error) }));
      response.on('error', error => event('owned-response-error', { path, error: errorDetails(error) }));
      request.on('data', chunk => { body += chunk.toString('utf8'); if (Buffer.byteLength(body) > 65536) request.destroy(); });
      request.on('end', () => {
        try {
          if (path === '/observe' && request.method === 'POST') { recordObservation(JSON.parse(body)); response.writeHead(204); response.end(); return; }
          if (path !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
          assert.equal(upstream, undefined, 'exactly one physical upstream dispatch');
          assert.equal(request.headers.authorization, 'Bearer synthetic-only');
          assert.equal(JSON.parse(body).stream, true);
          const row = upstream = { chunks: 0, closed: false, response, timer: null, closedBeforeCleanup: false, intervalStopped: false, writeErrors: 0 };
          event('upstream-request', { path, bytes: Buffer.byteLength(body), syntheticCredentialMatched: true });
          response.once('close', () => {
            row.closed = true; row.closedBeforeCleanup = !cleanupStarted; row.chunksAtClose = row.chunks;
            clearInterval(row.timer); intervals.delete(row.timer); row.intervalStopped = true;
            event('upstream-response-close', { chunks: row.chunks, beforeCleanup: row.closedBeforeCleanup, intervalStopped: row.intervalStopped });
          });
          request.socket.once('close', hadError => { row.socketClosed = true; row.socketClosedBeforeCleanup = !cleanupStarted; event('upstream-socket-close', { hadError, beforeCleanup: !cleanupStarted, chunks: row.chunks }); });
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); response.flushHeaders();
          row.timer = setInterval(() => {
            if (row.closed) return;
            if (++row.chunks > 400) { clearInterval(row.timer); intervals.delete(row.timer); row.ceilingReached = true; response.destroy(new Error('upstream chunk ceiling')); return; }
            const wire = 'data: ' + JSON.stringify({ id:'synthetic', model:'synthetic', object:'chat.completion.chunk', choices:[{ index:0, delta:{content:String(row.chunks)}, finish_reason:null }] }) + '\n\n';
            response.write(wire, error => { if (error) { row.writeErrors++; event('upstream-write-error', { error: errorDetails(error) }); } });
            event('upstream-chunk', { sequence: row.chunks });
          }, 40); intervals.add(row.timer);
        } catch (error) { fatal.push(errorDetails(error)); event('owned-handler-error', { path, error: errorDetails(error) }); response.writeHead(500); response.end(); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await bounded(new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }), 3000, 'owned provider listen');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require('miniflare');
    class CaptureLog extends Log {
      constructor() { super(LogLevel.DEBUG); }
      log(message) { event('miniflare-log', { message: String(message) }); }
    }
    mf = new Miniflare(convertV4MiniflareOptions({ modules:true, script:Buffer.from(bundle).toString('utf8'), compatibilityDate, compatibilityFlags, cf:false, host:'127.0.0.1', port:0, log:new CaptureLog(), bindings:{UPSTREAM_BASE:origin+'/v1', OBSERVATION_URL:origin+'/observe'}, handleStructuredLogs(log) { event('workerd-log', { timestamp:log.timestamp, level:log.level, message:String(log.message) }); } }));
    const ingress = await bounded(mf.ready, 15000, 'Miniflare ordinary HTTP ingress ready');
    assert.equal(ingress.hostname, '127.0.0.1');
    assert.equal(ingress.protocol, 'http:');
    event('owned-runtime-ready', { ingress: ingress.origin, upstreamOrigin: origin, directSocketBypass: false });
    const warm = await bounded(fetch(new URL('/fixture/warmup', ingress), { signal: AbortSignal.timeout(5000) }), 6000, 'HTTP warmup');
    assert.equal(warm.status, 200); assert.equal(await bounded(warm.text(), 2000, 'warmup body'), 'owned-worker-ready');
    event('warmup-complete', { nativeHTTPWorkerExecuted: true });
    await finishCase('product', async () => {
      const client = await clientRST(new URL('/fixture/product-sse', ingress), 'product');
      await until(() => upstream?.closed && upstream?.socketClosed, 5000, 'physical upstream response and socket close');
      assert.equal(upstream.closedBeforeCleanup, true);
      assert.equal(upstream.socketClosedBeforeCleanup, true);
      assert.equal(upstream.ceilingReached, undefined, 'upstream is stopped by RST propagation, not its safety ceiling');
      assert.equal(upstream.intervalStopped, true);
      const stoppedAt = upstream.chunks;
      await delay(300);
      assert.equal(upstream.chunks, stoppedAt, 'no subsequent upstream chunks after physical close');
      await until(() => observation('product', 'usage-settled') && observation('product', 'resource-completion-settled') && observation('product', 'request-signal-aborted'), 5000, 'actual request signal, usage and resource settlement');
      assert.equal(observation('product', 'request-signal-aborted').value.aborted, true);
      const usage = observation('product', 'usage-settled').value;
      const completion = observation('product', 'resource-completion-settled').value;
      assert.equal(usage.usage.cancelled, true, 'actual usage contract records downstream cancellation');
      assert.equal(usage.costUnknown, true, 'actual settlement helper preserves unknown cancelled cost');
      assert.equal(usage.usage.raw_usage, null, 'upstream emitted no authoritative usage frame');
      assert.equal(usage.usage.total_tokens, 0);
      assert.equal(completion.outcome, 'confirmed', 'actual driver cleanup promise confirms its registered work');
      assert.equal(observations.get('product:usage-settled').length, 1);
      assert.equal(observations.get('product:resource-completion-settled').length, 1);
      return { ...client, upstreamSocketClosed:true, upstreamChunkIntervalStopped:true, chunksAtClose:stoppedAt, stoppedObservationMs:300, usage:usage.usage, costUnknown:usage.costUnknown, resourceCompletion:completion.outcome, requestSignalAbortedObserved:Boolean(observation('product','request-signal-aborted')), databaseLeaseReleaseProven:false };
    });
    await finishCase('minimal', async () => {
      const client = await clientRST(new URL('/fixture/minimal-readable', ingress), 'minimal');
      await until(() => observation('minimal', 'minimal-source-cancel'), 5000, 'native minimal ReadableStream.cancel callback');
      const cancel = observation('minimal', 'minimal-source-cancel').value;
      assert.equal(cancel.stopped, true);
      assert.ok(cancel.chunks >= 3);
      assert.equal(observations.get('minimal:minimal-source-cancel').length, 1);
      assert.equal(observation('minimal', 'minimal-enqueue-error'), undefined, 'enqueue failure is not source.cancel confirmation');
      return { ...client, sourceCancelObserved:true, sourceCancelValue:cancel, requestSignalAbortedObserved:Boolean(observation('minimal','request-signal-aborted')), productSignalDoesNotSubstitute:true };
    });
  } catch (error) { fatal.push(errorDetails(error)); event('runtime-error', { error:errorDetails(error) }); }
  finally {
    cleanupStarted = true; event('cleanup-start');
    for (const client of clients) { client.request.destroy(); client.response?.destroy(); client.socket?.destroy(); } clients.clear();
    for (const timer of intervals) clearInterval(timer); intervals.clear();
    if (mf) {
      try { await bounded(mf.dispose(), 10000, 'Miniflare disposal'); event('miniflare-dispose-settled', { gracefulWorkerdExitProven:false }); }
      catch (error) { cleanupErrors.push({ resource:'miniflare', error:errorDetails(error) }); }
    }
    if (server) {
      try { await bounded(new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); for (const socket of sockets) socket.destroy(); }), 3000, 'owned HTTP server close'); }
      catch (error) { cleanupErrors.push({ resource:'owned-http-server', error:errorDetails(error) }); }
    }
    await delay(20);
    if (sockets.size) cleanupErrors.push({ resource:'owned-http-sockets', remaining:sockets.size });
    let sourcePinsVerified = false;
    try { assert.deepEqual(protectedPaths.map(pin), protectedBefore); assert.deepEqual(bundlePaths.map(pin), bundleInputs); sourcePinsVerified = true; }
    catch (error) { fatal.push(errorDetails(error)); }
    const passed = cases.length === 2 && cases.every(row => row.status === 'PASS') && !fatal.length && !cleanupErrors.length;
    event('fixture-closed', { passed, ownedSockets:sockets.size, activeIntervals:intervals.size, activeClients:clients.size });
    writeJSON('report.json', { ...common, endedAt:new Date().toISOString(), preparationPassed:true, runtimeExecuted:true, nativePass:passed, intendedExitCode:passed?0:1, cases, fatal, cleanupErrors, sourceUnchanged:sourcePinsVerified, cleanup:{ownedSockets:sockets.size, activeIntervals:intervals.size, activeClients:clients.size, miniflareDisposeFulfilled:events.some(row=>row.kind==='miniflare-dispose-settled'), gracefulWorkerdExitProven:false}, events:{count:events.length, bytes:readFileSync(join(output,'events.ndjson')).length, sha256:sha256(readFileSync(join(output,'events.ndjson')))} });
    console.log(JSON.stringify({ output, runtimeExecuted:true, nativePass:passed, cases:cases.map(row=>({name:row.name,status:row.status})), intendedExitCode:passed?0:1 }));
    process.exitCode = passed ? 0 : 1;
  }
}
