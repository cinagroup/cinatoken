import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-request-signal-readonly-yCKd6V';
const repo = 'C:/cinagroup/cinatoken';
const beganAt = new Date().toISOString();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: hash(b) }; };
const read = relative => JSON.parse(fs.readFileSync(`${root}/${relative}`, 'utf8'));
const audit = read('static-source-event-audit-v2.json');
assert.equal(audit.actualReadAuditExit, 0);
assert.equal(audit.checks.length, 31);
assert(audit.checks.every(c => c.verified === true));
for (const row of audit.snapshots) {
  assert.deepEqual(descriptor(row.original.path), row.original);
  assert.deepEqual(descriptor(row.copy.path), row.copy);
  assert.deepEqual(fs.readFileSync(row.original.path), fs.readFileSync(row.copy.path));
}
const receipts = [];
for (const [label, expected] of [['official-source-read', 1], ['official-source-public-read', 1], ['official-source-authorized-read', 0], ['static-source-event-read', 1], ['static-source-event-read-v2', 0], ['seal-request-signal', 1]]) {
  const file = `${root}/${label}.result.json`;
  const value = JSON.parse(fs.readFileSync(file));
  assert.equal(value.closed, true);
  assert.equal(value.actualExit, expected);
  assert.equal(value.signal, null);
  assert.equal(value.timedOut, false);
  assert.equal(value.spawnError, null);
  assert(Date.parse(value.beganAt) <= Date.parse(value.endedAt));
  for (const stream of ['stdout', 'stderr']) assert.deepEqual(descriptor(value[stream].path), value[stream]);
  receipts.push({ label, receipt: descriptor(file), actualExit: value.actualExit, closed: true, stdout: value.stdout, stderr: value.stderr });
}
const officialRead = read('official-locked-source-public-read.json');
assert.equal(officialRead.actualSourceReadExit, 0);
assert.equal(officialRead.results.length, 4);
for (const row of officialRead.results) {
  assert.equal(row.httpStatus, 200);
  const actual = descriptor(row.output.path);
  assert.deepEqual(actual, row.output);
}
const sourceReferences = audit.physicalSourceRanges.map(r => ({ source: r.source, beginOneBased: r.beginOneBased, endOneBased: r.endOneBased, reason: r.reason }));
const official = name => `https://github.com/cloudflare/workerd/blob/v1.20260828.1/src/workerd/${name}`;
const report = {
  schema: 'cinatoken-v364-request-signal-next-readonly-diagnosis-v1',
  beganAt, endedAt: new Date().toISOString(), actualReadAndSealExit: 0,
  preparedAtObservedHEAD: '4a9b4fb984035bb62ec5930cce01f8da605f476f',
  actualRuntimeSHA: 'dc7be6f8597333151c450bae3ae15e6585e3b2eb', actualRuntimeRun: '37414167261',
  result: 'STATIC_DIAGNOSIS_ONLY_STRICT_V364_STILL_FAILED',
  summary: 'enable_request_signal is supported, opt-in and already configured on every original direct worker. Two real holder RST requests aborted their incoming signal during the original poll while all four transport source-cancel assertions remained NULL/1. Missing flag is therefore contradicted for those two RST requests; suspended response-pump cancellation remains a source-supported but unproven candidate.',
  executionBoundary: { repoWrite: false, gitWrite: false, sourceChange: false, productionRequests: 0, appExecution: 0, nativeExecution: 0, ciInvocation: 0, oldArchiveGateRerun: 0, publicPrimarySourceReads: 4, localReadAndCollectionOnly: true, gatePassDerived: false, originalFullScopeUnchanged: true, newComparisonArmImplemented: false, newComparisonArmExecuted: false },
  exactEvidence: {
    audit: descriptor(`${root}/static-source-event-audit-v2.json`),
    archivedArtifactRoot: audit.artifactRoot,
    eventDecodedDescriptors: audit.decoded.filter(r => r.originalName.startsWith('events.')),
    eventSequenceCount: 1643, jsonNDJSONSequenceExact: true,
    holderRSTSignalAborts: audit.signalAbortLogs,
    selectedRelevantFrozenInputs: audit.selectedInputCount, exactSourceSnapshots: audit.snapshots.length,
    installedSourceMatchesActualRecordedLinuxSHA: audit.installed,
    primaryTagRawFetch: descriptor(`${root}/official-locked-source-public-read.json`),
    primaryTagFiles: officialRead.results.map(r => ({ url: r.url, httpStatus: r.httpStatus, file: r.output })),
    childReceipts: receipts,
  },
  knownFacts: [
    { fact: 'Locked compatibility schema has explicit enable_request_signal and disable_request_signal and no default enable date. Compatibility date alone is insufficient to enable this locked feature.', evidence: [official('io/compatibility-date.capnp#L794-L798')], physicalLines: [794, 798], classification: 'LOCKED_SOURCE_FACT' },
    { fact: 'Official docs describe the flag as exposing incoming cancellation through Request.signal. This is an incoming request signal contract, separate from invocation of a JavaScript response-source cancel algorithm.', evidence: ['https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests', 'https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/'], classification: 'PRIMARY_DOCUMENTATION_FACT' },
    { fact: 'Actual diagnostic uses Workerd1.20260828.1, Miniflare5.20260828.0-alpha, Wrangler4.127.1. Both frozen JSONCs contain nodejs_compat and enable_request_signal. Runtime creates bare, gateway and holder at 2026-09-04 with those same flags; frozen JSONC date is separately2026-09-25.', evidence: [`${repo}/scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs:173`, `${repo}/scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs:435`], classification: 'SOURCE_AND_ACTUAL_METADATA_FACT' },
    { fact: 'unsafeDirectSockets maps the actual entry user worker listener; unsafeGetDirectURL selects that listener. The four direct arms bypass the Miniflare Core ENTRY worker. The binding variant still retains the user gateway → service binding → holder hop.', evidence: [`${repo}/node_modules/miniflare/dist/src/index.js:113163`, `${repo}/node_modules/miniflare/dist/src/index.js:113668`], classification: 'LOCKED_INSTALLED_SOURCE_AND_ACTUAL_METADATA_FACT' },
    { fact: 'Core ENTRY delegates service.fetch and applies response transforms; bypassing it does not remove Workerd own HTTP response pump or the gateway service-binding leg.', evidence: [`${repo}/node_modules/miniflare/dist/src/workers/core/entry.worker.js:5186`], classification: 'LOCKED_INSTALLED_SOURCE_FACT' },
    { fact: 'BareRST and bindingRST each emitted one holder signal-abort with abortedtrue during original-poll. Exact event indices460/1269 and NDJSON lines461/1270 are preserved with line hashes. This proves incoming signal delivery for these two concrete requests, not for destroy or gateway, and not source cancellation.', evidence: ['exactEvidence.holderRSTSignalAborts'], classification: 'ACTUAL_EVENT_FACT' },
    { fact: 'All original four transport arms retain100polls×10ms, NULL/1. Their4s tails retain NULL and usedForPassfalse. Baseline actual1 remains8tests/7pass/1fail. Workerd explicit reader.cancel calibration is0 and has no added lifetime task; it proves local source cancel is reachable, not that disconnect automatically invokes it.', evidence: [audit.snapshots[0].original.path], classification: 'ACTUAL_RUNTIME_FACT' },
    { fact: 'Original holder async pull waits for KV release with original timer; original source cancel writes cancel observation and retains the same promise in original ctx.waitUntil. It does not install request.signal → reader.cancel glue. Gateway constructs holder Request with request.signal and returns upstream response.body.', evidence: [`${repo}/packages/proxy/scripts/staging/chat-holder-private-v364.ts:65`, `${repo}/packages/proxy/scripts/staging/chat-holder-gateway-v364.ts:9`], classification: 'PROTECTED_SOURCE_FACT' },
    { fact: 'Executor actualProcessExit/runnerOutcome/actualExit all1, no timeout or interruption; owned group absent and direct child reaped, no signal attempts or leftover kill. Four adopted esbuild zombies were individually reaped. Outer unforced close is not graceful Workerd exit proof; Miniflare disposal may kill Workerd.', evidence: [audit.snapshots[1].original.path], classification: 'ACTUAL_EXECUTOR_FACT' },
  ],
  causalAssessment: {
    contradictedForRealRST: 'The two RST failures cannot be explained by enable_request_signal being absent or wholly nonfunctional: the exact holder listeners fired before disposal in the original-poll phase.',
    stillUnknown: ['Exact response-body pump state and cancellation path at those two transport disconnects were not instrumented in the locked C++ binary.', 'Missing signal logs on destroy or gateway are not proof a callback can never fire; absence is bounded to this recorded event set/window.', 'The archived source and public locked-tag source support static reasoning; no binary build attestation or C++ trace establishes the exact branch taken.', 'Node TCP destroy and abortive RST are distinct transport teardown cases; RST signal delivery does not establish destroy semantics.'],
    candidate: { status: 'SUPPORTED_STATIC_CANDIDATE_NOT_CONFIRMED_CAUSE', mechanism: 'The locked JS response pump owns a DrainingReader in a KJ coroutine. Its comment states dropping the returned promise destroys the frame/reader/sink while isolate read tasks can outlive it. The explicit reader.cancel call is in the KJ exception path. DrainingReader destruction calls releaseReader with no JS lock, which clears reader references without calling the JS underlying-source cancel in the shown routine. This is compatible with dropping a pump suspended on an asynchronous read yielding request-signal abort but no JS source-cancel observation.', evidence: [official('api/streams/standard.c++#L3515-L3607'), official('api/streams/standard.c++#L291-L324'), official('api/streams/readable.c++#L284-L288')], limitation: 'Compatible static control flow is not proof that the failed project response ran this teardown branch.' },
    issueContext: { url: 'https://github.com/cloudflare/workerd/issues/6832', classification: 'AUTHOR_REPORTED_REPRODUCTION_CONTEXT_ONLY', note: 'The report describes asynchronous response-source cancel missing while explicitly enabled Request.signal still aborts in direct and proxied topologies. Its versions, payload and timing differ from this locked project run; it does not prove our cause.' },
    proposedUpstreamPatchContext: { url: 'https://github.com/cloudflare/workerd/pull/6833', observedState: 'Open in read-only browser observation on2026-10-06', adopted: false, note: 'A proposed dropped-pump source-cancel fix is relevant context only. No package, runtime, product flag, upstream patch or assertion was changed.' },
  },
  minimalFutureComparison: {
    recommendationNow: 'No new run is required to establish signal-enabled-vs-source-cancel separation on the two real RST arms. Their actual observations already establish it. Keep the locked pump teardown candidate for the next explicitly authorized diagnostic rather than treating a flag addition as a fix.',
    optionalSingleNegativeControl: {
      name: 'bare-rst-disable-request-signal', status: 'NOT_IMPLEMENTED_NOT_EXECUTED', baselineEligible: false, diagnosticVariant: true,
      pair: 'original enabled bareRST reference, unchanged',
      onlyChange: 'On one additional fresh bare fixture only, replace enable_request_signal with disable_request_signal, retaining nodejs_compat, runtime date2026-09-04, locked dependencies, exact bare source/holder observer and direct socket.',
      unchanged: ['original four arms and strict fixtures/assertions', 'same Node abortive RST after exact holder-ready frame and same request method/headers/body/envelope', '100polls×10ms and separate4s usedForPassfalse tail', 'original production holder/gateway and ctx.waitUntil behavior', 'source snapshots and no version/date upgrade', 'original baseline8/7/1 stays authoritative1'],
      requiredEvidence: ['seal the one-arm config/source and pair identities', 'require actual user direct socket, first frame, acceptedone and original-pull observation before RST', 'record holder incoming-signal initial/abort and source cancel observation separately with phase/timestamps', 'preserve actual client socket close/error and code; any timeout/null process exit stays failed/unknown', 'record pre-dispose KV snapshot independently; do not use disposal logs as transport success', 'same bounded owned-process executor with stdout/stderr SHA and verified absence'],
      interpretation: ['Enabled aborttrue/cancelNULL is already observed and rules out missing flag for that pair.', 'Disabled missing abort and cancelNULL would confirm a flag negative control only; it would not identify or fix the stream pump.', 'Disabled aborttrue requires investigating config/log association before any conclusion.', 'An unexpected source cancel in either comparison is evidence to retain, not permission to replace original transport failures or merge it into strict pass counts.'],
      prohibitedSubstitutions: ['No abort listener manually calls reader.cancel to make a transport test pass.', 'No request_signal_passthrough addition or imitation API.', 'No added waitUntil task, longer strict poll, skipped timeout, removed expectation, production flag edit or dependency upgrade.'],
    },
    nextCauseEvidenceNeeded: 'A future controlled comparison must actually distinguish pump-drop from exception-driven cancellation on this locked binary/topology. Existing Node calibration and explicit Workerd reader.cancel are distinct control paths; they cannot replace the transport assertion. No such additional runtime evidence was obtained in this read-only task.',
  },
  sourceReferences,
  preservedNewReaderFailures: [
    { label: 'official-source-read', actualExit: 1, reason: 'sandbox EACCES fetch failures; no primary source bytes obtained in that attempt' },
    { label: 'official-source-public-read', actualExit: 1, reason: 'prepared copied reader file absent after separate shell quoting error; no application/runtime execution' },
    { label: 'static-source-event-read', actualExit: 1, reason: 'local reader selected wrong calibration JSON field; original runtime data unchanged; original reader source/log/receipt retained and corrected reader saved separately' },
    { label: 'seal-request-signal', actualExit: 1, reason: 'local sealer selected wrong official-read metadata field; no FINAL was written and original metadata unchanged; first sealer source and raw receipt retained' },
  ],
  scopeAndDeployment: { fullGoalComplete: false, strictV364Passed: false, fullG7Passed: false, G8Passed: false, productionVersionUnchanged: 'c13 / 2a0 / 100% /29true is inherited task context, not newly fetched here', noProductionRequestOrDeployment: true, original102And54And211AndG0G8ScopeNotChanged: true },
};
const out = `${root}/FINAL-v364-request-signal-readonly-diagnosis.json`;
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ report: descriptor(out), actualReadAndSealExit: 0, archivedRuntimeActualExit: 1, strictV364Passed: false, sourceChange: false, runtimeExecuted: false }));
