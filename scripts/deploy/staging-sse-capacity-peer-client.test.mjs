import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {createSseCapacityPeerClient,classifySseCapacityPeerSequence} from './staging-sse-capacity-peer-client.mjs';
import {PEER_PROFILE,PEER_WATCH_URL,PEER_BARRIER_URL} from './staging-sse-capacity-peer-protocol.mjs';
const credentials={'CF-Access-Client-Id':'synthetic-client','CF-Access-Client-Secret':'synthetic-secret-do-not-log'};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function fixture(t,options={}){
  const instanceId=randomUUID(),peer=instanceId+':1',journal=[],calls=[];
  let ns=0n,controller,sequence=0,reserved=0,cancelled=0;
  const clock=createSseOperatorClock({readNs:()=>ns++,wallNow:()=> '2026-09-09T00:00:00.000Z'});
  const tick=ms=>{ns+=BigInt(ms)*1000000n;t.mock.timers.tick(ms);};
  const row=(barrier=0,requests=barrier===1?1:0)=>({profile:PEER_PROFILE,kind:'sample',instanceId,watchEpoch:1,barrier,sequence:++sequence,maxRequests:1,maxReservedBytes:1024,requests,reservedBytes:requests*1024});
  const emit=value=>controller.enqueue(Buffer.from(JSON.stringify(value)+'\n'));
  const responseHeaders=(json=false)=>({'Content-Type':json?'application/json':'application/x-ndjson','Cache-Control':'no-store','x-c02-capacity-instance':instanceId,'x-c02-capacity-peer':peer});
  const fetchImpl=async(url,init)=>{
    calls.push({url,init});assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(journal.at(-1).result,'PENDING');
    if(options.fetch)return options.fetch(url,init,{peer,instanceId,responseHeaders});
    if(url===PEER_WATCH_URL){
      assert.equal(init.headers.get('x-c02-capacity-watch'),'v2');
      return new Response(new ReadableStream({start(c){controller=c;emit(row());},cancel(){cancelled++;}}),{headers:responseHeaders()});
    }
    assert.equal(url,PEER_BARRIER_URL);assert.equal(init.method,'POST');assert.equal(init.body,undefined);
    assert.equal(init.headers.get('x-c02-capacity-peer'),peer);
    const stage=init.headers.get('x-c02-capacity-barrier'),barrier=['held','post-native','post-recovery'].indexOf(stage)+1;
    if(options.phase)return options.phase({barrier,stage,row,emit,responseHeaders,peer,instanceId,controller});
    emit(row(barrier-1)); // Old network-buffered row cannot satisfy this barrier.
    emit(row(barrier));
    return Response.json({profile:PEER_PROFILE,kind:'barrier',instanceId,watchEpoch:1,barrier,stage},{headers:responseHeaders(true)});
  };
  const client=createSseCapacityPeerClient({clock,fetchImpl,reserve(){reserved++;options.reserve?.();},
    async persist(r){journal.push(r);await options.persist?.(r);}});
  t.after(()=>client.stop());
  return {client,clock,tick,advance(ms){ns+=BigInt(ms)*1000000n;},journal,calls,peer,instanceId,emit,row,get reserved(){return reserved;},get cancelled(){return cancelled;}};
}
test('one watch plus three barrier attempts; stale frames skipped and logical scope stays explicit',async t=>{
  const f=fixture(t);await f.client.open(credentials);assert.equal(f.client.getPeer(),f.peer);
  for(const stage of ['held','post-native','post-recovery'])await f.client.phase(stage,{after:f.clock.sample()});
  const report=f.client.report();assert.equal(f.reserved,4);assert.equal(f.calls.length,4);assert.equal(f.journal.length,8);
  assert.deepEqual(report.records.map(r=>r.sample.sequence),[1,3,5,7]);
  const decision=classifySseCapacityPeerSequence(report,f.instanceId);
  assert.equal(decision.result,'LOGICAL_SEQUENCE_PASS');assert.equal(decision.nativeVerified,false);assert.equal(decision.c02GatePassed,false);
  assert.ok(!JSON.stringify(report).includes(credentials['CF-Access-Client-Secret']));
  await assert.rejects(f.client.open(credentials));await assert.rejects(f.client.phase('post-recovery',{after:f.clock.sample()}));
  assert.equal(f.reserved,4);f.client.stop();assert.equal(f.cancelled,1);assert.throws(()=>f.client.getPeer());
});
test('out of order or foreign-clock prerequisite fails before budget and network',async t=>{
  const f=fixture(t);await f.client.open(credentials);
  await assert.rejects(f.client.phase('post-native',{after:f.clock.sample()}));
  await assert.rejects(f.client.phase('held',{after:{...f.clock.sample(),clockId:randomUUID()}}));
  assert.equal(f.reserved,1);assert.equal(f.calls.length,1);
});
test('budget failure prevents fetch and poisons the client',async t=>{
  const f=fixture(t,{reserve(){throw Error('SECRET');}});await assert.rejects(f.client.open(credentials),/budget/);
  assert.equal(f.calls.length,0);assert.equal(f.reserved,1);await assert.rejects(f.client.open(credentials));
  assert.equal(JSON.stringify(f.client.report()).includes('SECRET'),false);
});
test('write-ahead journal failure prevents network, no retry',async t=>{
  const f=fixture(t,{persist(){throw Error('SECRET');}});await assert.rejects(f.client.open(credentials),/journal/);
  assert.equal(f.calls.length,0);assert.equal(f.reserved,1);assert.equal(f.client.report().failed,true);
});
for(const status of [302,403,409,500])test('unexpected status '+status+' does not consume response body or retry',async t=>{
  let pulls=0,cancels=0;
  const f=fixture(t,{fetch(){return new Response(new ReadableStream({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0}),{status});}});
  await assert.rejects(f.client.open(credentials),/contract_or_transport/);assert.equal(f.calls.length,1);assert.equal(pulls,0);assert.equal(cancels,1);
});
test('network timeout aborts immediately and cancels a noncooperative late response',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let resolve,cancels=0,signal;
  const f=fixture(t,{fetch(_url,init){signal=init.signal;return new Promise(r=>resolve=r);}});
  const p=assert.rejects(f.client.open(credentials),/timeout/);await flush();assert.equal(f.calls.length,1);
  f.tick(5001);await p;assert.equal(signal.aborted,true);
  resolve(new Response(new ReadableStream({cancel(){cancels++;}})));await flush();assert.equal(cancels,1);
  assert.equal(f.client.report().records.length,1);assert.equal(f.journal.at(-1).result,'FAIL');
});
test('body read timeout cancels watch without waiting for data',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let cancels=0;
  const f=fixture(t,{fetch(_url,_init,{responseHeaders}){return new Response(new ReadableStream({cancel(){cancels++;}},{highWaterMark:0}),{headers:responseHeaders()});}});
  const p=assert.rejects(f.client.open(credentials),/timeout/);await flush();f.tick(5001);await p;assert.equal(cancels,1);
});
test('uncertain barrier ACK stops without resending marker',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let cancels=0;
  const f=fixture(t,{phase({emit,row,barrier,responseHeaders}){emit(row(barrier));return new Response(new ReadableStream({cancel(){cancels++;}},{highWaterMark:0}),{headers:responseHeaders(true)});}});
  await f.client.open(credentials);const p=assert.rejects(f.client.phase('held',{after:f.clock.sample()}),/timeout/);
  await flush();f.tick(5001);await p;assert.equal(cancels,1);assert.equal(f.calls.length,2);
  await assert.rejects(f.client.phase('held',{after:f.clock.sample()}));assert.equal(f.reserved,2);
});
test('concurrent call fails before an additional network attempt',async t=>{
  let resolve;const f=fixture(t,{fetch(){return new Promise(r=>resolve=r);}});
  const p=assert.rejects(f.client.open(credentials));await flush();await assert.rejects(f.client.open(credentials));
  f.client.stop();await p;resolve(new Response());assert.equal(f.calls.length,1);
});
test('final journal failure discards otherwise valid observations',async t=>{
  const f=fixture(t,{persist(r){if(r.result==='PASS')throw Error('SECRET');}});
  await assert.rejects(f.client.open(credentials),/journal/);assert.equal(f.client.report().failed,true);assert.throws(()=>f.client.getPeer());
});
test('diagnostic end in same chunk as first sample cannot leave client ready',async t=>{
  const f=fixture(t,{fetch(_url,_init,{responseHeaders,instanceId}){
    const first={profile:PEER_PROFILE,kind:'sample',instanceId,watchEpoch:1,barrier:0,sequence:1,maxRequests:1,maxReservedBytes:1024,requests:0,reservedBytes:0};
    return new Response(JSON.stringify(first)+'\n'+JSON.stringify({profile:PEER_PROFILE,kind:'end',instanceId,watchEpoch:1,reason:'deadline'})+'\n',{headers:responseHeaders()});
  }});await assert.rejects(f.client.open(credentials),/stream_end/);assert.throws(()=>f.client.getPeer());
});
test('logical oracle refuses altered marker, stage, sequence, native timing and instance claims',async t=>{
  const f=fixture(t);await f.client.open(credentials);for(const stage of ['held','post-native','post-recovery'])await f.client.phase(stage,{after:f.clock.sample()});
  const original=f.client.report();
  for(const mutate of [r=>r.failed=true,r=>r.records.pop(),r=>r.records[2].sample.barrier=1,r=>r.records[2].barrier.barrier=1,
    r=>r.records[2].sample.sequence=1,r=>r.records[2].prerequisite.clockId=randomUUID(),r=>r.records[3].result='FAIL']){
    const r=structuredClone(original);mutate(r);assert.notEqual(classifySseCapacityPeerSequence(r,f.instanceId).result,'LOGICAL_SEQUENCE_PASS');
  }
  assert.equal(classifySseCapacityPeerSequence(original,randomUUID()).result,'INCONCLUSIVE_INSTANCE');
  const held=structuredClone(original);held.records[2].sample.requests=1;held.records[2].sample.reservedBytes=1024;
  assert.equal(classifySseCapacityPeerSequence(held,f.instanceId).result,'OCCUPIED_AFTER_NATIVE_MARKER');
});

for(const [label,patch] of [
  ['content type',{'Content-Type':'text/html'}],['cache policy',{'Cache-Control':'public'}],
  ['identity header',{'x-c02-capacity-instance':randomUUID()}],['peer header',{'x-c02-capacity-peer':'malformed'}],
  ['declared body overflow',{'Content-Length':String(181*512+1)}],
])test('watch response rejects '+label+' without reading the body',async t=>{
  let pulls=0;const f=fixture(t,{fetch(_url,_init,{responseHeaders}){
    return new Response(new ReadableStream({pull(){pulls++;}},{highWaterMark:0}),{headers:{...responseHeaders(),...patch}});
  }});await assert.rejects(f.client.open(credentials));assert.equal(pulls,0);assert.equal(f.reserved,1);
});
test('oversized barrier ACK is bounded and stops the watch',async t=>{
  const f=fixture(t,{phase({responseHeaders}){return new Response('x'.repeat(513),{headers:responseHeaders(true)});}});
  await f.client.open(credentials);await assert.rejects(f.client.phase('held',{after:f.clock.sample()}));
  assert.equal(f.calls.length,2);assert.equal(f.cancelled,1);
});
test('wrong barrier acknowledgement cannot authorize the queued newer sample',async t=>{
  const f=fixture(t,{phase({emit,row,responseHeaders,instanceId}){
    emit(row(1));return Response.json({profile:PEER_PROFILE,kind:'barrier',instanceId,watchEpoch:1,barrier:2,stage:'post-native'},{headers:responseHeaders(true)});
  }});await f.client.open(credentials);await assert.rejects(f.client.phase('held',{after:f.clock.sample()}));
  assert.equal(f.client.report().failed,true);
});
test('only stale samples until EOF remains inconclusive',async t=>{
  const f=fixture(t,{phase({emit,row,barrier,stage,instanceId,responseHeaders,controller}){
    emit(row(0));controller.close();return Response.json({profile:PEER_PROFILE,kind:'barrier',instanceId,watchEpoch:1,barrier,stage},{headers:responseHeaders(true)});
  }});await f.client.open(credentials);await assert.rejects(f.client.phase('held',{after:f.clock.sample()}),/stream_eof/);
  assert.equal(f.calls.length,2);
});
test('idle lifetime expires without resetting budget or releasing business state',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);await f.client.open(credentials);
  f.tick(185000);assert.equal(f.client.report().stopped,true);assert.equal(f.client.report().failed,true);
  assert.equal(f.reserved,1);assert.equal(f.cancelled,1);assert.throws(()=>f.client.getPeer());
});
test('noncooperative journal has bounded initial and final waits, no network',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{persist(){return new Promise(()=>{});}});
  const p=assert.rejects(f.client.open(credentials),/journal/);await flush();f.tick(5001);await flush();f.tick(5001);await p;
  assert.equal(f.calls.length,0);assert.equal(f.reserved,1);
});
test('elapsed monotonic deadline fails even before the timer callback runs',async t=>{
  const f=fixture(t,{fetch(_url,_init,{responseHeaders,instanceId}){
    f.advance(6000);return new Response(JSON.stringify({profile:PEER_PROFILE,kind:'sample',instanceId,watchEpoch:1,barrier:0,sequence:1,maxRequests:1,maxReservedBytes:1024,requests:0,reservedBytes:0})+'\n',{headers:responseHeaders()});
  }});await assert.rejects(f.client.open(credentials),/timeout/);assert.equal(f.client.report().failed,true);
});
