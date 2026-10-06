import{command,success,file,out,info}from'./capture.mjs';
import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
const inputs=JSON.parse(await readFile(join(out,'history-tail-inputs.json'),'utf8'));
const pins=[
 {step:99,target:'scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs',pin:'095f8ec4748cd92e35f37b86891ef8762bc8b8b5ca65ab49abc55b067c1d9be9'},
 {step:109,target:'scripts/db/cutover/postgres-replay-reservations.native.test.mjs',pin:'d95055419a04465c7c172ff0b8426bd0b928bd538e4dad80f9442229abd5e269'}
];
const jobs=[];
for(const p of pins){const wrapper=inputs.records.find(r=>r.step===p.step).file;
 jobs.push(['source-step-'+p.step,['show',inputs.authority.base+':'+p.target]]);
 jobs.push(['source-log-step-'+p.step,['log','--all','--follow','--format=%H%x09%ai%x09%s','--',p.target]]);
 jobs.push(['pin-history-step-'+p.step,['log','--all','-G',p.pin,'--format=%H%x09%ai%x09%s','--',wrapper]]);
 jobs.push(['source-web-diff-step-'+p.step,['diff','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b^','66ef5a698c0bb16aa1f2c490c79b6a06bdb5b33b','--',p.target]]);
}
const results=await Promise.allSettled(jobs.map(async([label,args])=>({label,bytes:success(await command(label,'git',args))})));
for(const r of results)if(r.status==='rejected')throw r.reason;
for(const p of pins)p.current=info(results.find(r=>r.value.label==='source-step-'+p.step).value.bytes);
const terminal=JSON.parse(await readFile(join(out,'parent-terminal-final.stdout.log'),'utf8'));
const raw=await file('actual-native-raw',terminal.rawEvidence.nativeLog.stdout);
if(raw.receipt.actualExit!==0)throw Error('Actual raw read failed');
const receipt=await file('actual-native-original-receipt',terminal.rawEvidence.nativeLog.receiptFile);
if(receipt.receipt.actualExit!==0)throw Error('Actual raw receipt read failed');
const originalReceipt=JSON.parse(receipt.stdout.toString());
console.log('pins',JSON.stringify(pins));
for(const r of results)if(!/^source-step-/.test(r.value.label))console.log(r.value.label+'\n'+r.value.bytes.toString());
await writeFile(join(out,'tail-source-history.json'),JSON.stringify({at:new Date().toISOString(),pins,readResults:results.map(r=>({label:r.value.label,...info(r.value.bytes)})),actualRaw:raw.receipt,originalReceipt},null,2)+'\n',{flag:'wx'});
