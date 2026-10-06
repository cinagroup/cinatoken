import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enumerate, stableRead, sha256 } from './enhanced-tools/evidence-lib.mjs';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pin = file => { const data = stableRead(file); return { path: file, bytes: data.bytes.length, sha256: data.sha256 }; };
const checks = [];
const check = (id, callback) => { callback(); checks.push(id); };
const old = read('old-four-root-audit.json');
const prepared = read('enhanced-four-root-bound-audit.json');
const config = read('four-frozen-roots-bound-config.json');
const initialReceipt = read('old-four-root-audit.result.json');
const finalReceipt = read('enhanced-four-root-bound-audit.result.json');
const key = entry => entry.sourceRootId + '/' + entry.sourceRelative;
const newByKey = new Map(prepared.entries.map(entry => [key(entry), entry]));
const rootSummary = [];
check('subset-source-exact-full473-and-no-growing-current-root', () => {
  assert.equal(config.sourceCommit, '473de5fc520fc7d64db700db88a76c7a6b45c241');
  assert.equal(config.roots.length, 5);
  assert.ok(!config.roots.some(item => item.path.includes('cinatoken-g7-native53-')));
  assert.equal(config.semantics.partialPreparationOnly, true);
  assert.equal(config.semantics.newCIResultsNotCollected, true);
  assert.equal(config.semantics.applicationTestsRunByPreparer, false);
  assert.equal(config.semantics.fullG7Verified, false);
  assert.equal(config.semantics.fullG8Verified, false);
  assert.equal(config.semantics.gatePassDerived, false);
  assert.ok(!fs.existsSync(config.outputDirectory));
});
check('old-actual1-and-24-blockers-remain-immutable-history', () => {
  assert.equal(initialReceipt.actualExit, 1);
  assert.equal(old.blockers.length, 24);
  assert.equal(old.entries.length, 120);
  assert.equal(old.exclusions.length, 0);
  assert.equal(finalReceipt.actualExit, 0);
  assert.equal(prepared.blockers.length, 0);
  assert.equal(prepared.entries.length, 149);
  assert.equal(prepared.exclusions.length, 0);
  assert.equal(prepared.receipts.length, 28);
  assert.equal(prepared.aggregateReports.length, 4);
});
check('all120-previously-included-files-remain-exact', () => {
  for (const entry of old.entries) {
    const after = newByKey.get(key(entry));
    assert.ok(after, key(entry));
    assert.equal(after.originalBytes, entry.originalBytes, key(entry));
    assert.equal(after.originalSha256, entry.originalSha256, key(entry));
    assert.equal(path.resolve(after.sourcePath), path.resolve(entry.sourcePath), key(entry));
  }
});
check('each-of-five-roots-is-complete-exact-current-file-set-no-exclusions', () => {
  for (const input of config.roots) {
    assert.equal(input.exclude, undefined);
    assert.equal(input.excludeDirectories, undefined);
    const actualNames = enumerate(input.path);
    const planned = prepared.entries.filter(entry => entry.sourceRootId === input.id);
    assert.deepEqual(planned.map(entry => entry.sourceRelative).sort(), [...actualNames].sort(), input.id);
    for (const entry of planned) {
      const data = stableRead(entry.sourcePath);
      assert.equal(data.bytes.length, entry.originalBytes, key(entry));
      assert.equal(data.sha256, entry.originalSha256, key(entry));
    }
    rootSummary.push({ id: input.id, path: input.path, completeOrdinaryFiles: actualNames.length });
  }
  assert.equal(rootSummary.slice(0, 4).reduce((sum, entry) => sum + entry.completeOrdinaryFiles, 0), 140);
  assert.equal(rootSummary[4].completeOrdinaryFiles, 9);
});
const originalTools = read('original-frozen-tools-index.json');
check('all-seven-frozen-tool-originals-and-unchanged-copies-still-byte-exact', () => {
  for (const item of originalTools.pins) {
    for (const file of [item.source, path.join(root, 'tools', item.file)]) {
      const data = stableRead(file); assert.equal(data.bytes.length, item.bytes); assert.equal(data.sha256, item.sha256);
    }
    if (item.file !== 'evidence-lib.mjs') {
      const data = stableRead(path.join(root, 'enhanced-tools', item.file));
      assert.equal(data.bytes.length, item.bytes); assert.equal(data.sha256, item.sha256);
    }
  }
  assert.equal(pin(path.join(root, 'enhanced-tools/evidence-lib.mjs')).sha256, '1a94e0682a2f9782a0bcc28c4736ff49c0bf4db0b9e0cfe0f34ecb6918b22cb7');
});
const owner = config.roots.find(item => item.id === 'g7-observe-owner');
const ownerBindingDetails = [];
check('eight-owner-commands-sixteen-original-streams-bound-to-each-original-status-and-timing', () => {
  assert.equal(config.explicitCommandOutputBindings.length, 8);
  for (const binding of config.explicitCommandOutputBindings) {
    const file = path.join(owner.path, binding.receiptFile), data = stableRead(file), command = JSON.parse(data.bytes);
    assert.equal(binding.rootId, owner.id);
    assert.equal(data.sha256, binding.expectedReceiptSha256);
    assert.equal(command.schema, 'g7-owner-exact-terminal-spawnSync-status-v1');
    assert.equal(command.closed, true);
    assert.equal(command.source, 'Exact spawnSync status; not inferred from wrapper success');
    assert.equal(command.actualExit, 0);
    assert.equal(command.signal, null); assert.equal(command.spawnError, null);
    assert.ok(Date.parse(command.startedAt) <= Date.parse(command.endedAt));
    assert.deepEqual(command.outputs, binding.outputs);
    const recognized = prepared.receipts.find(item => item.root === owner.id && item.file === binding.receiptFile);
    assert.ok(recognized); assert.equal(recognized.actualExit, command.actualExit);
    assert.equal(recognized.startedAt, command.startedAt); assert.equal(recognized.endedAt, command.endedAt);
    for (const descriptor of command.outputs) {
      const entry = newByKey.get(owner.id + '/' + descriptor.file);
      assert.ok(entry); assert.equal(entry.originalBytes, descriptor.bytes); assert.equal(entry.originalSha256, descriptor.sha256);
      assert.equal(entry.closures.length, 1);
      assert.equal(entry.closures[0].explicitCommandOutputBinding, true);
      assert.equal(entry.closures[0].sha256, binding.expectedReceiptSha256);
      assert.equal(entry.closures[0].actualExit, command.actualExit);
    }
    ownerBindingDetails.push({ receipt: pin(file), startedAt: command.startedAt, endedAt: command.endedAt,
      program: command.program, args: command.args, cwd: command.cwd, actualExit: command.actualExit,
      timeoutMs: command.timeoutMs, outputs: command.outputs, originalProducerAuthorityOnly: true });
  }
});
const nestedChildren = fs.readFileSync(path.join(owner.path, 'final-all-g7-controls.stdout.log'), 'utf8')
  .split(/\r?\n/u).filter(line => line.startsWith('ℹ {"scenario":')).map(line => JSON.parse(line.slice(2)));
check('six-controlled-children-have-only-parent-raw-not-invented-external-streams', () => {
  assert.equal(nestedChildren.length, 6);
  assert.deepEqual(nestedChildren.map(child => child.actualChildExit), [0, 1, 1, 1, 1, 1]);
  assert.deepEqual(nestedChildren.map(child => child.scenario), ['success', 'ledger-drift', 'count-drift', 'schema-drift', 'session-failure', 'seed-missing-core']);
  for (const child of nestedChildren) {
    assert.equal(child.realPostgresDriver, true); assert.equal(child.realSQLDatabase, false); assert.equal(child.nativeLinuxAcceptance, false);
    assert.equal(typeof child.stdout, 'string'); assert.equal(typeof child.stderr, 'string');
    assert.ok(!prepared.receipts.some(receipt => receipt.file.includes(child.scenario)));
    assert.ok(!config.explicitCommandOutputBindings.some(binding => binding.receiptFile.includes(child.scenario)));
  }
});
const historicalIndex = read('historical-observer-original-reference/immutable-original-source-index.json');
check('eight-selected-original-reference-files-are-byte-identical-no-new-execution', () => {
  assert.equal(historicalIndex.records.length, 8);
  assert.equal(historicalIndex.newExecution, false);
  for (const item of historicalIndex.records) {
    const original = stableRead(item.source);
    const reference = stableRead(path.join(config.roots[4].path, item.referenceFile));
    const ownerCopy = stableRead(path.join(owner.path, item.copied));
    for (const data of [original, reference, ownerCopy]) {
      assert.equal(data.bytes.length, item.bytes); assert.equal(data.sha256, item.sha256);
    }
    assert.deepEqual(original.bytes, reference.bytes); assert.deepEqual(original.bytes, ownerCopy.bytes);
  }
});
check('original-observer-negative-and-runtime1-separate-from-wire0-no-gate-pass', () => {
  const histReceipts = prepared.receipts.filter(item => item.root === 'original-observer-reference');
  assert.equal(histReceipts.length, 2);
  assert.deepEqual(histReceipts.map(item => [item.file, item.actualExit]), [['082-docker.result.json', 0], ['083-docker.result.json', 1]]);
  for (const item of prepared.aggregateReports) {
    assert.equal(item.aggregateOnly, true); assert.equal(item.childLogAuthority, false); assert.equal(item.gatePassDerived, false);
    assert.equal(item.actualExit, item.dialect === 'web-platform-g7-tls-pg-wire-v1' ? 0 : 1);
  }
  const runtime = read('historical-observer-original-reference/result.json');
  assert.equal(runtime.actualExit, 1); assert.equal(runtime.fullG7Verified, false); assert.equal(runtime.fullG8Verified, false);
  assert.equal(read('historical-observer-original-reference/wire-result.json').actualExit, 0);
});
check('owner-first-glob-and-peer-first-read-error-originals-retained-as-metadata-not-fake-terminals', () => {
  const ownerReport = newByKey.get('g7-observe-owner/FINAL-g7-observe-dependency-owner-review.json');
  assert.ok(ownerReport); assert.equal(ownerReport.originalSha256, '97c918f8be9a31d4a0ed9b61de38f6090d1f69bb96f9878cc2a763c63e0aa5ca');
  const provenance = JSON.parse(fs.readFileSync(path.join(owner.path, 'execution-tool-provenance.json'), 'utf8'));
  assert.ok(provenance.executions.some(item => item.chunk_id === '92646d' && item.exit_code === 1));
  const peerEntry = prepared.entries.find(item => item.sourceRootId === 'g7-observe-peer' && item.sourceRelative === 'FINAL-g7-observe-dependency-peer-review.json');
  assert.ok(peerEntry);
  const peerText = fs.readFileSync(peerEntry.sourcePath, 'utf8');
  assert.ok(peerText.includes('d8a114'));
});
const toolRuns = [];
check('all-seven-own-recorded-tool-child-exits-and-raw-descriptors-are-exact', () => {
  for (const [id, expected] of [['old-four-root-audit', 1], ['new-producer-controls', 0], ['enhanced-lib-syntax', 0],
    ['unchanged-controlled-regression', 0], ['unchanged-closure-regression', 0], ['unchanged-association-regression', 0], ['enhanced-four-root-bound-audit', 0]]) {
    const command = read(id + '.result.json'); assert.equal(command.actualExit, expected);
    assert.equal(command.signal, null); assert.equal(command.spawnError, null);
    assert.ok(Date.parse(command.at) <= Date.parse(command.finishedAt));
    for (const stream of ['stdout', 'stderr']) { const actual = pin(command[stream].path); assert.equal(actual.bytes, command[stream].bytes); assert.equal(actual.sha256, command[stream].sha256); }
    toolRuns.push({ id, receipt: pin(path.join(root, id + '.result.json')), actualExit: command.actualExit, at: command.at, finishedAt: command.finishedAt,
      stdout: command.stdout, stderr: command.stderr });
  }
});
check('new37-and-old-synthetic12-10-28-controls-proven-by-their-own-parent-terminals', () => {
  for (const [id, expected] of [['new-producer-controls', 37], ['unchanged-controlled-regression', 12], ['unchanged-closure-regression', 10], ['unchanged-association-regression', 28]]) {
    const command = read(id + '.result.json'); assert.equal(command.actualExit, 0);
    const proof = JSON.parse(fs.readFileSync(command.stdout.path, 'utf8').trim());
    assert.equal(proof.pass, expected); assert.equal(proof.fail, 0); assert.equal(proof.skipped, 0);
    assert.equal(proof.productionRequests, 0);
  }
});
check('current-root-source-snapshot-only-exact-no-whole-root-audit', () => {
  const source = read('root-run-closed-source-index.json');
  const copy = pin(path.join(root, 'root-run-closed-as-observed.mjs'));
  assert.equal(copy.bytes, source.bytes); assert.equal(copy.sha256, source.sha256);
  assert.equal(copy.sha256, '396a0c50f850ccd2e968bf8e0a320429698bdd825f4ec242f6fd95366bed8dec');
});
const report = {
  schema: 'cinatoken-frozen-subset-archive-preparation-readonly-proof-v1', closed: true, auditOutcome: 0,
  sourceCommit: config.sourceCommit, scope: 'Four complete frozen producer/peer roots plus nine explicitly selected immutable original reference files; preparation only, not full current G7 collection',
  checks, completeOrdinaryFiles: prepared.entries.length, frozenFourRootFiles: 140, selectedReferenceFiles: 9,
  rootSummary, recognizedOriginalTerminalReceipts: prepared.receipts.length, separateAggregateReports: prepared.aggregateReports,
  exclusions: [], oldAudit: { actualExit: 1, includedFiles: 120, unadmittedRawFiles: 20, blockers: 24, preserved: true },
  finalAudit: { actualExit: 0, includedFiles: 149, blockers: 0 }, ownerBindingDetails,
  controlledChildDiagnostics: nestedChildren.map(child => ({ scenario: child.scenario, actualChildExit: child.actualChildExit,
    stdoutUtf8Bytes: Buffer.byteLength(child.stdout), stdoutSha256: sha256(Buffer.from(child.stdout)), stderrUtf8Bytes: Buffer.byteLength(child.stderr), stderrSha256: sha256(Buffer.from(child.stderr)),
    authority: 'Nested diagnostic strings in original final-all-g7-controls.stdout.log only', independentExternalStreams: false, independentToolReceiptClaimed: false,
    realSQLDatabase: false, nativeLinuxAcceptance: false })),
  toolRuns, originalFrozenTools: originalTools.pins, boundConfig: pin(path.join(root, 'four-frozen-roots-bound-config.json')),
  oldToolCopiesAndOriginalsUnmodified: true, helperScope: 'Exact G7 owner schema and explicit original outputs matching only; current Root runner and other original dialects unchanged',
  actualRuntimeOrCiExecutionByPreparer: false, currentCiResultsCollected: false, repositoryCollectionPerformed: false,
  growingCurrentRootWalked: false, prior2226ArchiveFullAuditRepeated: false, productionRequests: 0,
  fullG7Verified: false, fullG8Verified: false, gatePassDerived: false
};
fs.writeFileSync(path.join(root, 'prepared-subset-final-proof.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ closed: true, auditOutcome: 0, checks: checks.length, files: prepared.entries.length,
  proof: pin(path.join(root, 'prepared-subset-final-proof.json')), runtimeOrGatePassClaimed: false }));
