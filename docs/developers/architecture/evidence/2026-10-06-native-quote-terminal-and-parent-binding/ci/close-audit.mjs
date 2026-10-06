import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const load=async n=>JSON.parse(await readFile(join(out,n),'utf8'));
const final=await load('FINAL-ci-terminal-observer.json');
assert.equal(final.sourceSha,'d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a');assert.equal(final.rootCauseConfirmed,false);
assert.deepEqual(final.native.financial8to113.actualCounts,{success:102,failure:1,skipped:3});
assert.deepEqual(final.native.chain55to113.actualCounts,{success:55,failure:1,skipped:3});
assert.deepEqual(final.native.target26.actualCounts,{success:26});assert.deepEqual(final.native.remaining6.actualCounts,{success:6});
assert.equal(final.native.frozen94.actual.conclusion,'success');assert.equal(final.native.frozen109.actual.conclusion,'success');
const totals=e=>Object.fromEntries(['tests','pass','fail','skipped'].map(k=>[k,e.tap.counters[k].value]));
assert.deepEqual(totals(final.native.quote24),{tests:1,pass:1,fail:0,skipped:0});
assert.deepEqual(totals(final.native.bootstrap7),{tests:1,pass:1,fail:0,skipped:0});
assert.deepEqual(totals(final.native.firstFailure.fixture),{tests:1,pass:0,fail:1,skipped:0});
assert.deepEqual(totals(final.dispatch.firstFailure),{tests:8,pass:7,fail:1,skipped:0});
const summaries=[];
for(const file of (await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const r=await load(file);for(const s of ['stdout','stderr'])assert.deepEqual(info(await readFile(r[s].path)),{bytes:r[s].bytes,sha256:r[s].sha256});
 summaries.push({file,actualExit:r.actualExit,signal:r.signal,spawnError:r.spawnError??null,error:r.error??null});
}
assert.ok(summaries.every(r=>r.signal===null&&r.spawnError===null&&r.error===null));
const expectedNonzero=['collect-terminal.closed.json','commit-runs.closed.json','dispatch-terminal.closed.json','prepare-workflow-map.closed.json','proxy-watch-1.closed.json'];
assert.deepEqual(summaries.filter(r=>r.actualExit!==0).map(r=>r.file),expectedNonzero);
const observations=[];
for(const [kind,record] of [['native',final.native.firstFailure.fixture],['dispatch',final.dispatch.firstFailure]]){
 const raw=await readFile(record.tap.raw.path),text=raw.toString('utf8'),body=raw.subarray(record.tap.raw.startByte,record.tap.raw.endByte).toString('utf8');
 const fields={};
 for(const key of ['failureType','error','code','name','expected','actual']){
  const m=new RegExp('^.*?\\s{2}'+key+': ([^\\r\\n]+)','m').exec(body);
  fields[key]=m?{value:m[1],byteOffset:record.tap.raw.startByte+Buffer.byteLength(body.slice(0,m.index))}:null;
 }
 observations.push({kind,actualStep:kind==='native'?110:27,range:record.tap.raw,fields,assertionExpectedActualAbsent:kind==='native'&&fields.expected===null&&fields.actual===null,rawSHA:info(raw)});
}
const result={at:new Date().toISOString(),collectionOnly:true,rootCauseConfirmed:false,receiptBytesAllExact:true,
 closes:summaries.length,zero:summaries.filter(r=>r.actualExit===0).length,nonzero:summaries.filter(r=>r.actualExit!==0),null:summaries.filter(r=>r.actualExit===null),
 failureObservations:observations,final:{path:join(out,'FINAL-ci-terminal-observer.json'),...info(await readFile(join(out,'FINAL-ci-terminal-observer.json')))},
 noDerivedCiLogFiles:true,originalFailureAndTransportRecordsRetained:true};
await writeFile(join(out,'CLOSED-byte-and-semantic-audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
