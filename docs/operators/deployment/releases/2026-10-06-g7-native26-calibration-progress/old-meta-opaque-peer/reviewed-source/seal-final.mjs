import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-old-meta-opaque-snapshot-eEXPR6';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const file = relative => {
  const pathname = path.join(root, relative);
  const bytes = fs.readFileSync(pathname);
  return { relative, path: pathname.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) };
};
const json = relative => JSON.parse(fs.readFileSync(path.join(root, relative)));
const index = json('frozen-old-metadata-index.json');
const verification = json('opaque-transport-verification.json');
const historical = json('historical-late-702-and-git-pin-proof.json');
const commands = ['zip-roundtrip', 'historical-pin'].map(label => {
  const value = json(`${label}.result.json`);
  assert.equal(value.closed, true);
  assert.equal(value.actualExit, 0);
  assert.equal(value.signal, null);
  assert.equal(value.spawnError, null);
  assert.equal(value.timedOut, false);
  for (const stream of ['stdout', 'stderr']) {
    const observed = file(`${label}.${stream}.log`);
    assert.equal(value[stream].bytes, observed.bytes);
    assert.equal(value[stream].sha256, observed.sha256);
    assert.equal(path.resolve(value[stream].path), path.resolve(observed.path));
  }
  return { receipt: file(`${label}.result.json`), stdout: file(`${label}.stdout.log`),
    stderr: file(`${label}.stderr.log`), actualExit: value.actualExit, signal: value.signal, closed: value.closed };
});
assert.equal(index.regularFileCount, 2353);
assert.equal(index.directoryCount, 187);
assert.equal(index.originalTotalBytes, 25703899);
assert.equal(index.exclusions.length, 0);
assert.equal(index.symlinkFollowing, false);
assert.equal(index.entries.length, index.regularFileCount);
assert(index.entries.every(entry => entry.roundtripBytesExact && entry.originalBytes === entry.decodedBytes && entry.originalSha256 === entry.decodedSha256));
const zip = file('frozen-old-metadata-lossless.zip');
assert.equal(zip.bytes, index.zip.bytes);
assert.equal(zip.sha256, index.zip.sha256);
assert.equal(zip.bytes, verification.zip.bytes);
assert.equal(zip.sha256, verification.zip.sha256);
assert.equal(verification.closed, true);
assert.equal(verification.actualCollectionExit, 0);
assert.equal(historical.closed, true);
assert.equal(historical.actualCollectionExit, 0);
const proof = {
  schema: 'cinatoken-frozen-old-metadata-opaque-snapshot-final-v1',
  at: new Date().toISOString(), closed: true, actualCollectionExit: 0,
  sourceRoot: index.sourceRoot, outputRoot: root,
  scope: 'All regular files and directories under the exact frozen old metadata root, including the entire nested output old full archive copy; no source exclusions or writes.',
  zip, index: file('frozen-old-metadata-index.json'),
  transportVerification: file('opaque-transport-verification.json'),
  historicalFactsProof: file('historical-late-702-and-git-pin-proof.json'),
  originalRegularFiles: index.regularFileCount, originalDirectories: index.directoryCount,
  originalTotalBytes: index.originalTotalBytes, exclusions: [],
  allRegularFilesIncluded: true, allDirectoriesIncluded: true, sourceSetAndIdentityUnchanged: true,
  everyZIPEntryDecodedAndComparedWithOriginalBytesAndSHA256: true,
  zipEntryFullSetExact: true, symlinkFollowing: false,
  originalNumericOneNullRawJSONAndLiteralPathsPreservedAsBytes: true,
  late702CommitPushCFGuardAndOneCIListReceiptAndRawExactInZIP: true,
  late702Commit: historical.oldCommit,
  originalA8beArchiveReportGitPinned: historical.pinnedOldFullArchiveReport,
  executedNewCollectionCommands: commands,
  producerSources: ['run-command.mjs', 'snapshot-opaque-meta.py', 'pin-historical-facts.mjs', 'seal-final.mjs'].map(file),
  collectorTreatment: 'Treat the ZIP as opaque immutable historical evidence transport. The index records historical paths and bytes; it does not grant newly executed receipt authority to embedded old archive copies. Original negative and NULL results remain unchanged. This new writer/ZIP verification0 is collection0 only.',
  oldArchiveOrCollectorReexecuted: false, applicationRuns: 0, oldGatesReexecuted: 0,
  newWorkflowDispatches: 0, productionRequests: 0, repositoryWrites: 0, gitMutations: 0,
  embeddedOldCopyIsNewRun: false, fullGoalComplete: false, collectionOnly: true, gatePassDerived: false,
  sealingCommandReceipt: 'seal-final.result.json is written only after this script exits; its actual stdout/stderr and outer tool receipt remain sibling closure evidence rather than a running self-snapshot.',
};
const output = path.join(root, 'FINAL-old-metadata-opaque-snapshot.json');
fs.writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ final: file('FINAL-old-metadata-opaque-snapshot.json'), originalRegularFiles: index.regularFileCount,
  zip, closed: true, actualCollectionExit: 0, collectionOnly: true, gatePassDerived: false }));
