import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, prepare, sha256, verify } from './evidence-lib.mjs';
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'cinatoken-evidence-collector-controlled-'));
const cases = [];
function source(label) { const root = path.join(owned, label); fs.mkdirSync(root); return root; }
function write(root, name, bytes) { fs.writeFileSync(path.join(root, name), bytes, { flag: 'wx' }); }
function config(root, output, changes = {}) { return { schemaVersion: 1, releaseSlug: '2026-10-06-controlled-collector-test', sourceCommit: 'b'.repeat(40), outputDirectory: path.join(owned, output), roots: [{ id: 'controlled', path: root, phase: 'local-validation', exclude: [] }], semantics: { controlledToolTestOnly: true, G7: 'pending' }, ...changes }; }
const good = source('good');
for (const label of ['zero', 'failure', 'root-dialect', 'peer-dialect', 'signaled']) { write(good, `${label}.stdout.log`, `closed ${label}\n`); write(good, `${label}.stderr.log`, label === 'failure' ? 'expected synthetic failure\n' : ''); }
write(good, 'zero.result.json', JSON.stringify({ closed: true, actualExitCode: 0, stdout: 'zero.stdout.log', stderr: 'zero.stderr.log' }));
write(good, 'failure.result.json', JSON.stringify({ closed: true, actualExitCode: 1, stdout: 'failure.stdout.log', stderr: 'failure.stderr.log' }));
write(good, 'root-dialect.result.json', JSON.stringify({ finishedAt: new Date().toISOString(), executable: 'node', args: [], actualExit: 0, signal: null, stdout: 'root-dialect.stdout.log', stderr: 'root-dialect.stderr.log' }));
write(good, 'peer-dialect.result.json', JSON.stringify({ completedAt: new Date().toISOString(), program: 'node', arguments: [], actualExitCode: 0, signal: null, spawnError: null, stdoutPath: path.join(good, 'peer-dialect.stdout.log'), stderrPath: path.join(good, 'peer-dialect.stderr.log'), stdoutBytes: fs.statSync(path.join(good, 'peer-dialect.stdout.log')).size, stderrBytes: 0 }));
write(good, 'signaled.result.json', JSON.stringify({ closed: true, actualExitCode: null, signal: 'SIGTERM', stdout: 'signaled.stdout.log', stderr: 'signaled.stderr.log' }));
const binary = Buffer.alloc(120_001); for (let i = 0; i < binary.length; i += 997) binary[i] = i % 256;
write(good, 'large-before.source', binary); write(good, 'script.mjs', '/* retained source */\n');
const result = collect(config(good, 'good-output'));
assert.equal(result.report.totals.files, 17); assert.equal(result.report.totals.gzipFiles, 1); assert.equal(result.report.totals.nonzeroOrAbnormalReceipts, 2);
assert.equal(result.report.closedReceipts.find((item) => item.file === 'failure.result.json').actualExit, 1);
assert.equal(result.report.closedReceipts.find((item) => item.file === 'signaled.result.json').actualExit, null);
assert.equal(verify(result.reportPath).verifiedFiles, 17); cases.push('all-three-real-closure-dialects-and-failures-preserved'); cases.push('large-binary-gzip-stored-original-source-exact');
const originalReport = fs.readFileSync(result.reportPath);
assert.throws(() => collect(config(good, 'good-output')), /already exists/); assert.deepEqual(fs.readFileSync(result.reportPath), originalReport); cases.push('wx-repeat-never-overwrites');
const active = source('active'); write(active, 'active.stdout.log', 'unfinished'); assert.equal(prepare(config(active, 'active-output')).blockers.length, 1); assert.throws(() => collect(config(active, 'active-output')), /no verified terminal/); assert.equal(fs.existsSync(path.join(owned, 'active-output')), false); cases.push('unclosed-log-blocked-before-output');
const missing = source('missing'); write(missing, 'unknown.result.json', JSON.stringify({ closed: true, actualExitCode: null, signal: null })); assert.ok(prepare(config(missing, 'missing-output')).blockers.length); cases.push('missing-exit-is-not-zero');
const late = source('late'); write(late, 'late.stdout.log', 'complete initially'); write(late, 'late.result.json', JSON.stringify({ closed: true, actualExitCode: 0, stdout: 'late.stdout.log' })); const future = new Date(Date.now() + 5_000); fs.utimesSync(path.join(late, 'late.stdout.log'), future, future); assert.ok(prepare(config(late, 'late-output')).blockers.some((item) => item.reason.includes('newer'))); cases.push('reused-late-log-blocked');
const outside = source('outside'); write(outside, 'outside.result.json', JSON.stringify({ closed: true, actualExitCode: 0, stdout: path.join(owned, 'outside-source.log') })); assert.ok(prepare(config(outside, 'outside-output')).blockers.some((item) => item.reason.includes('outside'))); cases.push('receipt-path-escape-blocked');
const collision = source('collision'); write(collision, 'same.bin', binary); write(collision, 'same.bin.gz', 'already stored'); assert.throws(() => collect(config(collision, 'collision-output')), /suffix collides/); assert.equal(fs.existsSync(path.join(owned, 'collision-output')), false); cases.push('gzip-path-collision-blocked-before-output');
assert.throws(() => collect(config(good, 'unused', { outputDirectory: path.join(process.cwd(), 'collector-must-not-write-repo') })), /dedicated Temp/); cases.push('repository-write-blocked');
assert.throws(() => prepare(config(good, 'unused', { roots: [{ id: 'one', path: good, phase: 'local-validation' }, { id: 'two', path: good, phase: 'local-validation' }] })), /Duplicate resolved source root/); cases.push('duplicate-root-blocked');
const gzipEntry = result.report.entries.find((item) => item.encoding === 'gzip'), gzipPath = path.join(path.dirname(result.reportPath), result.report.evidenceDirectory, gzipEntry.storedRelative), originalGzip = fs.readFileSync(gzipPath), tampered = Buffer.from(originalGzip); tampered[tampered.length - 1] ^= 1; fs.writeFileSync(gzipPath, tampered); assert.throws(() => verify(result.reportPath)); fs.writeFileSync(gzipPath, originalGzip); cases.push('stored-tamper-detected');
const extra = path.join(path.dirname(result.reportPath), result.report.evidenceDirectory, 'unexpected-file'); fs.writeFileSync(extra, 'extra', { flag: 'wx' }); assert.throws(() => verify(result.reportPath), /complete report index/); fs.unlinkSync(extra); cases.push('exact-stored-directory-set-checked');
assert.equal(verify(result.reportPath).sourceBytesExact, true);
const proof = { closed: true, actualExitCode: 0, controlledTests: cases.length, pass: cases.length, fail: 0, skipped: 0, cases, fixtureDirectory: owned, fixtureReport: result.reportPath, fixtureReportSha256: sha256(originalReport), realSourceCollectionPerformed: false, productionRequests: 0, repoWrites: 0, actualDockerOrCiExecution: false };
const receipt = path.join(owned, 'controlled-tests.proof.json'); fs.writeFileSync(receipt, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' }); process.stdout.write(`${JSON.stringify({ ...proof, receipt })}\n`);
