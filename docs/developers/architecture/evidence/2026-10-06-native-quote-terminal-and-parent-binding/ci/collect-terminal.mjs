import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {command,success,out,info} from './capture.mjs';
const sha='d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a',gh='C:/Program Files/GitHub CLI/gh.exe';
const watch=JSON.parse(await readFile(join(out,'proxy-watch-1.closed.json'),'utf8'));
assert.equal(watch.signal,null);assert.equal(watch.spawnError,null);
for(const stream of ['stdout','stderr'])assert.deepEqual(info(await readFile(watch[stream].path)),{bytes:watch[stream].bytes,sha256:watch[stream].sha256});
const fields='databaseId,name,headSha,status,conclusion,url,jobs,createdAt,updatedAt';
const proxyResult=await command('proxy-terminal',gh,['run','view','37421461373','--repo','cinagroup/cinatoken','--json',fields]);
const proxy=JSON.parse(success(proxyResult));assert.equal(proxy.headSha,sha);assert.equal(proxy.databaseId,37421461373);assert.equal(proxy.status,'completed');
assert.equal(proxy.jobs.find(j=>j.name==='native-financial-consumer').databaseId,112131520308);
assert.equal(proxy.jobs.find(j=>j.name==='dispatch-safety').databaseId,112131520499);
const requests=[
 ['web-terminal',['run','view','37421461394','--repo','cinagroup/cinatoken','--json',fields]],
 ['compose-terminal',['run','view','37421461379','--repo','cinagroup/cinatoken','--json',fields]],
 ['native-terminal',['run','view','37421461373','--repo','cinagroup/cinatoken','--job','112131520308','--log']],
 ['dispatch-terminal',['run','view','37421461373','--repo','cinagroup/cinatoken','--job','112131520499','--log']]
];
const results=await Promise.allSettled(requests.map(async([label,args])=>{
 const r=await command(label,gh,args);success(r);
 if(label==='web-terminal'||label==='compose-terminal'){const view=JSON.parse(r.stdout);assert.equal(view.headSha,sha);return{label,view,receipt:r.receipt};}
 return{label,receipt:r.receipt};
}));
for(const r of results)if(r.status==='rejected')throw r.reason;
const initial=JSON.parse(await readFile(join(out,'INITIAL-ci-state.json'),'utf8'));
const data={schema:'cinatoken-d537-original-ci-terminal-collection-v1',at:new Date().toISOString(),sourceSha:sha,watchReceipt:watch,
 proxy:{view:proxy,receipt:proxyResult.receipt},reads:results.map(r=>r.value),
 reusedAlreadyTerminal:initial.runs.filter(r=>r.slug==='verify'||r.slug==='release'),collectionOnly:true,rootCauseConfirmed:false,
 nativeExecutedLocally:false,ciActions:0,repositoryWrites:0,completeLogDownloadsPerJob:1,derivedCiLogFiles:0};
await writeFile(join(out,'TERMINAL-ci-collection.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha:sha,proxy:{status:proxy.status,conclusion:proxy.conclusion,jobs:proxy.jobs.map(j=>({id:j.databaseId,name:j.name,status:j.status,conclusion:j.conclusion,failed:j.steps.filter(s=>s.conclusion==='failure')}))},reads:data.reads.map(r=>({label:r.label,status:r.view?.status,conclusion:r.view?.conclusion,receipt:r.receipt})),rootCauseConfirmed:false}));
