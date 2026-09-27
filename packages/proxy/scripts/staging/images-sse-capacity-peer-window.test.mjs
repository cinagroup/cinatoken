import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {setupPeerWindow} from './images-sse-capacity-peer-window-fixture.mjs';
import {awaitPeerTestReadiness} from './images-sse-capacity-peer-finalizer-fixture.mjs';
import {createSseCapacityPeerWindow} from '../../../../scripts/deploy/staging-sse-capacity-peer-window.mjs';
import {SSE_STAGING_SCOPE as g} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';

// Actual window, coordinator, finalizer, session, ReadableStream and SQLite.
// Network, native tail, host stop and pool observations are LOCAL MODELS only.
async function setup(t,{fault,pending=false}={}) {
  const x=await setupPeerWindow(t,{pending}),calls=[],rpc=[],events=[];
  let body,signal,sent=0,observations=0,finishPrimaryCalls=0;
  let markReadEntered,markFetchAborted;
  const firstReadEntered=new Promise(resolve=>{markReadEntered=resolve;});
  const fetchAborted=new Promise(resolve=>{markFetchAborted=resolve;});
  let deliveredNative=false;
  const emitNative=()=>{if(!deliveredNative){deliveredNative=true;x.receive();}};
  x.setSleep(async()=>{if(fault!=='missing-native')emitNative();});
  const accessHeaders={'CF-Access-Client-Id':'local','CF-Access-Client-Secret':'local-secret'};
  const source=new TextEncoder().encode('data: '+JSON.stringify({type:'image_generation.completed',b64_json:'AQID'})+'\n\n');
  const co={...x.co,async finishPrimary(){finishPrimaryCalls++;return x.co.finishPrimary();}};
  const options={session:x.session,coordinator:co,finalizer:x.finalizer,fixture:x.inputFixture,key:x.key,
    ownership:x.options.ownership,accessHeaders,
    fetchImpl:async(url,init)=>{
      sent++;calls.push({url,init});signal=init.signal;x.at(1000,x.r.headersAt);
      if(fault==='no-headers')throw Error('local-secret');
      const stream=new ReadableStream({start(controller){
        body=controller;
        if(fault==='first-read-error')controller.error(Error('local-secret'));
        else if(fault==='first-read-hang'){ /* The real first read stays pending. */ }
        else if(fault==='invalid-utf8')controller.enqueue(Uint8Array.from([0xff,10,10]));
        else if(fault==='oversized-frame')controller.enqueue(new Uint8Array(8193));
        else if(fault==='premature-done')controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        else if(fault==='fragmented'){
          controller.enqueue(source.slice(0,7));controller.enqueue(source.slice(7));
        }else controller.enqueue(source);
        if(fault==='early-eof')controller.close();
        signal.addEventListener('abort',()=>{
          markFetchAborted();
          if(fault==='cancel-hang')return;
          x.at(Math.max(x.now(),1300),x.r.cancelIssuedAt);x.ended();
          try{controller.error(new DOMException('Cancelled','AbortError'));}catch{}
        },{once:true});
      },pull(){if(fault==='first-read-hang')markReadEntered();},cancel(){x.ended();}},
        {highWaterMark:fault==='first-read-hang'?0:1});
      return new Response(stream,{headers:{'Content-Type':'text/event-stream','X-Generation-Id':x.r.id,'x-c02-capacity-instance':x.pool}});
    },
    readObservation:async()=>{
      observations++;
      if(x.now()<1300)x.at(1100,x.r.cancelIssuedAt);
      if(fault==='observation-error')throw Error('local-secret');
      if(fault==='ended-during-observation'){body.close();await tick();}
      return x.observation;
    },
    readCancel:async()=>x.cancelRow,readFacts:x.facts,
    runRecovery:async({expected=1})=>{
      rpc.push(expected);
      if(pending){
        x.f.db.hooks.beforeStatement=undefined;
        const now=Math.floor(Date.now()/1000)+60;x.f.db.sqlite.function('unixepoch',{varargs:true},()=>now);
        assert.equal((await x.f.recoverOnce()).committed,expected);
      }
      if(fault==='rpc-ack-lost')throw Error('local-secret');
      return x.response(expected);
    },
    persist:async event=>{
      events.push(structuredClone(event));
      if(event.step==='peer-window-complete'&&fault==='final-journal')throw Error('local-secret');
      if(event.step==='peer-window-completed'&&fault==='completed-journal')throw Error('local-secret');
    },
  };
  const window=createSseCapacityPeerWindow(options);
  return {...x,window,options,calls,rpc,events,accessHeaders,emitNative,firstReadEntered,fetchAborted,
    get spent(){return x.spent;},
    get sent(){return sent;},get observations(){return observations;},get signal(){return signal;},
    get finishPrimaryCalls(){return finishPrimaryCalls;},
  };
}

for(const fault of [undefined,'fragmented'])test('real body + original session + coordinator/finalizer complete one window: '+fault,async t=>{
  const x=await setup(t,{fault,pending:true});x.addSharedToken();
  const first=x.window.run();assert.equal(x.window.run(),first);const result=await first;
  assert.equal(result.result,'OBSERVED',JSON.stringify(result));assert.equal(result.finalization.result,'CLOSED');
  assert.equal(result.decision.result,'AFTER_HOLD_PEER_EVIDENCE_PASS');assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);
  assert.equal(x.sent,1);assert.equal(x.spent,7);assert.deepEqual(x.rpc,[1,0]);assert.equal(x.finishPrimaryCalls,1);
  assert.equal(result.primaryEnd.monoMs,1300);assert.equal(result.coordinator.journal.requests[0].timing.finished.monoMs,1300);
  assert.deepEqual(x.f.counts(),x.f.baseline);assert.deepEqual(x.f.otherRows(),x.f.unrelated);assert.equal(x.f.sends,1);
  const {url,init}=x.calls[0];assert.equal(url,'https://'+g.domain+'/v1/images/generations');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');
  assert.equal(JSON.parse(init.body).model,x.inputFixture.cases['small-generations'].model);
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+x.key);
  assert.doesNotMatch(JSON.stringify({result,events:x.events}),/local-secret|synthetic-window-/);
});

for(const fault of ['no-headers','first-read-error','invalid-utf8','oversized-frame','premature-done','early-eof','ended-during-observation','observation-error','completed-journal'])
test('one failed body/observation attempt still closes both ingress: '+fault,async t=>{
  const x=await setup(t,{fault});const result=await x.window.run();
  assert.notEqual(result.result,'OBSERVED');assert.equal(x.sent,1);assert.equal(x.finishPrimaryCalls,0);assert.ok(x.rpc.length<=1);
  assert.equal(result.finalization.accessClosed,true);assert.equal(result.finalization.keyRevoked,true);
  for(const s of [g,c])assert.equal(x.state.get(s.worker).enabled,false);
  assert.doesNotMatch(JSON.stringify(result),/local-secret/);assert.deepEqual(x.f.otherRows(),x.f.unrelated);
  assert.equal(x.window.run(),x.window.run());assert.equal(x.sent,1);
});

for(const invalid of ['key','model','headers','owner','expired-preflight'])test('invalid trusted input refuses all public sends: '+invalid,async t=>{
  const x=await setup(t);
  if(invalid==='key')x.options.key+='wrong';
  if(invalid==='model')x.options.fixture.cases['small-generations'].model='paid-foreign-model';
  if(invalid==='headers')x.options.accessHeaders.Authorization='Bearer foreign';
  if(invalid==='owner')x.options.ownership.runId='foreign';
  if(invalid==='expired-preflight')x.at(60002);
  const window=createSseCapacityPeerWindow(x.options),result=await window.run();
  assert.notEqual(result.result,'OBSERVED');assert.equal(x.sent,0);assert.equal(x.spent,0);assert.deepEqual(x.rpc,[]);
  for(const s of [g,c])assert.equal(x.state.get(s.worker).enabled,false);
});

test('input mutation after run starts cannot replace model, headers or cleanup owner',async t=>{
  const x=await setup(t),work=x.window.run();
  x.options.fixture.cases['small-generations'].model='paid-foreign-model';
  x.accessHeaders['CF-Access-Client-Secret']='changed-secret';x.options.ownership.runId='foreign';
  const result=await work;assert.equal(result.result,'OBSERVED',JSON.stringify(result));
  assert.notEqual(JSON.parse(x.calls[0].init.body).model,'paid-foreign-model');
  assert.equal(new Headers(x.calls[0].init.headers).get('cf-access-client-secret'),'local-secret');
  assert.equal(result.finalization.cleanupPassed,true);
});

test('lost recovery ACK does not repeat inference, RPC or claim experiment success',async t=>{
  const x=await setup(t,{fault:'rpc-ack-lost',pending:true}),result=await x.window.run();
  assert.equal(x.sent,1);assert.deepEqual(x.rpc,[1]);assert.notEqual(result.result,'OBSERVED');
  assert.equal(result.finalization.cleanupPassed,true,JSON.stringify(result));assert.deepEqual(x.f.counts(),x.f.baseline);
});

test('final journal failure preserves cleanup result but reports attention, never raw error',async t=>{
  const x=await setup(t,{fault:'final-journal'}),result=await x.window.run();
  assert.equal(result.result,'ATTENTION_REQUIRED');assert.equal(result.finalJournalFailed,true);
  assert.equal(result.finalization.cleanupPassed,true);assert.doesNotMatch(JSON.stringify(result),/local-secret/);
});

test('missing native event expires without recovery and preserves financial rows',{timeout:10000},async t=>{
  const x=await setup(t,{fault:'missing-native'}),before=x.f.financial(),result=await awaitPeerTestReadiness(x.window.run(),{label:'missing native window'});
  assert.equal(result.result,'ATTENTION_REQUIRED');assert.deepEqual(x.rpc,[]);assert.equal(result.finalization.fixtureRemoved,false);
  assert.deepEqual(x.f.financial(),before);assert.equal(result.finalization.accessClosed,true);
});

test('late cancellation read cannot call success transition after its deadline',{timeout:10000},async t=>{
  const x=await setup(t,{fault:'cancel-hang'}),work=x.window.run();
  await awaitPeerTestReadiness(x.fetchAborted,{owner:work,label:'actual primary abort'});assert.equal(x.signal.aborted,true);
  // Expire the read bound. The finalizer can actually cancel the stream, but
  // the old timed-out continuation must not call finishPrimary afterward.
  t.mock.timers.tick(10001);const result=await awaitPeerTestReadiness(work,{label:'cancel deadline finalization'});
  assert.equal(x.finishPrimaryCalls,0);assert.notEqual(result.result,'OBSERVED');assert.equal(x.sent,1);
});

test('first read deadline aborts the original fetch and still finalizes once',{timeout:10000},async t=>{
  const x=await setup(t,{fault:'first-read-hang'}),work=x.window.run();
  await awaitPeerTestReadiness(x.firstReadEntered,{owner:work,label:'actual first body read'});assert.ok(x.signal);
  t.mock.timers.tick(15001);const result=await awaitPeerTestReadiness(work,{label:'first read deadline finalization'});
  assert.equal(x.signal.aborted,true);assert.equal(x.finishPrimaryCalls,0);assert.equal(x.sent,1);
  assert.notEqual(result.result,'OBSERVED');assert.equal(result.finalization.accessClosed,true);
  assert.equal(x.window.run(),work);assert.equal(x.sent,1);
});
