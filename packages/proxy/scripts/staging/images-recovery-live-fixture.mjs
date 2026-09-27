// Operator-side observations/cleanup for exactly one new synthetic Images tenant.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { imageStorageFaultHeader, imageStorageFaultRow } from './images-storage-fault-contract.ts';
const stmt = (sql, ...params) => ({ sql, params });
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
function scope(f) {
  assert.match(f.ids.runId, new RegExp('^c02-success-' + uuid + '$'));
  for (const key of ['user','workspace','key']) assert.equal(f.ids[key], f.ids.runId + '-' + key);
  return [f.ids.user, f.ids.key, f.ids.workspace];
}
export function recoveryImagePlans(f) {
  scope(f);
  return ['normal','before-fail','after-fail'].flatMap(mode => ['generations','edits'].map(operation => {
    const model = f.cases['small-' + operation].model;
    assert.equal(model, f.ids.runId + '-small-' + operation);
    const probe = mode === 'normal' ? null : { runId: f.ids.runId, probeId: randomUUID(), mode };
    return { label: operation + '-' + mode, operation, mode, model, cost: 0.1,
      ...(probe ? { probe, probeRow: imageStorageFaultRow(probe), header: imageStorageFaultHeader(probe) } : {}) };
  }));
}
export function recoveryImageSeed(f, plans) {
  scope(f); assert.equal(plans.length, 6);
  return [...f.seed,
    stmt('UPDATE users SET budget_max=1 WHERE id=?', f.ids.user),
    stmt('UPDATE api_keys SET limit_micros=NULL WHERE id=? AND user_id=?', f.ids.key, f.ids.user),
    ...f.ids.endpoints.map(id => stmt("UPDATE model_endpoints SET image_capabilities=json_set(image_capabilities,'$.pricing[0].cost_usd','0.1') WHERE id=? AND verified_by=?", id, f.ids.runId)),
    ...plans.filter(p => p.probe).map(p => stmt('INSERT INTO system_config(key,value,description) VALUES(?,?,?)', p.probeRow.key, p.probeRow.value, p.probeRow.description)),
  ];
}
export function recoveryImageObservations(f) {
  const params = scope(f), where = 'user_id=? AND api_key_id=? AND workspace_id=?';
  const ids = `SELECT request_id FROM request_dispatch_intents WHERE ${where}`;
  return {
    account: stmt('SELECT id,budget_spent_micros,budget_reserved_micros,budget_epoch FROM users WHERE id=?', f.ids.user),
    key: stmt('SELECT id,user_id,workspace_id,status FROM api_keys WHERE id=?', f.ids.key),
    intents: stmt(`SELECT request_id,attempt_index,operation,state,revision FROM request_dispatch_intents WHERE ${where} ORDER BY request_id`, ...params),
    snapshots: stmt(`SELECT request_id,operation,payload_sha256,recorded_at,length(CAST(payload_json AS BLOB)) AS bytes,json_extract(payload_json,'$.params.chargedCost') AS cost,json_extract(payload_json,'$.params.requestLog.modelId') AS model_id FROM request_usage_settlements WHERE ${where} ORDER BY request_id`, ...params),
    jobs: stmt(`SELECT request_id,state,revision,attempts,last_error,lease_expires_at,available_at,updated_at FROM request_usage_recovery_jobs WHERE ${where} ORDER BY request_id`, ...params),
    reservations: stmt('SELECT request_id,state,reserved_micros,settled_micros FROM user_budget_reservations WHERE user_id=? AND api_key_id=? ORDER BY request_id', f.ids.user, f.ids.key),
    receipts: stmt(`SELECT request_id,payload_sha256,recorded_at,lease_revision FROM request_usage_commit_receipts WHERE request_id IN (${ids}) ORDER BY request_id`, ...params),
    logs: stmt(`SELECT id,model_id,request_operation,status,charged_cost,budget_charged_micros,upstream_attempt_count,created_at FROM api_key_request_logs WHERE ${where} ORDER BY id`, ...params),
    attempts: stmt(`SELECT request_log_id,attempt_index,outcome FROM provider_attempt_availability WHERE request_log_id IN (${ids}) ORDER BY request_log_id,attempt_index`, ...params),
    audit: stmt('SELECT request_log_id,event_type,api_key_id FROM user_audit_logs WHERE user_id=? ORDER BY request_log_id', f.ids.user),
    stats: stmt('SELECT model_id,stat_date,SUM(request_count) AS request_count,SUM(success_count) AS success_count,SUM(error_count) AS error_count FROM public_model_daily_stats WHERE model_id IN (?,?,?,?,?) GROUP BY model_id,stat_date ORDER BY model_id,stat_date', ...f.ids.models),
    statsRaw: stmt('SELECT * FROM public_model_daily_stats WHERE model_id IN (?,?,?,?,?) ORDER BY model_id,stat_date,shard', ...f.ids.models),
  };
}
export function assertRecoveryImages(f, plans, o, recovered = false) {
  scope(f); assert.equal(plans.length, 6);
  for (const p of plans) assert.match(p.requestId, new RegExp('^gen-' + uuid + '$'));
  assert.equal(new Set(plans.map(p => p.requestId)).size, 6);
  const sorted = [...plans].sort((a,b) => a.requestId.localeCompare(b.requestId));
  const done = p => recovered || p.mode !== 'before-fail', completed = sorted.filter(done);
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
    const retry=recovered&&p.mode==='before-fail';
    assert.equal(job.request_id,p.requestId); assert.equal(job.state,done(p)?'committed':'pending');
    assert.equal(job.revision,retry?4:2); assert.equal(job.attempts,retry?2:1); assert.equal(job.lease_expires_at,null);
    assert.equal(job.last_error,done(p)?null:'execution_error');
    if(done(p))assert.equal(job.available_at,null); else assert.equal(job.available_at-job.updated_at,5);
    assert.equal(reservation.request_id,p.requestId); assert.equal(reservation.state,done(p)?'settled':'dispatched');
    assert.ok(reservation.reserved_micros>=100000); assert.equal(reservation.settled_micros,done(p)?100000:0);
    if(!done(p))reserved+=reservation.reserved_micros;
  }
  assert.equal(o.account[0].budget_reserved_micros,reserved);
  assert.deepEqual(o.receipts,completed.map(p=>{const s=o.snapshots.find(s=>s.request_id===p.requestId);return {request_id:p.requestId,payload_sha256:s.payload_sha256,recorded_at:s.recorded_at,lease_revision:recovered&&p.mode==='before-fail'?3:1};}));
  assert.deepEqual(o.logs,completed.map(p=>({id:p.requestId,model_id:p.model,request_operation:'images.'+p.operation,status:'success',charged_cost:0.1,budget_charged_micros:100000,upstream_attempt_count:1,created_at:o.snapshots.find(s=>s.request_id===p.requestId).recorded_at})));
  assert.deepEqual(o.attempts,completed.map(p=>({request_log_id:p.requestId,attempt_index:1,outcome:'available'})));
  assert.deepEqual(o.audit,completed.map(p=>({request_log_id:p.requestId,event_type:'usage_charge',api_key_id:f.ids.key})));
  const stats=new Map();
  for(const p of completed){const date=o.snapshots.find(s=>s.request_id===p.requestId).recorded_at.slice(0,10),key=p.model+'|'+date;stats.set(key,(stats.get(key)??0)+1);}
  assert.deepEqual(o.stats,[...stats].sort(([a],[b])=>a.localeCompare(b)).map(([key,n])=>({model_id:key.split('|')[0],stat_date:key.split('|')[1],request_count:n,success_count:n,error_count:0})));
}
/** Caller must close both public entries, revoke the key and drain the host first. */
export function recoveryImageCleanup(f, plans) {
  const params=scope(f), ids='SELECT request_id FROM request_dispatch_intents WHERE user_id=? AND api_key_id=? AND workspace_id=?';
  return [
    stmt(`DELETE FROM provider_attempt_availability WHERE request_log_id IN (${ids})`,...params),
    ...['request_usage_commit_receipts','request_usage_recovery_jobs','request_usage_settlements'].map(table=>stmt(`DELETE FROM ${table} WHERE request_id IN (${ids})`,...params)),
    stmt('DELETE FROM user_budget_reservations WHERE user_id=? AND api_key_id=?',f.ids.user,f.ids.key),
    stmt('DELETE FROM request_dispatch_intents WHERE user_id=? AND api_key_id=? AND workspace_id=?',...params),
    ...plans.filter(p=>p.probe).map(p=>stmt('DELETE FROM system_config WHERE key=? AND description=?',p.probeRow.key,p.probeRow.description)),
    ...f.cleanup,
  ];
}
