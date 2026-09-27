import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const {createByokD1PagesWorkerVersions:create}=await import(process.env.BYOK_PAGES_WORKER_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_PAGES_WORKER_MODULE)).href:'./byok-d1-pages-worker-versions.mjs');
const token='synthetic-pages-worker-token',secret='PRIVATE-DO-NOT-PERSIST',a='/accounts/7ea8e46d8210bad342fa7595f7935fea';
const db='6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1',target='cinatoken-proxy-staging';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sha=v=>createHash('sha256').update(v).digest('hex');
const ok=(result,result_info)=>({success:true,errors:null,result,result_info});
const project=n=>({id:uuid(n),name:'project-'+n,uses_functions:false,subdomain:'custom-'+n+'.pages.dev',
  production_script_name:'pages-worker--'+n+'-production',preview_script_name:'pages-worker--'+n+'-preview',
  latest_deployment:{id:uuid(n*100)},deployment_configs:{production:{env_vars:{PRIVATE:{value:secret}}},preview:{}}});
const pagination=(rows,page,perPage=2)=>({page,per_page:perPage,count:rows.slice((page-1)*perPage,page*perPage).length,total_count:rows.length,total_pages:Math.ceil(rows.length/perPage)});
function setup(options={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-pages-worker-test-'));
  const dir=resolve(workspace,'.wrangler/staging/byok-d1-pages-worker-versions-reservation'),calls=[],counts=new Map();let hook;
  const opts={workspace,apiToken:token,fetchImpl:async(url,init)=>{
    const u=new URL(url),path=u.pathname.replace('/client/v4','')+u.search,page=Number(u.searchParams.get('page'));
    assert.equal(u.origin,'https://api.cloudflare.com');assert.equal(init.method,'GET');assert.equal(init.body,undefined);
    assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+token);
    assert.match(fs.readFileSync(resolve(dir,'journal.jsonl'),'utf8'),/PENDING/);
    const n=counts.get(path)??0;counts.set(path,n+1);calls.push(path);let value,status=200;
    if(u.pathname.endsWith('/pages/projects')){const rows=[1,2,3,4,5].map(project);value=ok(rows.slice((page-1)*2,page*2),pagination(rows,page));}
    else{
      const m=u.pathname.match(/\/workers\/scripts\/pages-worker--(\d+)-(production|preview)\/versions(?:\/(.+))?$/);assert.ok(m);
      const p=Number(m[1]),env=m[2],base=p*10000+(env==='preview'?1000:0);
      if(!m[3]){
        assert.equal(u.searchParams.get('per_page'),'100');
        const rows=(p===4&&env==='preview'?[]:[1,2,3]).map(i=>({id:uuid(base+i),number:i,metadata:{has_preview:false,private:secret}}));
        value=ok({items:rows.slice((page-1)*2,page*2)},pagination(rows,page));
        if(p===5&&env==='preview'){status=404;value={success:false,errors:[{code:10007,message:secret}],result:null};}
      }else{
        const index=Number(m[3].slice(-12))-base;
        value=ok({id:m[3],number:index,metadata:{private:secret},resources:{bindings:[
          {name:'PRIVATE',type:'plain_text',text:secret},{name:'SECRET',type:'secret_text'},
          {name:'CF_PAGES_URL',type:'plain_text',text:p===1&&env==='production'&&index===3?'https://abcdef12.custom-1.pages.dev/':'https://custom-'+p+'.pages.dev/'},
          ...(p===1&&env==='production'&&index===3?[
            {name:'DB',type:'d1',id:db,database_id:db},{name:'RPC',type:'service',service:target},
            {name:'DO',type:'durable_object_namespace',script_name:target,class_name:'Example'},
            {name:'UNRESOLVED',type:'durable_object_namespace',class_name:'Unknown'}]:[])
        ],script:{handlers:['fetch']}}});
      }
    }
    return await hook?.({value,path,u,n,status})??Response.json(value,{status});
  },...options};
  return {workspace,dir,calls,opts,make:()=>create(opts),hook:fn=>{hook=fn;}};
}
test('all Pages backing names and listed versions are read, without filtering static projects or preview flags',async()=>{
  const f=setup(),c=f.make(),p=c.run();assert.equal(c.run(),p);const r=await p;
  assert.equal(r.result,'LISTED_PAGES_WORKER_BINDINGS_OBSERVED_MAPPING_PENDING');assert.equal(r.listedVersionBindingsObserved,true);
  assert.equal(r.projects.length,5);assert.equal(r.scripts.length,10);assert.equal(r.versionCount,24);assert.ok(r.scripts.every(s=>s.stable));
  assert.equal(r.operations.length,66);assert.equal(r.operations.filter(o=>o.result==='ACK_NOT_FOUND_UNVERIFIED').length,2);
  assert.deepEqual(r.missingScripts,['pages-worker--5-preview']);assert.equal(r.scripts.find(s=>s.name==='pages-worker--4-preview').listedCount,0);
  assert.equal(r.edges.length,4);assert.deepEqual(r.edges.map(e=>e.kind).sort(),['pages-worker-d1','pages-worker-durable-object','pages-worker-service','pages-worker-unresolved-durable-object']);
  const last=r.scripts.find(s=>s.name==='pages-worker--1-production').versions.at(-1);
  assert.equal(last.urlAssociation.state,'SHORT_ID_CANDIDATE_ONLY');assert.equal(last.urlAssociation.shortId,'abcdef12');
  for(const key of ['historicalBindingsComplete','pagesDeploymentMappingComplete','allInvocationPathsInventoried','fullPreflightPassed','snapshotIsAtomic','visibilityScopeVerified'])assert.equal(r[key],false);
  const raw=fs.readFileSync(resolve(f.dir,'result.json'),'utf8'),log=fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8');
  for(const value of [token,secret,'https://abcdef12.custom-1.pages.dev/']){assert.ok(!raw.includes(value));assert.ok(!log.includes(value));}
  let previous='0'.repeat(64);const lines=log.trim().split('\n');assert.equal(lines.length,134);
  lines.forEach((line,i)=>{const {sha256,...row}=JSON.parse(line);assert.equal(row.sequence,i+1);assert.equal(row.previous,previous);assert.equal(sha(JSON.stringify(row)),sha256);previous=sha256;});
  r.edges.length=0;assert.equal(c.report().edges.length,4);
});
for(const kind of ['missing-project-pagination','project-duplicate','script-duplicate','unsafe-script','bad-subdomain','config-drift','root-drift',
  'missing-version-pagination','version-count','version-total','version-total-drift','duplicate-version','bad-preview-flag','conflicting-preview-aliases','catalogue-drift',
  'wrong-version','wrong-number','missing-bindings','duplicate-binding','conflicting-d1','missing-service','detail-404','forbidden',
  'invalid-not-found','not-found-drift','http-error','mime','length','utf8']){
  test('fails closed: '+kind,async()=>{
    const f=setup();f.hook(({value,u,n,status})=>{
      if(u.pathname.endsWith('/pages/projects')){
        if(kind==='missing-project-pagination')delete value.result_info;
        if(kind==='project-duplicate'&&u.searchParams.get('page')==='2')value.result[0].id=uuid(1);
        if(kind==='script-duplicate')value.result[0].preview_script_name=value.result[0].production_script_name;
        if(kind==='unsafe-script')value.result[0].production_script_name='../escape';
        if(kind==='bad-subdomain')value.result[0].subdomain='https://example.test/';
        if(kind==='config-drift'&&n===1)value.result[0].deployment_configs.production.extra='changed';
        if(kind==='root-drift'&&n===1)value.result[0].latest_deployment.id=uuid(99);
        if(kind==='http-error')return Response.json(value,{status:403});
        if(kind==='mime')return new Response(JSON.stringify(value),{headers:{'Content-Type':'text/html'}});
        if(kind==='length')return Response.json(value,{headers:{'Content-Length':'1'}});
        if(kind==='utf8')return new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}});
      }
      if(u.pathname.endsWith('/pages-worker--1-production/versions')){
        if(kind==='missing-version-pagination')delete value.result_info;
        if(kind==='version-count')value.result_info.count=0;
        if(kind==='version-total')value.result_info.total_count=501;
        if(kind==='version-total-drift'&&u.searchParams.get('page')==='2')value.result_info.total_count=4;
        if(kind==='duplicate-version'&&u.searchParams.get('page')==='2')value.result.items[0].id=uuid(10001);
        if(kind==='bad-preview-flag')value.result.items[0].metadata.has_preview='false';
        if(kind==='conflicting-preview-aliases')value.result.items[0].metadata.hasPreview=true;
        if(kind==='catalogue-drift'&&n===1)value.result.items[0].metadata.private='changed';
        if(kind==='forbidden')return Response.json({success:false,errors:[{code:10000}],result:null},{status:403});
      }
      if(u.pathname.endsWith('/versions/'+uuid(10003))){
        if(kind==='wrong-version')value.result.id=uuid(99);
        if(kind==='wrong-number')value.result.number=99;
        if(kind==='missing-bindings')delete value.result.resources.bindings;
        if(kind==='duplicate-binding')value.result.resources.bindings[3].name='PRIVATE';
        if(kind==='conflicting-d1')value.result.resources.bindings[3].database_id=uuid(99);
        if(kind==='missing-service')delete value.result.resources.bindings[4].service;
        if(kind==='detail-404')return Response.json({success:false,errors:[{code:10007}],result:null},{status:404});
      }
      if(status===404){if(kind==='invalid-not-found')value.success=true;if(kind==='not-found-drift'&&n===1)value.errors[0].code=10090;}
      return Response.json(value,{status});
    });
    const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.listedVersionBindingsObserved,false);assert.equal(r.historicalBindingsComplete,false);
  });
}
test('404 on the second version page never counts as an absent script',async()=>{
  const f=setup();f.hook(({u})=>{if(u.pathname.endsWith('/pages-worker--1-production/versions')&&u.searchParams.get('page')==='2')return Response.json({success:false,errors:[{code:10007}],result:null},{status:404});});
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');
});
test('empty account catalogue remains scope unverified',async()=>{
  const f=setup();f.hook(()=>Response.json(ok([],{page:1,per_page:10,count:0,total_count:0,total_pages:0})));
  const r=await f.make().run();assert.equal(r.listedVersionBindingsObserved,true);assert.equal(r.scripts.length,0);assert.equal(r.visibilityScopeVerified,false);
});
test('only the actual project subdomain can supply an untrusted short-ID candidate',async()=>{
  const f=setup();f.hook(({value,u})=>{if(u.pathname.includes('/versions/'))value.result.resources.bindings[2].text='https://abcdef12.project-1.pages.dev/';return value.success?Response.json(value):undefined;});
  const r=await f.make().run();assert.equal(r.listedVersionBindingsObserved,true);assert.ok(r.scripts.every(s=>s.versions.every(v=>v.urlAssociation.state==='UNMATCHED')));
});
test('compressed dishonest body length cannot bypass the decoded bound',async()=>{
  const f=setup();f.hook(()=>new Response(' '.repeat(2097153),{headers:{'Content-Type':'application/json','Content-Encoding':'gzip','Content-Length':'1'}}));
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,1);
});
test('timeout cancels a late response without rewriting terminal evidence',async()=>{
  let finish,cancelled=0;const f=setup({timeoutMs:20});f.hook(()=>new Promise(resolve=>{finish=resolve;}));
  const c=f.make(),r=await c.run(),log=fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8');assert.equal(r.result,'FAILED_RETAINED');
  finish(new Response(new ReadableStream({cancel(){cancelled++;}})));await tick();await tick();assert.equal(cancelled,1);assert.deepEqual(c.report(),r);assert.equal(fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8'),log);
});
test('caller abort bounds a fetch that ignores signals',async()=>{
  const ac=new AbortController(),f=setup({signal:ac.signal});f.hook(()=>new Promise(()=>{}));const p=f.make().run();await tick();ac.abort();assert.equal((await p).result,'FAILED_RETAINED');
});
test('pre-aborted request creates no reservation',async()=>{
  const f=setup({signal:AbortSignal.abort()});assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.dir),false);
});
test('existing reservation is never replayed',async()=>{
  const f=setup();await f.make().run();const before=fs.readFileSync(resolve(f.dir,'result.json')),count=f.calls.length;
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,count);assert.deepEqual(fs.readFileSync(resolve(f.dir,'result.json')),before);
});
test('symlinked parent is refused',async()=>{
  const f=setup(),target=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-pages-worker-link-'));
  fs.symlinkSync(target,resolve(f.workspace,'.wrangler'),'junction');assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(target),[]);
});
test('invalid construction is rejected before I/O',()=>{
  const f=setup();for(const change of [{apiToken:'bad\n'},{timeoutMs:600001},{timeoutMs:0},{fetchImpl:null}])assert.throws(()=>create({...f.opts,...change}));assert.equal(f.calls.length,0);
});
test('error persistence never includes raw errors or secret values',async()=>{
  const f=setup();f.hook(()=>{throw new TypeError(token+secret,{cause:{code:'ECONNRESET'}});});const r=await f.make().run();
  assert.equal(r.operations[0].errorCode,'ECONNRESET');const raw=fs.readFileSync(resolve(f.dir,'result.json'),'utf8');assert.ok(!raw.includes(token));assert.ok(!raw.includes(secret));
});
test('fetch concurrency is bounded to four',async()=>{
  let active=0,peak=0;const f=setup();f.hook(async()=>{active++;peak=Math.max(peak,active);await tick();active--;});
  assert.equal((await f.make().run()).listedVersionBindingsObserved,true);assert.equal(active,0);assert.equal(peak,4);
});
test('large version sets stop at 1000 requests and retain 2002 journal records',async()=>{
  const f=setup();f.hook(({value,u,status})=>{
    if(u.pathname.endsWith('/versions')&&status===200){
      const m=u.pathname.match(/pages-worker--(\d+)-(production|preview)/),base=Number(m[1])*10000+(m[2]==='preview'?1000:0),page=Number(u.searchParams.get('page'));
      value.result.items=Array.from({length:100},(_,i)=>({id:uuid(base+(page-1)*100+i+1),number:(page-1)*100+i+1,metadata:{}}));
      value.result_info={page,per_page:100,count:100,total_count:500};
    }return Response.json(value,{status});
  });const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(f.calls.length,1000);assert.equal(r.automaticRetries,0);
  assert.equal(fs.readFileSync(resolve(f.dir,'journal.jsonl'),'utf8').trim().split('\n').length,2002);
});
