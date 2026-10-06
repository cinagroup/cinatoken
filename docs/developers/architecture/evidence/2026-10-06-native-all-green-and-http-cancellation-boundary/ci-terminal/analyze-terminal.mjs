import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const load=async name=>JSON.parse(await readFile(join(out,name),'utf8'));
const sourceSha='757490181564aa822f960f5d8704857b98b230d0',collection=await load('TERMINAL-ci-collection.json'),map=await load('original-workflow-map.json');
assert.equal(collection.sourceSha,sourceSha);assert.equal(map.sourceSha,sourceSha);
const proxy=JSON.parse(await readFile(collection.proxy.stdout.path,'utf8')),native=proxy.jobs.find(j=>j.name==='native-financial-consumer'),dispatch=proxy.jobs.find(j=>j.name==='dispatch-safety');
assert.equal(proxy.status,'completed');assert.equal(native.status,'completed');assert.equal(dispatch.status,'completed');assert.equal(native.databaseId,map.nativeJobId);
const metadata=await Promise.all([{slug:'proxy',receipt:collection.proxy},...collection.stateReads,...collection.alreadyTerminal].map(async r=>{
 const raw=await readFile(r.receipt.stdout.path),view=JSON.parse(raw);assert.equal(r.receipt.actualExit,0);assert.equal(view.headSha,sourceSha);assert.equal(view.status,'completed');
 assert.deepEqual(info(raw),{bytes:r.receipt.stdout.bytes,sha256:r.receipt.stdout.sha256});return{slug:r.slug,view,receipt:r.receipt};
}));assert.equal(metadata.length,5);
const state=s=>({number:s.number,status:s.status,conclusion:s.conclusion,startedAt:s.startedAt,completedAt:s.completedAt});
async function logIndex(receipt){
 assert.equal(receipt.actualExit,0);assert.equal(receipt.signal,null);assert.equal(receipt.spawnError,null);
 const raw=await readFile(receipt.stdout.path),text=raw.toString('utf8');assert.equal(Buffer.compare(Buffer.from(text,'utf8'),raw),0);
 assert.deepEqual(info(raw),{bytes:receipt.stdout.bytes,sha256:receipt.stdout.sha256});
 const starts=[...text.matchAll(/^.*?##\[group\]Run .*$/gm)].map(m=>m.index),byte=i=>Buffer.byteLength(text.slice(0,i),'utf8');
 const groups=starts.map((start,i)=>{
  const end=starts[i+1]??text.length,body=text.slice(start,end),headerEnd=body.indexOf('##[endgroup]');assert.ok(headerEnd>=0);
  return{start,end,body,header:body.slice(0,headerEnd),range:{path:receipt.stdout.path,startByte:byte(start),endByte:byte(end)}};
 });
 function details(g){
  const counters={};for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo']){
   const m=[...g.body.matchAll(new RegExp('# '+key+' (\\d+)','g'))].at(-1);counters[key]=m?{value:Number(m[1]),byteOffset:byte(g.start+m.index)}:null;
  }
  const tokens=(pattern,mapToken)=>[...g.body.matchAll(pattern)].map(m=>({...mapToken(m),byteOffset:byte(g.start+m.index)}));
  const fields={};for(const key of ['failureType','error','code','name','expected','actual']){
   const m=new RegExp('^.*?\\s{2}'+key+': ([^\\r\\n]+)','m').exec(g.body);fields[key]=m?{value:m[1],byteOffset:byte(g.start+m.index)}:null;
  }
  return{range:g.range,counters,exitCodes:tokens(/Process completed with exit code (\d+)/g,m=>({value:Number(m[1])})),
   failedSubtests:tokens(/\bnot ok (\d+) - ([^\r\n]+)/g,m=>({number:Number(m[1]),name:m[2]})),
   subtests:tokens(/# Subtest: ([^\r\n]+)/g,m=>({name:m[1]})),fields,
   locations:tokens(/(?:file:\/\/[^\s'"()]*\/)?scripts\/(?:db\/cutover|staging)\/[^\s'"()]+?\.(?:mjs|[cm]?ts):\d+(?::\d+)?/g,m=>({source:m[0]}))};
 }
 return{groups,details};
}
const nativeLog=await logIndex(collection.logs.native),dispatchLog=await logIndex(collection.logs.dispatch);
assert.equal(map.fixtures.length,107);assert.deepEqual(map.fixtures.map(s=>s.step),Array.from({length:107},(_,i)=>i+7));
const entries=map.fixtures.map(entry=>{
 const actual=native.steps.find(s=>s.number===entry.step);assert.ok(actual);assert.equal(actual.status,'completed');
 const groups=nativeLog.groups.filter(g=>g.header.includes(entry.fixture));
 if(actual.conclusion==='skipped'){assert.equal(groups.length,0);return{...entry,actual:state(actual),tap:null};}
 assert.equal(groups.length,1,'One original log command group for actual native step '+entry.step);
 const tap=nativeLog.details(groups[0]);assert.ok(tap.counters.tests,'Actual TAP tests counter '+entry.step);
 return{...entry,actual:state(actual),tap};
});
const counts=rows=>rows.reduce((a,e)=>(a[e.actual.conclusion]=(a[e.actual.conclusion]??0)+1,a),{});
const flat=e=>({step:e.step,fixture:e.fixture,yamlStep:e.yamlStep,workflowLine:e.workflowLine,...e.actual,
 tests:e.tap?.counters.tests?.value??null,pass:e.tap?.counters.pass?.value??null,fail:e.tap?.counters.fail?.value??null,
 cancelled:e.tap?.counters.cancelled?.value??null,skipped:e.tap?.counters.skipped?.value??null,todo:e.tap?.counters.todo?.value??null,range:e.tap?.range??null});
const cohort=numbers=>{
 const rows=numbers.map(n=>{const e=entries.find(s=>s.step===n);assert.ok(e);return e;});
 return{count:rows.length,actualCounts:counts(rows),steps:rows.map(e=>({step:e.step,conclusion:e.actual.conclusion,tests:e.tap?.counters.tests?.value??null,pass:e.tap?.counters.pass?.value??null,fail:e.tap?.counters.fail?.value??null,skipped:e.tap?.counters.skipped?.value??null}))};
};
const firstNative=native.steps.find(s=>s.conclusion==='failure'),firstDispatch=dispatch.steps.find(s=>s.conclusion==='failure');
let dispatchFailure=null;
if(firstDispatch){const groups=dispatchLog.groups.filter(g=>g.header.includes(firstDispatch.name.replace(/^Run\s+/,'').trim()));assert.equal(groups.length,1);dispatchFailure={actual:{...state(firstDispatch),name:firstDispatch.name},tap:dispatchLog.details(groups[0])};assert.ok(dispatchFailure.tap.counters.tests);}
const realClosed=[];
for(const name of (await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const path=join(out,name),r=await load(name);for(const s of ['stdout','stderr'])assert.deepEqual(info(await readFile(r[s].path)),{bytes:r[s].bytes,sha256:r[s].sha256});
 realClosed.push({path,...info(await readFile(path)),actualExit:r.actualExit,signal:r.signal,spawnError:r.spawnError??null,error:r.error??null,stdout:r.stdout,stderr:r.stderr});
}
const financial=entries.filter(e=>e.step>=8&&e.step<=113);assert.equal(financial.length,106);
const report={schema:'cinatoken-757-original-ci-terminal-observer-v1',at:new Date().toISOString(),sourceSha,collectionOnly:true,rootCauseConfirmed:false,
 nativeExecutedLocally:false,repositoryWrites:0,ciActions:0,derivedCiLogFiles:0,
 truthBoundary:'Only exact-source original GitHub run/job/step metadata and complete original logs are observed. Collector/download exit 0 verifies collection, not CI or production. Prior d537 results are not applied to this source. Quote root cause remains unconfirmed.',
 runs:metadata.map(r=>({slug:r.slug,runId:r.view.databaseId,name:r.view.name,headSha:r.view.headSha,url:r.view.url,status:r.view.status,conclusion:r.view.conclusion,
  jobs:r.view.jobs.map(j=>({jobId:j.databaseId,name:j.name,status:j.status,conclusion:j.conclusion,failedSteps:j.steps.filter(s=>s.conclusion==='failure').map(s=>({...state(s),name:s.name}))})),metadata:r.receipt.stdout})),
 logs:collection.logs,watch:collection.watchReceipt,workflow:{raw:info(await readFile(join(out,'original-proxy-workflow.stdout.log'))),mapPath:join(out,'original-workflow-map.json'),yamlActualOffset:map.yamlActualOffset},
 native:{jobId:native.databaseId,status:native.status,conclusion:native.conclusion,
  firstFailure:firstNative?{actual:{...state(firstNative),name:firstNative.name},fixture:entries.find(e=>e.step===firstNative.number)??null}:null,
  bootstrap7:entries.find(e=>e.step===7),quote24:entries.find(e=>e.step===24),retention90:entries.find(e=>e.step===90),financial8to113:{count:106,actualCounts:counts(financial),entries:financial.map(flat)},
  chain55to113:cohort(Array.from({length:59},(_,i)=>i+55)),target26:cohort(map.target26Steps),remaining6:cohort(map.remaining6Steps),
  frozen94:entries.find(e=>e.step===94),frozen109:entries.find(e=>e.step===109),tail110to113:entries.filter(e=>e.step>=110)},
 dispatch:{jobId:dispatch.databaseId,status:dispatch.status,conclusion:dispatch.conclusion,firstFailure:dispatchFailure},
 realClosedInputs:realClosed,retainedNonzeroOrNull:realClosed.filter(r=>r.actualExit!==0||r.signal||r.spawnError||r.error),
 completeLogOrder:collection.fullLogOrder,completeLogAttemptsPerJob:collection.completeLogAttemptsPerJob,
 byteOffsets:'Every range/TAP token points into the complete original UTF-8 stdout buffer. No derived log slice or raw log is created.',stopWriteAfterSeal:true};
await writeFile(join(out,'FINAL-ci-terminal-observer.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
const simpleTap=e=>e?.tap?Object.fromEntries(['tests','pass','fail','skipped'].map(k=>[k,e.tap.counters[k]?.value??null])):null;
console.log(JSON.stringify({sourceSha,runs:report.runs.map(r=>({slug:r.slug,runId:r.runId,status:r.status,conclusion:r.conclusion})),
 native:{jobId:native.databaseId,conclusion:native.conclusion,firstFailure:firstNative?.number??null,financial:report.native.financial8to113.actualCounts,tail59:report.native.chain55to113.actualCounts,target26:report.native.target26.actualCounts,remaining6:report.native.remaining6.actualCounts,
  quote24:{status:report.native.quote24.actual.conclusion,tap:simpleTap(report.native.quote24)},bootstrap7:{status:report.native.bootstrap7.actual.conclusion,tap:simpleTap(report.native.bootstrap7)},retention90:{status:report.native.retention90.actual.conclusion,tap:simpleTap(report.native.retention90)},frozen94:report.native.frozen94.actual.conclusion,frozen109:report.native.frozen109.actual.conclusion,
  tail110to113:report.native.tail110to113.map(e=>({step:e.step,fixture:e.fixture,status:e.actual.conclusion,tap:simpleTap(e)}))},
 dispatch:{jobId:dispatch.databaseId,conclusion:dispatch.conclusion,firstFailure:firstDispatch?.number??null,tap:simpleTap(dispatchFailure)},rootCauseConfirmed:false,final:info(await readFile(join(out,'FINAL-ci-terminal-observer.json')))}));
