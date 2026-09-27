import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {createRequestCapacityPool} from '../../src/services/request-capacity.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseCapacityStagingGateway} from './images-sse-capacity-gateway-handler.ts';
import {createImagesSseDurableStagingGateway} from './images-sse-durable-gateway-handler.ts';

// Logical ownership only: these arbitrary small numbers are NOT a memory profile.
const bytes=1024;
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
async function setup(t,boundary='snapshot'){
  const db=createSqliteD1(),tasks=[],controllers=[],responses=[];
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const key='synthetic-capacity-'+randomUUID();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const reached=Promise.withResolvers(),ack=Promise.withResolvers();ack.promise.catch(()=>{});
  let held=false,statements=0,sends=0;
  const hold=()=>{if(held)return;held=true;reached.resolve();return ack.promise;};
  if(boundary==='before-snapshot'){
    const prepare=db.binding.prepare.bind(db.binding);
    db.binding.prepare=sql=>{
      const statement=prepare(sql);
      if(!/^\s*INSERT INTO request_usage_settlements\s/.test(sql))return statement;
      // Test-owned transport delay BEFORE actual SQL. Preserve native statements
      // and batch atomicity; no synthesized D1 result or early capacity release.
      const wrap=s=>{
        const bind=s.bind.bind(s),run=s.run.bind(s);
        s.bind=(...values)=>wrap(bind(...values));s.run=async()=>{await hold();return run();};return s;
      };
      return wrap(statement);
    };
  }
  db.hooks.beforeStatement=()=>{statements++;};
  if(boundary==='snapshot')db.hooks.afterStatement=sql=>{
    if(/^\s*INSERT INTO request_usage_settlements\s/.test(sql))return hold();
  };
  if(boundary==='financial')db.hooks.afterBatch=sqls=>{
    if(sqls.some(sql=>sql.includes('INSERT INTO request_usage_commit_receipts')))return hold();
  };
  const pool=createRequestCapacityPool({maxRequests:1,maxReservedBytes:bytes});
  const policy={pool,reservedBytesPerRequest:bytes};
  const transport=async()=>{sends++;return new Response('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});};
  const app=createImagesSseCapacityStagingGateway(transport,policy);
  const sibling=createImagesSseCapacityStagingGateway(transport,policy);
  const env={DB:db.binding,DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-capacity-not-real-secret',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});await drainNodeBackgroundWork();};
  t.after(async()=>{for(const c of controllers)c.abort();ack.resolve();for(const r of responses)if(!r.body?.locked)await r.body?.cancel().catch(()=>{});await drain();db.sqlite.close();});
  const request=async(target=app,overrides={})=>{
    const controller=new AbortController();controllers.push(controller);
    const response=await target.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:controller.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...overrides},
      body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic capacity',stream:true})}),env,context);
    responses.push(response);return {response,controller};
  };
  const counts=()=>['request_usage_settlements','request_usage_commit_receipts','api_key_request_logs'].map(table=>db.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n);
  const chargedOnce=()=>{
    assert.deepEqual(counts(),[1,1,1]);
    assert.deepEqual({...db.sqlite.prepare('SELECT status,charged_cost FROM api_key_request_logs').get()},{status:'success',charged_cost:0.1});
    assert.deepEqual({...db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(fixture.ids.user)},{budget_spent_micros:100000,budget_reserved_micros:0});
    assert.equal(sends,1);
  };
  const blocked=async(target=sibling)=>{
    const before=statements,dispatched=sends;let pulls=0;
    const r=await target.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',duplex:'half',
      headers:{'Content-Type':'application/json','Content-Length':'1','X-Request-Capacity':'0'},
      body:new ReadableStream({pull(){pulls++;}},{highWaterMark:0})}),env,context);
    assert.equal(r.status,503);assert.match(await r.text(),/capacity_unavailable/);
    assert.equal(statements,before);assert.equal(sends,dispatched);assert.equal(pulls,0);
    assert.equal(pool.snapshot().requests,1);assert.equal(pool.snapshot().reservedBytes,bytes);
  };
  const available=async()=>{
    assert.equal(pool.snapshot().requests,0);assert.equal(pool.snapshot().reservedBytes,0);
    // A new ordinary handler can reuse the pool; no inference is dispatched.
    const r=await sibling.fetch(new Request('https://example.invalid/health'),{CINATOKEN_MAINTENANCE_MODE:'true'},context);
    assert.equal(r.status,503);assert.match(await r.text(),/maintenance_mode/);await drain();
    assert.equal(pool.snapshot().requests,0);
  };
  const storage=await resolveWorkerStorageFromBindings(env);
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  return {db,pool,request,reached:reached.promise,ack,drain,blocked,available,chargedOnce,counts,recover,env,context,transport};
}

for(const boundary of ['before-snapshot','snapshot','financial'])for(const cancel of ['reader','signal'])for(const terminal of ['resolve','reject'])
test(`durable SSE capacity: ${boundary} ACK / ${cancel} cancel / ${terminal}`,{timeout:10000},async t=>{
  const f=await setup(t,boundary),{response,controller}=await f.request();assert.equal(response.status,200);
  const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/completed/);
  await f.reached;await f.blocked();
  if(cancel==='reader')await reader.cancel();else {controller.abort();await assert.rejects(reader.read());}
  await flush();await f.blocked();
  assert.deepEqual(f.counts(),boundary==='before-snapshot'?[0,0,0]:boundary==='snapshot'?[1,0,0]:[1,1,1]);
  if(terminal==='resolve')f.ack.resolve();else f.ack.reject(Error('Synthetic committed ACK lost'));
  await f.drain();await f.available();
  if(boundary==='before-snapshot'&&terminal==='reject'){
    // No durable fact exists: preserve the unresolved financial state. Do not
    // invent a charge/refund or infer that a terminated promise persisted SQL.
    assert.deepEqual(f.counts(),[0,0,0]);assert.equal((await f.recover()).committed,0);
    assert.equal(f.db.sqlite.prepare('SELECT state FROM request_dispatch_intents').get().state,'dispatch_claimed');
    assert.equal(f.db.sqlite.prepare('SELECT state FROM user_budget_reservations').get().state,'dispatched');
  }else {f.chargedOnce();assert.equal((await f.recover()).committed,0);f.chargedOnce();}
});

test('independent recovery cannot free the original pending snapshot ACK reservation',{timeout:10000},async t=>{
  const f=await setup(t),{response}=await f.request();const reader=response.body.getReader();await reader.read();await f.reached;
  await reader.cancel();assert.equal((await f.recover()).committed,1);f.chargedOnce();await f.blocked();
  assert.equal((await f.recover()).committed,0);await f.blocked();
  f.ack.reject(Error('Original pending ACK terminates'));await f.drain();f.chargedOnce();await f.available();
});

test('response EOF does not release a still pending financial ACK',{timeout:10000},async t=>{
  const f=await setup(t,'financial'),{response}=await f.request();
  const wire=await response.text();assert.match(wire,/data: \[DONE\]\n\n$/);await f.reached;
  await f.blocked();f.chargedOnce();f.ack.resolve();await f.drain();await f.available();
});

test('unread response remainder retains capacity after all accounting tasks settle',{timeout:10000},async t=>{
  const f=await setup(t),{response}=await f.request();
  const reader=response.body.getReader();await reader.read();
  // Read completed, then leave DONE/EOF unread. Do not claim a fully unread
  // response drives upstream to completion: the driver honors backpressure.
  await f.reached;f.ack.resolve();await f.drain();f.chargedOnce();await f.blocked();
  await reader.cancel();await f.drain();await f.available();
});

test('explicit Worker capacity rejects Upgrade before storage, without a production default',async t=>{
  const f=await setup(t,'none');
  const {response}=await f.request(undefined,{Upgrade:'websocket'});
  assert.equal(response.status,503);assert.match(await response.text(),/capacity_unavailable/);
  assert.deepEqual(f.counts(),[0,0,0]);await f.available();
  const legacy=createImagesSseDurableStagingGateway(f.transport);
  const r=await legacy.fetch(new Request('https://example.invalid/health',{headers:{Upgrade:'websocket','X-Request-Capacity':'1'}}),
    {CINATOKEN_MAINTENANCE_MODE:'true',HTTP_CAPACITY:'1'},f.context);
  assert.equal(r.status,503);assert.match(await r.text(),/maintenance_mode/);
  assert.equal(f.pool.snapshot().requests,0);
});
