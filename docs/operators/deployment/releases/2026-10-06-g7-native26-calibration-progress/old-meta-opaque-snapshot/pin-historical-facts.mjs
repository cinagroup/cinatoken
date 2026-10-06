import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-old-meta-opaque-snapshot-eEXPR6';
const oldRoot = 'C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7';
const oldCommit = '702c4d71379acb697024ef846725871582bff94f';
const oldReportSHA = 'a8be774130b2071902c03fac4c74cb16f36dea3c9e7b60fc3890595d704b4f30';
const repo = 'C:/cinagroup/cinatoken';
const reportRelative = 'docs/operators/deployment/releases/2026-10-06-native-g7-boundary-progress.json';
const index = JSON.parse(fs.readFileSync(path.join(root, 'frozen-old-metadata-index.json')));
const entries = new Map(index.entries.map(entry => [entry.relative, entry]));
const beganAt = new Date().toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = (file, bytes) => ({ file, bytes: bytes.length, sha256: sha(bytes) });
const pinnedSource = relative => {
  assert(entries.has(relative), `Original source not indexed: ${relative}`);
  const entry = entries.get(relative);
  const bytes = fs.readFileSync(entry.originalPath);
  assert.equal(bytes.length, entry.originalBytes);
  assert.equal(sha(bytes), entry.originalSha256);
  return { bytes, entry };
};
const receipt = name => {
  const result = pinnedSource(`${name}.result.json`);
  const value = JSON.parse(result.bytes);
  assert.equal(value.actualExit, 0, 'This historical receipt specifically recorded actual0');
  assert.equal(value.signal, null);
  assert(Number.isFinite(Date.parse(value.at)) && Number.isFinite(Date.parse(value.finishedAt)));
  assert(Date.parse(value.finishedAt) >= Date.parse(value.at));
  const streams = {};
  for (const stream of ['stdout', 'stderr']) {
    const relative = `${name}.${stream}.log`;
    assert.equal(value[stream].replaceAll('\\', '/'), `${oldRoot}/${relative}`);
    const output = pinnedSource(relative);
    streams[stream] = { ...descriptor(relative, output.bytes), indexedOriginalPath: output.entry.originalPath };
  }
  return {
    result: value,
    preservedReceipt: descriptor(`${name}.result.json`, result.bytes),
    preservedStreams: streams,
    historicalExecutionOnly: true,
    originalExitRecorded: value.actualExit,
    rerun: false,
  };
};

const commit = receipt('commit-cutover-evidence');
assert(commit.result.args.includes('commit'));
const commitStdout = pinnedSource('commit-cutover-evidence.stdout.log').bytes.toString('utf8');
assert(commitStdout.startsWith('[main 702c4d71] docs: record independent Web cutover and acceptance progress'));
const push = receipt('push-cutover-evidence');
assert.deepEqual(push.result.args, ['-c', 'core.longpaths=true', 'push', 'origin', 'main']);
const pushStderr = pinnedSource('push-cutover-evidence.stderr.log').bytes.toString('utf8');
assert(pushStderr.includes('07d19c1c..702c4d71  main -> main'));
const guard = receipt('cutover-after-push-guard');
const guardFile = pinnedSource('cutover-after-push.deployment-guard.json');
const guardData = JSON.parse(guardFile.bytes);
assert.equal(guardData.actualExit, 0);
assert.equal(guardData.readOnly, true);
assert.equal(guardData.deployment.id, 'fd24618f-121e-4640-9edf-f15d243a6d75');
assert.deepEqual(guardData.deployment.versions, [{ version_id: '2a0a2777-d3b1-47f0-a0a7-88e701b4d2d9', percentage: 100 }]);
assert.equal(guardData.deployment.commitTag, 'c13a64b9c3b2c90adcf736910ea408868d7854f1');
assert.deepEqual(guardData.access, { enabled: false, previews_enabled: false });
assert.deepEqual(guardData.routes.map(row => [row.pattern, row.script]), [
  ['cinatoken.com/*', 'cinatoken-web'], ['cinatoken.com/web-assets/*', 'cinatoken-web'],
  ['api.cinatoken.com/*', 'cinatoken-proxy'],
]);
const ci = receipt('current-release-ci-list');
assert.deepEqual(ci.result.args, ['run', 'list', '--repo', 'cinagroup/cinatoken', '--commit', oldCommit,
  '--limit', '10', '--json', 'databaseId,name,status,conclusion,headSha,url,createdAt,updatedAt']);
const ciData = JSON.parse(pinnedSource('current-release-ci-list.stdout.log').bytes);
assert.equal(ciData.length, 2);
assert(ciData.every(row => row.headSha === oldCommit && row.status === 'completed' && row.conclusion === 'success'));
assert.deepEqual(ciData.map(row => [row.databaseId, row.name]), [[37407870479, 'Verify package versions'], [37407870624, 'Release']]);
const wrapper = pinnedSource('run-command.mjs');
const historicalIndex = JSON.parse(pinnedSource('metadata-source-index.json').bytes);
const wrapperIndex = historicalIndex.entries.find(entry => entry.relative === 'run-command.mjs');
assert(wrapperIndex);
assert.equal(wrapperIndex.originalBytes, wrapper.bytes.length);
assert.equal(wrapperIndex.originalSha256, sha(wrapper.bytes));

const oldReport = pinnedSource('output/2026-10-06-native-g7-boundary-progress.json');
assert.equal(oldReport.bytes.length, 3392478);
assert.equal(sha(oldReport.bytes), oldReportSHA);
const repoBytes = fs.readFileSync(path.join(repo, reportRelative));
assert(repoBytes.equals(oldReport.bytes));
const gitRead = args => {
  const startedAt = new Date().toISOString();
  const child = spawnSync('C:/Program Files/Git/cmd/git.exe', args, { cwd: repo, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.signal, null);
  return {
    bytes: child.stdout,
    observedRead: { program: 'C:/Program Files/Git/cmd/git.exe', args, startedAt,
      endedAt: new Date().toISOString(), actualExit: child.status, signal: child.signal,
      stdoutBytes: child.stdout.length, stdoutSha256: sha(child.stdout),
      stderrBytes: child.stderr.length, stderrSha256: sha(child.stderr), readOnly: true },
  };
};
const headRead = gitRead(['rev-parse', 'HEAD']);
const readAtHead = headRead.bytes.toString('utf8').trim();
assert(/^[0-9a-f]{40}$/.test(readAtHead));
const blobRead = gitRead(['show', `${readAtHead}:${reportRelative}`]);
assert(blobRead.bytes.equals(oldReport.bytes));
const proof = {
  schema: 'cinatoken-opaque-history-late-702-and-git-pin-readonly-v1',
  beganAt, endedAt: new Date().toISOString(), closed: true, actualCollectionExit: 0,
  oldMetadataSource: oldRoot, oldCommit,
  lateHistoricalExecutionReceipts: { commit, push, guard, oneCIListRead: ci },
  historicalGuard: { report: descriptor('cutover-after-push.deployment-guard.json', guardFile.bytes), facts: guardData },
  historicalCIList: ciData,
  wrapperSourceIndexedBeforeOldRead: { ...descriptor('run-command.mjs', wrapper.bytes), originalIndexMatched: true },
  pinnedOldFullArchiveReport: { original: descriptor('output/2026-10-06-native-g7-boundary-progress.json', oldReport.bytes),
    repositoryRelative: reportRelative, readAtHead, gitReadCommands: [headRead.observedRead, blobRead.observedRead],
    currentWorkingFileExact: true, pinnedGitBlobExact: true, archiveCollectionReexecuted: false },
  interpretation: 'The original702 commit/push/guard/list command receipts and original raw bytes exist exactly in the opaque ZIP. Only read-only local Git blob pinning was performed now. The a8be value is the original full archive report SHA256, not a new test result or a commit.',
  originalRuntimeAndCIFailuresRemainOpaqueUnmodified: true, embeddedCopiesAreNewExecutions: false,
  oldCollectorOrGateExecuted: false, applicationRuns: 0, ciRunsTriggered: 0, productionRequests: 0,
  collectionOnly: true, gatePassDerived: false,
};
const output = path.join(root, 'historical-late-702-and-git-pin-proof.json');
fs.writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ proof: output, actualCollectionExit: 0, oldCommit, readAtHead, pinnedOldReportSHA256: oldReportSHA, applicationRuns: 0, productionRequests: 0, gatePassDerived: false }));
