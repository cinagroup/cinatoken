import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';
import {assertSseCapacityPrimaryV3,assertSseCapacityPeerV3Record,PEER_V3_STAGES} from './staging-sse-capacity-peer-protocol-v3.mjs';
import {assertSseCapacityHeldObservation} from './staging-sse-capacity-peer-acceptance.mjs';
import {assertSseHostExpiryEvidence} from './staging-sse-host-expiry-evidence-v3.mjs';
import {hostExpirySseCleanupStatements} from './staging-sse-host-expiry-reconciliation-v3.mjs';

const exact=(value,keys)=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());};
const bounded=(value,bytes)=>assert.ok(Buffer.byteLength(JSON.stringify(value))<=bytes,'Evidence exceeds bounded projection');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const mismatchBytes=Buffer.from('{"status":"rejected","reason":"peer_not_active_here","dispatch_started":false}');
const mismatchHash=createHash('sha256').update(mismatchBytes).digest('hex');
const noProof=result=>Object.freeze({result,nativeVerified:false,c02GatePassed:false,isolateEvictionProven:false});

/** V3-native sequence validation. Never rename V3 into V2 or change its occupied
 * baseline. Inputs must be the original sealed client report, not reconstructed
 * timestamps. This pure check cannot establish their remote/journal provenance.
 */
export function assertSseCapacityPeerV3Sequence(report,primary) {
  bounded(report,16384);bounded(primary,1024);
  const p=assertSseCapacityPrimaryV3(primary),clockId=p.received.clockId,at=v=>assertOperatorSample(v,clockId);
  exact(report,['profile','primary','stopped','failed',...('error' in report?['error']:[]),'endedAt',
    'journalPending','journalUnconfirmed','upgradeAttempts','markerAttempts','upgrades','records','parser',
    'nativeVerified','c02GatePassed','isolateEvictionProven']);
  assert.equal(report.profile,'c02-sse-peer-client-v3');assert.deepEqual(report.primary,p);
  assert.equal(report.stopped,true,'Only a sealed observer report is accepted');assert.equal(report.failed,false);
  assert.equal(report.error,undefined);assert.equal(report.journalPending,false);assert.equal(report.journalUnconfirmed,false);
  for(const key of ['nativeVerified','c02GatePassed','isolateEvictionProven'])assert.equal(report[key],false);
  assert.ok(Number.isInteger(report.upgradeAttempts)&&report.upgradeAttempts>=1&&report.upgradeAttempts<=8);
  assert.equal(report.upgrades.length,report.upgradeAttempts);assert.equal(report.markerAttempts,3);assert.equal(report.records.length,4);
  const baseline=report.records[0];
  exact(baseline,['kind','stage','peer','started','result','status','sample','received','upgradeAttempt','finished']);
  assert.equal(baseline.kind,'capacity-peer-v3');assert.equal(baseline.stage,'baseline');assert.equal(baseline.result,'PASS');
  assert.equal(baseline.peer,p.peer);assert.equal(baseline.status,101);assert.equal(baseline.upgradeAttempt,report.upgradeAttempts);
  const primaryAt=at(p.received),baselineStart=at(baseline.started),baselineAt=at(baseline.received),baselineFinish=at(baseline.finished);
  assert.ok(primaryAt<=baselineStart&&baselineStart<=baselineAt&&baselineAt<=baselineFinish);
  assert.ok(baselineFinish<=primaryAt+20000,'Discovery exceeded original primary window');
  let previous=baselineStart;
  for(let i=0;i<report.upgrades.length;i++){
    const row=report.upgrades[i],matched=i===report.upgrades.length-1;
    exact(row,['kind','attempt','peer','started','result','dispatched','status','headersAt','finished',
      ...(matched?['openedAt']:['rejectionBytes','rejectionComplete','rejectionSha256'])]);
    assert.equal(row.kind,'capacity-peer-v3-upgrade');assert.equal(row.attempt,i+1);assert.equal(row.peer,p.peer);
    const start=at(row.started),sent=at(row.dispatched),headers=at(row.headersAt),finished=at(row.finished);
    assert.ok(previous<=start&&start<=sent&&sent<=headers&&headers<=finished);
    assert.ok(finished<=primaryAt+20000);previous=finished;
    if(matched){
      assert.equal(row.result,'MATCH');assert.equal(row.status,101);
      const opened=at(row.openedAt);assert.ok(headers<=opened&&opened<=baselineAt&&baselineAt<=finished&&finished<=baselineFinish);
      assert.ok(baselineAt<=sent+5001,'Upgrade/baseline exceeded handshake bound');
    }else{
      assert.equal(row.result,'MISMATCH');assert.equal(row.status,409);assert.equal(row.rejectionComplete,true);
      assert.equal(row.rejectionBytes,mismatchBytes.length);assert.equal(row.rejectionSha256,mismatchHash);
      assert.ok(finished<=sent+5001,'Mismatch exceeded handshake bound');
      assert.ok(finished<=headers+1001,'Rejection exceeded bounded EOF wait');
    }
  }
  const first=assertSseCapacityPeerV3Record(baseline.sample,p.peer);
  assert.equal(first.kind,'sample');assert.equal(first.sequence,1);assert.equal(first.barrier,0);assert.equal(first.requests,1);
  let sequence=1;previous=baselineFinish;
  for(let i=1;i<4;i++){
    const row=report.records[i];
    exact(row,['kind','stage','peer','attempt','prerequisite','started','result','sent','barrier','acknowledged','sample','received','sendConfirmed','finished']);
    assert.equal(row.kind,'capacity-peer-v3');assert.equal(row.stage,PEER_V3_STAGES[i-1]);assert.equal(row.peer,p.peer);
    assert.equal(row.attempt,i);assert.equal(row.result,'PASS');
    const prerequisite=at(row.prerequisite),start=at(row.started),sent=at(row.sent),acknowledged=at(row.acknowledged),received=at(row.received);
    const confirmed=at(row.sendConfirmed),finished=at(row.finished);
    assert.ok(previous<=prerequisite&&prerequisite<=start&&start<=sent&&sent<=acknowledged&&acknowledged<=received&&received<=finished);
    assert.ok(sent<=confirmed&&confirmed<=finished);assert.ok(received<=sent+5001&&confirmed<=sent+5001,'Marker exceeded bounded wait');
    const ack=assertSseCapacityPeerV3Record(row.barrier,p.peer),sample=assertSseCapacityPeerV3Record(row.sample,p.peer);
    assert.equal(ack.kind,'barrier');assert.equal(ack.barrier,i);assert.equal(sample.kind,'sample');assert.equal(sample.barrier,i);
    assert.ok(sample.sequence>sequence);sequence=sample.sequence;previous=finished;
  }
  const stats=report.parser;
  exact(stats,['frames','bytes','sequence','barrier','issued','awaitingSample','ended','failed']);
  assert.equal(stats.failed,false);assert.equal(stats.awaitingSample,false);assert.equal(stats.barrier,3);assert.equal(stats.issued,3);
  assert.equal(typeof stats.ended,'boolean');assert.ok(integer(stats.sequence)&&stats.sequence>=sequence&&stats.sequence<=180);
  assert.equal(stats.frames,stats.sequence+3+(stats.ended?1:0));
  assert.ok(integer(stats.bytes)&&stats.bytes>=stats.frames&&stats.bytes<=stats.frames*512&&stats.bytes<=184*512);
  const ended=at(report.endedAt);assert.ok(ended>=previous&&ended<=primaryAt+180001);
  if(report.records[1].sample.requests!==1)return noProof('INCONCLUSIVE_HELD');
  if(report.records[2].sample.requests!==0)return noProof('OCCUPIED_AFTER_NATIVE_MARKER');
  if(report.records[3].sample.requests!==0)return noProof('OCCUPIED_AFTER_RECOVERY_MARKER');
  return noProof('LOGICAL_SEQUENCE_PASS');
}

/** Pure original-evidence join. Call only after the live operator durably saves
 * the sealed observer report and original session/native/D1 facts. No SQL is
 * executed or exposed, no cleanup/refund/dispatch/recovery/replay is performed.
 * Local modeled native envelopes validate shape only, never cloud acceptance.
 */
export function assertSseCapacityPeerAcceptanceV3({peerReport,journal,primary,held,native,recovery}) {
  bounded(journal,16384);bounded(held,16384);bounded(native,16384);bounded(recovery,1048576);
  const logical=assertSseCapacityPeerV3Sequence(peerReport,primary);
  assert.equal(journal.requests.length,1,'One original inference only');
  const request=journal.requests[0],stages=peerReport.records,clockId=request.timing.started.clockId,at=v=>assertOperatorSample(v,clockId);
  assert.equal(request.mode,'after-hold');assert.equal(primary.requestId,request.id);assert.equal(request.responseStatus,200);
  assert.deepEqual(primary.received,request.timing.headers);assert.ok(at(request.timing.started)<=at(primary.received));
  assert.ok(at(primary.received)<=at(stages[0].started),'V3 watch must follow primary headers');
  exact(held,['observation','received']);assert.ok(at(stages[0].finished)<=at(held.received));
  assert.deepEqual(stages[1].prerequisite,held.received);assert.ok(at(stages[1].finished)<=at(request.timing.cancel));
  const heldRow=assertSseCapacityHeldObservation(journal,held.observation);
  exact(native,['observation','cancelRow','platform','received']);exact(native.platform,['events','receipts','version']);
  assert.equal(native.platform.events.length,1);assert.equal(native.platform.receipts.length,1);
  assert.deepEqual(native.observation,held.observation,'Held/native rows and pending state must be unchanged');
  const receipt=native.platform.receipts[0];
  const proof=assertSseHostExpiryEvidence({journal,cancelRow:native.cancelRow,snapshotRow:native.observation.snapshotRow,
    tail:native.platform.events[0],version:native.platform.version,receipts:native.platform.receipts});
  assert.equal(proof.requestId,primary.requestId);assert.equal(proof.clientClockOrderingVerified,true);
  assert.ok(at(receipt.sample)<=at(native.received));assert.deepEqual(stages[2].prerequisite,native.received);
  exact(recovery,['calls','afterRecovery','afterDedup','probeRows','cancelRows','received']);
  assert.equal(recovery.calls.length,2);const runIds=new Set();let previous=at(stages[2].finished);
  for(let i=0;i<2;i++){
    const call=recovery.calls[i];exact(call,['started','attempt','result','finished','status','body']);
    assert.equal(call.attempt,i+1);assert.equal(call.result,'ACK');assert.equal(call.status,200);
    assert.ok(at(call.started)>=previous);previous=at(call.finished);assert.ok(previous>=at(call.started));
    assert.ok(previous<=at(call.started)+30001,'RPC exceeded bounded original attempt');
    exact(call.body,['status','runId','retry_safe','result']);assert.equal(call.body.status,'finished');assert.equal(call.body.retry_safe,false);
    assert.match(call.body.runId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.ok(!runIds.has(call.body.runId));runIds.add(call.body.runId);
    const result=call.body.result;
    exact(result,['scanned','claimed','committed','blocked','deferred','lostOwnership','uncertain','skipped','capacityLimited','admissionStopped']);
    for(const key of ['scanned','claimed','committed'])assert.equal(result[key],i===0?1:0);
    for(const key of ['blocked','deferred','lostOwnership','uncertain','skipped'])assert.equal(result[key],0);
    assert.equal(result.capacityLimited,false);assert.equal(result.admissionStopped,false);
  }
  assert.ok(at(recovery.received)>=previous);assert.deepEqual(stages[3].prerequisite,recovery.received);
  assert.deepEqual(recovery.afterDedup,recovery.afterRecovery);assert.deepEqual(recovery.probeRows,[heldRow]);assert.deepEqual(recovery.cancelRows,[native.cancelRow]);
  // Reuse the full immutable ledger oracle, not a total-cost approximation.
  // Its returned SQL plan stays private and is never executed by this validator.
  const financial=hostExpirySseCleanupStatements(journal,recovery.afterRecovery,recovery.probeRows,recovery.cancelRows,native.platform);
  assert.equal(financial.committed,1);assert.equal(financial.unknown,0);assert.equal(financial.platformCancelled,1);assert.equal(financial.experimentPassed,true);
  return Object.freeze({result:logical.result==='LOGICAL_SEQUENCE_PASS'?'AFTER_HOLD_PEER_V3_EVIDENCE_PASS':logical.result,
    requestId:request.id,instanceId:primary.instanceId,nativeVerified:true,financialEvidenceValidated:true,
    samePoolIdleObserved:logical.result==='LOGICAL_SEQUENCE_PASS',c02GatePassed:false,isolateEvictionProven:false,cleanupExecuted:false,
    scope:'Single V3 after-hold logical ownership observation; not physical capacity or full C02 acceptance'});
}
