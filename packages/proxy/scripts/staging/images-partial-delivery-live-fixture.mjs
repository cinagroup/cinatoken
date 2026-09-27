// Operator-only partial-client-delivery evidence; no production runtime imports this module.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recoveryImageObservations } from './images-recovery-live-fixture.mjs';
import { imageStorageFaultHeader, imageStorageFaultRow } from './images-storage-fault-contract.ts';
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
// Six fixture models include both limit operations; old observation helper has five slots.
export function partialImageObservations(f) {
  assert.equal(f.ids.models.length,6);
  const observations=recoveryImageObservations(f);
  for(const name of ['stats','statsRaw']) {
    assert.ok(observations[name].sql.includes('IN (?,?,?,?,?)'));
    observations[name].sql=observations[name].sql.replace('IN (?,?,?,?,?)','IN (?,?,?,?,?,?)');
    assert.equal(observations[name].params.length,6);
  }
  return observations;
}
export function partialImagePlans(f) {
  partialImageObservations(f);
  return ['before-abort','after-abort'].flatMap(mode=>['generations','edits'].map(operation=>{
    const model=f.cases['limit-'+operation].model;
    assert.equal(model,f.ids.runId+'-limit-'+operation);
    const probe={runId:f.ids.runId,probeId:randomUUID(),mode};
    return {label:operation+'-partial-'+mode,operation,mode,model,cost:0.1,probe,
      probeRow:imageStorageFaultRow(probe),header:imageStorageFaultHeader(probe)};
  }));
}
export function partialImageSeed(f,plans) {
  assert.deepEqual(plans.map(p=>p.label),partialImagePlans(f).map(p=>p.label));
  return [...f.seed,
    {sql:'UPDATE users SET budget_max=1 WHERE id=?',params:[f.ids.user]},
    {sql:'UPDATE api_keys SET limit_micros=NULL WHERE id=? AND user_id=?',params:[f.ids.key,f.ids.user]},
    ...f.ids.endpoints.map(id=>({sql:"UPDATE model_endpoints SET image_capabilities=json_set(image_capabilities,'$.pricing[0].cost_usd','0.1') WHERE id=? AND verified_by=?",params:[id,f.ids.runId]})),
    ...plans.map(p=>({sql:'INSERT INTO system_config(key,value,description) VALUES(?,?,?)',params:[p.probeRow.key,p.probeRow.value,p.probeRow.description]})),
  ];
}
/** Node operator observation only: not a claim about bytes buffered by the edge/network. */
export async function readPartialImageResponse(response,expectedBytes) {
  assert.equal(response.status,200);assert.ok(expectedBytes>=32*1024**2);
  const reader=response.body.getReader();
  try {
    const {done,value}=await reader.read();
    assert.equal(done,false);assert.ok(value.byteLength>0&&value.byteLength<=262144&&value.byteLength<expectedBytes);
    await reader.cancel('c02-operator-partial-body-cancel');
    return {bytes:value.byteLength,expectedFullBytes:expectedBytes,eofObserved:false,
      clientCancellationRequested:true,clientCancellationCompleted:true,fullBodyParsed:false};
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** All financial projections are checked; pending/backoff is NOT accepted as native abort. */
export function assertPartialImages(f, plans, o, recovered = false) {
  partialImageObservations(f); assert.ok(plans.length>=1&&plans.length<=4);
  assert.equal(typeof recovered,'boolean');
  const all=partialImagePlans(f);
  assert.deepEqual(plans.map(p=>p.label),all.slice(0,plans.length).map(p=>p.label));
  for(const p of plans){assert.equal(p.model,f.ids.runId+'-limit-'+p.operation);assert.equal(p.cost,0.1);}
  for(const p of plans)assert.equal(p.label,p.operation+'-partial-'+p.mode);
  for (const p of plans) assert.match(p.requestId, new RegExp('^gen-' + uuid + '$'));
  assert.equal(new Set(plans.map(p => p.requestId)).size, plans.length);
  const sorted = [...plans].sort((a,b) => a.requestId.localeCompare(b.requestId));
  const done = p => recovered || p.mode !== 'before-abort', completed = sorted.filter(done);
  assert.equal(o.account.length, 1); assert.equal(o.account[0].id, f.ids.user);
  assert.equal(o.account[0].budget_spent_micros, completed.length * 100000);
  assert.equal(o.account[0].budget_epoch, 0);
  assert.equal(o.key.length, 1); assert.equal(o.key[0].id, f.ids.key);
  assert.deepEqual(o.intents, sorted.map(p => ({ request_id:p.requestId, attempt_index:1, operation:'images.'+p.operation, state:'dispatch_claimed', revision:1 })));
  assert.equal(o.snapshots.length,plans.length); assert.equal(o.jobs.length,plans.length); assert.equal(o.reservations.length,plans.length);
  let reserved=0;
  for (const [i,p] of sorted.entries()) {
    const snapshot=o.snapshots[i], job=o.jobs[i], reservation=o.reservations[i];
    assert.equal(snapshot.request_id,p.requestId); assert.equal(snapshot.operation,'images.'+p.operation);
    assert.equal(snapshot.model_id,p.model); assert.equal(snapshot.cost,p.cost); assert.ok(snapshot.bytes>0&&snapshot.bytes<=262144);
    assert.match(snapshot.payload_sha256,/^[a-f0-9]{64}$/);
    const retry=recovered&&p.mode==='before-abort';
    assert.equal(job.request_id,p.requestId); assert.equal(job.state,done(p)?'committed':'leased');
    assert.equal(job.revision,retry?3:done(p)?2:1); assert.equal(job.attempts,retry?2:1);
    assert.equal(job.last_error,null);
    if(done(p)){assert.equal(job.available_at,null);assert.equal(job.lease_expires_at,null);}
    else {assert.equal(job.available_at,job.lease_expires_at);assert.equal(job.lease_expires_at-job.updated_at,5);}
    assert.equal(reservation.request_id,p.requestId); assert.equal(reservation.state,done(p)?'settled':'dispatched');
    assert.ok(reservation.reserved_micros>=100000); assert.equal(reservation.settled_micros,done(p)?100000:0);
    if(!done(p))reserved+=reservation.reserved_micros;
  }
  assert.equal(o.account[0].budget_reserved_micros,reserved);
  assert.deepEqual(o.receipts,completed.map(p=>{const s=o.snapshots.find(s=>s.request_id===p.requestId);return {request_id:p.requestId,payload_sha256:s.payload_sha256,recorded_at:s.recorded_at,lease_revision:recovered&&p.mode==='before-abort'?2:1};}));
  assert.deepEqual(o.logs,completed.map(p=>({id:p.requestId,model_id:p.model,request_operation:'images.'+p.operation,status:'success',charged_cost:0.1,budget_charged_micros:100000,upstream_attempt_count:1,created_at:o.snapshots.find(s=>s.request_id===p.requestId).recorded_at})));
  assert.deepEqual(o.attempts,completed.map(p=>({request_log_id:p.requestId,attempt_index:1,outcome:'available'})));
  assert.deepEqual(o.audit,completed.map(p=>({request_log_id:p.requestId,event_type:'usage_charge',api_key_id:f.ids.key})));
  const stats=new Map();
  for(const p of completed){const date=o.snapshots.find(s=>s.request_id===p.requestId).recorded_at.slice(0,10),key=p.model+'|'+date;stats.set(key,(stats.get(key)??0)+1);}
  assert.deepEqual(o.stats,[...stats].sort(([a],[b])=>a.localeCompare(b)).map(([key,n])=>({model_id:key.split('|')[0],stat_date:key.split('|')[1],request_count:n,success_count:n,error_count:0})));
}
