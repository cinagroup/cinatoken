import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {createByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
const {createByokD1ReadTransport:create}=await import(process.env.BYOK_D1_READ_TRANSPORT_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_READ_TRANSPORT_MODULE)).href:new URL('./byok-d1-read-transport.mjs',import.meta.url).href);
const apiToken='synthetic-private-read-credential',path='/d1/database/'+g.database;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const digest=v=>createHash('sha256').update(v).digest('hex');
const response=(result={uuid:g.database,name:'cinatoken-staging'})=>Response.json({success:true,errors:[],result});
function setup(t,{fetchImpl,timeoutMs,io}={}){
  const workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-read-test-'));
  const journal=createByokD1OperatorJournal(workspace,{runId:'c02-byok-a1b2c3d4e5f6',candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)});
  const calls=[],options={journal,apiToken,fetchImpl:async(url,init)=>{
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+g.account+'/'));
    assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
    assert.equal(init.headers.Authorization,'Bearer '+apiToken);calls.push(url);
    const rows=fs.readFileSync(resolve(journal.directory,'observations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(r=>r.event==='PENDING'));return fetchImpl?fetchImpl(url,init):response();
  },...(timeoutMs?{timeoutMs}:{}),...(io?{io}:{})};
  const transport=create(options);
  t.after(async()=>{await transport.settle();transport.close();journal.close();});
  return {transport,journal,calls,options,log:()=>fs.readFileSync(resolve(journal.directory,'observations.jsonl'),'utf8')};
}
test('GET-only, separately durable and metered, with no secret or raw body in log',async t=>{
  const f=setup(t,{fetchImpl:()=>response({private:apiToken})});assert.deepEqual(await f.transport.api(path),{private:apiToken});
  const r=f.transport.report();assert.equal(r.httpAttempts,1);assert.equal(r.httpAcknowledged,1);assert.equal(r.journalRecords,3);
  assert.equal(f.journal.snapshot().sequence,1);assert.ok(!f.log().includes(apiToken));let previous='0'.repeat(64);
  for(const [i,row] of f.log().trim().split('\n').map(JSON.parse).entries()){
    const {sha256,...body}=row;assert.equal(row.sequence,i+1);assert.equal(row.previous,previous);assert.equal(sha256,digest(JSON.stringify(body)));previous=sha256;
  }
  assert.equal(r.journalSha256,previous);assert.equal(r.cloudMutationAttempted,false);
  assert.deepEqual(Object.keys(f.transport).sort(),['api','close','report','settle']);
});
for(const name of ['c02-byok-a1b2c3d4e5f6-access',undefined,'',7,'x'.repeat(1025)])test('service token name is bounded, optional and does not expose other credential fields / '+typeof name+' '+String(name).length,async t=>{
  const f=setup(t,{fetchImpl:()=>Response.json({success:true,result:[{id:id(1),...(name===undefined?{}:{name}),client_secret:apiToken}],
    result_info:{page:1,per_page:1000,count:1,total_count:1,total_pages:1}})});
  if(name===undefined||typeof name==='string'&&name.length>0&&name.length<=1024){const r=await f.transport.api('/access/service_tokens');
    assert.deepEqual(r,[{id:id(1),...(name===undefined?{}:{name})}]);}
  else await assert.rejects(f.transport.api('/access/service_tokens'));
  assert.ok(!f.log().includes(apiToken));
});
for(const [target,method,body] of [['https://example.invalid','GET'],['/d1/database/f7588b56-e761-49fc-b944-4cd7d121fc21','GET'],
  [path+'/query','POST',{sql:'SELECT 1'}],[path,'DELETE'],[path,'GET',{}],['/billable-usage','GET'],
  ['/workers/scripts/'+g.worker+'/content/v2','GET'],['/access/service_tokens?page=1','GET'],['/workers/scripts/production-other/settings','GET']])
test('reject outside scope before logging or sending / '+target+' '+method,async t=>{
  const f=setup(t);await assert.rejects(f.transport.api(target,method,body),/^Error: byok_read_rejected$/);
  assert.equal(f.calls.length,0);assert.equal(f.transport.report().journalRecords,1);
});
for(const errors of [undefined,null,[]])test('successful envelope accepts only absence/null/empty errors / '+JSON.stringify(errors),async t=>{
  const f=setup(t,{fetchImpl:()=>Response.json({success:true,errors,result:[]})});
  assert.deepEqual(await f.transport.api('/workers/domains?service='+g.worker),[]);
  assert.equal(f.transport.report().httpAcknowledged,1);assert.equal(f.transport.report().poisoned,false);
});
for(const kind of ['status','redirect','mime','json','utf8','envelope','errors','errors-false','errors-string','errors-object','errors-null-item','missing-result','length','oversize','empty-chunks'])
test('bounded response failures are terminal / '+kind,async t=>{
  let cancelled=0,pulls=0;
  const f=setup(t,{fetchImpl:()=>{
    if(kind==='status')return new Response(apiToken,{status:500});if(kind==='redirect')return new Response(null,{status:302});
    if(kind==='mime')return new Response('{}',{headers:{'Content-Type':'text/html'}});
    if(kind==='json'||kind==='utf8')return new Response(kind==='json'?'{':new Uint8Array([255]),{headers:{'Content-Type':'application/json'}});
    if(kind==='envelope')return Response.json({success:false,result:[]});if(kind==='errors')return Response.json({success:true,errors:[apiToken],result:[]});
    const malformed={'errors-false':false,'errors-string':'','errors-object':{},'errors-null-item':[null]};
    if(Object.hasOwn(malformed,kind))return Response.json({success:true,errors:malformed[kind],result:[]});
    if(kind==='missing-result')return Response.json({success:true,errors:[]});
    if(kind==='length'){const r=response();r.headers.set('Content-Length','1');return r;}
    if(kind==='oversize')return new Response('x'.repeat(2097153),{headers:{'Content-Type':'application/json'}});
    return new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{'Content-Type':'application/json'}});
  }});
  await assert.rejects(f.transport.api(path),/^Error: byok_read_unconfirmed$/);await assert.rejects(f.transport.api(path));
  assert.equal(f.calls.length,1);assert.equal(f.transport.report().poisoned,true);assert.ok(!f.log().includes(apiToken));
  if(kind==='empty-chunks'){await tick();assert.equal(pulls,4096);assert.equal(cancelled,1);}
});
function pageResponse(url,mode){
  const page=Number(new URL(url).searchParams.get('page')),total=mode==='empty'?0:1001;
  const rows=Array.from({length:Math.min(1000,total-(page-1)*1000)},(_,i)=>({id:id(1000*(page-1)+i+1),client_id:'private-id'}));
  const info={page,per_page:1000,count:rows.length,total_count:total,total_pages:total?2:0};
  if(mode==='missing')return Response.json({success:true,result:rows});
  if(mode==='count')info.count++;if(mode==='page')info.page++;if(mode==='per-page')info.per_page=999;
  if(mode==='too-many')info.total_count=20001;if(mode==='page-count')info.total_pages=3;
  if(page===2){if(mode==='drift')info.total_count=1002;if(mode==='duplicate')rows[0].id=id(1);if(mode==='invalid-id')rows[0].id='bad';}
  return Response.json({success:true,errors:[],result:rows,result_info:info});
}
for(const mode of ['ok','empty','missing','count','page','per-page','too-many','page-count','drift','duplicate','invalid-id'])
test('complete consistent pagination and projected IDs / '+mode,async t=>{
  const f=setup(t,{fetchImpl:url=>pageResponse(url,mode)});
  if(mode==='ok'||mode==='empty'){
    const v=await f.transport.api('/access/service_tokens');assert.equal(v.length,mode==='ok'?1001:0);
    assert.ok(v.every(r=>Object.keys(r).join(',')==='id'));assert.equal(f.calls.length,mode==='ok'?2:1);
  }else{await assert.rejects(f.transport.api('/access/service_tokens'));assert.equal(f.transport.report().poisoned,true);}
  assert.ok(!f.log().includes('private-id'));
});
test('fixed concurrency ceiling and settlement before close',async t=>{
  const releases=[];const f=setup(t,{fetchImpl:()=>new Promise(r=>releases.push(()=>r(response())))});
  const pending=Array.from({length:4},()=>f.transport.api(path));await tick();assert.equal(f.calls.length,4);
  assert.throws(()=>f.transport.close());await assert.rejects(f.transport.api(path));assert.equal(f.calls.length,4);
  for(const release of releases)release();await Promise.all(pending);await f.transport.settle();assert.equal(f.transport.report().peakActive,4);
});
test('failed read aborts and settles peer logical calls without waiting for noncooperative fetch',{timeout:5000},async t=>{
  // Four durable PENDING writes must finish before testing failure of an admitted fetch.
  let fail;const f=setup(t,{timeoutMs:1000,fetchImpl:()=>new Promise((_,reject)=>{fail??=reject;})});
  const pending=Array.from({length:4},()=>f.transport.api(path));await tick();fail(Error(apiToken));
  assert.ok((await Promise.allSettled(pending)).every(r=>r.status==='rejected'));await f.transport.settle();
  assert.equal(f.transport.report().active,0);assert.equal(f.transport.report().httpAttempts,4);assert.equal(f.transport.report().remoteReadsDrained,false);
});
test('timeout is not replayable and late body is cancelled without modifying closed evidence',{timeout:5000},async t=>{
  // Allow durable PENDING persistence before exercising the hung fetch.
  let release,cancelled=0;const f=setup(t,{timeoutMs:1000,fetchImpl:()=>new Promise(r=>release=r)});
  await assert.rejects(f.transport.api(path));await f.transport.settle();f.transport.close();const before=f.log(),report=f.transport.report();
  release(new Response(new ReadableStream({cancel(){cancelled++;}})));await tick();await tick();
  assert.equal(cancelled,1);assert.equal(f.log(),before);assert.deepEqual(f.transport.report(),report);
});
test('pre-abort is zero I/O and missing pending fsync prevents network admission',async t=>{
  let fail=false;const f=setup(t,{io:{...fs,fsyncSync(fd){if(fail)throw Error('injected');fs.fsyncSync(fd);}}});
  const ac=new AbortController();ac.abort();await assert.rejects(f.transport.api(path,'GET',undefined,{signal:ac.signal}));assert.equal(f.calls.length,0);
  fail=true;await assert.rejects(f.transport.api(path));assert.equal(f.calls.length,0);assert.equal(f.transport.report().journalFailed,true);
});
test('cannot reopen observation file through a fresh object',t=>{
  const f=setup(t);assert.throws(()=>create(f.options));assert.equal(f.calls.length,0);
});
test('physical requests have a fixed cap including pagination',async t=>{
  const f=setup(t);for(let i=0;i<320;i++)await f.transport.api(path);
  await assert.rejects(f.transport.api(path));assert.equal(f.calls.length,320);assert.equal(f.transport.report().journalRecords,641);
});
for(const flush of ['pending','ack'])test('monotonic admission rejects stale persistence without widening deadlines / '+flush,async t=>{
  let count=0;const now=performance.now.bind(performance);
  const f=setup(t,{io:{...fs,fsyncSync(fd){fs.fsyncSync(fd);if(++count===(flush==='pending'?2:3))t.mock.method(performance,'now',()=>now()+21000);}}});
  await assert.rejects(f.transport.api(path));await f.transport.settle();
  assert.equal(f.calls.length,flush==='pending'?0:1);assert.equal(f.transport.report().poisoned,true);
  const last=JSON.parse(f.log().trim().split('\n').at(-1));assert.equal(last.failure,'deadline');assert.ok(last.elapsedMs>=21000);
  assert.ok(last[flush==='pending'?'pendingPersistMs':'ackPersistMs']>=21000);
});
