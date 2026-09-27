import assert from 'node:assert/strict';
export const PEER_ORIGIN='https://cinatoken-proxy-staging.cinagroup.workers.dev';
export const PEER_WATCH_URL=PEER_ORIGIN+'/__staging/sse-capacity/watch-v2';
export const PEER_BARRIER_URL=PEER_ORIGIN+'/__staging/sse-capacity/barrier-v2';
export const PEER_PROFILE='c02-sse-peer-v2';
export const PEER_STAGES=Object.freeze(['held','post-native','post-recovery']);
export const PEER_MAX_BYTES=181*512;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const keys=(v,k)=>{assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),k.sort());};
export function parseCapacityPeer(value){
  assert.equal(typeof value,'string');assert.ok(value.length<=53);
  const [instanceId,epoch,...extra]=value.split(':');assert.match(instanceId,uuid);assert.equal(extra.length,0);
  assert.match(epoch,/^[1-9][0-9]{0,15}$/);const watchEpoch=Number(epoch);assert.ok(Number.isSafeInteger(watchEpoch));
  return Object.freeze({instanceId,watchEpoch});
}
export function assertPeerRecord(value,peer){
  const identity=parseCapacityPeer(peer);
  const common=['profile','kind','instanceId','watchEpoch'];
  if(value?.kind==='sample'){
    keys(value,[...common,'barrier','sequence','maxRequests','maxReservedBytes','requests','reservedBytes']);
    assert.ok(Number.isInteger(value.sequence)&&value.sequence>=1&&value.sequence<=180);
    assert.ok(Number.isInteger(value.barrier)&&value.barrier>=0&&value.barrier<=3);
    assert.equal(value.maxRequests,1);assert.equal(value.maxReservedBytes,1024);
    assert.ok(value.requests===0||value.requests===1);assert.equal(value.reservedBytes,value.requests*1024);
  }else if(value?.kind==='barrier'){
    keys(value,[...common,'barrier','stage']);assert.ok(Number.isInteger(value.barrier)&&value.barrier>=1&&value.barrier<=3);
    assert.equal(value.stage,PEER_STAGES[value.barrier-1]);
  }else{
    keys(value,[...common,'reason']);assert.equal(value.kind,'end');assert.ok(['deadline','sample-limit'].includes(value.reason));
  }
  assert.equal(value.profile,PEER_PROFILE);assert.equal(value.instanceId,identity.instanceId);assert.equal(value.watchEpoch,identity.watchEpoch);
  return Object.freeze({...value});
}

/** Incremental fixed-wire parser. Buffers at most one <=511-byte partial line.
 * JSON must be canonical, preventing duplicate fields and hidden whitespace.
 * The returned batch has <=181 records; total received bytes remain bounded.
 */
export function createCapacityPeerParser(peer){
  parseCapacityPeer(peer);let partial=new Uint8Array(0),bytes=0,sequence=0,barrier=0,ended=false,failed=false;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  return Object.freeze({
    push(chunk){
      assert.ok(!failed);
      try{
        assert.ok(chunk instanceof Uint8Array&&chunk.byteLength>0);bytes+=chunk.byteLength;assert.ok(bytes<=PEER_MAX_BYTES);
        const rows=[];let start=0;
        for(let i=0;i<chunk.length;i++){
          assert.ok(!ended,'Data after diagnostic end');
          if(chunk[i]!==10){assert.ok(partial.length+i-start<511);continue;}
          const size=partial.length+i-start;assert.ok(size>0&&size<=511);
          const line=new Uint8Array(size);line.set(partial);line.set(chunk.subarray(start,i),partial.length);
          partial=new Uint8Array(0);start=i+1;
          const text=decoder.decode(line),value=JSON.parse(text);assert.equal(JSON.stringify(value),text);
          const row=assertPeerRecord(value,peer);assert.notEqual(row.kind,'barrier');
          if(row.kind==='sample'){
            assert.equal(row.sequence,sequence+1);assert.ok(row.barrier>=barrier);
            sequence=row.sequence;barrier=row.barrier;
          }else{
            assert.ok(sequence>0);if(row.reason==='sample-limit')assert.equal(sequence,180);ended=true;
          }
          rows.push(row);
        }
        if(start<chunk.length){
          assert.ok(!ended);const next=new Uint8Array(partial.length+chunk.length-start);
          assert.ok(next.length<=511);next.set(partial);next.set(chunk.subarray(start),partial.length);partial=next;
        }
        return rows;
      }catch(error){failed=true;partial=new Uint8Array(0);throw error;}
    },
    finish(){assert.ok(!failed&&ended&&partial.length===0,'Truncated peer stream');},
    stats(){return Object.freeze({bytes,sequence,barrier,ended,failed,partialBytes:partial.length});},
  });
}
