import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate as tick} from 'node:timers/promises';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
const {createByokD1Deployment:create,byokD1DeploymentFingerprint:fingerprint}=await import(process.env.BYOK_D1_DEPLOYMENT_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_DEPLOYMENT_MODULE)).href:new URL('./byok-d1-deployment.mjs',import.meta.url).href);
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(JSON.stringify(v));
const roles=['receiver','controller','gateway'],names=['cinatoken-staging-usage-recovery',c.worker,g.worker];
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),runId='c02-byok-a1b2c3d4e5f6',apiToken='synthetic-deployment-api-secret';
const response=result=>Response.json({success:true,errors:[],result});
const closedApp=t=>({id:t.app,aud:t.audience,domain:t.domain,type:'self_hosted',destinations:[{type:'public',uri:t.domain}],
  policies:[{id:t.policy,precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}],service_auth_401_redirect:false});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,{options={},candidateChange,metadataChange}={}){
  const settings=new Map(names.map(name=>[name,{bindings:[],compatibility_date:'2026-09-16',compatibility_flags:['nodejs_compat'],
    observability:{enabled:true,head_sampling_rate:1,logs:{invocation_logs:false}}}]));
  const versions=new Map(names.map((name,i)=>[name,id(i+1)])),ingress=new Map(names.map(n=>[n,{enabled:false,previews_enabled:false}]));
  const apps=new Map([[g.app,closedApp(g)],[c.app,closedApp(c)]]),content=new Map(),calls=[],uploads=[],readyCalls=[];
  const now=Math.floor(Date.now()/1000),candidate={runId,priorManifestSha256:'b'.repeat(64),grant:{version:1,runId,tokenHash:'c'.repeat(64),
    schemaSha256:'d'.repeat(64),fencedSchemaSha256:'e'.repeat(64),issuedAt:now-1,expiresAt:now+899},
    bundles:Object.fromEntries(roles.map(role=>{const code='export default {fetch(){return new Response("'+role+'");}};';return [role,{code,sha256:sha(code)}];})),
    priorWorkers:Object.fromEntries(roles.map((role,i)=>[role,{settingsSha256:hash(settings.get(names[i])),versionId:versions.get(names[i])}]))};
  candidateChange?.(candidate,settings);
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-deployment-test-'));let failSync=false;
  const metadata={runId,candidateSha256:fingerprint(candidate),priorManifestSha256:candidate.priorManifestSha256};metadataChange?.(metadata);
  const journal=createByokD1OperatorJournal(workspace,metadata,{io:{...fs,fsyncSync(fd){if(failSync)throw Error('fsync injected');fs.fsyncSync(fd);}}});
  t.after(()=>journal.close());const path=resolve(journal.directory,'journal.jsonl');let hook=()=>undefined,ready=true;
  const fetchImpl=async(url,init)=>{
    const prefix='https://api.cloudflare.com/client/v4/accounts/'+g.account;assert.ok(url.startsWith(prefix));
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+apiToken);
    const route=url.slice(prefix.length),call={route,method:init.method,body:init.body,signal:init.signal};calls.push(call);
    assert.ok(Object.values(journal.snapshot().attempts).includes('INVOKED'));
    const result=await hook(call);if(result!==undefined)return result;
    if(route==='/d1/database/'+g.database){assert.equal(init.method,'GET');return response({uuid:g.database,name:'cinatoken-staging'});}
    for(const [appId,app] of apps)if(route==='/access/apps/'+appId){assert.equal(init.method,'GET');return response(app);}
    for(const [i,name] of names.entries()){
      const base='/workers/scripts/'+name;
      if(route===base+'?excludeScript=true&bindings_inherit=strict'){
        assert.equal(init.method,'PUT');assert.equal(inspectByokD1OperatorJournal(path).attempts['deploy-'+roles[i]],'PENDING');
        assert.ok(init.body instanceof FormData);assert.equal([...init.body.keys()].length,2);
        const metadata=JSON.parse(init.body.get('metadata')),file=init.body.get(metadata.main_module),code=await file.text();
        assert.equal(file.name,metadata.main_module);assert.equal(file.type,'application/javascript+module');
        assert.equal(code,candidate.bundles[roles[i]].code);assert.deepEqual(metadata.keep_bindings,[]);assert.equal(metadata.keep_assets,false);
        assert.ok(!('assets' in metadata)&&!('migrations' in metadata)&&!('containers' in metadata));
        uploads.push({name,metadata,code});settings.set(name,{bindings:metadata.bindings,compatibility_date:metadata.compatibility_date,limits:metadata.limits,
          compatibility_flags:metadata.compatibility_flags,tail_consumers:metadata.tail_consumers,logpush:metadata.logpush,observability:metadata.observability});
        versions.set(name,id(100+i));content.set(name,{code,module:metadata.main_module});return response({deployment_id:id(100+i).replaceAll('-','')});
      }
      if(route===base+'/settings')return response(settings.get(name));
      if(route===base+'/deployments')return response({deployments:[{versions:[{version_id:versions.get(name),percentage:100}]}]});
      if(route===base+'/subdomain')return response(ingress.get(name));
      if(route==='/workers/domains?service='+name)return Response.json({success:true,errors:null,messages:null,result:[],
        result_info:{page:1,per_page:0,count:0,total_count:0}});
      if(route===base+'/schedules')return response({schedules:[]});
      if(route===base&&init.method==='GET'){
        // FormData string fields normalize LF to CRLF. A code download must
        // preserve the uploaded bytes, including mixed line endings/Unicode.
        const {code,module}=content.get(name),form=new FormData();form.set(module,new Blob([code],{type:'application/javascript+module'}),module);
        const r=new Response(form);r.headers.set('cf-entrypoint',module);return r;
      }
    }
    assert.fail('Out-of-scope HTTP');
  };
  const opts={journal,candidate,apiToken,assertReady(role){readyCalls.push(role);return ready;},fetchImpl,...options};
  return {journal,path,candidate,settings,versions,ingress,apps,content,calls,uploads,readyCalls,options:opts,
    setHook(fn){hook=fn;},setReady(v){ready=v;},setFsync(v){failSync=v;}};
}
const ack=async(f,...steps)=>{for(const step of steps)await f.journal.attempt(step,async()=>true);};
async function ready(t,opts){const f=setup(t,opts);await ack(f,'preflight','closure-before');return {...f,deploy:create(f.options)};}

test('download fixture preserves LF, CRLF, isolated CR and Unicode code bytes',async t=>{
  const code='// 中文\n// second\r\n// third\rexport default {};\n';
  const f=await ready(t,{candidateChange:c=>{c.bundles.receiver={code,sha256:sha(code)};}});
  assert.equal((await f.deploy.deployNext()).codeSha256,sha(code));
});

test('three fixed existing Workers deploy in order, closed, with one upload and independent full-code/settings reads each',async t=>{
  const f=await ready(t);
  for(const [i,role] of roles.entries()){
    const r=await f.deploy.deployNext();assert.equal(r.role,role);assert.equal(r.worker,names[i]);assert.equal(r.versionId,id(100+i));
    assert.equal(r.codeSha256,f.candidate.bundles[role].sha256);assert.equal(r.settingsSha256,hash(f.settings.get(names[i])));
    assert.equal(r.workersDevClosed,true);assert.equal(r.knownDomainsAndCronsEmpty,true);r.settingsSha256='mutated';
  }
  assert.deepEqual(f.uploads.map(v=>v.name),names);assert.equal(f.deploy.snapshot().cursor,3);assert.equal(f.deploy.snapshot().uploadAttempts,3);
  assert.equal(f.deploy.snapshot().cloudQuiescenceProved,false);assert.ok(f.readyCalls.length>=6);
  for(const state of f.ingress.values())assert.deepEqual(state,{enabled:false,previews_enabled:false});
  const receiver=f.uploads[0].metadata,controller=f.uploads[1].metadata,gateway=f.uploads[2].metadata;
  for(const m of [receiver,controller,gateway])assert.deepEqual(m.limits,{cpu_ms:30000});
  assert.deepEqual(receiver.bindings.find(b=>b.type==='d1'),{name:'RECOVERY_DB',type:'d1',id:g.database});
  assert.deepEqual(controller.bindings.find(b=>b.type==='service'),{name:'USAGE_RECOVERY',type:'service',service:names[0],entrypoint:'UsageRecovery'});
  assert.equal(controller.bindings.some(b=>b.type==='d1'),false);
  assert.equal(JSON.parse(gateway.bindings.find(b=>b.name==='BYOK_GATEWAY_INSTALL_GRANT').text).tokenHash,'c'.repeat(64));
  const count=f.calls.length;await assert.rejects(f.deploy.deployNext());assert.equal(f.calls.length,count);
  const log=fs.readFileSync(f.path,'utf8')+JSON.stringify(f.deploy.snapshot());assert.ok(!log.includes(apiToken));assert.ok(!log.includes('export default'));
  assert.equal(f.deploy.api,undefined);assert.equal(f.deploy.rollback,undefined);
});
test('all closed Wrangler candidates agree with the fixed uploaded CPU setting',()=>{
  for(const role of ['gateway','maintenance','maintenance-control']){
    const config=JSON.parse(fs.readFileSync('packages/proxy/scripts/staging/wrangler.byok-d1-'+role+'.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''));
    assert.deepEqual(config.limits,{cpu_ms:30000});assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
    assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers,{crons:[]});
  }
});
for(const role of roles)for(const [mode,limits] of [
  ['absent',undefined],['null',null],['higher',{cpu_ms:300000}],['lower',{cpu_ms:10000}],
  ['string',{cpu_ms:'30000'}],['missing-cpu',{subrequests:10000}],['array',[30000]],
])test('uploaded '+role+' CPU setting must read back exactly / '+mode,async t=>{
  const f=await ready(t),index=roles.indexOf(role),target=names[index];
  for(let i=0;i<index;i++)await f.deploy.deployNext();
  f.setHook(call=>{
    if(f.uploads.length===index+1&&call.route==='/workers/scripts/'+target+'/settings'){
      const value=structuredClone(f.settings.get(target));
      if(limits===undefined)delete value.limits;else value.limits=limits;
      return response(value);
    }
  });
  await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,index+1);assert.equal(f.deploy.snapshot().cursor,index);
  const count=f.calls.length;await assert.rejects(f.deploy.deployNext());assert.equal(f.calls.length,count);
  assert.ok(f.calls.every(c=>c.method==='GET'||c.method==='PUT')); // no rollback or reopening
});
test('extra server-default limits do not hide or invalidate an exact CPU setting',async t=>{
  const f=await ready(t);f.setHook(call=>{
    if(f.uploads.length&&call.route.endsWith('/settings'))return response({...f.settings.get(names[0]),limits:{cpu_ms:30000,subrequests:10000}});
  });await f.deploy.deployNext();assert.equal(f.uploads.length,1);
});
test('CPU drift at the final readback stops progression',async t=>{
  const f=await ready(t);let reads=0;f.setHook(call=>{
    if(f.uploads.length&&call.route.endsWith('/settings')&&++reads===2)return response({...f.settings.get(names[0]),limits:{cpu_ms:300000}});
  });await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,1);assert.equal(f.deploy.snapshot().cursor,0);
});
test('CPU drift in the deployed dependency prevents the next upload',async t=>{
  const f=await ready(t);await f.deploy.deployNext();f.settings.get(names[0]).limits.cpu_ms=300000;
  await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,1);
});
if(process.env.BYOK_D1_LEGACY_DEPLOYMENT_MODULE)test('legacy no-CPU candidate fingerprint cannot authorize the new upload contract',async t=>{
  const old=await import(pathToFileURL(resolve(process.env.BYOK_D1_LEGACY_DEPLOYMENT_MODULE)).href),f=setup(t);
  assert.notEqual(old.byokD1DeploymentFingerprint(f.candidate),fingerprint(f.candidate));
  const legacyJournal=Object.freeze({...f.journal,identity:{...f.journal.identity,candidateSha256:old.byokD1DeploymentFingerprint(f.candidate)}});
  assert.throws(()=>create({...f.options,journal:legacyJournal}));assert.equal(f.calls.length,0);
});
test('fingerprint pins every bundle, grant, predecessor and prior evidence',t=>{
  const f=setup(t),base=fingerprint(f.candidate);
  for(const mutate of [c=>c.runId='c02-byok-112233445566',c=>c.grant.extra=true,c=>c.bundles.receiver.code+='changed',c=>c.priorWorkers.gateway.versionId='bad',
    c=>c.extra='arbitrary',c=>c.bundles.extra=c.bundles.receiver,c=>c.bundles.receiver.url='https://untrusted.invalid']){
    const v=structuredClone(f.candidate);mutate(v);assert.throws(()=>fingerprint(v),/^Error: byok_deployment_candidate_invalid$/);
  }
  for(const mutate of [c=>c.priorManifestSha256='a'.repeat(64),c=>c.grant.tokenHash='a'.repeat(64),c=>c.priorWorkers.gateway.settingsSha256='a'.repeat(64)]){
    const v=structuredClone(f.candidate);mutate(v);assert.notEqual(fingerprint(v),base);assert.throws(()=>create({...f.options,candidate:v}));
  }
  assert.equal(f.calls.length,0);
});
test('invalid options and non-frozen journal identity fail before HTTP',t=>{
  const f=setup(t);for(const change of [{apiToken:apiToken+'\n'},{timeoutMs:60001},{account:'other'},{assertReady:null},{fetchImpl:null}])
    assert.throws(()=>create({...f.options,...change}),/^Error: byok_deployment_options_invalid$/);
  const other=setup(t,{metadataChange:m=>{m.candidateSha256='f'.repeat(64);}});assert.throws(()=>create(other.options));
  assert.equal(f.calls.length,0);
});
test('constructor snapshots candidate bytes and metadata before caller mutation',async t=>{
  const f=await ready(t),expected=f.candidate.bundles.receiver.code;
  // Capture the sent bytes directly; fixture intentionally compares its mutable input otherwise.
  f.setHook(async call=>{if(call.method==='PUT'){
    const m=JSON.parse(call.body.get('metadata'));assert.equal(await call.body.get(m.main_module).text(),expected);throw Error('synthetic terminal');}});
  f.candidate.bundles.receiver.code='changed';f.candidate.grant.tokenHash='f'.repeat(64);
  await assert.rejects(f.deploy.deployNext());assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
for(const mode of ['preflight','closure','opened','stopped','expired','guard','async-guard','aborted'])
test('unsafe deployment phase is refused before HTTP / '+mode,async t=>{
  const f=setup(t,{candidateChange:mode==='expired'?c=>{c.grant.issuedAt-=1000;c.grant.expiresAt-=1000;}:undefined});
  if(mode!=='preflight')await ack(f,'preflight');if(!['preflight','closure'].includes(mode))await ack(f,'closure-before');
  if(mode==='opened')await ack(f,'open-access');if(mode==='stopped')await ack(f,'stop');
  if(mode==='guard')f.setReady(false);if(mode==='async-guard')f.setReady(Promise.resolve(true));
  const d=create(f.options);await assert.rejects(d.deployNext(mode==='aborted'?{signal:AbortSignal.abort()}:undefined));
  assert.equal(f.calls.length,0);await assert.rejects(d.deployNext());
});
for(const mode of ['identity','settings','version','split','public','preview','domain','cron','access','missing-worker','assets','durable-object'])
test('existing-resource and isolation checks refuse upload / '+mode,async t=>{
  const f=await ready(t,{candidateChange:['assets','durable-object'].includes(mode)?(c,s)=>{
    if(mode==='assets')s.get(names[0]).assets={id:'existing'};else s.get(names[0]).bindings.push({name:'DO',type:'durable_object_namespace',namespace_id:'existing'});
    c.priorWorkers.receiver.settingsSha256=hash(s.get(names[0]));}:undefined});
  if(mode==='settings')f.settings.get(names[0]).extra=true;if(mode==='version')f.versions.set(names[0],id(88));
  if(mode==='public')f.ingress.get(names[0]).enabled=true;if(mode==='preview')f.ingress.get(names[0]).previews_enabled=true;
  if(mode==='access')f.apps.get(c.app).policies[0].decision='allow';
  f.setHook(call=>{
    if(mode==='identity'&&call.route.startsWith('/d1/'))return response({uuid:'production',name:'cinatoken-staging'});
    if(mode==='split'&&call.route.endsWith('/deployments'))return response({deployments:[{versions:[{version_id:id(1),percentage:50},{version_id:id(2),percentage:50}]}]});
    if(mode==='domain'&&call.route.startsWith('/workers/domains'))return response([{hostname:'unexpected.invalid'}]);
    if(mode==='cron'&&call.route.endsWith('/schedules'))return response({schedules:[{cron:'* * * * *'}]});
    if(mode==='missing-worker'&&call.route.endsWith('/settings'))return new Response('{}',{status:404,headers:{'Content-Type':'application/json'}});
  });
  await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,0);
});
test('readiness is rechecked immediately before PUT after read-only checks',async t=>{
  const f=await ready(t);f.setHook(call=>{if(call.route.startsWith('/access/apps/'))f.setReady(false);});
  await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,0);
});
test('unknown upload ACK prevents later roles and cross-instance recreation; containment journal still available',async t=>{
  const f=await ready(t);f.setHook(call=>{if(call.method==='PUT')throw Error(apiToken);});
  await assert.rejects(f.deploy.deployNext(),/^Error: byok_deployment_unconfirmed$/);const count=f.calls.length;
  await assert.rejects(f.deploy.deployNext());await assert.rejects(create(f.options).deployNext());assert.equal(f.calls.length,count);
  await ack(f,'close-controller');assert.equal(f.journal.snapshot().attempts['close-controller'],'ACK');
  assert.ok(!fs.readFileSync(f.path,'utf8').includes(apiToken));
});
for(const mode of ['no-new-version','bad-binding','extra-binding','date','tail','post-open','code','extra-module','second-version-drift'])
test('post-upload independent verification rejects mismatches without rollback / '+mode,async t=>{
  const f=await ready(t);let postVersionReads=0;
  f.setHook(call=>{
    if(!f.uploads.length)return;
    if(mode==='no-new-version'&&call.route.endsWith('/deployments'))return response({deployments:[{versions:[{version_id:id(1),percentage:100}]}]});
    if(call.route.endsWith('/settings')){
      const s=structuredClone(f.settings.get(names[0]));
      if(mode==='bad-binding')s.bindings.find(b=>b.type==='d1').id='production';if(mode==='extra-binding')s.bindings.push({type:'secret_text',name:'PRIVATE'});
      if(mode==='date')s.compatibility_date='2020-01-01';if(mode==='tail')s.tail_consumers=[{service:'foreign'}];
      if(['bad-binding','extra-binding','date','tail'].includes(mode))return response(s);
    }
    if(mode==='post-open'&&call.route.endsWith('/subdomain'))return response({enabled:true,previews_enabled:false});
    if(mode==='code'&&call.route==='/workers/scripts/'+names[0])return new Response('wrong',{headers:{'Content-Type':'application/javascript'}});
    if(mode==='extra-module'&&call.route==='/workers/scripts/'+names[0]){
      const form=new FormData(),v=f.content.get(names[0]);form.set(v.module,new Blob([v.code]),v.module);form.set('other.js',new Blob(['extra']),'other.js');return new Response(form);
    }
    if(mode==='second-version-drift'&&call.route.endsWith('/deployments')&&++postVersionReads===2)
      return response({deployments:[{versions:[{version_id:id(999),percentage:100}]}]});
  });
  await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,1);assert.equal(f.deploy.snapshot().cursor,0);
  assert.equal(f.calls.filter(c=>c.method!=='GET').length,1);
});
test('already verified receiver cannot drift before controller deployment',async t=>{
  const f=await ready(t);await f.deploy.deployNext();f.versions.set(names[0],id(99));await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,1);
});
test('single-module raw content and database_id output spelling are supported without weakening exact bindings',async t=>{
  const f=await ready(t);f.setHook(call=>{
    if(!f.uploads.length)return;
    if(call.route==='/workers/scripts/'+names[0])return new Response(f.content.get(names[0]).code,{headers:{'Content-Type':'application/javascript+module'}});
    if(call.route.endsWith('/settings')){const s=structuredClone(f.settings.get(names[0])),b=s.bindings.find(b=>b.type==='d1');b.database_id=b.id;delete b.id;return response(s);}
  });await f.deploy.deployNext();assert.equal(f.uploads.length,1);
});
test('null errors never bypass a nonempty domain result before upload',async t=>{
  const f=await ready(t);f.setHook(call=>{
    if(call.route.startsWith('/workers/domains'))return Response.json({success:true,errors:null,result:[{hostname:'unexpected.invalid'}]});
  });await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,0);
});
for(const mode of ['http','redirect','redirected','mime','length','length-mismatch','large','invalid-json','utf8','api-false','api-error','errors-false','errors-string','errors-object','errors-null-item'])
test('bounded JSON transport rejects malformed response / '+mode,async t=>{
  const f=await ready(t);f.setHook(()=>{
    if(mode==='http')return new Response(null,{status:503});if(mode==='redirect')return new Response(null,{status:302});
    const malformed={'errors-false':false,'errors-string':'','errors-object':{},'errors-null-item':[null]};
    if(Object.hasOwn(malformed,mode))return Response.json({success:true,errors:malformed[mode],result:{uuid:g.database,name:'cinatoken-staging'}});
    const r=mode==='large'?new Response(' '.repeat(2097153),{headers:{'Content-Type':'application/json'}})
      :mode==='invalid-json'?new Response('{',{headers:{'Content-Type':'application/json'}})
      :mode==='utf8'?new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}})
      :Response.json({success:mode!=='api-false',errors:mode==='api-error'?[{message:apiToken}]:[],result:{uuid:g.database,name:'cinatoken-staging'}});
    if(mode==='redirected')Object.defineProperty(r,'redirected',{value:true});if(mode==='mime')r.headers.set('Content-Type','text/html');
    if(mode==='length')r.headers.set('Content-Length','2097153');if(mode==='length-mismatch')r.headers.set('Content-Length','1');return r;
  });await assert.rejects(f.deploy.deployNext());assert.equal(f.calls.length,1);assert.equal(f.uploads.length,0);
});
test('chunk floods are bounded and cancelled',async t=>{
  const f=await ready(t);let pulls=0,cancelled=0;
  f.setHook(()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},{highWaterMark:0}),
    {headers:{'Content-Type':'application/json'}}));await assert.rejects(f.deploy.deployNext());await tick();assert.equal(pulls,4096);assert.equal(cancelled,1);
});
test('late headers after deadline are cancelled and cannot lead to upload',async t=>{
  const late=deferred(),f=await ready(t,{options:{timeoutMs:20}});let cancelled=0;
  f.setHook(()=>late.promise);await assert.rejects(f.deploy.deployNext());
  late.resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}));
  await tick();assert.equal(cancelled,1);assert.equal(f.uploads.length,0);
});
test('PENDING fsync failure prevents any cloud request',async t=>{
  const f=await ready(t);f.setFsync(true);await assert.rejects(f.deploy.deployNext());assert.equal(f.calls.length,0);f.setFsync(false);
});
test('ACK fsync failure retains unknown deployment and never uploads next role',async t=>{
  const f=await ready(t);f.setHook(call=>{if(f.uploads.length&&call.route.endsWith('/settings'))f.setFsync(true);});
  await assert.rejects(f.deploy.deployNext());assert.equal(f.uploads.length,1);await assert.rejects(f.deploy.deployNext());f.setFsync(false);
});
test('parallel calls cannot overlap uploads or consume the next role',async t=>{
  const entered=deferred(),wait=deferred(),f=await ready(t);f.setHook(async()=>{entered.resolve();await wait.promise;});
  const first=f.deploy.deployNext();await entered.promise;await assert.rejects(f.deploy.deployNext());wait.resolve();await first;
  assert.equal(f.uploads.length,1);assert.equal(f.journal.snapshot().attempts['deploy-controller'],undefined);
});

// Explicit offline-artifact verification mode, run after three real Wrangler
// dry-runs by the evidence verifier. It never executes these Worker bundles.
if(process.env.BYOK_D1_DEPLOYMENT_ARTIFACT_ROOT)test('real three-Worker dry-run bytes flow unchanged through the fixed multipart upload contract',async t=>{
  const artifacts=resolve(process.env.BYOK_D1_DEPLOYMENT_ARTIFACT_ROOT);
  const f=await ready(t,{candidateChange:c=>{
    for(const [role,folder,file] of [['receiver','maintenance','byok-d1-maintenance-worker.js'],
      ['controller','maintenance-control','byok-d1-maintenance-control-worker.js'],['gateway','gateway','byok-d1-gateway-worker.js']]){
      const bytes=fs.readFileSync(resolve(artifacts,folder,file)),code=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      assert.equal(Buffer.byteLength(code),bytes.length);assert.ok(bytes.length>1000&&bytes.length<=1048576);c.bundles[role]={code,sha256:sha(bytes)};
    }
  }});
  for(const role of roles){const r=await f.deploy.deployNext();assert.equal(r.codeSha256,f.candidate.bundles[role].sha256);}
  assert.equal(f.uploads.length,3);
  for(const upload of f.uploads){assert.equal(upload.metadata.compatibility_date,'2026-09-16');assert.deepEqual(upload.metadata.compatibility_flags,['nodejs_compat']);}
});
