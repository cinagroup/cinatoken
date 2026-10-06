import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const here = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-terminal-readonly-dadfa5000d064bd08eeab54de4130cd8';
const owner = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E';
const artifact = join(owner, 'boundary-artifact');
const rawDir = join(artifact, '_temp/v364-boundary-once-37402302570-1');
const pkg = join(artifact, 'cinatoken/cinatoken/scripts/diagnostics/v364-owned-linux-boundary');
const prepRoot = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-preparation-1427c951d98b46c6ae8299694b679b38';
const peerPath = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-boundary-peer-79ca7e6f2470461d9554856f33950460/FINAL-new-boundary-final-reseal-readonly-review.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = path => { const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: sha(bytes) }; };
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const executor = readJSON(join(rawDir, 'executor.closed.json'));
const node = readJSON(join(rawDir, 'closed-result.json'));
const start = readJSON(join(rawDir, 'executor-start.json'));
const analysis = readJSON(join(owner, 'boundary-terminal-analysis.json'));
const sourcePins = readJSON(join(pkg, 'source-inputs.json'));
const seal = readJSON(join(pkg, 'sealed-package.json'));
const originalFiles = executor.files.map(item => {
  const actual = receipt(join(rawDir, item.path)); assert.equal(actual.bytes, item.bytes); assert.equal(actual.sha256, item.sha256);
  return { ...actual, originalExecutorDigestExact: true };
});
const packageFiles = seal.files.map(item => {
  const actual = receipt(join(pkg, item.path)); assert.equal(actual.bytes, item.bytes); assert.equal(actual.sha256, item.sha256);
  return { ...actual, artifactManifestDigestExact: true };
});
const workflowPath = join(artifact, 'cinatoken/cinatoken', seal.workflow.path);
const workflow = existsSync(workflowPath) ? receipt(workflowPath) : { path: workflowPath, present: false };
if (existsSync(workflowPath)) { assert.equal(workflow.bytes, seal.workflow.bytes); assert.equal(workflow.sha256, seal.workflow.sha256); }
assert.equal(receipt(join(pkg, 'sealed-package.json')).sha256, 'b99ede67c0e949fc6aee728f450d564d60c9eed14b60e542e3282e9a8d163af9');
assert.equal(executor.packageSHA256, receipt(join(pkg, 'sealed-package.json')).sha256);
assert.equal(executor.checkoutSHA, '67f8b3df2f2b6e8159806767ecce1efa1904d27a');
assert.equal(start.checkoutSHA, executor.checkoutSHA); assert.equal(executor.run.GITHUB_SHA, executor.checkoutSHA);
assert.equal(executor.run.GITHUB_RUN_ID, '37402302570'); assert.equal(executor.run.GITHUB_RUN_ATTEMPT, '1');
assert.equal(node.checkoutSHA, executor.checkoutSHA); assert.deepEqual(node.executorReceipt, start);
assert.equal(executor.actualExit, 1); assert.equal(executor.actualProcessExit, 1); assert.equal(executor.runnerOutcomeCode, 1);
assert.equal(node.actualExit, 1); assert.equal(executor.reportedActualExit, 1);
assert.equal(executor.timedOut, false); assert.equal(executor.interrupted, false); assert.equal(executor.fatal, null);
assert.equal(node.fatal ?? null, null); assert.equal(node.sourceUnchanged, true); assert.deepEqual(node.inputsBefore, sourcePins.files); assert.deepEqual(node.inputsAfter, sourcePins.files);
assert.equal(node.observationFailures.length, 0); assert.equal(node.activeMiniflare, 0);
const tap = readFileSync(join(rawDir, 'original-strict.stdout.txt'), 'utf8');
assert.equal(node.baseline.code, 1); assert.equal(node.baseline.signal, null); assert.equal(node.baseline.timedOut, false);
assert.equal(receipt(join(rawDir, 'original-strict.stdout.txt')).sha256, node.baseline.stdout.sha256);
assert.equal(receipt(join(rawDir, 'original-strict.stderr.txt')).sha256, node.baseline.stderr.sha256);
assert.ok(tap.includes('# tests 8')); assert.ok(tap.includes('# pass 7')); assert.ok(tap.includes('# fail 1')); assert.ok(tap.includes('# skipped 0')); assert.ok(tap.includes("null !== 'observed'"));
const expectedIds = ['node-http-calibration-destroy', 'node-http-calibration-rst', ...['bare', 'direct', 'binding'].flatMap(kind => ['destroy', 'rst'].map(mode => `locked-${kind}-${mode}`))];
assert.deepEqual(node.results.map(v => v.caseId), expectedIds);
assert.equal(node.results.every(v => v.closed && v.baselineEligible === false), true);
assert.equal(node.results.slice(0, 2).every(v => v.actualExit === 0), true);
for (const item of node.results.slice(2)) {
  assert.equal(item.actualExit, 1); assert.equal(item.originalWindow.actual, null); assert.equal(item.originalWindow.actualExit, 1);
  assert.equal(item.originalWindow.pollCount, 100); assert.equal(item.originalWindow.sleepMs, 10); assert.equal(item.originalWindow.expected, 'observed');
  assert.equal(item.tail.actual, null); assert.equal(item.tail.usedForPass, false);
  assert.deepEqual(item.finalPreDisposeSnapshot, { cancel: null, release: null, accepted: 'one', usedForPass: false });
}
const eventsBytes = readFileSync(join(rawDir, 'events.json')); const events = JSON.parse(eventsBytes);
assert.equal(sha(eventsBytes), node.events.sha256); assert.equal(eventsBytes.length, node.events.bytes); assert.equal(events.length, node.events.count);
const streamEvents = readFileSync(join(rawDir, 'events.ndjson'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
const eventSnapshotsExact = JSON.stringify(events) === JSON.stringify(streamEvents);
const rows = node.results.map(item => {
  const caseEvents = events.filter(v => v.caseId === item.caseId);
  const metadata = [];
  for (const ev of caseEvents.filter(v => v.kind === 'workerd-log')) {
    const message = String(ev.message); const marker = 'V364_DIAG ';
    const at = message.indexOf(marker);
    if (at < 0) continue;
    try { const fields = JSON.parse(message.slice(at + marker.length)); metadata.push({ ...fields, hostMs: ev.hostMs, receiptPhase: ev.phase, timestamp: ev.timestamp }); }
    catch { /* Preserve raw log, do not invent unavailable parsed metadata. */ }
  }
  const pick = kind => caseEvents.filter(v => v.kind === kind).map(v => ({ hostMs: v.hostMs, phase: v.phase, mode: v.mode }));
  return { caseId: item.caseId, actualExit: item.actualExit, closed: item.closed, baselineEligible: item.baselineEligible,
    originalWindow: item.originalWindow ?? null, tail: item.tail ?? null, finalPreDisposeSnapshot: item.finalPreDisposeSnapshot ?? null,
    clientCancelInvoke: pick('client-cancel-invoke'), clientRSTAPIInvoke: pick('client-rst-api-invoke'),
    clientSettled: pick('client-cancel-settled'), clientSocketClose: pick('socket-close'),
    disposeInvoke: pick('dispose-invoke'), disposeFulfilled: pick('dispose-fulfilled'),
    observedMetadata: { parsedCount: metadata.length,
      cancelKVInvoke: metadata.filter(v => v.event === 'kv-invoke' && v.category === 'cancel').length,
      cancelKVFulfilled: metadata.filter(v => v.event === 'kv-fulfilled' && v.category === 'cancel').length,
      waitUntilRegister: metadata.filter(v => v.event === 'waitUntil-register').length,
      signalAbort: metadata.filter(v => v.event === 'signal-abort').map(v => ({ boundary: v.boundary, hostMs: v.hostMs, receiptPhase: v.receiptPhase })) } };
});
const closure = executor.closure;
assert.equal(closure.groupGone, true); assert.equal(closure.outerUnforcedGroupClose, true); assert.equal(closure.leftoverGroupKilled, false);
assert.deepEqual(closure.signalAttempts, []); assert.deepEqual(closure.errors, []); assert.equal(closure.gracefulWorkerdExitProven, false);
assert.equal(closure.miniflareDisposeMaySendSIGKILL, true); assert.equal(closure.directChildReaped, true);
const before = closure.processCensus.find(v => v.label === 'before-initial-adopted-reap');
const after = closure.processCensus.find(v => v.label === 'after-initial-adopted-reap');
assert.equal(before.live, 0); assert.equal(before.zombies, 4); assert.equal(before.complete, true); assert.equal(before.groupExists, true);
assert.equal(before.members.every(v => v.state === 'Z' && v.comm === 'esbuild'), true);
assert.equal(after.members.length, 0); assert.equal(after.groupExists, false); assert.equal(after.complete, true);
assert.equal(closure.reapedDescendants.length, 4); assert.equal(closure.reapedDescendants.every(v => v.waitStatus === 0 && v.waitExitCode === 0), true);
assert.equal(analysis.executorActualExit, executor.actualExit); assert.deepEqual(analysis.cleanup, closure); assert.deepEqual(analysis.strictBaseline, node.baseline);
assert.equal(analysis.rows.length, node.results.length);
for (const row of analysis.rows) { const actual = node.results.find(v => v.caseId === row.caseId); assert.equal(row.actualExit, actual.actualExit); assert.deepEqual(row.originalWindow, actual.originalWindow ?? null); }
const peer = receipt(peerPath); assert.equal(peer.bytes, 8007); assert.equal(peer.sha256, '2067c48c0f0999febbc56a910747e4990ce78802ff4d6c5e45f2a4fde70a0e54');
const prepPath = join(prepRoot, 'FINAL-v364-boundary-portable-preparation.json'); const prepFile = receipt(prepPath);
assert.equal(prepFile.bytes, 34463); assert.equal(prepFile.sha256, '6a871bc68a5611273d64d65d4ea9d6aee46d87f9c92bc427238604710e092f02');
const prep = readJSON(prepPath);
const prepCommands = prep.commands.map(item => {
  const commandFile = receipt(join(prepRoot, 'validation-2', item.id + '.command-result.json'));
  const original = readJSON(commandFile.path); assert.deepEqual(original, item);
  const outputs = item.outputs.map(output => { const actual = receipt(output.path); assert.equal(actual.bytes, output.bytes); assert.equal(actual.sha256, output.sha256); return actual; });
  assert.equal(item.terminal, true); assert.equal(item.signal, null); assert.equal(item.error, null);
  return { id: item.id, commandFile, program: item.program, args: item.args, status: item.status, expectedExit: item.expectedExit, outputs,
    sourceScope: 'Owner local synchronous spawnSync producer-observed status; not an independent Linux command or per-child unified tool return' };
});
assert.deepEqual(prepCommands.map(v => v.status), [0, 0, 0, 0, 0, 0, 0, 1, 1]);
const negative = prep.negativeWindowsReceipt;
assert.equal(negative.actualProcessExit, null); assert.equal(negative.runnerOutcomeCode, 1); assert.equal(negative.actualExit, 1);
assert.equal(negative.closure.directChildReaped, false); assert.equal(prep.negativeIsLinuxClosureProof, false);
const report = { schema: 'cinatoken.v364.boundary.actual-linux-terminal.independent-readonly-review.v1',
  at: new Date().toISOString(), reviewActualExit: 0, diagnosticActualExit: 1,
  conclusion: 'STRICT_CANCELLATION_FAILURE_CONFIRMED_UNFORCED_OUTER_REAP_CONFIRMED_CAUSE_UNPROVEN',
  run: executor.run, checkoutSHA: executor.checkoutSHA, actualProcessExit: executor.actualProcessExit, runnerOutcomeCode: executor.runnerOutcomeCode,
  evidence: { originalExecutor: receipt(join(rawDir, 'executor.closed.json')), originalNode: receipt(join(rawDir, 'closed-result.json')),
    originalStart: receipt(join(rawDir, 'executor-start.json')), originalFiles, packageManifest: receipt(join(pkg, 'sealed-package.json')),
    packageFiles, workflow, rootAnalysis: receipt(join(owner, 'boundary-terminal-analysis.json')), rootAnalysisMatchesActual: true,
    eventsNDJSONMatchesFinalSnapshot: eventSnapshotsExact },
  strictBaseline: { ...node.baseline, tests: 8, pass: 7, fail: 1, skip: 0, cancelAssertionActual: null, expected: 'observed', failureRetained: true },
  rows, closure,
  source: { priorReviewBaseHEAD: sourcePins.reviewBaseHEAD, priorPreparedAtHead: sourcePins.preparedAtHead,
    actualRunSHADistinctFromPreparation: executor.checkoutSHA !== sourcePins.preparedAtHead, sourceUnchanged: node.sourceUnchanged,
    frozenInputsBeforeAfterExact: true, allComparisonsBaselineEligible: false },
  preparationSources: { finalPeerReport: peer, ownerPreparation: prepFile, commands: prepCommands,
    ownerProducer: receipt(join(prepRoot, 'audit-boundary.mjs')),
    ownerOuterToolEvidence: { chunkId: '0d93dc', actualExitCode: 0, wallTimeSeconds: 7.6567148,
      source: 'Original retained exec_command tool return for owner audit-boundary.mjs. No newly executed preparation command.',
      individualInnerUnifiedToolReceiptsExisted: false },
    scope: 'Local Node24 preparation/syntax/esbuild, Python AST and inert no-process simulations; expected Windows/no-child and reused-out failures only. This is not Node22 Linux runtime proof.',
    originalHistoricalPreparationFailuresRetained: [prep.historicalPreparationFailure, prep.historicalAuditEntryFailure, prep.historicalInertStubFailure],
    windowsNegative: { actualProcessExit: null, runnerOutcomeCode: 1, actualExit: 1, noDiagnosticChild: true, noNativeRuntime: true,
      directChildReaped: false, linuxClosureProof: false } },
  supported: [
    'The original strict baseline remains 7 pass, 1 failed, 0 skipped. Both Node transport calibrations pass.',
    'Bare/no-Service-Binding, original-holder local-call and Service Binding paths each fail both destroy and RST source-cancel windows: six null original100x10ms windows, null separate4s tails and cancel-null final pre-dispose snapshots.',
    'A failure specific only to the Service Binding boundary is weakened by matched direct and bare failures; an upstream defect or precise pump/callback cause is still not proven.',
    'This run starts outer cleanup with four adopted esbuild zombies and no observed live group members; exact PID/start identity wait statuses are0, reap empties the group, no outer signal is sent. This new observation cannot rewrite the old forced flag.',
    'Miniflare API disposal can itself SIGKILL workerd. Outer unforced group close is not proof of graceful workerd exit or cancellation propagation.'
  ],
  limitations: [
    'This is a finite hash-checked artifact snapshot from the one specified run; it cannot establish absence of every later/unlogged callback.',
    'Worker metadata receive phase is host attribution; after dispose stdio closure may suppress late logs.',
    'Bare source simplifies envelope validation and direct holder shares request context; both remain diagnostic variants and cannot pass the original suite.',
    'Remote ZIP hash is only source-reported in Root analysis; this reviewer has not downloaded or independently verified that archive.',
    'No fixed runtime comparison or causal C++ trace is supplied, so causeProven remains false; G7/G8 or production holder readiness is not inferred.'
  ],
  reviewerActions: { onlyLocalArtifactReadsAndNewTempWrites: true, repositoryWrites: 0, gitCommands: 0, sourceChanges: 0,
    ciRequests: 0, runtimeReruns: 0, productionRequests: 0, databaseRequests: 0, historicalCommandsRerun: false },
  reviewerEntryFailurePreserved: { chunkId: '6bec7e', actualExitCode: 1, issue: 'Reviewer asserted Node fatal exact null, but undefined fatal is omitted by JSON serialization. Corrected reviewer to accept absent fatal; original runtime artifacts were not changed.' },
  causeProven: false };
const body = Buffer.from(JSON.stringify(report, null, 2) + '\n');
const path = join(here, 'FINAL-boundary-actual-linux-readonly-review.json');
writeFileSync(path, body, { flag: 'wx' }); writeFileSync(path + '.sha256', sha(body) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ actualExit: 0, report: path, bytes: body.length, sha256: sha(body), diagnosticActualExit: 1,
  originalHashCheckedFiles: originalFiles.length, sealedPackageFiles: packageFiles.length, workflowPresent: existsSync(workflowPath),
  ownerCommandReceiptsChecked: prepCommands.length, allSixCancelNull: true, outerUnforcedGroupClose: true, gracefulWorkerdExitProven: false, causeProven: false }));
