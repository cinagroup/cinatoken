import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const {createByokD1PaidPlan:create,projectByokD1PaidPlan:project}=await import(process.env.BYOK_PAID_PLAN_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_PAID_PLAN_MODULE)).href:'./byok-d1-paid-plan.mjs');
const secret='synthetic-api-credential-DO-NOT-PERSIST',privateData='unrelated-private-billing-data';
const sha=v=>createHash('sha256').update(v).digest('hex'),iso=n=>new Date(n).toISOString();
function subscription(at=Date.now(),extra={}){return {id:'0123456789abcdef0123456789abcdef',currency:'USD',price:5,
  current_period_start:iso(at-86400000),current_period_end:iso(at+86400000),state:'Paid',
  rate_plan:{id:'workers_paid',public_name:'Workers Paid',scope:'account'},...extra};}
function input(){const atMs=Date.now();return {atMs,settings:{default_usage_model:'standard'},subscriptions:[subscription(atMs)]};}
function setup(extra={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-paid-plan-test-'));
  const calls=[],data=input();let hook;const directory=resolve(workspace,'.wrangler/staging/byok-d1-paid-plan-reservation');
  const opts={workspace,apiToken:secret,fetchImpl:async(url,init)=>{
    const allowed=['/workers/account-settings','/subscriptions'],path=new URL(url).pathname.replace('/client/v4/accounts/7ea8e46d8210bad342fa7595f7935fea','');
    assert.ok(allowed.includes(path));assert.equal(new URL(url).origin,'https://api.cloudflare.com');assert.equal(new URL(url).search,'');
    assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+secret);
    const lines=fs.readFileSync(resolve(directory,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(lines.at(-1).result,'PENDING');
    calls.push({path});const replacement=await hook?.(path,calls.length,init);if(replacement!==undefined)return replacement;
    return Response.json({success:true,errors:null,result:path===allowed[0]?data.settings:data.subscriptions});
  },...extra};
  return {workspace,directory,calls,data,opts,setHook(f){hook=f;},make:()=>create(opts)};
}
test('only exact active account Workers Paid qualifies; unrelated billing is not projected',()=>{
  const v=input();v.settings.extra=privateData;v.subscriptions.unshift({id:privateData,price:999,state:'Paid',rate_plan:{id:'free',public_name:privateData}});
  v.subscriptions.push({id:privateData,price:0,state:'Paid',rate_plan:{id:'workers_planetscale_paid'}});
  const r=project(v);assert.equal(r.selected.productId,'workers_paid');assert.equal(r.workersSubscriptions.length,1);assert.ok(!JSON.stringify(r).includes(privateData));
});
test('zero-priced discount is not used to disqualify an otherwise exact Paid product',()=>{const v=input();v.subscriptions[0].price=0;assert.equal(project(v).selected.current,true);});
test('default usage model is descriptive, never a paid entitlement on its own',()=>{const v=input();v.subscriptions=[];assert.throws(()=>project(v));});
test('historical cancelled record is retained but only the current paid period qualifies',()=>{
  const v=input();v.subscriptions.push(subscription(v.atMs-3*86400000,{id:'a'.repeat(32),state:'Cancelled'}));
  const r=project(v);assert.equal(r.workersSubscriptions.length,2);assert.equal(r.selected.subscriptionId,v.subscriptions[0].id);
});
for(const kind of ['free','different-product','wrong-scope','trial','provisioned','awaiting-payment','cancelled','failed','expired-state',
  'future','ended','reverse-period','invalid-calendar','non-utc','bad-price','negative-price','bad-currency','missing-id','duplicate-id',
  'two-current','missing-settings','missing-model','missing-result','too-many-subscriptions','bad-state']){
  test('invalid or insufficient plan evidence rejected: '+kind,()=>{
    const v=input(),s=v.subscriptions[0];
    if(kind==='free')s.rate_plan.id='free';if(kind==='different-product')s.rate_plan.id='workers_planetscale_paid';if(kind==='wrong-scope')s.rate_plan.scope='zone';
    const states={trial:'Trial',provisioned:'Provisioned','awaiting-payment':'AwaitingPayment',cancelled:'Cancelled',failed:'Failed','expired-state':'Expired','bad-state':'unknown'};if(states[kind])s.state=states[kind];
    if(kind==='future')s.current_period_start=iso(v.atMs+1);if(kind==='ended')s.current_period_end=iso(v.atMs);
    if(kind==='reverse-period')s.current_period_end=iso(v.atMs-2*86400000);if(kind==='invalid-calendar')s.current_period_start='2026-02-30T00:00:00Z';
    if(kind==='non-utc')s.current_period_start='2026-01-01T00:00:00+00:00';if(kind==='bad-price')s.price='5';if(kind==='negative-price')s.price=-1;
    if(kind==='bad-currency')s.currency='usd';if(kind==='missing-id')delete s.id;
    if(kind==='duplicate-id')v.subscriptions.push({...s});if(kind==='two-current')v.subscriptions.push({...s,id:'b'.repeat(32)});
    if(kind==='missing-settings')v.settings=null;if(kind==='missing-model')v.settings={};if(kind==='missing-result')v.subscriptions={};
    if(kind==='too-many-subscriptions')v.subscriptions=Array(1001).fill({rate_plan:{id:'other'}});
    assert.throws(()=>project(v));
  });
}
test('four fixed GETs and stable projection produce only a point-in-time fact, with no replay',async()=>{
  const f=setup(),reader=f.make();assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
  const promise=reader.run();assert.equal(reader.run(),promise);const r=await promise;
  assert.equal(r.result,'PAID_PLAN_OBSERVED');assert.equal(r.paidPlanObserved,true);assert.equal(r.planStable,true);assert.equal(r.operations.length,4);
  for(const key of ['fullPreflightPassed','budgetVerified','subscriptionCreated','snapshotIsAtomic'])assert.equal(r[key],false);
  assert.equal(r.cloudWrites,0);assert.match(r.evidenceSha256,/^[a-f0-9]{64}$/);assert.equal(r.observations.length,2);
  const file=fs.readFileSync(resolve(f.directory,'result.json'),'utf8');assert.ok(!file.includes(secret));assert.deepEqual(JSON.parse(file),r);
  let previous='0'.repeat(64);const lines=fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8').trim().split('\n');assert.equal(lines.length,10);
  for(const [i,line] of lines.entries()){const {sha256,...row}=JSON.parse(line);assert.equal(row.sequence,i+1);assert.equal(row.previous,previous);assert.equal(sha(JSON.stringify(row)),sha256);previous=sha256;}
  r.paidPlanObserved=false;r.observations[0].selected.state='Failed';assert.equal(reader.report().paidPlanObserved,true);assert.equal(reader.report().observations[0].selected.state,'Paid');
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,4);
});
for(const kind of ['settings-drift','plan-drift','plan-disappears','period-changes','price-changes','extra-current','http','mime','missing-body','errors','truthy-success',
  'malformed-json','invalid-utf8','length','oversize-header','oversize-body','encoding','partial-pagination','next-page','cursor','too-many-reads']){
  test('real collector fails closed and keeps bounded evidence: '+kind,async()=>{
    const f=setup();f.setHook((path,n)=>{
      const value=path.endsWith('subscriptions')?structuredClone(f.data.subscriptions):structuredClone(f.data.settings);
      if(kind==='http')return new Response(privateData,{status:403});if(kind==='mime')return new Response('{}');
      if(kind==='missing-body')return new Response(null,{headers:{'Content-Type':'application/json'}});
      if(kind==='errors')return Response.json({success:true,errors:[{message:privateData}],result:value});if(kind==='truthy-success')return Response.json({success:'true',result:value});
      if(kind==='malformed-json')return new Response('{',{headers:{'Content-Type':'application/json'}});
      if(kind==='invalid-utf8')return new Response(new Uint8Array([0xff]),{headers:{'Content-Type':'application/json'}});
      if(kind==='length')return new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'999'}});
      if(kind==='oversize-header')return new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'2097153'}});
      if(kind==='oversize-body')return new Response('x'.repeat(2097153),{headers:{'Content-Type':'application/json'}});
      if(kind==='encoding')return new Response('{}',{headers:{'Content-Type':'application/json','Content-Encoding':'unknown'}});
      if(kind==='too-many-reads'){let reads=0;return new Response(new ReadableStream({pull(c){if(++reads<4100)c.enqueue(new Uint8Array([32]));else c.close();}}),{headers:{'Content-Type':'application/json'}});}
      if(n===3&&kind==='settings-drift')value.default_usage_model='bundled';
      if(n===4){if(kind==='plan-drift')value[0].state='Failed';if(kind==='plan-disappears')value.length=0;if(kind==='period-changes')value[0].current_period_end=iso(f.data.atMs+2*86400000);
        if(kind==='price-changes')value[0].price=6;if(kind==='extra-current')value.push({...value[0],id:'f'.repeat(32)});}
      if(path.endsWith('subscriptions')){
        if(kind==='partial-pagination')return Response.json({success:true,result:value,result_info:{count:value.length,total_count:value.length+1}});
        if(kind==='next-page')return Response.json({success:true,result:value,result_info:{page:2}});
        if(kind==='cursor')return Response.json({success:true,result:value,result_info:{cursors:{after:'next'}}});
      }
      return Response.json({success:true,result:value});
    });
    const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.paidPlanObserved,false);assert.equal(r.evidenceSha256,undefined);
    assert.ok(f.calls.length<=4);assert.ok(fs.existsSync(resolve(f.directory,'result.json')));assert.ok(!JSON.stringify(r).includes(privateData));assert.ok(!JSON.stringify(r).includes(secret));
  });
}
test('compressed fetch body is decoded; compressed Content-Length is not compared to decoded bytes',async()=>{
  const f=setup();f.setHook(path=>{const body=JSON.stringify({success:true,result:path.endsWith('subscriptions')?f.data.subscriptions:f.data.settings});return new Response(body,{headers:{'Content-Type':'application/json','Content-Encoding':'gzip','Content-Length':'2'}});});
  assert.equal((await f.make().run()).paidPlanObserved,true);
});
test('single-page metadata is checked without inventing pagination requests',async()=>{
  const f=setup();f.setHook(path=>path.endsWith('subscriptions')?Response.json({success:true,result:f.data.subscriptions,result_info:{page:1,count:1,total_count:1,total_pages:1,per_page:20}}):undefined);
  assert.equal((await f.make().run()).paidPlanObserved,true);assert.equal(f.calls.length,4);
});
test('unrelated product changes are neither persisted nor treated as Workers entitlement drift',async()=>{
  const f=setup();f.setHook((path,n)=>path.endsWith('subscriptions')?Response.json({success:true,result:[...f.data.subscriptions,{rate_plan:{id:'other'},personal:privateData+n}]}):undefined);
  const r=await f.make().run();assert.equal(r.paidPlanObserved,true);assert.ok(!JSON.stringify(r).includes(privateData));
});
test('pre-aborted run performs no reservation or cloud traffic',async()=>{
  const f=setup({signal:AbortSignal.abort()});assert.equal((await f.make().run()).paidPlanObserved,false);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
});
test('caller cancellation bounds noncooperative fetch and ignores its late body',async()=>{
  const ac=new AbortController(),f=setup({signal:ac.signal});let release,cancelled=0;f.setHook(()=>new Promise(r=>{release=r;}));
  const reader=f.make(),pending=reader.run();await tick();ac.abort();const result=await pending;assert.equal(result.paidPlanObserved,false);
  const before=fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8');release(new Response(new ReadableStream({cancel(){cancelled++;}})));
  await tick();await tick();assert.equal(cancelled,1);assert.equal(fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8'),before);assert.deepEqual(reader.report(),result);
});
test('collection deadline is finite even when fetch ignores cancellation',async()=>{
  const f=setup({timeoutMs:20});f.setHook(()=>new Promise(()=>{}));const r=await f.make().run();assert.equal(r.paidPlanObserved,false);assert.equal(f.calls.length,1);
});
test('options reject credentials containing whitespace and excessive timeouts before I/O',()=>{
  const f=setup();for(const extra of [{apiToken:'a b'},{timeoutMs:60001},{timeoutMs:0},{fetchImpl:1},{signal:1},{io:{}}])assert.throws(()=>create({...f.opts,...extra}),/byok_paid_plan_options_invalid/);
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
});
test('linked evidence parent cannot redirect output outside the workspace',async()=>{
  const f=setup(),other=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-plan-link-'));fs.symlinkSync(other,resolve(f.workspace,'.wrangler'),'junction');
  assert.equal((await f.make().run()).paidPlanObserved,false);assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(other),[]);
});
test('PENDING persistence failure prevents the corresponding network request',async()=>{
  const f=setup();let syncs=0;f.opts.io={...fs,fsyncSync(fd){if(++syncs===2)throw Error(privateData);return fs.fsyncSync(fd);}};
  const r=await f.make().run();assert.equal(r.paidPlanObserved,false);assert.equal(f.calls.length,0);assert.ok(!JSON.stringify(r).includes(privateData));
});
test('result persistence failure cannot return a usable paid observation',async()=>{
  const f=setup();f.opts.io={...fs,openSync(path,...args){if(String(path).endsWith('result.json'))throw Error(privateData);return fs.openSync(path,...args);}};
  const reader=f.make();await assert.rejects(reader.run(),/byok_paid_plan_result_not_durable/);assert.equal(reader.report().paidPlanObserved,false);assert.equal(reader.report().evidenceSha256,undefined);
});
test('period boundary or wall-clock jump during observation prevents qualification',async t=>{
  const f=setup();const initial=Date.now();t.mock.method(Date,'now',()=>initial);
  f.setHook((_,n)=>{if(n===3)t.mock.method(Date,'now',()=>initial+120000);});
  assert.equal((await f.make().run()).paidPlanObserved,false);assert.equal(f.calls.length,3);
});
test('period includes its start but excludes its end',()=>{
  const v=input();v.subscriptions[0].current_period_start=iso(v.atMs);assert.equal(project(v).selected.current,true);
  v.subscriptions[0].current_period_end=iso(v.atMs);assert.throws(()=>project(v));
});
test('sub-millisecond period start is never truncated into early eligibility',()=>{
  const v=input();v.atMs=Date.parse('2026-09-21T00:00:00Z');v.subscriptions=[subscription(v.atMs)];
  v.subscriptions[0].current_period_start='2026-09-21T00:00:00.000000001Z';assert.throws(()=>project(v));
  v.atMs++;assert.equal(project(v).selected.current,true);
});
test('sub-millisecond period end uses its actual precision',()=>{
  const v=input();v.atMs=Date.parse('2026-09-21T00:00:00Z');v.subscriptions=[subscription(v.atMs)];
  v.subscriptions[0].current_period_end='2026-09-21T00:00:00.000000001Z';assert.equal(project(v).selected.current,true);
  v.atMs++;assert.throws(()=>project(v));
});
test('more than sixteen Workers Paid records is bounded rather than partially inspected',()=>{
  const v=input();v.subscriptions=Array.from({length:17},(_,i)=>subscription(v.atMs,{id:i.toString(16).padStart(32,'0')}));assert.throws(()=>project(v));
});
test('errors absent and empty array are both accepted, without accepting error strings',async()=>{
  for(const errors of [undefined,[]]){const f=setup();f.setHook(path=>Response.json({success:true,errors,result:path.endsWith('subscriptions')?f.data.subscriptions:f.data.settings}));assert.equal((await f.make().run()).paidPlanObserved,true);}
});
test('a body arriving after cancellation cannot mutate the settled report or journal',async()=>{
  const ac=new AbortController(),f=setup({signal:ac.signal});let release,entered=0,cancelled=0;
  f.setHook(()=>({status:200,redirected:false,headers:new Headers({'Content-Type':'application/json'}),body:{getReader(){return {
    read(){entered++;return new Promise(r=>{release=r;});},cancel(){cancelled++;return Promise.resolve();}
  };}}}));
  const reader=f.make(),pending=reader.run();while(!entered)await tick();ac.abort();const r=await pending;
  const before=fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8');release({done:false,value:new TextEncoder().encode(privateData)});await tick();await tick();
  assert.equal(r.paidPlanObserved,false);assert.ok(cancelled>0);assert.deepEqual(reader.report(),r);assert.equal(fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8'),before);
});
test('final journal flush failure revokes the successful observation',async()=>{
  const f=setup();let syncs=0;f.opts.io={...fs,fsyncSync(fd){if(++syncs===10)throw Error(privateData);return fs.fsyncSync(fd);}};
  const r=await f.make().run();assert.equal(r.paidPlanObserved,false);assert.equal(r.evidenceSha256,undefined);assert.ok(!JSON.stringify(r).includes(privateData));
});
test('journal close failure revokes the observation and returns only a sanitized error',async()=>{
  const f=setup();let closed=false;f.opts.io={...fs,closeSync(fd){fs.closeSync(fd);if(!closed){closed=true;throw Error(privateData);}}};
  const reader=f.make();await assert.rejects(reader.run(),/^Error: byok_paid_plan_result_not_durable$/);assert.equal(reader.report().paidPlanObserved,false);assert.equal(reader.report().evidenceSha256,undefined);
});
test('short filesystem writes are completed and zero-byte writes are rejected before network',async()=>{
  const f=setup();f.opts.io={...fs,writeSync(fd,b,offset,length){return fs.writeSync(fd,b,offset,Math.min(length,11));}};
  assert.equal((await f.make().run()).paidPlanObserved,true);
  const zero=setup();let writes=0;zero.opts.io={...fs,writeSync(...args){if(++writes===1)return 0;return fs.writeSync(...args);}};
  assert.equal((await zero.make().run()).paidPlanObserved,false);assert.equal(zero.calls.length,0);
});
