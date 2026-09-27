import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const {createByokD1PagesHistoryInventory: create} = await import(process.env.BYOK_PAGES_HISTORY_MODULE
  ? pathToFileURL(resolve(process.env.BYOK_PAGES_HISTORY_MODULE)).href : './byok-d1-pages-history.mjs');
const token='synthetic-pages-history-token', secret='PRIVATE-DO-NOT-PERSIST';
const base='/accounts/7ea8e46d8210bad342fa7595f7935fea/pages/projects';
const db='6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1', target='cinatoken-proxy-staging';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=v=>createHash('sha256').update(v).digest('hex');
const project=n=>({id:uuid(n),name:'project-'+n,uses_functions:false,
  production_script_name:'pages-worker--'+n+'-production',preview_script_name:'pages-worker--'+n+'-preview',
  latest_deployment:{id:uuid(n*100+3)},canonical_deployment:{id:uuid(n*100+1)},
  deployment_configs:{production:{env_vars:{PRIVATE:{value:secret}},d1_databases:{CURRENT:{id:db}}},preview:{}}});
const deployment=(n,i,environment)=>({id:uuid(n*100+i),project_id:uuid(n),project_name:'project-'+n,environment,
  uses_functions:false,is_skipped:true,created_on:'2026-01-01T00:00:00Z',modified_on:'2026-01-01T00:00:00Z',
  latest_stage:{status:'failure'},env_vars:{PRIVATE:{value:secret}},
  ...(i===1?{services:{},d1_databases:null,durable_object_namespaces:{}}:{}),
  ...(n===1&&i===3?{services:{RPC:{service:target,environment:'production',entrypoint:'Handler'}},
    d1_databases:{DB:{id:db}},durable_object_namespaces:{DO:{service:target,class_name:'Example'},UNKNOWN:{namespace_id:uuid(999)}}}:{}),
  ...(n===1&&environment==='preview'?{services:{},d1_databases:{},durable_object_namespaces:{}}:{})});
function envelope(rows,page,perPage=2){return {success:true,errors:null,result:rows.slice((page-1)*perPage,page*perPage),
  result_info:{page,per_page:perPage,count:rows.slice((page-1)*perPage,page*perPage).length,total_count:rows.length,total_pages:Math.ceil(rows.length/perPage)}};}
function setup(options={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-pages-test-'));
  const dir=resolve(workspace,'.wrangler/staging/byok-d1-pages-history-reservation');
  const calls=[],counts=new Map();let hook;
  const opts={workspace,apiToken:token,fetchImpl:async(url,init)=>{
    const u=new URL(url),path=u.pathname.replace('/client/v4','')+u.search,page=Number(u.searchParams.get('page'));
    assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+token);
    assert.match(fs.readFileSync(resolve(dir,'journal.jsonl'),'utf8'),/PENDING/);assert.equal(u.searchParams.has('per_page'),false);
    const n=counts.get(path)??0;counts.set(path,n+1);calls.push(path);let value;
    if(u.pathname.endsWith('/pages/projects'))value=envelope([1,2,3,4,5].map(project),page);
    else{
      const p=Number(u.pathname.match(/\/project-(\d+)\/deployments$/)?.[1]),env=u.searchParams.get('env');
      assert.ok(p>=1&&p<=5);assert.ok(['production','preview'].includes(env));
      value=envelope((env==='production'?[1,2,3]:p===1?[4]:[]).map(i=>deployment(p,i,env)),page);
    }
    return await hook?.({path,n,value,init,u})??Response.json(value);
  },...options};
  return {workspace,dir,calls,opts,make:()=>create(opts),hook:fn=>{hook=fn;}};
}
test('two complete environment sweeps include old skipped/static failures and distinguish absent/null/empty maps',async()=>{
  const f=setup(),c=f.make(),p=c.run();assert.equal(c.run(),p);const r=await p;
  assert.equal(r.result,'HISTORY_METADATA_OBSERVED_BINDING_SEMANTICS_PENDING');assert.equal(r.historyCatalogueComplete,true);
  assert.equal(r.reportedBindingMapsObserved,true);assert.equal(r.projectCatalogueStable,true);
  for(const key of ['historicalBindingsComplete','absenceSemanticsVerified','allInvocationPathsInventoried','fullPreflightPassed','snapshotIsAtomic','visibilityScopeVerified'])assert.equal(r[key],false);
  assert.equal(r.projects.length,5);assert.ok(r.projects.every(p=>p.stable&&p.firstSweepComplete));assert.equal(r.deploymentCount,16);
  assert.equal(r.operations.length,36);assert.ok(r.operations.every(o=>o.result==='ACK'&&o.status===200));
  assert.equal(r.edges.length,4);assert.deepEqual(r.edges.map(e=>e.kind).sort(),['pages-d1','pages-durable-object','pages-service','pages-unresolved-durable-namespace']);
  assert.ok(r.edges.every(e=>e.source==='pages:project-1/production@'+uuid(103)));
  assert.deepEqual(r.fieldCoverage.d1_databases,{explicit:2,absentUnverified:9,nullUnverified:5,returnedEntries:1});
  assert.deepEqual(r.projects[1].environments.preview,{count:0,pages:1});
  const saved=fs.readFileSync(resolve(f.dir,'result.json'),'utf8'),log=fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8');
  for(const privateValue of [token,secret]){assert.ok(!saved.includes(privateValue));assert.ok(!log.includes(privateValue));}
  let previous='0'.repeat(64);const lines=log.trim().split('\n');assert.equal(lines.length,74);
  lines.forEach((line,i)=>{const {sha256,...row}=JSON.parse(line);assert.equal(row.sequence,i+1);assert.equal(row.previous,previous);assert.equal(sha(JSON.stringify(row)),sha256);previous=sha256;});
  r.edges.length=0;assert.equal(c.report().edges.length,4);
});
for(const kind of ['missing-pagination','wrong-page','wrong-count','wrong-total-pages','changed-total','changed-per-page',
  'excess-projects','duplicate-project','duplicate-name','unsafe-name','missing-config','missing-script','project-drift','config-drift',
  'duplicate-deployment','cross-environment-duplicate','wrong-project-id','wrong-project-name','wrong-environment','invalid-deployment-id',
  'invalid-boolean','invalid-time','excess-deployments','history-drift','binding-array','binding-scalar','too-many-bindings',
  'missing-service','missing-d1-id','conflicting-d1-aliases','conflicting-do-aliases','unresolved-do-missing-id',
  'http-error','envelope-error','missing-result','mime','redirect','length','utf8']){
  test('fails closed and preserves evidence: '+kind,async()=>{
    const f=setup();f.hook(({path,n,value,u})=>{
      if(u.pathname.endsWith('/pages/projects')){
        if(kind==='missing-pagination')delete value.result_info;
        if(kind==='wrong-page')value.result_info.page=9;
        if(kind==='wrong-count')value.result_info.count=0;
        if(kind==='wrong-total-pages')value.result_info.total_pages=1;
        if(kind==='changed-total'&&u.searchParams.get('page')==='2')value.result_info.total_count=6;
        if(kind==='changed-per-page'&&u.searchParams.get('page')==='2')value.result_info.per_page=3;
        if(kind==='excess-projects')value.result_info.total_count=101;
        if(kind==='duplicate-project'&&u.searchParams.get('page')==='2')value.result[0].id=uuid(1);
        if(kind==='duplicate-name'&&u.searchParams.get('page')==='2')value.result[0].name='project-1';
        if(kind==='unsafe-name')value.result[0].name='../escape';
        if(kind==='missing-config')delete value.result[0].deployment_configs.preview;
        if(kind==='missing-script')delete value.result[0].preview_script_name;
        if(kind==='project-drift'&&n===1)value.result[0].uses_functions=true;
        if(kind==='config-drift'&&n===1)value.result[0].deployment_configs.production.env_vars.PRIVATE.value='CHANGED';
        if(kind==='http-error')return Response.json(value,{status:403});
        if(kind==='envelope-error')value.errors={};
        if(kind==='missing-result')delete value.result;
        if(kind==='mime')return new Response(JSON.stringify(value),{headers:{'Content-Type':'text/html'}});
        if(kind==='redirect')return {status:200,redirected:true,body:new ReadableStream(),headers:new Headers()};
        if(kind==='length')return Response.json(value,{headers:{'Content-Length':'1'}});
        if(kind==='utf8')return new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}});
      }
      if(path.includes('/project-1/deployments')){
        const row=value.result[0],second=u.searchParams.get('page')==='2';
        if(kind==='duplicate-deployment'&&second)row.id=uuid(101);
        if(kind==='cross-environment-duplicate'&&u.searchParams.get('env')==='preview')row.id=uuid(101);
        if(kind==='wrong-project-id')row.project_id=uuid(9);
        if(kind==='wrong-project-name')row.project_name='other';
        if(kind==='wrong-environment')row.environment='other';
        if(kind==='invalid-deployment-id')row.id='invalid';
        if(kind==='invalid-boolean')row.uses_functions='false';
        if(kind==='invalid-time')row.modified_on='bad\n';
        if(kind==='excess-deployments')value.result_info.total_count=5001;
        if(kind==='history-drift'&&n===1)row.env_vars.PRIVATE.value='CHANGED';
        if(second){
          if(kind==='binding-array')row.services=[];
          if(kind==='binding-scalar')row.services=false;
          if(kind==='too-many-bindings')row.services=Object.fromEntries(Array.from({length:1001},(_,i)=>['B'+i,{service:'other'}]));
          if(kind==='missing-service')delete row.services.RPC.service;
          if(kind==='missing-d1-id')delete row.d1_databases.DB.id;
          if(kind==='conflicting-d1-aliases')row.d1_databases.DB.database_id=uuid(8);
          if(kind==='conflicting-do-aliases')row.durable_object_namespaces.DO.script_name='other';
          if(kind==='unresolved-do-missing-id')delete row.durable_object_namespaces.UNKNOWN.namespace_id;
        }
      }
      return Response.json(value);
    });
    const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.historyCatalogueComplete,false);
    assert.equal(r.historicalBindingsComplete,false);assert.equal(r.fullPreflightPassed,false);assert.ok(fs.existsSync(resolve(f.dir,'result.json')));
  });
}
test('current configuration bindings are never substituted for absent history fields',async()=>{
  const f=setup();f.hook(({value,u})=>{if(u.pathname.endsWith('/deployments'))for(const row of value.result)for(const key of ['services','d1_databases','durable_object_namespaces'])delete row[key];return Response.json(value);});
  const r=await f.make().run();assert.equal(r.historyCatalogueComplete,true);assert.equal(r.edges.length,0);
  assert.deepEqual(r.fieldCoverage.d1_databases,{explicit:0,absentUnverified:16,nullUnverified:0,returnedEntries:0});assert.equal(r.historicalBindingsComplete,false);
});
test('null historical uses_functions remains unknown and never excludes bindings',async()=>{
  const f=setup();f.hook(({value,u})=>{if(u.pathname.endsWith('/deployments'))for(const row of value.result)row.uses_functions=null;return Response.json(value);});
  const r=await f.make().run();assert.equal(r.historyCatalogueComplete,true);assert.equal(r.deploymentCount,16);
  assert.ok(r.projects.every(p=>p.deployments.every(d=>d.usesFunctions===null)));assert.equal(r.edges.length,4);assert.equal(r.historicalBindingsComplete,false);
});
test('lifecycle metadata is projected and compared without promoting runtime absence',async()=>{
  const f=setup();f.hook(({value,u})=>{
    if(u.pathname.endsWith('/deployments'))for(const row of value.result){
      row.uses_functions=null;row.is_skipped=false;
      row.latest_stage={name:'build',status:'failure',started_on:'2026-01-01T00:00:00Z',ended_on:'2026-01-01T00:01:00Z'};
      row.stages=[{...row.latest_stage},{name:'deploy',status:'idle',started_on:null,ended_on:null}];
    }return Response.json(value);
  });
  const r=await f.make().run();assert.equal(r.historyCatalogueComplete,true);assert.equal(r.edges.length,4);
  for(const p of r.projects)for(const d of p.deployments){assert.equal(d.lifecycle.classification,'PRE_DEPLOY_TERMINAL_NO_DEPLOY_RECORDED');assert.equal(d.lifecycle.runtimeAbsenceProved,false);}
});
test('empty project inventory remains visibility-unverified',async()=>{
  const f=setup();f.hook(()=>Response.json(envelope([],1)));const r=await f.make().run();
  assert.equal(r.historyCatalogueComplete,true);assert.equal(r.deploymentCount,0);assert.equal(r.operations.length,2);assert.equal(r.visibilityScopeVerified,false);
});
test('empty pagination can report one total page',async()=>{
  const f=setup();f.hook(({value})=>{if(value.result_info.total_count===0)value.result_info.total_pages=1;return Response.json(value);});
  assert.equal((await f.make().run()).historyCatalogueComplete,true);
});
test('compressed dishonest Content-Length cannot bypass decoded body bound',async()=>{
  const f=setup();f.hook(()=>new Response(' '.repeat(2097153),{headers:{'Content-Type':'application/json','Content-Encoding':'gzip','Content-Length':'1'}}));
  assert.equal((await f.make().run()).historyCatalogueComplete,false);assert.equal(f.calls.length,1);
});
test('timeout cancels late noncooperative response without mutating terminal evidence',async()=>{
  let finish,cancelled=0;const f=setup({timeoutMs:20});f.hook(()=>new Promise(resolve=>{finish=resolve;}));
  const c=f.make(),r=await c.run(),log=fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8');assert.equal(r.result,'FAILED_RETAINED');
  finish(new Response(new ReadableStream({cancel(){cancelled++;}})));await tick();await tick();
  assert.equal(cancelled,1);assert.deepEqual(c.report(),r);assert.equal(fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8'),log);
});
test('caller abort bounds uncooperative fetch',async()=>{
  const ac=new AbortController(),f=setup({signal:ac.signal});f.hook(()=>new Promise(()=>{}));const p=f.make().run();await tick();ac.abort();assert.equal((await p).result,'FAILED_RETAINED');
});
test('pre-aborted request creates no reservation or traffic',async()=>{
  const f=setup({signal:AbortSignal.abort()});assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.dir),false);
});
test('existing reservation is never replayed',async()=>{
  const f=setup();await f.make().run();const before=fs.readFileSync(resolve(f.dir,'result.json')),count=f.calls.length;
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,count);assert.deepEqual(fs.readFileSync(resolve(f.dir,'result.json')),before);
});
test('symlinked parent is refused before traffic',async()=>{
  const f=setup(),target=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-pages-link-'));
  fs.symlinkSync(target,resolve(f.workspace,'.wrangler'),'junction');assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(target),[]);
});
test('invalid construction rejects before I/O',()=>{
  const f=setup();for(const change of [{apiToken:'bad\n'},{timeoutMs:600001},{timeoutMs:0},{fetchImpl:null}])assert.throws(()=>create({...f.opts,...change}));assert.equal(f.calls.length,0);
});
test('error persistence excludes raw exception text',async()=>{
  const f=setup();f.hook(()=>{throw new TypeError(secret+token,{cause:{code:'ECONNRESET',message:secret}});});const r=await f.make().run();
  assert.equal(r.operations[0].errorName,'TypeError');assert.equal(r.operations[0].errorCode,'ECONNRESET');
  const saved=fs.readFileSync(resolve(f.dir,'result.json'),'utf8');assert.ok(!saved.includes(token));assert.ok(!saved.includes(secret));
});
test('network concurrency never exceeds four',async()=>{
  let active=0,peak=0;const f=setup();f.hook(async()=>{active++;peak=Math.max(peak,active);await tick();active--;});
  const r=await f.make().run();assert.equal(r.historyCatalogueComplete,true);assert.equal(active,0);assert.equal(peak,4);
});
test('request and journal limits stop oversized catalogue without retries',async()=>{
  const f=setup();f.hook(({value,u})=>{
    if(u.pathname.endsWith('/deployments')){
      const n=Number(u.pathname.match(/\/project-(\d+)\/deployments$/)[1]),env=u.searchParams.get('env'),page=Number(u.searchParams.get('page'));
      const row=deployment(n,env==='production'?page:page+200,env);delete row.services;delete row.d1_databases;delete row.durable_object_namespaces;
      value={success:true,result:[row],result_info:{page,per_page:1,count:1,total_count:200,total_pages:200}};
    }
    return Response.json(value);
  });const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(f.calls.length,1000);assert.equal(r.automaticRetries,0);
  assert.equal(fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8').trim().split('\n').length,2002);
});
