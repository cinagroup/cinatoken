import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { enumerate, sha256, stableRead } from './evidence-lib.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const write = (name, data) => fs.writeFileSync(path.join(root, name), data, { flag: 'wx' });
const json = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
const describe = name => { const item = stableRead(path.join(root, name)); return { file: name, bytes: item.bytes.length, sha256: item.sha256 }; };
const firstOutput = "node:internal/modules/run_main:107\r\n    triggerUncaughtException(\r\n    ^\r\n\r\nAssertionError [ERR_ASSERTION]: old-controlled-regression failed: actual 1\r\n    at command (file:///C:/Users/cina/AppData/Local/Temp/cinatoken-evidence-g7-boundary-tools-82ab15ef384141c7bf99246c437325d2/run-tool-validation.mjs:20:3)\r\n    at file:///C:/Users/cina/AppData/Local/Temp/cinatoken-evidence-g7-boundary-tools-82ab15ef384141c7bf99246c437325d2/run-tool-validation.mjs:23:20\r\n    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)\r\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:661:26)\r\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {\r\n  generatedMessage: false,\r\n  code: 'ERR_ASSERTION',\r\n  actual: false,\r\n  expected: true,\r\n  operator: '==',\r\n  diff: 'simple'\r\n}\r\n\r\nNode.js v24.14.1\r\n";
write('initial-wrapper.tool-output.txt', firstOutput);
json('initial-wrapper.exec-tool-receipt.json', { closed: true, actualExit: 1, signal: null, chunkId: 'f3e34e', wallTimeSeconds: 0.6816093, output: describe('initial-wrapper.tool-output.txt'), stdoutStderrPartitionClaimed: false, source: 'Original execution tool result transcribed from delivered output; child raw is separately preserved', failurePreserved: true, unchangedOriginalWrapper: describe('run-tool-validation.mjs'), childReceipt: describe('old-controlled-regression.result.json') });
const finishedOutput = '{"actualOutcome":0,"proof":"C:\\Users\\cina\\AppData\\Local\\Temp\\cinatoken-evidence-g7-boundary-tools-82ab15ef384141c7bf99246c437325d2\\tool-validation.proof.json","bytes":13935,"sha256":"80c2f8be53b91205a111459bb7473aa2088b0530103f69d159441755754c7219","oldChecks":22,"newChecks":36}\n';
write('validation-v2-wrapper.tool-output.txt', finishedOutput);
json('validation-v2-wrapper.exec-tool-receipt.json', { closed: true, actualExit: 0, signal: null, chunkId: 'c93d79', wallTimeSeconds: 4.3398755, output: describe('validation-v2-wrapper.tool-output.txt'), stdoutStderrPartitionClaimed: false, source: 'Original execution tool result transcribed from delivered output; seven child commands have independent raw and closed receipts', report: describe('tool-validation.proof.json') });
const executable = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
const args = ['-NoProfile', '-File', path.join(root, 'preserve-controlled-mirror.ps1')];
const startedAt = new Date().toISOString();
const child = spawnSync(executable, args, { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
const finishedAt = new Date().toISOString();
for (const field of ['stdout', 'stderr']) write(`preserve-controlled-mirror.${field}.log`, child[field] ?? Buffer.alloc(0));
const receipt = { closed: true, executable, args, cwd: root, startedAt, finishedAt, actualExit: child.status, signal: child.signal, spawnError: child.error ? { code: child.error.code, name: child.error.name } : null, stdout: path.join(root, 'preserve-controlled-mirror.stdout.log'), stderr: path.join(root, 'preserve-controlled-mirror.stderr.log'), stdoutBytes: child.stdout?.length ?? 0, stderrBytes: child.stderr?.length ?? 0 };
json('preserve-controlled-mirror.result.json', receipt);
assert.equal(child.status, 0, `ZIP preservation failed actual ${child.status}`);
assert.equal(child.signal, null);
assert.equal(child.error, undefined);
const mirror = JSON.parse(stableRead(path.join(root, 'initial-controlled-mirror.index.json')).bytes);
assert.equal(mirror.actualArchiveOutcome, 0);
assert.equal(mirror.entries.every(x => x.roundtripExact === true), true);
const proof = JSON.parse(stableRead(path.join(root, 'tool-validation.proof.json')).bytes);
assert.equal(proof.oldControlled.pass + proof.oldClosure.pass + proof.newBoundary.pass, 58);
assert.equal(proof.commands.every(x => x.actualExit === 0 && x.closed === true && x.signal === null && x.spawnError == null), true);
assert.equal(JSON.parse(stableRead(path.join(root, 'old-controlled-regression.result.json')).bytes).actualExit, 1);
const index = JSON.parse(stableRead(path.join(root, 'original-source-index.json')).bytes);
for (const item of index.files) {
  for (const prefix of [index.original, path.join(root, 'original-source')]) {
    const found = stableRead(path.join(prefix, item.file));
    assert.equal(found.bytes.length, item.bytes); assert.equal(found.sha256, item.sha256);
  }
  if (item.file !== 'evidence-lib.mjs') assert.deepEqual(describe(item.file), item);
}
const duplicate = new Set(mirror.explicitDuplicateFileExclusions.map(x => x.file));
const files = enumerate(root).filter(x => !duplicate.has(x)).map(describe);
const final = { schema: 'evidence-g7-boundary-tool-preparation-v1', closed: true, actualPreparationOutcome: 0, endedAt: new Date().toISOString(), frozenLibrary: describe('evidence-lib.mjs'), oldLibrary: index.files.find(x => x.file === 'evidence-lib.mjs'), originalFiveExact: true, wrappersAndOldTestsExact: true, validation: describe('tool-validation.proof.json'), tests: { old: 22, added: 36, passed: 58, failed: 0, skipped: 0, syntaxChecks: 4 }, initialFailure: { actualExit: 1, reason: 'Old controlled suite invoked from Temp; its repository-output negative test requires repository cwd. Separate v2 invocation used repository cwd without changing original test source.', receipt: describe('old-controlled-regression.result.json'), rawFailure: describe('old-controlled-regression.stderr.log'), mirrorArchive: describe('initial-controlled-mirror.zip'), mirrorIndex: describe('initial-controlled-mirror.index.json'), mirrorUnmodified: true }, keepWholeToolRootExceptExactDuplicateFiles: mirror.explicitDuplicateFileExclusions, completeFrozenInputFileListBeforeThisFinal: files, explicitByteCopyBindingsExample: [{ rootId: 'release-preparation', provenanceFile: 'original-ci-failure-provenance.json', expectedProvenanceSha256: 'a5a4fd5a04b84d5fd172b4469fa6ef1af26eb4388d17f2dddf9e0e0974fe2b5d' }], limitations: { sourceArchiveCollected: false, rootFullConfigAuditPerformed: false, sourceGitOrRepositoryWrites: false, realServiceOrCiExecution: false, productionRequests: 0, fullG7Complete: false, fullG8Complete: false } };
json('FINAL-evidence-tool-preparation.json', final);
process.stdout.write(JSON.stringify({ actualPreparationOutcome: 0, final: describe('FINAL-evidence-tool-preparation.json'), duplicateMirrorFiles: duplicate.size, totalFrozenToolFiles: files.length + 1, library: describe('evidence-lib.mjs') }) + '\n');
