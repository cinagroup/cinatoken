import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, sha256, stableRead } from './evidence-lib.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cinatoken-evidence-explicit-association-controls-'));
const cases = [];
const json = (root, name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const raw = (root, name, value) => fs.writeFileSync(path.join(root, name), value);
const descriptor = (root, name) => { const item = stableRead(path.join(root, name)); return { file: name, bytes: item.bytes.length, sha256: item.sha256 }; };
const fresh = id => { const root = path.join(fixture, id); fs.mkdirSync(root); return root; };
const config = roots => ({ schemaVersion: 1, releaseSlug: '2026-10-06-explicit-association-controls', roots: roots.map(([id, root]) => ({ id, path: root, phase: 'local-validation' })) });
const blocked = plan => assert.ok(plan.blockers.length > 0, 'Invalid association must block rather than guess a terminal status');
const check = (name, callback) => { callback(); cases.push(name); };
const root = fresh('terminal'), at = new Date('2026-10-06T01:00:00.000Z');
raw(root, 'one.stdout.txt', 'reported stdout\n'); raw(root, 'one.stderr.txt', 'negative stderr\n');
const terminal = { id: 'one', program: process.execPath, args: ['--check', 'inert.mjs'], cwd: fixture,
  timeout: 1000, status: 1, signal: null, error: null, expectedExit: 0, outputs: ['one.stdout.txt', 'one.stderr.txt'].map(name => ({ path: path.join(root, name), ...Object.fromEntries(Object.entries(descriptor(root, name)).filter(([key]) => key !== 'file')) })),
  source: 'actual synchronous spawnSync return, not aggregate report', terminal: true };
json(root, 'one.command-result.json', terminal);
const base = config([['terminal', root]]);
check('terminal-spawnSync-status1-sha-bound-two-outputs-preserved-despite-expected0', () => {
  const plan = prepare(base); assert.deepEqual(plan.blockers, []);
  for (const item of plan.entries.filter(x => x.sourceRelative.endsWith('.txt'))) assert.equal(item.closures[0].actualExit, 1);
});
for (const [name, mutate] of [
  ['wrong-source', value => { value.source = 'aggregate guessed return'; }],
  ['terminal-false', value => { value.terminal = false; }],
  ['unknown-status', value => { value.status = null; }],
  ['fractional-status', value => { value.status = 0.1; }],
  ['output-sha-tamper', value => { value.outputs[0].sha256 = '0'.repeat(64); }],
  ['output-byte-tamper', value => { value.outputs[0].bytes++; }],
  ['duplicate-output', value => { value.outputs[1] = structuredClone(value.outputs[0]); }],
  ['output-cross-root', value => { value.outputs[0].path = path.join(fixture, 'outside.stdout.txt'); }],
  ['invalid-timeout', value => { value.timeout = 0; }],
]) check(`terminal-${name}-blocks`, () => { const value = structuredClone(terminal); mutate(value); json(root, 'one.command-result.json', value); blocked(prepare(base)); });
json(root, 'one.command-result.json', terminal);

const direct = fresh('direct');
raw(direct, 'format.stdout.log', 'stdout\n'); raw(direct, 'format.stderr.log', 'actual format failure\n');
const command = { id: 'format', program: process.execPath, args: ['inert.mjs'], begin: '2026-10-06T01:00:00.000Z', endedAt: '2026-10-06T01:00:01.000Z', closed: true, actualExit: 1, signal: null, errorCode: null };
json(direct, 'format.result.json', command);
for (const name of ['format.stdout.log', 'format.stderr.log']) fs.utimesSync(path.join(direct, name), at, at);
fs.utimesSync(path.join(direct, 'format.result.json'), new Date(+at + 1000), new Date(+at + 1000));
const directBase = config([['direct', direct]]);
const binding = { rootId: 'direct', receiptFile: 'format.result.json', expectedReceiptSha256: descriptor(direct, 'format.result.json').sha256, outputs: ['format.stdout.log', 'format.stderr.log'].map(name => descriptor(direct, name)) };
check('same-stem-without-explicit-binding-remains-blocked', () => blocked(prepare(directBase)));
check('pinned-explicit-closed-command-and-two-raw-hashes-retain-actual1', () => {
  const plan = prepare({ ...directBase, explicitCommandOutputBindings: [binding] }); assert.deepEqual(plan.blockers, []);
  assert.equal(plan.entries.find(x => x.sourceRelative === 'format.stderr.log').closures[0].actualExit, 1);
});
for (const [name, mutate] of [
  ['wrong-receipt-pin', value => { value.expectedReceiptSha256 = '0'.repeat(64); }],
  ['wrong-output-sha', value => { value.outputs[0].sha256 = '0'.repeat(64); }],
  ['wrong-output-bytes', value => { value.outputs[0].bytes++; }],
  ['duplicate-output', value => { value.outputs.push(structuredClone(value.outputs[0])); }],
  ['output-path-escape', value => { value.outputs[0].file = '../outside.log'; }],
]) check(`explicit-${name}-blocks`, () => { const value = structuredClone(binding); mutate(value); blocked(prepare({ ...directBase, explicitCommandOutputBindings: [value] })); });
check('explicit-output-newer-than-pinned-receipt-blocks', () => {
  fs.utimesSync(path.join(direct, 'format.stderr.log'), new Date(+at + 2000), new Date(+at + 2000));
  blocked(prepare({ ...directBase, explicitCommandOutputBindings: [binding] }));
  fs.utimesSync(path.join(direct, 'format.stderr.log'), at, at);
});
check('explicit-binding-cannot-turn-aggregate0-with-no-program-into-command', () => {
  json(direct, 'format.result.json', { closed: true, actualExit: 0 });
  blocked(prepare({ ...directBase, explicitCommandOutputBindings: [{ ...binding, expectedReceiptSha256: descriptor(direct, 'format.result.json').sha256 }] }));
  json(direct, 'format.result.json', command);
});

const original = fresh('original'), copy = fresh('copy');
raw(original, 'seed.stdout.log', ''); raw(original, 'seed.stderr.log', 'seed failed\n');
const nested = { schema: 'web-platform-g7-child-command-closed-v1', program: 'docker', args: ['logs', 'owned-seed'], begin: '2026-10-06T01:00:00.000Z', endedAt: '2026-10-06T01:00:01.000Z', closed: true, actualExit: 1, signal: null, errorCode: null, timeoutMs: 1000, stdout: descriptor(original, 'seed.stdout.log'), stderr: descriptor(original, 'seed.stderr.log') };
json(original, 'seed.result.json', nested);
for (const name of ['seed.stderr.log', 'seed.result.json']) fs.copyFileSync(path.join(original, name), path.join(copy, name));
const partial = { rootId: 'copy', file: 'seed.result.json', originalRootId: 'original', originalFile: 'seed.result.json', sha256: descriptor(original, 'seed.result.json').sha256, partialLogCopy: true, includedLogCopies: [{ ...descriptor(copy, 'seed.stderr.log'), originalFile: 'seed.stderr.log' }] };
const copyBase = config([['original', original], ['copy', copy]]);
check('partial-copy-without-explicit-schema-binding-stays-blocked', () => blocked(prepare(copyBase)));
check('explicit-partial-stderr-only-copy-inherits-original1-full-empty-stdout-retained', () => {
  const plan = prepare({ ...copyBase, immutableSchemaCopies: [partial] }); assert.deepEqual(plan.blockers, []);
  const item = plan.entries.find(x => x.sourceRootId === 'copy' && x.sourceRelative === 'seed.stderr.log');
  assert.equal(item.closures[0].actualExit, 1); assert.equal(item.closures[0].partialLogCopy, true); assert.equal(item.closures[0].ciTerminalClaim, false);
  assert.equal(plan.entries.some(x => x.sourceRootId === 'original' && x.sourceRelative === 'seed.stdout.log'), true);
});
for (const [name, mutate] of [
  ['wrong-receipt-pin', value => { value.sha256 = '0'.repeat(64); }],
  ['wrong-log-hash', value => { value.includedLogCopies[0].sha256 = '0'.repeat(64); }],
  ['wrong-log-bytes', value => { value.includedLogCopies[0].bytes++; }],
  ['wrong-original-stream', value => { value.includedLogCopies[0].originalFile = 'seed.stdout.log'; }],
  ['duplicate-copy-log', value => { value.includedLogCopies.push(structuredClone(value.includedLogCopies[0])); }],
]) check(`partial-${name}-blocks`, () => { const value = structuredClone(partial); mutate(value); blocked(prepare({ ...copyBase, immutableSchemaCopies: [value] })); });
check('partial-copy-requires-explicit-partial-declaration', () => { assert.throws(() => prepare({ ...copyBase, immutableSchemaCopies: [{ ...partial, partialLogCopy: false }] })); });
check('partial-copy-cannot-inherit-original-report-without-own-recognized-terminal-authority', () => {
  json(original, 'seed.result.json', { schema: 'web-platform-g7-child-command-closed-v1', closed: false, actualExit: 1 });
  fs.copyFileSync(path.join(original, 'seed.result.json'), path.join(copy, 'seed.result.json'));
  blocked(prepare({ ...copyBase, immutableSchemaCopies: [{ ...partial, sha256: descriptor(original, 'seed.result.json').sha256 }] }));
});

const realConfigPath = process.argv[2];
let realAudit = null;
if (realConfigPath) {
  const configItem = stableRead(realConfigPath), realConfig = JSON.parse(configItem.bytes);
  const plan = prepare(realConfig);
  realAudit = { configPath: realConfigPath, configBytes: configItem.bytes.length, configSha256: configItem.sha256, roots: plan.sourceRootIds.length, entries: plan.entries.length, receipts: plan.receipts.length, aggregates: plan.aggregateReports.length, exclusions: plan.exclusions, blockers: plan.blockers, realSourceCollectionPerformed: false };
  const report = { closed: true, actualAuditOutcome: plan.blockers.length ? 1 : 0, ...realAudit };
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'full-config-readonly-audit.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  assert.deepEqual(plan.blockers, [], 'Current full Root config has unsupported evidence relationships');
  check('actual-root-full-config-admits-all-raw-with-negative-exits-preserved-and-only-two-declared-release-directory-exclusions', () => {
    assert.equal(plan.exclusions.filter(x => x.directory).length, 2);
    assert.ok(plan.receipts.some(x => x.actualExit === 1));
    assert.ok(plan.receipts.some(x => x.dialect === 'exact-terminal-spawnSync-status' && x.actualExit === 1));
    assert.ok(plan.entries.some(x => x.closures.some(c => c.includedPartialLogCopy === true)));
    assert.ok(plan.aggregateReports.some(x => x.dialect === 'web-platform-g7-owned-linux-tls-pg-closed-v1' && x.actualExit === 1));
    assert.ok(plan.aggregateReports.some(x => x.dialect === 'web-platform-g7-tls-pg-wire-v1' && x.actualExit === 0));
  });
}
process.stdout.write(JSON.stringify({ closed: true, actualExitCode: 0, pass: cases.length, fail: 0, skipped: 0, cases, fixtureDirectory: fixture, actualRuntimeOrCiExecution: false, sourceGitOrRepositoryWrites: false, sourceCollectionPerformed: false, productionRequests: 0, realAudit }) + '\n');
