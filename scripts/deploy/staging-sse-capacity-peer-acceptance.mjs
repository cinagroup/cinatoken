import assert from 'node:assert/strict';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';
import {assertSseHostExpiryEvidence} from './staging-sse-host-expiry-evidence-v3.mjs';
import {hostExpirySseCleanupStatements} from './staging-sse-host-expiry-reconciliation-v3.mjs';
import {classifySseCapacityPeerSequence} from './staging-sse-capacity-peer-client.mjs';

const bounded=(value,bytes)=>assert.ok(Buffer.byteLength(JSON.stringify(value))<=bytes,'Evidence exceeds bounded projection');
const exact=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),keys.slice().sort());

/** Validated bounded projection before it reaches the operator journal. */
export function assertSseCapacityHeldObservation(journal,observation){
  assert.equal(journal.requests.length,1);const request=journal.requests[0];assert.equal(request.mode,'after-hold');
  bounded(observation,16384);exact(observation,['snapshotRow','snapshot','upstream','jobs','logs']);
  const heldRow=observation.snapshotRow;
  exact(heldRow,['key','value','description']);assert.ok(Buffer.byteLength(heldRow.value)<=2048);
  const snapshot=JSON.parse(heldRow.value);
  assert.deepEqual(observation.snapshot,snapshot);
  exact(snapshot,['runId','probeId','mode','requestId','payloadSha256','phase','nativeResult']);
  assert.equal(snapshot.runId,journal.runId);assert.equal(snapshot.probeId,request.probeId);
  assert.equal(snapshot.mode,'after-hold');assert.equal(snapshot.requestId,request.id);assert.equal(snapshot.phase,'held-after-insert');
  assert.match(snapshot.payloadSha256,/^[a-f0-9]{64}$/);
  assert.equal(heldRow.key,'c02_sse_snapshot:'+request.probeId);assert.equal(heldRow.description,'c02-snapshot:'+journal.runId);
  exact(snapshot.nativeResult,['success','changes','rowsWritten','identityVerified']);
  assert.equal(snapshot.nativeResult.success,true);assert.equal(snapshot.nativeResult.identityVerified,true);
  assert.ok(Number.isSafeInteger(snapshot.nativeResult.changes)&&snapshot.nativeResult.changes>0);
  assert.ok(snapshot.nativeResult.rowsWritten===null||(Number.isSafeInteger(snapshot.nativeResult.rowsWritten)&&snapshot.nativeResult.rowsWritten>=0));
  assert.deepEqual(observation.jobs,[{state:'pending'}]);assert.deepEqual(observation.logs,[]);
  const upstream=observation.upstream;
  exact(upstream,['runId','probeId','mode','windowProfile','phase','events']);
  assert.equal(upstream.runId,journal.runId);assert.equal(upstream.probeId,request.upstreamProbeId);
  assert.equal(upstream.mode,'success');assert.equal(upstream.phase,'terminal');assert.equal(upstream.windowProfile,'completed-and-done');
  assert.ok(Array.isArray(upstream.events)&&upstream.events.length>=3&&upstream.events.length<=16);
  let previous=-1;
  for(const event of upstream.events){
    assert.ok(['started','body-prefix','completed-enqueued','done-enqueued','terminal'].includes(event.phase));
    assert.ok(Number.isSafeInteger(event.at)&&event.at>=previous);previous=event.at;
    for(const key of Object.keys(event))assert.ok(['phase','at','signalAborted','reason'].includes(key));
    if('signalAborted' in event)assert.equal(typeof event.signalAborted,'boolean');
    if('reason' in event)assert.ok(['request_abort','response_cancel','completed'].includes(event.reason));
  }
  const positions=['completed-enqueued','done-enqueued','terminal'].map(phase=>{
    assert.equal(upstream.events.filter(e=>e.phase===phase).length,1);return upstream.events.findIndex(e=>e.phase===phase);
  });
  assert.ok(positions[0]<positions[1]&&positions[1]<positions[2]);

  return heldRow;
}

/** Joins ORIGINAL, single-run evidence, not precomputed booleans or renamed
 * phases. Pure validation: no dispatch, SQL execution, refund, retry or cleanup.
 * The returned financial statement plan is deliberately NOT exposed/executed.
 * Call only after the live operator has captured and durably journaled inputs.
 */
export function assertSseCapacityPeerAcceptance({peerReport,journal,primary,held,native,recovery}){
  bounded(peerReport,16384);bounded(journal,16384);bounded(primary,1024);bounded(held,16384);bounded(native,16384);bounded(recovery,1048576);
  assert.equal(journal.requests.length,1,'Only one actual inference is supported');
  const request=journal.requests[0];assert.equal(request.mode,'after-hold');
  assert.equal(primary.requestId,request.id);assert.equal(primary.status,200);
  exact(primary,['requestId','status','instanceId','received']);
  assert.deepEqual(primary.received,request.timing.headers);
  const clockId=request.timing.started.clockId;
  const at=value=>assertOperatorSample(value,clockId);
  const stages=peerReport.records;
  // Validate all sequence/schema/time fields first; the state classification
  // itself is kept until after independent native/financial validation below.
  const logical=classifySseCapacityPeerSequence(peerReport,primary.instanceId);
  assert.ok(['LOGICAL_SEQUENCE_PASS','INCONCLUSIVE_HELD','OCCUPIED_AFTER_NATIVE_MARKER','OCCUPIED_AFTER_RECOVERY_MARKER'].includes(logical.result),
    'Peer sequence lacks required identity, order or clock evidence');
  assert.ok(at(stages[0].finished)<=at(request.timing.started),'Baseline must precede this inference');
  assert.ok(at(primary.received)<=at(held.received));
  assert.deepEqual(stages[1].prerequisite,held.received,'Held barrier must follow the original DB receipt');
  assert.ok(at(stages[1].finished)<=at(request.timing.cancel),'Held observation must precede client cancellation');

  const heldRow=assertSseCapacityHeldObservation(journal,held.observation);

  assert.equal(native.platform.events.length,1);assert.equal(native.platform.receipts.length,1);
  const tail=native.platform.events[0],receipt=native.platform.receipts[0];
  assert.deepEqual(native.observation.snapshotRow,heldRow,'Held row bytes changed across native cancellation');
  assert.deepEqual(native.observation.snapshot,held.observation.snapshot);
  assert.deepEqual(native.observation.jobs,[{state:'pending'}]);assert.deepEqual(native.observation.logs,[]);
  const proof=assertSseHostExpiryEvidence({journal,cancelRow:native.cancelRow,snapshotRow:native.observation.snapshotRow,
    tail,version:native.platform.version,receipts:native.platform.receipts});
  assert.equal(proof.requestId,primary.requestId);assert.equal(proof.clientClockOrderingVerified,true);
  assert.ok(at(receipt.sample)<=at(native.received));
  assert.deepEqual(stages[2].prerequisite,native.received,'Native barrier requires the same raw native observation receipt');

  assert.equal(recovery.calls.length,2);let prior=at(stages[2].finished);
  const recoveryRunIds=new Set();
  for(let i=0;i<2;i++){
    const call=recovery.calls[i];assert.equal(call.status,200);assert.ok(at(call.started)>=prior);
    prior=at(call.finished);assert.ok(prior>=at(call.started));
    assert.equal(call.body.status,'finished');assert.equal(call.body.retry_safe,false);
    assert.match(call.body.runId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.ok(!recoveryRunIds.has(call.body.runId));recoveryRunIds.add(call.body.runId);
    const result=call.body.result;
    exact(result,['scanned','claimed','committed','blocked','deferred','lostOwnership','uncertain','skipped','capacityLimited','admissionStopped']);
    for(const key of ['scanned','claimed','committed'])assert.equal(result[key],i===0?1:0);
    for(const key of ['blocked','deferred','lostOwnership','uncertain','skipped'])assert.equal(result[key],0);
    assert.equal(result.capacityLimited,false);assert.equal(result.admissionStopped,false);
  }
  assert.ok(at(recovery.received)>=prior);
  assert.deepEqual(stages[3].prerequisite,recovery.received,'Recovery marker must follow final facts and both original RPC receipts');
  assert.deepEqual(recovery.afterDedup,recovery.afterRecovery,'Dedup changed durable financial facts');
  assert.deepEqual(recovery.probeRows,[heldRow]);assert.deepEqual(recovery.cancelRows,[native.cancelRow]);
  // Reuse the frozen full-field durable ledger oracle, NOT a few charge totals.
  const financial=hostExpirySseCleanupStatements(journal,recovery.afterRecovery,recovery.probeRows,recovery.cancelRows,native.platform);
  assert.equal(financial.committed,1);assert.equal(financial.unknown,0);assert.equal(financial.platformCancelled,1);assert.equal(financial.experimentPassed,true);
  return Object.freeze({result:logical.result==='LOGICAL_SEQUENCE_PASS'?'AFTER_HOLD_PEER_EVIDENCE_PASS':logical.result,
    requestId:request.id,instanceId:primary.instanceId,nativeVerified:true,financialEvidenceValidated:true,
    samePoolIdleObserved:logical.result==='LOGICAL_SEQUENCE_PASS',c02GatePassed:false,isolateEvictionProven:false,
    cleanupExecuted:false,scope:'Single after-hold logical ownership observation, not physical capacity or full C02 acceptance'});
}
