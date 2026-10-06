import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const load=async name=>JSON.parse(await readFile(join(out,name),'utf8'));
const collection=await load('TERMINAL-ci-collection.json'),map=await load('original-workflow-map-v2.json');
const sha='d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a';
assert.equal(collection.sourceSha,sha);assert.equal(map.sourceSha,sha);
const proxy=collection.proxy.view,native=proxy.jobs.find(j=>j.databaseId===112131520308),dispatch=proxy.jobs.find(j=>j.databaseId===112131520499);
assert.equal(proxy.status,'completed');assert.equal(native.status,'completed');assert.equal(dispatch.status,'completed');
const nativeRead=collection.reads.find(r=>r.label==='native-terminal'),dispatchRead=collection.reads.find(r=>r.label==='dispatch-terminal');
async function logIndex(read){
 assert.equal(read.receipt.actualExit,0);assert.equal(read.receipt.signal,null);assert.equal(read.receipt.spawnError,null);
 const raw=await readFile(read.receipt.stdout.path);assert.deepEqual(info(raw),{bytes:read.receipt.stdout.bytes,sha256:read.receipt.stdout.sha256});
 const text=raw.toString('utf8');assert.equal(Buffer.compare(Buffer.from(text,'utf8'),raw),0);
 const positions=[...text.matchAll(/^.*?##\[group\]Run .*$/gm)].map(m=>m.index);
 const byte=c=>Buffer.byteLength(text.slice(0,c),'utf8');
 const groups=positions.map((start,i)=>{
  const end=positions[i+1]??text.length,body=text.slice(start,end),headerEnd=body.indexOf('##[endgroup]');
  assert.ok(headerEnd>=0);return{start,end,body,header:body.slice(0,headerEnd),raw:{path:read.receipt.stdout.path,startByte:byte(start),endByte:byte(end),bytes:byte(end)-byte(start)}};
 });
 const details=g=>{
  const counters={};
  for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo']){
   const matches=[...g.body.matchAll(new RegExp('# '+key+' (\\d+)','g'))],m=matches.at(-1);
   counters[key]=m?{value:Number(m[1]),byteOffset:byte(g.start+m.index)}:null;
  }
  const exitCodes=[...g.body.matchAll(/Process completed with exit code (\d+)/g)].map(m=>({value:Number(m[1]),byteOffset:byte(g.start+m.index)}));
  const failedSubtests=[...g.body.matchAll(/\bnot ok (\d+) - ([^\r\n]+)/g)].map(m=>({number:Number(m[1]),name:m[2],byteOffset:byte(g.start+m.index)}));
  const subtests=[...g.body.matchAll(/# Subtest: ([^\r\n]+)/g)].map(m=>({name:m[1],byteOffset:byte(g.start+m.index)}));
  const locations=[...g.body.matchAll(/(?:file:\/\/[^\s'"()]*\/)?scripts\/(?:db\/cutover|staging)\/[^\s'"()]+?\.(?:mjs|[cm]?ts):\d+(?::\d+)?/g)].map(m=>({source:m[0],byteOffset:byte(g.start+m.index)}));
  return{raw:g.raw,counters,exitCodes,failedSubtests,subtests,locations};
 };
 return{read,groups,details};
}
const nativeLog=await logIndex(nativeRead),dispatchLog=await logIndex(dispatchRead);
const fixtureEntries=map.nativeFixtureSteps.filter(s=>s.step>=7&&s.step<=113);
assert.equal(fixtureEntries.length,107);assert.deepEqual(fixtureEntries.map(s=>s.step),Array.from({length:107},(_,i)=>i+7));
const status=s=>({number:s.number,name:s.name,status:s.status,conclusion:s.conclusion,startedAt:s.startedAt,completedAt:s.completedAt});
const fixtures=fixtureEntries.map(entry=>{
 const actual=native.steps.find(s=>s.number===entry.step);assert.ok(actual);assert.equal(actual.status,'completed');
 const groups=nativeLog.groups.filter(g=>g.header.includes(entry.fixture));
 if(actual.conclusion==='skipped'){assert.equal(groups.length,0);return{step:entry.step,fixture:entry.fixture,yamlStep:entry.yamlStep,workflowLine:entry.workflowLine,actual:status(actual),tap:null};}
 assert.equal(groups.length,1,'One original full-log command group for actual step '+entry.step);
 const detail=nativeLog.details(groups[0]);assert.ok(detail.counters.tests,'Original TAP counter for actual step '+entry.step);
 return{step:entry.step,fixture:entry.fixture,yamlStep:entry.yamlStep,workflowLine:entry.workflowLine,actual:status(actual),tap:detail};
});
function cohort(numbers,full=false){const source=numbers.map(n=>{const e=fixtures.find(f=>f.step===n);assert.ok(e);return e;});return{steps:numbers,count:source.length,actualCounts:source.reduce((a,e)=>(a[e.actual.conclusion]=(a[e.actual.conclusion]??0)+1,a),{}),entries:full?source:source.map(e=>({step:e.step,fixture:e.fixture,status:e.actual.status,conclusion:e.actual.conclusion,tests:e.tap?.counters.tests?.value??null,pass:e.tap?.counters.pass?.value??null,fail:e.tap?.counters.fail?.value??null,skipped:e.tap?.counters.skipped?.value??null}))};}
const firstNative=native.steps.find(s=>s.conclusion==='failure'),firstDispatch=dispatch.steps.find(s=>s.conclusion==='failure');
let dispatchFailure=null;
if(firstDispatch){
 const normalized=firstDispatch.name.replace(/^Run\s+/,'').trim();
 const groups=dispatchLog.groups.filter(g=>g.header.includes(normalized));assert.equal(groups.length,1,'One full-log group for actual dispatch first failure');
 dispatchFailure={actual:status(firstDispatch),tap:dispatchLog.details(groups[0])};
 assert.ok(dispatchFailure.tap.counters.tests);assert.ok(dispatchFailure.tap.counters.fail.value>0);
}
const views=[{slug:'proxy',view:proxy,receipt:collection.proxy.receipt},...collection.reads.filter(r=>r.view).map(r=>({slug:r.label.replace('-terminal',''),view:r.view,receipt:r.receipt})),...collection.reusedAlreadyTerminal];
assert.equal(views.length,5);
for(const v of views){assert.equal(v.view.headSha,sha);assert.equal(v.view.status,'completed');}
const receipts=[];
for(const name of (await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const receipt=await load(name);
 for(const stream of ['stdout','stderr']){
  const raw=await readFile(receipt[stream].path);assert.deepEqual(info(raw),{bytes:receipt[stream].bytes,sha256:receipt[stream].sha256});
 }
 receipts.push({path:join(out,name),...info(await readFile(join(out,name))),actualExit:receipt.actualExit,signal:receipt.signal,spawnError:receipt.spawnError??null,error:receipt.error??null,stdout:receipt.stdout,stderr:receipt.stderr});
}
const financial=cohort(Array.from({length:106},(_,i)=>i+8),true),tail=cohort(Array.from({length:59},(_,i)=>i+55)),targets=cohort(map.target26Steps),remaining=cohort(map.remaining6Steps);
const report={schema:'cinatoken-d537-original-ci-terminal-observer-v1',at:new Date().toISOString(),sourceSha:sha,
 collectionOnly:true,rootCauseConfirmed:false,nativeExecutedLocally:false,repositoryWrites:0,ciActions:0,derivedCiLogFiles:0,
 truthBoundary:'GitHub job/step metadata and complete original job logs are observed for this exact source SHA. Download and collector exit 0 only proves collection. No database/application/CI rerun occurred. Quote step success does not establish root cause.',
 runs:views.map(v=>({slug:v.slug,runId:v.view.databaseId,name:v.view.name,status:v.view.status,conclusion:v.view.conclusion,headSha:v.view.headSha,url:v.view.url,jobs:v.view.jobs.map(j=>({jobId:j.databaseId,name:j.name,status:j.status,conclusion:j.conclusion,failedSteps:j.steps.filter(s=>s.conclusion==='failure').map(status)})),metadata:v.receipt.stdout})),
 logs:{native:nativeRead.receipt,dispatch:dispatchRead.receipt},watch:collection.watchReceipt,
 native:{jobId:native.databaseId,status:native.status,conclusion:native.conclusion,firstFailure:firstNative?{actual:status(firstNative),fixture:fixtures.find(f=>f.step===firstNative.number)??null}:null,
  bootstrap7:fixtures.find(f=>f.step===7),quote24:fixtures.find(f=>f.step===24),financial8to113:financial,chain55to113:tail,target26:targets,remaining6:remaining,
  frozen94:fixtures.find(f=>f.step===94),frozen109:fixtures.find(f=>f.step===109)},
 dispatch:{jobId:dispatch.databaseId,status:dispatch.status,conclusion:dispatch.conclusion,firstFailure:dispatchFailure},
 realClosedInputs:receipts,retainedNonzeroOrNull:receipts.filter(r=>r.actualExit!==0||r.signal||r.spawnError||r.error),
 byteOffsets:'All ranges and TAP tokens reference full original UTF-8 stdout buffers. No extracted log file is created.',stopWriteAfterSeal:true};
await writeFile(join(out,'FINAL-ci-terminal-observer.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sourceSha:sha,runs:report.runs.map(r=>({slug:r.slug,runId:r.runId,status:r.status,conclusion:r.conclusion})),native:{conclusion:native.conclusion,firstFailure:firstNative?.number??null,financial:financial.actualCounts,tail59:tail.actualCounts,target26:targets.actualCounts,remaining6:remaining.actualCounts,quote24:report.native.quote24.actual.conclusion,frozen94:report.native.frozen94.actual.conclusion,frozen109:report.native.frozen109.actual.conclusion},dispatch:{conclusion:dispatch.conclusion,firstFailure:firstDispatch?.number??null,counters:dispatchFailure?.tap.counters},rootCauseConfirmed:false,final:info(await readFile(join(out,'FINAL-ci-terminal-observer.json')))}));
