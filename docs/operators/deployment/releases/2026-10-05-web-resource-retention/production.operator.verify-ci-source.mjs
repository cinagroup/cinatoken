import fs from 'node:fs';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import { inventoryWebBuildInputs, WEB_BUILD_INPUT_POLICY } from 'file:///C:/cinagroup/cinatoken/packages/web/scripts/build-inputs.mjs';
import { verifyRelease } from 'file:///C:/cinagroup/cinatoken/packages/web/scripts/package-release.mjs';
const [sha, label] = process.argv.slice(2);
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const root = 'C:/cinagroup/cinatoken';
const release = verifyRelease(root, sha);
const inventory = inventoryWebBuildInputs(root + '/packages/web');
const queries = inventory.files.map(f => `${sha}:${f.path}`).join('\n') + '\n';
const raw = cp.execFileSync('C:/Program Files/Git/cmd/git.exe', ['cat-file', '--batch'], { cwd: root, input: queries, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
const digest = crypto.createHash('sha256').update(WEB_BUILD_INPUT_POLICY.digest.domain).update(inventory.policySha256 + '\0');
let cursor = 0, bytes = 0, committedFiles = 0;
const workingTreeOnlyPaths = [];
for (const file of inventory.files) {
  const end = raw.indexOf(10, cursor);
  assert.ok(end > cursor);
  const header = raw.subarray(cursor, end).toString('utf8').split(' ');
  if (header[1] === 'missing') {
    assert.equal(header[0], sha + ':' + file.path);
    workingTreeOnlyPaths.push(file.path);
    cursor = end + 1;
    continue;
  }
  assert.equal(header[1], 'blob', file.path);
  const length = Number(header[2]);
  assert.ok(Number.isSafeInteger(length) && length >= 0);
  const body = raw.subarray(end + 1, end + 1 + length);
  assert.equal(body.length, length);
  assert.equal(raw[end + 1 + length], 10);
  digest.update(`${file.path}\0${length}\0`).update(body);
  bytes += length;
  committedFiles += 1;
  cursor = end + length + 2;
}
assert.equal(cursor, raw.length);
const sourceSha256 = digest.digest('hex');
assert.equal(sourceSha256, release.manifest.buildContract.sourceSha256, 'CI artifact must match the exact committed Git input bytes');
const proof = { at: new Date().toISOString(), actualExit: 0, sourceCommit: sha, manifestSha256: release.manifestSha256, buildContract: release.manifest.buildContract, selectedWorkingTreeInputFiles: inventory.files.length, selectedCommittedInputFiles: committedFiles, workingTreeOnlyPaths, selectedGitBlobBytes: bytes, committedSourceSha256: sourceSha256, windowsWorkingTreeSourceSha256: inventory.sourceSha256, provenance: 'Exact committed Git input blobs match the Linux artifact fingerprint; local ignored reference files and Windows EOL are neither rewritten nor represented as CI inputs', assetFiles: release.manifest.files.length, serverFiles: release.manifest.serverFiles.length };
fs.writeFileSync(new URL(label + '.source-proof.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(proof));
