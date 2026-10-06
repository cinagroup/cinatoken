import assert from 'node:assert/strict';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url)),repo='C:/cinagroup/cinatoken';
const audit=JSON.parse(await readFile(join(root,'five-source-audit-v2.json'),'utf8'));
const labels=(await readdir(root)).filter(name=>name.endsWith('.closed.json')).sort();
const closed=[];
for(const label of labels){const r=JSON.parse(await readFile(join(root,label),'utf8'));assert.ok(r.at&&r.finishedAt&&r.stdout&&r.stderr);assert.equal(r.signal,null);assert.equal(r.actualExit,label==='five-diff-check.closed.json'?2:0);closed.push({file:label,...r});}
assert.equal(closed.length,17);
for(const file of audit.files){const current=await readFile(join(repo,file.file));assert.equal(current.length,file.after.bytes);assert.equal(createHash('sha256').update(current).digest('hex'),file.after.sha256);}
const inert=await readFile(join(root,'inert-six.stdout.log'),'utf8');assert.match(inert,/pass 6/u);assert.match(inert,/fail 0/u);assert.match(inert,/skipped 0/u);
const environment=JSON.parse(await readFile(join(root,'native-environment.stdout.log'),'utf8'));assert.equal(environment.platform,'win32');assert.equal(environment.nativeBinConfigured,false);assert.ok(environment.probe.every(item=>item.actualExit===1));
const result={schema:'cinatoken.pg73.next-five.final.v1',sealedAt:new Date().toISOString(),actualExit:0,baseCommit:audit.baseCommit,readyForCommit:true,sourceOwnership:audit.files.map(f=>f.file),files:audit.files,originalCi:audit.originalCi,
  scope:{actualFailedStep:47,sourceConfirmedSamePatternSteps:[48,49,50,51],unchangedControlStep:52,unchangedControl:'postgres-complete-text-result-client-digest-v367.native.test.mjs',laterSkippedStepsNotClaimedFailed:true,noCountTargetDrivenEdits:true},
  validation:{syntaxFiles:5,syntaxActualExit:0,changedNewLinesResyntaxFiles:3,finalDiffCheckActualExit:0,inertBridgeTests:{pass:6,fail:0,skipped:0,productionFunctionSourceUsed:true,exactOriginalV365RequestCapabilityRejectionUsed:true,notRealPgOrMvcc:true},...audit.totals,...audit.corpus,originalRolePermissionsNegativeTestsConcurrentSqlAndCleanupPreservedByFullFileReverse:true},
  unchangedSources:audit.unchangedSources,closedReceipts:closed,environment,
  historicalFailures:[{receipt:'five-diff-check.closed.json',actualExit:2,cause:'8 newly changed CRLF lines reported trailing whitespace; normalized only those new lines to LF; final v2 exact reverse-byte/source audit and diff-check passed',notNativePgFailure:true}],
  productionWrites:0,gitMutations:0,nativeFixtureExecuted:false,realPgResultNotClaimed:true,limitations:['Only step 47 has actually failed in the source CI; steps 48–51 were skipped and their same fixture defect is established by source review.','Windows environment has no configured native PG and no PG or container executable; syntax/inert controls do not prove Linux PostgreSQL 18.6 runtime behavior.','Root must run the original Linux CI after commit; no original assertion or SQL/role/helper/production source was weakened.'],finalWriterClosedReceipt:'finalize-five.closed.json'};
const path=join(root,'FINAL-next-five-pg73-repair.json');const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');await writeFile(path,bytes,{flag:'wx'});
process.stdout.write(JSON.stringify({actualExit:0,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...audit.totals,readyForCommit:true,nativeFixtureExecuted:false})+'\n');
