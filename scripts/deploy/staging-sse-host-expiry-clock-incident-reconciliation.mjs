import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {SSE_STAGING_SCOPE,closeSseStagingAccess,sseCleanupNotBefore,SseCleanupPendingError,terminalSseProbeCleanup} from './staging-sse-reconciliation.mjs';
import {durableSseCleanupStatements} from './staging-sse-durable-reconciliation.mjs';
import {assertCancelObservation} from './staging-sse-cancel-reconciliation.mjs';
import {assertSseHostExpiryEvidence} from './staging-sse-host-expiry-clock-incident-evidence.mjs';

// Operator-only synthetic fixture removal, NOT a refund, real-customer reconciliation, or model retry.
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const modes=['before-hold','after-hold'];
const tables=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'];
const guard=(condition,params=[])=>({sql:`SELECT CASE WHEN ${condition} THEN 1 ELSE json('snapshot_cleanup_precondition_failed') END AS cleanup_guard`,params});
// Balanced predicates preserve every observed field within the native D1 expression-depth limit.
import {exactStagingRowGuard as exact} from './staging-sql-row-guard.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const asLegacy=(journal,r)=>({...journal,requests:[{...r,mode:'success'}]});
function validate(journal){
  assert.match(journal.runId,new RegExp(`^c02-success-${uuid}$`));
  assert.ok(Array.isArray(journal.requests)&&journal.requests.length>0&&journal.requests.length<=2);
  const ids=new Set(),profiles=new Set(),probes=new Set(),upstream=new Set();
  for(const r of journal.requests){
    assert.match(r.id,new RegExp(`^gen-${uuid}$`));assert.match(r.probeId,new RegExp(`^${uuid}$`));assert.match(r.upstreamProbeId,new RegExp(`^${uuid}$`));
    assert.ok(modes.includes(r.mode)&&!ids.has(r.id)&&!profiles.has(r.mode)&&!probes.has(r.probeId)&&!upstream.has(r.upstreamProbeId));
    ids.add(r.id);profiles.add(r.mode);probes.add(r.probeId);upstream.add(r.upstreamProbeId);
    sseCleanupNotBefore(asLegacy(journal,r)); // Reuse fixed 350-second safety window, not legacy financial semantics.
  }
  assert.ok(Array.isArray(journal.probes)&&journal.probes.length===journal.requests.length);
  for(const p of journal.probes)assert.ok(p.mode==='success'&&upstream.delete(p.probeId));
  assert.equal(upstream.size,0);
}
export function hostExpirySseCleanupNotBefore(journal){
  validate(journal);return Math.max(0,...journal.requests.map(r=>sseCleanupNotBefore(asLegacy(journal,r))));
}
function selections(journal){
  validate(journal);const user=journal.runId+'-user',key=journal.runId+'-key',ids=journal.requests.map(r=>r.id);
  const selected=` IN (${ids.length?ids.map(()=>'?').join(','):'NULL'})`;
  return tables.map(table=>{
    const id=table==='api_key_request_logs'?'id':'request_id';
    const where=table==='request_usage_commit_receipts'?`${id}${selected}`:`user_id=? OR api_key_id=? OR ${id}${selected}`;
    const params=table==='request_usage_commit_receipts'?ids:[user,key,...ids];
    const columns='*'; // Guard every observed log field, including non-pricing fields.
    return {table,where,params,sql:`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${id} LIMIT 3`};
  });
}
const probeSelection=(journal,snapshot)=>{
  const keys=snapshot?journal.requests.map(r=>'c02_sse_snapshot:'+r.probeId):journal.probes.map(r=>'c02_images_sse_probe:'+r.probeId);
  const where=`description=?${keys.length?` OR key IN (${keys.map(()=>'?').join(',')})`:''}`;
  return {where,params:[(snapshot?'c02-snapshot:':'c02-sse:')+journal.runId,...keys],sql:`SELECT key,value,description FROM system_config WHERE ${where} ORDER BY key LIMIT 3`};
};

const cancelSelection=journal=>{
  const keys=journal.requests.map(r=>'c02_sse_cancel:'+r.probeId);
  const where=`description=? OR key IN (${keys.map(()=>'?').join(',')})`;
  return {where,params:['c02-cancel:'+journal.runId,...keys],sql:`SELECT key,value,description FROM system_config WHERE ${where} ORDER BY key LIMIT 3`};
};

/** A held row requires exact platform evidence. Timer survival is cleanup-only.
 * No phase normalization, model replay or financial mutation is performed. */
export function hostExpirySseCleanupStatements(journal,observed,probeRows,cancelRows,platform={events:[]}){
  const selected=selections(journal),n=journal.requests.length;
  assert.ok(Array.isArray(observed)&&observed.length===6);assert.ok(Array.isArray(probeRows)&&probeRows.length===n);
  for(const rows of observed)assert.ok(Array.isArray(rows)&&rows.length<=n);
  const ids=new Set(journal.requests.map(r=>r.id));
  for(const rows of observed){const seen=new Set();for(const row of rows){const id=row.request_id??row.id;assert.ok(ids.has(id)&&!seen.has(id));seen.add(id);}}
  assert.equal(observed[0].length,n);assert.equal(observed[5].length,n);
  const statements=selected.map((s,k)=>guard(`(SELECT COUNT(*) FROM ${s.table} WHERE ${s.where})=?`,[...s.params,observed[k].length]));
  const ps=probeSelection(journal,true);
  statements.push(guard(`(SELECT COUNT(*) FROM system_config WHERE ${ps.where})=?`,[...ps.params,n]));
  assert.ok(Array.isArray(cancelRows)&&cancelRows.length===n);
  assert.ok(platform&&Array.isArray(platform.events)&&platform.events.length<=n);
  const tailHeaders=new Set();
  for(const tail of platform.events){
    assert.ok(journal.requests.some(r=>tail.probeHeader===`c02-snapshot:${journal.runId}:${r.probeId}:${r.mode}`));
    assert.ok(!tailHeaders.has(tail.probeHeader));tailHeaders.add(tail.probeHeader);
  }
  const cp=cancelSelection(journal);
  statements.push(guard(`(SELECT COUNT(*) FROM system_config WHERE ${cp.where})=?`,[...cp.params,n]));
  let unknown=0,committed=0,platformCancelled=0,failedExperiments=0;const used=new Set(),cancelUsed=new Set();
  for(const request of journal.requests){
    const rows=observed.map(rows=>rows.filter(row=>(row.request_id??row.id)===request.id));
    const p=probeRows.find(p=>p.key==='c02_sse_snapshot:'+request.probeId);assert.ok(p&&!used.has(p.key));used.add(p.key);
    assert.equal(p.description,'c02-snapshot:'+journal.runId);assert.equal(typeof p.value,'string');assert.ok(Buffer.byteLength(p.value)<=2048);
    const v=JSON.parse(p.value);
    const intentOnly=request.mode==='before-hold';
    assert.deepEqual(Object.keys(v).sort(),['runId','probeId','mode','requestId','payloadSha256','phase',...(intentOnly?[]:['nativeResult'])].sort());
    if(!intentOnly){
      const m=v.nativeResult;assert.ok(m&&typeof m==='object');
      assert.deepEqual(Object.keys(m).sort(),['success','changes','rowsWritten','identityVerified'].sort());
      assert.equal(m.success,true);assert.equal(m.identityVerified,true);
      assert.ok(Number.isSafeInteger(m.changes)&&m.changes>0);
      assert.ok(m.rowsWritten===null||(Number.isSafeInteger(m.rowsWritten)&&m.rowsWritten>=0));
    }
    assert.equal(v.runId,journal.runId);assert.equal(v.probeId,request.probeId);assert.equal(v.mode,request.mode);assert.equal(v.requestId,request.id);
    assert.match(v.payloadSha256,/^[a-f0-9]{64}$/);
    const held=request.mode==='before-hold'?'held-before-insert':'held-after-insert';
    assert.ok([held,'host-expiry-not-observed'].includes(v.phase),'Unfinished or unexpected host expiry probe');
    const cancel=cancelRows.find(c=>c.key==='c02_sse_cancel:'+request.probeId);
    assert.ok(cancel&&!cancelUsed.has(cancel.key));cancelUsed.add(cancel.key);
    const observation=assertCancelObservation(journal,cancel,v.phase===held);
    if(v.phase===held){
      const tail=platform.events.find(t=>t.probeHeader===`c02-snapshot:${journal.runId}:${request.probeId}:${request.mode}`);
      assert.ok(tail,'Held marker alone cannot authorize cleanup');
      assertSseHostExpiryEvidence({journal,cancelRow:cancel,snapshotRow:p,tail,version:platform.version});
      platformCancelled++;
    }else{
      failedExperiments++;
      if(observation.phase==='request-aborted'){
        const {phase:observedPhase,...atCancel}=JSON.parse(observation.snapshotValue);
        const {phase:currentPhase,...current}=v;
        assert.ok([held,currentPhase].includes(observedPhase));assert.deepEqual(atCancel,current);
      }
    }
    if(intentOnly){
      unknown++;assert.deepEqual(rows.map(r=>r.length),[1,0,0,0,0,1]);const i=rows[0][0],b=rows[5][0];
      for(const r of [i,b]){assert.equal(r.user_id,journal.runId+'-user');assert.equal(r.api_key_id,journal.runId+'-key');}
      assert.equal(i.workspace_id,journal.runId+'-workspace');assert.equal(i.operation,'images.generations');assert.equal(i.attempt_index,1);
      assert.ok(['dispatch_claimed','outcome_unknown'].includes(i.state));assert.match(i.context_sha256,/^[a-f0-9]{64}$/);assert.match(i.dispatch_claim_id,new RegExp(`^${uuid}$`));
      assert.equal(b.state,'dispatched');assert.equal(b.reserved_micros,100000);assert.equal(b.settled_micros,0);assert.equal(b.terminal_at,null);assert.equal(b.terminal_reason,null);
      assert.ok(Number.isSafeInteger(b.budget_epoch)&&b.budget_epoch>=0);
    }else{
      committed++;assert.deepEqual(rows.map(r=>r.length),[1,1,1,1,1,1]);
      // Reuse the complete financial oracle, including receipt/lease/digest/amount and terminal reservation.
      // Its single-request SQL is NOT executed; this module builds global-scope guards for the whole mixed run.
      durableSseCleanupStatements(asLegacy(journal,request),rows);
      assert.equal(rows[1][0].payload_sha256,v.payloadSha256);
      assert.equal(hash(rows[1][0].payload_json),v.payloadSha256);
    }
  }
  for(let k=0;k<6;k++)for(const row of observed[k])statements.push(exact(tables[k],row));
  for(const p of [...probeRows,...cancelRows])statements.push(exact('system_config',p));
  // No budget settlement, TTL refund, fake receipt or fabricated zero-cost usage is created.
  // Delete the synthetic reservation and its synthetic owner in one caller transaction below.
  for(const k of [3,2,1,0,5])for(const row of observed[k])statements.push({sql:`DELETE FROM ${tables[k]} WHERE request_id=?`,params:[row.request_id]});
  for(const p of [...probeRows,...cancelRows])statements.push({sql:'DELETE FROM system_config WHERE key=? AND description=? AND value=?',params:[p.key,p.description,p.value]});
  return {statements,unknown,committed,platformCancelled,failedExperiments,experimentPassed:false,nativeCancellationCorrelated:platformCancelled===n};
}

export async function reconcileHostExpirySseStagingRun({api,batch,journal,nowMs,persist,platform={events:[]}}){
  assert.equal(typeof persist,'function');assert.ok(Number.isFinite(nowMs));
  // Close Access even if request metadata is incomplete; request validation gates DATA deletion later.
  const access=await closeSseStagingAccess({api,journal,persist});
  const db=await api(`/d1/database/${SSE_STAGING_SCOPE.database}`);
  assert.equal(db.uuid,SSE_STAGING_SCOPE.database);assert.equal(db.name,'cinatoken-staging');
  const fixture=await imageSseFixture(journal.runId,journal.keyHash,journal.expiresAt);
  await batch([fixture.revoke]);
  const notBefore=hostExpirySseCleanupNotBefore(journal);if(nowMs<notBefore)throw new SseCleanupPendingError(notBefore);
  const selected=selections(journal),sp=probeSelection(journal,true),up=probeSelection(journal,false),cp=cancelSelection(journal);
  const owners=[{sql:'SELECT id,metadata,budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',params:[fixture.ids.user]},
    {sql:'SELECT id,user_id,workspace_id,key_hash,status FROM api_keys WHERE id=?',params:[fixture.ids.key]}];
  const queries=[...selected.map(({sql,params})=>({sql,params})),sp,up,cp,...owners];
  const all=await batch(queries);assert.equal(all.length,11);
  const verifyAbsent=async()=>{
    const remaining=await batch([['workspaces',[fixture.ids.workspace]],['models',fixture.ids.models],['providers',fixture.ids.providers],['model_routes',fixture.ids.routes],['model_endpoints',fixture.ids.endpoints]].map(([table,ids])=>
      ({sql:`SELECT id FROM ${table} WHERE id IN (${ids.map(()=>'?').join(',')})`,params:ids})));
    assert.equal(remaining.length,5);assert.ok(remaining.every(r=>r.length===0),'Named fixture objects remain');
  };
  if(all.every(rows=>rows.length===0)){await verifyAbsent();return {access,fixtureRemoved:true,alreadyRemoved:true};}
  const [snapshotProbes,upstreamProbes,cancelRows,users,keys]=all.slice(6);assert.equal(users.length,1);assert.equal(keys.length,1);
  const plan=hostExpirySseCleanupStatements(journal,all.slice(0,6),snapshotProbes,cancelRows,platform);
  for(const tail of platform.events)assert.ok(Date.parse(tail.receivedAt)<=nowMs,'Future platform evidence');
  assert.equal(users[0].metadata,JSON.stringify({staging_fixture:journal.runId,purpose:'private-synthetic-images'}));
  assert.equal(users[0].budget_spent_micros,plan.committed*100000);assert.equal(users[0].budget_reserved_micros,plan.unknown*100000);
  assert.deepEqual({...keys[0]},{id:fixture.ids.key,user_id:fixture.ids.user,workspace_id:fixture.ids.workspace,key_hash:journal.keyHash,status:'revoked'});
  assert.equal(upstreamProbes.length,journal.probes.length);
  const upstreamDeletes=terminalSseProbeCleanup({...journal,requests:[]},upstreamProbes);
  for(const p of upstreamProbes){
    const value=JSON.parse(p.value);assert.equal(value.phase,'terminal');assert.equal(value.mode,'success');
    assert.equal(value.windowProfile,'completed-and-done');assert.ok(Array.isArray(value.events)&&value.events.length<=5);
    for(const phase of ['completed-enqueued','done-enqueued','terminal'])assert.equal(value.events.filter(e=>e.phase===phase).length,1);
    assert.equal(value.events.at(-1).phase,'terminal');assert.ok(['request_abort','response_cancel'].includes(value.events.at(-1).reason));
  }
  const statements=[exact('users',users[0]),exact('api_keys',keys[0]),
    guard(`(SELECT COUNT(*) FROM system_config WHERE ${up.where})=?`,[...up.params,upstreamProbes.length]),
    ...plan.statements,...upstreamDeletes,...fixture.cleanup];
  assert.ok(statements.length<=256&&statements.every(s=>s.params.length<=100&&Buffer.byteLength(s.sql)<=100000));
  assert.ok(Buffer.byteLength(JSON.stringify(statements))<=1024*1024,'Atomic fixture cleanup exceeds bounded transport');
  await persist({step:'host-expiry-sse-facts-observed',runId:journal.runId,observed:all.slice(0,6),snapshotProbes,upstreamProbes,cancelRows,platform,users,keys,
    unknown:plan.unknown,committed:plan.committed,platformCancelled:plan.platformCancelled,failedExperiments:plan.failedExperiments,
    experimentPassed:plan.experimentPassed,syntheticRemovalNotRefund:true});
  await batch(statements); // One atomic cleanup. Never split to fit a transport limit.
  const remaining=await batch(queries);assert.ok(remaining.every(rows=>rows.length===0));await verifyAbsent();
  await persist({step:'host-expiry-sse-cleanup-complete',runId:journal.runId});
  return {access,fixtureRemoved:true,alreadyRemoved:false,unknownFixturesRemoved:plan.unknown,committedFixturesRemoved:plan.committed,
    cancelObservationsRemoved:true,platformCancelled:plan.platformCancelled,failedExperiments:plan.failedExperiments,experimentPassed:plan.experimentPassed};
}
