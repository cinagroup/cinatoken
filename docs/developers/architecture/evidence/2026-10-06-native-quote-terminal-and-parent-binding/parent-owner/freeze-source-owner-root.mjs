import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'C:/Users/cina/AppData/Local/Temp/cinatoken-legacy-parent-client-binding-repair-c3e097398c054113961be652993e62b0';
const descriptor = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const read = file => JSON.parse(fs.readFileSync(file));
const final = `${root}/FINAL-legacy-parent-client-binding-repair.json`;
const report = read(final);
assert.equal(report.actualLocalSealVerification, 0);
for (const key of ['before', 'after', 'currentTarget', 'unchangedHelper', 'helperCopy']) assert.deepEqual(descriptor(report.sources[key].path), report.sources[key]);
const authority = read(`${root}/actual-owner-tool-receipts.json`);
for (const item of [...authority.records, { receipt: 'node-check.result.json', exit_code: 0 }]) {
  const r = read(`${root}/${item.receipt}`);
  assert.equal(r.closed, true);
  assert.equal(r.actualExit, item.exit_code);
  assert.equal(r.signal, null);
  assert.equal(r.spawnError, null);
  if ('timedOut' in r) assert.equal(r.timedOut, false);
  for (const stream of ['stdout', 'stderr']) assert.deepEqual(descriptor(r[stream].path), r[stream]);
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name).replaceAll('\\', '/');
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) walk(file);
    else { assert(stat.isFile()); files.push({ relative: file.slice(root.length + 1), ...descriptor(file) }); }
  }
}
assert(!fs.existsSync(`${root}/STOPWRITE.json`));
walk(root);
fs.writeFileSync(`${root}/STOPWRITE.json`, `${JSON.stringify({ schema: 'cinatoken-legacy-parent-source-owner-frozen-file-index-v1', at: new Date().toISOString(), root, stopWrite: true, indexOnly: true, actualCommandExitNotPredicted: true, fileCountExcludingSelf: files.length, files, totalBytesExcludingSelf: files.reduce((n, r) => n + r.bytes, 0), final: descriptor(final), sourceAfter: report.sources.after, closedReceipts: 4, completeRawStreams: 8, originalNativeStep110ActualExit: 1, newPostgresExecution: false, sourceEditScope: 'only3migratorpropertiesin1file', gatePassDerived: false, selfExcludedReason: 'self-referential index; exact descriptor printed after wx write' }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ stopWrite: true, totalFrozenFiles: files.length + 1, final: descriptor(final), index: descriptor(`${root}/STOPWRITE.json`), sourceAfter: report.sources.after, originalNativeStep110ActualExit: 1, realPostgresRepairValidated: false }));
