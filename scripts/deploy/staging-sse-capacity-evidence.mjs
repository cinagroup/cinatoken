import assert from 'node:assert/strict';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Bounded numeric evidence only. Does not prove native cancellation, routing
 * affinity, heap reclamation or completion of an unrelated invocation.
 */
export function assertSseCapacityObservation(value){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(),['profile','instanceId','maxRequests','maxReservedBytes','requests','reservedBytes'].sort());
  assert.equal(value.profile,'c02-sse-ownership-v1');assert.match(value.instanceId,uuid);
  assert.equal(value.maxRequests,1);assert.equal(value.maxReservedBytes,1024);
  assert.ok(value.requests===0||value.requests===1);
  assert.equal(value.reservedBytes,value.requests*1024);
  return Object.freeze({...value});
}
export function classifySseCapacityObservation(requestInstanceId,value){
  assert.match(requestInstanceId,uuid);const observed=assertSseCapacityObservation(value);
  if(observed.instanceId!==requestInstanceId)return {state:'different-instance',sameInstance:false,observed};
  return {state:observed.requests===0?'idle':'occupied',sameInstance:true,observed};
}
