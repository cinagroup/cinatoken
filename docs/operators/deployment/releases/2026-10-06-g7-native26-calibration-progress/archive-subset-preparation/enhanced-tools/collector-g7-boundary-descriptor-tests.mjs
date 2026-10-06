import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enumerate, prepare, sha256 } from './evidence-lib.mjs';
import { prepare as oldPrepare } from './historical-original-library/evidence-lib.mjs';

const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'cinatoken-evidence-g7-boundary-controls-'));
const cases = [];
const source = label => { const root = path.join(owned, label); fs.mkdirSync(root); return root; };
const write = (root, name, content) => {
  const full = path.join(root, name); fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'object' && !Buffer.isBuffer(content) ? `${JSON.stringify(content, null, 2)}\n` : content, { flag: 'wx' });
};
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name)));
const descriptor = (root, name, field = 'file') => { const bytes = fs.readFileSync(path.join(root, name)); return { [field]: name, bytes: bytes.length, sha256: sha256(bytes) }; };
const input = (id, root, other = {}) => ({ id, path: root, phase: 'historical-and-current', ...other });
const config = roots => ({ schemaVersion: 1, releaseSlug: '2026-10-06-g7-boundary-tool-controls', roots });
const cloneTree = (original, label) => { const root = source(label); fs.cpSync(original, root, { recursive: true, errorOnExist: true, force: false }); return root; };
const replace = (root, file, change) => { const value = read(root, file); change(value); fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`); };

const g7 = source('g7-good');
write(g7, 'nested/001-docker.stdout.log', 'closed command output\n'); write(g7, 'nested/001-docker.stderr.log', '');
const g7Value = { schema: 'web-platform-g7-child-command-closed-v1', program: 'docker', args: ['--host', 'unix:///var/run/docker.sock', 'wait', 'owned-seed'], begin: '2026-10-06T00:00:00.000Z', endedAt: '2026-10-06T00:00:00.001Z', closed: true, actualExit: 1, signal: null, errorCode: null, timedOut: false, timeoutMs: 90000, stdout: { ...descriptor(g7, 'nested/001-docker.stdout.log'), file: '001-docker.stdout.log', redacted: true }, stderr: { ...descriptor(g7, 'nested/001-docker.stderr.log'), file: '001-docker.stderr.log', redacted: false } };
write(g7, 'nested/001-docker.result.json', g7Value);
const good = prepare(config([input('g7', g7)])); assert.equal(good.blockers.length, 0); assert.equal(good.receipts[0].actualExit, 1); assert.equal(good.entries.filter(x => x.materialKind === 'closed-command-output').length, 2); cases.push('nested-g7-receipt-relative-to-parent-exact-sha-redacted-stored-bytes-and-exit1-preserved');
for (const [label, mutation, expected] of [
  ['sha-tamper', value => value.stdout.sha256 = '0'.repeat(64), 'bytes/SHA mismatch'],
  ['wrong-bytes', value => value.stderr.bytes = 1, 'bytes/SHA mismatch'],
  ['bad-hash', value => value.stdout.sha256 = 'bad', 'Invalid stdout terminal'],
  ['escape', value => value.stdout.file = '../escape.stdout.log', 'nested descriptor path'],
  ['absolute-file', value => value.stdout.file = path.join(g7, 'nested/001-docker.stdout.log'), 'nested descriptor path'],
  ['missing-descriptor', value => delete value.stdout, 'No explicit supported terminal'],
  ['unknown-status', value => value.actualExit = null, 'No explicit supported terminal'],
  ['not-closed', value => value.closed = false, 'No explicit supported terminal'],
  ['reverse-time', value => value.endedAt = '2025-01-01T00:00:00.000Z', 'No explicit supported terminal'],
  ['secondary-wrong-number', value => value.stdoutBytes = 0, 'byte count no longer matches'],
  ['secondary-negative', value => value.stdoutBytes = -1, 'Invalid stdout terminal byte count'],
  ['secondary-missing-sha', value => value.stdoutBytes = { bytes: value.stdout.bytes }, 'secondary terminal'],
  ['secondary-wrong-sha', value => value.stdoutBytes = { bytes: value.stdout.bytes, sha256: '1'.repeat(64) }, 'Secondary terminal receipt'],
]) {
  const root = cloneTree(g7, label); replace(root, 'nested/001-docker.result.json', mutation);
  assert.ok(prepare(config([input('negative', root)])).blockers.some(x => x.reason.includes(expected)), label); cases.push(`g7-${label}-blocks`);
}
const timeout = cloneTree(g7, 'timeout'); replace(timeout, 'nested/001-docker.result.json', value => { value.actualExit = null; value.signal = 'SIGKILL'; value.errorCode = 'ETIMEDOUT'; value.timedOut = true; });
const timed = prepare(config([input('timeout', timeout)])); assert.equal(timed.blockers.length, 0); assert.equal(timed.receipts[0].actualExit, null); assert.equal(timed.receipts[0].spawnError.code, 'ETIMEDOUT'); assert.equal(timed.receipts[0].timedOut, true); cases.push('timeout-and-signal-retained-without-invented-numeric-exit');
const release = source('release-path-descriptor'); write(release, 'raw.stdout.log', 'real local CLI\n'); write(release, 'raw.stderr.log', '');
write(release, 'raw.result.json', { schema: 'cinatoken-isolated-release-command-v1', program: 'node', args: ['version'], closed: true, actualExit: 0, signal: null, spawnError: null, stdout: { ...descriptor(release, 'raw.stdout.log', 'path'), path: path.join(release, 'raw.stdout.log') }, stderr: { ...descriptor(release, 'raw.stderr.log', 'path'), path: path.join(release, 'raw.stderr.log') } });
assert.equal(prepare(config([input('release', release)])).blockers.length, 0); cases.push('release-nested-path-descriptor-admitted-with-sha');
const scalar = source('string-and-byte-object'); write(scalar, 'raw.stdout.log', 'closed source validation\n'); write(scalar, 'raw.stderr.log', '');
write(scalar, 'raw.result.json', { executable: 'node', args: [], finishedAt: new Date().toISOString(), actualExit: 1, signal: null, stdout: 'raw.stdout.log', stderr: 'raw.stderr.log', stdoutBytes: { bytes: 25, sha256: descriptor(scalar, 'raw.stdout.log').sha256 }, stderrBytes: { bytes: 0, sha256: descriptor(scalar, 'raw.stderr.log').sha256 } });
const scalarPlan = prepare(config([input('scalar', scalar)])); assert.equal(scalarPlan.blockers.length, 0); assert.equal(scalarPlan.receipts[0].actualExit, 1); cases.push('string-pointer-object-byte-and-sha-descriptor-retains-exit1');
const scalarBad = cloneTree(scalar, 'byte-object-tamper'); replace(scalarBad, 'raw.result.json', value => value.stdoutBytes.sha256 = '1'.repeat(64)); assert.ok(prepare(config([input('bad', scalarBad)])).blockers.some(x => x.reason.includes('bytes/SHA mismatch'))); cases.push('byte-object-sha-tamper-blocks');

const originals = source('copy-original'); write(originals, 'download.stdout.log', 'Release CI failure: missing Web CHANGELOG\n'); write(originals, 'download.stderr.log', '');
write(originals, 'download.result.json', { executable: 'gh', args: ['run', 'view', '37401132382', '--log-failed'], finishedAt: new Date().toISOString(), actualExit: 0, signal: null, stdout: path.join(originals, 'download.stdout.log'), stderr: path.join(originals, 'download.stderr.log') });
const copies = source('copy-target'); const copyEntries = [];
for (const file of ['download.result.json', 'download.stdout.log', 'download.stderr.log']) { const bytes = fs.readFileSync(path.join(originals, file)); write(copies, `original-ci/${file}`, bytes); copyEntries.push({ source: path.join(originals, file), copy: path.join(copies, 'original-ci', file), bytes: bytes.length, sha256: sha256(bytes), exact: true }); }
write(copies, 'provenance.json', { closed: true, actualArchiveOutcome: 0, originalDownloadActualExit: 0, noWorkflowRerun: true, entries: copyEntries });
const binding = { rootId: 'copy', provenanceFile: 'provenance.json', expectedProvenanceSha256: descriptor(copies, 'provenance.json').sha256 };
const copyConfig = { ...config([input('original', originals), input('copy', copies)]), explicitByteCopyBindings: [binding] };
assert.ok(prepare({ ...copyConfig, explicitByteCopyBindings: [] }).blockers.some(x => x.root === 'copy' && x.file.endsWith('stdout.log'))); cases.push('unbound-byte-exact-copy-logs-stay-blocked');
const bound = prepare(copyConfig); assert.equal(bound.blockers.length, 0);
const copyClosure = bound.entries.find(x => x.sourceRootId === 'copy' && x.sourceRelative.endsWith('stdout.log')).closures[0]; assert.equal(copyClosure.actualExit, 0); assert.equal(copyClosure.ciTerminalClaim, false); assert.equal(copyClosure.immutableExplicitByteCopy, true); cases.push('pinned-copy-provenance-only-propagates-original-download-closure-without-ci-success');
assert.ok(prepare({ ...copyConfig, explicitByteCopyBindings: [{ ...binding, expectedProvenanceSha256: '0'.repeat(64) }] }).blockers.some(x => x.reason.includes('byte-copy binding rejected'))); cases.push('wrong-explicit-copy-provenance-sha-blocks');
fs.appendFileSync(path.join(copies, 'original-ci/download.stdout.log'), 'altered'); assert.ok(prepare(copyConfig).blockers.some(x => x.reason.includes('byte-copy binding rejected'))); cases.push('copy-raw-byte-tamper-blocks');
const missingAuthority = source('copy-no-authority'); write(missingAuthority, 'copy.stdout.log', 'unclosed'); const noOriginal = source('unclosed-original'); write(noOriginal, 'source.stdout.log', 'unclosed');
write(missingAuthority, 'provenance.json', { closed: true, actualArchiveOutcome: 0, originalDownloadActualExit: 0, noWorkflowRerun: true, entries: [{ source: path.join(noOriginal, 'source.stdout.log'), copy: path.join(missingAuthority, 'copy.stdout.log'), bytes: 8, sha256: sha256(Buffer.from('unclosed')), exact: true }] });
assert.ok(prepare({ ...config([input('no-original', noOriginal), input('no-authority', missingAuthority)]), explicitByteCopyBindings: [{ rootId: 'no-authority', provenanceFile: 'provenance.json', expectedProvenanceSha256: descriptor(missingAuthority, 'provenance.json').sha256 }] }).blockers.some(x => x.reason.includes('no independently verified terminal authority'))); cases.push('producer-exit0-cannot-close-unclosed-original-copy');

const directory = source('explicit-release-mirrors'); write(directory, 'top.source', 'retained');
for (const name of ['isolated-before', 'isolated-after']) { fs.mkdirSync(path.join(directory, name)); write(directory, `${name}/active.stdout.log`, 'CLI mirror not collection authority'); fs.symlinkSync(originals, path.join(directory, name, 'node_modules'), 'junction'); }
assert.throws(() => prepare(config([input('mirror', directory)])), /Linked source/);
const excludedDirectories = ['isolated-before', 'isolated-after'].map(directory => ({ directory, reason: 'Explicit Release CLI mirror; actual generated/source/commands retained separately' }));
assert.throws(() => prepare(config([input('mirror', directory, { excludeDirectories: excludedDirectories })])), /actual authorized Release owner root/); cases.push('matching-mirror-basename-does-not-authorize-excluding-other-roots');
const actualRelease = 'C:/Users/cina/AppData/Local/Temp/cinatoken-changesets-prettier-repair-ebc93278d4d847c7ae00b3cd29ba4ff2';
assert.throws(() => prepare(config([input('actual-release', actualRelease)])), /Linked source/);
const directoryPlan = prepare(config([input('actual-release', actualRelease, { excludeDirectories: excludedDirectories })])); assert.equal(directoryPlan.exclusions.length, 2); assert.ok(directoryPlan.exclusions.every(x => x.scope === 'entire-explicit-directory-tree' && x.descendantsEnumerated === false));
assert.ok(directoryPlan.entries.some(x => x.sourceRelative === 'generated-after/packages/web/CHANGELOG.md')); assert.ok(directoryPlan.entries.some(x => x.sourceRelative === 'commands/before-actual-six-changelog-integrity.result.json' && x.closures[0].actualExit === 1));
assert.ok(directoryPlan.blockers.every(x => x.file.startsWith('original-ci-failure/')), 'Only deliberately unconfigured original CI copy authority may be missing'); cases.push('actual-release-only-two-mirror-trees-skipped-all-generated-source-closed-commands-retained');
assert.throws(() => prepare(config([input('mirror', directory, { excludeDirectories: [{ directory: '../outside', reason: 'invalid' }] })])), /explicit safe/); cases.push('directory-path-escape-blocks');
assert.throws(() => prepare(config([input('mirror', directory, { excludeDirectories: [{ directory: 'negative', reason: 'do not discard negatives' }] })])), /Only the two/); cases.push('negative-or-generic-directory-exclusion-not-authorized');
const otherLink = source('other-symlink'); fs.symlinkSync(originals, path.join(otherLink, 'dependencies'), 'junction'); assert.throws(() => prepare(config([input('other', otherLink)])), /Linked source/); cases.push('all-other-symlink-inputs-remain-rejected');

const realG7 = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E/g7-artifact-first';
const realBoundary = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E/boundary-artifact/_temp/v364-boundary-once-37402302570-1';
const realAfterSeed = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-boundary-next-20261006-Zm6Z3E/g7-artifact-after-seed/web-platform-g7-07d19c1c941cc373019811be3dbf553c441a0ff3-37403868149-1';
const realIndexes = [realG7, realBoundary, realAfterSeed].map(root => ({ root, files: enumerate(root).map(name => ({ name, ...descriptor(root, name) })) }));
assert.ok(oldPrepare(config([input('original-g7', realG7), input('original-boundary', realBoundary)])).blockers.length > 0); cases.push('actual-old-collector-lacks-new-dialects-negative-audit-preserved');
const actual = prepare(config([input('real-g7', realG7), input('real-boundary', realBoundary), input('real-after-seed', realAfterSeed)])); assert.equal(actual.blockers.length, 0);
assert.equal(actual.entries.filter(x => x.sourceRootId === 'real-g7').length, 352); assert.equal(actual.entries.filter(x => x.sourceRootId === 'real-after-seed').length, 601); assert.equal(read(realG7, 'result.json').actualExit, 1);
const boundaryReceipt = actual.receipts.find(x => x.dialect === 'v364-owned-linux-boundary-executor-closed-v1'); assert.equal(boundaryReceipt.actualExit, 1); assert.equal(boundaryReceipt.actualProcessExit, 1); assert.equal(boundaryReceipt.outerUnforcedGroupCloseReported, true); assert.equal(boundaryReceipt.gracefulWorkerdExitProven, false); assert.equal(boundaryReceipt.fullCooperativeCleanupProven, false); cases.push('actual352-original-and601-new-g7-files-and-new-boundary-manifest-admitted-readonly-with-failures-preserved');
const afterSeedOverall = actual.entries.find(x => x.sourceRootId === 'real-after-seed' && x.sourceRelative === 'result.json'); const afterSeedWire = actual.entries.find(x => x.sourceRootId === 'real-after-seed' && x.sourceRelative === 'wire-result.json');
assert.equal(afterSeedOverall.materialKind, 'closed-aggregate-report'); assert.equal(afterSeedOverall.aggregateReport.actualExit, 1); assert.equal(afterSeedOverall.closures.length, 0); assert.equal(afterSeedWire.aggregateReport.actualExit, 0); assert.equal(afterSeedWire.closures.length, 0); assert.equal(actual.receipts.find(x => x.root === 'real-after-seed' && x.file === '083-docker.result.json').actualExit, 1); cases.push('actual-new-wire0-kept-separate-from-overall1-and-admin-observer-command1');
const aggregateOnly = source('aggregate-cannot-close-log'); write(aggregateOnly, 'unbound.stdout.log', 'must not be inferred closed'); const copiedAggregate = read(realAfterSeed, 'wire-result.json'); copiedAggregate.stdout = 'unbound.stdout.log'; copiedAggregate.closed = true; write(aggregateOnly, 'wire.result.json', copiedAggregate); const aggregatePlan = prepare(config([input('aggregate-only', aggregateOnly)])); assert.equal(aggregatePlan.receipts.length, 0); assert.equal(aggregatePlan.aggregateReports[0].actualExit, 0); assert.ok(aggregatePlan.blockers.some(x => x.file === 'unbound.stdout.log')); cases.push('even-wire-report-closed-true-and-exit0-never-close-child-logs');
const invalidAggregate = source('invalid-aggregate'); const invalid = read(realAfterSeed, 'result.json'); invalid.sourceSHA = 'bad'; write(invalidAggregate, 'result.json', invalid); assert.ok(prepare(config([input('invalid-aggregate', invalidAggregate)])).blockers.some(x => x.reason.includes('Invalid explicit aggregate'))); cases.push('invalid-aggregate-source-sha-blocks');
const alteredBoundary = cloneTree(realBoundary, 'boundary-manifest-tamper'); fs.appendFileSync(path.join(alteredBoundary, 'original-strict.stdout.txt'), 'tamper'); assert.ok(prepare(config([input('tampered-boundary', alteredBoundary)])).blockers.some(x => x.reason.includes('SHA mismatch'))); cases.push('new-boundary-manifest-tamper-blocks');
const notGone = cloneTree(realBoundary, 'boundary-not-gone'); replace(notGone, 'executor.closed.json', value => value.closure.groupGone = false); assert.ok(prepare(config([input('not-gone', notGone)])).blockers.some(x => x.reason.includes('No explicit supported terminal'))); cases.push('new-boundary-group-not-gone-is-not-terminal-authority');
const unknownProcess = cloneTree(realBoundary, 'boundary-unknown-process'); replace(unknownProcess, 'executor.closed.json', value => value.actualProcessExit = null); assert.ok(prepare(config([input('unknown-process', unknownProcess)])).blockers.some(x => x.reason.includes('No explicit supported terminal'))); cases.push('new-boundary-unknown-child-exit-cannot-be-guessed');
for (const index of realIndexes) for (const file of index.files) assert.deepEqual(descriptor(index.root, file.name), { file: file.name, bytes: file.bytes, sha256: file.sha256 });
const proof = { closed: true, actualExitCode: 0, pass: cases.length, fail: 0, skipped: 0, cases, fixtureDirectory: owned, realSourceRootsReadonly: 4, realFilesAdmitted: actual.entries.length, actualOldFailuresPreserved: true, realSourceFilesModified: false, actualRuntimeOrCiExecution: false, productionRequests: 0, repoWrites: 0 };
write(owned, 'descriptor-boundaries.proof.json', proof); console.log(JSON.stringify(proof));
