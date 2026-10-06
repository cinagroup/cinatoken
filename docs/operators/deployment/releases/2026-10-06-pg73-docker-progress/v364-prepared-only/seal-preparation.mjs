import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = 'C:/cinagroup/cinatoken';
const sha = b => createHash('sha256').update(b).digest('hex');
const sealedInputs = JSON.parse(readFileSync(join(here, 'source-inputs.json')));
for (const item of sealedInputs) { const data = readFileSync(join(repo, item.path)); assert.equal(data.length, item.bytes); assert.equal(sha(data), item.sha256); }
const checks = [];
for (const path of ['gateway-observer.mjs', 'holder-observer.mjs', 'run-v364-owned-diagnostic.mjs', 'seal-preparation.mjs']) {
  const r = spawnSync(process.execPath, ['--check', join(here, path)], { encoding: 'utf8' });
  checks.push({ name: 'Node syntax ' + path, actualExit: r.status, stderr: r.stderr }); assert.equal(r.status, 0);
}
const python = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const py = spawnSync(python, ['-c', 'import ast,sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_text()); print("syntax-only AST OK")', join(here, 'execute-owned-linux.py')], { encoding: 'utf8' });
checks.push({ name: 'bundled Python executor AST only', actualExit: py.status, stdout: py.stdout, stderr: py.stderr }); assert.equal(py.status, 0);
const preparation = JSON.parse(readFileSync(join(here, 'prepared-final/prepare-only.json')));
assert.equal(preparation.actualExit, 0); assert.equal(preparation.runtimeExecuted, false); assert.deepEqual(preparation.inputsBefore, sealedInputs);
const files = ['gateway-observer.mjs', 'holder-observer.mjs', 'run-v364-owned-diagnostic.mjs', 'execute-owned-linux.py',
  'owned-linux-plan.md', 'source-inputs.json', 'prepared-final/prepare-only.json', 'seal-preparation.mjs']
  .map(path => { const b = readFileSync(join(here, path)); return { path, bytes: b.length, sha256: sha(b) }; });
const manifest = JSON.stringify({ schema: 'v364-owned-linux-sealed-package-v1', files }, null, 2) + '\n';
writeFileSync(join(here, 'sealed-package.json'), manifest);
const historicPath = 'C:/Users/cina/AppData/Local/Temp/cinatoken-workerd-cancel-diagnosis-393aa84d3e474d2184c6c0b189c803a9/FINAL-workerd-v364-cancel-diagnosis.json';
const oldData = readFileSync(historicPath);
const old = JSON.parse(oldData);
const sourceProofs = old.decodedSources.map(item => {
  const data = readFileSync(item.source.path); assert.equal(sha(data), item.source.sha256); return item;
});
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }); assert.equal(head.status, 0);
const report = { schema: 'v364-owned-linux-diagnostic-preparation-closed-v1', endedAt: new Date().toISOString(), actualExit: 0,
  outcome: 'PREPARED_ONLY_NO_NATIVE_EXECUTION', repositoryHeadAtClose: head.stdout.trim(),
  lockedRuntime: preparation.versions, localSyntaxNode: process.version, plannedLinuxNodeMajor: 22,
  originalStrictFailure: { source: 'Root supplied current run; not polled by this subagent', runId: 37390678189,
    step: 27, tests: 8, passed: 7, failed: 1, cancellationActual: null, stillFailed: true },
  checks, nonFatalPreparationToolFailure: { tool: 'python on PATH', error: 'command not found', recoveredWithBundledPythonASTOnly: true },
  sourceInputs: sealedInputs, sourceInputsUnchanged: true,
  package: { path: join(here, 'sealed-package.json'), bytes: Buffer.byteLength(manifest), sha256: sha(manifest), files },
  bundleHashes: preparation.bundleHashes,
  historicalReport: { path: historicPath, bytes: oldData.length, sha256: sha(oldData), retained: true },
  pinnedPrimarySourceProofs: sourceProofs,
  verifiedContracts: {
    clientDestroy: 'dedicated HTTP connection and incomplete response are asserted; destroy alone does not establish TCP RST',
    clientRST: 'Node22 resetAndDestroy specifies TCP RST; owned differential also records server-side peer events',
    requestSignal: 'enable_request_signal exposes incoming abort event; separate request_signal_passthrough is absent from frozen flags',
    lockedSignalBranch: 'worker-entrypoint lines460-463: passthrough false chooses IGNORE_FOR_SUBREQUESTS; no flag is changed in baseline',
    lockedSchemaCaution: 'requestSignalPassthrough comment in compatibility-date.capnp contradicts executable branch; docs and branch support conclusion',
    sourceCancel: 'original private cancel first invokes cancel-category KV put; waitUntil is registered only after that invocation',
    holderSignal: 'original holder does not register an abort listener; forwarded signal is not equivalent to JS source cancellation',
    originalWindow: '100 KV reads and 10ms sleep after each null; elapsed includes KV latency and is measured',
  },
  nextAction: { rootReviewRequired: true, ownedLinuxRunsPrepared: 1, matrixCases: 8, sourceOrFlagBaselineChanges: 0,
    originalTestsRunOnceInNewJob: true, variantBaselineEligible: false, diagnosticTailMs: 4000, tailUsedForPass: false,
    caseTimeoutMs: 30000, originalTestTimeoutMs: 30000, outerTimeoutMs: 320000, termGraceMs: 10000,
    artifactPlan: 'always upload TAP stdout/stderr, events.json, closed-result.json and executor.closed.json; preserve actual exit, no auto-retry' },
  cause: { proven: false, observabilityCanLocalize: true, upstreamMatchIsCandidateOnly: true,
    proofNeeded: 'unchanged strict suite against a reviewed corrected-runtime differential, or direct traces proving the failing runtime path',
    noPassUpgradeFromTailOrVariant: true, observerPerturbationMustBeCompared: true },
  primaryLinks: [
    'https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-request-signal',
    'https://nodejs.org/docs/latest-v22.x/api/net.html#socketresetanddestroy',
    'https://nodejs.org/download/release/v22.15.0/docs/api/http.html#messagecomplete',
    'https://streams.spec.whatwg.org/#generic-reader-cancel',
    'https://github.com/cloudflare/workerd/issues/6832', 'https://github.com/cloudflare/workerd/pull/6833',
  ], primaryReadLimitation: 'PR7600 current web fetch cache miss; old sealed pinned patch retained and no fresh PR status claimed',
  runtimeExecuted: false, nativeRuntimeStarts: 0, ciInvocations: 0, ciPolls: 0, productionRequests: 0,
  databaseRequests: 0, realIdentityActions: 0, productionDeployments: 0, rootSourceEditsByThisTask: 0,
  dependencyChanges: 0, defaultOffHolderChanged: false,
};
const text = JSON.stringify(report, null, 2) + '\n';
writeFileSync(join(here, 'FINAL-v364-owned-linux-diagnostic-preparation.json'), text);
writeFileSync(join(here, 'FINAL-v364-owned-linux-diagnostic-preparation.sha256'), sha(text) + '\n');
console.log(JSON.stringify({ actualExit: 0, path: join(here, 'FINAL-v364-owned-linux-diagnostic-preparation.json'), bytes: Buffer.byteLength(text), sha256: sha(text), manifestSHA256: sha(manifest), runtimeExecuted: false }));
