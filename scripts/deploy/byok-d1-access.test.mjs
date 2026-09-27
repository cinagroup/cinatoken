import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setImmediate as tick} from 'node:timers/promises';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
const {createByokD1Access:create}=await import(process.env.BYOK_D1_ACCESS_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_ACCESS_MODULE)).href:new URL('./byok-d1-access.mjs',import.meta.url).href);
const runId='c02-byok-a1b2c3d4e5f6',apiToken='synthetic-api-secret',clientId='synthetic.access',clientSecret='synthetic-client-secret';
const tokenId='01234567-1234-1234-1234-123456789abc',tokenName=runId+'-access';
const prefix='https://api.cloudflare.com/client/v4/accounts/'+g.account;
const p=t=>({id:t.policy,name:t===g?'CinaToken staging closed':'CinaToken recovery staging closed',
  precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]});
const app=t=>({id:t.app,aud:t.audience,domain:t.domain,type:'self_hosted',destinations:[{type:'public',uri:t.domain}],
  service_auth_401_redirect:false,policies:[p(t)],unchangedFlag:'preserve-this'});
const json=(result,rest={})=>Response.json({success:true,errors:[],result,...rest});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,options={}) {
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-access-test-'));
  let failSync=false;
  const journal=createByokD1OperatorJournal(workspace,{runId,candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)},
    {io:{...fs,fsyncSync(fd){if(failSync)throw Error('injected fsync failure');fs.fsyncSync(fd);}}});
  t.after(()=>journal.close());const path=resolve(journal.directory,'journal.jsonl');
  const apps=new Map([[g.app,app(g)],[c.app,app(c)]]),ingress=new Map([[g.worker,{enabled:false,previews_enabled:false}],[c.worker,{enabled:false,previews_enabled:false}]]);
  const rows=[],calls=[],readyCalls=[];let hook=()=>undefined,ready=true;
  const read=()=>inspectByokD1OperatorJournal(path);
  const fetchImpl=async(url,init)=>{
    assert.ok(url.startsWith(prefix));assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
    assert.equal(init.headers.Authorization,'Bearer '+apiToken);
    const route=url.slice(prefix.length),method=init.method,body=init.body===undefined?undefined:JSON.parse(init.body);
    const call={route,method,body,signal:init.signal};calls.push(call);
    assert.ok(Object.values(journal.snapshot().attempts).includes('INVOKED'),'HTTP needs a live journal step');
    const overridden=await hook(call);if(overridden!==undefined)return overridden;
    if(route.startsWith('/access/service_tokens?')) {
      assert.equal(method,'GET');const page=Number(new URL(url).searchParams.get('page')),list=rows.slice((page-1)*1000,page*1000);
      return json(list,{result_info:{page,per_page:1000,count:list.length,total_count:rows.length,total_pages:Math.max(1,Math.ceil(rows.length/1000))}});
    }
    if(route==='/access/service_tokens'&&method==='POST'){
      assert.deepEqual(body,{name:tokenName,duration:'1h'});const row={id:tokenId,name:tokenName};rows.push(row);
      return json({...row,client_id:clientId,client_secret:clientSecret});
    }
    if(route==='/access/service_tokens/'+tokenId&&method==='DELETE'){
      const i=rows.findIndex(r=>r.id===tokenId);assert.ok(i>=0);rows.splice(i,1);return json({id:tokenId});
    }
    for(const target of [g,c]) {
      if(route==='/access/apps/'+target.app){assert.equal(method,'GET');return json(apps.get(target.app));}
      if(route==='/access/apps/'+target.app+'/policies/'+target.policy){
        assert.equal(method,'PUT');assert.deepEqual(Object.keys(body).sort(),['decision','exclude','include','name','precedence','require']);
        apps.get(target.app).policies=[{id:target.policy,...body}];return json(apps.get(target.app).policies[0]);
      }
      if(route==='/workers/scripts/'+target.worker+'/subdomain'){
        if(method==='POST'){assert.equal(body.previews_enabled,false);assert.equal(typeof body.enabled,'boolean');ingress.set(target.worker,body);}
        else assert.equal(method,'GET');return json(ingress.get(target.worker));
      }
    }
    assert.fail('Unscoped request');
  };
  const opts={journal,apiToken,assertReady(step){readyCalls.push(step);return ready;},fetchImpl,...options};
  return {journal,path,read,apps,ingress,rows,calls,readyCalls,options:opts,adapter:create(opts),
    setHook(fn){hook=fn;},setReady(v){ready=v;},setFsync(v){failSync=v;}};
}
const acknowledge=async(f,...steps)=>{for(const step of steps)await f.journal.attempt(step,async()=>true);};
async function activated(t,options){const f=setup(t,options);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();
  await f.adapter.openGatewayAccess();await f.adapter.openGateway();return f;}
async function maintenanceReady(f) {
  await acknowledge(f,...Array.from({length:10},(_,i)=>'verify-case-'+i),'stop','seal-fence');
  await f.adapter.closeGateway();await f.adapter.closeGatewayAccess();
}
for(const phase of ['closure-fresh','arm-maintenance'])test('controller cannot first activate after the freshness/permit window has begun / '+phase,async t=>{
  const f=await activated(t);await maintenanceReady(f);await acknowledge(f,phase);const before=f.calls.length;
  await assert.rejects(f.adapter.openControllerAccess());assert.equal(f.calls.length,before);assert.equal(f.ingress.get(c.worker).enabled,false);
});
const writes=f=>f.calls.filter(c=>c.method!=='GET');

test('complete fixed-resource activation / maintenance / containment sequence is journaled and secret-free',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');const cred=await f.adapter.createToken();
  assert.deepEqual(cred,{tokenId,accessClientId:clientId,accessClientSecret:clientSecret});
  assert.equal(f.read().attempts['create-token'],'ACK');await f.adapter.openGatewayAccess();await f.adapter.openGateway();
  assert.equal(f.ingress.get(g.worker).enabled,true);assert.equal(f.ingress.get(c.worker).enabled,false);
  await maintenanceReady(f);await f.adapter.openControllerAccess();await f.adapter.openController();
  assert.equal(f.ingress.get(g.worker).enabled,false);assert.equal(f.ingress.get(c.worker).enabled,true);
  await acknowledge(f,'closure-fresh','arm-maintenance','cleanup');const result=await f.adapter.contain();
  assert.deepEqual(result.failedSteps,[]);assert.equal(result.journalPoisoned,false);assert.equal(result.cloudQuiescenceProved,false);
  assert.equal(result.knownIngressClosureReverified,false);assert.deepEqual(f.rows,[]);
  for(const target of [g,c]){assert.deepEqual(f.apps.get(target.app).policies,[p(target)]);assert.equal(f.apps.get(target.app).unchangedFlag,'preserve-this');
    assert.deepEqual(f.ingress.get(target.worker),{enabled:false,previews_enabled:false});}
  assert.equal(writes(f).length,10);assert.equal(f.adapter.snapshot().apiAttempts,f.calls.length);
  assert.ok(f.readyCalls.length>=10);assert.ok(f.read().records<96);
  const log=fs.readFileSync(f.path,'utf8')+JSON.stringify(f.adapter.snapshot())+JSON.stringify(result);
  for(const secret of [apiToken,clientSecret,clientId])assert.ok(!log.includes(secret));
  assert.equal(f.adapter.api,undefined);assert.equal(f.adapter.batch,undefined);assert.equal(f.adapter.deploy,undefined);
  const count=f.calls.length;await f.adapter.contain();assert.equal(f.calls.length,count);await assert.rejects(f.adapter.openGateway());
});
test('options reject arbitrary targets, malformed credentials and async proof before I/O',async t=>{
  const f=setup(t);
  for(const change of [{apiToken:apiToken+'\n'},{apiToken:''},{account:'other'},{fetchImpl:null},{timeoutMs:60001},{timeoutMs:0},{assertReady:null}])
    assert.throws(()=>create({...f.options,...change}),/^Error: Invalid BYOK Access options$/);
  assert.equal(f.calls.length,0);await acknowledge(f,'preflight','closure-before');f.setReady(Promise.resolve(true));
  await assert.rejects(f.adapter.createToken());assert.equal(f.calls.length,0);
});
test('activation missing preflight consumes its single attempt without network; containment remains available',async t=>{
  const f=setup(t);await assert.rejects(f.adapter.createToken());assert.equal(f.calls.length,0);
  await assert.rejects(f.adapter.createToken());const result=await f.adapter.contain();
  assert.ok(result.failedSteps.includes('revoke-token'));assert.equal(writes(f).length,0);assert.equal(result.journalPoisoned,true);
});
test('readiness is rechecked after observations immediately before token POST',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');f.setHook(call=>{if(call.method==='GET')f.setReady(false);});
  await assert.rejects(f.adapter.createToken());assert.equal(writes(f).length,0);
});
test('empty token inventory accepts zero total_pages without guessing nonempty pagination',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');
  f.setHook(call=>{if(call.route.startsWith('/access/service_tokens?')&&f.rows.length===0)
    return json([],{result_info:{page:1,per_page:1000,count:0,total_count:0,total_pages:0}});});
  await f.adapter.createToken();await f.adapter.revokeToken();assert.deepEqual(f.rows,[]);
});
test('maximum observed inventory leaves capacity for the new token and refuses create when full',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');
  for(let i=0;i<20000;i++)f.rows.push({id:'aaaaaaaa-aaaa-aaaa-aaaa-'+i.toString(16).padStart(12,'0'),name:'unrelated-'+i});
  await assert.rejects(f.adapter.createToken());assert.equal(f.calls.length,20);assert.equal(writes(f).length,0);
});
test('all service-token pages are consumed; preexisting name collision is never adopted or deleted',async t=>{
  const f=setup(t);for(let i=0;i<1000;i++)f.rows.push({id:'aaaaaaaa-aaaa-aaaa-aaaa-'+i.toString(16).padStart(12,'0'),name:'unrelated-'+i});
  f.rows.push({id:tokenId,name:tokenName});await acknowledge(f,'preflight','closure-before');await assert.rejects(f.adapter.createToken());
  assert.equal(f.calls.length,2);assert.equal(writes(f).length,0);const result=await f.adapter.contain();
  assert.ok(result.failedSteps.includes('revoke-token'));assert.equal(f.rows.length,1001);assert.equal(writes(f).length,0);
});
for(const mode of ['page','per-page','count','total','pages','duplicate','changing-total'])
test('incomplete or inconsistent pagination rejects before token creation / '+mode,async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');
  f.setHook(call=>{if(!call.route.startsWith('/access/service_tokens?'))return;
    let rows=[{id:tokenId,name:'unrelated'}],info={page:1,per_page:1000,count:1,total_count:1,total_pages:1};
    if(mode==='page')info.page=2;if(mode==='per-page')info.per_page=100;if(mode==='count')info.count=0;
    if(mode==='total')info.total_count=20001;if(mode==='pages')info.total_pages=2;
    if(mode==='duplicate'){rows.push({...rows[0]});info.count=2;info.total_count=2;}
    if(mode==='changing-total'){
      const page=call.route.endsWith('page=1')?1:2;rows=page===1?Array.from({length:1000},(_,i)=>({id:'bbbbbbbb-bbbb-bbbb-bbbb-'+i.toString(16).padStart(12,'0'),name:'other'})):[];
      info={page,per_page:1000,count:rows.length,total_count:page===1?1001:1000,total_pages:page===1?2:1};
    }
    return json(rows,{result_info:info});
  });
  await assert.rejects(f.adapter.createToken());assert.equal(writes(f).length,0);
});
test('lost token creation ACK is never retried; unique run-owned token can be revoked after isolation',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');f.setHook(call=>{
    if(call.method==='POST'&&call.route==='/access/service_tokens'){f.rows.push({id:tokenId,name:tokenName});throw Error(clientSecret);}
  });
  await assert.rejects(f.adapter.createToken(),/^Error: byok_access_operation_unconfirmed$/);
  await assert.rejects(f.adapter.createToken());const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,[]);
  assert.equal(result.journalPoisoned,true);assert.deepEqual(f.rows,[]);assert.equal(writes(f).length,2);
  assert.ok(!fs.readFileSync(f.path,'utf8').includes(clientSecret));
});
test('unknown creation plus current absence is NOT a confirmed revocation (late creation risk)',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');f.setHook(call=>{
    if(call.method==='POST'&&call.route==='/access/service_tokens')throw Error('unknown');});
  await assert.rejects(f.adapter.createToken());const result=await f.adapter.contain();
  assert.deepEqual(result.failedSteps,['revoke-token']);assert.equal(writes(f).length,1);
});
test('duplicate run token names prevent guessing a deletion target',async t=>{
  const f=await activated(t);f.rows.push({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:tokenName});
  const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,['revoke-token']);assert.equal(f.rows.length,2);
  assert.equal(writes(f).filter(c=>c.method==='DELETE').length,0);
});
test('token ID mismatch prevents deleting a replacement token',async t=>{
  const f=await activated(t);f.rows[0].id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,['revoke-token']);assert.equal(f.rows.length,1);
});
test('new adapter cannot replay activation or claim missing in-memory token ownership',async t=>{
  const f=await activated(t),other=create(f.options);const count=f.calls.length;
  await assert.rejects(other.createToken());assert.equal(f.calls.length,count);
  await assert.rejects(other.revokeToken());assert.equal(f.calls.length,count);assert.equal(f.rows.length,1);
});
test('token ownership survives creation ACK fsync failure; secret is not returned or journaled',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');
  f.setHook(call=>{if(call.route.startsWith('/access/service_tokens?')&&f.rows.length>0)f.setFsync(true);});
  await assert.rejects(f.adapter.createToken());assert.equal(f.adapter.snapshot().ownedTokenId,tokenId);assert.equal(f.rows.length,1);
  f.setFsync(false);f.setHook(()=>undefined);const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,[]);
  assert.deepEqual(f.rows,[]);assert.equal(result.journalPoisoned,true);assert.ok(!fs.readFileSync(f.path,'utf8').includes(clientSecret));
});
test('worker enabling requires both app readbacks to match the run token',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();await f.adapter.openGatewayAccess();
  f.apps.get(g.app).policies[0].include=[{everyone:{}}];const before=writes(f).length;
  await assert.rejects(f.adapter.openGateway());assert.equal(writes(f).length,before);assert.equal(f.ingress.get(g.worker).enabled,false);
});
for(const mode of ['id','aud','domain','destination','policy-id','policy-count','redirect','decision','include'])
test('activation rejects drift in fixed Access identity/policy / '+mode,async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();const a=f.apps.get(g.app);
  if(mode==='id')a.id=c.app;if(mode==='aud')a.aud=c.audience;if(mode==='domain')a.domain='foreign.invalid';
  if(mode==='destination')a.destinations=[];if(mode==='policy-id')a.policies[0].id=c.policy;if(mode==='policy-count')a.policies.push(p(g));
  if(mode==='redirect')a.service_auth_401_redirect=true;if(mode==='decision')a.policies[0].decision='bypass';if(mode==='include')a.policies[0].include=[];
  const before=writes(f).length;await assert.rejects(f.adapter.openGatewayAccess());assert.equal(writes(f).length,before);
});
test('opening public ingress before Access ACK is refused',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();const count=f.calls.length;
  await assert.rejects(f.adapter.openGateway());assert.equal(f.calls.length,count);
});
test('controller cannot open before completed cases, STOP, seal, fresh closure and maintenance permit',async t=>{
  const f=await activated(t);const before=f.calls.length;await assert.rejects(f.adapter.openControllerAccess());assert.equal(f.calls.length,before);
});
test('controller activation rejects a reopened gateway even with recorded prerequisites',async t=>{
  const f=await activated(t);await maintenanceReady(f);f.ingress.set(g.worker,{enabled:true,previews_enabled:false});
  const before=writes(f).length;await assert.rejects(f.adapter.openControllerAccess());assert.equal(writes(f).length,before);
});
test('controller readiness checked again before public POST; expired permit cannot open ingress',async t=>{
  const f=await activated(t);await maintenanceReady(f);await f.adapter.openControllerAccess();
  f.setHook(call=>{if(call.route.endsWith(c.worker+'/subdomain'))f.setReady(false);});const before=writes(f).length;
  await assert.rejects(f.adapter.openController());assert.equal(writes(f).length,before);
});
test('unknown policy activation commit is closed by containment without replaying setup',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();
  f.setHook(call=>{if(call.method==='PUT'&&call.body.decision==='non_identity'){
    f.apps.get(g.app).policies=[{id:g.policy,...call.body}];throw Error('lost ACK');}});
  await assert.rejects(f.adapter.openGatewayAccess());const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,[]);
  assert.deepEqual(f.apps.get(g.app).policies,[p(g)]);assert.equal(result.journalPoisoned,true);
});
test('one failed closure does not prevent independent controller/Access/token containment',async t=>{
  const f=await activated(t);f.ingress.set(c.worker,{enabled:true,previews_enabled:true});
  f.setHook(call=>{if(call.method==='POST'&&call.route.endsWith(g.worker+'/subdomain')&&!call.body.enabled)throw Error('unknown close');});
  const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,['close-gateway']);assert.equal(f.ingress.get(c.worker).enabled,false);
  assert.deepEqual(f.apps.get(g.app).policies,[p(g)]);assert.deepEqual(f.rows,[]);
  const count=f.calls.length;await f.adapter.contain();assert.equal(f.calls.length,count);
});
test('independent readback detects ignored Worker toggle ACK and still permits containment',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();await f.adapter.openGatewayAccess();
  f.setHook(call=>{if(call.method==='POST'&&call.route.endsWith('/subdomain'))return json(call.body);});
  await assert.rejects(f.adapter.openGateway());const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,[]);
});
test('independent readback detects ignored policy ACK',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await f.adapter.createToken();
  f.setHook(call=>{if(call.method==='PUT')return json({id:g.policy,...call.body});});
  await assert.rejects(f.adapter.openGatewayAccess());assert.equal(f.ingress.get(g.worker).enabled,false);
});
test('DELETE ACK without independently observed absence is not successful revocation',async t=>{
  const f=await activated(t);f.setHook(call=>{if(call.method==='DELETE')return json({id:tokenId});});
  const result=await f.adapter.contain();assert.deepEqual(result.failedSteps,['revoke-token']);assert.equal(f.rows.length,1);
});
for(const mode of ['http','redirect','redirected','type','length','mismatch','oversize','json','utf8','api-error','api-false','transport'])
test('bounded transport rejects invalid/unknown responses without automatic retry / '+mode,async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');f.setHook(()=>{
    if(mode==='http')return new Response(apiToken,{status:503});if(mode==='redirect')return new Response(null,{status:302});
    if(mode==='transport')throw Error(apiToken);
    const r=mode==='json'?new Response('{',{headers:{'Content-Type':'application/json'}})
      :mode==='utf8'?new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}})
      :mode==='oversize'?new Response(' '.repeat(2097153),{headers:{'Content-Type':'application/json'}})
      :json([],{result_info:{page:1,per_page:1000,count:0,total_count:0,total_pages:1},
        ...(mode==='api-error'?{errors:[{message:clientSecret}]}:{}),...(mode==='api-false'?{success:false}:{})});
    if(mode==='redirected')Object.defineProperty(r,'redirected',{value:true});if(mode==='type')r.headers.set('Content-Type','text/html');
    if(mode==='length')r.headers.set('Content-Length','2097153');if(mode==='mismatch')r.headers.set('Content-Length','1');return r;
  });
  await assert.rejects(f.adapter.createToken(),/^Error: byok_access_operation_unconfirmed$/);await assert.rejects(f.adapter.createToken());
  assert.equal(f.calls.length,1);assert.ok(!fs.readFileSync(f.path,'utf8').includes(clientSecret));
});
test('zero-byte chunk floods are bounded and cancelled',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');let pulls=0,cancelled=0;
  f.setHook(()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},{highWaterMark:0}),
    {headers:{'Content-Type':'application/json'}}));await assert.rejects(f.adapter.createToken());await tick();
  assert.equal(pulls,4096);assert.equal(cancelled,1);
});
test('deadline covers headers and late responses are cancelled without a late write',async t=>{
  const late=deferred(),f=setup(t,{timeoutMs:20});await acknowledge(f,'preflight','closure-before');let cancelled=0;
  f.setHook(()=>late.promise);await assert.rejects(f.adapter.createToken());
  late.resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}));
  await tick();assert.equal(cancelled,1);assert.equal(writes(f).length,0);assert.equal(f.adapter.snapshot().busy,false);
});
test('deadline covers a stuck body; no subsequent activating request',async t=>{
  const f=setup(t,{timeoutMs:20});await acknowledge(f,'preflight','closure-before');let cancelled=0;
  f.setHook(()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}));
  await assert.rejects(f.adapter.createToken());await tick();assert.equal(cancelled,1);assert.equal(writes(f).length,0);
});
test('already aborted operation never dispatches',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await assert.rejects(f.adapter.createToken({signal:AbortSignal.abort()}));assert.equal(f.calls.length,0);
});
test('invalid signal cannot race a rejected listener setup with HTTP dispatch',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');await assert.rejects(f.adapter.createToken({signal:{}}));
  assert.equal(f.calls.length,0);assert.equal(f.read().attempts['create-token'],undefined);
});
test('parallel operation rejected while in flight, journal close waits for it to settle',async t=>{
  const wait=deferred(),entered=deferred(),f=setup(t);await acknowledge(f,'preflight','closure-before');
  f.setHook(async()=>{entered.resolve();await wait.promise;});const first=f.adapter.createToken();await entered.promise;
  await assert.rejects(f.adapter.closeGateway());assert.throws(()=>f.journal.close());wait.resolve();await first;
  assert.equal(f.read().attempts['close-gateway'],undefined);
});
test('PENDING fsync failure prevents activation HTTP',async t=>{
  const f=setup(t);await acknowledge(f,'preflight','closure-before');f.setFsync(true);
  await assert.rejects(f.adapter.createToken());assert.equal(f.calls.length,0);f.setFsync(false);
});
test('containment still invokes known-resource closures if its PENDING fsync fails',async t=>{
  const f=await activated(t);f.setFsync(true);const result=await f.adapter.contain();
  assert.ok(result.failedSteps.includes('close-gateway'));assert.equal(f.ingress.get(g.worker).enabled,false);
  assert.deepEqual(f.apps.get(g.app).policies,[p(g)]);assert.deepEqual(f.rows,[]);f.setFsync(false);
});
