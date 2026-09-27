import assert from 'node:assert/strict';
import {createSseCapacityPeerClientV3} from './staging-sse-capacity-peer-client-v3.mjs';
import {assertSseHostExpiryEvidence} from './staging-sse-host-expiry-evidence-v3.mjs';
import {hostExpirySseCleanupStatements} from './staging-sse-host-expiry-reconciliation-v3.mjs';
import {assertSseCapacityHeldObservation} from './staging-sse-capacity-peer-acceptance.mjs';
import {assertSseCapacityPeerAcceptanceV3} from './staging-sse-capacity-peer-acceptance-v3.mjs';
import {captureSseCapacityPrimaryV3} from './staging-sse-capacity-peer-protocol-v3.mjs';
const copy=v=>structuredClone(v);
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};

/** Live single-case glue, with no I/O at import time. The outer operator still
 * owns exact ingress/tail/token closure, key revoke, safety wait and DB cleanup.
 * Callback implementations must use the existing fixed staging transports.
 */
export function createSseCapacityPeerCoordinatorV3({session,reserve,persist,socketFactory}){
  const {clock}=session;
  const lifecycle=new AbortController();
  let state='NEW',entry,requestScope,response,primary,held,native,recovery,decision,forcedAbort;
  const peer=createSseCapacityPeerClientV3({clock,reserve,persist,socketFactory});
  const stop=()=>{
    // Capture the FIRST actual abort, including a failure-triggered abort. This
    // preserves evidence for the outer failed-run cleanup without changing the
    // failed outcome or pretending the downstream read has already finished.
    if(entry?.timing.headers&&!entry.timing.cancel&&requestScope){
      session.cancelRequest(entry,requestScope.abort);forcedAbort=copy(entry.timing.cancel);
    }
    lifecycle.abort();peer.stop();requestScope?.abort();requestScope?.dispose();cancel(response?.body);
  };
  const journal=()=>({runId:session.plan.runId,keyHash:session.plan.keyHash,expiresAt:session.plan.expiresAt,
    tokenName:session.plan.tokenName,requests:entry?[{id:entry.id,mode:entry.mode,probeId:entry.probeId,upstreamProbeId:entry.upstreamProbeId,
      startedAt:entry.startedAt,headersAt:entry.headersAt,finishedAt:entry.finishedAt,cancelIssuedAt:entry.cancelIssuedAt,responseStatus:entry.status,timing:copy(entry.timing)}]:[],
    probes:entry?[copy(session.plan.plans.find(p=>p.snapshot.probeId===entry.probeId).upstream)]:[]});
  const bound=async(work,ms=5000)=>{
    assert.equal(lifecycle.signal.aborted,false);
    const deadline=clock.after(clock.sample(),ms);let timer,onAbort;
    try{
      const value=await Promise.race([Promise.resolve().then(()=>{lifecycle.signal.throwIfAborted();return work();}),new Promise((_,reject)=>{
        onAbort=()=>reject(Error('coordinator_stopped'));lifecycle.signal.addEventListener('abort',onAbort,{once:true});
        timer=setTimeout(()=>reject(Error('coordinator_timeout')),clock.remaining(deadline));
      })]);
      assert.ok(clock.remaining(deadline)>0);lifecycle.signal.throwIfAborted();return value;
    }finally{clearTimeout(timer);lifecycle.signal.removeEventListener('abort',onAbort);}
  };
  const save=event=>bound(()=>persist(copy(event)));
  const step=async(expected,next,work)=>{
    assert.equal(state,expected,'Unexpected or concurrent peer coordinator step');state=next;
    try{return await work();}catch{state='FAILED';stop();throw Error('peer_coordinator_failed');}
  };
  const facts=()=>copy({journal:journal(),primary,held,native,recovery,peerReport:peer.report()});
  return Object.freeze({
    // V3 has no watch-first entry: only the original response can identify a peer.
    watch:headers=>step('PRIMARY','WATCHING',async()=>{const r=await peer.open(primary,headers);state='WATCHED';return r;}),
    dispatch:(plan,send)=>step('NEW','DISPATCHING',async()=>{
      assert.equal(plan.mode,'after-hold');assert.ok(session.plan.plans.includes(plan));assert.equal(session.requests.length,0);
      assert.equal(typeof send,'function');entry=session.beginRequest(plan);requestScope=session.abortScope(90000);
      assert.equal(reserve(),undefined,'Public-call reservation must be synchronous');
      await save({kind:'peer-inference',result:'PENDING',entry:copy(entry)});
      // Even a non-cooperative late callback must not hand out a usable response.
      response=await bound(async()=>{
        const r=await send({signal:requestScope.signal,primaryHeader:'v3',entry:copy(entry)});
        if(state!=='DISPATCHING'||requestScope.signal.aborted){cancel(r?.body);throw Error('late_response');}return r;
      },15000);
      session.markHeaders(entry,response);
      primary=captureSseCapacityPrimaryV3(response,entry.timing.headers,clock.clockId);
      await save({kind:'peer-inference',result:'HEADERS',primary});state='PRIMARY';return {response,entry:copy(entry)};
    }),
    held:observation=>step('WATCHED','HOLDING',async()=>{
      assertSseCapacityHeldObservation(journal(),observation);
      held={observation:copy(observation),received:clock.sample()};await save({kind:'peer-held',...held});
      const r=await peer.phase('held',{after:held.received});assert.equal(r.sample.requests,1);state='HELD';return r;
    }),
    cancelPrimary(){assert.equal(state,'HELD');state='CANCELLING';session.cancelRequest(entry,requestScope.abort);},
    finishPrimary:()=>step('CANCELLING','FINISHING',async()=>{
      // Caller must await the real pending body read ending before this method.
      session.finishRequest(entry);requestScope.dispose();await save({kind:'peer-inference',result:'CANCELLED',entry:copy(entry)});state='CANCELLED';
    }),
    native:input=>step('CANCELLED','NATIVE_CHECKING',async()=>{
      assert.ok(Buffer.byteLength(JSON.stringify(input))<=16384);
      assert.deepEqual(Object.keys(input).sort(),['cancelRow','observation']);
      const platform=session.platform();assert.equal(platform.events.length,1);
      assert.deepEqual(input.observation,held.observation);
      assert.deepEqual(input.observation.jobs,[{state:'pending'}]);assert.deepEqual(input.observation.logs,[]);
      const proof=assertSseHostExpiryEvidence({journal:journal(),cancelRow:input.cancelRow,snapshotRow:input.observation.snapshotRow,
        tail:platform.events[0],version:platform.version,receipts:platform.receipts});
      assert.equal(proof.requestId,entry.id);
      native={...copy(input),platform,received:clock.sample()};await save({kind:'peer-native',...native});
      // A raw native proof must pass BEFORE issuing the post-native marker.
      const result=await peer.phase('post-native',{after:native.received});state='NATIVE';return result;
    }),
    recover:({run,readFacts})=>step('NATIVE','RECOVERING',async()=>{
      assert.equal(typeof run,'function');assert.equal(typeof readFacts,'function');
      recovery={calls:[],afterRecovery:undefined,afterDedup:undefined};
      for(let i=0;i<2;i++){
        assert.equal(reserve(),undefined,'Public-call reservation must be synchronous');const call={started:clock.sample(),attempt:i+1,result:'PENDING'};recovery.calls.push(call);await save({kind:'peer-recovery',...call});
        const value=await session.rpc((signal)=>bound(()=>run({signal:AbortSignal.any([signal,lifecycle.signal]),expected:i===0?1:0}),30000));
        call.finished=copy(session.lastRpcFinished);assert.ok(Buffer.byteLength(JSON.stringify(value))<=8192);
        call.status=value.status;call.body=copy(value.body);call.result='ACK';
        assert.equal(call.status,200);assert.equal(call.body.status,'finished');assert.equal(call.body.retry_safe,false);
        assert.deepEqual(Object.keys(call.body).sort(),['result','retry_safe','runId','status']);
        assert.match(call.body.runId,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
        if(i)assert.notEqual(call.body.runId,recovery.calls[0].body.runId);
        for(const key of ['scanned','claimed','committed'])assert.equal(call.body.result[key],i===0?1:0);
        for(const key of ['blocked','deferred','lostOwnership','uncertain','skipped'])assert.equal(call.body.result[key],0);
        assert.equal(call.body.result.capacityLimited,false);assert.equal(call.body.result.admissionStopped,false);
        await save({kind:'peer-recovery',...call});
        const fresh=await bound(readFacts);assert.ok(Buffer.byteLength(JSON.stringify(fresh))<=1048576);
        assert.deepEqual(Object.keys(fresh).sort(),['cancelRows','observed','probeRows']);
        assert.deepEqual(fresh.probeRows,[native.observation.snapshotRow]);assert.deepEqual(fresh.cancelRows,[native.cancelRow]);
        recovery.probeRows=copy(fresh.probeRows);recovery.cancelRows=copy(fresh.cancelRows);const rows=fresh.observed;
        recovery[i===0?'afterRecovery':'afterDedup']=copy(rows);
        if(i===0){
          const proof=hostExpirySseCleanupStatements(journal(),rows,recovery.probeRows,recovery.cancelRows,native.platform);
          assert.equal(proof.committed,1);assert.equal(proof.unknown,0);assert.equal(proof.experimentPassed,true);
        }else assert.deepEqual(rows,recovery.afterRecovery);
      }
      recovery.received=clock.sample();await save({kind:'peer-recovery-facts',...recovery});
      await peer.phase('post-recovery',{after:recovery.received});
      // Seal first; durably record the exact joined inputs before invoking the
      // pure oracle. A lost journal ACK cannot become a successful observation.
      peer.stop();const evidence=facts();
      await save({kind:'peer-v3-sealed-evidence',...evidence});
      decision=assertSseCapacityPeerAcceptanceV3(evidence);
      await save({kind:'peer-joint-acceptance-v3',decision});state='OBSERVED';return decision;
    }),
    finishAbortedPrimary(){
      // Outer finally calls this ONLY after its real pending body read settles.
      assert.ok(['FAILED','STOPPED'].includes(state)&&entry?.timing.cancel);
      return session.finishRequest(entry);
    },
    report:()=>copy({profile:'c02-sse-peer-coordinator-v3',state,decision,forcedAbort,lastRpcFinished:session.lastRpcFinished,...facts()}),
    close(){stop();if(state!=='FAILED'&&state!=='OBSERVED')state='STOPPED';},
  });
}
