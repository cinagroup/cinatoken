import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-queued-write-candidate-125e5fd5336c42b18c0bb59dda8f4942';
const desc = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const read = file => JSON.parse(fs.readFileSync(file));
const finalFile = `${root}/FINAL-queued-write-candidate-preparation.json`;
const final = read(finalFile);
assert.equal(final.actualLocalPreparationAndSealExit, 0);
assert.equal(final.pressureEvidence.runtimeExecuted, false);
assert.equal(final.pressureEvidence.cppPendingWriteProven, false);
assert.equal(fs.existsSync('C:/cinagroup/cinatoken/scripts/staging/chat-holder-binding-v364-direct-socket/run-direct-socket.mjs'), false);
for (const key of ['candidate', 'helper', 'before', 'extension']) assert.deepEqual(desc(final[key].path), final[key]);
assert.deepEqual(fs.readFileSync(final.sourceContext.actualRepositoryPath), fs.readFileSync(final.before.path));
for (const row of final.protection.protectedInputs) assert.deepEqual(fs.readFileSync(row.path), fs.readFileSync(row.copy));
const tools = read(`${root}/actual-preparation-tool-receipts.json`);
for (const row of tools.records) {
  const receipt = read(`${root}/${row.receipt}`);
  assert.equal(receipt.closed, true); assert.equal(receipt.actualExit, row.exit_code); assert.equal(receipt.signal, null); assert.equal(receipt.spawnError, null); assert.equal(receipt.timedOut, false);
  for (const s of ['stdout', 'stderr']) assert.deepEqual(desc(receipt[s].path), receipt[s]);
}
for (const receipt of final.localVerification.syntax) {
  assert.equal(receipt.actualExit, 0); assert.equal(receipt.closed, true); assert.equal(receipt.signal, null); assert.equal(receipt.error, null);
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
assert(!fs.existsSync(`${root}/STOPWRITE.json`));
walk(root);
const stop = `${root}/STOPWRITE.json`;
fs.writeFileSync(stop, `${JSON.stringify({ schema: 'cinatoken-queued-write-temp-candidate-frozen-index-v1', at: new Date().toISOString(), root, stopWrite: true, indexOnly: true, actualCommandExitNotPredicted: true, fileCountExcludingSelf: files.length, files, final: desc(finalFile), candidate: final.candidate, helper: final.helper, closedPreparationAndSyntaxReceipts: 6, completeRawStreams: 12, runtimeExecuted: false, repositoryChanged: false, cppPendingWriteProven: false, gatePassDerived: false, selfExcludedReason: 'Self-referential index; own descriptor printed only after wx write' }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ stopWrite: true, totalFrozenFiles: files.length + 1, final: desc(finalFile), stopWriteIndex: desc(stop), candidate: final.candidate, helper: final.helper, runtimeExecuted: false, cppPendingWriteProven: false }));
