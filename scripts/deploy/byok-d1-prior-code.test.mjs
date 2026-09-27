import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const {createByokD1PriorCode:create}=await import(process.env.BYOK_PRIOR_CODE_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_PRIOR_CODE_MODULE)).href:new URL('./byok-d1-prior-code.mjs',import.meta.url).href);
const sha=v=>createHash('sha256').update(v).digest('hex'),names=['cinatoken-proxy-staging','cinatoken-staging-recovery-control','cinatoken-staging-usage-recovery'];
const secret='synthetic-credential-not-for-logs',code='export default {fetch(){return new Response("synthetic");}};';
function setup(options={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-prior-code-test-'));
  const settings={bindings:[]},calls=[],counts=new Map(),expected=names.map((name,i)=>({name,settingsSha256:sha(JSON.stringify(settings)),
    versionId:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),entrySha256:sha(code)}));let hook;
  const opts={workspace,expected,apiToken:secret,fetchImpl:async(url,init)=>{
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/7ea8e46d8210bad342fa7595f7935fea/workers/scripts/'));
    assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+secret);
    const path=new URL(url).pathname,n=counts.get(path)??0;counts.set(path,n+1);calls.push(path);
    const log=fs.readFileSync(resolve(workspace,'.wrangler/staging/byok-d1-prior-code-reservation/journal.jsonl'),'utf8');assert.match(log,/PENDING/);
    const altered=await hook?.(path,n,init);if(altered!==undefined)return altered;
    if(path.endsWith('/settings'))return Response.json({success:true,errors:null,result:settings});
    const w=expected.find(w=>path.includes('/'+w.name));assert.ok(w);
    if(path.endsWith('/deployments'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:w.versionId,percentage:100}]}]}});
    const form=new FormData();form.set('main.js',code);const r=new Response(form);r.headers.set('cf-entrypoint','main.js');return r;
  },...options};
  return {workspace,calls,expected,opts,setHook(fn){hook=fn;},make:()=>create(opts),directory:resolve(workspace,'.wrangler/staging/byok-d1-prior-code-reservation')};
}
test('three fixed targets archive complete exact bytes with pre/post version and settings checks, no replay',async()=>{
  const f=setup(),reader=f.make();assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
  const promise=reader.run();assert.equal(reader.run(),promise);const r=await promise;
  assert.equal(r.result,'CODE_OBSERVED_AND_ARCHIVED');assert.equal(r.codeComplete,true);assert.equal(r.fullPreflightPassed,false);assert.equal(r.restoreAuthorized,false);
  assert.equal(f.calls.length,15);assert.equal(r.workers.length,3);
  for(const w of r.workers){assert.equal(w.modules.length,1);assert.equal(fs.readFileSync(resolve(f.directory,w.modules[0].filename),'utf8'),code);}
  let previous='0'.repeat(64);for(const row of fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse)){
    const {sha256,...body}=row;assert.equal(row.previous,previous);assert.equal(sha(JSON.stringify(body)),sha256);previous=sha256;}
  assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8').includes(code));
  assert.equal((await f.make().run()).result,'FAILED_RETAINED');assert.equal(f.calls.length,15);
});
for(const kind of ['settings','version','split','post-settings','post-version','entry-hash','http','mime','body','truncated-multipart','extra-duplicate','length','api-errors','oversize'])test('failure retains evidence and never declares complete / '+kind,async()=>{
  const f=setup();if(kind==='entry-hash')f.expected[0].entrySha256='f'.repeat(64);
  f.setHook((path,n)=>{
    if(kind==='http')return new Response(null,{status:403});if(kind==='mime')return new Response('{}');
    if(kind==='body')return new Response(null,{headers:{'Content-Type':'application/json'}});
    if(kind==='api-errors')return Response.json({success:true,errors:[{message:secret}],result:{}});
    if(kind==='oversize')return new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'2097153'}});
    if((kind==='settings'||kind==='post-settings'&&n===1)&&path.endsWith('/settings'))return Response.json({success:true,result:{drift:true}});
    if((kind==='version'||kind==='post-version'&&n===1||kind==='split')&&path.endsWith('/deployments'))
      return Response.json({success:true,result:{deployments:[{versions:[{version_id:'00000000-0000-4000-8000-000000000099',percentage:kind==='split'?50:100}]}]}});
    if(names.some(name=>path.endsWith('/'+name))){
      if(kind==='truncated-multipart')return new Response('--boundary\r\nContent-Disposition: form-data; name="main.js"\r\n\r\n'+code,{headers:{'Content-Type':'multipart/form-data; boundary=boundary','cf-entrypoint':'main.js'}});
      if(kind==='extra-duplicate'){const form=new FormData();form.append('main.js',code);form.append('main.js',code);const r=new Response(form);r.headers.set('cf-entrypoint','main.js');return r;}
      if(kind==='length')return new Response(code,{headers:{'Content-Type':'application/javascript','Content-Length':'1'}});
    }
  });const r=await f.make().run();assert.equal(r.result,'FAILED_RETAINED');assert.equal(r.codeComplete,false);assert.ok(f.calls.length<=15);
  assert.ok(fs.existsSync(resolve(f.directory,'result.json')));assert.ok(!JSON.stringify(r).includes(secret));
});
test('extra non-entry module is archived too; known entry hash is not a whole-code claim',async()=>{
  const f=setup();f.setHook(path=>{if(names.some(n=>path.endsWith('/'+n))){const form=new FormData();form.set('main.js',code);form.set('extra.js','extra');const r=new Response(form);r.headers.set('cf-entrypoint','main.js');return r;}});
  const r=await f.make().run();assert.equal(r.codeComplete,true);assert.ok(r.workers.every(w=>w.modules.length===2));
});
test('timeout cancels late response without changing finished evidence',async()=>{
  const releases=[],f=setup({timeoutMs:20});f.setHook(()=>new Promise(resolve=>releases.push(resolve)));
  const reader=f.make(),r=await reader.run();assert.equal(r.codeComplete,false);const before=fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8');
  let cancelled=0;for(const done of releases)done(new Response(new ReadableStream({cancel(){cancelled++;}})));
  await tick();await tick();assert.equal(cancelled,releases.length);assert.equal(fs.readFileSync(resolve(f.directory,'journal.jsonl'),'utf8'),before);assert.deepEqual(reader.report(),r);
});
test('pre-aborted call creates no reservation or cloud traffic',async()=>{
  const f=setup({signal:AbortSignal.abort()});assert.equal((await f.make().run()).codeComplete,false);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
});
test('caller cancellation releases noncooperative reads and prevents archives',async()=>{
  const ac=new AbortController(),f=setup({signal:ac.signal});f.setHook(()=>new Promise(()=>{}));const pending=f.make().run();await tick();ac.abort();
  const r=await pending;assert.equal(r.codeComplete,false);assert.equal(r.workers.length,0);assert.equal(f.calls.length,3);
});
test('out of scope workers, invalid pinned identity and excessive deadline are rejected before I/O',()=>{
  const f=setup();for(const change of [{timeoutMs:60001},{apiToken:'x\n'},{expected:f.expected.slice(0,2)},
    {expected:f.expected.map((w,i)=>i? w:{...w,name:'production'})},{expected:f.expected.map(w=>({...w,settingsSha256:'bad'}))}])assert.throws(()=>create({...f.opts,...change}));
  assert.equal(f.calls.length,0);
});
test('linked evidence parent cannot redirect archives outside the reservation',async()=>{
  const f=setup(),other=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-prior-link-'));
  fs.symlinkSync(other,resolve(f.workspace,'.wrangler'),'junction');const r=await f.make().run();
  assert.equal(r.codeComplete,false);assert.equal(f.calls.length,0);assert.deepEqual(fs.readdirSync(other),[]);
});
test('existing module file is retained rather than overwritten',async()=>{
  const f=setup();let inserted=false;const name=names[0]+'-0.bin';f.setHook(()=>{if(!inserted){inserted=true;fs.writeFileSync(resolve(f.directory,name),'preserve',{flag:'wx'});}});
  assert.equal((await f.make().run()).codeComplete,false);assert.equal(fs.readFileSync(resolve(f.directory,name),'utf8'),'preserve');
});
