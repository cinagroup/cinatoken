import assert from 'node:assert/strict';
import {assertSseCapacityPrimaryV3,isSseCapacityPeerV3Mismatch} from './staging-sse-capacity-peer-protocol-v3.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Pure additional evidence. Transport must supply the original primary DTO,
 * rejection headers/bytes and observed natural EOF from the same attempt.
 * No I/O, body reads, counter resets, retry decisions or native/financial claims.
 */
export function classifySsePeerV3MismatchDiagnostic({primary,status,headers,body,complete}) {
  const actual=assertSseCapacityPrimaryV3(primary,primary?.received?.clockId);
  assert.equal(isSseCapacityPeerV3Mismatch({status,headers,body,complete}),true,'Original complete V3 mismatch required');
  assert.equal(headers.get('x-c02-peer-diagnostic'),'instance-v1');
  const instance=headers.get('x-c02-peer-observed-instance');
  assert.ok(typeof instance==='string'&&instance.length===36&&uuid.test(instance),'Original bounded server instance required');
  const sameInstance=instance===actual.instanceId;
  return Object.freeze({profile:'c02-sse-peer-mismatch-instance-v1',requestId:actual.requestId,primaryPeer:actual.peer,
    observedInstance:instance,sameInstance,classification:sameInstance?'epoch_mismatch':'instance_mismatch',
    // Same UUID + canonical V3 mismatch narrows the frozen branch to an
    // unequal/zero eligible epoch. It does not disclose that epoch or its cause.
    epochValueKnown:false,capacityProof:false,nativeProof:false,retryAuthorization:false});
}
