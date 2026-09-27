import assert from 'node:assert/strict';
import {snapshotSseCleanupNotBefore,reconcileSnapshotSseStagingRun} from './staging-sse-snapshot-reconciliation-v2.mjs';
import {exactStagingRowGuard} from './staging-sql-row-guard.mjs';

function selection(journal) {
  snapshotSseCleanupNotBefore(journal);
  assert.ok(journal.requests.length>0&&journal.requests.length<=2);
  assert.ok(journal.requests.every(r=>['before-hold','after-hold'].includes(r.mode)));
  const keys=journal.requests.map(r=>'c02_sse_cancel:'+r.probeId);
  const where=`description=? OR key IN (${keys.map(()=>'?').join(',')})`;
  return {where,params:['c02-cancel:'+journal.runId,...keys],
    sql:`SELECT key,value,description FROM system_config WHERE ${where} ORDER BY key LIMIT 3`};
}
export function assertCancelObservation(journal,row,requireHeld=false) {
  selection(journal);
  const request=journal.requests.find(r=>'c02_sse_cancel:'+r.probeId===row.key);assert.ok(request);
  assert.equal(row.description,'c02-cancel:'+journal.runId);
  assert.equal(typeof row.value,'string');assert.ok(Buffer.byteLength(row.value)<=4096);
  const v=JSON.parse(row.value),base=['runId','probeId','mode','phase'];
  assert.equal(v.runId,journal.runId);assert.equal(v.probeId,request.probeId);assert.equal(v.mode,request.mode);
  if(v.phase==='armed'){
    assert.equal(requireHeld,false,'Native cancellation not observed');assert.deepEqual(Object.keys(v).sort(),base.sort());return v;
  }
  assert.equal(v.phase,'request-aborted');
  assert.deepEqual(Object.keys(v).sort(),[...base,'requestId','at','signalAborted','snapshotValue'].sort());
  assert.equal(v.requestId,request.id);assert.equal(v.signalAborted,true);
  assert.equal(new Date(v.at).toISOString(),v.at);
  assert.equal(typeof v.snapshotValue,'string');assert.ok(v.snapshotValue.length<=2048);
  const s=JSON.parse(v.snapshotValue);
  assert.equal(s.runId,journal.runId);assert.equal(s.probeId,request.probeId);assert.equal(s.mode,request.mode);
  assert.equal(s.requestId,request.id);assert.match(s.payloadSha256,/^[a-f0-9]{64}$/);
  if(requireHeld)assert.equal(s.phase,request.mode==='before-hold'?'held-before-insert':'held-after-insert');
  return v;
}

/** Extend the existing financial oracle/atomic cleanup with independent observation rows.
 * Never rewrite its financial observations or split the final native transaction.
 * Armed rows may be removed after a FAILED experiment; that does not prove cancellation.
 */
export async function reconcileCancelledSseStagingRun(options) {
  const {journal,batch,persist}=options,selected=selection(journal);
  let appended=false;
  const result=await reconcileSnapshotSseStagingRun({...options,batch:async statements=>{
    const deleting=statements.some(s=>s.sql.startsWith('DELETE FROM request_dispatch_intents'));
    if(!deleting)return batch(statements);
    assert.equal(appended,false,'Only one atomic fixture removal is supported');appended=true;
    const [rows]=await batch([{sql:selected.sql,params:selected.params}]);
    assert.equal(rows.length,journal.requests.length);const keys=new Set();
    for(const row of rows){assertCancelObservation(journal,row);assert.ok(!keys.has(row.key));keys.add(row.key);}
    await persist({step:'cancel-observations-before-cleanup',runId:journal.runId,rows});
    const guards=[{sql:`SELECT CASE WHEN (SELECT COUNT(*) FROM system_config WHERE ${selected.where})=? THEN 1 ELSE json('cancel_scope_changed') END`,
      params:[...selected.params,rows.length]},...rows.map(r=>exactStagingRowGuard('system_config',r))];
    const deletes=rows.map(r=>({sql:'DELETE FROM system_config WHERE key=? AND description=? AND value=?',params:[r.key,r.description,r.value]}));
    const combined=[...guards,...statements,...deletes];
    assert.ok(combined.length<=256&&combined.every(s=>s.params.length<=100&&Buffer.byteLength(s.sql)<=100000));
    assert.ok(Buffer.byteLength(JSON.stringify(combined))<=1048576);
    return batch(combined);
  }});
  const [remaining]=await batch([{sql:selected.sql,params:selected.params}]);assert.deepEqual(remaining,[]);
  return {...result,cancelObservationsRemoved:true};
}
