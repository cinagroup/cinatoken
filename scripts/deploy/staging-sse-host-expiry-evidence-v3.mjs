import assert from 'node:assert/strict';
import {assertSseHostExpiryEvidence as assertNative} from './staging-sse-host-expiry-clock-incident-evidence.mjs';
import {assertSseOperatorTiming} from './staging-sse-operator-clock.mjs';

/** Same native invocation/snapshot proof, plus newly captured monotonic client evidence.
 * Historical incident records are never upgraded by supplying synthetic clock offsets.
 */
export function assertSseHostExpiryEvidence({journal,cancelRow,snapshotRow,tail,version,receipts}){
  const native=assertNative({journal,cancelRow,snapshotRow,tail,version});
  const request=journal.requests.find(r=>r.id===native.requestId);
  assert.ok(Array.isArray(receipts)&&receipts.length>0&&receipts.length<=2);
  const seen=new Set();
  for(const r of receipts){
    assert.deepEqual(Object.keys(r).sort(),['probeHeader','sample']);assert.ok(!seen.has(r.probeHeader));seen.add(r.probeHeader);
    assert.ok(journal.requests.some(q=>r.probeHeader===`c02-snapshot:${journal.runId}:${q.probeId}:${q.mode}`));
  }
  const receipt=receipts.find(r=>r.probeHeader===tail.probeHeader);assert.ok(receipt,'Missing native tail monotonic receipt');
  const timing=assertSseOperatorTiming(request.timing,receipt.sample);
  for(const [field,marker] of [['startedAt','started'],['headersAt','headers'],['cancelIssuedAt','cancel'],['finishedAt','finished']])
    assert.equal(request[field],request.timing[marker].wallAt,'Audit labels must match original clock samples');
  assert.equal(tail.receivedAt,receipt.sample.wallAt);
  return {requestId:native.requestId,mode:native.mode,kind:native.kind,isolateEvictionProven:false,...timing};
}
