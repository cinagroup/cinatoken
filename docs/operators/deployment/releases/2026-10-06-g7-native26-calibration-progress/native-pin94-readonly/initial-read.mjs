import{command,file,success,out}from'./capture.mjs';
import{writeFile}from'node:fs/promises';import{join}from'node:path';
const source='scripts/db/cutover/postgres-shared-key-guardrail-post-reservation-denial-v348.native.test.mjs';
const wrapper='scripts/db/cutover/postgres-shared-key-guardrail-post-reservation-denial-v348-runtime-buyer-client-successor.native.test.mjs';
const workflow='.github/workflows/proxy-dispatch-safety.yml';
const current=success(await command('head','git',['rev-parse','HEAD'])).toString().trim();
const base=success(await command('dcc6','git',['rev-parse','dcc6^{commit}'])).toString().trim();
const jobs=[
 ['base-workflow',['show',base+':'+workflow]],
 ['base-source',['show',base+':'+source]],
 ['base-wrapper',['show',base+':'+wrapper]],
 ['473-source',['show','473de5fc520fc7d64db700db88a76c7a6b45c241:'+source]],
 ['source-log',['log','--all','--follow','--format=%H%x09%ai%x09%s','--',source]],
 ['wrapper-log',['log','--all','--follow','--format=%H%x09%ai%x09%s','--',wrapper]],
 ['pin-history',['log','--all','-G','603646|historicalFixture','--format=%H%x09%ai%x09%s','--',wrapper]],
 ['exact-status',['status','--short','--',source,wrapper]]
];
const results=await Promise.allSettled(jobs.map(async([label,args])=>({label,text:success(await command(label,'git',args)).toString()})));
for(const r of results)if(r.status==='rejected')throw r.reason;
const reads=await Promise.allSettled([
 ...['C:/AGENTS.md','C:/cinagroup/AGENTS.md','C:/cinagroup/cinatoken/AGENTS.md','C:/cinagroup/cinatoken/scripts/AGENTS.md','C:/cinagroup/cinatoken/scripts/db/AGENTS.md','C:/cinagroup/cinatoken/scripts/db/cutover/AGENTS.md'].map((path,i)=>file('instructions-'+i,path)),
 file('parent-terminal-final','C:/Users/cina/AppData/Local/Temp/cinatoken-native26-ci-terminal-independent-peer-cc2708922c0e4f64a9cca948194a20d9/FINAL-native26-ci-independent-peer.json')
]);
for(const r of reads)if(r.status==='rejected')throw r.reason;
await writeFile(join(out,'initial-authority.json'),JSON.stringify({at:new Date().toISOString(),current,base,source,wrapper,workflow,results:results.map(r=>({label:r.value.label,chars:r.value.text.length})),readResults:reads.map(r=>r.value.receipt)},null,2)+'\n',{flag:'wx'});
for(const r of results){if(['source-log','wrapper-log','pin-history','exact-status'].includes(r.value.label))console.log(r.value.label+'\n'+r.value.text);}
console.log(JSON.stringify({actualExit:0,current,base}));
