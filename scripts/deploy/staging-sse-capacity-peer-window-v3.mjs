import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as gateway} from './staging-sse-reconciliation.mjs';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {imageSsePrompt} from '../../packages/proxy/scripts/staging/images-sse-probe-contract.ts';

/** The executable HTTP/body/native portion of ONE already-authorized staging
 * window. Setup must finish fresh preflight, tail/Access ownership and atomic
 * fixture seed first, using the SAME session/reserve as coordinator/finalizer.
 * This module never deploys, provisions, selects a paid model, or retries POST.
 * Native proof always comes from the original session collector.
 */
export function createSseCapacityPeerWindowV3({session,coordinator,finalizer,fixture,key,ownership,
  accessHeaders,fetchImpl=fetch,readObservation,readCancel,readFacts,runRecovery,persist,onWait}) {
  const {clock}=session;
  let running,reader,activeRead,readFinished=false,bodyTerminated=false,primaryEnd,requestDeadline,owned;
  const report={result:'NOT_RUN',primarySends:0,c02GatePassed:false,isolateEvictionProven:false};
  const read=()=>{
    readFinished=false;
    activeRead=reader.read().then(next=>{
      readFinished=true;if(next.done){bodyTerminated=true;primaryEnd=clock.sample();}return next;
    },error=>{readFinished=true;bodyTerminated=true;primaryEnd=clock.sample();throw error;});
    // Attach rejection handling at creation even when observation I/O precedes
    // the await. A transport rejection must not become an unhandled promise.
    activeRead.catch(()=>{});return activeRead;
  };
  async function bound(work,ms,deadline) {
    const stop=clock.after(clock.sample(),ms),ac=new AbortController();let timer;
    const left=()=>Math.min(clock.remaining(stop),deadline?clock.remaining(deadline):Infinity);
    try {
      assert.ok(left()>0,'Window deadline exceeded');
      const value=await Promise.race([Promise.resolve().then(()=>work(ac.signal)),
        new Promise((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(Error('window_timeout'));},left());})]);
      assert.ok(left()>0,'Window deadline exceeded');return value;
    }finally{clearTimeout(timer);ac.abort();}
  }
  const save=event=>bound(signal=>persist(structuredClone(event),{signal}),5000);
  // Called by the finalizer only after coordinator.close() aborted the original
  // fetch signal. Closing a reader is actual transport cleanup, not a synthetic
  // finished timestamp. Late completion after the finalizer's timeout cannot
  // call any coordinator transition.
  async function awaitPrimary() {
    assert.ok(reader,'No primary body owner');
    if(!bodyTerminated) {
      const cancelled=reader.cancel('peer_window_closed');cancelled.catch(()=>{});
      // The original fetch abort may already have errored the stream before
      // its first read. cancel() can then reject; still observe the real reader
      // below rather than treating the rejected cleanup call as completion.
      try { await cancelled; } catch { /* Does not establish body termination. */ }
      try { await activeRead; } catch { /* Actual pending read termination. */ }
      if(!bodyTerminated){
        try { const end=await read();assert.equal(end.done,true); }
        catch(error) { if(!bodyTerminated)throw error; }
      }
    }
    assert.equal(bodyTerminated,true);
  }
  const selected=()=>{
    const plan=session.plan.plans.find(p=>p.mode==='after-hold');assert.ok(plan);return plan;
  };
  async function native({signal}={}) {
    const entry=coordinator.report().journal.requests[0],plan=selected();assert.ok(entry?.id);
    const deadline=clock.after(clock.sample(),65000);
    // Bounded read-only polling of the original collector; never reconnect tail
    // or inject an event after the collector has failed.
    for(;;) {
      signal?.throwIfAborted();const platform=session.platform();
      if(platform.events.length)break;
      const left=clock.remaining(deadline);assert.ok(left>1,'Native warning unavailable');
      await clock.waitUntil(clock.after(clock.sample(),Math.min(1000,left-1)),{signal});
    }
    const cancelRow=await bound(inner=>readCancel({plan,id:entry.id,signal:signal?AbortSignal.any([inner,signal]):inner}),5000,deadline);
    const observation=await bound(inner=>readObservation({plan,id:entry.id,signal:signal?AbortSignal.any([inner,signal]):inner}),5000,deadline);
    assert.ok(Buffer.byteLength(JSON.stringify({cancelRow,observation}))<=16384);
    return {cancelRow,observation};
  }
  async function execute() {
    report.result='RUNNING';
    try {
      // Snapshot caller-owned inputs before the first await. No supplied model
      // can select a paid provider, and no later mutation can retarget cleanup.
      owned=structuredClone(ownership);
      const supplied=structuredClone(fixture),headers=new Headers(accessHeaders);
      assert.equal(session.requests.length,0);assert.equal(fixture.ids.runId,session.plan.runId);
      assert.equal(owned.runId,session.plan.runId);assert.equal(owned.tokenName,session.plan.tokenName);
      assert.equal(typeof key,'string');assert.ok(key.length>0&&key.length<=256);
      assert.equal('sha256:'+createHash('sha256').update(key).digest('hex'),session.plan.keyHash);
      assert.deepEqual([...headers.keys()].sort(),['cf-access-client-id','cf-access-client-secret']);
      for(const value of headers.values())assert.ok(value.length>0&&value.length<=4096);
      const trusted=await imageSseFixture(session.plan.runId,session.plan.keyHash,session.plan.expiresAt);
      assert.deepEqual(supplied.ids,trusted.ids);assert.deepEqual(supplied.cases,trusted.cases);
      session.assertWriteReady();
      const plan=selected();
      const primary=await coordinator.dispatch(plan,async({signal,primaryHeader})=>{
        assert.equal(report.primarySends,0);report.primarySends++;
        // Only the trusted private fixture model and protocol-derived prompt.
        // All diagnostic headers are internal and stripped by the gateway.
        return fetchImpl('https://'+gateway.domain+'/v1/images/generations',{
          method:'POST',redirect:'manual',cache:'no-store',signal,headers:{...Object.fromEntries(headers),Authorization:'Bearer '+key,'Content-Type':'application/json',
            'x-c02-capacity-primary':primaryHeader,'x-c02-sse-cancel-observe':'v1','x-c02-sse-host-expiry':'v1',
            'x-c02-sse-snapshot':`c02-snapshot:${session.plan.runId}:${plan.snapshot.probeId}:after-hold`},
          body:JSON.stringify({model:trusted.cases['small-generations'].model,prompt:imageSsePrompt(plan.upstream),stream:true}),
        });
      });
      // The outer deadline leaves a margin before the core's 90s emergency
      // signal. Failures call close() to capture the FIRST actual abort.
      requestDeadline=clock.after(primary.entry.timing.started,60000);
      assert.ok(primary.response.body);reader=primary.response.body.getReader();
      // Keep the sole original reader; the observer never reads, clones or tees
      // the inference body. Only its validated response DTO chooses the peer.
      await coordinator.watch(new Headers(headers));
      const decoder=new TextDecoder('utf-8',{fatal:true});let wire='';
      while(!wire.includes('\n\n')) {
        const next=await bound(()=>read(),15000,requestDeadline);assert.equal(next.done,false);
        assert.ok(next.value.length<=8192);wire+=decoder.decode(next.value,{stream:true});assert.ok(Buffer.byteLength(wire)<=8192);
      }
      assert.doesNotMatch(wire,/\[DONE\]/);
      assert.ok(wire.startsWith('data: '));const frame=JSON.parse(wire.trim().slice(6));
      assert.equal(frame.type,'image_generation.completed');assert.equal(frame.b64_json,'AQID');
      await save({step:'peer-window-completed',requestId:primary.entry.id,received:clock.sample()});
      read(); // Keep a real body read outstanding while held evidence is read.
      let held;
      for(let n=0;n<12;n++) {
        held=await bound(signal=>readObservation({plan,id:primary.entry.id,signal}),5000,requestDeadline);
        assert.ok(Buffer.byteLength(JSON.stringify(held))<=16384);
        if(held.snapshot?.phase==='held-after-insert')break;
        await clock.waitUntil(clock.after(clock.sample(),250));
      }
      assert.equal(readFinished,false,'Primary ended before intentional cancellation');
      await bound(()=>coordinator.held(held),5000,requestDeadline);
      assert.equal(readFinished,false,'Primary ended during held observation');
      coordinator.cancelPrimary();
      await bound(async signal=>{
        try { const next=await activeRead;assert.equal(next.done,true,'Unexpected frame at cancellation'); }
        catch(error) { assert.equal(error.name,'AbortError'); }
        signal.throwIfAborted();assert.equal(bodyTerminated,true);await coordinator.finishPrimary();
      },10000);
      await save({step:'peer-window-primary-ended',primaryEnd});
      await coordinator.native(await native());
      report.decision=await coordinator.recover({run:runRecovery,readFacts});
      report.result='OBSERVED';
    }catch {
      // Do this before asynchronous finalizer containment; otherwise transport
      // failure might leave the primary running until an unrelated API returns.
      coordinator.close();report.result='FAILED';
    }finally {
      report.finalization=await finalizer.finish({ownership:owned,awaitPrimary,readNative:native,runRecovery,onWait});
      if(report.finalization.result!=='CLOSED')report.result='ATTENTION_REQUIRED';
      if(reader&&bodyTerminated)reader.releaseLock();
      report.primaryEnd=primaryEnd;report.coordinator=coordinator.report();
      try { await save({step:'peer-window-complete',...report}); }
      catch { report.result='ATTENTION_REQUIRED';report.finalJournalFailed=true; }
    }
    return structuredClone(report);
  }
  return Object.freeze({run(){return running??=execute();},report:()=>structuredClone(report)});
}
