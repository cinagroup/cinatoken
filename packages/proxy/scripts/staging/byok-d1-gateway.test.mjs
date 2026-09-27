import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {byokCleanupFixture} from './byok-d1-cleanup-fixture.mjs';
import {BYOK_D1_CASES} from './byok-d1-acceptance.ts';
import {BYOK_D1_CONTROL_KEY,BYOK_D1_ORIGIN} from './byok-d1-one-shot.ts';
import {byokD1FenceInstallPlan,byokD1FenceTransition,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED} from './byok-d1-write-fence.ts';
import {captureByokD1CleanupBaseline,BYOK_D1_MAINTENANCE_KEY} from './byok-d1-cleanup.ts';
import {runByokD1Maintenance} from './byok-d1-maintenance-host.ts';
import {readJsonc} from '../../../../scripts/deploy/prepare-proxy-staging.mjs';
const {createByokD1Gateway:create}=await import(process.env.BYOK_D1_GATEWAY_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_GATEWAY_MODULE)).href:new URL('./byok-d1-gateway.ts',import.meta.url).href);
const aud='a'.repeat(64),token='a1'.repeat(32),hash=v=>createHash('sha256').update(v).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const headers=(action)=>({Authorization:'Bearer '+token,'X-CinaToken-BYOK-Command':action==='stop'?'stop-once-v1':'case-once-v1'});
const request=(action=BYOK_D1_CASES[0],init={})=>new Request(BYOK_D1_ORIGIN+'/__staging/byok-d1/'+action,{method:'POST',headers:headers(action),...init});
function deniedFixture(t){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const tasks=[],ctx={access:{aud},waitUntil(p){assert.equal(this,ctx);tasks.push(p);}};
  let dbReads=0;
  const env={BYOK_GATEWAY_ENVIRONMENT:'staging',BYOK_GATEWAY_ENABLED:'true',BYOK_GATEWAY_ACCESS_AUD:aud,
    get BYOK_DB(){dbReads++;throw Error('unexpected DB access');}};
  return {gateway:create(),ctx,tasks,env,get dbReads(){return dbReads;}};
}
async function fixture(t){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const f=byokCleanupFixture(),tasks=[],ctx={access:{aud},waitUntil(p){assert.equal(this,ctx);tasks.push(p);}};
  t.after(async()=>{await Promise.all(tasks);await f.close();});
  await f.raw.batch(byokD1FenceInstallPlan(JSON.stringify(f.schema())).map(q=>f.raw.prepare(q.sql).bind(...q.params)));
  const baseline=await captureByokD1CleanupBaseline(f.raw,hash(JSON.stringify(f.schema())),'write-fence-v1');
  const before=f.allRows();f.arm();const open=byokD1FenceTransition(f.runId,true);
  assert.equal((await f.raw.prepare(open.sql).bind(...open.params).run()).meta.changes,1);
  const gateway=create(),env={BYOK_GATEWAY_ENVIRONMENT:'staging',BYOK_GATEWAY_ENABLED:'true',BYOK_GATEWAY_ACCESS_AUD:aud,BYOK_DB:f.raw};
  const read=()=>JSON.parse(f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).value);
  return Object.assign(f,{gateway,env,ctx,tasks,read,before,baseline,send:(action,init)=>gateway.fetch(request(action,init),env,ctx)});
}

for(const fault of ['disabled','production','empty-audience','wrong-audience','missing-access','forged-access','missing-bearer','bad-bearer'])
test('authorization rejects before body or binding access / '+fault,async t=>{
  const f=deniedFixture(t),h=headers();
  if(fault==='disabled')f.env.BYOK_GATEWAY_ENABLED='false';
  if(fault==='production')f.env.BYOK_GATEWAY_ENVIRONMENT='production';
  if(fault==='empty-audience')f.env.BYOK_GATEWAY_ACCESS_AUD='';
  if(fault==='wrong-audience')f.ctx.access.aud='b'.repeat(64);
  if(['missing-access','forged-access'].includes(fault))delete f.ctx.access;
  if(fault==='forged-access')h['Cf-Access-Jwt-Assertion']='forged';
  if(fault==='missing-bearer')delete h.Authorization;
  if(fault==='bad-bearer')h.Authorization='Bearer private-invalid';
  const r=await f.gateway.fetch(request(undefined,{headers:h}),f.env,f.ctx);
  assert.ok(r.status>=400);assert.equal(f.dbReads,0);assert.equal(f.tasks.length,0);assert.doesNotMatch(await r.text(),/private|forged/);
});
for(const [name,make] of [
  ['get',()=>request(undefined,{method:'GET'})],['options',()=>request(undefined,{method:'OPTIONS'})],
  ['production-host',()=>new Request(request().url.replace('-staging',''),{method:'POST',headers:headers()})],
  ['http',()=>new Request(request().url.replace('https:','http:'),{method:'POST',headers:headers()})],
  ['query',()=>new Request(request().url+'?sql=DELETE',{method:'POST',headers:headers()})],
  ['fragment',()=>new Request(request().url+'#x',{method:'POST',headers:headers()})],
  ['long-url',()=>new Request(request().url+'?'+ 'x'.repeat(2048),{method:'POST',headers:headers()})],
  ['inference',()=>new Request(BYOK_D1_ORIGIN+'/v1/images/generations',{method:'POST',headers:headers()})],
  ['cleanup',()=>request('cleanup')],['encoded-path',()=>request('%73top')],
  ['origin',()=>request(undefined,{headers:{...headers(),Origin:'https://browser.invalid'}})],
  ['command',()=>request(undefined,{headers:{...headers(),'X-CinaToken-BYOK-Command':'stop-once-v1'}})],
  ['stop-command',()=>request('stop',{headers:headers()})],
  ['transfer',()=>request(undefined,{headers:{...headers(),'Transfer-Encoding':'chunked'}})],
  ['length',()=>request(undefined,{headers:{...headers(),'Content-Length':'1'}})],
])test('fixed command surface rejects / '+name,async t=>{
  const f=deniedFixture(t),r=await f.gateway.fetch(make(),f.env,f.ctx);
  assert.ok([400,404].includes(r.status));assert.equal(f.dbReads,0);assert.equal(f.tasks.length,0);
  assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
});
for(const mode of ['null','empty-string','empty-byte-stream'])test('verified empty command reaches native-shaped DB binding / '+mode,async t=>{
  const f=await fixture(t),init=mode==='null'?{}:mode==='empty-string'?{body:''}:{body:new ReadableStream({type:'bytes',start(c){c.close();}}),duplex:'half'};
  const r=await f.send(undefined,init);assert.equal(r.status,200);assert.equal((await r.json()).receipt.outcome,'PASS');assert.equal(f.read().cursor,1);
});
for(const mode of ['bytes','non-byte-stream','used','locked'])test('unverified body never gets discarded / '+mode,async t=>{
  const f=deniedFixture(t);
  const body=mode==='non-byte-stream'?new ReadableStream({start(c){c.close();}}):new ReadableStream({type:'bytes',start(c){c.enqueue(new Uint8Array([42]));c.close();}});
  const req=request(undefined,{body,duplex:'half',headers:{...headers(),'Content-Length':'0'}});
  let reader;if(mode==='used')await req.arrayBuffer();if(mode==='locked')reader=req.body.getReader();
  const r=await f.gateway.fetch(req,f.env,f.ctx);assert.equal(r.status,400);assert.equal(f.dbReads,0);reader?.releaseLock();
});
test('registration failure starts neither body reads nor D1; gate can serve a later command',async t=>{
  const f=deniedFixture(t);let pulls=0;const body=new ReadableStream({type:'bytes',pull(){pulls++;}},{highWaterMark:0});
  const original=f.ctx.waitUntil;f.ctx.waitUntil=()=>{throw Error('private');};
  assert.equal((await f.gateway.fetch(request(undefined,{body,duplex:'half'}),f.env,f.ctx)).status,503);
  assert.equal(pulls,0);assert.equal(f.dbReads,0);f.ctx.waitUntil=original;
  const r=await f.gateway.fetch(request(undefined,{body:'nonempty'}),f.env,f.ctx);assert.equal(r.status,400);assert.equal(f.dbReads,0);
});
test('inner D1 lifetime registration failure remains zero SQL',async t=>{
  const f=await fixture(t),before=f.calls.length;let registrations=0;
  f.ctx.waitUntil=p=>{if(++registrations===2)throw Error('rejected');f.tasks.push(p);};
  assert.equal((await f.send()).status,503);assert.equal(f.calls.length,before);assert.equal(f.read().state,'ready');
});
test('pre-aborted and body-aborted commands cannot claim',async t=>{
  const f=deniedFixture(t);
  assert.equal((await f.gateway.fetch(request(undefined,{signal:AbortSignal.abort()}),f.env,f.ctx)).status,409);assert.equal(f.tasks.length,0);
  const ac=new AbortController();let cancelled=0;
  const body=new ReadableStream({type:'bytes',pull(){},cancel(){cancelled++;}},{highWaterMark:0});
  const running=f.gateway.fetch(request(undefined,{body,duplex:'half',signal:ac.signal}),f.env,f.ctx);
  await tick();ac.abort();assert.equal((await running).status,409);assert.equal(cancelled,1);assert.equal(f.dbReads,0);
});
test('timed-out read holds load gate until actual cancellation settles',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=deniedFixture(t),released=deferred();let cancelled=0,settled=false;
  const body=new ReadableStream({type:'bytes',pull(){},cancel(){cancelled++;return released.promise;}},{highWaterMark:0});
  const running=f.gateway.fetch(request(undefined,{body,duplex:'half'}),f.env,f.ctx).then(r=>{settled=true;return r;});
  await tick();t.mock.timers.tick(1000);await tick();
  assert.equal(cancelled,1);assert.equal(settled,false);assert.equal((await f.gateway.fetch(request(),f.env,f.ctx)).status,503);assert.equal(f.dbReads,0);
  released.resolve();assert.equal((await running).status,408);assert.equal(f.dbReads,0);
});
test('stop has a separate load lane while a case body is stuck',async t=>{
  const f=await fixture(t),ac=new AbortController();const body=new ReadableStream({type:'bytes',pull(){}},{highWaterMark:0});
  const running=f.send(undefined,{body,duplex:'half',signal:ac.signal});await tick();
  assert.equal((await f.send('stop')).status,200);assert.equal(f.read().state,'stopped');assert.equal(f.read().cursor,0);
  ac.abort();assert.equal((await running).status,409);
});
test('stop can seal pending case; it does not clear ownership or claim SQL cancellation',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());
  f.hooks.beforeBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users')){entered.resolve();await release.promise;}};
  const running=f.send();await entered.promise;
  assert.equal((await f.send()).status,503);assert.equal((await f.send('stop')).status,200);assert.equal(f.read().state,'stopped');
  assert.equal(f.read().pendingCase,BYOK_D1_CASES[0]);release.resolve();assert.equal((await running).status,503);
  assert.equal(f.read().pendingCase,BYOK_D1_CASES[0]);assert.equal(f.read().receipts.length,0);assert.equal(f.counts().users,0);
});
test('another gateway context cannot replay a claimed case; post-claim disconnect still drains',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred(),ac=new AbortController();t.after(()=>release.resolve());
  f.hooks.beforeBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users')){entered.resolve();await release.promise;}};
  const running=f.send(undefined,{signal:ac.signal});await entered.promise;ac.abort();
  assert.equal((await create().fetch(request(),f.env,f.ctx)).status,409);assert.equal(f.read().state,'pending');
  release.resolve();assert.equal((await running).status,200);assert.equal(f.read().cursor,1);assert.equal(f.read().receipts[0].counters.active,0);
});
test('unknown claim or receipt acknowledgement never permits fixture replay',async t=>{
  for(const stage of ['claim','receipt']){
    const f=await fixture(t);let hit=false;
    f.hooks.afterStatement=s=>{if(s.sql.startsWith('UPDATE system_config')&&JSON.parse(s.values[0]).state===(stage==='claim'?'pending':'ready')){hit=true;throw Error('secret SQL');}};
    const r=await f.send();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret|SQL/);assert.equal(hit,true);
    assert.equal(f.read().state,stage==='claim'?'pending':'ready');const batches=f.batches.length;
    assert.equal((await f.send()).status,409);assert.equal(f.batches.length,batches);
  }
});
test('all ten cases through gateway, then STOP/seal/independent cleanup preserve the closed baseline',async t=>{
  const f=await fixture(t);
  for(const [i,id] of BYOK_D1_CASES.entries()){
    const r=await f.send(id,{body:''}),value=await r.json();assert.equal(r.status,200,JSON.stringify(value));
    assert.equal(value.code,'case_pass');assert.equal(value.receipt.caseId,id);assert.deepEqual(value.receipt,f.read().receipts[i]);
    assert.equal(value.receipt.result.midBatchWallClockExpiryVerified,false);assert.equal(value.receipt.counters.active,0);
    assert.doesNotMatch(JSON.stringify(value),new RegExp(token+'|'+hash(token)+'|enc:v2:|SELECT'));
  }
  assert.equal(f.read().state,'done');assert.equal((await f.send('stop')).status,200);
  const seal=byokD1FenceTransition(f.runId,false);assert.equal((await f.raw.prepare(seal.sql).bind(...seal.params).run()).meta.changes,1);
  const now=Math.floor(Date.now()/1000),maintenanceToken='b1'.repeat(32);
  const permit={version:1,runId:f.runId,tokenHash:hash(maintenanceToken),issuedAt:now,expiresAt:now+60,state:'ready',baseline:f.baseline,
    closure:{observedAt:now,evidenceSha256:'c'.repeat(64)},receipt:null};
  f.db.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(BYOK_D1_MAINTENANCE_KEY,JSON.stringify(permit),'local synthetic permit');
  const cleaned=await runByokD1Maintenance(f.raw,true,maintenanceToken,f.ctx);
  assert.equal(cleaned.status,'cleaned');assert.equal(cleaned.removedRows,664);assert.equal(cleaned.statementCount,143);
  const after=f.allRows();assert.equal(JSON.parse(after.system_config.find(r=>r.key===BYOK_D1_MAINTENANCE_KEY).value).state,'finished');
  assert.equal(after.system_config.find(r=>r.key===BYOK_D1_FENCE_KEY).value,BYOK_D1_FENCE_CLOSED);
  after.system_config=after.system_config.filter(r=>r.key!==BYOK_D1_MAINTENANCE_KEY);assert.deepEqual(after,f.before);
});
test('dedicated default Worker and config expose no inference, cleanup, services or provisioning',async t=>{
  const f=deniedFixture(t),{default:worker}=await import(process.env.BYOK_D1_GATEWAY_WORKER_MODULE
    ?pathToFileURL(resolve(process.env.BYOK_D1_GATEWAY_WORKER_MODULE)).href:new URL('./byok-d1-gateway-worker.ts',import.meta.url).href);
  assert.deepEqual(Object.keys(worker),['fetch']);
  assert.equal((await worker.fetch(new Request(BYOK_D1_ORIGIN+'/v1/chat/completions',{method:'POST'}),f.env,f.ctx)).status,404);assert.equal(f.dbReads,0);
  const c=readJsonc(fileURLToPath(new URL('./wrangler.byok-d1-gateway.jsonc',import.meta.url)));
  assert.equal(c.name,'cinatoken-proxy-staging');assert.equal(c.account_id,'7ea8e46d8210bad342fa7595f7935fea');
  assert.equal(c.main,'byok-d1-gateway-worker.ts');assert.equal(c.workers_dev,false);assert.equal(c.preview_urls,false);
  assert.deepEqual(c.routes,[]);assert.deepEqual(c.triggers,{crons:[]});assert.equal(c.send_metrics,false);
  assert.equal(c.compatibility_date,'2026-09-16');assert.deepEqual(c.compatibility_flags,['nodejs_compat']);assert.equal(c.observability.logs.invocation_logs,false);
  assert.deepEqual(c.vars,{BYOK_GATEWAY_ENVIRONMENT:'staging',BYOK_GATEWAY_ENABLED:'false',BYOK_GATEWAY_ACCESS_AUD:'',BYOK_GATEWAY_INSTALL_GRANT:''});
  assert.deepEqual(c.d1_databases,[{binding:'BYOK_DB',database_name:'cinatoken-staging',database_id:'6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1',remote:false}]);
  for(const key of ['services','kv_namespaces','r2_buckets','durable_objects','queues','hyperdrive','ai','secrets'])assert.equal(key in c,false);
});
test('actual default Worker entrypoint executes one case against its supplied binding',async t=>{
  const f=await fixture(t),{default:worker}=await import(process.env.BYOK_D1_GATEWAY_WORKER_MODULE
    ?pathToFileURL(resolve(process.env.BYOK_D1_GATEWAY_WORKER_MODULE)).href:new URL('./byok-d1-gateway-worker.ts',import.meta.url).href);
  const r=await worker.fetch(request(undefined,{body:''}),f.env,f.ctx);
  assert.equal(r.status,200);assert.equal(f.read().cursor,1);assert.equal((await r.json()).receipt.outcome,'PASS');
});
