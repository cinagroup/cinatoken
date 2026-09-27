import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseCapacityHostGateway} from './images-sse-capacity-host-handler.ts';
import {SSE_CAPACITY_ORIGIN as origin,SSE_CAPACITY_PATH as path,SSE_CAPACITY_INSTANCE_HEADER as instanceHeader} from './images-sse-capacity-observation.ts';
import {SSE_HOST_EXPIRY_HEADER} from './images-sse-host-expiry-gateway-handler.ts';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';
import {SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler.ts';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {classifySseCapacityObservation} from '../../../../scripts/deploy/staging-sse-capacity-evidence.mjs';

for(const mode of ['before-hold','after-hold'])test('observed actual durable host chain: '+mode,{timeout:10000},async t=>{
  const db=createSqliteD1(),tasks=[],abort=new AbortController(),reached=Promise.withResolvers(),heldAck=Promise.withResolvers();heldAck.promise.catch(()=>{});
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});await drainNodeBackgroundWork();};
  t.after(async()=>{abort.abort();heldAck.reject(Error('Local test teardown'));await drain();db.sqlite.close();});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const key='synthetic-capacity-host-'+randomUUID();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const probe={runId:fixture.ids.runId,probeId:randomUUID(),mode};
  const row=sseSnapshotFaultRow(probe),cancelRow=sseCancelObservationRow(probe);
  for(const r of [row,cancelRow])db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(r.key,r.value,r.description);
  // A local delayed ACK is NOT a Cloudflare invocation cancellation. Pause before
  // entering the native experiment's timer; terminate explicitly after assertions.
  db.hooks.afterStatement=(sql,values)=>{
    if(sql.startsWith('UPDATE system_config SET value=')&&values[2]===row.key&&JSON.parse(values[0]).phase.startsWith('held-')){
      reached.resolve();return heldAck.promise;
    }
  };
  let sends=0,statements=0;db.hooks.beforeStatement=()=>statements++;
  const app=createImagesSseCapacityHostGateway(async(input,init)=>{
    sends++;const headers=new Headers(init.headers);
    for(const h of [SSE_HOST_EXPIRY_HEADER,SSE_SNAPSHOT_HEADER,SSE_CANCEL_HEADER,instanceHeader])assert.equal(headers.has(h),false);
    return new Response('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  });
  const env={DB:db.binding,DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-capacity-host-not-real-secret'};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  const observe=async()=>{
    const before=statements,r=await app.fetch(new Request(origin+path),env,context);assert.equal(statements,before);
    assert.equal(r.status,200);return r.json();
  };
  const baseline=await observe();assert.equal(baseline.requests,0);
  const response=await app.fetch(new Request(origin+'/v1/images/generations',{method:'POST',signal:abort.signal,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',[SSE_HOST_EXPIRY_HEADER]:'v1',[SSE_CANCEL_HEADER]:'v1',
      [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${probe.runId}:${probe.probeId}:${mode}`,[instanceHeader]:'spoofed-client'},
    body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic capacity host',stream:true})}),env,context);
  assert.equal(response.status,200);assert.equal(response.headers.get(instanceHeader),baseline.instanceId);
  const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/completed/);
  await reached.promise;assert.equal(classifySseCapacityObservation(baseline.instanceId,await observe()).state,'occupied');
  abort.abort();await assert.rejects(reader.read(),/Gateway response delivery stopped/);reader.releaseLock();
  const before=statements,rejected=await app.fetch(new Request(origin+'/v1/images/generations',{method:'POST',body:'not-json'}),env,context);
  assert.equal(rejected.status,503);assert.equal(statements,before);assert.match(await rejected.text(),/capacity_unavailable/);
  const storage=await resolveWorkerStorageFromBindings(env);
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  assert.equal((await recover()).committed,mode==='after-hold'?1:0);
  assert.equal(classifySseCapacityObservation(baseline.instanceId,await observe()).state,'occupied');
  heldAck.reject(Error('Local modeled ACK terminal, not native expiry'));await drain();
  assert.equal(classifySseCapacityObservation(baseline.instanceId,await observe()).state,'idle');
  assert.equal((await recover()).committed,0);assert.equal(sends,1);
  const logs=db.sqlite.prepare('SELECT status,charged_cost FROM api_key_request_logs').all();
  assert.deepEqual(logs.map(r=>({...r})),mode==='after-hold'?[{status:'success',charged_cost:0.1}]:[]);
  const observed=JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(cancelRow.key).value);
  assert.equal(observed.phase,'request-aborted');assert.equal(observed.signalAborted,true);
});
