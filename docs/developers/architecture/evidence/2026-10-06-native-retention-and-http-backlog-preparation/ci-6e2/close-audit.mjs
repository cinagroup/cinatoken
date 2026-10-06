import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {out,info} from './capture.mjs';
const load=async name=>JSON.parse(await readFile(join(out,name),'utf8'));
const final=await load('FINAL-ci-terminal-observer.json'),map=await load('original-workflow-map.json');
const sourceSha='6e2d65b35d4d60b3b14dac2ecbf9fbaa8ca363fa';assert.equal(final.sourceSha,sourceSha);assert.equal(final.rootCauseConfirmed,false);assert.equal(final.collectionOnly,true);
const proxy=await load('proxy-terminal.stdout.log'),native=proxy.jobs.find(j=>j.databaseId===final.native.jobId),dispatch=proxy.jobs.find(j=>j.databaseId===final.dispatch.jobId);
assert.equal(proxy.headSha,sourceSha);assert.equal(proxy.status,'completed');assert.equal(native.status,'completed');assert.equal(dispatch.status,'completed');
const financial=final.native.financial8to113.entries;assert.equal(financial.length,106);assert.deepEqual(financial.map(e=>e.step),Array.from({length:106},(_,i)=>i+8));
const actualCounts={};for(const e of financial){const actual=native.steps.find(s=>s.number===e.step);assert.ok(actual);assert.equal(e.status,actual.status);assert.equal(e.conclusion,actual.conclusion);actualCounts[e.conclusion]=(actualCounts[e.conclusion]??0)+1;
 const source=map.fixtures.find(s=>s.step===e.step);assert.equal(e.fixture,source.fixture);assert.equal(e.yamlStep,source.yamlStep);assert.equal(e.workflowLine,source.workflowLine);
 if(e.conclusion==='skipped'){assert.equal(e.range,null);assert.equal(e.tests,null);}else{assert.ok(e.range);assert.ok(Number.isInteger(e.tests));}
}assert.deepEqual(actualCounts,final.native.financial8to113.actualCounts);
for(const [name,numbers] of [['chain55to113',Array.from({length:59},(_,i)=>i+55)],['target26',map.target26Steps],['remaining6',map.remaining6Steps]]){
 const c=final.native[name];assert.equal(c.count,numbers.length);assert.deepEqual(c.steps.map(s=>s.step),numbers);const counts={};
 for(const e of c.steps){const origin=financial.find(s=>s.step===e.step);assert.equal(e.conclusion,origin.conclusion);for(const key of ['tests','pass','fail','skipped'])assert.equal(e[key],origin[key]);counts[e.conclusion]=(counts[e.conclusion]??0)+1;}
 assert.deepEqual(c.actualCounts,counts);
}
assert.deepEqual(final.native.tail110to113.map(e=>e.step),[110,111,112,113]);
for(const e of [final.native.bootstrap7,final.native.quote24,final.native.frozen94,final.native.frozen109,...final.native.tail110to113]){
 const actual=native.steps.find(s=>s.number===e.step);assert.equal(e.actual.status,actual.status);assert.equal(e.actual.conclusion,actual.conclusion);
 if(e.tap){const raw=await readFile(e.tap.range.path);for(const [key,counter] of Object.entries(e.tap.counters))if(counter){const token='# '+key+' '+counter.value;assert.equal(raw.subarray(counter.byteOffset,counter.byteOffset+Buffer.byteLength(token)).toString('utf8'),token);}}
}
if(final.dispatch.firstFailure){const actual=dispatch.steps.find(s=>s.conclusion==='failure');assert.equal(final.dispatch.firstFailure.actual.number,actual.number);
 const d=final.dispatch.firstFailure.tap,raw=await readFile(d.range.path);for(const [key,counter] of Object.entries(d.counters))if(counter){const token='# '+key+' '+counter.value;assert.equal(raw.subarray(counter.byteOffset,counter.byteOffset+Buffer.byteLength(token)).toString('utf8'),token);}
}
const closes=[];for(const name of (await readdir(out)).filter(n=>n.endsWith('.closed.json')).sort()){
 const r=await load(name);for(const s of ['stdout','stderr'])assert.deepEqual(info(await readFile(r[s].path)),{bytes:r[s].bytes,sha256:r[s].sha256});
 closes.push({name,actualExit:r.actualExit,signal:r.signal,spawnError:r.spawnError??null,error:r.error??null});
}
const data={schema:'cinatoken-6e2-terminal-byte-and-semantics-v1',at:new Date().toISOString(),sourceSha,collectionOnly:true,rootCauseConfirmed:false,
 metadataAndWorkflowStepsExact:true,fullLogTAPTokenOffsetsExact:true,capturedBytesAllExact:true,financialCount:106,chainCount:59,targetCount:26,remainingCount:6,
 actualCloses:closes.length,zero:closes.filter(r=>r.actualExit===0).length,nonzeroOrNull:closes.filter(r=>r.actualExit!==0||r.signal||r.spawnError||r.error),
 final:{path:join(out,'FINAL-ci-terminal-observer.json'),...info(await readFile(join(out,'FINAL-ci-terminal-observer.json')))},
 logs:Object.fromEntries(Object.entries(final.logs).map(([name,r])=>[name,r.stdout])),noDerivedCiLogFiles:true};
await writeFile(join(out,'CLOSED-byte-and-semantic-audit.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(data));
