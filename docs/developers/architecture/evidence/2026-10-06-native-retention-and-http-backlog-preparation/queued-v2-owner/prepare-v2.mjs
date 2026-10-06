import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-v2-8e7e441d5c7547dc93ae0c2c76898bf8';
const v1 = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-candidate-125e5fd5336c42b18c0bb59dda8f4942';
const repoSource = 'C:/cinagroup/cinatoken/scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs';
const require = createRequire('C:/cinagroup/cinatoken/package.json');
const acorn = require('acorn');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const desc = path => { const b = fs.readFileSync(path); return { path, bytes: b.length, sha256: hash(b) }; };
const write = (relative, bytes) => fs.writeFileSync(`${root}/${relative}`, bytes, { flag: 'wx' });
const readJSON = file => JSON.parse(fs.readFileSync(file));
const beganAt = new Date().toISOString();
const stop = desc(`${v1}/STOPWRITE.json`);
assert.equal(stop.sha256, 'db8403d20e848497d66eb779a9322685d03fbe9cc1e581cdc74bffeb6c6f0c19');
const v1Index = readJSON(stop.path);
const pinned = relative => {
  const row = v1Index.files.find(r => r.relative === relative); assert(row);
  const actual = desc(`${v1}/${relative}`); assert.equal(actual.bytes, row.bytes); assert.equal(actual.sha256, row.sha256); return actual;
};
const v1Candidate = pinned('run-direct-socket.candidate.mjs');
const oldSource = pinned('run-direct-socket.before.mjs');
const helper = pinned('queued-write-source.mjs');
const v1Final = pinned('FINAL-queued-write-candidate-preparation.json');
assert.equal(v1Candidate.sha256, 'e6cfdb5d6e3d8ab04b4bc97d278132b4439930a92465bcf72081ccc173dbb04e');
assert.equal(helper.sha256, '93417db1e3b0edbb3dd06b504bddee18ba6fbb1bbf31141cd20ce119dea7fb5d');
assert.deepEqual(fs.readFileSync(repoSource), fs.readFileSync(oldSource.path));
const before = fs.readFileSync(v1Candidate.path, 'utf8');
let candidate = before;
const deltas = [];
function replace(old, next, reason) {
  assert.equal(candidate.split(old).length - 1, 1, reason);
  candidate = candidate.replace(old, next); deltas.push({ old, next, reason });
}
replace('return { at, known: true, pid: owner.pid,', 'return { at, sampleEndedAt: performance.now(), known: true, pid: owner.pid,', 'Known sample records sampling/validation completion time');
replace('return { at, known: false, error: errorSafe(error),', 'return { at, sampleEndedAt: performance.now(), known: false, error: errorSafe(error),', 'Unknown sample retains completion time too');
replace('pressureBeforeReset: null,\n', 'pressureBeforeReset: null,\n\t\t\t\t\tresetInvokeAt: null,\n', 'New queued client keeps explicit actual RST invocation timestamp');
replace('\t\t\t\t\t\t\t\tsocket.resetAndDestroy();\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\trequest.destroy();', '\t\t\t\t\t\t\t\tthis.resetInvokeAt = performance.now();\n\t\t\t\t\t\t\t\tsocket.resetAndDestroy();\n\t\t\t\t\t\t\t\tevent(caseId, "queued-rst-api-return", { resetInvokeAt: this.resetInvokeAt, resetReturnedAt: performance.now() });\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\trequest.destroy();', 'Only queued function RST timestamp immediately precedes actual API; independent post-call event');
replace('result.immediatePreRST = client.pressureBeforeReset;\n', 'result.immediatePreRST = client.pressureBeforeReset;\n\t\tresult.resetInvokeAt = client.resetInvokeAt;\n', 'Record actual invocation timestamp in queued result');
replace('client.pressureBeforeReset.at - prior.at < 100', 'Number.isFinite(result.resetInvokeAt) && Number.isFinite(prior.sampleEndedAt) && Number.isFinite(client.pressureBeforeReset.sampleEndedAt) && prior.sampleEndedAt <= result.resetInvokeAt && client.pressureBeforeReset.sampleEndedAt <= result.resetInvokeAt && result.resetInvokeAt - prior.sampleEndedAt >= 0 && result.resetInvokeAt - prior.sampleEndedAt < 100', 'Age derives from actual RST invoke minus completed sample, nonnegative and under100ms');
let reverse = candidate;
for (const d of [...deltas].reverse()) { assert.equal(reverse.split(d.next).length - 1, 1); reverse = reverse.replace(d.next, d.old); }
assert.equal(reverse, before);
const parse = text => acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
const clean = v => Array.isArray(v) ? v.map(clean) : !v || typeof v !== 'object' ? v : Object.fromEntries(Object.entries(v).filter(([k]) => !['start', 'end', 'loc'].includes(k)).map(([k, value]) => [k, clean(value)]));
const beforeAST = parse(before), afterAST = parse(candidate), originalAST = parse(fs.readFileSync(oldSource.path, 'utf8'));
const changedNames = ['queuedSendBacklog', 'queuedWriteHttpClient', 'queuedWritePressureCase'];
const unchanged = ast => ast.body.filter(n => !(n.type === 'FunctionDeclaration' && changedNames.includes(n.id.name)));
assert.deepEqual(clean(unchanged(afterAST)), clean(unchanged(beforeAST)));
const originalFunctions = originalAST.body.filter(n => n.type === 'FunctionDeclaration');
for (const original of originalFunctions) {
  const after = afterAST.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === original.id.name); assert(after);
  assert.deepEqual(clean(after), clean(original));
  assert.equal(candidate.slice(after.start, after.end), fs.readFileSync(oldSource.path, 'utf8').slice(original.start, original.end));
}
for (const name of changedNames) {
  const oldFn = beforeAST.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  const newFn = afterAST.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert(oldFn && newFn); assert.notDeepEqual(clean(oldFn), clean(newFn));
}
const client = afterAST.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'queuedWriteHttpClient');
const clientText = candidate.slice(client.start, client.end);
assert(clientText.includes('this.resetInvokeAt = performance.now();\n\t\t\t\t\t\t\t\tsocket.resetAndDestroy();'));
assert(clientText.includes('"queued-rst-api-return"'));
const ownCandidate = `${root}/run-direct-socket.candidate-v2.mjs`;
write('run-direct-socket.candidate-v2.mjs', candidate);
const nodeStartedAt = new Date().toISOString();
const node = spawnSync(process.execPath, ['--check', ownCandidate], { windowsHide: true, timeout: 15000, maxBuffer: 1048576 });
write('node-check.stdout.log', node.stdout ?? Buffer.alloc(0)); write('node-check.stderr.log', node.stderr ?? Buffer.alloc(0));
const nodeReceipt = { schema: 'cinatoken-queued-v2-node-syntax-closed-v1', closed: true, startedAt: nodeStartedAt, endedAt: new Date().toISOString(), program: process.execPath, args: ['--check', ownCandidate], actualExit: node.status, signal: node.signal, error: node.error ? { name: node.error.name, code: node.error.code ?? null } : null, stdout: desc(`${root}/node-check.stdout.log`), stderr: desc(`${root}/node-check.stderr.log`), moduleEvaluated: false, runtimeExecuted: false };
write('node-check.result.json', `${JSON.stringify(nodeReceipt, null, 2)}\n`);
assert.equal(node.status, 0); assert.equal(node.signal, null); assert.equal(node.error, undefined);
assert.deepEqual(fs.readFileSync(repoSource), fs.readFileSync(oldSource.path));
const report = {
  schema: 'cinatoken-v364-queued-write-v2-timestamp-candidate-final-v1', beganAt, endedAt: new Date().toISOString(), actualLocalPreparationVerification: 0,
  result: 'TEMP_CANDIDATE_PREPARED_NO_RUNTIME_OR_GATE_PASS',
  candidate: desc(ownCandidate), unchangedHelperReference: helper, v1CandidateReference: v1Candidate, v1FinalReference: v1Final, v1StopWriteReference: stop, unchangedRepositorySourceReference: { ...desc(repoSource), exactOldSourceReference: oldSource },
  deltas, onlyChangedExtraFunctions: changedNames, reverseEntireV1BytesExact: true, allOtherV1TopLevelASTExact: true, allOriginal13FunctionsASTAndBytesExact: true, originalBaselineFourArmsAndReaderCalibrationNotChanged: true, helperNotCopiedOrChanged: true,
  timestampSemantics: { at: 'sampling attempt start retained', sampleEndedAt: 'known or unknown sampling attempt completed before return', resetInvokeAt: 'performance.now immediately before socket.resetAndDestroy in only queued client', resetReturnedAt: 'independent queued-rst-api-return event records API return', admission: 'actual resetInvokeAt - prior.sampleEndedAt must be nonnegative and below100ms; both prior and immediate sampleEndedAt must not exceed actual resetInvokeAt', originalPIDStartInodeFDQueueCriteriaUnchanged: true, originalHttpClientUnchanged: true },
  limits: { kernelBacklogOnly: true, cppPendingWriteProven: false, pumpBranchConclusion: 'unknown', sourceCancelFromSignalNotIntroduced: true, sourceCancelObservationNotFaked: true, originalFlagsDatesWindowsAssertionsAndWaitUntilNotChanged: true, overallOriginalFailureNotWashed: true, runtimeExecuted: false, originalPrepareOnlyRunnerExecuted: false, repositoryWrite: false, gitOrCIInvoked: false, sourceFetch: false, pgOrAppOrProductionExecution: false, oldV1And59And27RootsChanged: false, fullGoalComplete: false, gatePassDerived: false },
  localCheck: { nodeSyntax: nodeReceipt, ASTAndReverseTextOnly: true, originalFunctions: originalFunctions.map(n => n.id.name) },
  integration: 'Use this V2 runner candidate with the unchanged helper pinned above only after peer/Root approval and a proper new package input seal; existing immutable V1 is historical preparation evidence, not a new runtime run.',
};
write('FINAL-queued-write-v2-timestamp-candidate.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ final: desc(`${root}/FINAL-queued-write-v2-timestamp-candidate.json`), candidate: report.candidate, onlyChangedExtraFunctions: changedNames, nodeSyntaxActualExit: node.status, runtimeExecuted: false, originalHttpClientUnchanged: true }));
