import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [bindingFile] = process.argv.slice(2);
const binding = JSON.parse(fs.readFileSync(bindingFile));
assert.equal(binding.schema, 'cinatoken-v364-queued-linux-observation-binding-v1'); assert.equal(binding.rootAuthorisedObservation, true);
const root = path.resolve(binding.observationRoot); assert.equal(path.dirname(path.resolve(bindingFile)), root);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: sha(b) }; };
const read = file => JSON.parse(fs.readFileSync(file));
const receipts = [];
for (const label of ['watch', 'run-terminal', 'jobs-terminal', 'artifacts-terminal', 'job-log-once', 'download-artifact-once', 'extract-artifact']) {
  const file = path.join(root, `${label}.result.json`), r = read(file);
  assert.equal(r.closed, true); assert.equal(r.signal, null); assert.equal(r.spawnError, null); assert.equal(r.timedOut, false);
  assert.equal(String(r.runId), String(binding.runId)); assert.equal(r.sourceSHA, binding.sourceSHA);
  if (label === 'watch') assert([0, 1].includes(r.actualExit)); else assert.equal(r.actualExit, 0);
  for (const s of ['stdout', 'stderr']) assert.deepEqual(descriptor(r[s].path), r[s]);
  receipts.push({ label, receipt: descriptor(file), actualExit: r.actualExit, stdout: r.stdout, stderr: r.stderr });
}
const run = read(path.join(root, 'run-terminal.stdout.raw'));
const jobs = read(path.join(root, 'jobs-terminal.stdout.raw'));
const artifacts = read(path.join(root, 'artifacts-terminal.stdout.raw'));
assert.equal(run.id, Number(binding.runId)); assert.equal(run.head_sha, binding.sourceSHA); assert.equal(run.run_attempt, binding.runAttempt); assert.equal(run.status, 'completed');
assert.equal(jobs.total_count, 1); assert.equal(jobs.jobs.length, 1); assert.equal(jobs.jobs[0].run_id, run.id); assert.equal(jobs.jobs[0].status, 'completed');
const artifactName = `v364-direct-socket-${binding.sourceSHA}-${binding.runId}-${binding.runAttempt}`;
const artifactMatches = artifacts.artifacts.filter(a => a.name === artifactName && a.workflow_run?.id === run.id && a.workflow_run.head_sha === binding.sourceSHA && !a.expired);
assert.equal(artifactMatches.length, 1);
const artifact = artifactMatches[0];
const index = read(path.join(root, 'full-artifact-index.json'));
assert.equal(index.sourceSHA, binding.sourceSHA); assert.equal(index.runId, String(binding.runId)); assert.equal(index.actualDecodeVerification, 0);
assert.equal(index.files.length, index.fileCount);
assert.deepEqual(descriptor(index.archive.path), index.archive);
const zipOriginalDescriptor = read(path.join(root, 'download-artifact-once.result.json')).stdout;
assert.equal(path.resolve(index.archive.path), path.resolve(zipOriginalDescriptor.path));
assert.equal(index.archive.bytes, zipOriginalDescriptor.bytes); assert.equal(index.archive.sha256, zipOriginalDescriptor.sha256);
for (const row of index.files) {
  assert.equal(descriptor(row.path).bytes, row.bytes); assert.equal(descriptor(row.path).sha256, row.sha256);
  assert(path.resolve(row.path).startsWith(path.resolve(root, 'full-artifact') + path.sep));
}
const one = predicate => { const rows = index.files.filter(predicate); assert.equal(rows.length, 1); return rows[0]; };
const executorFile = one(row => path.basename(row.relative) === 'executor.closed.json');
const runtime = path.dirname(executorFile.path);
const executor = read(executorFile.path), node = read(path.join(runtime, 'closed-result.json'));
assert.equal(executor.schema, 'v364-direct-socket-executor-closed-v1'); assert.equal(node.schema, 'v364-direct-socket-closed-v1');
assert.equal(executor.checkoutSHA, binding.sourceSHA); assert.equal(node.checkoutSHA, binding.sourceSHA);
assert.equal(executor.run.GITHUB_SHA, binding.sourceSHA); assert.equal(executor.run.GITHUB_RUN_ID, String(binding.runId)); assert.equal(executor.run.GITHUB_RUN_ATTEMPT, String(binding.runAttempt));
const runtimeManifest = [];
for (const row of executor.files) {
  const file = path.join(runtime, row.path); assert.equal(path.dirname(path.resolve(file)), path.resolve(runtime));
  const d = descriptor(file); assert.equal(d.bytes, row.bytes); assert.equal(d.sha256, row.sha256);
  runtimeManifest.push(d);
}
const eventsFile = path.join(runtime, 'events.json'), ndjsonFile = path.join(runtime, 'events.ndjson');
const eventsBytes = fs.readFileSync(eventsFile), events = JSON.parse(eventsBytes), ndjsonBytes = fs.readFileSync(ndjsonFile);
assert.equal(eventsBytes.length, node.events.bytes); assert.equal(sha(eventsBytes), node.events.sha256); assert.equal(events.length, node.events.count);
assert.deepEqual(ndjsonBytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)), events);
assert.deepEqual(node.versions, { workerd: '1.20260828.1', miniflare: '5.20260828.0-alpha', wrangler: '4.127.1' });
assert.equal(node.runtimeCompatibilityDate, '2026-09-04'); assert.equal(node.frozenConfigDate, '2026-09-25');
assert.deepEqual(node.inputsBefore, node.inputsAfter); assert.deepEqual(node.installedBefore, node.installedAfter);
const sealedFile = one(row => row.relative.endsWith('/scripts/diagnostics/v364-direct-socket/sealed-package.json') || row.relative === 'sealed-package.json');
const packageDir = path.dirname(sealedFile.path), sealed = read(sealedFile.path);
assert.equal(sealed.schema, 'v364-direct-socket-sealed-package-v1'); assert.equal(descriptor(sealedFile.path).sha256, executor.packageSHA256);
const packageFiles = [];
for (const row of sealed.files) { const file = path.join(packageDir, row.path); assert.equal(path.dirname(path.resolve(file)), path.resolve(packageDir)); const d = descriptor(file); assert.equal(d.bytes, row.bytes); assert.equal(d.sha256, row.sha256); packageFiles.push(d); }
const workflowFile = one(row => row.relative.endsWith('/.github/workflows/v364-direct-socket.yml') || row.relative === '.github/workflows/v364-direct-socket.yml');
assert.equal(workflowFile.bytes, sealed.workflow.bytes); assert.equal(workflowFile.sha256, sealed.workflow.sha256);
assert.equal(node.results.length, 5, 'Do not fold the queued extra arm into the original five');
assert.deepEqual(node.results.map(row => row.caseId), ['native-worker-reader-cancel', 'direct-socket-bare-destroy', 'direct-socket-bare-rst', 'direct-socket-binding-destroy', 'direct-socket-binding-rst']);
const timingContracts = node.results.slice(1).map(row => {
  if (row.originalWindow) {
    assert(Number.isInteger(row.originalWindow.pollCount) && row.originalWindow.pollCount >= 1 && row.originalWindow.pollCount <= 100);
    assert.equal(row.originalWindow.sleepMs, 10); assert.equal(row.originalWindow.expected, 'observed');
    assert.equal(row.originalWindow.actualExit, row.originalWindow.actual === 'observed' ? 0 : 1);
  }
  if (row.tail) assert.equal(row.tail.usedForPass, false);
  return { caseId: row.caseId, reachedOriginalPoll: Boolean(row.originalWindow), originalWindow: row.originalWindow, tail: row.tail, fixedSourcePollLimit: 100, fixedSourceSleepMs: 10, fixedSourceTailMs: 4000 };
});
const baseline = node.baseline, baselineText = fs.readFileSync(path.join(runtime, baseline.stdout.file), 'utf8');
for (const s of ['stdout', 'stderr']) { const d = descriptor(path.join(runtime, baseline[s].file)); assert.equal(d.bytes, baseline[s].bytes); assert.equal(d.sha256, baseline[s].sha256); }
const tap = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, Number(baselineText.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
const extra = node.queuedWriteComparison;
assert(extra && extra.caseId === 'direct-socket-bare-rst-queued-write'); assert.equal(extra.baselineEligible, false);
const extraEvents = events.filter(row => row.caseId === extra.caseId);
const pressureSamples = extra.queuedPressureAdmission?.samples ?? [];
const immediate = extra.immediatePreRST;
const previous = pressureSamples.at(-1);
const recomputedBacklog = Boolean(extra.queuedPressureAdmission?.admitted && previous?.known && immediate?.known && previous.txBytes > 0 && immediate.txBytes > 0 && previous.inode === immediate.inode && previous.pid === immediate.pid && previous.startTimeTicks === immediate.startTimeTicks && Number.isFinite(extra.resetInvokeAt) && Number.isFinite(previous.sampleEndedAt) && Number.isFinite(immediate.sampleEndedAt) && previous.sampleEndedAt <= extra.resetInvokeAt && immediate.sampleEndedAt <= extra.resetInvokeAt && extra.resetInvokeAt - previous.sampleEndedAt >= 0 && extra.resetInvokeAt - previous.sampleEndedAt < 100);
if ('transportBacklogObservedBeforeRST' in extra) assert.equal(extra.transportBacklogObservedBeforeRST, recomputedBacklog);
const parseOwnLog = row => row.message?.startsWith('V364_QWRITE ') ? JSON.parse(row.message.slice('V364_QWRITE '.length)) : null;
const callbackNames = { incomingSignalAbort: 'signal-abort', syntheticCleanupHookInvoke: 'cleanup-hook-invoke', syntheticCleanupHookReturn: 'cleanup-hook-return', realSourceCancelHookInvoke: 'source-cancel-hook-invoke', realSourceCancelHookFulfilled: 'source-cancel-hook-fulfilled' };
const callbackCounts = Object.fromEntries(Object.entries(callbackNames).map(([key, event]) => [key, extraEvents.filter(row => ['client-cancel', 'original-poll'].includes(row.phase) && parseOwnLog(row)?.event === event).length]));
for (const [key, count] of Object.entries(callbackCounts)) if (extra.distinctCallbacks) assert.equal(extra.distinctCallbacks[key], count);
const closure = executor.closure;
const closureFacts = { actualProcessExit: executor.actualProcessExit, runnerOutcomeCode: executor.runnerOutcomeCode, actualExecutorExit: executor.actualExit, nodeActualExit: node.actualExit, reportedActualExit: executor.reportedActualExit, timedOut: executor.timedOut, interrupted: executor.interrupted, directChildReaped: closure.directChildReaped, groupGone: closure.groupGone, leftoverGroupKilled: closure.leftoverGroupKilled, actualSignalAttempts: closure.signalAttempts, reapedDescendants: closure.reapedDescendants, reapedCount: closure.reapedDescendants.length, processCensus: closure.processCensus, outerUnforcedGroupClose: closure.outerUnforcedGroupClose, apiDisposalReported: closure.apiDisposalReported, gracefulWorkerdExitProven: closure.gracefulWorkerdExitProven, disposalMayKillWorkerd: closure.miniflareDisposeMaySendSIGKILL, errors: closure.errors };
const report = { schema: 'cinatoken-v364-queued-linux-complete-artifact-independent-review-v1', at: new Date().toISOString(), actualByteAndFactVerificationExit: 0, run: { id: run.id, sourceSHA: run.head_sha, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion, url: run.html_url, event: run.event, createdAt: run.created_at, updatedAt: run.updated_at }, job: jobs.jobs[0], artifact: { id: artifact.id, name: artifact.name, sizeBytes: artifact.size_in_bytes, GitHubReportedDigest: artifact.digest, expiresAt: artifact.expires_at, createdAt: artifact.created_at, updatedAt: artifact.updated_at, workflowRun: artifact.workflow_run }, downloadedZip: index.archive, allDecodedFiles: index.files, fullDecodedFileCount: index.fileCount, directoryCount: index.directoryCount, decodedBytes: index.decodedBytes, completeZipMemberSetRetained: index.completeZipMemberSetRetained, rawManifest: runtimeManifest, sealedPackage: descriptor(sealedFile.path), sealedPackageFiles: packageFiles, workflow: workflowFile, eventJSON: descriptor(eventsFile), eventNDJSON: descriptor(ndjsonFile), eventSequenceExact: true, eventCount: events.length, versions: node.versions, dates: { runtime: node.runtimeCompatibilityDate, frozen: node.frozenConfigDate }, inputsBeforeAndAfterExact: true, baseline: { receipt: baseline, observedTAP: tap, expectedHistoricalTAP: { tests: 8, pass: 7, fail: 1 }, matchesHistorical8_7_1: tap.tests === 8 && tap.pass === 7 && tap.fail === 1 }, originalFiveResults: node.results, queuedWriteComparison: extra, queuedFacts: { recomputedKernelBacklog: recomputedBacklog, pressureSamples, immediatePreRST: immediate, resetInvokeAt: extra.resetInvokeAt, rstInvokeReturnEvents: extraEvents.filter(row => ['queued-immediate-pre-rst-backlog', 'client-rst-api-invoke', 'queued-rst-api-return', 'client-cancel-settled'].includes(row.kind)), separatelyRecomputedCallbackCounts: callbackCounts, allOwnCallbackLogs: extraEvents.filter(row => parseOwnLog(row)), cppPendingWriteProven: false, pumpBranchProven: false, businessCleanupProven: false, signalAbortNotStreamCancelPass: true }, closure: closureFacts, commandReceipts: receipts, byteVerificationIsNotCIOrProductPass: true, strictPassDerived: false, fullGoalComplete: false, productionRequest: false, noNewRuntimeOrTestsExecuted: true };
const file = path.join(root, 'FINAL-linux-artifact-independent-review.json');
report.originalTransportTimingContracts = timingContracts;
report.processOwnership = { executorStart: node.executorReceipt, closureAuthority: node.closureAuthority, activeMiniflare: node.activeMiniflare, fatal: node.fatal, observationFailures: node.observationFailures };
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ final: descriptor(file), actualByteAndFactVerificationExit: 0, ciConclusion: run.conclusion, baselineTAP: tap, nodeActualExit: node.actualExit, actualProcessExit: executor.actualProcessExit, originalResultExits: node.results.map(r => r.actualExit), extraActualExit: extra.actualExit, extraBacklog: recomputedBacklog, gracefulWorkerdExitProven: closure.gracefulWorkerdExitProven, strictPassDerived: false }));
