// Operator-side validator for native context aborts; not a runtime recovery implementation.
import assert from 'node:assert/strict';
import { recoveryImagePlans, recoveryImageObservations } from './images-recovery-live-fixture.mjs';
import { imageStorageFaultHeader, imageStorageFaultRow } from './images-storage-fault-contract.ts';
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export function abortImagePlans(f) {
  return recoveryImagePlans(f).map(p=>{
    if(p.mode==='normal')return p;
    const mode=p.mode==='before-fail'?'before-abort':'after-abort', probe={...p.probe,mode};
    return {...p,mode,label:p.operation+'-'+mode,probe,probeRow:imageStorageFaultRow(probe),header:imageStorageFaultHeader(probe)};
  });
}
/** All financial projections are checked; pending/backoff is NOT accepted as native abort. */
export function assertAbortImages(f, plans, o, recovered = false) {
  recoveryImageObservations(f); assert.equal(plans.length, 6);
  assert.deepEqual(plans.map(p=>p.mode+"|"+p.operation).sort(), ["normal","before-abort","after-abort"].flatMap(m=>["generations","edits"].map(op=>m+"|"+op)).sort());
  for (const p of plans) assert.match(p.requestId, new RegExp('^gen-' + uuid + '$'));
  assert.equal(new Set(plans.map(p => p.requestId)).size, 6);
  const sorted = [...plans].sort((a,b) => a.requestId.localeCompare(b.requestId));
  const done = p => recovered || p.mode !== 'before-abort', completed = sorted.filter(done);
  assert.equal(o.account.length, 1); assert.equal(o.account[0].id, f.ids.user);
  assert.equal(o.account[0].budget_spent_micros, completed.length * 100000);
  assert.equal(o.account[0].budget_epoch, 0);
  assert.equal(o.key.length, 1); assert.equal(o.key[0].id, f.ids.key);
  assert.deepEqual(o.intents, sorted.map(p => ({ request_id:p.requestId, attempt_index:1, operation:'images.'+p.operation, state:'dispatch_claimed', revision:1 })));
  assert.equal(o.snapshots.length,6); assert.equal(o.jobs.length,6); assert.equal(o.reservations.length,6);
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
    else {assert.equal(job.available_at,job.lease_expires_at);assert.equal(job.lease_expires_at-job.updated_at,30);}
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
