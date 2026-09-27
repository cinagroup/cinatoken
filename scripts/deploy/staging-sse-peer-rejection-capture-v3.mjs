import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as gateway} from './staging-sse-reconciliation.mjs';

const target='https://'+gateway.domain+'/v1/images/generations';
const copy=v=>structuredClone(v);
const timedOut=Error('rejection_capture_timeout');
const reasons=new Map([
  ['profile_unavailable',404],['http_marker_unavailable',400],['invalid_primary',400],
  ['request_aborted',409],['identity_unavailable',503],['primary_busy',409],['primary_epoch_exhausted',503],
]);
const cancel=value=>{try{void Promise.resolve(value?.cancel()).catch(()=>{});}catch{}};
export const PEER_REJECTION_V3_LIMITS=Object.freeze({bytes:8192,reads:128,readMs:2000,persistMs:1000});

/** Local operator adapter, not a Worker. Reads only a non-200 response from
 * the one fixed inference POST. Never tees, retries, changes session timing,
 * or treats a gateway declaration as financial/native proof. */
export function createSsePeerRejectionCaptureV3({clock,persist,fetchImpl=fetch}) {
  assert.equal(typeof persist,'function');
  let attempts=0,fact,journalFailed=false,sealed=false,sealedReport,savesPending=0;
  const lifetime=new AbortController();
  const snapshot=()=>copy({inferenceAttempts:attempts,journalFailed,rejection:fact??null});
  const bounded=async(work,ms,signal)=>{
    const deadline=clock.after(clock.sample(),ms);let timer,onAbort;
    try {
      signal?.throwIfAborted();
      const value=await Promise.race([Promise.resolve().then(()=>{signal?.throwIfAborted();return work();}),new Promise((_,reject)=>{
        onAbort=()=>reject(Error('aborted'));signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
        timer=setTimeout(()=>reject(timedOut),clock.remaining(deadline));
      })]);
      signal?.throwIfAborted();if(clock.remaining(deadline)<=0)throw timedOut;return value;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  };
  const save=async()=>{
    if(sealed)return;
    savesPending++;
    try{await bounded(()=>persist({step:'peer-rejection',...copy(fact)}),PEER_REJECTION_V3_LIMITS.persistMs,lifetime.signal);}
    catch{journalFailed=true;}
    finally{savesPending--;}
  };
  async function capture(response,signal) {
    const generation=response.headers.get('X-Generation-Id');
    const contentType=response.headers.get('Content-Type');
    fact={status:response.status,headersReceived:clock.sample(),generationHeaderPresent:generation!==null,
      jsonMediaType:typeof contentType==='string'&&contentType.length<=128&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType),
      state:'HEADERS',bytesCaptured:0,readCalls:0,naturalEof:false,bodySha256:null,digestScope:'none',
      gatewayDeclaration:null,nativeProof:false,settlementProof:false,retryAllowed:false};
    let reader,ended=false;
    const bytes=Buffer.alloc(PEER_REJECTION_V3_LIMITS.bytes),hash=createHash('sha256');
    // Persist actual header receipt before waiting for any response byte.
    await save();
    try {
      if(journalFailed){fact.state='JOURNAL_FAILED';return;}
      if(!response.body){fact.state='NO_BODY';return;}
      reader=response.body.getReader();
      const deadline=clock.after(clock.sample(),PEER_REJECTION_V3_LIMITS.readMs);
      while(fact.readCalls<PEER_REJECTION_V3_LIMITS.reads){
        const left=clock.remaining(deadline);if(left<=0){fact.state='READ_TIMEOUT';break;}
        let next;
        try{fact.readCalls++;next=await bounded(()=>reader.read(),left,signal);}
        catch(error){fact.state=signal?.aborted?'ABORTED':error===timedOut?'READ_TIMEOUT':'READ_FAILED';break;}
        if(next.done){ended=true;fact.naturalEof=true;fact.eofReceived=clock.sample();fact.state='EOF';break;}
        if(!(next.value instanceof Uint8Array)){fact.state='INVALID_CHUNK';break;}
        const keep=Math.min(next.value.byteLength,bytes.length-fact.bytesCaptured);
        bytes.set(next.value.subarray(0,keep),fact.bytesCaptured);hash.update(next.value.subarray(0,keep));fact.bytesCaptured+=keep;
        if(keep<next.value.byteLength){fact.state='BYTE_LIMIT';break;}
      }
      if(fact.state==='HEADERS')fact.state='READ_LIMIT';
      fact.bodySha256=hash.digest('hex');fact.digestScope=ended?'complete':'prefix';
      if(ended&&fact.jsonMediaType&&!fact.generationHeaderPresent){
        try{
          const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,fact.bytesCaptured));
          // Exact canonical bytes from the frozen gateway; JSON.parse alone
          // would accept duplicate fields/extra properties and hide ambiguity.
          for(const [reason,status] of reasons)if(fact.status===status&&text===JSON.stringify({status:'rejected',reason,dispatch_started:false}))
            fact.gatewayDeclaration={reason,dispatch_started:false};
        }catch{ /* Invalid UTF-8 is evidence only, never a declaration. */ }
      }
    }catch{fact.state='READ_FAILED';}
    finally{
      if(!ended)cancel(reader??response.body);
      if(reader){try{reader.releaseLock();}catch{}}
      bytes.fill(0);fact.observationFinished=clock.sample();await save();
    }
  }
  return Object.freeze({
    async fetch(url,init){
      assert.equal(sealed,false,'Rejection capture is closed');
      if(url!==target||init?.method!=='POST')return fetchImpl(url,init);
      assert.equal(attempts,0,'Never replay inference through rejection capture');attempts++;
      const response=await fetchImpl(url,init);
      if(sealed||init.signal?.aborted){cancel(response.body);return response;}
      if(response.status!==200)await capture(response,init.signal?AbortSignal.any([init.signal,lifetime.signal]):lifetime.signal);
      return response; // Original identity/status; success body is untouched.
    },
    seal(){
      if(!sealed){sealed=true;if(savesPending)journalFailed=true;lifetime.abort();sealedReport=snapshot();}
      return copy(sealedReport);
    },
    report:()=>sealed?copy(sealedReport):snapshot(),
  });
}
