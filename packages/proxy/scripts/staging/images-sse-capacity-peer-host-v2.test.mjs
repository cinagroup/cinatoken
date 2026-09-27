import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {resolveWorkerStorageFromBindings} from '../../src/runtime/workers.ts';
import {drainNodeBackgroundWork} from '../../src/runtime/schedule-background-work.ts';
import {runUsageRecoveryD1} from '../../../core/src/storage/recovery/run-usage-recovery-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {createImagesSseCapacityPeerGatewayV2} from './images-sse-capacity-peer-handler-v2.ts';
import {SSE_CAPACITY_ORIGIN as origin,SSE_CAPACITY_PATH as censusPath,SSE_CAPACITY_INSTANCE_HEADER as instanceHeader} from './images-sse-capacity-observation.ts';
import {SSE_CAPACITY_PEER_HEADER as peerHeader,SSE_CAPACITY_WATCH_PATH as watchPath,SSE_CAPACITY_WATCH_HEADER as watchHeader,SSE_CAPACITY_BARRIER_PATH as barrierPath,SSE_CAPACITY_BARRIER_HEADER as barrierHeader} from './images-sse-capacity-peer-observation-v2.ts';
import {SSE_HOST_EXPIRY_HEADER} from './images-sse-host-expiry-gateway-handler.ts';
import {SSE_SNAPSHOT_HEADER} from './images-sse-snapshot-gateway-handler-v2.ts';
import {SSE_CANCEL_HEADER} from './images-sse-cancel-gateway-handler.ts';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';

for(const mode of ['before-hold','after-hold'])test('peer v2 observes real SQLite host flow: '+mode+' (modeled ACK, not native evidence)',{timeout:15000},async t=>{
  const db=createSqliteD1(),tasks=[],abort=new AbortController(),reached=Promise.withResolvers(),heldAck=Promise.withResolvers();
  heldAck.promise.catch(()=>{});
  t.mock.method(globalThis,'fetch',async()=>assert.fail('No external network'));
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  const drain=async()=>{for(let i=0;i<tasks.length;i++)await tasks[i].catch(()=>{});await drainNodeBackgroundWork();};
  t.after(async()=>{abort.abort();heldAck.reject(Error('Local teardown'));await drain();db.sqlite.close();});
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])
    db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const key='synthetic-capacity-peer-'+randomUUID();
  const fixture=await imageSseFixture('c02-success-'+randomUUID(),'sha256:'+createHash('sha256').update(key).digest('hex'),new Date(Date.now()+3600000).toISOString());
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  const probe={runId:fixture.ids.runId,probeId:randomUUID(),mode};
  const row=sseSnapshotFaultRow(probe),cancelRow=sseCancelObservationRow(probe);
  for(const r of [row,cancelRow])db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(r.key,r.value,r.description);
  db.hooks.afterStatement=(sql,values)=>{
    if(sql.startsWith('UPDATE system_config SET value=')&&values[2]===row.key&&JSON.parse(values[0]).phase.startsWith('held-')){
      reached.resolve();return heldAck.promise;
    }
  };
  let sends=0,statements=0;db.hooks.beforeStatement=()=>statements++;
  const app=createImagesSseCapacityPeerGatewayV2(async(input,init)=>{
    sends++;const headers=new Headers(init.headers);
    for(const h of [peerHeader,watchHeader,SSE_HOST_EXPIRY_HEADER,SSE_SNAPSHOT_HEADER,SSE_CANCEL_HEADER,instanceHeader])
      assert.equal(headers.has(h),false);
    return new Response('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  });
  const env={DB:db.binding,DATABASE_DRIVER:'d1',REQUEST_BODY_LOGGING:'off',BATCH_API_ENABLED:'false',SHARED_KEY_ENCRYPTION_SECRET:'synthetic-capacity-peer-not-real-secret'};
  const context={waitUntil(p){assert.equal(this,context);tasks.push(p);p.catch(()=>{});}};
  const beforeWatch=statements;
  const watched=await app.fetch(new Request(origin+watchPath,{headers:{[watchHeader]:'v2'}}),env,context);
  const reader=watched.body.getReader();t.after(()=>reader.cancel());
  const peer=watched.headers.get(peerHeader);
  const mark=async stage=>{const r=await app.fetch(new Request(origin+barrierPath,{method:'POST',headers:{[peerHeader]:peer,[barrierHeader]:stage}}),env,context);assert.equal(r.status,200);return r.json();};
  const sample=async()=>JSON.parse(new TextDecoder().decode((await reader.read()).value));
  const baseline=await sample();assert.equal(statements,beforeWatch);assert.equal(baseline.requests,0);
  const response=await app.fetch(new Request(origin+'/v1/images/generations',{method:'POST',signal:abort.signal,
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',[peerHeader]:peer,[SSE_HOST_EXPIRY_HEADER]:'v1',[SSE_CANCEL_HEADER]:'v1',
      [SSE_SNAPSHOT_HEADER]:`c02-snapshot:${probe.runId}:${probe.probeId}:${mode}`},
    body:JSON.stringify({model:fixture.cases['small-generations'].model,prompt:'synthetic peer',stream:true})}),env,context);
  assert.equal(response.status,200);assert.equal(response.headers.get(instanceHeader),baseline.instanceId);
  const primaryReader=response.body.getReader();assert.match(new TextDecoder().decode((await primaryReader.read()).value),/completed/);
  await reached.promise;
  assert.equal((await mark('held')).barrier,1);
  const held=await sample();assert.equal(held.barrier,1);assert.equal(held.instanceId,baseline.instanceId);assert.equal(held.watchEpoch,baseline.watchEpoch);assert.equal(held.requests,1);
  abort.abort();await assert.rejects(primaryReader.read(),/Gateway response delivery stopped/);primaryReader.releaseLock();
  const before=statements,rejected=await app.fetch(new Request(origin+'/v1/images/generations',{method:'POST',headers:{[peerHeader]:peer},body:'not-json'}),env,context);
  assert.equal(rejected.status,503);assert.equal(statements,before);assert.match(await rejected.text(),/capacity_unavailable/);
  const storage=await resolveWorkerStorageFromBindings(env);
  const recover=()=>runUsageRecoveryD1(storage.client,{scope:{kind:'tenant',userId:fixture.ids.user,workspaceId:fixture.ids.workspace},maxItems:2,concurrency:1,leaseSeconds:10,runBudgetMs:5000,reservedBytesPerConsumer:1024},{tryAcquire(){return {release(){}};}});
  assert.equal((await recover()).committed,mode==='after-hold'?1:0);
  // This is deliberately a modeled native marker, not actual native evidence.
  assert.equal((await mark('post-native')).barrier,2);
  const retained=await sample();assert.equal(retained.barrier,2);assert.equal(retained.requests,1);
  assert.equal((await mark('post-recovery')).barrier,3);
  // Ending the peer is diagnostic only: the unacknowledged original owner stays.
  await reader.cancel();
  const census=async()=> (await app.fetch(new Request(origin+censusPath),env,context)).json();
  assert.equal((await census()).requests,1);
  heldAck.reject(Error('Local modeled ACK terminal, not native expiry'));await drain();
  assert.equal((await census()).requests,0);assert.equal((await recover()).committed,0);assert.equal(sends,1);
  const logs=db.sqlite.prepare('SELECT status,charged_cost FROM api_key_request_logs').all();
  assert.deepEqual(logs.map(r=>({...r})),mode==='after-hold'?[{status:'success',charged_cost:0.1}]:[]);
  const observed=JSON.parse(db.sqlite.prepare('SELECT value FROM system_config WHERE key=?').get(cancelRow.key).value);
  assert.equal(observed.phase,'request-aborted');assert.equal(observed.signalAborted,true);
});
