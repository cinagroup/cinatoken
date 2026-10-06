import assert from'node:assert/strict';
import{command,file,success,out,info}from'./capture.mjs';
import{writeFile,readFile}from'node:fs/promises';import{join}from'node:path';
const authority=JSON.parse(await readFile(join(out,'initial-authority.json'),'utf8'));
const terminal=JSON.parse(await readFile(join(out,'parent-terminal-final.stdout.log'),'utf8'));
const inventory=JSON.parse(await readFile('C:/Users/cina/AppData/Local/Temp/cinatoken-native59-full-inventory-10b2722ab06d4cf6b6305e24571b4a8d/FINAL-native59-full-readonly-inventory.json','utf8'));
const records=inventory.records.filter(r=>r.step>=95&&r.step<=113);
assert.equal(records.length,19);
console.log('record-example',JSON.stringify(records[0]).slice(0,2500));
const revisions=[
 ['pin-introduction-source','94c12c1e37e7346330486cf9a3a3246af00d95c5',authority.source],
 ['pin-introduction-wrapper','94c12c1e37e7346330486cf9a3a3246af00d95c5',authority.wrapper],
 ['source-before-web','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b^',authority.source],
 ['source-at-web','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b',authority.source],
 ['wrapper-at-web','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b',authority.wrapper]
];
const jobs=revisions.map(([label,commit,path])=>[label,['show',commit+':'+path]]);
jobs.push(['source-web-diff',['diff','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b^','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b','--',authority.source]]);
jobs.push(['wrapper-web-diff',['diff','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b^','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b','--',authority.wrapper]]);
for(const r of records)jobs.push(['tail-step-'+r.step,['show',authority.base+':'+(r.fixture??r.file)]]);
const results=await Promise.allSettled(jobs.map(async([label,args])=>({label,bytes:success(await command(label,'git',args))})));
for(const r of results)if(r.status==='rejected')throw r.reason;
const raw=terminal.rawEvidence;console.log('rawEvidence-summary',JSON.stringify(raw).slice(0,5000));
console.log('history-hashes',JSON.stringify(results.filter(r=>revisions.some(x=>x[0]===r.value.label)).map(r=>({label:r.value.label,...info(r.value.bytes)}))));
for(const name of ['source-web-diff','wrapper-web-diff'])console.log(name+'\n'+results.find(r=>r.value.label===name).value.bytes.toString());
await writeFile(join(out,'history-tail-inputs.json'),JSON.stringify({authority,records:records.map(r=>({step:r.step,file:r.fixture??r.file})),gitReads:results.map(r=>({label:r.value.label,...info(r.value.bytes)}))},null,2)+'\n',{flag:'wx'});
