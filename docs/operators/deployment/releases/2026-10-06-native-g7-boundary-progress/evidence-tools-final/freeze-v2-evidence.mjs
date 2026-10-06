import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerate, stableRead } from './evidence-lib.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const describe = file => { const item = stableRead(path.join(root, file)); return { file, bytes: item.bytes.length, sha256: item.sha256 }; };
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const first = { closed: true, actualExit: 1, signal: null, chunkId: '67808f', wallTimeSeconds: 2.4191584, executionRequest: "node 'C:/Users/cina/AppData/Local/Temp/cinatoken-evidence-g7-boundary-tools-v2-344bf6aba6864fafba8f6d1a5e9e7e7f/run-v2-tool-validation.mjs'", source: 'Original execution tool returned numeric exit1; this metadata does not fabricate independent wrapper stdout/stderr files', childFailureReceipt: describe('first-added-regression.result.json'), childFailureRaw: describe('first-added-regression.stderr.log'), reason: 'Copied test oldPrepare import pointed to v1 final library; prior negative requires original pre-extension library', failureNotRewritten: true };
write('initial-v2-wrapper.receipt.json', first);
const proof = JSON.parse(stableRead(path.join(root, 'FINAL-v2-tool-validation.json')).bytes);
assert.equal(proof.actualValidationOutcome, 0); assert.equal(proof.tests.passed, 87); assert.equal(proof.tests.failed, 0); assert.equal(proof.tests.skipped, 0);
assert.equal(describe('evidence-lib.mjs').sha256, 'f6f86b8c7de1f49c4485cb6171b670d105b94efbb73a4cea5e0f1f5d80c6cbfa');
for (const receipt of proof.commands) {
  assert.equal(receipt.closed, true); assert.equal(receipt.actualExit, 0); assert.equal(receipt.signal, null); assert.equal(receipt.spawnError, null);
  for (const stream of ['stdout', 'stderr']) {
    const item = stableRead(receipt[stream]), descriptor = receipt[`${stream}Descriptor`]; assert.equal(item.bytes.length, descriptor.bytes); assert.equal(item.sha256, descriptor.sha256);
  }
}
assert.equal(JSON.parse(stableRead(path.join(root, 'first-added-regression.result.json')).bytes).actualExit, 1);
write('final-v2-wrapper.receipt.json', { closed: true, actualExit: 0, signal: null, chunkId: '6d0f73', wallTimeSeconds: 4.0830276, executionRequest: "node 'C:/Users/cina/AppData/Local/Temp/cinatoken-evidence-g7-boundary-tools-v2-344bf6aba6864fafba8f6d1a5e9e7e7f/finish-v2-tool-validation.mjs'", source: 'Original execution tool returned numeric exit0 and exact FINAL descriptor; per-command stdout/stderr have separately retained real closed receipts', final: describe('FINAL-v2-tool-validation.json'), stdoutStderrPartitionClaimed: false, currentFullArchiveCollected: false });
const index = JSON.parse(stableRead(path.join(root, 'original-source-index.json')).bytes);
for (const item of index.files) for (const location of [index.original, path.join(root, 'original-source')]) { const found = stableRead(path.join(location, item.file)); assert.equal(found.bytes.length, item.bytes); assert.equal(found.sha256, item.sha256); }
const files = enumerate(root).map(describe);
write('FINAL-v2-frozen-input-index.json', { closed: true, actualFreezeVerificationOutcome: 0, endedAt: new Date().toISOString(), toolRoot: root,
  sourceLibrary: describe('evidence-lib.mjs'), previousFrozenLibrary: index.files.find(x => x.file === 'evidence-lib.mjs'), wrappersUnchanged: true, originalSnapshotsUnchanged: true,
  validation: describe('FINAL-v2-tool-validation.json'), allListedRawClosedAndHashVerified: true, originalFailurePreserved: describe('first-added-regression.result.json'),
  allFilesBeforeThisIndex: files, inputFileCountIncludingThisIndex: files.length + 1, wholeToolRootIncludedWithoutExclusions: true,
  explicitNoClaims: { sourceGitOrRepositoryWrites: false, realRuntimeOrCiExecution: false, productionRequests: 0, actualDurableArchiveCollected: false, fullG7Verified: false, fullG8Verified: false } });
process.stdout.write(JSON.stringify({ actualFreezeVerificationOutcome: 0, fullRootStoppedWritingAfterThisIndex: true, toolRoot: root, files: files.length + 1, final: describe('FINAL-v2-frozen-input-index.json'), library: describe('evidence-lib.mjs') }) + '\n');
