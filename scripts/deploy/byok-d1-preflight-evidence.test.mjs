import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {byokD1DeploymentFingerprint} from './byok-d1-deployment.mjs';
import {createByokD1Operator} from './byok-d1-operator.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
const modulePath=process.env.BYOK_PREFLIGHT_EVIDENCE_MODULE,metaPath=process.env.BYOK_PREFLIGHT_EVIDENCE_META;
assert.ok(modulePath&&metaPath,'This producer is exercised as its frozen bundle, never an unpinned source import');
const {createByokD1PreflightEvidence:create}=await import(pathToFileURL(resolve(modulePath)).href);
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v));
const record=path=>({path,bytes:fs.statSync(path).size,sha256:sha(fs.readFileSync(path))});
const roles={receiver:'cinatoken-staging-usage-recovery',controller:c.worker,gateway:g.worker};
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const apiToken='synthetic-preflight-credential-not-for-output',installToken='c1'.repeat(32);
const runtimeCode='// fixture 中文\nexport default {};\r\n';
function fixture(extra={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','preflight-evidence-test-'));
  const settings={bindings:[]};
  const candidate={runId:'c02-byok-012345abcdef',priorManifestSha256:'b'.repeat(64),
    grant:{version:1,runId:'c02-byok-012345abcdef',tokenHash:sha(installToken),schemaSha256:'d'.repeat(64),fencedSchemaSha256:'e'.repeat(64),issuedAt:1,expiresAt:900},
    bundles:Object.fromEntries(Object.keys(roles).map(r=>{const code='export default '+JSON.stringify(r)+';';return [r,{code,sha256:sha(code)}];})),
    priorWorkers:Object.fromEntries(Object.keys(roles).map((r,i)=>[r,{settingsSha256:hash(settings),versionId:id(i+1)}]))};
  const expected={workers:[...Object.values(roles),'cinatoken-staging-images-upstream'].map((name,i)=>({name,settingsSha256:hash(settings),versions:[{version_id:id(i+1),percentage:100}]})),
    production:['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].map(name=>({name,settingsSha256:'a'.repeat(64)})),
    access:[g,c].map(t=>({id:t.app,sha256:'a'.repeat(64)})),previousTokenIds:[]};
  const meta=JSON.parse(fs.readFileSync(metaPath)),sourceSnapshot={version:1,sources:Object.keys(meta.inputs).map(record),
    evidence:[record(relative(resolve('.'),resolve(modulePath)).replaceAll('\\','/')),record(relative(resolve('.'),resolve(metaPath)).replaceAll('\\','/'))]};
  const sign=()=>{delete sourceSnapshot.evidenceSha256;sourceSnapshot.evidenceSha256=hash(sourceSnapshot);};sign();
  let sourceValid=true,hook,sourceChecks=0;const calls=[];
  const sourceFreeze={assertCurrent(){sourceChecks++;return sourceValid;},bindCandidate(value){return {runId:value.runId,candidateSha256:byokD1DeploymentFingerprint(value),
    priorManifestSha256:value.priorManifestSha256,sourceEvidenceSha256:sourceSnapshot.evidenceSha256};}};
  const now=Date.now(),subscription={id:'a'.repeat(32),rate_plan:{id:'workers_paid',scope:'account',public_name:'Workers Paid'},state:'Paid',
    current_period_start:new Date(now-86400000).toISOString(),current_period_end:new Date(now+86400000).toISOString(),currency:'USD',price:5};
  const directory=resolve(workspace,'.wrangler/staging/byok-d1-preflight-evidence-reservation');
  const options={workspace,sourceRoot:resolve('.'),candidate,expected,sourceSnapshot,sourceFreeze,producerMetafile:relative(resolve('.'),resolve(metaPath)).replaceAll('\\','/'),apiToken,
    fetchImpl:async(url,init)=>{
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.body,undefined);
      assert.equal(init.headers.Authorization,'Bearer '+apiToken);assert.ok(fs.readFileSync(resolve(directory,'journal.jsonl'),'utf8').includes('COLLECTION_PENDING'));
      const path=new URL(url).pathname;calls.push(path);const value=await hook?.(path,init);if(value!==undefined)return value;
      const json=result=>Response.json({success:true,errors:null,result});
      if(path.endsWith('/account-settings'))return json({default_usage_model:'standard'});
      if(path.endsWith('/subscriptions'))return json([subscription]);
      if(path.endsWith('/settings'))return json(settings);
      const entry=Object.entries(roles).find(([,name])=>path.includes('/'+name));assert.ok(entry);
      if(path.endsWith('/deployments'))return json({deployments:[{versions:[{version_id:candidate.priorWorkers[entry[0]].versionId,percentage:100}]}]});
      const form=new FormData();form.set('main.js',new Blob([runtimeCode]),'main.js');const r=new Response(form);r.headers.set('cf-entrypoint','main.js');return r;
    },...extra};
  return {workspace,directory,options,candidate,expected,sourceSnapshot,subscription,calls,sign,
    make:()=>create(options),setHook:f=>{hook=f;},setSource:v=>{sourceValid=v;},sourceChecks:()=>sourceChecks};
}
const localIdentity=r=>({...r.identity,evidenceSha256:r.evidenceSha256});
test('real collectors join 19 GETs under one candidate/source/scope identity, never full preflight',async()=>{
  const f=fixture(),p=f.make();assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
  const first=p.run();assert.equal(first,p.run());const r=await first;
  assert.equal(r.result,'PARTIAL_EVIDENCE_COLLECTED');assert.equal(r.httpAttempts,19);assert.equal(r.unsettledFetchRequests,0);assert.ok(r.peakActive<=4);
  assert.deepEqual(r.observed,{sources:true,priorCode:true,paidPlan:true});assert.equal(r.missing.length,4);
  assert.equal(r.fullPreflightPassed,false);assert.equal(r.budgetVerified,false);assert.equal(r.executionReservationCreated,false);
  assert.equal(fs.existsSync(resolve(f.workspace,'.wrangler/staging/byok-d1-execution-reservation')),false);
  assert.equal(r.identity.scopeSha256,hash(f.expected));assert.equal(r.identity.candidateSha256,byokD1DeploymentFingerprint(f.candidate));
  assert.equal(p.checkLocalEvidence(localIdentity(r)).remoteStateRevalidated,false);
  assert.equal(p.preflight,undefined);assert.equal(p.assertReady,undefined);
  assert.ok(!JSON.stringify(r).includes(apiToken)&&!JSON.stringify(r).includes(runtimeCode));
  r.missing.length=0;assert.equal(p.report().missing.length,4);
});
test('durable composite journal is hash chained and bound to child archives',async()=>{
  const f=fixture(),p=f.make(),r=await p.run();let prev='0'.repeat(64);
  for(const event of fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse)){
    const {sha256,...data}=event;assert.equal(data.previous,prev);assert.equal(hash(data),sha256);prev=sha256;
  }assert.equal(prev,r.journal.lastSha256);assert.equal(r.artifacts.length,8);
  const {evidenceSha256,...rest}=r;assert.equal(hash(rest),evidenceSha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(resolve(f.directory,'result.json'))),r);
});
test('partial evidence is rejected by real operator before any cloud request',async()=>{
  const f=fixture(),r=await f.make().run();let external=0;
  const operator=createByokD1Operator({workspace:f.workspace,candidate:f.candidate,expected:f.expected,apiToken,installToken,
    preflight:async()=>r,assertReady:()=>true,fetchImpl:async()=>{external++;throw Error('must not call');},signal:undefined});
  const state=await operator.run();assert.equal(state.result,'ATTENTION_REQUIRED');assert.equal(state.failedPhase,'preflight');assert.equal(external,0);
});
test('existing independent evidence reservation prevents a second collection',async()=>{
  const f=fixture();await f.make().run();const n=f.calls.length;const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(f.calls.length,n);
});
test('existing execution reservation prevents discovery reuse',async()=>{
  const f=fixture();fs.mkdirSync(resolve(f.workspace,'.wrangler/staging/byok-d1-execution-reservation'),{recursive:true});
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);
});
for(const mode of ['candidate-prior','scope','source-false','source-async','binding-identity','binding-async','snapshot-hash','producer-record','metafile-record','omitted-input','wrong-input-size','extra-option','timeout','api-token']){
  test('invalid admission inputs stop before I/O: '+mode,()=>{
    const f=fixture();
    if(mode==='candidate-prior')f.candidate.priorWorkers.receiver.settingsSha256='f'.repeat(64);
    if(mode==='scope')f.expected.production=[];
    if(mode==='source-false')f.setSource(false);
    if(mode==='source-async')f.options.sourceFreeze.assertCurrent=async()=>true;
    if(mode==='binding-identity')f.options.sourceFreeze.bindCandidate=()=>({runId:'another'});
    if(mode==='binding-async')f.options.sourceFreeze.bindCandidate=async()=>({});
    if(mode==='snapshot-hash')f.sourceSnapshot.evidenceSha256='0'.repeat(64);
    if(mode==='producer-record'){f.sourceSnapshot.evidence.shift();f.sign();}
    if(mode==='metafile-record'){f.sourceSnapshot.evidence.pop();f.sign();}
    if(mode==='omitted-input'){f.sourceSnapshot.sources.shift();f.sign();}
    if(mode==='wrong-input-size'){f.sourceSnapshot.sources[0].bytes++;f.sign();}
    if(mode==='extra-option')f.options.allowPartial=true;
    if(mode==='timeout')f.options.timeoutMs=60001;
    if(mode==='api-token')f.options.apiToken+='\n';
    assert.throws(f.make,/options_invalid/);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
  });
}
test('source change after construction blocks before GET',async()=>{const f=fixture(),p=f.make();f.setSource(false);assert.equal((await p.run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);});
for(const mode of ['external-package','missing-input'])test('producer graph cannot hide executable dependencies: '+mode,()=>{
  const f=fixture(),meta=JSON.parse(fs.readFileSync(metaPath));
  if(mode==='external-package')Object.values(meta.outputs)[0].imports.push({path:'unfrozen-package',kind:'import-statement',external:true});
  else Object.values(meta.inputs)[0].imports.push({path:'unrecorded-input.mjs',kind:'import-statement'});
  const absolute=resolve(f.workspace,'invalid-producer.meta.json'),p=relative(resolve('.'),absolute).replaceAll('\\','/');fs.writeFileSync(absolute,JSON.stringify(meta));
  f.options.producerMetafile=p;f.sourceSnapshot.evidence[1]=record(p);f.sign();assert.throws(f.make,/options_invalid/);assert.equal(f.calls.length,0);
});
test('reserve one revoked-token observer slot before any collection',()=>{const f=fixture();f.expected.previousTokenIds=Array.from({length:100},(_,i)=>id(i+100));assert.throws(f.make,/options_invalid/);assert.equal(f.calls.length,0);});
test('caller mutation after construction cannot change captured identity',async()=>{
  const f=fixture(),p=f.make(),old=byokD1DeploymentFingerprint(f.candidate);f.candidate.bundles.gateway.code='changed';
  const r=await p.run();assert.equal(r.identity.candidateSha256,old);assert.equal(r.result,'PARTIAL_EVIDENCE_COLLECTED');
});
for(const mode of ['403','settings-drift','version-drift','free-plan','plan-change','multipart','source-during-read']){
  test('incomplete component retains failure and no complete proof: '+mode,async()=>{
    const f=fixture();let subs=0;f.setHook(path=>{
      if(mode==='403')return new Response(null,{status:403});
      if(mode==='settings-drift'&&path.endsWith('/settings'))return Response.json({success:true,result:{changed:true}});
      if(mode==='version-drift'&&path.endsWith('/deployments'))return Response.json({success:true,result:{deployments:[]}});
      if(mode==='free-plan'&&path.endsWith('/subscriptions'))return Response.json({success:true,result:[]});
      if(mode==='plan-change'&&path.endsWith('/subscriptions')&&++subs===2){f.subscription.price=6;}
      if(mode==='multipart'&&Object.values(roles).some(w=>path.endsWith('/'+w)))return new Response('broken',{headers:{'Content-Type':'multipart/form-data; boundary=abc'}});
      if(mode==='source-during-read')f.setSource(false);
    });const p=f.make(),r=await p.run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.fullPreflightPassed,false);assert.equal(r.evidenceSha256,undefined);assert.ok(f.calls.length<=19);
    assert.throws(()=>p.checkLocalEvidence(localIdentity(r)));assert.ok(!JSON.stringify(r).includes(apiToken));
  });
}
test('aborted before run does not create reservation or request',async()=>{const f=fixture({signal:AbortSignal.abort()}),p=f.make();assert.equal((await p.run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);});
test('deadline with noncooperative fetch returns and late headers do not change final evidence',{timeout:5000},async()=>{
  // The deadline must outlast durable reservation so this exercises an in-flight fetch.
  const f=fixture({timeoutMs:1000}),releases=[];f.setHook(()=>new Promise(resolve=>releases.push(resolve)));const p=f.make(),r=await p.run();
  assert.equal(r.result,'FAILED_RETAINED');assert.ok(r.unsettledFetchRequests>0);const before=JSON.stringify(p.report());
  for(const release of releases)release(new Response('{}',{headers:{'Content-Type':'application/json'}}));await tick();await tick();assert.equal(JSON.stringify(p.report()),before);
});
test('initial fsync failure prevents network',async()=>{const f=fixture({io:{...fs,fsyncSync(){throw Error('fault');}}});await assert.rejects(f.make().run(),/not_durable/);assert.equal(f.calls.length,0);});
test('zero-progress parent journal writes cannot start network',async()=>{const f=fixture({io:{...fs,writeSync(){return 0;}}});await assert.rejects(f.make().run(),/not_durable/);assert.equal(f.calls.length,0);});
test('FINISHED journal fsync failure revokes otherwise collected evidence',async()=>{
  let writes=0;const f=fixture({io:{...fs,fsyncSync(fd){if(++writes===3)throw Error('finish fault');fs.fsyncSync(fd);}}});
  const p=f.make(),r=await p.run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.failedPhase,'journal-finish');assert.equal(r.evidenceSha256,undefined);assert.equal(f.calls.length,19);
  assert.throws(()=>p.checkLocalEvidence(localIdentity(r)));
});
test('result fsync failure cannot return usable evidence',async()=>{
  let writes=0;const f=fixture({io:{...fs,fsyncSync(fd){if(++writes===4)throw Error('result fault');fs.fsyncSync(fd);}}});
  const p=f.make();await assert.rejects(p.run(),/not_durable/);assert.equal(p.report().result,'FAILED_RETAINED');assert.equal(p.report().evidenceSha256,undefined);
});
test('result close failure poisons even an apparently complete disk document',async()=>{
  const paths=new Map();const f=fixture({io:{...fs,openSync(p,...args){const fd=fs.openSync(p,...args);paths.set(fd,p);return fd;},closeSync(fd){
    const p=paths.get(fd);fs.closeSync(fd);if(p?.endsWith('result.json'))throw Error('close fault');}}});
  const p=f.make();await assert.rejects(p.run(),/not_durable/);const disk=JSON.parse(fs.readFileSync(resolve(f.directory,'result.json')));
  assert.equal(disk.result,'PARTIAL_EVIDENCE_COLLECTED');assert.throws(()=>p.checkLocalEvidence(localIdentity(disk)));assert.equal(p.report().evidenceSha256,undefined);
});
test('short writes are completed before child readers start',async()=>{
  const f=fixture({io:{...fs,writeSync(fd,data,at,length){return fs.writeSync(fd,data,at,Math.min(length,7));}}});assert.equal((await f.make().run()).result,'PARTIAL_EVIDENCE_COLLECTED');
});
for(const mode of ['result','journal','code','source','identity','digest']){
  test('local evidence drift or identity mismatch poisons reuse: '+mode,async()=>{
    const f=fixture(),p=f.make(),r=await p.run(),input=localIdentity(r);
    if(mode==='result')fs.appendFileSync(resolve(f.directory,'result.json'),'{}');
    if(mode==='journal')fs.appendFileSync(resolve(f.directory,'journal.jsonl'),'{}');
    if(mode==='code')fs.appendFileSync(resolve(f.directory,r.artifacts.find(a=>a.path.endsWith('.bin')).path),'x');
    if(mode==='source')f.setSource(false);
    if(mode==='identity')input.scopeSha256='0'.repeat(64);
    if(mode==='digest')input.evidenceSha256='0'.repeat(64);
    assert.throws(()=>p.checkLocalEvidence(input),/unconfirmed/);assert.throws(()=>p.checkLocalEvidence(localIdentity(r)),/unconfirmed/);
  });
}
test('wall-clock rollback cannot extend local evidence usability',async()=>{
  const f=fixture(),p=f.make(),r=await p.run(),now=Date.now;
  try{Date.now=()=>now()-2000;assert.throws(()=>p.checkLocalEvidence(localIdentity(r)),/unconfirmed/);}
  finally{Date.now=now;}
  assert.throws(()=>p.checkLocalEvidence(localIdentity(r)),/unconfirmed/);
});
