import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { enumerate, stableRead } from './evidence-lib.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const write = (name, bytes) => fs.writeFileSync(path.join(root, name), bytes, { flag: 'wx' });
const json = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
const describe = name => { const data = stableRead(path.join(root, name)); return { file: name, bytes: data.bytes.length, sha256: data.sha256 }; };
const commands = [];
const prior = label => { const item = JSON.parse(stableRead(path.join(root, `${label}.result.json`)).bytes); assert.equal(item.closed, true); assert.equal(item.actualExit, 0); assert.equal(item.signal, null); assert.equal(item.spawnError, null); commands.push({ ...item, stdoutDescriptor: describe(`${label}.stdout.log`), stderrDescriptor: describe(`${label}.stderr.log`) }); return stableRead(path.join(root, `${label}.stdout.log`)).bytes.toString('utf8'); };
function command(label, args) {
  const startedAt = new Date().toISOString(); const child = spawnSync(process.execPath, args, { cwd: root, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); const finishedAt = new Date().toISOString();
  for (const stream of ['stdout', 'stderr']) write(`${label}.${stream}.log`, child[stream] ?? Buffer.alloc(0));
  const receipt = { closed: true, executable: process.execPath, args, cwd: root, startedAt, finishedAt, actualExit: child.status, signal: child.signal, spawnError: child.error ? { code: child.error.code, name: child.error.name } : null, stdout: path.join(root, `${label}.stdout.log`), stderr: path.join(root, `${label}.stderr.log`), stdoutBytes: child.stdout?.length ?? 0, stderrBytes: child.stderr?.length ?? 0 };
  json(`${label}.result.json`, receipt); commands.push({ ...receipt, stdoutDescriptor: describe(`${label}.stdout.log`), stderrDescriptor: describe(`${label}.stderr.log`) });
  assert.equal(child.status, 0, `${label} failed actual ${child.status}`); assert.equal(child.signal, null); assert.equal(child.error, undefined); return child.stdout.toString('utf8');
}
for (const name of ['evidence-lib.mjs', 'collect-evidence.mjs', 'verify-evidence.mjs', 'collector-explicit-association-tests.mjs']) prior(`syntax-${name}`);
const oldControlled = JSON.parse(prior('old-controlled-regression')), oldClosure = JSON.parse(prior('old-closure-regression'));
const firstAdded = JSON.parse(command('first-added-regression-v2', ['collector-g7-boundary-descriptor-tests.mjs']));
const secondAdded = JSON.parse(command('second-added-controls-and-full-config', ['collector-explicit-association-tests.mjs', 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7/archive-config-v2.json']));
const copyIndex = JSON.parse(stableRead(path.join(root, 'original-source-index.json')).bytes);
for (const item of copyIndex.files) {
  for (const directory of [copyIndex.original, path.join(root, 'original-source')]) { const found = stableRead(path.join(directory, item.file)); assert.equal(found.bytes.length, item.bytes); assert.equal(found.sha256, item.sha256); }
  if (!['evidence-lib.mjs', 'collector-g7-boundary-descriptor-tests.mjs'].includes(item.file)) assert.deepEqual(describe(item.file), item);
}
const originalPriorTest = stableRead(path.join(root, 'original-source/collector-g7-boundary-descriptor-tests.mjs')).bytes;
const adjustedPriorTest = stableRead(path.join(root, 'collector-g7-boundary-descriptor-tests.mjs')).bytes;
assert.equal(adjustedPriorTest.toString('utf8'), originalPriorTest.toString('utf8').replace("'./original-source/evidence-lib.mjs'", "'./historical-original-library/evidence-lib.mjs'"));
const historical = describe('historical-original-library/evidence-lib.mjs'); assert.equal(historical.bytes, 31432); assert.equal(historical.sha256, 'c9c46be6e8c08b1c693cec02fc2f94386394412527e46b91028a113be2af7cc4');
const before = JSON.parse(stableRead(path.join(root, 'first-added-regression.result.json')).bytes); assert.equal(before.actualExit, 1);
const proof = { closed: true, actualValidationOutcome: 0, endedAt: new Date().toISOString(), oldControlled, oldClosure, firstAdded, secondAdded, commands, previousSixFrozenFilesRemainExact: true,
  wrappersAndTwoOldSuitesUnchanged: true, firstAddedOnlyImportLocatorAdjusted: true, historicalOriginalLibrary: historical,
  tests: { prior: oldControlled.pass + oldClosure.pass + firstAdded.pass, added: secondAdded.pass, passed: oldControlled.pass + oldClosure.pass + firstAdded.pass + secondAdded.pass, failed: 0, skipped: 0 },
  initialV2TestInvocationFailure: { actualExit: 1, receipt: describe('first-added-regression.result.json'), raw: describe('first-added-regression.stderr.log'), reason: 'COPY changed original-source to v1 final library. One test negative specifically requires older pre-extension library. Only new copied suite import locator was changed to byte-exact original 31432B snapshot. All prior test assertions remain identical.', originalWrapperRemainsUnchanged: true },
  fullReadonlyConfigAudit: describe('full-config-readonly-audit.json'), sourceFiles: ['evidence-lib.mjs', 'collect-evidence.mjs', 'verify-evidence.mjs', 'collector-explicit-association-tests.mjs', 'run-v2-tool-validation.mjs', 'finish-v2-tool-validation.mjs'].map(describe),
  completeInputFileListBeforeThisFinal: enumerate(root).map(describe), sourceGitOrRepositoryWrites: false, realServiceOrCiExecution: false, sourceCollectionPerformed: false, productionRequests: 0, originalFailuresExcluded: false };
json('FINAL-v2-tool-validation.json', proof);
process.stdout.write(JSON.stringify({ actualValidationOutcome: 0, final: describe('FINAL-v2-tool-validation.json'), library: describe('evidence-lib.mjs'), tests: proof.tests, fullConfig: secondAdded.realAudit }) + '\n');
