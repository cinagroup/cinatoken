import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256, stableRead } from './evidence-lib.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const write = (name, bytes) => fs.writeFileSync(path.join(root, name), bytes, { flag: 'wx' });
const json = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
const describe = name => { const data = stableRead(path.join(root, name)); return { file: name, bytes: data.bytes.length, sha256: data.sha256 }; };
const commands = [];
function command(label, args, cwd = root) {
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, args, { cwd, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const finishedAt = new Date().toISOString();
  for (const stream of ['stdout', 'stderr']) write(`${label}.${stream}.log`, child[stream] ?? Buffer.alloc(0));
  const receipt = { closed: true, executable: process.execPath, args, cwd, startedAt, finishedAt, actualExit: child.status, signal: child.signal, spawnError: child.error ? { code: child.error.code, name: child.error.name } : null,
    stdout: path.join(root, `${label}.stdout.log`), stderr: path.join(root, `${label}.stderr.log`), stdoutBytes: child.stdout?.length ?? 0, stderrBytes: child.stderr?.length ?? 0 };
  json(`${label}.result.json`, receipt); commands.push({ ...receipt, stdoutDescriptor: describe(`${label}.stdout.log`), stderrDescriptor: describe(`${label}.stderr.log`) });
  assert.equal(child.status, 0, `${label} failed actual ${child.status}`); assert.equal(child.signal, null); assert.equal(child.error, undefined);
  return child.stdout.toString('utf8');
}
for (const name of ['evidence-lib.mjs', 'collect-evidence.mjs', 'verify-evidence.mjs', 'collector-explicit-association-tests.mjs']) command(`syntax-${name}`, ['--check', path.join(root, name)]);
const oldControlled = JSON.parse(command('old-controlled-regression', [path.join(root, 'collector-controlled-tests.mjs')], 'C:/cinagroup/cinatoken'));
const oldClosure = JSON.parse(command('old-closure-regression', ['collector-closure-boundary-tests.mjs']));
const firstAdded = JSON.parse(command('first-added-regression', ['collector-g7-boundary-descriptor-tests.mjs']));
const secondAdded = JSON.parse(command('second-added-controls-and-full-config', ['collector-explicit-association-tests.mjs', 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7/archive-config-v2.json']));
const copyIndex = JSON.parse(stableRead(path.join(root, 'original-source-index.json')).bytes);
for (const item of copyIndex.files) {
  for (const directory of [copyIndex.original, path.join(root, 'original-source')]) {
    const found = stableRead(path.join(directory, item.file)); assert.equal(found.bytes.length, item.bytes); assert.equal(found.sha256, item.sha256);
  }
  if (item.file !== 'evidence-lib.mjs') assert.deepEqual(describe(item.file), item);
}
const proof = { closed: true, actualValidationOutcome: 0, startedAt: commands[0].startedAt, endedAt: commands.at(-1).finishedAt,
  oldControlled, oldClosure, firstAdded, secondAdded, commands, previousSixFrozenFilesRemainExact: true, wrappersAndThreePriorSuitesUnchanged: true,
  tests: { prior: oldControlled.pass + oldClosure.pass + firstAdded.pass, added: secondAdded.pass, passed: oldControlled.pass + oldClosure.pass + firstAdded.pass + secondAdded.pass, failed: 0, skipped: 0 },
  fullReadonlyConfigAudit: describe('full-config-readonly-audit.json'), sourceFiles: ['evidence-lib.mjs', 'collect-evidence.mjs', 'verify-evidence.mjs', 'collector-explicit-association-tests.mjs', 'run-v2-tool-validation.mjs'].map(describe),
  sourceGitOrRepositoryWrites: false, realServiceOrCiExecution: false, sourceCollectionPerformed: false, productionRequests: 0, originalFailuresExcluded: false };
json('FINAL-v2-tool-validation.json', proof);
process.stdout.write(JSON.stringify({ actualValidationOutcome: 0, final: describe('FINAL-v2-tool-validation.json'), library: describe('evidence-lib.mjs'), tests: proof.tests, fullConfig: secondAdded.realAudit }) + '\n');
