import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {command,success,out,info} from './capture.mjs';
const sourceSha='6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa',gh='C:/Program Files/GitHub CLI/gh.exe',fields='databaseId,name,headSha,status,conclusion,url,jobs,createdAt,updatedAt';
const load=async n=>JSON.parse(await readFile(join(out,n),'utf8'));
const initial=await load('INITIAL-ci-state.json'),watch=await load('proxy-watch-2.closed.json'),watchHistory=[await load('proxy-watch-1.closed.json'),watch];
assert.equal(watch.signal,null);assert.equal(watch.spawnError,null);
for(const s of ['stdout','stderr'])assert.deepEqual(info(await readFile(watch[s].path)),{bytes:watch[s].bytes,sha256:watch[s].sha256});
const originalProxy=await load('proxy-initial.stdout.log'),originalNative=originalProxy.jobs.find(j=>j.name==='native-financial-consumer'),originalDispatch=originalProxy.jobs.find(j=>j.name==='dispatch-safety');
const p=await command('proxy-terminal',gh,['run','view',String(originalProxy.databaseId),'--repo','cinagroup/cinatoken','--json',fields]);
const proxy=JSON.parse(success(p));assert.equal(proxy.headSha,sourceSha);assert.equal(proxy.status,'completed');
assert.equal(proxy.jobs.find(j=>j.name==='native-financial-consumer').databaseId,originalNative.databaseId);
assert.equal(proxy.jobs.find(j=>j.name==='dispatch-safety').databaseId,originalDispatch.databaseId);
const stateReads=await Promise.allSettled(initial.runs.filter(r=>r.slug==='web'||r.slug==='compose').map(async r=>{
 const result=await command(r.slug+'-terminal',gh,['run','view',String(r.runId),'--repo','cinagroup/cinatoken','--json',fields]);
 const view=JSON.parse(success(result));assert.equal(view.headSha,sourceSha);return{slug:r.slug,receipt:result.receipt,status:view.status,conclusion:view.conclusion};
}));for(const r of stateReads)if(r.status==='rejected')throw r.reason;
// These two full original job-log reads deliberately remain sequential to avoid the shared gh ZIP cache race.
const native=await command('native-terminal',gh,['run','view',String(proxy.databaseId),'--repo','cinagroup/cinatoken','--job',String(originalNative.databaseId),'--log']);success(native);
const dispatch=await command('dispatch-terminal',gh,['run','view',String(proxy.databaseId),'--repo','cinagroup/cinatoken','--job',String(originalDispatch.databaseId),'--log']);success(dispatch);
const data={schema:'cinatoken-6e2-original-ci-terminal-collection-v1',at:new Date().toISOString(),sourceSha,watchReceipt:watch,watchHistory,
 proxy:p.receipt,stateReads:stateReads.map(r=>r.value),alreadyTerminal:initial.runs.filter(r=>r.slug==='verify'||r.slug==='release').map(r=>({slug:r.slug,receipt:r.receipt})),
 logs:{native:native.receipt,dispatch:dispatch.receipt},fullLogOrder:['native','dispatch'],completeLogAttemptsPerJob:1,collectionOnly:true,rootCauseConfirmed:false,
 ciActions:0,repositoryWrites:0,nativeExecutedLocally:false,derivedCiLogFiles:0};
await writeFile(join(out,'TERMINAL-ci-collection.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha,proxy:{status:proxy.status,conclusion:proxy.conclusion,jobs:proxy.jobs.map(j=>({id:j.databaseId,name:j.name,status:j.status,conclusion:j.conclusion,failed:j.steps.filter(s=>s.conclusion==='failure').map(s=>s.number)}))},stateReads:data.stateReads,logs:data.logs,rootCauseConfirmed:false}));
