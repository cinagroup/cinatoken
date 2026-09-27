import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {setupExpiryCleanup} from './images-sse-host-expiry-cleanup-fixture.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from '../../../../scripts/deploy/staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerCoordinator} from '../../../../scripts/deploy/staging-sse-capacity-peer-coordinator.mjs';
import {assertSseCapacityPeerAcceptance} from '../../../../scripts/deploy/staging-sse-capacity-peer-acceptance.mjs';
import {PEER_PROFILE,PEER_WATCH_URL} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol.mjs';
import {SSE_STAGING_SCOPE as g} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';

// ALL native envelopes/monotonic labels/peer counters here are LOCAL MODELS.
// Financial records come from the real SQLite handler fixture, not invented totals.
async function fixture(t,{persist:customPersist}={}){
  const f=await setupExpiryCleanup(t,'after-hold'),r=f.journal.requests[0],tail=f.platform.events[0];
  let ms=0,wall=r.startedAt,controller,sequence=0,spent=0;
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,wallNow:()=>wall});
  const at=(n,label=wall)=>{ms=n;wall=label;};
  const baseline={previousPublicHttp:382,firstRoundUsdCap:2};
  const session=createSseHostExpirySession({clock,baseline,input:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},
    version:f.platform.version,runId:f.journal.runId,keyHash:f.journal.keyHash,expiresAt:f.journal.expiresAt,tokenName:'cinatoken-sse-v211-'+randomUUID(),
    plans:[{mode:'after-hold',snapshot:{runId:f.journal.runId,probeId:r.probeId,mode:'after-hold'},upstream:f.journal.probes[0]},
      {mode:'before-hold',snapshot:{runId:f.journal.runId,probeId:randomUUID(),mode:'before-hold'},upstream:{runId:f.journal.runId,probeId:randomUUID(),mode:'success'}}],
    budget:{...baseline,capReset:false,maxPublicHttp:32,maxRpc:2}}});
  const instanceId=randomUUID(),peer=instanceId+':1',events=[],network=[];
  const headers=json=>({'Content-Type':json?'application/json':'application/x-ndjson','Cache-Control':'no-store','x-c02-capacity-instance':instanceId,'x-c02-capacity-peer':peer});
  const emit=(barrier,requests)=>controller.enqueue(Buffer.from(JSON.stringify({profile:PEER_PROFILE,kind:'sample',instanceId,watchEpoch:1,barrier,sequence:++sequence,maxRequests:1,maxReservedBytes:1024,requests,reservedBytes:requests*1024})+'\n'));
  const coordinator=createSseCapacityPeerCoordinator({session,reserve(){assert.ok(spent<32);spent++;},persist:async e=>{events.push(structuredClone(e));await customPersist?.(e);},fetchImpl:async(url,init)=>{
    network.push(url);if(url===PEER_WATCH_URL)return new Response(new ReadableStream({start(c){controller=c;emit(0,0);}}),{headers:headers(false)});
    const stage=init.headers.get('x-c02-capacity-barrier'),barrier=['held','post-native','post-recovery'].indexOf(stage)+1;
    emit(barrier,barrier===1?1:0);return Response.json({profile:PEER_PROFILE,kind:'barrier',instanceId,watchEpoch:1,barrier,stage},{headers:headers(true)});
  }});t.after(()=>coordinator.close());session.preflightComplete();
  const row=key=>({...f.db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get(key)});
  const snapshotRow=row(f.rowKey),cancelRow=row('c02_sse_cancel:'+r.probeId);
  const observation={snapshotRow,snapshot:JSON.parse(snapshotRow.value),upstream:JSON.parse(row('c02_images_sse_probe:'+r.upstreamProbeId).value),jobs:[{state:'pending'}],logs:[]};
  const facts=()=>({observed:f.financial(),probeRows:[row(f.rowKey)],cancelRows:[row('c02_sse_cancel:'+r.probeId)]});
  const send=async()=>new Response(null,{headers:{'Content-Type':'text/event-stream','X-Generation-Id':r.id,'x-c02-capacity-instance':instanceId}});
  const rpc=async({expected})=>({status:200,body:{status:'finished',runId:randomUUID(),retry_safe:false,result:{scanned:expected,claimed:expected,committed:expected,
    blocked:0,deferred:0,lostOwnership:0,uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false}}});
  const start=async()=>{
    await coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});
    at(1000,r.headersAt);await coordinator.dispatch(session.plan.plans[0],send);at(1100);await coordinator.held(observation);
    at(1200,r.cancelIssuedAt);coordinator.cancelPrimary();at(1300);await coordinator.finishPrimary();
    at(33000,tail.receivedAt);
    session.receive(Buffer.from(JSON.stringify({scriptName:g.worker,scriptVersion:{id:f.platform.version},outcome:'ok',eventTimestamp:tail.eventTimestamp,
      event:{request:{url:'https://'+g.domain+'/v1/images/generations',method:'POST',headers:{'x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1','x-c02-sse-snapshot':tail.probeHeader}},response:{status:200}},
      logs:tail.waitUntilWarnings.map(w=>({level:w.level,message:[w.message],timestamp:w.timestamp})),exceptions:[]})));
  };
  return {f,session,coordinator,at,observation,cancelRow,facts,send,rpc,start,network,events,get spent(){return spent;}};
}
test('local modeled end-to-end coordinator joins one primary, raw native projection and real SQLite financial rows',async t=>{
  const x=await fixture(t),before=x.f.financial();await x.start();
  await x.coordinator.native({observation:x.observation,cancelRow:x.cancelRow});x.at(34000);
  const result=await x.coordinator.recover({run:x.rpc,readFacts:x.facts});
  assert.equal(result.result,'AFTER_HOLD_PEER_EVIDENCE_PASS');assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);
  assert.equal(result.cleanupExecuted,false);assert.deepEqual(x.f.financial(),before);assert.equal(x.spent,7);assert.equal(x.network.length,4);
  assert.equal(x.session.requests.length,1);assert.equal(x.coordinator.report().state,'OBSERVED');
  assert.ok(x.events.some(e=>e.kind==='peer-joint-acceptance'));assert.doesNotMatch(JSON.stringify(x.events),/synthetic-not-real/);
});
test('joint validator rejects cross-stage/native/financial splice without database writes',async t=>{
  const x=await fixture(t);await x.start();await x.coordinator.native({observation:x.observation,cancelRow:x.cancelRow});x.at(34000);
  await x.coordinator.recover({run:x.rpc,readFacts:x.facts});const report=x.coordinator.report(),before=x.f.financial();
  for(const [label,change] of [
    ['second inference',v=>v.journal.requests.push(structuredClone(v.journal.requests[0]))],
    ['before-hold mode',v=>v.journal.requests[0].mode='before-hold'],['foreign primary',v=>v.primary.requestId='gen-'+randomUUID()],
    ['foreign pool',v=>v.primary.instanceId=randomUUID()],['headers from another clock',v=>v.primary.received.clockId=randomUUID()],
    ['late baseline',v=>v.peerReport.records[0].finished.monoMs=1050],['held after cancel',v=>v.held.received.monoMs=1250],
    ['held marker before DB',v=>v.peerReport.records[1].prerequisite.monoMs=1099],['changed held snapshot',v=>v.held.observation.snapshotRow.value+=' '],
    ['no pending job',v=>v.held.observation.jobs=[]],['existing log',v=>v.native.observation.logs=[{}]],
    ['missing DONE',v=>v.held.observation.upstream.events=v.held.observation.upstream.events.filter(e=>e.phase!=='done-enqueued')],
    ['reordered DONE',v=>v.held.observation.upstream.events.reverse()],['foreign upstream',v=>v.held.observation.upstream.probeId=randomUUID()],
    ['missing raw warning',v=>v.native.platform.events[0].waitUntilWarnings=[]],['wrong deployment',v=>v.native.platform.version=randomUUID()],
    ['missing raw native evidence',v=>v.native={nativeVerified:true}],['marker before native receipt',v=>v.peerReport.records[2].prerequisite.monoMs=1300],
    ['native from another clock',v=>v.native.platform.receipts[0].sample.clockId=randomUUID()],
    ['only first RPC',v=>v.recovery.calls.pop()],['RPC before native marker',v=>v.recovery.calls[0].started.monoMs=32900],
    ['uncertain RPC',v=>v.recovery.calls[0].body.result.uncertain=1],['duplicate RPC receipt',v=>v.recovery.calls[1].body.runId=v.recovery.calls[0].body.runId],
    ['marker before recovery facts',v=>v.peerReport.records[3].prerequisite.monoMs=33999],
    ['changed ledger',v=>v.recovery.afterDedup[4][0].charged_cost=0],['fake totals only',v=>v.recovery.afterRecovery=[[{}]]],
    ['lost snapshot',v=>v.recovery.probeRows=[]],['snapshot changed after recovery',v=>v.recovery.probeRows[0].value+=' '],
  ]){const v=structuredClone(report);change(v);assert.throws(()=>assertSseCapacityPeerAcceptance(v),label);}
  assert.deepEqual(x.f.financial(),before);
});
test('native validation failure stops before post-native marker or recovery RPC',async t=>{
  const x=await fixture(t);await x.start();const wrong=structuredClone(x.cancelRow);wrong.value=wrong.value.replace('request-aborted','armed');
  await assert.rejects(x.coordinator.native({observation:x.observation,cancelRow:wrong}));assert.equal(x.network.length,2);assert.equal(x.spent,3);
  assert.equal(x.coordinator.report().state,'FAILED');let called=0;
  await assert.rejects(x.coordinator.recover({run(){called++;},readFacts:x.facts}));assert.equal(called,0);
});
test('uncertain first recovery prevents second RPC and still exposes original completion sample',async t=>{
  const x=await fixture(t);await x.start();await x.coordinator.native({observation:x.observation,cancelRow:x.cancelRow});x.at(34000);let calls=0;
  await assert.rejects(x.coordinator.recover({run(){calls++;throw Error('Uncertain synthetic ACK');},readFacts:x.facts}));
  assert.equal(calls,1);assert.equal(x.network.length,3);assert.equal(x.spent,5);assert.ok(x.coordinator.report().lastRpcFinished);
});
test('uncertain primary response is never replayed',async t=>{
  const x=await fixture(t);await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});let sends=0;
  await assert.rejects(x.coordinator.dispatch(x.session.plan.plans[0],()=>{sends++;throw Error('Uncertain');}));
  await assert.rejects(x.coordinator.dispatch(x.session.plan.plans[0],x.send));assert.equal(sends,1);assert.equal(x.session.requests.length,1);assert.equal(x.spent,2);
});
test('fresh post-recovery snapshot is checked before the second RPC',async t=>{
  const x=await fixture(t);await x.start();await x.coordinator.native({observation:x.observation,cancelRow:x.cancelRow});x.at(34000);let calls=0;
  await assert.rejects(x.coordinator.recover({run:args=>{calls++;return x.rpc(args);},readFacts(){const f=x.facts();f.probeRows[0].value+=' ';return f;}}));
  assert.equal(calls,1);assert.equal(x.network.length,3);
});

test('close during fact read stops pending recovery and cannot start second RPC after a late callback',async t=>{
  const x=await fixture(t);await x.start();await x.coordinator.native({observation:x.observation,cancelRow:x.cancelRow});x.at(34000);
  let resolve,entered;const reached=new Promise(r=>entered=r);let calls=0;
  const pending=assert.rejects(x.coordinator.recover({run:args=>{calls++;return x.rpc(args);},readFacts(){entered();return new Promise(r=>resolve=r);}}));
  await reached;x.coordinator.close();await pending;resolve(x.facts());for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(calls,1);assert.equal(x.coordinator.report().state,'FAILED');assert.equal(x.network.length,3);
});
test('close aborts active RPC and does not rely on callback cooperation',async t=>{
  const x=await fixture(t);await x.start();await x.coordinator.native({observation:x.observation,cancelRow:x.cancelRow});x.at(34000);
  let signal,entered;const reached=new Promise(r=>entered=r);let calls=0;
  const pending=assert.rejects(x.coordinator.recover({run(args){calls++;signal=args.signal;entered();return new Promise(()=>{});},readFacts:x.facts}));
  await reached;x.coordinator.close();await pending;assert.equal(signal.aborted,true);assert.equal(calls,1);assert.ok(x.coordinator.report().lastRpcFinished);
});
test('dispatch journal failure consumes reservation but never invokes send',async t=>{
  const x=await fixture(t,{persist(e){if(e.kind==='peer-inference'&&e.result==='PENDING')throw Error('disk unavailable');}});
  await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});let sends=0;
  await assert.rejects(x.coordinator.dispatch(x.session.plan.plans[0],()=>{sends++;return x.send();}));
  assert.equal(sends,0);assert.equal(x.spent,2);assert.equal(x.coordinator.report().state,'FAILED');
});
test('late primary headers after close cannot revive a stopped coordinator',async t=>{
  const x=await fixture(t);await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});
  let resolve,entered;const reached=new Promise(r=>entered=r);let signal,cancelled=0;
  const p=assert.rejects(x.coordinator.dispatch(x.session.plan.plans[0],args=>{signal=args.signal;entered();return new Promise(r=>resolve=r);}));
  await reached;x.coordinator.close();await p;
  resolve(new Response(new ReadableStream({cancel(){cancelled++;}})));for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(x.coordinator.report().state,'FAILED');
});
test('wrong pool headers abort primary and prevent held marker',async t=>{
  const x=await fixture(t);await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});let signal;
  await assert.rejects(x.coordinator.dispatch(x.session.plan.plans[0],async args=>{signal=args.signal;const r=await x.send();r.headers.set('x-c02-capacity-instance',randomUUID());return r;}));
  assert.equal(signal.aborted,true);assert.equal(x.network.length,1);await assert.rejects(x.coordinator.held(x.observation));
});
test('another request cannot be inserted into the same session before dispatch',async t=>{
  const x=await fixture(t);await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});
  x.session.beginRequest(x.session.plan.plans[1]);let sends=0;
  await assert.rejects(x.coordinator.dispatch(x.session.plan.plans[0],()=>{sends++;return x.send();}));assert.equal(sends,0);assert.equal(x.spent,1);
});

test('forced stop captures first actual abort but does not invent body completion or successful outcome',async t=>{
  const x=await fixture(t);await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});
  x.at(1000);let signal;await x.coordinator.dispatch(x.session.plan.plans[0],args=>{signal=args.signal;return x.send();});
  x.at(1100);x.coordinator.close();const first=x.coordinator.report();assert.equal(signal.aborted,true);
  assert.equal(first.state,'STOPPED');assert.equal(first.forcedAbort.monoMs,1100);assert.equal(first.journal.requests[0].timing.finished,undefined);
  x.at(1200);x.coordinator.close();assert.deepEqual(x.coordinator.report().forcedAbort,first.forcedAbort);
  x.at(1300);x.coordinator.finishAbortedPrimary();const final=x.coordinator.report();
  assert.equal(final.journal.requests[0].timing.cancel.monoMs,1100);assert.equal(final.journal.requests[0].timing.finished.monoMs,1300);
  assert.equal(final.state,'STOPPED');assert.equal(final.decision,undefined);assert.equal(x.spent,2);
});
test('held observation failure keeps original forced-abort timing for failed-run native reconciliation',async t=>{
  const x=await fixture(t);await x.coordinator.open({'CF-Access-Client-Id':'synthetic','CF-Access-Client-Secret':'synthetic-not-real'});
  x.at(1000);await x.coordinator.dispatch(x.session.plan.plans[0],x.send);x.at(1100);
  const bad=structuredClone(x.observation);bad.upstream.windowProfile='completed-only';await assert.rejects(x.coordinator.held(bad));
  assert.equal(x.coordinator.report().state,'FAILED');assert.equal(x.coordinator.report().forcedAbort.monoMs,1100);
  x.at(1200);x.coordinator.finishAbortedPrimary();assert.equal(x.coordinator.report().state,'FAILED');assert.equal(x.network.length,1);
});
