import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {SSE_STAGING_SCOPE,closeSseStagingAccess,sseCleanupNotBefore,SseCleanupPendingError,
  terminalSseReservationCleanup,terminalSseProbeCleanup} from './staging-sse-reconciliation.mjs';

// Operator-only. No credentials, network implementation, timers, model replay, or production selector.
const tables=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'];
const guard=(condition,params=[])=>({sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE json('staging_durable_cleanup_precondition_failed') END AS cleanup_guard`,params});
const sha=value=>createHash('sha256').update(value).digest('hex');
const capacity=mode=>['usage-limit','property-limit'].includes(mode);
const budget=mode=>mode==='success'||capacity(mode)?100000:0;

function selections(journal){
  sseCleanupNotBefore(journal); // Fixed synthetic identities, <=9 unique requests and known modes.
  const user=journal.runId+'-user',key=journal.runId+'-key',ids=journal.requests.map(r=>r.id);
  const selected=ids.length?` IN (${ids.map(()=>'?').join(',')})`:' IN (NULL)';
  return tables.map(table=>{
    const id=table==='api_key_request_logs'?'id':'request_id';
    const where=table==='request_usage_commit_receipts'?`${id}${selected}`:`user_id=? OR api_key_id=? OR ${id}${selected}`;
    const params=table==='request_usage_commit_receipts'?ids:[user,key,...ids];
    const columns=table==='api_key_request_logs'?'id,user_id,api_key_id,workspace_id,model_id,provider_id,request_operation,response_streamed,status,charged_cost,budget_charged_micros,output_image_count,upstream_attempt_count,created_at':'*';
    return {table,where,params,sql:`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${id} LIMIT 10`};
  });
}
const rowGuard=(table,row)=>{
  const keys=Object.keys(row);assert.ok(keys.length>0&&keys.length<=100);assert.ok(keys.every(k=>/^[a-z][a-z0-9_]*$/.test(k)));
  return guard(`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k]));
};

/** Full live observation -> guards + deletes. Pending/blocked/intent-only records are never erased. */
export function durableSseCleanupStatements(journal,observed){
  const selected=selections(journal),n=journal.requests.length;
  assert.ok(Array.isArray(observed)&&observed.length===tables.length);
  const [intents,snapshots,jobs,receipts,logs,reservations]=observed;
  for(const rows of observed)assert.ok(Array.isArray(rows)&&rows.length===n,'Missing, extra or partially reconciled durable facts');
  const guards=selected.map((s,i)=>guard(`(SELECT COUNT(*) FROM ${s.table} WHERE ${s.where})=?`,[...s.params,observed[i].length]));
  for(const request of journal.requests){
    const find=rows=>{const matched=rows.filter(row=>(row.request_id??row.id)===request.id);assert.equal(matched.length,1);return matched[0];};
    const i=find(intents),s=find(snapshots),j=find(jobs),r=find(receipts),l=find(logs),b=find(reservations);
    for(const row of [i,s,j,l,b]){
      assert.equal(row.user_id,journal.runId+'-user');assert.equal(row.api_key_id,journal.runId+'-key');
      if(row!==b)assert.equal(row.workspace_id,journal.runId+'-workspace');
    }
    assert.equal(i.attempt_index,1);assert.ok(['dispatch_claimed','outcome_unknown'].includes(i.state));
    assert.equal(s.attempt_index,1);assert.equal(s.operation,'images.generations');assert.equal(i.operation,s.operation);
    assert.equal(s.context_sha256,i.context_sha256);assert.equal(s.dispatch_claim_id,i.dispatch_claim_id);
    assert.equal(typeof s.payload_json,'string');assert.ok(Buffer.byteLength(s.payload_json)<=262144);assert.equal(sha(s.payload_json),s.payload_sha256);
    assert.equal(j.state,'committed');assert.equal(j.payload_sha256,s.payload_sha256);assert.equal(j.lease_token,null);assert.equal(j.last_error,null);
    assert.equal(r.payload_sha256,s.payload_sha256);assert.equal(r.recorded_at,s.recorded_at);
    assert.match(r.lease_token,/^[a-f0-9-]{36}$/);assert.equal(j.revision,r.lease_revision+1);
    const p=JSON.parse(s.payload_json).params,success=request.mode==='success';
    assert.equal(p.requestLog.id,request.id);assert.equal(p.requestLog.responseStreamed,true);
    assert.equal(p.requestLog.status,success?'success':'error');assert.equal(p.chargedCost,success?0.1:0);
    assert.equal(l.created_at,s.recorded_at);assert.equal(l.status,p.requestLog.status);assert.equal(l.response_streamed,1);
    assert.equal(l.request_operation,s.operation);assert.equal(l.model_id,p.requestLog.modelId);assert.equal(l.provider_id,p.requestLog.providerId);
    // Capacity rejection preserves the reservation separately; it is not a priced log charge.
    assert.equal(l.charged_cost,p.chargedCost);assert.equal(l.budget_charged_micros,success?100000:0);
    assert.equal(l.output_image_count,success?1:0);assert.equal(l.upstream_attempt_count,1);
  }
  for(let t=0;t<tables.length;t++)for(const row of observed[t])guards.push(rowGuard(tables[t],row));
  // All guards execute before any DELETE in the same caller-supplied atomic batch.
  const deletes=[3,2,1,0].flatMap(index=>observed[index].map(row=>({sql:`DELETE FROM ${tables[index]} WHERE request_id=?`,params:[row.request_id]})));
  return [...guards,...deletes,...terminalSseReservationCleanup(journal,reservations)];
}

/** Caller supplies the fixed account API, atomic staging batch, and durable evidence writer.
 * Close/reconcile Access first. Quiescence never substitutes for completed financial evidence.
 */
export async function reconcileDurableSseStagingRun({api,batch,journal,nowMs,persist}){
  assert.equal(typeof persist,'function');assert.ok(Number.isFinite(nowMs));selections(journal);
  const access=await closeSseStagingAccess({api,journal,persist});
  const db=await api(`/d1/database/${SSE_STAGING_SCOPE.database}`);
  assert.equal(db.uuid,SSE_STAGING_SCOPE.database);assert.equal(db.name,'cinatoken-staging');
  const fixture=await imageSseFixture(journal.runId,journal.keyHash,journal.expiresAt);
  await batch([fixture.revoke]);
  const notBefore=sseCleanupNotBefore(journal);if(nowMs<notBefore)throw new SseCleanupPendingError(notBefore);
  assert.ok(Array.isArray(journal.probes)&&journal.probes.length<=9);
  terminalSseProbeCleanup(journal,[]); // Validate probe identities even when no row remains.
  const probeKeys=journal.probes.map(p=>'c02_images_sse_probe:'+p.probeId);
  const probes={sql:`SELECT key,value,description FROM system_config WHERE description=?${probeKeys.length?` OR key IN (${probeKeys.map(()=>'?').join(',')})`:''} ORDER BY key LIMIT 10`,params:['c02-sse:'+journal.runId,...probeKeys]};
  const owners=[{sql:'SELECT id,metadata,budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',params:[fixture.ids.user]},
    {sql:'SELECT id,user_id,workspace_id,key_hash,status FROM api_keys WHERE id=?',params:[fixture.ids.key]}];
  const query=selections(journal),all=await batch([...query.map(({sql,params})=>({sql,params})),probes,...owners]);
  const verifyNamedFixtureAbsent=async()=>{
    const rows=await batch([['workspaces',[fixture.ids.workspace]],['models',fixture.ids.models],['providers',fixture.ids.providers],['model_routes',fixture.ids.routes],['model_endpoints',fixture.ids.endpoints]].map(([table,ids])=>
      ({sql:`SELECT id FROM ${table} WHERE id IN (${ids.map(()=>'?').join(',')})`,params:ids})));
    assert.equal(rows.length,5);assert.ok(rows.every(r=>r.length===0),'Named fixture objects remain');
  };
  assert.equal(all.length,9);const observed=all.slice(0,6),probeRows=all[6],users=all[7],keys=all[8];
  if(all.every(rows=>rows.length===0)){await verifyNamedFixtureAbsent();return {access,fixtureRemoved:true,alreadyRemoved:true};}
  assert.equal(users.length,1);assert.equal(keys.length,1);
  assert.equal(users[0].metadata,JSON.stringify({staging_fixture:journal.runId,purpose:'private-synthetic-images'}));
  assert.equal(users[0].budget_reserved_micros,0);assert.equal(users[0].budget_spent_micros,journal.requests.reduce((n,r)=>n+budget(r.mode),0));
  assert.deepEqual({...keys[0]},{id:fixture.ids.key,user_id:fixture.ids.user,workspace_id:fixture.ids.workspace,key_hash:journal.keyHash,status:'revoked'});
  const statements=durableSseCleanupStatements(journal,observed),probeDeletes=terminalSseProbeCleanup(journal,probeRows);
  // A persistence exception prevents deletion; a lost delete ACK can resume from empty state.
  await persist({step:'durable-sse-terminal-observed',runId:journal.runId,observed,probes:probeRows,users,keys});
  await batch([rowGuard('users',users[0]),rowGuard('api_keys',keys[0]),
    guard(`(SELECT COUNT(*) FROM system_config WHERE description=?${probeKeys.length?` OR key IN (${probeKeys.map(()=>'?').join(',')})`:''})=?`,[...probes.params,probeRows.length]),
    ...statements,...probeDeletes,...fixture.cleanup]);
  const remaining=await batch([...query.map(({sql,params})=>({sql,params})),probes,...owners]);
  assert.ok(remaining.every(rows=>rows.length===0));
  await verifyNamedFixtureAbsent();
  await persist({step:'durable-sse-cleanup-complete',runId:journal.runId});
  return {access,fixtureRemoved:true,alreadyRemoved:false};
}
