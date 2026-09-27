import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {imageSseRow,imageSsePrompt} from './images-sse-probe-contract.ts';
import {sseSnapshotFaultRow,SSE_SNAPSHOT_FAULT_MODES} from './images-sse-snapshot-fault-v2.ts';
import {createImagesSseSnapshotStagingGateway,SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';
import upstream from './images-sse-window-upstream.ts';
import {reconcileSnapshotSseStagingRun,snapshotSseCleanupStatements,snapshotSseCleanupNotBefore} from '../../../../scripts/deploy/staging-sse-snapshot-reconciliation-v2.mjs';
import {SSE_STAGING_SCOPE} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';

import {sqliteTotalChangesBinding} from './sqlite-total-changes-binding.mjs';

async function setup(t){
  const db=createSqliteD1(),tasks=[],controllers=[],key='synthetic-snapshot-client-'+randomUUID(),saved=[],apiCalls=[];
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const counts=()=>Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>{assert.match(name,/^[a-z][a-z0-9_]*$/);return [name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n];}));
  // A second, unrelated fixture must remain byte-for-byte unchanged throughout reconciliation.
  const other=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+'b'.repeat(64),new Date(Date.now()+3600000).toISOString());
  for(const s of other.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const otherRows=()=>['users','workspaces','api_keys','models','providers','model_routes','model_endpoints'].map(table=>
    db.sqlite.prepare(`SELECT * FROM ${table} WHERE id LIKE ? ORDER BY id`).all(other.ids.runId+'%').map(r=>({...r})));
  const unrelated=otherRows(),baseline=counts();
  const keyHash='sha256:'+createHash('sha256').update(key).digest('hex'),expiresAt=new Date(Date.now()+3600000).toISOString();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),keyHash,expiresAt);
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const journal={runId:fixture.ids.runId,keyHash,expiresAt,requests:[],probes:[]};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  let sends=0;
  const app=createImagesSseSnapshotStagingGateway((input,init)=>{
    sends++;assert.equal(new Headers(init.headers).has(SSE_SNAPSHOT_HEADER),false);
    return upstream.fetch(new Request(input,init),{PROBE_DB:db.binding},context);
  });
  const env={DB:sqliteTotalChangesBinding(db),DATABASE_DRIVER:'d1',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-material-not-for-real-secrets',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false'};
  const storage=await resolveWorkerStorageFromBindings(env);
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:6,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  const release=probeId=>{
    const row=db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_snapshot:'+probeId);
    if(!row)return;const v=JSON.parse(row.value);
    if(!['held-before-insert','held-after-insert'].includes(v.phase))return;
    assert.equal(db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=? AND value=?').run(JSON.stringify({...v,phase:'release-requested'}),'c02_sse_snapshot:'+probeId,row.value).changes,1);
  };
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i];await drainNodeBackgroundWork();};
  t.after(async()=>{for(const r of journal.requests)release(r.probeId);for(const c of controllers)c.abort();await Promise.allSettled(tasks);await drainNodeBackgroundWork();db.sqlite.close();});
  const api=async(path,method)=>{
    apiCalls.push({path,method:method??'GET'});assert.ok(!method||method==='GET','Closed Access mock must not hide unexpected writes');
    const s=SSE_STAGING_SCOPE;
    if(path===`/workers/scripts/${s.worker}/subdomain`)return {enabled:false,previews_enabled:false};
    if(path===`/access/apps/${s.app}`)return {id:s.app,type:'self_hosted',domain:s.domain,aud:s.audience,destinations:[{type:'public',uri:s.domain}],
      policies:[{id:s.policy,name:'CinaToken staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]};
    if(path===`/d1/database/${s.database}`)return {uuid:s.database,name:'cinatoken-staging'};
    assert.fail('Unexpected account path '+path);
  };
  const batch=async statements=>{
    assert.ok(statements.length<=256&&statements.every(s=>s.params.length<=100&&Buffer.byteLength(s.sql)<=100000));
    return (await db.binding.batch(statements.map(s=>db.binding.prepare(s.sql).bind(...s.params)))).map(r=>r.results);
  };
  const options=()=>({api,batch,journal,nowMs:Date.now()+360000,persist:async e=>saved.push(structuredClone(e))});
  const run=async(mode,{recoverAfter=true,timeout=false,omitHeader=false,headerOverride}={})=>{
    const p={runId:journal.runId,probeId:randomUUID(),mode},u={runId:journal.runId,probeId:randomUUID(),mode:'success'};
    for(const row of [sseSnapshotFaultRow(p),imageSseRow(u)])db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
    const controller=new AbortController();controllers.push(controller);
    const startedAt=new Date().toISOString();
    const request=new Request('https://example.invalid/v1/images/generations',{method:'POST',signal:controller.signal,
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...(!omitHeader?{[SSE_SNAPSHOT_HEADER]:headerOverride??`c02-snapshot:${p.runId}:${p.probeId}:${mode}`}:{})},
      body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:imageSsePrompt(u),stream:true})});
    const response=await app.fetch(request,env,context);assert.equal(response.status,200);
    const id=response.headers.get('X-Generation-Id'),entry={id,mode,probeId:p.probeId,upstreamProbeId:u.probeId,startedAt,headersAt:new Date().toISOString()};
    journal.requests.push(entry);journal.probes.push(u);
    const reading=response.text();
    if(mode.endsWith('hold')&&!timeout){
      let reached=false;
      for(let n=0;n<1000;n++){
        const value=JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_snapshot:'+p.probeId).value);
        if(value.phase=== (mode==='before-hold'?'held-before-insert':'held-after-insert')){reached=true;break;}await delay(5);
      }
      assert.ok(reached);release(p.probeId);
    }
    const wire=await reading;entry.finishedAt=new Date().toISOString();await drain();
    assert.match(wire,/image_generation.completed/);assert.equal((wire.match(/data: \[DONE\]/g)||[]).length,1);
    const unknown=mode==='before-fail'||(mode==='before-hold'&&timeout),error=unknown||mode==='snapshot-read-fail'||mode==='job-read-fail'||timeout;
    if(error){assert.match(wire,/gateway.image_settlement_unconfirmed/);assert.match(wire,/"retry_safe":false/);}else assert.doesNotMatch(wire,/"type":"error"/);
    if(recoverAfter)await recover();
    const log=db.sqlite.prepare('SELECT status,charged_cost,upstream_attempt_count FROM api_key_request_logs WHERE id=?').get(id);
    if(unknown||(!recoverAfter&&['snapshot-read-fail','job-read-fail'].includes(mode)))assert.equal(log,undefined);
    else assert.deepEqual({...log},{status:'success',charged_cost:0.1,upstream_attempt_count:1});
    return {id,wire};
  };
  return {db,app,env,context,key,fixture,journal,run,drain,recover,counts,baseline,otherRows,unrelated,options,saved,apiCalls,get sends(){return sends;}};
}

test('six real gateway/upstream faults, mixed intent-only and committed, atomic cleanup + repeat',{timeout:35000},async t=>{
  const f=await setup(t);
  for(const mode of SSE_SNAPSHOT_FAULT_MODES)await f.run(mode,{timeout:mode==='before-hold'});
  assert.equal(f.sends,6);assert.equal((await f.recover()).claimed,0);
  const result=await reconcileSnapshotSseStagingRun(f.options());
  assert.equal(result.unknownFixturesRemoved,2);assert.equal(result.committedFixturesRemoved,4);
  const saved=f.saved.find(e=>e.step==='snapshot-sse-facts-observed');
  assert.deepEqual(saved.observed.map(r=>r.length),[6,4,4,4,4,6]);assert.equal(saved.users[0].budget_reserved_micros,200000);
  assert.equal(saved.syntheticRemovalNotRefund,true);assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);
  assert.equal((await reconcileSnapshotSseStagingRun(f.options())).alreadyRemoved,true);assert.deepEqual(f.counts(),f.baseline);
});
for(const mode of ['before-hold','after-hold'])test('released '+mode+' is committed, not intent-only cleanup',async t=>{
  const f=await setup(t);await f.run(mode);const result=await reconcileSnapshotSseStagingRun(f.options());
  assert.equal(result.unknownFixturesRemoved,0);assert.equal(result.committedFixturesRemoved,1);assert.deepEqual(f.counts(),f.baseline);
});
test('pending snapshot is preserved until independent recovery',async t=>{
  const f=await setup(t);await f.run('job-read-fail',{recoverAfter:false});const before=f.counts();
  await assert.rejects(reconcileSnapshotSseStagingRun(f.options()));assert.deepEqual(f.counts(),before);
  assert.equal(f.db.sqlite.prepare('SELECT state FROM request_usage_recovery_jobs').get().state,'pending');
  assert.equal((await f.recover()).committed,1);await reconcileSnapshotSseStagingRun(f.options());assert.deepEqual(f.counts(),f.baseline);assert.equal(f.sends,1);
});

for(const fault of ['save-failure','delete-rollback','delete-ack-lost','changed-reservation','late-intent','changed-probe','wrong-database','not-quiescent','missing-request-id'])
test('intent-only cleanup safety: '+fault,async t=>{
  const f=await setup(t);await f.run('before-fail');const before=f.counts(),options=f.options();let hit=false;
  const id=f.journal.requests[0].id;
  if(fault==='save-failure')options.persist=async e=>{if(e.step==='snapshot-sse-facts-observed'){hit=true;throw Error('save_failed');}};
  if(fault==='delete-rollback')f.db.hooks.beforeStatement=sql=>{if(sql.startsWith('DELETE FROM request_dispatch_intents')){hit=true;throw Error('delete_failed');}};
  if(fault==='delete-ack-lost')f.db.hooks.afterBatch=sql=>{if(sql.some(s=>s.startsWith('DELETE FROM request_dispatch_intents'))){hit=true;throw Error('delete_ack_lost');}};
  if(['changed-reservation','late-intent','changed-probe'].includes(fault))options.persist=async e=>{
    if(e.step!=='snapshot-sse-facts-observed')return;hit=true;
    if(fault==='changed-probe')f.db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}','c02_sse_snapshot:'+f.journal.requests[0].probeId);
    else if(fault==='changed-reservation')f.db.sqlite.prepare('UPDATE user_budget_reservations SET reserved_micros=200000 WHERE request_id=?').run(id);
    else {
      const row={...f.db.sqlite.prepare('SELECT * FROM request_dispatch_intents WHERE request_id=?').get(id),request_id:'gen-'+randomUUID(),dispatch_claim_id:randomUUID()};
      f.db.sqlite.prepare(`INSERT INTO request_dispatch_intents(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
    }
  };
  if(fault==='wrong-database'){const api=options.api;options.api=async path=>{const value=await api(path);if(path.startsWith('/d1/')){hit=true;return {...value,uuid:'production-not-authorized'};}return value;};}
  if(fault==='not-quiescent')options.nowMs=Date.now();
  if(fault==='missing-request-id')f.journal.requests[0].id='';
  await assert.rejects(reconcileSnapshotSseStagingRun(options));
  if(!['not-quiescent','missing-request-id'].includes(fault))assert.equal(hit,true);
  if(fault==='delete-ack-lost'){
    assert.deepEqual(f.counts(),f.baseline);f.db.hooks.afterBatch=undefined;
    assert.equal((await reconcileSnapshotSseStagingRun(f.options())).alreadyRemoved,true);
  }else{
    const now=f.counts();if(fault!=='late-intent')assert.deepEqual(now,before);
    else {assert.equal(now.user_budget_reservations,before.user_budget_reservations);assert.equal(now.request_dispatch_intents,before.request_dispatch_intents+1);}
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM request_dispatch_intents').get().n,fault==='late-intent'?2:1);
    if(fault!=='wrong-database')assert.equal(f.db.sqlite.prepare('SELECT status FROM api_keys WHERE id=?').get(f.fixture.ids.key).status,'revoked');
  }
  assert.deepEqual(f.otherRows(),f.unrelated);assert.equal(f.sends,1);
});

test('mixed cleanup planner rejects tampered observations and incomplete probe states',async t=>{
  const f=await setup(t);await f.run('before-fail');await f.run('after-ack-loss');let facts;
  await assert.rejects(reconcileSnapshotSseStagingRun({...f.options(),persist:async e=>{if(e.step==='snapshot-sse-facts-observed'){facts=structuredClone(e);throw Error('capture');}}}),/capture/);
  const corruptions={
    missingNative:o=>{const row=o.snapshotProbes.find(r=>JSON.parse(r.value).nativeResult);const v=JSON.parse(row.value);delete v.nativeResult;row.value=JSON.stringify(v);},
    falseNative:o=>{const row=o.snapshotProbes.find(r=>JSON.parse(r.value).nativeResult);const v=JSON.parse(row.value);v.nativeResult.identityVerified=false;row.value=JSON.stringify(v);},
    zeroNative:o=>{const row=o.snapshotProbes.find(r=>JSON.parse(r.value).nativeResult);const v=JSON.parse(row.value);v.nativeResult.changes=0;row.value=JSON.stringify(v);},
    extraNative:o=>{const row=o.snapshotProbes.find(r=>JSON.parse(r.value).nativeResult);const v=JSON.parse(row.value);v.nativeResult.extra='unbounded';row.value=JSON.stringify(v);},
    foreignIntent:o=>o.observed[0][0].user_id='other',unknownSettled:o=>o.observed[5].find(r=>r.state==='dispatched').settled_micros=1,
    unknownTerminal:o=>o.observed[5].find(r=>r.state==='dispatched').terminal_reason='refund',
    pendingJob:o=>o.observed[2][0].state='pending',wrongCharge:o=>o.observed[4][0].charged_cost=0,
    missingReceipt:o=>o.observed[3]=[],extraIntent:o=>o.observed[0].push({...o.observed[0][0]}),
    wrongDigest:o=>o.observed[1][0].payload_sha256='0'.repeat(64),
    activeProbe:o=>{const p=JSON.parse(o.snapshotProbes[0].value);p.phase='held-before-insert';o.snapshotProbes[0].value=JSON.stringify(p);},
    foreignProbe:o=>o.snapshotProbes[0].description='other',wrongProbeRequest:o=>{const p=JSON.parse(o.snapshotProbes[0].value);p.requestId='gen-'+randomUUID();o.snapshotProbes[0].value=JSON.stringify(p);},
  };
  for(const [name,mutate] of Object.entries(corruptions))await t.test(name,()=>{const copy=structuredClone(facts);mutate(copy);assert.throws(()=>snapshotSseCleanupStatements(f.journal,copy.observed,copy.snapshotProbes));});
  await reconcileSnapshotSseStagingRun(f.options());assert.deepEqual(f.counts(),f.baseline);
});

for(const bad of ['method','path','query','type','header','driver'])test('dedicated gateway rejects invalid probe '+bad+' before storage',async t=>{
  const p={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'before-fail'};
  const app=createImagesSseSnapshotStagingGateway(async()=>{assert.fail('Must not dispatch');});let reads=0;
  const db={prepare(){reads++;throw Error('Must not access storage');}};
  const headers={'Content-Type':bad==='type'?'text/plain':'application/json',[SSE_SNAPSHOT_HEADER]:bad==='header'?'bad':`c02-snapshot:${p.runId}:${p.probeId}:${p.mode}`};
  const response=await app.fetch(new Request('https://example.invalid'+(bad==='path'?'/v1/images/edits':'/v1/images/generations')+(bad==='query'?'?delay=1':''),
    {method:bad==='method'?'GET':'POST',headers}),{DB:db,DATABASE_DRIVER:bad==='driver'?'postgres':'d1'},{});
  assert.equal(response.status,400);assert.equal(reads,0);
});
for(const credential of ['missing','invalid'])test('valid snapshot header never bypasses '+credential+' API authorization',async t=>{
  const f=await setup(t),p={runId:f.journal.runId,probeId:randomUUID(),mode:'before-fail'},row=sseSnapshotFaultRow(p);
  f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  const response=await f.app.fetch(new Request('https://example.invalid/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json',
    [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${p.runId}:${p.probeId}:${p.mode}`,...(credential==='invalid'?{Authorization:'Bearer invalid'}:{})},body:'{}'}),f.env,f.context);
  assert.equal(response.status,401);await response.text();await f.drain();assert.equal(f.sends,0);
  assert.equal(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value,row.value);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM request_dispatch_intents').get().n,0);
});

test('no probe header keeps durable SSE behavior and leaves armed probe untouched',async t=>{
  const f=await setup(t);await f.run('after-ack-loss',{omitHeader:true});assert.equal(f.sends,1);
  const p=f.journal.requests[0];assert.equal(JSON.parse(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get('c02_sse_snapshot:'+p.probeId).value).phase,'armed');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM request_usage_commit_receipts').get().n,1);
});
test('foreign synthetic probe header never captures this authenticated tenant',async t=>{
  const f=await setup(t),foreign={runId:'c02-success-'+randomUUID(),probeId:randomUUID(),mode:'before-fail'},row=sseSnapshotFaultRow(foreign);
  f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(row.key,row.value,row.description);
  await f.run('after-ack-loss',{headerOverride:`c02-snapshot:${foreign.runId}:${foreign.probeId}:${foreign.mode}`});
  assert.equal(f.db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(row.key).value,row.value);
  assert.equal(f.db.sqlite.prepare('SELECT charged_cost FROM api_key_request_logs').get().charged_cost,0.1);assert.equal(f.sends,1);
});
test('snapshot journal rejects unsupported profiles, duplicates and missing identities',async t=>{
  const f=await setup(t);await f.run('before-fail');
  const mutations={mode:j=>j.requests[0].mode='success',duplicate:j=>j.requests.push({...j.requests[0]}),
    missingUpstream:j=>j.probes=[],foreignUpstream:j=>j.probes[0].probeId=randomUUID(),
    invalidTimestamp:j=>j.requests[0].startedAt='yesterday',foreignRun:j=>j.runId='production'};
  for(const [name,change] of Object.entries(mutations))await t.test(name,()=>{const j=structuredClone(f.journal);change(j);assert.throws(()=>snapshotSseCleanupNotBefore(j));});
});
