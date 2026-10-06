import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-v364-request-signal-readonly-yCKd6V';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: sha(b) }; };
const read = file => JSON.parse(fs.readFileSync(file));
const reportFile = `${root}/FINAL-v364-request-signal-readonly-diagnosis.json`;
const report = read(reportFile);
assert.equal(report.actualReadAndSealExit, 0);
assert.equal(report.actualRuntimeRun, '37414167261');
assert.equal(report.scopeAndDeployment.strictV364Passed, false);
const authority = read(`${root}/actual-producer-tool-receipts.json`);
for (const item of authority.records) {
  const r = read(`${root}/${item.ownedChildReceipt}`);
  assert.equal(r.closed, true);
  assert.equal(r.actualExit, item.exit_code);
  assert.equal(r.signal, null);
  assert.equal(r.spawnError, null);
  assert.equal(r.timedOut, false);
  for (const s of ['stdout', 'stderr']) assert.deepEqual(descriptor(r[s].path), r[s]);
}
const files = [];
const directories = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name).replaceAll('\\', '/');
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) { directories.push(file.slice(root.length + 1)); walk(file); }
    else { assert(stat.isFile()); files.push({ relative: file.slice(root.length + 1), ...descriptor(file) }); }
  }
}
assert(!fs.existsSync(`${root}/STOPWRITE.json`));
walk(root);
const index = {
  schema: 'cinatoken-readonly-request-signal-frozen-file-index-v1', at: new Date().toISOString(), root,
  stopWriteRequested: true, indexOnly: true, actualCommandExitNotPredicted: true,
  fileCountExcludingSelf: files.length, directoryCount: directories.length,
  totalBytesExcludingSelf: files.reduce((n, f) => n + f.bytes, 0),
  files, directories, final: descriptor(reportFile),
  closedProducerReceipts: authority.records.length, originalActualRuntimeExit: 1,
  originalStrictV364Passed: false, newComparisonArmExecuted: false, gatePassDerived: false,
  exclusions: [{ relative: 'STOPWRITE.json', reason: 'Self-referential file index; own bytes/SHA printed after wx write for parent receipt' }],
};
fs.writeFileSync(`${root}/STOPWRITE.json`, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ actualLocalFreezeVerification: 0, stopWrite: true, totalFrozenFiles: files.length + 1, final: descriptor(reportFile), stopWriteIndex: descriptor(`${root}/STOPWRITE.json`), originalActualRuntimeExit: 1, gatePassDerived: false }));
