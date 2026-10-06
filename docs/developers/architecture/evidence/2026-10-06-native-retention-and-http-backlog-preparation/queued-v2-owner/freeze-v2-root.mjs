import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-v2-8e7e441d5c7547dc93ae0c2c76898bf8';
const desc = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const read = file => JSON.parse(fs.readFileSync(file));
const finalFile = `${root}/FINAL-queued-write-v2-timestamp-candidate.json`;
const final = read(finalFile);
assert.equal(final.actualLocalPreparationVerification, 0);
assert.equal(final.limits.runtimeExecuted, false);
for (const key of ['candidate', 'unchangedHelperReference', 'v1CandidateReference', 'v1FinalReference', 'v1StopWriteReference']) assert.deepEqual(desc(final[key].path), final[key]);
const repo = final.unchangedRepositorySourceReference;
assert.equal(desc(repo.path).sha256, repo.sha256);
assert.deepEqual(fs.readFileSync(repo.path), fs.readFileSync(repo.exactOldSourceReference.path));
const records = read(`${root}/actual-preparation-tool-receipts.json`).records;
for (const item of [...records, { receipt: 'node-check.result.json', exit_code: 0 }]) {
  const receipt = read(`${root}/${item.receipt}`);
  assert.equal(receipt.closed, true); assert.equal(receipt.actualExit, item.exit_code); assert.equal(receipt.signal, null);
  if ('spawnError' in receipt) assert.equal(receipt.spawnError, null);
  if ('error' in receipt) assert.equal(receipt.error, null);
  if ('timedOut' in receipt) assert.equal(receipt.timedOut, false);
  for (const s of ['stdout', 'stderr']) assert.deepEqual(desc(receipt[s].path), receipt[s]);
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name).replaceAll('\\', '/');
    const stat = fs.lstatSync(file); assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) walk(file); else { assert(stat.isFile()); files.push({ relative: file.slice(root.length + 1), ...desc(file) }); }
  }
}
assert(!fs.existsSync(`${root}/STOPWRITE.json`)); walk(root);
const stop = `${root}/STOPWRITE.json`;
fs.writeFileSync(stop, `${JSON.stringify({ schema: 'cinatoken-queued-v2-timestamp-temp-frozen-index-v1', at: new Date().toISOString(), root, stopWrite: true, indexOnly: true, actualCommandExitNotPredicted: true, fileCountExcludingSelf: files.length, files, final: desc(finalFile), candidate: final.candidate, helperUnchangedReference: final.unchangedHelperReference, closedReceipts: 3, rawStreams: 6, retainedPreparationFailures: 1, runtimeExecuted: false, repoWrite: false, v1RootCopiedOrChanged: false, original13FunctionsUnchanged: true, gatePassDerived: false, selfExcludedReason: 'Self-referential index; descriptor printed after wx write' }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ stopWrite: true, totalFrozenFiles: files.length + 1, final: desc(finalFile), candidate: final.candidate, stopWriteIndex: desc(stop), runtimeExecuted: false, originalHttpClientUnchanged: true }));
