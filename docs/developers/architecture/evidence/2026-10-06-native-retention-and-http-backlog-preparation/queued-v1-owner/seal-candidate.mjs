import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-candidate-125e5fd5336c42b18c0bb59dda8f4942';
const desc = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const read = relative => JSON.parse(fs.readFileSync(`${root}/${relative}`));
const proof = read('candidate-static-protection-proof.json');
assert.equal(proof.actualStaticVerificationExit, 0);
for (const key of ['before', 'candidate', 'newHelper', 'extension', 'editIndex']) assert.deepEqual(desc(proof[key].path), proof[key]);
const index = read('candidate-edit-index.json');
assert.deepEqual(fs.readFileSync(index.source), fs.readFileSync(proof.before.path));
for (const row of index.protectedInputs) { assert.deepEqual(fs.readFileSync(row.path), fs.readFileSync(row.copy)); assert.equal(desc(row.path).sha256, row.sha256); }
const receipts = [];
for (const relative of ['build-candidate.result.json', 'verify-candidate.result.json']) {
  const r = read(relative); assert.equal(r.closed, true); assert.equal(r.actualExit, 0); assert.equal(r.signal, null); assert.equal(r.timedOut, false); assert.equal(r.spawnError, null);
  for (const s of ['stdout', 'stderr']) assert.deepEqual(desc(r[s].path), r[s]);
  receipts.push({ receipt: desc(`${root}/${relative}`), actualExit: r.actualExit, stdout: r.stdout, stderr: r.stderr });
}
for (const r of proof.syntax) { assert.equal(r.closed, true); assert.equal(r.actualExit, 0); assert.equal(r.signal, null); assert.equal(r.error, null); for (const s of ['stdout', 'stderr']) assert.deepEqual(desc(r[s].path), r[s]); }
const report = {
  schema: 'cinatoken-v364-finite-queued-write-temp-candidate-final-v1', at: new Date().toISOString(), actualLocalPreparationAndSealExit: 0,
  result: 'REVIEWABLE_TEMP_CANDIDATE_NO_RUNTIME_EXECUTION_NO_FIX_CLAIM',
  sourceContext: { suppliedByRoot: '6e2d65b3 original CI observing; no Git used to resolveHEAD in this task', actualRepositoryPath: index.source, requestedStagingPathDidNotExist: true, originalSourceBytesUnchanged: true },
  candidate: proof.candidate, helper: proof.newHelper, before: proof.before, extension: proof.extension,
  protection: { proof: desc(`${root}/candidate-static-protection-proof.json`), editIndex: proof.editIndex, protectedInputs: index.protectedInputs, entireCandidateEditsReverseByteExact: true, allOriginalTopLevelFunctionNames: proof.protectedOriginalFunctions, allOriginalFunctionASTAndBytesExact: true, originalAssertCount: proof.originalAssertCount, allOriginalAssertASTMultiplicityRetained: true, originalFourTransportScheduleASTAndBytesExact: true, originalFiveResultsArrayStillFive: true, originalStrictOverallFormulaASTExact: true, originalBaselineEightTestsAndNodeCalibrationFunctionsExact: true, originalVersionsFlagsDatePollTailAndWaitUntilContractRetained: true },
  design: {
    onlyAdditionalArm: 'direct-socket-bare-rst-queued-write', baselineEligible: false, directSocket: true, coreEntryBypassed: true,
    stages: ['Run original strict baseline, native reader calibration and four transport arms unchanged.', 'Create one additional fresh bare user-worker socket at same locked date/flags.', 'Receive exactready frame, pause response and client socket; keep original POST/envelope/first-frame guards.', 'Only then write a distinct synthetic queued-trigger key; source allocates and enqueues the finite payload.', 'Observe two successive owned Workerd kernelTCP tx_queue samples, then sample synchronously immediately before the original RST API invocation.', 'Run the same100polls×10ms original cancel expectation and4s tail usedForPassfalse, preserve accepted/release and pre-dispose snapshot.', 'Record the independent comparison outside original five results; unknown/failure stays actual1 and cannot wash the original baseline failure.'],
    allocation: { controlledJSPayloadBytes: 8388608, readyFrameUTF8Bytes: 16, chunkCount: 128, chunkBytes: 65536, payloadAllocationsPerOwnedRequest: 1, viewBuffersReferenceSameAllocation: true, unboundedSourceProduction: false, controllerCloseBeforeRST: false, totalProcessOrKernelMemoryBoundedTo8MiB: false, note: '8MiB is the explicit JavaScript payload allocation cap; view metadata, framework copies and kernel buffers are additional. Only one owned request is issued to this fresh fixture.' },
    timing: { extraArmOuterBoundMs: 30000, newSourceTriggerPollMax: 100, triggerPollSleepMs: 10, newPreRSTPressureSamplingMax: 100, pressureSamplingSleepMs: 10, cancelPollMax: 100, cancelPollSleepMs: 10, diagnosticTailMs: 4000, tailUpgradesPass: false, oldArmBudgetsChanged: false, oldPythonExecutorOrWorkflowChanged: false },
    distinctCallbacks: { requestSignalAbort: 'real incoming signal listener logs queued-source signal-abort', syntheticCleanupHook: 'separate synchronous hook drops a local payload reference and logs invoke/return; no KV write, reader cancellation or new lifetime task', realStreamSourceCancel: 'only the actual underlying-source cancel callback writes original cancel:<nonce>; its original put/waitUntil/await core AST matches the frozen bare source', businessCleanupProof: false, payloadMemoryFreedProof: false, manualReaderCancelFromSignal: false },
  },
  pressureEvidence: {
    runtimeExecuted: false, runtimePressureStatus: 'unknown/not executed',
    required: ['Complete current process census from owned pgrp/session.', 'Exactly one live Workerd PID; same startTimeTicks/pgrp/session before and after reading.', 'Exact established IPv4 loopback server/client socket tuple from direct listener and actual client ports.', 'TCP inode belongs to exactly one FD of that owned Workerd PID.', 'Two consecutive positive tx_queue samples plus finite-enqueue log observed before disconnect.', 'Same PID/start/inode and positive tx_queue sampled again synchronously immediately before RST; sample age under100ms.'],
    knownFailureBehavior: 'Unreadable/raced/unmatched/multiple PID, tuple or FD, absent enqueue log, nonpositive queue or missing immediate sample stays pressureunknown and comparisonactual1; raw per-sample error/tuple/queue data retained.',
    interpretation: 'Positive /proc TCP tx_queue is evidence of kernel outstanding send backlog. It does not separate unsent from unacknowledged data and does not prove the C++ pump is currently awaiting sink.write, that its coroutine was dropped, or that the DrainingReader destructor was reached. Those C++ claims remain unknown even if every kernel criterion succeeds.',
    branchConclusion: 'unknown', cppPendingWriteProven: false, workerdPumpDropProven: false, readerDestructorProven: false,
  },
  adequacy: { reviewableExecutableCandidate: true, enoughForFiniteQueuedDataAndOwnedKernelBacklogObservation: true, enoughToConfirmCppPumpBranchOrCause: false, currentPressureActuallyObserved: false, value: 'Compare source-data availability and concrete owned TCP backlog with unchanged async-read failures, while distinguishing real signal, synthetic cleanup hook and actual source cancel. An outcome can narrow a boundary; it cannot by itself establish a runtime defect or satisfy original transport tests.' },
  applicationPrerequisites: ['Root and independent source review must approve before any repository application.', 'Add helper and candidate runner to the owned package input seal and recompute exact descriptors; current immutable sealed package is not updated here and must not be bypassed.', 'No dependency, compatibility flag/date, original fixture, Python ownership executor, workflow timer or production holder change.', 'SameSHA owned Linux execution must preserve actual baseline8/7/1 and original four results even if the extra arm succeeds; do not combine the extra result into the original strict pass count.', 'All failed or unknown Linux results, raw events, per-command closure and true cleanup evidence must be retained.'],
  localVerification: { sourceASTOnly: true, syntaxOnly: true, nodeSyntaxChecksActualExit: proof.syntax.map(r => r.actualExit), moduleEvaluated: false, commands: receipts, syntax: proof.syntax },
  boundary: { repositoryWrite: false, gitExecution: false, mdChange: false, ciInvocation: false, prepareOnlyOriginalRunnerExecuted: false, workerdOrMiniflareInstantiated: false, appOrPGOrNativeExecution: false, productionRequests: 0, newSourceFetch: 0, old59Or27EvidenceTouched: false, strictV364Passed: false, fullG7Passed: false, fullG8Passed: false, fullGoalComplete: false, gatePassDerived: false },
};
const file = `${root}/FINAL-queued-write-candidate-preparation.json`;
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ final: desc(file), actualLocalPreparationAndSealExit: 0, runtimeExecuted: false, enoughToConfirmCppPumpBranch: false }));
