import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.dirname(fileURLToPath(import.meta.url));
const oldIndex = JSON.parse(fs.readFileSync(path.join(out, 'original-source-index.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = file => { const bytes = fs.readFileSync(file); return { bytes: bytes.length, sha256: hash(bytes) }; };
const receipts = [];
function command(label, args, expected = [0], commandCwd = out) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, { cwd: commandCwd, encoding: null, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const finishedAt = new Date().toISOString();
  const stdout = path.join(out, `${label}.stdout.log`), stderr = path.join(out, `${label}.stderr.log`);
  fs.writeFileSync(stdout, result.stdout ?? Buffer.alloc(0), { flag: 'wx' }); fs.writeFileSync(stderr, result.stderr ?? Buffer.alloc(0), { flag: 'wx' });
  const receipt = { executable: process.execPath, args, cwd: commandCwd, startedAt, finishedAt, actualExit: result.status, signal: result.signal, spawnError: result.error ? { code: result.error.code, message: result.error.message } : null, closed: Number.isSafeInteger(result.status) && result.signal === null && !result.error, expectedActualExits: expected, stdout, stderr };
  fs.writeFileSync(path.join(out, `${label}.result.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' }); receipts.push({ label, ...receipt });
  assert(receipt.closed && expected.includes(receipt.actualExit), `${label} failed: actual ${receipt.actualExit}`);
  return JSON.parse(fs.readFileSync(stdout, 'utf8'));
}
const controlled = command('old-controlled-regression-v2', [path.join(out,'collector-controlled-tests.mjs')], [0], 'C:/cinagroup/cinatoken');
const closure = command('old-closure-regression', ['collector-closure-boundary-tests.mjs']);
const current = command('new-g7-boundary-descriptor-controls', ['collector-g7-boundary-descriptor-tests.mjs']);
for (const file of ['evidence-lib.mjs', 'collect-evidence.mjs', 'verify-evidence.mjs', 'collector-g7-boundary-descriptor-tests.mjs']) {
  const label = `syntax-${file}`; const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, ['--check', file], { cwd: out, encoding: null, timeout: 30000, windowsHide: true });
  const stdout = path.join(out, `${label}.stdout.log`), stderr = path.join(out, `${label}.stderr.log`);
  fs.writeFileSync(stdout, result.stdout ?? Buffer.alloc(0), { flag: 'wx' }); fs.writeFileSync(stderr, result.stderr ?? Buffer.alloc(0), { flag: 'wx' });
  const receipt = { executable: process.execPath, args: ['--check', file], cwd: out, startedAt, finishedAt: new Date().toISOString(), actualExit: result.status, signal: result.signal, closed: Number.isSafeInteger(result.status) && result.signal === null && !result.error, stdout, stderr };
  fs.writeFileSync(path.join(out, `${label}.result.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' }); receipts.push({ label, ...receipt }); assert(receipt.closed && receipt.actualExit === 0);
}
for (const file of oldIndex.files) { assert.deepEqual(descriptor(path.join(oldIndex.original, file.file)), { bytes: file.bytes, sha256: file.sha256 }); assert.deepEqual(descriptor(path.join(out, 'original-source', file.file)), { bytes: file.bytes, sha256: file.sha256 }); if (file.file !== 'evidence-lib.mjs') assert.deepEqual(descriptor(path.join(out, file.file)), { bytes: file.bytes, sha256: file.sha256 }); }
const report = { closed: true, actualExitCode: 0, phase: 'tool-validation-only', oldControlled: controlled, oldClosure: closure, newBoundary: current, commands: receipts.map(receipt => ({ ...receipt, stdoutDescriptor: descriptor(receipt.stdout), stderrDescriptor: descriptor(receipt.stderr) })), originalFiveFilesRemainExact: true, wrappersAndOldTestsRemainExact: true, sourceGitOrRepositoryWrites: false, serviceOrCiExecution: false, sourceCollectionPerformed: false, productionRequests: 0, sourceFiles: ['evidence-lib.mjs', 'collect-evidence.mjs', 'verify-evidence.mjs', 'collector-g7-boundary-descriptor-tests.mjs', 'run-tool-validation.mjs'].map(file => ({ file, ...descriptor(path.join(out, file)) })) };
const file = path.join(out, 'tool-validation.proof.json'); fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); console.log(JSON.stringify({ actualOutcome: 0, proof: file, ...descriptor(file), oldChecks: controlled.pass + closure.pass, newChecks: current.pass }));
