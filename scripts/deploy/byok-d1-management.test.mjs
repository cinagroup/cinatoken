import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {createByokD1OperatorJournal,inspectByokD1OperatorJournal} from './byok-d1-operator-journal.mjs';
import {createByokD1CaseDispatch} from './byok-d1-case-dispatch.mjs';
import {byokCleanupFixture} from '../../packages/proxy/scripts/staging/byok-d1-cleanup-fixture.mjs';
import {byokD1FenceInstallPlan,BYOK_D1_FENCE_KEY,BYOK_D1_FENCE_CLOSED} from '../../packages/proxy/scripts/staging/byok-d1-write-fence.ts';
import {BYOK_D1_CONTROL_KEY,handleByokD1OneShot} from '../../packages/proxy/scripts/staging/byok-d1-one-shot.ts';
import {BYOK_D1_MAINTENANCE_KEY} from '../../packages/proxy/scripts/staging/byok-d1-cleanup.ts';
import {runByokD1Maintenance} from '../../packages/proxy/scripts/staging/byok-d1-maintenance-host.ts';
const {createByokD1Management:create}=await import(process.env.BYOK_D1_MANAGEMENT_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_MANAGEMENT_MODULE)).href:new URL('./byok-d1-management.mjs',import.meta.url).href);
const hash=v=>createHash('sha256').update(v).digest('hex');
const token='a1'.repeat(32),maintenance='b1'.repeat(32),apiToken='SYNTHETIC-API-CREDENTIAL';
const url='https://api.cloudflare.com/client/v4/accounts/7ea8e46d8210bad342fa7595f7935fea/d1/database/6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1';
const response=result=>Response.json({success:true,errors:[],result});
async function setup(t,{installed=true,preflight=true,mutate,timeoutMs,io}={}){
  const fixture=byokCleanupFixture(),workspace=fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT??'.wrangler/staging','byok-management-test-'));
  const journal=createByokD1OperatorJournal(workspace,{runId:fixture.runId,candidateSha256:'a'.repeat(64),priorManifestSha256:'b'.repeat(64)},io?{io}:{});
  t.after(async()=>{journal.close();await fixture.close();});
  if(installed)await fixture.raw.batch(byokD1FenceInstallPlan(JSON.stringify(fixture.schema())).map(q=>fixture.raw.prepare(q.sql).bind(...q.params)));
  if(preflight){await journal.attempt('preflight',async()=>{});await journal.attempt('closure-before',async()=>{});}
  const calls=[];let ready=true;
  const fetchImpl=async(path,init)=>{
    assert.equal(path,init.method==='GET'?url:url+'/query');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
    assert.equal(init.headers.Authorization,'Bearer '+apiToken);assert.equal(init.signal.aborted,false);
    const state=inspectByokD1OperatorJournal(resolve(journal.directory,'journal.jsonl'));assert.ok(Object.values(state.attempts).includes('PENDING'));
    const body=init.body&&JSON.parse(init.body),qs=body?(body.batch??[body]):[];
    calls.push({path,method:init.method,queries:qs});
    const base=()=>{
      if(!body)return response({uuid:'6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1',name:'cinatoken-staging'});
      // Deliberately NO REST batch transaction simulation. All writes must be single statements.
      if(qs.some(q=>!/^(SELECT|PRAGMA)\b/.test(q.sql)))assert.equal(qs.length,1);
      try{return response(qs.map(q=>{
        const statement=fixture.db.prepare(q.sql),results=statement.all(...q.params);
        return {success:true,results,meta:{changes:37,rows_read:results.length,rows_written:/^(INSERT|UPDATE)\b/.test(q.sql)?1:0}};
      }));}catch{return Response.json({success:false,errors:[{message:apiToken}],result:[]});}
    };
    return mutate?mutate({path,init,qs,base,calls,fixture}):base();
  };
  const options={journal,apiToken,expectedSchemaSha256:hash(JSON.stringify(fixture.schema())),assertWriteReady:()=>ready,fetchImpl,...(timeoutMs?{timeoutMs}:{})};
  const adapter=create(options);
  const read=key=>fixture.db.prepare('SELECT value FROM system_config WHERE key=?').get(key)?.value;
  return {fixture,journal,workspace,calls,options,adapter,read,setReady:v=>{ready=v;}};
}
async function armed(f){await f.adapter.captureBaseline();const control=await f.adapter.arm(hash(token));await f.adapter.openFence();return control;}
async function completed(f){
  const control=await armed(f),tasks=[],ctx={waitUntil:p=>tasks.push(p)};
  const dispatch=createByokD1CaseDispatch({journal:f.journal,control,token,accessClientId:'synthetic',accessClientSecret:'synthetic',
    fetchImpl:(url,init)=>handleByokD1OneShot(new Request(url,init),f.fixture.raw,ctx)});
  for(let i=0;i<10;i++)await f.adapter.verifyCase(i,await dispatch.runNext());
  await dispatch.stop();await f.adapter.sealFence();await Promise.all(tasks);
  for(const step of ['close-gateway','close-access','open-controller-access','open-controller','closure-fresh'])await f.journal.attempt(step,async()=>{});
  const closure={assertFreshMaintenanceIngress:()=>({result:'MAINTENANCE_READY',knownIngressClosed:false,knownProducerIngressClosed:true,maintenanceOnlyConfigured:true,
    maintenance:{runId:f.fixture.runId,tokenId:'00000000-0000-4000-8000-000000000080'},databaseQuiescenceProved:false,
    evidenceSha256:'c'.repeat(64),finished:{wallAt:new Date().toISOString()}})};
  return {closure,dispatch};
}

test('fixed REST baseline -> single statement controls -> ten independent readbacks -> native cleanup primitive (SQLite only)',async t=>{
  const f=await setup(t),before=f.fixture.allRows(),{closure}=await completed(f);
  const permit=await f.adapter.armMaintenance({tokenHash:hash(maintenance),closure});assert.equal(permit.state,'ready');
  assert.equal(permit.expiresAt-permit.issuedAt,60);
  const tasks=[],result=await runByokD1Maintenance(f.fixture.raw,true,maintenance,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);
  assert.deepEqual(result,{status:'cleaned',runId:f.fixture.runId,removedRows:664,statementCount:143});
  const after=f.fixture.allRows();after.system_config=after.system_config.filter(r=>r.key!==BYOK_D1_MAINTENANCE_KEY);assert.deepEqual(after,before);
  const r=f.adapter.report();assert.equal(r.mutationsAttempted,4);assert.equal(r.httpAttempts,r.httpAcknowledged);
  assert.equal(r.nativeAcceptanceProved,false);assert.equal(r.automaticRetries,0);
  assert.ok(f.calls.every(c=>c.queries.every(q=>!/^(DELETE|CREATE|DROP|ALTER|REPLACE|BEGIN|COMMIT)\b/.test(q.sql))));
  assert.deepEqual(Object.keys(f.adapter).sort(),['arm','armMaintenance','captureBaseline','openFence','report','sealFence','verifyCase','verifyFinal']);
  const journal=fs.readFileSync(resolve(f.journal.directory,'journal.jsonl'),'utf8');
  for(const secret of [apiToken,token,maintenance,'Authorization'])assert.ok(!journal.includes(secret)&&!JSON.stringify(r).includes(secret));
  assert.equal(inspectByokD1OperatorJournal(resolve(f.journal.directory,'journal.jsonl')).attempts['arm-maintenance'],'ACK');
});
test('constructor rejects extra scope, unsafe credentials and invalid guards before any I/O',async t=>{
  const f=await setup(t);
  for(const change of [{account:'production'},{database:'production'},{baseUrl:'https://untrusted.invalid'},
    {apiToken:apiToken+'\n'},{timeoutMs:60001},{expectedSchemaSha256:'bad'},{assertWriteReady:null}])
    assert.throws(()=>create({...f.options,...change}),/^Error: byok_management_options$/);
  assert.equal(f.calls.length,0);
});
test('full preflight and closed ingress journal ACKs are prerequisites even for baseline',async t=>{
  const f=await setup(t,{preflight:false});await assert.rejects(f.adapter.captureBaseline());assert.equal(f.calls.length,0);
});
test('native fence must already be installed: baseline never installs missing triggers',async t=>{
  const f=await setup(t,{installed:false});await assert.rejects(f.adapter.captureBaseline());assert.equal(f.adapter.report().mutationsAttempted,0);
  assert.equal(f.read(BYOK_D1_FENCE_KEY),undefined);
});
test('guard denial cannot send a write',async t=>{
  const f=await setup(t);await f.adapter.captureBaseline();f.setReady(false);await assert.rejects(f.adapter.arm(hash(token)));
  assert.equal(f.adapter.report().mutationsAttempted,0);assert.equal(f.read(BYOK_D1_CONTROL_KEY),undefined);
});
test('missing baseline and cross-instance reuse cannot arm',async t=>{
  const f=await setup(t);await f.adapter.captureBaseline();await assert.rejects(create(f.options).arm(hash(token)));
  assert.equal(f.adapter.report().mutationsAttempted,0);
});
for(const mode of ['identity','name','http','redirect','mime','envelope','errors','json','utf8','length','too-large','tiny-chunks'])
test('bounded sanitized REST rejection / '+mode,async t=>{
  let cancelled=0,pulls=0;
  const f=await setup(t,{mutate:async({base})=>{
    if(mode==='http')return new Response(apiToken,{status:500});if(mode==='redirect')return new Response(null,{status:302});
    if(mode==='tiny-chunks')return new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},
      {highWaterMark:0}),{headers:{'Content-Type':'application/json'}});
    if(mode==='too-large')return new Response(' '.repeat(2097153),{headers:{'Content-Type':'application/json'}});
    if(mode==='json'||mode==='utf8')return new Response(mode==='json'?'{':new Uint8Array([255]),{headers:{'Content-Type':'application/json'}});
    const r=base(),v=await r.json();
    if(mode==='identity')v.result.uuid='f7588b56-e761-49fc-b944-4cd7d121fc21';if(mode==='name')v.result.name='production';
    if(mode==='envelope')v.success=false;if(mode==='errors')v.errors=[{message:apiToken}];
    const output=Response.json(v);if(mode==='mime')output.headers.set('Content-Type','text/html');if(mode==='length')output.headers.set('Content-Length','1');return output;
  }});
  await assert.rejects(f.adapter.captureBaseline(),/^Error: byok_management_unconfirmed$/);await assert.rejects(f.adapter.captureBaseline());
  assert.equal(f.calls.length,1);assert.ok(!JSON.stringify(f.adapter.report()).includes(apiToken));
  if(mode==='tiny-chunks'){await tick();assert.equal(pulls,4096);assert.equal(cancelled,1);}
});
for(const mode of ['missing-meta','missing-result','batch-count','read-reports-write'])test('query response contract / '+mode,async t=>{
  const f=await setup(t,{mutate:async({base,qs})=>{
    const r=base();if(!qs.length)return r;const v=await r.json();
    if(mode==='missing-meta')delete v.result[0].meta;if(mode==='missing-result')delete v.result[0].results;
    if(mode==='batch-count')v.result=[];if(mode==='read-reports-write')v.result[0].meta.rows_written=1;return Response.json(v);
  }});await assert.rejects(f.adapter.captureBaseline());assert.equal(f.adapter.report().mutationsAttempted,0);
});
for(const mode of ['foreign-row','schema-drift','existing-control'])test('arm SQL guard fails closed atomically / '+mode,async t=>{
  const f=await setup(t);await f.adapter.captureBaseline();
  if(mode==='foreign-row')f.fixture.db.exec("INSERT INTO system_config(key,value) VALUES('foreign','x')");
  if(mode==='schema-drift')f.fixture.db.exec('CREATE TABLE unexpected(id TEXT)');
  if(mode==='existing-control')f.fixture.arm();
  const before=f.read(BYOK_D1_CONTROL_KEY);await assert.rejects(f.adapter.arm(hash(token)));assert.equal(f.read(BYOK_D1_CONTROL_KEY),before);
  assert.equal(f.read(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
});
for(const mode of ['lost-ack','readback-drift','returning-missing'])test('committed write with unknown acknowledgement is never replayed / '+mode,async t=>{
  let injected=false;
  const f=await setup(t,{mutate:async({qs,base,fixture})=>{
    const r=base();if(qs[0]?.sql.startsWith('INSERT')&&!injected){injected=true;
      if(mode==='lost-ack')throw Error(apiToken);
      if(mode==='readback-drift')fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',BYOK_D1_CONTROL_KEY);
      if(mode==='returning-missing'){const v=await r.json();v.result[0].results=[];return Response.json(v);}
    }return r;
  }});
  await f.adapter.captureBaseline();await assert.rejects(f.adapter.arm(hash(token)));const count=f.calls.length;
  await assert.rejects(f.adapter.arm(hash(token)));await assert.rejects(create(f.options).arm(hash(token)));await assert.rejects(f.adapter.openFence());
  assert.equal(f.calls.length,count);assert.notEqual(f.read(BYOK_D1_CONTROL_KEY),undefined);assert.equal(f.adapter.report().mutationsAttempted,1);
});
test('sealing is allowed after unknown STOP ACK but never authorizes maintenance or reopening',async t=>{
  const f=await setup(t);await armed(f);
  await assert.rejects(f.journal.attempt('stop',async()=>{
    const c=JSON.parse(f.read(BYOK_D1_CONTROL_KEY));c.state='stopped';
    f.fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify(c),BYOK_D1_CONTROL_KEY);throw Error('ACK lost');
  }));
  assert.equal((await f.adapter.sealFence()).state,'closed');assert.equal(f.read(BYOK_D1_FENCE_KEY),BYOK_D1_FENCE_CLOSED);
  const count=f.calls.length;await assert.rejects(f.adapter.sealFence());await assert.rejects(f.adapter.openFence());
  await assert.rejects(f.adapter.armMaintenance({tokenHash:hash(maintenance),closure:{}}));assert.equal(f.calls.length,count);
});
test('sealing checks durable stopped state and does not close another run',async t=>{
  const f=await setup(t);await armed(f);await assert.rejects(f.adapter.sealFence());assert.match(f.read(BYOK_D1_FENCE_KEY),/open/);
});
test('independent case readback rejects mismatched HTTP receipt',async t=>{
  const f=await setup(t);await armed(f);await f.journal.attempt('case-0',async()=>{});
  await assert.rejects(f.adapter.verifyCase(0,{forged:true}));assert.equal(f.journal.snapshot().poisoned,true);
});
for(const mode of ['stale','future','schema','control','fence','existing-permit'])test('maintenance single-statement guards / '+mode,async t=>{
  const f=await setup(t),{closure}=await completed(f);
  if(mode==='stale'||mode==='future'){const original=closure.assertFreshMaintenanceIngress;closure.assertFreshMaintenanceIngress=()=>{
    const v=original();v.finished.wallAt=new Date(Date.now()+(mode==='stale'?-20000:20000)).toISOString();return v;
  };}
  if(mode==='schema')f.fixture.db.exec('CREATE TABLE unexpected(id TEXT)');
  if(mode==='control')f.fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',BYOK_D1_CONTROL_KEY);
  if(mode==='fence')f.fixture.db.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',BYOK_D1_FENCE_KEY);
  if(mode==='existing-permit')f.fixture.db.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run(BYOK_D1_MAINTENANCE_KEY,'{}');
  await assert.rejects(f.adapter.armMaintenance({tokenHash:hash(maintenance),closure}));
  assert.equal(f.read(BYOK_D1_MAINTENANCE_KEY),mode==='existing-permit'?'{}':undefined);
});
for(const mode of ['all-closed','producer-open','maintenance-absent','wrong-run'])test('maintenance permit requires explicit prepared-only ingress proof / '+mode,async t=>{
  const f=await setup(t),{closure}=await completed(f),original=closure.assertFreshMaintenanceIngress;
  closure.assertFreshMaintenanceIngress=()=>{const r=original();if(mode==='all-closed'){r.result='CLOSED';r.knownIngressClosed=true;}
    if(mode==='producer-open')r.knownProducerIngressClosed=false;if(mode==='maintenance-absent')r.maintenanceOnlyConfigured=false;
    if(mode==='wrong-run')r.maintenance.runId='c02-byok-ffffffffffff';return r;};
  const before=f.calls.length;await assert.rejects(f.adapter.armMaintenance({tokenHash:hash(maintenance),closure}));
  assert.equal(f.calls.length,before);assert.equal(f.read(BYOK_D1_MAINTENANCE_KEY),undefined);
});
test('host deadline cancels late response body without retry',async t=>{
  let resolveResponse,cancelled=0;
  const f=await setup(t,{timeoutMs:10,mutate:()=>new Promise(r=>{resolveResponse=r;})});
  await assert.rejects(f.adapter.captureBaseline());resolveResponse(new Response(new ReadableStream({cancel(){cancelled++;}})));
  await tick();assert.equal(cancelled,1);assert.equal(f.calls.length,1);await assert.rejects(f.adapter.captureBaseline());assert.equal(f.calls.length,1);
});
test('concurrent operations cannot race control creation',async t=>{
  let release,entered;const inside=new Promise(r=>{entered=r;});
  const f=await setup(t,{mutate:async({base,qs})=>{if(!qs.length){entered();await new Promise(r=>{release=r;});}return base();}});
  const pending=f.adapter.captureBaseline();await inside;await assert.rejects(f.adapter.arm(hash(token)),/^Error: byok_management_busy$/);
  release();await pending;assert.equal(f.read(BYOK_D1_CONTROL_KEY),undefined);
});
test('monotonic deadline rejects synchronous work that delays the timer callback',async t=>{
  const f=await setup(t,{timeoutMs:10,mutate:({base})=>{
    const until=performance.now()+25;while(performance.now()<until){/* simulate a blocked event loop */}return base();
  }});
  await assert.rejects(f.adapter.captureBaseline());assert.equal(f.calls.length,1);
  assert.equal(f.adapter.report().httpAcknowledged,0);assert.equal(f.adapter.report().mutationsAttempted,0);
});
