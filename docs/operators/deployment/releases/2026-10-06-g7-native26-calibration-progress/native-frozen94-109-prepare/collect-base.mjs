import assert from'node:assert/strict';import{readFile,writeFile,lstat}from'node:fs/promises';import{join}from'node:path';
import{command,file,success,out,repo,info}from'./capture.mjs';
const baseCommit='dc7be6f8597333151c450bae3ae15e6585e3b2eb';
const targets=[
 {step:94,wrapper:'scripts/db/cutover/postgres-shared-key-guardrail-post-reservation-denial-v348-runtime-buyer-client-successor.native.test.mjs',legacy:'scripts/db/cutover/postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs',
  frozenPath:'scripts/db/cutover/fixtures/historical-native/postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs.txt',
  originalCommit:'94c12c1e37e7346330486cf9a3a3246af00d95c5',pin:'603646803c82d3209987260ad682a34169b4e53ca7b03b672d818e3a28d7cc13',oldBytes:50164,currentBytes:50146,currentSha256:'dfe004034784018eb9c70502e19a2192c45e1e8982a96c98b03626f72f7cce1d'},
 {step:109,wrapper:'scripts/db/cutover/postgres-replay-reservations-backend-lifecycle-successor.native.test.mjs',legacy:'scripts/db/cutover/postgres-replay-reservations.native.test.mjs',
  frozenPath:'scripts/db/cutover/fixtures/historical-native/postgres-replay-reservations.native.test.mjs.txt',
  originalCommit:'63e305a1bdf14c55fede74fb7ff9cbd9f732fc19',pin:'d95055419a04465c7c172ff0b8426bd0b928bd538e4dad80f9442229abd5e269',oldBytes:37114,currentBytes:37096,currentSha256:'9cb9a57a7a3edaff9f7a66a9c547a83d6f90ee8938d9a4ad8370194586b4ebe6'}
];
const head=success(await command('initial-head','git',['rev-parse','HEAD'])).toString().trim();assert.equal(head,baseCommit);
const jobs=[['baseline-commit',['show','--no-patch','--format=%H%n%P%n%aI%n%s',baseCommit]],
 ['gitattributes-git',['show',baseCommit+':.gitattributes']],
 ['snapshot-text-attributes',['check-attr','text','--',...targets.map(t=>t.frozenPath)]],
 ['input-blobs',['rev-parse',...targets.flatMap(t=>[baseCommit+':'+t.wrapper,baseCommit+':'+t.legacy,t.originalCommit+':'+t.legacy])]]];
for(const t of targets){jobs.push(['wrapper-'+t.step+'-original',['show',baseCommit+':'+t.wrapper]]);
 jobs.push(['legacy-'+t.step+'-current',['show',baseCommit+':'+t.legacy]]);
 jobs.push(['legacy-'+t.step+'-historical',['show',t.originalCommit+':'+t.legacy]]);}
const reads=await Promise.allSettled(jobs.map(async([label,args])=>({label,bytes:success(await command(label,'git',args))})));
for(const r of reads)if(r.status==='rejected')throw r.reason;
const attr=reads.find(r=>r.value.label==='snapshot-text-attributes').value.bytes.toString();
for(const t of targets)assert.ok(attr.includes(t.frozenPath+': text: unset'));
for(const t of targets){
 const current=await file('working-legacy-'+t.step,join(repo,t.legacy));assert.equal(current.receipt.actualExit,0);assert.deepEqual(info(current.stdout),{bytes:t.currentBytes,sha256:t.currentSha256});
 const wrapper=await file('working-wrapper-'+t.step,join(repo,t.wrapper));assert.equal(wrapper.receipt.actualExit,0);assert.deepEqual(wrapper.stdout,reads.find(r=>r.value.label==='wrapper-'+t.step+'-original').value.bytes);
 const old=reads.find(r=>r.value.label==='legacy-'+t.step+'-historical').value.bytes;assert.deepEqual(info(old),{bytes:t.oldBytes,sha256:t.pin});
 let snapshotExists=false;try{await lstat(join(repo,t.frozenPath));snapshotExists=true}catch(e){assert.equal(e.code,'ENOENT')}
 assert.equal(snapshotExists,false,'Do not overwrite existing snapshot');
 console.log('wrapper-'+t.step+'-historical-metadata\n'+wrapper.stdout.toString().split('\n').flatMap((s,i)=>/historical|lineage|frozen|\.native\.test\.mjs/.test(s)?[(i+1)+': '+s]:[]).join('\n'));
}
const instructionPaths=['C:/AGENTS.md','C:/cinagroup/AGENTS.md',join(repo,'AGENTS.md'),join(repo,'scripts/AGENTS.md'),join(repo,'scripts/db/AGENTS.md'),join(repo,'scripts/db/cutover/AGENTS.md')];
const extra=await Promise.allSettled(instructionPaths.map((p,i)=>file('instructions-'+i,p)));
for(const r of extra)if(r.status==='rejected')throw r.reason;
const frozenPaths=[
 ['prior-owner-final','C:/Users/cina/AppData/Local/Temp/cinatoken-native26-pg73-repair-908e0528cf5e44508d04e761c4540713/FINAL-native26-pg73-preparation.json',210963,'48f61432f183455a1c1557cda0ee8063d9f5419358933ed035504cd85913efda'],
 ['prior-pin-final','C:/Users/cina/AppData/Local/Temp/cinatoken-native-pin94-readonly-385d45490c944bcb892427d92c3de287/FINAL-native-pin94-tail-readonly.json',212858,'41f05a0c311dad452ab8b8d2cc44cb5e1d7e68937fcb83b1baa98a5aeecade58']
];
const frozen=[];
for(const[label,path,bytes,sha256]of frozenPaths){const r=await file(label,path);assert.equal(r.receipt.actualExit,0);assert.deepEqual(info(r.stdout),{bytes,sha256});frozen.push(r.receipt)}
const result={at:new Date().toISOString(),actualExit:0,head,baseCommit,targets,
 allowedPaths:targets.flatMap(t=>[t.wrapper,t.frozenPath]),
 gitInputs:reads.map(r=>({label:r.value.label,...info(r.value.bytes)})),
 gitBlobs:reads.find(r=>r.value.label==='input-blobs').value.bytes.toString().trim().split('\n'),
 instructions:extra.map(r=>r.value.receipt),frozenInputs:frozen,nativeExecuted:false,repositoryWrites:0};
await writeFile(join(out,'base-inputs.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({actualExit:0,baseCommit,allowedPaths:result.allowedPaths,rawHistoricalGitMatches:2,repositoryWrites:0}));
