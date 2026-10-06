import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const repo = 'C:/cinagroup/cinatoken';
const legacy = `${repo}/scripts/diagnostics/v364-owned-linux`;
const target = `${repo}/scripts/diagnostics/v364-owned-linux-boundary/run-boundary.mjs`;
let text = readFileSync(`${legacy}/run-v364-owned-diagnostic.mjs`, 'utf8');
function replace(before, after) { assert.equal(text.split(before).length, 2, before.slice(0, 100)); text = text.replace(before, after); }
function section(start, end, after) { const a = text.indexOf(start); const b = text.indexOf(end, a); assert.ok(a >= 0 && b > a); text = text.slice(0, a) + after + text.slice(b); }
replace("import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';", "import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';");
replace("import { spawn } from 'node:child_process';", "import { spawn, execFileSync } from 'node:child_process';\nimport { processCensus } from './proc-census.mjs';");
replace("const here = dirname(fileURLToPath(import.meta.url));", "const here = dirname(fileURLToPath(import.meta.url));\nconst legacy = join(here, '..', 'v364-owned-linux');");
replace("'v364-owned-linux-executor-start-v1'", "'v364-owned-linux-boundary-executor-start-v1'");
section('const files = [', 'const gatewayConfig =', `const sealedInputs = JSON.parse(readFileSync(join(here, 'source-inputs.json'), 'utf8'));
assert.equal(sealedInputs.schema, 'v364-boundary-source-inputs-v1');
const files = sealedInputs.files.map(v => v.path);
const snapshot = () => files.map(path => { const b = readFileSync(join(repo, path)); return { path, bytes: b.length, sha256: sha(b) }; });
const inputsBefore = snapshot();
assert.deepEqual(inputsBefore, sealedInputs.files, 'exact frozen source/config/lock/legacy package and real prior evidence bytes');
const checkoutSHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
for (const item of inputsBefore) {
  const blob = execFileSync('git', ['show', 'HEAD:' + item.path], { cwd: repo });
  assert.equal(blob.length, item.bytes); assert.equal(sha(blob), item.sha256, 'working tree must match checkout Git bytes');
}
if (execute) assert.equal(executorReceipt.checkoutSHA, checkoutSHA);
const priorAnalysis = JSON.parse(readFileSync(join(repo, sealedInputs.priorAnalysisPath), 'utf8'));
const priorExecutor = JSON.parse(readFileSync(join(repo, sealedInputs.priorArtifactRoot, 'executor.closed.json'), 'utf8'));
const priorNode = JSON.parse(readFileSync(join(repo, sealedInputs.priorArtifactRoot, 'closed-result.json'), 'utf8'));
assert.equal(priorAnalysis.capturedScope.runId, '37396338452');
assert.equal(priorExecutor.actualExit, 1); assert.equal(priorExecutor.actualProcessExit, 1); assert.equal(priorExecutor.runnerOutcomeCode, 1);
assert.equal(priorExecutor.closure.leftoverGroupKilled, true); assert.equal(priorNode.actualExit, 1);
const priorRun = { runId: '37396338452', checkoutSHA: priorExecutor.run.GITHUB_SHA, actualExit: priorExecutor.actualExit,
  actualProcessExit: priorExecutor.actualProcessExit, runnerOutcomeCode: priorExecutor.runnerOutcomeCode,
  leftoverGroupKilled: priorExecutor.closure.leftoverGroupKilled, reapedDescendants: priorExecutor.closure.reapedDescendants,
  causeProven: false, unchangedHistoricalFailure: true };
`);
replace("files[5].split('/').at(-1)", "'wrangler.chat-holder-gateway-v364.jsonc'");
replace("files[6].split('/').at(-1)", "'wrangler.chat-holder-private-v364.jsonc'");
replace("readFileSync(join(here, wrapper), 'utf8')", "readFileSync(join(legacy, wrapper), 'utf8')");
replace("const bundles = {", `async function boundaryBundle(entry) {
  const result = await build({ entryPoints: [join(here, entry)], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    plugins: [{ name: 'frozen-observer-links', setup(plugin) {
      plugin.onResolve({ filter: /^__GATEWAY_OBSERVER__$/ }, () => ({ path: join(legacy, 'gateway-observer.mjs') }));
      plugin.onResolve({ filter: /^__HOLDER_OBSERVER__$/ }, () => ({ path: join(legacy, 'holder-observer.mjs') }));
      plugin.onResolve({ filter: /^__ORIGINAL__$/ }, args => ({ path: join(source, args.importer.endsWith('gateway-observer.mjs') ? gatewayConfig.main : holderConfig.main) }));
    } }],
  });
  assert.equal(result.outputFiles.length, 1); return result.outputFiles[0].text;
}
async function observedBareBundle() {
  const contents = readFileSync(join(legacy, 'holder-observer.mjs'), 'utf8').replace('__ORIGINAL__', join(here, 'bare-async-source.mjs').replaceAll('\\\\', '/'));
  const result = await build({ stdin: { contents, resolveDir: here, sourcefile: 'bare-observer.mjs', loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  assert.equal(result.outputFiles.length, 1); return result.outputFiles[0].text;
}
const bundles = {`);
replace("observedHolder: await bundle(holderConfig.main, 'holder-observer.mjs'),", "observedHolder: await bundle(holderConfig.main, 'holder-observer.mjs'),\n  bare: await observedBareBundle(), direct: await boundaryBundle('direct-holder.mjs'),");
replace("'v364-linux-diagnostic-prepare-v1'", "'v364-linux-boundary-prepare-v1'");
replace("sourceUnchanged: true, inputsBefore, bundleHashes, productionRequests", "sourceUnchanged: true, reviewBaseHEAD: sealedInputs.reviewBaseHEAD, checkoutSHA, priorRun, inputsBefore, bundleHashes, productionRequests");
replace("const active = new Set();", "const active = new Map();");
replace("const event = (caseId, kind, fields = {}) => { if (events.length >= 15000) throw new Error('diagnostic event cap exceeded'); events.push({ caseId, kind, hostMs: performance.now() - start, wallMs: Date.now(), ...fields }); };", "const event = (caseId, kind, fields = {}) => { if (events.length >= 20000) throw new Error('diagnostic event cap exceeded'); const row = { caseId, kind, hostMs: performance.now() - start, wallMs: Date.now(), ...fields }; events.push(row); appendFileSync(join(output, 'events.ndjson'), JSON.stringify(row) + '\\n'); };\nconst phases = new Map();\nconst phase = (caseId, value) => { phases.set(caseId, value); event(caseId, 'phase', { phase: value }); };\nconst census = (caseId, label) => event(caseId, 'proc-census', { phase: phases.get(caseId), label, census: processCensus() });");
section('class CaptureLog', 'function httpClient', `class CaptureLog extends Log {
  constructor(caseId) { super(LogLevel.DEBUG); this.caseId = caseId; }
  log(message) { event(this.caseId, 'miniflare-log', { phase: phases.get(this.caseId), message: String(message) }); }
}
function createFixture(caseId, kind) {
  phase(caseId, 'fixture-create');
  const kv = { OBSERVATIONS: holderConfig.kv_namespaces[0].id };
  const common = { modules: true, compatibilityDate: '2026-09-04', compatibilityFlags: holderConfig.compatibility_flags };
  const single = { ...common, name: 'v364-boundary-' + kind, script: kind === 'bare' ? bundles.bare : bundles.direct, kvNamespaces: kv };
  const workers = kind === 'binding' ? [
    { ...common, name: gatewayConfig.name, script: bundles.observedGateway, serviceBindings: { TEXT_HOLDER: holderConfig.name } },
    { ...common, name: holderConfig.name, script: bundles.observedHolder, kvNamespaces: kv },
  ] : [single];
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, log: new CaptureLog(caseId),
    handleStructuredLogs(log) { event(caseId, 'workerd-log', { phase: phases.get(caseId), timestamp: log.timestamp, level: log.level,
      message: String(log.message).replaceAll(SYNTHETIC_CREDENTIAL_V364, '[synthetic-redacted]').replaceAll(SYNTHETIC_PROVIDER_URL_V364, '[synthetic-redacted]') }); }, workers }));
  const f = { caseId, kind, mf, owner: kind === 'binding' ? holderConfig.name : single.name, observations: null, url: null };
  active.set(mf, f); return f; // register immediately before every readiness/binding await
}
async function readyFixture(f) {
  phase(f.caseId, 'fixture-ready');
  if (f.kind === 'binding') assert.deepEqual(Object.keys(await f.mf.getBindings(gatewayConfig.name)), ['TEXT_HOLDER']);
  const bindings = await f.mf.getBindings(f.owner); assert.deepEqual(Object.keys(bindings), ['OBSERVATIONS']);
  f.observations = bindings.OBSERVATIONS;
  f.url = new URL('/fixture/complete-text', await f.mf.ready);
  assert.equal(f.url.hostname, '127.0.0.1'); assert.equal(f.url.protocol, 'http:');
  census(f.caseId, 'ready');
}
async function disposeFixture(f, reason) {
  phase(f.caseId, 'dispose-start'); census(f.caseId, 'pre-dispose');
  event(f.caseId, 'dispose-invoke', { reason, nativeRuntimeDisposeMaySendSIGKILL: true });
  try {
    await bounded(f.mf.dispose(), 10000, 'Miniflare dispose'); active.delete(f.mf);
    phase(f.caseId, 'dispose-settled'); event(f.caseId, 'dispose-fulfilled', { reason, gracefulRuntimeExitProven: false });
    census(f.caseId, 'post-dispose'); return true;
  } catch (error) { event(f.caseId, 'dispose-error', { reason, ...errorSafe(error) }); return false; }
}
`);
replace("let response; let socket;", "let response; let socket; let socketCloseResolve;\n    const socketClosed = new Promise(resolveSocketClose => { socketCloseResolve = resolveSocketClose; });");
replace("socket = value;", "socket = value; socket.once('close', () => socketCloseResolve());");
replace("await bounded(closed, 10000, 'client response close');", "await bounded(Promise.all([closed, socketClosed]), 10000, 'client response and socket close');");
replace("responseComplete: response.complete };", "responseComplete: response.complete, socketDestroyed: socket.destroyed }; ");
// readerClient is unused in the new fixed two-transport matrix; keep no alternate transport path.
section('async function readerClient', 'async function observedGet', '');
section('async function cancellationCase', 'async function calibration', `async function cancellationCase(caseId, kind, mode) {
  let f; let client; let e;
  const result = { caseId, kind, mode, baselineEligible: false, diagnosticVariant: true, originalWindow: null, tail: null,
    finalPreDisposeSnapshot: null, actualExit: 1, closed: false };
  try {
    f = createFixture(caseId, kind); await bounded(readyFixture(f), 10000, 'fixture readiness');
    e = envelope(); const body = JSON.stringify(e); phase(caseId, 'streaming');
    client = await bounded(httpClient(caseId, f.url, body, mode), 10000, 'first frame');
    assert.equal(client.status, 200); assert.equal(client.contentType, 'text/event-stream');
    assert.equal(await observedGet(caseId, f.observations, 'accepted:' + e.attemptNonce, 0, 'before'), 'one');
    assert.equal(client.first.toString(), ': holder-ready\\n\\n');
    phase(caseId, 'client-cancel'); const cancelled = await bounded(client.cancel(), 10000, 'cancel');
    assert.deepEqual(cancelled, { requestDestroyed: true, responseDestroyed: true, responseComplete: false, socketDestroyed: true });
    phase(caseId, 'original-poll'); const pollStart = performance.now(); let value = null; let count = 0;
    for (let n = 0; n < 100 && value === null; n++) { value = await observedGet(caseId, f.observations, 'cancel:' + e.attemptNonce, n, 'original'); count++; if (value === null) await delay(10); }
    result.originalWindow = { pollCount: count, sleepMs: 10, elapsedMs: performance.now() - pollStart, actual: value, expected: 'observed', actualExit: value === 'observed' ? 0 : 1 };
    try { assert.equal(value, 'observed'); } catch (error) { result.strictFailure = errorSafe(error); }
    assert.equal(await observedGet(caseId, f.observations, 'release:' + e.attemptNonce, 0, 'after'), null);
    assert.equal(await observedGet(caseId, f.observations, 'accepted:' + e.attemptNonce, 0, 'after'), 'one');
    phase(caseId, 'diagnostic-tail'); const tailStart = performance.now(); let tailCount = 0;
    while (value === null && performance.now() - tailStart < 4000) { value = await observedGet(caseId, f.observations, 'cancel:' + e.attemptNonce, tailCount++, 'diagnostic-tail'); if (value === null) await delay(50); }
    result.tail = { elapsedMs: performance.now() - tailStart, reads: tailCount, actual: value, usedForPass: false };
    result.actualExit = result.originalWindow.actualExit;
  } catch (error) { result.error = errorSafe(error); }
  finally {
    client?.cleanup();
    if (f && e && f.observations) {
      phase(caseId, 'pre-dispose-observation');
      try {
        const values = {};
        for (const category of ['cancel', 'release', 'accepted']) values[category] = await bounded(observedGet(caseId, f.observations, category + ':' + e.attemptNonce, 0, 'pre-dispose'), 2000, 'final KV observation');
        result.finalPreDisposeSnapshot = { ...values, usedForPass: false }; event(caseId, 'pre-dispose-kv-snapshot', result.finalPreDisposeSnapshot);
      } catch (error) { result.preDisposeError = errorSafe(error); result.actualExit = 1; }
    }
    if (f) result.closed = await disposeFixture(f, 'case-finally');
    event(caseId, 'case-closed', { actualExit: result.actualExit, closed: result.closed, baselineEligible: false }); results.push(result);
  }
}
`);
replace("const result = { caseId, mode, actualExit: 1, closed: false };", "const result = { caseId, mode, baselineEligible: false, calibrationOnly: true, actualExit: 1, closed: false };");
replace("let peerClose;", "let peerClose; let peerSocketClose;\n  const socketClosed = new Promise(resolveSocketClose => { peerSocketClose = resolveSocketClose; });");
replace("request.socket.on('close', hadError => event(caseId, 'server-socket-close', { hadError }));", "request.socket.on('close', hadError => { event(caseId, 'server-socket-close', { hadError }); peerSocketClose(); });");
replace("mode === 'reader-cancel' ? readerClient(caseId, url, body) : httpClient(caseId, url, body, mode)", "httpClient(caseId, url, body, mode)");
replace("{ requestDestroyed: true, responseDestroyed: true, responseComplete: false });", "{ requestDestroyed: true, responseDestroyed: true, responseComplete: false, socketDestroyed: true });");
replace("await bounded(closed, 10000, 'server peer close');", "await bounded(Promise.all([closed, socketClosed]), 10000, 'server response and socket peer close');");
replace("let baseline; let fatal;", "let baseline; let fatal;\nlet sourceUnchanged = false;");
section("  for (const mode of ['destroy', 'rst', 'reader-cancel'])", '} catch (error) { fatal', `  for (const mode of ['destroy', 'rst']) await bounded(calibration(mode), 15000, 'calibration case');
  for (const kind of ['bare', 'direct', 'binding']) for (const mode of ['destroy', 'rst']) {
    await bounded(cancellationCase('locked-' + kind + '-' + mode, kind, mode), 30000, 'boundary cancellation case');
  }
`);
replace("for (const mf of active) { try { await bounded(mf.dispose(), 10000, 'final Miniflare dispose'); active.delete(mf); } catch (error) { event('finally', 'dispose-error', errorSafe(error)); } }", "for (const f of active.values()) await disposeFixture(f, 'outer-finally');");
replace("const sourceUnchanged = JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter);", "sourceUnchanged = JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter);");
replace("'v364-owned-linux-diagnostic-closed-v1'", "'v364-owned-linux-boundary-closed-v1'");
replace("'STRICT_SYNTHETIC_ONLY_PASS' : 'STRICT_FAILURE_PRESERVED'", "'STRICT_SYNTHETIC_BOUNDARY_COMPARISON_ONLY' : 'STRICT_FAILURE_PRESERVED'");
replace("executorReceipt, closureAuthority", "executorReceipt, checkoutSHA, reviewBaseHEAD: sealedInputs.reviewBaseHEAD, priorRun, allComparisonsBaselineEligible: false, closureAuthority");
replace("causeProven: false, lateObservationUpgradesPass: false, upstreamPatchApplied: false", "causeProven: false, lateObservationUpgradesPass: false, upstreamPatchApplied: false, flagsChanged: false,\n    limitations: ['Bare stream simplifies envelope validation and has no gateway/holder import; timing perturbation remains possible.',\n      'Direct arm changes request execution context topology by calling original holder locally and contains synthetic private literals; it cannot pass the original binding baseline.',\n      'Miniflare runtime dispose sends SIGKILL internally; API disposal fulfilled is not graceful workerd exit.',\n      'Host receipt phase is arrival-time attribution; preserve worker timestamps and do not assume all logs arrived before dispose.',\n      'Same runtime failure differences localize a boundary, not an upstream regression cause proof.']");
assert.equal(text.includes('request_signal_passthrough'), false);
assert.equal(text.includes('readerClient'), false);
writeFileSync(target, text.replaceAll('\r\n', '\n'), { flag: 'wx' });
console.log(JSON.stringify({ actualExit: 0, created: target, bytes: Buffer.byteLength(text), originalRuntimeExecuted: false }));
