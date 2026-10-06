import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const repo = resolve(arg('--repo') ?? process.cwd());
const output = resolve(arg('--out') ?? join(here, 'prepared'));
const execute = process.argv.includes('--execute-linux');
const source = join(repo, 'packages/proxy/scripts/staging');
const require = createRequire(join(repo, 'package.json'));
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require('miniflare');
const expected = { workerd: '1.20260828.1', miniflare: '5.20260828.0-alpha', wrangler: '4.127.1' };
const versions = Object.fromEntries(Object.keys(expected).map(name => [name, require(`${name}/package.json`).version]));
assert.deepEqual(versions, expected);
assert.equal(process.env.MINIFLARE_WORKERD_PATH, undefined, 'no runtime override');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [
  'packages/proxy/scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs',
  'packages/proxy/scripts/staging/chat-holder-binding-v364.node.test.mjs',
  'packages/proxy/scripts/staging/chat-holder-gateway-v364.ts',
  'packages/proxy/scripts/staging/chat-holder-private-v364.ts',
  'packages/proxy/scripts/staging/chat-holder-synthetic-v364.ts',
  'packages/proxy/scripts/staging/wrangler.chat-holder-gateway-v364.jsonc',
  'packages/proxy/scripts/staging/wrangler.chat-holder-private-v364.jsonc',
  'package-lock.json', '.nvmrc', '.github/workflows/proxy-dispatch-safety.yml',
];
const snapshot = () => files.map(path => { const b = readFileSync(join(repo, path)); return { path, bytes: b.length, sha256: sha(b) }; });
const inputsBefore = snapshot();
const sealedInputs = JSON.parse(readFileSync(join(here, 'source-inputs.json'), 'utf8'));
assert.deepEqual(inputsBefore, sealedInputs, 'exact reviewed source/config/lock/workflow bytes');
const gatewayConfig = JSON.parse(readFileSync(join(source, files[5].split('/').at(-1)), 'utf8'));
const holderConfig = JSON.parse(readFileSync(join(source, files[6].split('/').at(-1)), 'utf8'));
for (const config of [gatewayConfig, holderConfig]) {
  assert.deepEqual(config.compatibility_flags, ['nodejs_compat', 'enable_request_signal']);
  assert.equal(config.compatibility_date, '2026-09-25');
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []); assert.deepEqual(config.triggers, { crons: [] });
}
assert.deepEqual(gatewayConfig.services, [{ binding: 'TEXT_HOLDER', service: holderConfig.name, remote: false }]);
assert.deepEqual(holderConfig.kv_namespaces.map(v => v.binding), ['OBSERVATIONS']);
assert.equal(holderConfig.services, undefined);
async function bundle(path, wrapper) {
  const opts = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false };
  if (wrapper) {
    const text = readFileSync(join(here, wrapper), 'utf8').replace('__ORIGINAL__', join(source, path).replaceAll('\\', '/'));
    opts.stdin = { contents: text, resolveDir: source, sourcefile: wrapper, loader: 'js' };
  } else opts.entryPoints = [join(source, path)];
  const result = await build(opts); assert.equal(result.outputFiles.length, 1); return result.outputFiles[0].text;
}
const bundles = {
  gateway: await bundle(gatewayConfig.main), holder: await bundle(holderConfig.main),
  observedGateway: await bundle(gatewayConfig.main, 'gateway-observer.mjs'),
  observedHolder: await bundle(holderConfig.main, 'holder-observer.mjs'),
};
const syntheticBuilt = await build({ entryPoints: [join(source, 'chat-holder-synthetic-v364.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
const synthetic = await import('data:text/javascript;base64,' + Buffer.from(syntheticBuilt.outputFiles[0].text).toString('base64'));
const { SYNTHETIC_CREDENTIAL_V364, SYNTHETIC_PROVIDER_URL_V364, SYNTHETIC_PUBLIC_BODY_V364, SYNTHETIC_QUOTE_V364, SYNTHETIC_ROUTE_V364 } = synthetic;
for (const name of ['gateway', 'observedGateway']) {
  assert.equal(bundles[name].includes(SYNTHETIC_CREDENTIAL_V364), false);
  assert.equal(bundles[name].includes(SYNTHETIC_PROVIDER_URL_V364), false);
}
for (const name of ['holder', 'observedHolder']) {
  assert.equal(bundles[name].includes(SYNTHETIC_CREDENTIAL_V364), true);
  assert.equal(bundles[name].includes(SYNTHETIC_PROVIDER_URL_V364), true);
}
const envelope = () => ({ requestId: SYNTHETIC_QUOTE_V364.requestId, quoteId: SYNTHETIC_QUOTE_V364.quoteId,
  attemptNonce: randomUUID(), candidateIndex: SYNTHETIC_ROUTE_V364.candidateIndex,
  routeTargetId: SYNTHETIC_ROUTE_V364.targetId, finalBodyUtf8: SYNTHETIC_PUBLIC_BODY_V364 });
mkdirSync(output, { recursive: true });
const bundleHashes = Object.entries(bundles).map(([name, text]) => ({ name, bytes: Buffer.byteLength(text), sha256: sha(text) }));
if (!execute) {
  assert.deepEqual(snapshot(), inputsBefore);
  writeFileSync(join(output, 'prepare-only.json'), JSON.stringify({ schema: 'v364-linux-diagnostic-prepare-v1', actualExit: 0,
    runtimeExecuted: false, versions, runtimeCompatibilityDate: '2026-09-04', frozenConfigDate: '2026-09-25',
    sourceUnchanged: true, inputsBefore, bundleHashes, productionRequests: 0, ciInvocations: 0 }, null, 2) + '\n');
  console.log(JSON.stringify({ actualExit: 0, runtimeExecuted: false, output }));
  process.exit(0);
}
assert.equal(process.platform, 'linux', 'owned Linux only');
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'use repository .nvmrc major 22');
const startedAt = new Date().toISOString();
const start = performance.now();
const events = [];
const results = [];
const active = new Set();
const errorSafe = error => ({ name: error?.name, code: error?.code, message: String(error?.message ?? error).replaceAll(SYNTHETIC_CREDENTIAL_V364, '[synthetic-redacted]').replaceAll(SYNTHETIC_PROVIDER_URL_V364, '[synthetic-redacted]') });
const event = (caseId, kind, fields = {}) => { if (events.length >= 15000) throw new Error('diagnostic event cap exceeded'); events.push({ caseId, kind, hostMs: performance.now() - start, wallMs: Date.now(), ...fields }); };
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function bounded(task, ms, label) {
  let timer; try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
class CaptureLog extends Log { constructor(caseId) { super(LogLevel.DEBUG); this.caseId = caseId; } log(message) { event(this.caseId, 'miniflare-log', { message: String(message) }); } }
async function fixture(caseId, observed, signalPassthrough = false) {
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0,
    log: new CaptureLog(caseId),
    handleStructuredLogs(log) { event(caseId, 'workerd-log', { timestamp: log.timestamp, level: log.level, message: String(log.message).replaceAll(SYNTHETIC_CREDENTIAL_V364, '[synthetic-redacted]').replaceAll(SYNTHETIC_PROVIDER_URL_V364, '[synthetic-redacted]') }); },
    workers: [{ name: gatewayConfig.name, modules: true, script: observed ? bundles.observedGateway : bundles.gateway,
      compatibilityDate: '2026-09-04', compatibilityFlags: signalPassthrough ? [...gatewayConfig.compatibility_flags, 'request_signal_passthrough'] : gatewayConfig.compatibility_flags,
      serviceBindings: { TEXT_HOLDER: holderConfig.name } },
    { name: holderConfig.name, modules: true, script: observed ? bundles.observedHolder : bundles.holder,
      compatibilityDate: '2026-09-04', compatibilityFlags: holderConfig.compatibility_flags,
      kvNamespaces: { OBSERVATIONS: holderConfig.kv_namespaces[0].id } }],
  }));
  active.add(mf);
  assert.deepEqual(Object.keys(await mf.getBindings(gatewayConfig.name)), ['TEXT_HOLDER']);
  const { OBSERVATIONS } = await mf.getBindings(holderConfig.name); assert.ok(OBSERVATIONS);
  const url = new URL('/fixture/complete-text', await mf.ready); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  return { mf, observations: OBSERVATIONS, url };
}
function httpClient(caseId, url, body, mode) {
  assert.equal(url.hostname, '127.0.0.1');
  return new Promise((resolveClient, reject) => {
    let response; let socket;
    const request = httpRequest(url, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    request.on('error', error => { event(caseId, 'request-error', errorSafe(error)); reject(error); });
    request.once('close', () => event(caseId, 'request-close', { destroyed: request.destroyed }));
    request.once('socket', value => {
      socket = value;
      for (const type of ['connect', 'end', 'close', 'error', 'timeout']) socket.on(type, data => event(caseId, 'socket-' + type,
        type === 'error' ? errorSafe(data) : { hadError: typeof data === 'boolean' ? data : undefined, destroyed: socket.destroyed, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten }));
    });
    request.setTimeout(10000, () => request.destroy(new Error('fixture HTTP socket timed out')));
    request.once('response', value => {
      response = value;
      for (const type of ['aborted', 'close', 'end', 'error']) response.on(type, data => event(caseId, 'response-' + type, type === 'error' ? errorSafe(data) : { complete: response.complete, destroyed: response.destroyed }));
      response.on('error', reject);
      let first = Buffer.alloc(0);
      const onData = chunk => {
        first = Buffer.concat([first, chunk]);
        if (first.length > 128) { request.destroy(); response.destroy(); reject(new Error('first SSE frame exceeded bound')); return; }
        if (!first.includes('\n\n')) return;
        response.pause(); response.removeListener('data', onData);
        event(caseId, 'first-frame', { bytes: first.length });
        resolveClient({ status: response.statusCode, contentType: response.headers['content-type'], first,
          async cancel() {
            event(caseId, 'client-cancel-invoke', { mode });
            if (!response.closed) {
              const closed = new Promise(resolveClosed => response.once('close', resolveClosed));
              if (mode === 'rst') { assert.equal(typeof socket.resetAndDestroy, 'function'); assert.equal(socket.remoteAddress, '127.0.0.1'); socket.resetAndDestroy(); }
              request.destroy(); response.destroy();
              await bounded(closed, 10000, 'client response close');
            }
            const result = { requestDestroyed: request.destroyed, responseDestroyed: response.destroyed, responseComplete: response.complete };
            event(caseId, 'client-cancel-settled', result); return result;
          }, cleanup() { request.destroy(); response?.destroy(); },
        });
      };
      response.on('data', onData);
      response.once('end', () => reject(new Error('response ended before first frame')));
    });
    request.end(body);
  });
}
async function readerClient(caseId, url, body) {
  assert.equal(url.hostname, '127.0.0.1');
  const controller = new AbortController();
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
  const reader = response.body.getReader();
  reader.closed.then(() => event(caseId, 'reader-closed-fulfilled'), error => event(caseId, 'reader-closed-rejected', errorSafe(error)));
  let first = Buffer.alloc(0);
  while (!first.includes('\n\n')) { const part = await reader.read(); assert.equal(part.done, false); first = Buffer.concat([first, part.value]); assert.ok(first.length <= 128); }
  event(caseId, 'first-frame', { bytes: first.length });
  return { status: response.status, contentType: response.headers.get('Content-Type'), first,
    async cancel() { event(caseId, 'client-cancel-invoke', { mode: 'reader-cancel' }); await reader.cancel('synthetic client cancel'); event(caseId, 'client-cancel-settled'); return { readerCancelled: true }; },
    cleanup() { controller.abort(); },
  };
}
async function observedGet(caseId, observations, key, n, phase) {
  event(caseId, 'observer-kv-get-invoke', { category: key.split(':', 1)[0], poll: n, phase });
  const value = await observations.get(key);
  event(caseId, 'observer-kv-get-settled', { category: key.split(':', 1)[0], poll: n, phase, value });
  return value;
}
async function cancellationCase(caseId, observed, mode, signalPassthrough = false) {
  let f; let client;
  const result = { caseId, observed, mode, signalPassthrough, baselineEligible: !signalPassthrough, originalWindow: null, tail: null, actualExit: 1, closed: false };
  try {
    f = await fixture(caseId, observed, signalPassthrough); const e = envelope(); const body = JSON.stringify(e);
    client = await bounded(mode === 'reader-cancel' ? readerClient(caseId, f.url, body) : httpClient(caseId, f.url, body, mode), 10000, 'first frame');
    assert.equal(client.status, 200); assert.equal(client.contentType, 'text/event-stream');
    assert.equal(await observedGet(caseId, f.observations, `accepted:${e.attemptNonce}`, 0, 'before'), 'one');
    assert.equal(client.first.toString(), ': holder-ready\n\n');
    const cancelled = await bounded(client.cancel(), 10000, 'cancel');
    if (mode !== 'reader-cancel') assert.deepEqual(cancelled, { requestDestroyed: true, responseDestroyed: true, responseComplete: false });
    const pollStart = performance.now(); let value = null; let count = 0;
    // Exact original poll count, sleep, and expected value. Elapsed time is measured, not assumed 1s.
    for (let n = 0; n < 100 && value === null; n++) { value = await observedGet(caseId, f.observations, `cancel:${e.attemptNonce}`, n, 'original'); count++; if (value === null) await delay(10); }
    result.originalWindow = { pollCount: count, sleepMs: 10, elapsedMs: performance.now() - pollStart, actual: value, expected: 'observed', actualExit: value === 'observed' ? 0 : 1 };
    try { assert.equal(value, 'observed'); } catch (error) { result.strictFailure = errorSafe(error); }
    assert.equal(await observedGet(caseId, f.observations, `release:${e.attemptNonce}`, 0, 'after'), null);
    assert.equal(await observedGet(caseId, f.observations, `accepted:${e.attemptNonce}`, 0, 'after'), 'one');
    // Separate observational tail cannot overwrite originalWindow or turn a failure into success.
    const tailStart = performance.now(); let tailCount = 0;
    while (value === null && performance.now() - tailStart < 4000) { value = await observedGet(caseId, f.observations, `cancel:${e.attemptNonce}`, tailCount++, 'diagnostic-tail'); if (value === null) await delay(50); }
    result.tail = { elapsedMs: performance.now() - tailStart, reads: tailCount, actual: value, usedForPass: false };
    result.actualExit = result.originalWindow.actualExit;
  } catch (error) { result.error = errorSafe(error); }
  finally {
    client?.cleanup();
    if (f) { await bounded(f.mf.dispose(), 10000, 'Miniflare dispose'); active.delete(f.mf); result.closed = true; }
    event(caseId, 'case-closed', { actualExit: result.actualExit, closed: result.closed }); results.push(result);
  }
}
async function calibration(mode) {
  const caseId = 'node-http-calibration-' + mode;
  let requestCount = 0; let received = ''; let client;
  const body = JSON.stringify(envelope());
  let peerClose;
  const closed = new Promise(resolveClose => { peerClose = resolveClose; });
  const server = createServer((request, response) => {
    requestCount++; request.setEncoding('utf8'); request.on('data', chunk => { received += chunk; });
    request.socket.on('error', error => event(caseId, 'server-socket-error', errorSafe(error)));
    request.socket.on('end', () => event(caseId, 'server-socket-end'));
    request.socket.on('close', hadError => event(caseId, 'server-socket-close', { hadError }));
    response.on('error', error => event(caseId, 'server-response-error', errorSafe(error)));
    request.on('end', () => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': holder-ready\n\n'); });
    response.once('close', () => { event(caseId, 'server-response-close', { writableFinished: response.writableFinished }); peerClose(); });
  });
  const result = { caseId, mode, actualExit: 1, closed: false };
  try {
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const url = new URL(`http://127.0.0.1:${server.address().port}/fixture/complete-text`);
    client = await bounded(mode === 'reader-cancel' ? readerClient(caseId, url, body) : httpClient(caseId, url, body, mode), 10000, 'calibration first frame');
    assert.equal(client.status, 200); assert.equal(client.contentType, 'text/event-stream'); assert.equal(client.first.toString(), ': holder-ready\n\n');
    const cancellation = await bounded(client.cancel(), 10000, 'calibration cancel');
    if (mode !== 'reader-cancel') assert.deepEqual(cancellation, { requestDestroyed: true, responseDestroyed: true, responseComplete: false });
    await bounded(closed, 10000, 'server peer close'); assert.equal(requestCount, 1); assert.equal(received, body);
    result.actualExit = 0;
  } catch (error) { result.error = errorSafe(error); }
  finally { client?.cleanup(); server.closeAllConnections(); await bounded(new Promise(resolveClose => server.close(resolveClose)), 10000, 'server dispose'); result.closed = true; results.push(result); }
}
async function strictBaseline() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: 'true', NO_COLOR: '1' };
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), '--test', 'scripts/staging/chat-holder-binding-v364.node.test.mjs', 'scripts/staging/chat-holder-binding-v364-http-cancel-successor.test.mjs'], { cwd: join(repo, 'packages/proxy'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 90000);
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  let spawnError;
  child.on('error', error => { spawnError = errorSafe(error); });
  const [code, signal] = await new Promise(resolveClose => child.once('close', (...args) => resolveClose(args)));
  clearTimeout(timer);
  writeFileSync(join(output, 'original-strict.stdout.txt'), stdout); writeFileSync(join(output, 'original-strict.stderr.txt'), stderr);
  return { code, signal, timedOut, spawnError, stdout: { bytes: Buffer.byteLength(stdout), sha256: sha(stdout) }, stderr: { bytes: Buffer.byteLength(stderr), sha256: sha(stderr) } };
}
let baseline; let fatal;
try {
  baseline = await strictBaseline();
  for (const mode of ['destroy', 'rst', 'reader-cancel']) await bounded(calibration(mode), 15000, 'calibration case');
  await bounded(cancellationCase('locked-uninstrumented-destroy', false, 'destroy'), 30000, 'original transport case');
  await bounded(cancellationCase('locked-observed-destroy', true, 'destroy'), 30000, 'observed original transport case');
  await bounded(cancellationCase('locked-observed-rst', true, 'rst'), 30000, 'observed RST case');
  await bounded(cancellationCase('locked-observed-reader-cancel', true, 'reader-cancel'), 30000, 'observed reader case');
  await bounded(cancellationCase('locked-observed-destroy-passthrough-variant', true, 'destroy', true), 30000, 'isolated passthrough variant');
} catch (error) { fatal = errorSafe(error); }
finally {
  for (const mf of active) { try { await bounded(mf.dispose(), 10000, 'final Miniflare dispose'); active.delete(mf); } catch (error) { event('finally', 'dispose-error', errorSafe(error)); } }
  const inputsAfter = snapshot(); const sourceUnchanged = JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter);
  const eventsText = JSON.stringify(events, null, 2) + '\n'; writeFileSync(join(output, 'events.json'), eventsText);
  const actualExit = !fatal && baseline?.code === 0 && results.length === 8 && results.every(v => v.actualExit === 0 && v.closed) && active.size === 0 && sourceUnchanged ? 0 : 1;
  const report = { schema: 'v364-owned-linux-diagnostic-closed-v1', startedAt, endedAt: new Date().toISOString(), elapsedMs: performance.now() - start,
    actualExit, outcome: actualExit === 0 ? 'STRICT_SYNTHETIC_ONLY_PASS' : 'STRICT_FAILURE_PRESERVED', baseline, results, fatal, versions,
    runtimeCompatibilityDate: '2026-09-04', frozenConfigDate: '2026-09-25', sourceUnchanged, inputsBefore, inputsAfter, bundleHashes,
    activeMiniflare: active.size, events: { bytes: Buffer.byteLength(eventsText), sha256: sha(eventsText), count: events.length },
    productionRequests: 0, realIdentity: false, defaultOffHolderChanged: false, dependencyChanged: false,
    causeProven: false, lateObservationUpgradesPass: false, upstreamPatchApplied: false };
  writeFileSync(join(output, 'closed-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ actualExit, outcome: report.outcome, output, sourceUnchanged, activeMiniflare: active.size })); process.exitCode = actualExit;
}
