import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {command,success,out,info} from './capture.mjs';
const load=async name=>JSON.parse(await readFile(join(out,name),'utf8'));
const sourceSha='d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a',gh='C:/Program Files/GitHub CLI/gh.exe';
const failed=await load('dispatch-terminal.closed.json');assert.equal(failed.actualExit,1);assert.equal(failed.stdout.bytes,0);
const proxy=await load('proxy-terminal.stdout.log');assert.equal(proxy.status,'completed');assert.equal(proxy.headSha,sourceSha);
const result=await command('dispatch-terminal-retry',gh,['run','view','37421461373','--repo','cinagroup/cinatoken','--job','112131520499','--log']);success(result);
const initial=await load('INITIAL-ci-state.json'),reads=[];
for(const label of ['web-terminal','compose-terminal','native-terminal']){
 const receipt=await load(label+'.closed.json');assert.equal(receipt.actualExit,0);
 assert.deepEqual(info(await readFile(receipt.stdout.path)),{bytes:receipt.stdout.bytes,sha256:receipt.stdout.sha256});
 const item={label,receipt};if(label!=='native-terminal'){item.view=await load(label+'.stdout.log');assert.equal(item.view.headSha,sourceSha);}reads.push(item);
}
reads.push({label:'dispatch-terminal',receipt:result.receipt});
const data={schema:'cinatoken-d537-original-ci-terminal-collection-v1',at:new Date().toISOString(),sourceSha,watchReceipt:await load('proxy-watch-1.closed.json'),
 proxy:{view:proxy,receipt:await load('proxy-terminal.closed.json')},reads,reusedAlreadyTerminal:initial.runs.filter(r=>r.slug==='verify'||r.slug==='release'),
 collectionOnly:true,rootCauseConfirmed:false,nativeExecutedLocally:false,ciActions:0,repositoryWrites:0,derivedCiLogFiles:0,
 completeLogDownloadAttempts:{native:1,dispatch:2},completeLogCopies:{native:1,dispatch:1},failedDispatchDownloadRetained:failed,
 recovery:'Only failed empty dispatch download retried sequentially; existing metadata and successful native log reused without another query.'};
await writeFile(join(out,'TERMINAL-ci-collection.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha,dispatchComplete:result.receipt,runs:[proxy,...reads.filter(r=>r.view).map(r=>r.view)].map(v=>({runId:v.databaseId,status:v.status,conclusion:v.conclusion})),retainedFailedEmptyDownload:failed,rootCauseConfirmed:false}));
