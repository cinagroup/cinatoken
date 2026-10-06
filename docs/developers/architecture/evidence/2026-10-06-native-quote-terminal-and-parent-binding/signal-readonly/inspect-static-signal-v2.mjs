import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const own = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-request-signal-readonly-yCKd6V';
const repo = 'C:/cinagroup/cinatoken';
const artifact = `${repo}/docs/operators/deployment/releases/2026-10-06-g7-native26-calibration-progress/current-terminal-evidence/canonical-calibration-artifact`;
const runtime = `${artifact}/_temp/v364-direct-socket-once-37414167261-1`;
const archiveSource = `${artifact}/cinatoken/cinatoken/scripts/diagnostics/v364-direct-socket`;
const beganAt = new Date().toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const desc = file => {
  const bytes = fs.readFileSync(file);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
};
const output = (file, bytes) => fs.writeFileSync(`${own}/${file}`, bytes, { flag: 'wx' });
const checks = [];
const verified = (name, fn) => { fn(); checks.push({ name, verified: true }); };
const snapshotDir = `${own}/source-snapshots-v2`;
fs.mkdirSync(snapshotDir);
const snapshots = [];
const copy = (file, relative) => {
  const bytes = fs.readFileSync(file);
  const target = `${snapshotDir}/${relative}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  assert.deepEqual(fs.readFileSync(target), bytes);
  snapshots.push({ original: desc(file), copy: desc(target), exact: true });
  return bytes;
};
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const resultFile = `${runtime}/closed-result.json`;
const executorFile = `${runtime}/executor.closed.json`;
const result = json(resultFile);
const executor = json(executorFile);
copy(resultFile, 'runtime/closed-result.json');
copy(executorFile, 'runtime/executor.closed.json');
verified('precise run, commit and failure remain authoritative', () => {
  assert.equal(result.schema, 'v364-direct-socket-closed-v1');
  assert.equal(executor.schema, 'v364-direct-socket-executor-closed-v1');
  assert.equal(result.checkoutSHA, 'dc7be6f8597333151c450bae3ae15e6585e3b2eb');
  assert.equal(executor.checkoutSHA, result.checkoutSHA);
  assert.equal(executor.run.GITHUB_RUN_ID, '37414167261');
  for (const value of [result.actualExit, executor.actualExit, executor.actualProcessExit, executor.runnerOutcomeCode]) assert.equal(value, 1);
  assert.equal(executor.timedOut, false);
  assert.equal(executor.interrupted, false);
  assert.equal(executor.fatal, null);
});
const decoded = [];
for (const item of executor.files) {
  const normal = `${runtime}/${item.path}`;
  const compressed = `${normal}.gz`;
  const source = fs.existsSync(normal) ? normal : compressed;
  const stored = fs.readFileSync(source);
  const bytes = source === normal ? stored : zlib.gunzipSync(stored);
  verified(`executor manifest exact: ${item.path}`, () => {
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha(bytes), item.sha256);
  });
  decoded.push({ originalName: item.path, stored: desc(source), decoded: { bytes: bytes.length, sha256: sha(bytes) }, gzip: source !== normal });
}
const eventJSONFile = `${runtime}/events.json.gz`;
const eventNDJSONFile = `${runtime}/events.ndjson.gz`;
const eventJSONBytes = zlib.gunzipSync(fs.readFileSync(eventJSONFile));
const eventNDJSONBytes = zlib.gunzipSync(fs.readFileSync(eventNDJSONFile));
const events = JSON.parse(eventJSONBytes);
const ndjsonLines = eventNDJSONBytes.toString('utf8').trimEnd().split('\n');
verified('JSON and NDJSON event sequence exact', () => {
  assert.equal(events.length, result.events.count);
  assert.equal(eventJSONBytes.length, result.events.bytes);
  assert.equal(sha(eventJSONBytes), result.events.sha256);
  assert.deepEqual(ndjsonLines.map(line => JSON.parse(line)), events);
});
const aborts = [];
const observed = [];
for (const [zeroBasedIndex, event] of events.entries()) {
  if (event.kind !== 'workerd-log' || !event.message?.startsWith('V364_DIAG ')) continue;
  const message = JSON.parse(event.message.slice('V364_DIAG '.length));
  if (message.event?.startsWith('signal-')) observed.push({ zeroBasedIndex, event, parsedMessage: message });
  if (message.event === 'signal-abort') aborts.push({ zeroBasedIndex, ndjsonOneBasedLine: zeroBasedIndex + 1, ndjsonLine: ndjsonLines[zeroBasedIndex], ndjsonLineUtf8Bytes: Buffer.byteLength(ndjsonLines[zeroBasedIndex]), ndjsonLineSha256: sha(Buffer.from(ndjsonLines[zeroBasedIndex])), event, parsedMessage: message });
}
verified('two real holder RST abort logs are inside original poll', () => {
  assert.deepEqual(aborts.map(row => row.event.caseId), ['direct-socket-bare-rst', 'direct-socket-binding-rst']);
  assert.deepEqual(aborts.map(row => row.zeroBasedIndex), [460, 1269]);
  for (const row of aborts) {
    assert.equal(row.event.phase, 'original-poll');
    assert.equal(row.parsedMessage.boundary, 'holder');
    assert.equal(row.parsedMessage.aborted, true);
  }
});
verified('all original transport arms still fail and explicit reader calibration remains separate', () => {
  assert.equal(result.results.length, 5);
  const calibration = result.results[0];
  assert.equal(calibration.actualExit, 0);
  assert.equal(calibration.nativeWorkerExecuted, true);
  assert.equal(calibration.calibrationOnly, true);
  assert.equal(calibration.baselineEligible, false);
  assert.equal(calibration.received.cancel, 'observed');
  assert.equal(calibration.nativeObserverEvidence.addsLifetimeTask, false);
  assert.equal(result.baseline.actualExit, 1);
  assert.equal(result.baseline.closed, true);
  for (const arm of result.results.slice(1)) {
    assert.equal(arm.actualExit, 1);
    assert.equal(arm.coreEntryBypassed, true);
    assert.equal(arm.originalWindow.actual, null);
    assert.equal(arm.originalWindow.pollCount, 100);
    assert.equal(arm.originalWindow.sleepMs, 10);
    assert.equal(arm.tail.actual, null);
    assert.equal(arm.tail.usedForPass, false);
    assert.equal(arm.finalPreDisposeSnapshot.cancel, null);
  }
});
verified('cleanup is unforced outer close, not graceful Workerd proof', () => {
  assert.equal(executor.closure.directChildReaped, true);
  assert.equal(executor.closure.groupGone, true);
  assert.equal(executor.closure.leftoverGroupKilled, false);
  assert.equal(executor.closure.outerUnforcedGroupClose, true);
  assert.equal(executor.closure.gracefulWorkerdExitProven, false);
});
const sealed = json(`${archiveSource}/sealed-package.json`);
const inputs = json(`${archiveSource}/source-inputs.json`);
for (const entry of sealed.files) {
  verified(`archived sealed diagnostic input exact: ${entry.path}`, () => {
    const d = desc(`${archiveSource}/${entry.path}`);
    assert.equal(d.bytes, entry.bytes);
    assert.equal(d.sha256, entry.sha256);
    const current = desc(`${repo}/scripts/diagnostics/v364-direct-socket/${entry.path}`);
    assert.equal(current.bytes, d.bytes);
    assert.equal(current.sha256, d.sha256);
  });
  copy(`${archiveSource}/${entry.path}`, `direct/${entry.path}`);
}
copy(`${archiveSource}/sealed-package.json`, 'direct/sealed-package.json');
const selected = inputs.files.filter(row => /packages\/proxy\/scripts\/staging\//.test(row.path) || /\/(gateway-observer|holder-observer|bare-async-source)\.mjs$/.test(row.path));
for (const entry of selected) {
  verified(`frozen relevant holder and observer input exact: ${entry.path}`, () => {
    const d = desc(`${repo}/${entry.path}`);
    assert.equal(d.bytes, entry.bytes);
    assert.equal(d.sha256, entry.sha256);
  });
  copy(`${repo}/${entry.path}`, `repository/${entry.path}`);
}
const installed = [];
for (const entry of result.installedBefore) {
  const d = desc(`${repo}/${entry.path}`);
  verified(`installed source matches actual Linux recorded hash: ${entry.path}`, () => {
    assert.equal(d.bytes, entry.bytes);
    assert.equal(d.sha256, entry.sha256);
    assert.deepEqual(inputs.installedFiles.find(row => row.path === entry.path), entry);
  });
  installed.push(d);
}
const ranges = [];
function range(file, begin, end, reason) {
  const bytes = fs.readFileSync(file);
  const lines = bytes.toString('utf8').split(/\r?\n/);
  assert(begin > 0 && end <= lines.length);
  ranges.push({ source: desc(file), beginOneBased: begin, endOneBased: end, reason, text: lines.slice(begin - 1, end).join('\n') });
}
const official = `${own}/official-locked-source-public`;
range(`${official}/compatibility-date.capnp`, 794, 799, 'explicit request-signal enable/disable flag; no enable-date annotation');
range(`${official}/worker-entrypoint.c++`, 414, 474, 'request signal controller and cancellation hook; internal runtime waitUntil');
range(`${official}/standard.c++`, 3515, 3607, 'locked JavaScript draining-reader pump and catch-path cancellation');
range(`${official}/standard.c++`, 291, 324, 'reader release handles pending reads and references');
range(`${official}/standard.c++`, 3743, 3778, 'JavaScript controller delegates response pump to draining reader');
range(`${official}/readable.c++`, 284, 288, 'draining reader destructor calls releaseReader without JavaScript lock');
range(`${repo}/node_modules/miniflare/dist/src/index.js`, 111120, 111134, 'direct socket config normalized into worker dev config');
range(`${repo}/node_modules/miniflare/dist/src/index.js`, 113163, 113193, 'direct sockets use user worker service');
range(`${repo}/node_modules/miniflare/dist/src/index.js`, 113668, 113689, 'direct URL selects actual worker socket port');
range(`${repo}/node_modules/miniflare/dist/src/workers/core/entry.worker.js`, 5112, 5120, 'Core ENTRY fetch boundary');
range(`${repo}/node_modules/miniflare/dist/src/workers/core/entry.worker.js`, 5180, 5191, 'Core ENTRY service fetch and response transforms');
range(`${archiveSource}/run-direct-socket.mjs`, 173, 184, 'frozen configs and exact nodejs_compat plus enable_request_signal flags');
range(`${archiveSource}/run-direct-socket.mjs`, 435, 468, 'same date and flag configuration applied to bare/gateway/holder workers');
range(`${repo}/packages/proxy/scripts/staging/chat-holder-private-v364.ts`, 65, 91, 'original async source pull and cancel implementation');
range(`${repo}/packages/proxy/scripts/staging/chat-holder-gateway-v364.ts`, 1, 30, 'original request signal passed through binding and response body returned');
const report = {
  schema: 'cinatoken-v364-request-signal-static-source-and-event-audit-v1',
  beganAt, endedAt: new Date().toISOString(), actualReadAuditExit: 0,
  observationOnly: true, applicationExecution: false, nativeExecution: false, ciInvocation: false,
  gatePassDerived: false, repoWrite: false, archivedRunActualExit: 1,
  artifactRoot: artifact, archivedRun: { checkoutSHA: result.checkoutSHA, versions: result.versions, runtimeCompatibilityDate: result.runtimeCompatibilityDate, frozenConfigDate: result.frozenConfigDate },
  checks, decoded, signalAbortLogs: aborts, allSignalDiagnosticLogs: observed,
  originalResults: result.results, originalBaseline: result.baseline, originalClosure: executor.closure,
  selectedInputCount: selected.length, snapshots, installed, physicalSourceRanges: ranges,
};
output('static-source-event-audit-v2.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ actualReadAuditExit: 0, checks: checks.length, selectedInputCount: selected.length, snapshots: snapshots.length, decodedFiles: decoded.length, events: events.length, signalAbortLogs: aborts.length, archivedActualExit: 1, applicationExecution: false, nativeExecution: false, gatePassDerived: false }));
