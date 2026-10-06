import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root='C:/Users/cina/AppData/Local/Temp/cinatoken-d537-terminal-packet-peer-Fvm9uF';
const source='C:/Users/cina/AppData/Local/Temp/cinatoken-d537-ci-terminal-observer-14da29e39da54262917a3e2d0d5ed3c8';
const sourceSha='d537f83b6389a4e5bbd7f92325f74d77e6bdfc9a';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pin=p=>{const s=fs.lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink());const b=fs.readFileSync(p);return {bytes:b.length,sha256:sha(b)}};
const j=JSON.parse(fs.readFileSync(source+'/FINAL-ci-terminal-observer.json'));
assert.deepEqual(pin(source+'/FINAL-ci-terminal-observer.json'),{bytes:288169,sha256:'9d273f6d48c0d45bd4bca062896c7310fdc94f363e6d8dafdec85bd1e626ed53'});
assert.deepEqual(pin(source+'/TERMINAL-STOPWRITE-SEAL.json'),{bytes:35325,sha256:'6727d6330b27d5319676cb06461ab23f9860b6260bf694278ed26cc52ba0465a'});
const seal=JSON.parse(fs.readFileSync(source+'/TERMINAL-STOPWRITE-SEAL.json'));
assert.deepEqual(fs.readdirSync(source).sort(),[...seal.entries.map(e=>e.name),'TERMINAL-STOPWRITE-SEAL.json'].sort());
for(const e of seal.entries)assert.deepEqual(pin(e.path),{bytes:e.bytes,sha256:e.sha256});
assert.equal(seal.entries.length+1,93);assert.equal(j.sourceSha,sourceSha);
assert.equal(j.collectionOnly,true);assert.equal(j.rootCauseConfirmed,false);assert.equal(j.nativeExecutedLocally,false);
for(const r of j.runs){assert.equal(r.headSha,sourceSha);assert.equal(r.status,'completed');assert.equal(r.conclusion,r.slug==='proxy'?'failure':'success');assert.deepEqual(pin(r.metadata.path),{bytes:r.metadata.bytes,sha256:r.metadata.sha256});}
const proxy=JSON.parse(fs.readFileSync(j.runs.find(r=>r.slug==='proxy').metadata.path));
const native=proxy.jobs.find(x=>x.databaseId===j.native.jobId||x.id===j.native.jobId);
assert(native);assert.equal(native.conclusion,'failure');
const selected=native.steps.filter(x=>x.number>=8&&x.number<=113);
assert.equal(selected.length,106);
const count=xs=>xs.reduce((a,x)=>(a[x.conclusion]=(a[x.conclusion]||0)+1,a),{});
assert.deepEqual(count(selected),{success:102,failure:1,skipped:3});
assert.deepEqual(count(selected.filter(x=>x.number>=55)),{success:55,failure:1,skipped:3});
assert.deepEqual(selected.filter(x=>x.conclusion==='failure').map(x=>x.number),[110]);
assert.deepEqual(selected.filter(x=>x.conclusion==='skipped').map(x=>x.number),[111,112,113]);
const nativeBytes=fs.readFileSync(j.logs.native.stdout.path),dispatchBytes=fs.readFileSync(j.logs.dispatch.stdout.path);
assert.deepEqual(pin(j.logs.native.stdout.path),{bytes:667343,sha256:'29f68229763fc5c214ff07c380e91905ad1c70cfe4c00e674e3621fed338ba49'});
assert.deepEqual(pin(j.logs.dispatch.stdout.path),{bytes:5159606,sha256:'d1a431e6f7bafbddce2045e949a771cc5d4783f4cccad8dac690c95e0ef627f7'});
const validatedTaps=[];
const checkTap=(tap,b,label)=>{assert(tap&&tap.raw);assert.equal(tap.raw.endByte-tap.raw.startByte,tap.raw.bytes);assert(tap.raw.startByte>=0&&tap.raw.endByte<=b.length);for(const [name,c]of Object.entries(tap.counters)){const token=Buffer.from('# '+name+' '+c.value);assert(c.byteOffset>=tap.raw.startByte&&c.byteOffset+token.length<=tap.raw.endByte);assert(b.subarray(c.byteOffset,c.byteOffset+token.length).equals(token));}validatedTaps.push({label,raw:tap.raw,counters:Object.fromEntries(Object.entries(tap.counters).map(([k,v])=>[k,v.value]))});};
for(const e of j.native.financial8to113.entries){assert.deepEqual(e.actual,native.steps.find(s=>s.number===e.step));if(e.actual.conclusion!=='skipped')checkTap(e.tap,nativeBytes,'native-step-'+e.step);}
for(const e of [j.native.bootstrap7,j.native.quote24,j.native.frozen94,j.native.frozen109]){checkTap(e.tap,nativeBytes,'verified-key-step-'+e.step);assert.equal(e.actual.conclusion,'success');assert.equal(e.tap.counters.tests.value,1);assert.equal(e.tap.counters.pass.value,1);assert.equal(e.tap.counters.fail.value,0);}
for(const group of [j.native.target26,j.native.remaining6]){assert.equal(group.entries.length,group.count);for(const e of group.entries){const original=j.native.financial8to113.entries.find(x=>x.step===e.step);assert.equal(e.conclusion,'success');assert.equal(original.actual.conclusion,'success');assert.equal(e.tests,1);assert.equal(e.pass,1);assert.equal(e.fail,0);assert.equal(e.skipped,0);assert.equal(original.tap.counters.tests.value,1);assert.equal(original.tap.counters.pass.value,1);assert.equal(original.tap.counters.fail.value,0);}}
assert.equal(j.native.target26.count,26);assert.equal(j.native.remaining6.count,6);
const failure=j.native.firstFailure.fixture;
assert.equal(failure.step,110);assert.equal(failure.tap.counters.tests.value,1);assert.equal(failure.tap.counters.pass.value,0);assert.equal(failure.tap.counters.fail.value,1);
const failedSegment=nativeBytes.subarray(failure.tap.raw.startByte,failure.tap.raw.endByte).toString('utf8');
assert(failedSegment.includes("error: 'migrator is not defined'"));assert(failedSegment.includes("name: 'ReferenceError'"));assert(failedSegment.includes('postgres-legacy-parent-activation.native.test.mjs:100:48'));
checkTap(j.dispatch.firstFailure.tap,dispatchBytes,'original-dispatch-step27');
assert.equal(j.dispatch.firstFailure.actual.number,27);assert.equal(j.dispatch.conclusion,'failure');
assert.equal(j.dispatch.firstFailure.tap.counters.tests.value,8);assert.equal(j.dispatch.firstFailure.tap.counters.pass.value,7);assert.equal(j.dispatch.firstFailure.tap.counters.fail.value,1);assert.equal(j.dispatch.firstFailure.tap.counters.skipped.value,0);
const closes=fs.readdirSync(source).filter(f=>f.endsWith('.closed.json')).map(file=>{const c=JSON.parse(fs.readFileSync(path.join(source,file)));assert(c.executable||c.program);assert.equal(c.signal,null);assert.equal(c.spawnError??null,null);for(const k of ['stdout','stderr'])if(c[k])assert.deepEqual(pin(c[k].path),{bytes:c[k].bytes,sha256:c[k].sha256});return {file,actualExit:c.actualExit,...pin(path.join(source,file))};});
assert.equal(closes.length,25);assert.equal(closes.filter(c=>c.actualExit===0).length,20);assert.equal(closes.filter(c=>c.actualExit===1).length,5);assert.equal(j.realClosedInputs.length,23);
const report={schema:'d537-original-terminal-readonly-peer-precheck-v1',at:new Date().toISOString(),source,sourceSha,originalSourceFiles:93,sourceSealAllBytesShaExact:true,sourceFinal:pin(source+'/FINAL-ci-terminal-observer.json'),sourceSeal:pin(source+'/TERMINAL-STOPWRITE-SEAL.json'),runs:j.runs.map(r=>({runId:r.runId,slug:r.slug,headSha:r.headSha,status:r.status,conclusion:r.conclusion})),financialSteps:{count:106,success:102,failure:1,skipped:3},chain55to113:{count:59,success:55,failure:1,skipped:3},target26AllPass:true,remaining6AllPass:true,bootstrap7Quote24Frozen94Frozen109TapOnePass:true,step110:{tests:1,pass:0,fail:1,error:'migrator is not defined',name:'ReferenceError',sourceLocation:'postgres-legacy-parent-activation.native.test.mjs:100:48'},skipSteps:[111,112,113],strictDispatch:{tests:8,pass:7,fail:1,skipped:0},nativeRaw:pin(j.logs.native.stdout.path),dispatchRaw:pin(j.logs.dispatch.stdout.path),realClosedAll25:{count:25,zero:20,one:5,receipts:closes},originalFinal23InputsBeforeLastTwoChecks:{count:23,zero:18,one:5},validatedTaps,collectionOnly:true,rootCauseConfirmed:false,nativeExecutedLocally:false,ciRequestsPerformedHere:0,productionRequestsPerformedHere:0,repositoryWrites:0,gatePassDerived:false,fullG7:false,fullG8:false,limitations:['This only verifies the observed exact d537 original terminal metadata/full raw; no runtime was repeated.','A quote fixture passing does not prove the historical failure cause.','Step110 repair source and future SHA CI are separate preparation/runtime cohorts.','Collector/download status0 is not the failing Proxy or strict cancellation status0.']};
const target=root+'/PRECHECK-original-d537-terminal.json';fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:target,...pin(target),originalFiles:93,realClosed:25,zero:20,one:5,financialSteps:report.financialSteps,chain55to113:report.chain55to113,strictDispatch:report.strictDispatch,collectionOnly:true,gatePassDerived:false}));
