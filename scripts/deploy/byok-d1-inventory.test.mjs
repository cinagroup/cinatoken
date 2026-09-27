import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const {createByokD1Inventory:create}=await import(process.env.BYOK_INVENTORY_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_INVENTORY_MODULE)).href:new URL('./byok-d1-inventory.mjs',import.meta.url).href);
const secret='synthetic-test-credential',sensitive='private-env-value-must-not-be-saved';
const account='7ea8e46d8210bad342fa7595f7935fea',a='/accounts/'+account,db='6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1';
const targets=['cinatoken-proxy-staging','cinatoken-staging-recovery-control','cinatoken-staging-usage-recovery','cinatoken-staging-images-upstream'];
const names=[...targets,'producer'],ident=n=>String(n).padStart(32,'0');
const sha=v=>createHash('sha256').update(v).digest('hex'),ok=(result,result_info)=>({success:true,errors:null,result,result_info});
function setup(options={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-inventory-test-'));
  const dir=resolve(workspace,'.wrangler/staging/byok-d1-inventory-reservation'),calls=[],counts=new Map();let hook;
  const opts={workspace,apiToken:secret,fetchImpl:async(url,init)=>{
    const u=new URL(url);assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+secret);
    assert.match(fs.readFileSync(resolve(dir,'journal.jsonl'),'utf8'),/PENDING/);
    const path=u.pathname.replace('/client/v4','')+u.search,n=counts.get(path)??0;counts.set(path,n+1);calls.push(path);
    let value;
    if(path===a+'/workers/scripts')value=ok(names.map(id=>({id,deployment_id:'stable',modified_on:'unchanged'})));
    else if(path.startsWith(a+'/workers/services/')){const parts=u.pathname.split('/'),worker=parts[7];
      if(path.endsWith('/bindings'))value=ok([{type:'service',name:'EXTRA',service:targets[0],environment:'production'}]);
      else if(path.includes('/environments/'))value=ok({script:{tail_consumers:[]}});
      else value=ok({id:worker,default_environment:{environment:'production',script:{handlers:['fetch'],named_handlers:[]}},
        environments:[{environment:'production'},...(worker==='producer'?[{environment:'extra'}]:[])]});
    }else if(path.endsWith('/settings')){const worker=u.pathname.split('/').at(-2);value=ok({bindings:[{type:'plain_text',name:'PRIVATE',text:sensitive},
      ...(worker==='producer'?[{type:'service',name:'RPC',service:targets[2],entrypoint:'UsageRecovery'},
        {type:'d1',name:'DB',id:db},{type:'durable_object_namespace',name:'DO',script_name:targets[0],class_name:'Example'}]:[])],
      tail_consumers:worker==='producer'?[{service:targets[1]}]:[]});
    }else if(path.startsWith(a+'/pages/projects')){assert.equal(u.searchParams.has('per_page'),false);const page=Number(u.searchParams.get('page'));
      const rows=(page===1?[1,2]:[3]).map(n=>({id:ident(n),name:'pages-'+n,deployment_configs:{
        production:{env_vars:{PRIVATE:{value:sensitive}},services:n===3?{S:{service:targets[0]}}:{},d1_databases:{}},
        preview:{services:{},d1_databases:n===3?{DB:{id:db}}:{}}}}));
      value=ok(rows,{page,per_page:2,count:rows.length,total_count:3,total_pages:2});
    }else if(path.startsWith('/zones?'))value=ok([1,2].map(n=>({id:ident(n),account:{id:account}})),{page:1,per_page:50,count:2,total_count:2,total_pages:1});
    else if(path.startsWith('/zones/'))value=ok([{id:ident(9),script:targets[0],pattern:'staging.example.test/*'},{id:ident(8),script:null,pattern:'skip.example.test/*'}]);
    else if(path.startsWith(a+'/queues?'))value=ok([{queue_id:ident(6),consumers_total_count:1,consumers:[{type:'worker',script:targets[3]}]}],{page:1,per_page:100,count:1,total_count:1,total_pages:1});
    else if(path.startsWith(a+'/workflows?'))value=ok([],{page:1,per_page:100,count:0,total_count:0,total_pages:0});
    else throw Error('unexpected test path '+path);
    const altered=await hook?.({path,n,value,init});return altered??Response.json(value);
  },...options};
  return {workspace,dir,calls,opts,make:()=>create(opts),setHook:fn=>hook=fn};
}
test('reads every page and current environment, extracts target-only edges without private values or blanket admission',async()=>{
  const f=setup(),c=f.make(),p=c.run();assert.equal(c.run(),p);const r=await p;
  assert.equal(r.result,'CURRENT_CONFIGURATION_OBSERVED_GAPS_RETAINED');assert.equal(r.currentConfigurationInventoryComplete,true);
  assert.equal(r.allInvocationPathsInventoried,false);assert.equal(r.fullPreflightPassed,false);assert.equal(r.snapshotIsAtomic,false);
  assert.equal(r.catalogues.pages.count,3);assert.equal(r.catalogues.pages.pagesRead,2);assert.equal(r.workers.length,5);
  assert.equal(r.operations.length,21);assert.ok(r.operations.every(o=>o.result==='ACK'));assert.equal(r.edges.length,10);
  assert.ok(r.edges.some(e=>e.kind==='pages-service'));assert.ok(r.edges.some(e=>e.kind==='pages-d1'));
  assert.ok(r.edges.some(e=>e.source==='worker:producer/extra'));assert.ok(r.uncovered.includes('DISPATCH_NAMESPACES'));
  const raw=fs.readFileSync(resolve(f.dir,'result.json'),'utf8'),journal=fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8');
  for(const value of [secret,sensitive]){assert.ok(!raw.includes(value));assert.ok(!journal.includes(value));}
  let previous='0'.repeat(64);for(const line of journal.trim().split('\n')){const {sha256,...row}=JSON.parse(line);assert.equal(row.previous,previous);assert.equal(sha(JSON.stringify(row)),sha256);previous=sha256;}
  assert.equal(JSON.parse(journal.trim().split('\n').at(-1)).sequence,44);
  r.edges.length=0;assert.equal(c.report().edges.length,10);
});
for(const kind of ['duplicate-workers','missing-target','unsafe-worker','too-many-workers','environment-duplicate','wrong-service','missing-default',
  'malformed-bindings','malformed-service-binding','conflicting-consumer','missing-consumer-target','partial-consumers','unknown-consumer',
  'missing-pagination','wrong-page','wrong-count','changed-total','duplicate-pages','foreign-zone','unsafe-zone','routes-duplicate',
  'workers-drift','invalid-errors','http-error','redirect','content-type','body-length','invalid-utf8']){
  test('rejects '+kind+' and retains partial observations without retry or completion',async()=>{
    const f=setup();f.setHook(({path,n,value})=>{
      if(path===a+'/workers/scripts'){
        if(kind==='duplicate-workers')value.result.push(value.result[0]);if(kind==='missing-target')value.result.shift();
        if(kind==='unsafe-worker')value.result[0].id='../outside';if(kind==='too-many-workers')value.result=Array(201).fill(value.result[0]);
        if(kind==='workers-drift'&&n===1)value.result[0].deployment_id='changed';
        if(kind==='invalid-errors')value.errors={};if(kind==='http-error')return Response.json(value,{status:403});
        if(kind==='redirect')return {status:200,redirected:true,body:new ReadableStream(),headers:new Headers({'Content-Type':'application/json'})};
        if(kind==='content-type')return new Response(JSON.stringify(value),{headers:{'Content-Type':'text/html'}});
        if(kind==='body-length')return Response.json(value,{headers:{'Content-Length':'1'}});
        if(kind==='invalid-utf8')return new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}});
      }
      if(path===a+'/workers/services/producer'){
        if(kind==='environment-duplicate')value.result.environments.push(value.result.environments[0]);
        if(kind==='wrong-service')value.result.id='other';if(kind==='missing-default')value.result.default_environment.environment='missing';
      }
      if(path.endsWith('/producer/settings')){if(kind==='malformed-bindings')value.result.bindings={};if(kind==='malformed-service-binding')delete value.result.bindings[1].service;}
      if(path.startsWith(a+'/queues?')){
        const q=value.result[0],c=q.consumers[0];if(kind==='conflicting-consumer')c.script_name='other';if(kind==='missing-consumer-target')delete c.script;
        if(kind==='partial-consumers')q.consumers_total_count=2;if(kind==='unknown-consumer')c.type='future-unknown';
      }
      if(path.startsWith(a+'/pages/projects')){
        if(kind==='missing-pagination')delete value.result_info;
        if(kind==='wrong-page')value.result_info.page=9;if(kind==='wrong-count')value.result_info.count=0;
        if(kind==='changed-total'&&path.endsWith('page=2'))value.result_info.total_count=4;
        if(kind==='duplicate-pages'&&path.endsWith('page=2'))value.result[0].id=ident(1);
      }
      if(path.startsWith('/zones?')){if(kind==='foreign-zone')value.result[0].account.id='other';if(kind==='unsafe-zone')value.result[0].id='../unsafe';}
      if(path.startsWith('/zones/')&&kind==='routes-duplicate')value.result[1].id=value.result[0].id;
      return Response.json(value);
    });
    const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.currentConfigurationInventoryComplete,false);
    assert.equal(r.allInvocationPathsInventoried,false);assert.ok(fs.existsSync(resolve(f.dir,'result.json')));
    const queries=f.calls.filter(p=>p!==a+'/workers/scripts');assert.equal(new Set(queries).size,queries.length);
  });
}
test('supports documented queue script_name and legacy service aliases, but never treats absent identity as no edge',async()=>{
  for(const key of ['script_name','service']){const f=setup();f.setHook(({path,value})=>{if(path.startsWith(a+'/queues?')){const c=value.result[0].consumers[0];c[key]=c.script;delete c.script;return Response.json(value);}});
    const r=await f.make().run();assert.equal(r.currentConfigurationInventoryComplete,true);assert.ok(r.edges.some(e=>e.kind==='queue-consumer'));}
});
test('decoded size bound is independent of Content-Length and compression',async()=>{
  const f=setup();f.setHook(()=>new Response(' '.repeat(2097153),{headers:{'Content-Type':'application/json','Content-Encoding':'gzip','Content-Length':'1'}}));
  assert.equal((await f.make().run()).currentConfigurationInventoryComplete,false);assert.equal(f.calls.length,1);
});
test('abort and late response cannot mutate the sealed report or journal',async()=>{
  let finish,cancelled=0;const f=setup({timeoutMs:20});f.setHook(()=>new Promise(r=>finish=r));const c=f.make(),r=await c.run();
  assert.equal(r.result,'FAILED_RETAINED');const log=fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8');
  finish(new Response(new ReadableStream({cancel(){cancelled++;}})));await tick();await tick();
  assert.equal(cancelled,1);assert.deepEqual(c.report(),r);assert.equal(fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8'),log);
});
test('caller abort bounds noncooperative fetch',async()=>{
  const ac=new AbortController(),f=setup({signal:ac.signal});f.setHook(()=>new Promise(()=>{}));const p=f.make().run();await tick();ac.abort();
  assert.equal((await p).result,'FAILED_RETAINED');assert.equal(f.calls.length,1);
});
test('already-aborted request creates no reservation and does not send',async()=>{
  const f=setup({signal:AbortSignal.abort()});assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.dir),false);
});
test('existing reservation is not resumed or overwritten',async()=>{
  const f=setup();await f.make().run();const before=fs.readFileSync(resolve(f.dir,'result.json'));const count=f.calls.length;
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,count);assert.deepEqual(fs.readFileSync(resolve(f.dir,'result.json')),before);
});
test('symlinked parent is rejected before traffic',async()=>{
  const f=setup(),target=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-inventory-link-'));
  fs.symlinkSync(target,resolve(f.workspace,'.wrangler'),'junction');assert.equal((await f.make().run()).result,'FAILED_RETAINED');
  assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(target),[]);
});
test('invalid credential, deadline or fetch configuration is rejected before I/O',()=>{
  const f=setup();for(const change of [{apiToken:'bad\n'},{timeoutMs:120001},{timeoutMs:0},{fetchImpl:null}])assert.throws(()=>create({...f.opts,...change}));assert.equal(f.calls.length,0);
});
