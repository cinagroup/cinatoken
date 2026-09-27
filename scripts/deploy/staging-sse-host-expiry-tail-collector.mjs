import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractSseHostExpiryTail,SseTailValidationError} from './staging-sse-host-expiry-evidence-v2.mjs';

/** Operator-local collector. Never stores raw headers, arbitrary error messages or log text.
 * First failure is immutable; a subsequent transport close cannot hide the rejecting stage.
 */
export function createSseHostExpiryTailCollector({version,probeHeaders}){
  assert.match(version,/^[a-f0-9-]{36}$/);assert.ok(Array.isArray(probeHeaders)&&probeHeaders.length>0&&probeHeaders.length<=2);
  assert.equal(new Set(probeHeaders).size,probeHeaders.length);
  const state={bytes:0,messages:0,unmatched:0,events:[],firstFailure:null};
  const snapshot=()=>structuredClone(state);
  function fail(code,at,detail={}){
    assert.ok(['transport-error','transport-close','message-type','byte-budget','message-budget','json','correlation','deployment','duplicate','event-budget','validation'].includes(code));
    if(!state.firstFailure)state.firstFailure={code,at,...detail};return snapshot();
  }
  function receive(data,at){
    if(state.firstFailure)return snapshot();
    if(!Buffer.isBuffer(data))return fail('message-type',at);
    state.messages++;state.bytes+=data.length;
    if(data.length>131072||state.bytes>524288)return fail('byte-budget',at,{messageBytes:data.length});
    if(state.messages>8)return fail('message-budget',at);
    const digest=createHash('sha256').update(data).digest('hex');let raw;
    try{raw=JSON.parse(data.toString());}catch{return fail('json',at,{messageBytes:data.length,sha256:digest});}
    let event;
    try{event=extractSseHostExpiryTail(raw,at);}catch(e){
      // Only closed enums/counts plus a digest are retained even when the envelope is invalid.
      const outcome=['ok','canceled','exception','exceededCpu','exceededMemory'].includes(raw?.outcome)?raw.outcome:'other';
      return fail('validation',at,{stage:e instanceof SseTailValidationError?e.code:'internal',sha256:digest,messageBytes:data.length,outcome,
        responsePresent:raw?.event?.response!==undefined,logCount:Array.isArray(raw?.logs)?Math.min(raw.logs.length,65):null,exceptionCount:Array.isArray(raw?.exceptions)?Math.min(raw.exceptions.length,65):null});
    }
    if(!event){state.unmatched++;return snapshot();}
    if(!probeHeaders.includes(event.probeHeader))return fail('correlation',at,{sha256:digest});
    if(event.version!==version)return fail('deployment',at,{sha256:digest});
    if(state.events.some(e=>e.probeHeader===event.probeHeader))return fail('duplicate',at,{sha256:digest});
    if(state.events.length>=probeHeaders.length)return fail('event-budget',at,{sha256:digest});
    state.events.push(event);return snapshot();
  }
  return {receive,transportError:at=>fail('transport-error',at),transportClose:at=>fail('transport-close',at),snapshot};
}
