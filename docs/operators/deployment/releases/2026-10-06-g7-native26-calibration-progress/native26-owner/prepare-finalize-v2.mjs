import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { out } from './evidence-lib.mjs';
let source = await readFile(join(out,'finalize26.mjs'),'utf8');
const changes = [
  ["import { join } from 'node:path';", "import { join, basename } from 'node:path';"],
  ['`step-${f.step}.final-after`', '`'+ '${basename(f.file)}.final-after`'],
  ['`step-${f.step}.prepared-after-v2`', '`'+ '${basename(f.file)}.prepared-after-v2`'],
  ['`step-${f.step}.before-v2`', '`'+ '${basename(f.file)}.before-v2`'],
  ['assert.equal(receiptNames.length, 39);', 'assert.equal(receiptNames.length, 41);'],
  ["name === 'repair26.closed.json' ? 1 : 0", "['repair26.closed.json','finalize26.closed.json'].includes(name) ? 1 : 0"],
  ["r.path.endsWith('/repair26.closed.json')", "r.path.endsWith('repair26.closed.json')"],
  ["'repair26-v2.mjs','audit26.mjs','verify-static26.mjs','finalize26.mjs',", "'repair26-v2.mjs','audit26.mjs','verify-static26.mjs','finalize26.mjs','prepare-finalize-v2.mjs','finalize26-v2.mjs',"],
  ['receiptCounts:{alreadyClosed:39, actualZero:38, actualOne:1, actualNull:0, signaled:0, spawnErrors:0}', 'receiptCounts:{alreadyClosed:41, actualZero:39, actualOne:2, actualNull:0, signaled:0, spawnErrors:0}'],
  ["finalWriterClosedReceipt:join(out,'finalize26.closed.json')", "finalWriterClosedReceipt:join(out,'finalize26-v2.closed.json')"],
  ['closedReceiptsBeforeFinalWriter:39', 'closedReceiptsBeforeFinalWriter:41'],
  ['  evidenceFiles, commandReceipts,', `  historicalFinalizerFailure: {
    receipt:commandReceipts.find(r => r.path.endsWith('finalize26.closed.json')),
    reason:'The first read-only finalizer expected step-60.final-after; actual snapshot names use the original fixture basename. ENOENT was retained with actual exit 1.',
    repositoryWritesAtFailure:0, finalReportWrittenAtFailure:false,
    resolution:'A separate v2 finalizer uses actual basename snapshots and records both preserved preparation failures.'
  },
  evidenceFiles, commandReceipts,`]
];
for(const [before,after] of changes){
  assert.equal(source.split(before).length,2,'Unique exact v2 edit: '+before);
  source=source.replace(before,after);
}
await writeFile(join(out,'finalize26-v2.mjs'),source,{flag:'wx'});
console.log(JSON.stringify({actualExit:0,newFile:'finalize26-v2.mjs',originalPreserved:true,repositoryWrites:0}));
