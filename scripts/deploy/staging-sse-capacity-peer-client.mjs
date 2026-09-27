import assert from 'node:assert/strict';
import {assertOperatorSample} from './staging-sse-operator-clock.mjs';
import {PEER_WATCH_URL,PEER_BARRIER_URL,PEER_STAGES,parseCapacityPeer,assertPeerRecord,createCapacityPeerParser} from './staging-sse-capacity-peer-protocol.mjs';
const copy=v=>Object.freeze(structuredClone(v));
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};
class PeerFailure extends Error {constructor(code){super(code);this.code=code;}}

/** Node operator only. One watch GET and at most three diagnostic POSTs.
 * No inference, RPC, automatic retry or cloud management mutation. A lost ACK
 * consumes the attempt and stops the client, even if its marker took effect.
 */
export function createSseCapacityPeerClient({clock,fetchImpl=fetch,reserve,persist}){
  assert.equal(typeof fetchImpl,'function');assert.equal(typeof reserve,'function');assert.equal(typeof persist,'function');
  assertOperatorSample(clock.sample(),clock.clockId);
  const abort=new AbortController();
  let opened=false,busy=false,stopped=false,failed=false,headers,peer,reader,ackReader,parser,lifetime;
  let queue=[],stage=0,attempt=0,previousFinished;
  const records=[];
  const report=()=>copy({profile:'c02-sse-peer-client-v2',peer,stopped,failed,attempts:attempt,records});
  const stop=()=>{stopped=true;headers=undefined;clearTimeout(lifetime);abort.abort();cancel(reader);cancel(ackReader);queue=[];};
  const bounded=async(work,ms,code,ignoreAbort=false)=>{
    if(!ignoreAbort&&abort.signal.aborted)throw new PeerFailure('stopped');
    let timer,onAbort;
    const deadline=clock.after(clock.sample(),ms);
    const expired=new Promise((_,reject)=>{
      onAbort=()=>reject(new PeerFailure('stopped'));if(!ignoreAbort)abort.signal.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>reject(new PeerFailure(code)),clock.remaining(deadline));
    });
    try{
      const value=await Promise.race([Promise.resolve().then(work),expired]);
      if(clock.remaining(deadline)===0)throw new PeerFailure(code);
      return value;
    }
    finally{clearTimeout(timer);abort.signal.removeEventListener('abort',onAbort);}
  };
  const journal=async(record,final=false)=>{
    try{await bounded(()=>persist(copy(record)),5000,'journal',final);}
    catch{throw new PeerFailure('journal');}
  };
  const responseContract=(response,url,type)=>{
    assert.equal(response.status,200);assert.equal(response.redirected,false);assert.ok(!response.url||response.url===url);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.ok(new RegExp('^'+type+'(?:;\\s*charset=utf-8)?$','i').test(response.headers.get('content-type')??''));
    const p=response.headers.get('x-c02-capacity-peer');const id=parseCapacityPeer(p);
    assert.equal(response.headers.get('x-c02-capacity-instance'),id.instanceId);if(peer)assert.equal(p,peer);
    assert.ok(response.body);return p;
  };
  const send=async(url,init)=>{
    const response=await fetchImpl(url,{...init,redirect:'manual',cache:'no-store',signal:abort.signal});
    if(abort.signal.aborted){cancel(response.body);throw new PeerFailure('stopped');}
    return response;
  };
  const sample=async(target)=>{
    for(;;){
      if(abort.signal.aborted)throw new PeerFailure('stopped');
      if(!queue.length){
        const next=await reader.read();if(abort.signal.aborted)throw new PeerFailure('stopped');
        if(next.done)throw new PeerFailure('stream_eof');
        queue=parser.push(next.value);if(parser.stats().ended)throw new PeerFailure('stream_end');
      }
      if(!queue.length)continue;
      const row=queue.shift();
      if(row.kind==='end')throw new PeerFailure('stream_end');
      assert.ok(row.barrier<=target,'Unissued barrier observed');
      if(row.barrier===target)return row;
      // A delayed earlier-stage sample cannot satisfy a newer barrier.
    }
  };
  const run=async(kind,after,work)=>{
    assert.ok(!busy&&!stopped&&!failed,'Peer client unavailable');busy=true;
    const record={kind:'capacity-peer',stage:kind,attempt:++attempt,started:clock.sample(),result:'PENDING'};
    if(after!==undefined)record.prerequisite=copy(after);
    let response;
    try{
      try{reserve();}catch{throw new PeerFailure('budget');}
      await journal(record);
      await bounded(async()=>{await work(record,r=>{response=r;});},5000,'timeout');
      record.finished=clock.sample();assert.ok(assertOperatorSample(record.finished,record.started.clockId)>=record.started.monoMs);
      record.result='PASS';await journal(record);records.push(copy(record));previousFinished=record.finished;
      return copy(record);
    }catch(error){
      failed=true;record.result='FAIL';record.error=error instanceof PeerFailure?error.code:'contract_or_transport';
      record.finished=clock.sample();const final=copy(record);records.push(final);stop();
      // Final journal is best effort after an aborted/lost transport. It is still
      // bounded and sanitized; failure never permits another network attempt.
      try{await journal(final,true);}catch{}
      cancel(response?.body);throw new PeerFailure(final.error);
    }finally{busy=false;}
  };
  return Object.freeze({
    async open(accessHeaders){
      assert.ok(!opened&&!busy&&!stopped);headers=new Headers(accessHeaders);
      assert.deepEqual([...headers.keys()].sort(),['cf-access-client-id','cf-access-client-secret']);
      for(const value of headers.values())assert.ok(value.length>0&&value.length<=4096);
      opened=true;lifetime=setTimeout(()=>{failed=true;stop();},185000);
      return run('baseline',undefined,async(record,setResponse)=>{
        const h=new Headers(headers);h.set('x-c02-capacity-watch','v2');
        const response=await send(PEER_WATCH_URL,{method:'GET',headers:h});setResponse(response);
        record.status=response.status;peer=responseContract(response,PEER_WATCH_URL,'application/x-ndjson');
        const length=response.headers.get('content-length');
        if(length!==null)assert.ok(/^(0|[1-9][0-9]*)$/.test(length)&&Number(length)<=181*512);
        reader=response.body.getReader();parser=createCapacityPeerParser(peer);
        record.sample=await sample(0);assert.equal(record.sample.sequence,1);assert.equal(record.sample.requests,0);
        record.received=clock.sample();record.peer=peer;
      });
    },
    async phase(name,{after}){
      assert.ok(opened&&peer&&!busy&&!stopped&&!failed);assert.equal(name,PEER_STAGES[stage]);
      const at=assertOperatorSample(after,clock.clockId);assert.ok(at>=previousFinished.monoMs&&at<=clock.sample().monoMs);
      const target=stage+1;stage++;
      return run(name,after,async(record,setResponse)=>{
        const h=new Headers(headers);h.set('x-c02-capacity-peer',peer);h.set('x-c02-capacity-barrier',name);
        const response=await send(PEER_BARRIER_URL,{method:'POST',headers:h});setResponse(response);
        record.status=response.status;responseContract(response,PEER_BARRIER_URL,'application/json');
        ackReader=response.body.getReader();const ownedAckReader=ackReader;let bytes=0;const chunks=[];
        try{
          for(;;){const next=await ownedAckReader.read();if(abort.signal.aborted)throw new PeerFailure('stopped');if(next.done)break;
            assert.ok(next.value instanceof Uint8Array&&next.value.byteLength>0);bytes+=next.value.byteLength;assert.ok(bytes<=512);chunks.push(Buffer.from(next.value));}
        }finally{cancel(ownedAckReader);if(ackReader===ownedAckReader)ackReader=undefined;}
        const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,bytes));
        const value=JSON.parse(raw);assert.equal(JSON.stringify(value),raw);
        record.barrier=assertPeerRecord(value,peer);assert.equal(value.kind,'barrier');assert.equal(value.barrier,target);
        record.acknowledged=clock.sample();record.sample=await sample(target);record.received=clock.sample();record.peer=peer;
      });
    },
    getPeer(){assert.ok(opened&&peer&&!failed&&!stopped&&records[0]?.result==='PASS');return peer;},
    stop,report,
  });
}

/** Logical causal sequence only. Does NOT validate native tail, actual primary
 * identity provenance, settlement, physical memory, or grant the C02 gate.
 */
export function classifySseCapacityPeerSequence(report,requestInstanceId){
  const no=reason=>Object.freeze({result:reason,nativeVerified:false,c02GatePassed:false,isolateEvictionProven:false});
  if(report?.failed)return no('INCONCLUSIVE_CLIENT');
  try{
    assert.equal(report.profile,'c02-sse-peer-client-v2');const id=parseCapacityPeer(report.peer);
    if(id.instanceId!==requestInstanceId)return no('INCONCLUSIVE_INSTANCE');
    assert.equal(report.records.length,4);assert.equal(report.attempts,4);
    let sequence=0,previous=-1,clockId;
    for(let i=0;i<4;i++){
      const r=report.records[i];assert.equal(r.result,'PASS');assert.equal(r.stage,i?PEER_STAGES[i-1]:'baseline');
      assert.equal(r.peer,report.peer);assert.equal(r.attempt,i+1);assert.equal(r.status,200);
      clockId??=r.started.clockId;const started=assertOperatorSample(r.started,clockId);
      assert.ok(started>=previous);if(i){
        const prerequisite=assertOperatorSample(r.prerequisite,clockId);assert.ok(prerequisite>=previous&&prerequisite<=started);
        const ack=assertPeerRecord(r.barrier,report.peer);assert.equal(ack.kind,'barrier');assert.equal(ack.barrier,i);
        const ackAt=assertOperatorSample(r.acknowledged,clockId);assert.ok(ackAt>=started&&ackAt<=r.received.monoMs);
      }
      const row=assertPeerRecord(r.sample,report.peer);assert.equal(row.kind,'sample');assert.equal(row.barrier,i);
      assert.ok(row.sequence>sequence);if(!i)assert.equal(row.sequence,1);sequence=row.sequence;
      const received=assertOperatorSample(r.received,clockId);previous=assertOperatorSample(r.finished,clockId);
      assert.ok(received>=started&&previous>=received);
    }
    if(report.records[0].sample.requests!==0)return no('INCONCLUSIVE_BASELINE');
    if(report.records[1].sample.requests!==1)return no('INCONCLUSIVE_HELD');
    if(report.records[2].sample.requests!==0)return no('OCCUPIED_AFTER_NATIVE_MARKER');
    if(report.records[3].sample.requests!==0)return no('OCCUPIED_AFTER_RECOVERY_MARKER');
    return no('LOGICAL_SEQUENCE_PASS');
  }catch{return no('INCONCLUSIVE_EVIDENCE');}
}
