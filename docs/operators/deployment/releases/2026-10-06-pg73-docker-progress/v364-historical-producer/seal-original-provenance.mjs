import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = dirname(fileURLToPath(import.meta.url));
const source = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-portable-ci-review-d6411d594da14209af87d9522488c952';
const repo = 'C:/cinagroup/cinatoken';
const packageDir = `${repo}/scripts/diagnostics/v364-owned-linux`;
const python = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const sha = b => createHash('sha256').update(b).digest('hex');
const wxJSON = (name, value) => { const b = Buffer.from(JSON.stringify(value, null, 2) + '\n'); writeFileSync(join(out, name), b, { flag: 'wx' }); return { path: join(out, name), bytes: b.length, sha256: sha(b) }; };
const originalNestedToolResult = {
  chunk_id: '14b93f', wall_time_seconds: 4.8866004, exit_code: 0, original_token_count: 95,
  output: '{"actualExit":0,"report":"C:\\\\Users\\\\cina\\\\AppData\\\\Local\\\\Temp\\\\cinatoken-v364-portable-ci-review-d6411d594da14209af87d9522488c952\\\\FINAL-v364-portable-ci-preparation.json","bytes":12713,"sha256":"bf61962660ffb46f10e699b2b9933e2bf33bf3f0d89a41833b14c5d45982800e","manifestSHA":"cc8346861d175eeb2458a1765ba3c22768d0cb8dc9eee17f702faa868e6e7d92","files":8,"runtimeExecuted":false}\n'
};
const outer = wxJSON('original-exec-command-tool-receipt.json', {
  schema: 'historical-exact-tool-return-copy-v1',
  provenance: 'Exact original nested exec_command request and return copied from retained conversation tool context; not a new execution receipt',
  originalRequest: { cmd: "node 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-portable-ci-review-d6411d594da14209af87d9522488c952/audit-portable.mjs'", workdir: repo, max_output_tokens: 1800 },
  originalResult: originalNestedToolResult,
  originalTimestamp: null, originalTimestampRetained: false,
  commandWasRerun: false, individualInnerToolReceiptsExisted: false
});
const producerBytes = readFileSync(join(source, 'audit-portable.mjs'));
const producerText = producerBytes.toString('utf8');
const finalBytes = readFileSync(join(source, 'FINAL-v364-portable-ci-preparation.json'));
assert.equal(sha(finalBytes), 'bf61962660ffb46f10e699b2b9933e2bf33bf3f0d89a41833b14c5d45982800e');
const final = JSON.parse(finalBytes);
const innerClosed = JSON.parse(readFileSync(join(source, 'executor-windows-rejection/executor.closed.json')));
assert.equal(innerClosed.closure.directChildReaped, false);
assert.equal(innerClosed.closedReportPresent, false);
assert.equal(innerClosed.actualExit, 1);
mkdirSync(join(out, 'raw-copies'));
const copy = name => { const b = readFileSync(join(source, name)); const target = join(out, 'raw-copies', name.replaceAll('/', '__')); writeFileSync(target, b, { flag: 'wx' }); return { originalPath: join(source, name), copiedPath: target, bytes: b.length, sha256: sha(b), copiedBytesExactly: readFileSync(target).equals(b) }; };
const commands = [
  { id: 'python-syntax', program: python, args: ['-c', 'import ast,sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_text()); print("AST OK")', `${packageDir}/execute-owned-linux.py`], options: { encoding: 'utf8' }, actualProgramExit: 0, assertion: 'assert.equal(py.status, 0)', checkName: 'Python AST syntax only' },
  { id: 'prepare', program: 'original process.execPath', programPathRetained: false, observedNodeVersion: 'v24.14.1', args: [`${packageDir}/run-v364-owned-diagnostic.mjs`, '--repo', repo, '--out', `${source}/prepare-once`, '--prepare-only'], options: { cwd: repo, encoding: 'utf8', timeout: 60000 }, actualProgramExit: 0, assertion: 'assert.equal(prep.status, 0, prep.stderr)', checkName: 'actual prepare-only bundling, no runtime' },
  { id: 'fresh-out-rejection', program: 'original process.execPath', programPathRetained: false, observedNodeVersion: 'v24.14.1', args: [`${packageDir}/run-v364-owned-diagnostic.mjs`, '--repo', repo, '--out', `${source}/prepare-once`, '--prepare-only'], options: { cwd: repo, encoding: 'utf8', timeout: 10000 }, actualProgramExit: 1, expectedExit: 1, assertion: 'assert.equal(reused.status, 1)', checkName: 'existing prepare output rejected without overwrite' },
  { id: 'executor-negative', program: python, args: [`${packageDir}/execute-owned-linux.py`, '--repo', repo, '--out', `${source}/executor-windows-rejection`, '--execute-linux'], options: { encoding: 'utf8', timeout: 10000 }, actualProgramExit: 1, expectedExit: 1, assertion: 'assert.equal(rejection.status, 1)', checkName: 'non-Linux preflight preserves real failure/stderr/closed receipt, no child' }
].map(item => {
  assert.ok(producerText.includes(item.assertion), item.id + ' original status assertion missing');
  const check = final.checks.find(v => v.name === item.checkName);
  assert.equal(check.actualExit, item.actualProgramExit);
  const assertionLine = producerText.slice(0, producerText.indexOf(item.assertion)).split('\n').length;
  return { ...item, commandStatusSource: 'Original synchronous spawnSync returned status, checked by exact original assertion; external producer completed with tool exit_code 0. Not inferred from FINAL aggregate actualExit.',
    originalProducerAssertionLine: assertionLine, originalProducerWasClosed: true,
    separateToolReceiptForThisCommand: false, spawnedLocalPreparationProcessWasWaited: true,
    noNativeRuntime: true, noDiagnosticNodeChildForWindowsExecutorRejection: item.id === 'executor-negative',
    provesLinuxProcessGroupClosure: false, nativeTerminalClaim: false,
    outputs: [copy(`${item.id}.stdout.txt`), copy(`${item.id}.stderr.txt`)] };
});
const retainedWindows = ['executor-windows-rejection/executor.stdout.txt', 'executor-windows-rejection/executor.stderr.txt', 'executor-windows-rejection/executor.closed.json'].map(copy);
for (const item of innerClosed.files) {
  const match = retainedWindows.find(r => r.originalPath.replaceAll('\\', '/').endsWith('/' + item.path));
  if (match) { assert.equal(match.bytes, item.bytes); assert.equal(match.sha256, item.sha256); }
}
const producerCopy = copy('audit-portable.mjs');
const originalFinalCopy = copy('FINAL-v364-portable-ci-preparation.json');
const report = wxJSON('FINAL-historical-log-provenance.json', {
  schema: 'v364-historical-preparation-log-terminal-provenance-v1', recordedAt: new Date().toISOString(),
  scope: 'Historical producer-observed Windows preparation and expected negative execution statuses only',
  originalOuterToolReceipt: outer, originalProducer: producerCopy, originalFinal: originalFinalCopy,
  originalOuterCommandActuallyClosed: true, originalOuterToolExitCode: originalNestedToolResult.exit_code,
  originalInnerStatusEvidence: 'Exact status assertions in original immutable producer; only one outer tool receipt was emitted. No synthetic per-command tool receipts are created.',
  commands, windowsExecutorHistoricalArtifacts: retainedWindows,
  windowsExecutorInterpretation: {
    noDiagnosticNodeChild: true, noNativeRuntime: true, noLinuxExecution: true,
    historicalActualProcessExitField: innerClosed.actualProcessExit,
    historicalActualProcessExitMeaning: 'Old ambiguous runner outcome code, preserved exactly; cannot be called the actual diagnostic child exit because no diagnostic child existed.',
    actualPythonProcessExit: 1, actualPythonProcessExitSource: 'Original rejection.status === 1 synchronous producer assertion',
    diagnosticChildActualReturnCode: null,
    directChildReaped: innerClosed.closure.directChildReaped,
    cooperativeNativeFinallyVerified: innerClosed.closure.cooperativeNativeFinallyVerified,
    nativeTerminalClaim: false, nonTerminalClaim: true, provesLinuxProcessGroupClosure: false
  },
  preservation: { allEightOuterLogsRetained: true, allThreeInnerArtifactsRetained: true, originalFilesModified: false, originalFinalModified: false, exactByteCopies: true, oldFailureRemainsNegative: true },
  currentAction: { operation: 'Temp-only wx copying and provenance sealing', historicalCommandsRerun: false, runtimeExecuted: false, ciInvocations: 0, ciPolls: 0, productionRequests: 0, databaseRequests: 0, repositoryWrites: 0 },
  limitations: [
    'No independent per-command unified tool receipts or original per-command start/end timestamps were emitted or retained.',
    'The exact original Node binary path was not retained; program process.execPath is preserved without inventing that path.',
    'Local Node v24.14.1 syntax/prepare results are not the required Linux Node22 runtime execution.',
    'Windows executor preflight rejection and no-child metadata cannot prove native/Linux cleanup or baseline cancellation pass.',
    'Original aggregate FINAL actualExit 0 is not used to invent inner successes; two expected negatives keep their actual exit 1.'
  ]
});
writeFileSync(join(out, 'FINAL-historical-log-provenance.sha256'), report.sha256 + '\n', { flag: 'wx' });
console.log(JSON.stringify({ actualExit: 0, report, historicalOuterExit: 0, fourOriginalSpawnStatuses: commands.map(v => v.actualProgramExit), outerLogsCopied: 8, innerArtifactsCopied: 3, historicalCommandsRerun: false, runtimeExecuted: false, nativeTerminalClaim: false }));
