import assert from 'node:assert/strict';
import test from 'node:test';
import { peer,deferred,tick } from './postgres-recovery-operation-owner.wire.test.mjs';
import { net as postgresCfNet } from '../../../../../node_modules/postgres/cf/polyfills.js';

const options={backendIdentity:true,holdReady:q=>q==='select first',rawCloseGate:true};

test('CF installed polyfill emits a synthetic close while raw.closed is pending',async()=>{
  const rawClosed=deferred(),socket=postgresCfNet.Socket(),events=[];
  socket.raw={closed:rawClosed.promise,close:()=>rawClosed.promise};
  socket.reader={read:()=>Promise.reject(new Error('synthetic read failure'))};
  socket.on('error',()=>events.push('error'));socket.on('close',()=>events.push('close'));
  await socket.read();assert.deepEqual(events,['error','close']);
  let settled=false;void rawClosed.promise.then(()=>{settled=true;});
  await tick();assert.equal(settled,false);
});

test('CF synthetic primary close cannot recycle a canceled pool slot before raw.closed',{timeout:5000},async t=>{
  const p=await peer(t,options),statement=p.owner.ownedStatement('select first');
  await p.entered;const handle=statement.cancel();await p.cancelled;
  const primary=statement.completion.then(()=>({ok:true}),()=>({ok:false}));
  p.emitSyntheticPrimaryClose();assert.equal((await primary).ok,false);
  assert.deepEqual(await handle.primaryCloseObserved,{status:'close_observed'});
  assert.equal(handle.snapshot().primaryRawClose,'pending');await p.rawCloseRequested;
  const next=Promise.resolve(p.owner.client.raw.unsafe('select after'));
  await tick();assert.deepEqual(p.queries,['select first']);
  let drained=false;const drain=p.owner.drain().then(result=>{drained=true;return result;});
  await tick();assert.equal(drained,false);
  p.releaseRawClose();assert.deepEqual(await handle.primaryRawClosed,{status:'raw_closed'});
  await next;assert.equal(await drain,'unconfirmed');assert.equal(p.owner.pending(),0);
  assert.deepEqual(p.queries,['select first','select after']);
  assert.notEqual(p.trace[0].connectionId,p.trace[1].connectionId);
});

test('CF rejected raw.closed keeps the canceled pool slot quarantined',{timeout:5000},async t=>{
  const p=await peer(t,options),statement=p.owner.ownedStatement('select first');
  await p.entered;const handle=statement.cancel();await p.cancelled;
  const primary=statement.completion.then(()=>({ok:true}),()=>({ok:false}));
  p.emitSyntheticPrimaryClose();assert.equal((await primary).ok,false);await p.rawCloseRequested;
  const next=Promise.resolve(p.raw.unsafe('select after')).then(()=>({ok:true}),()=>({ok:false}));
  await tick();assert.deepEqual(p.queries,['select first']);
  p.rejectRawClose();assert.deepEqual(await handle.primaryRawClosed,{status:'raw_close_rejected'});
  assert.deepEqual(await handle.primaryCloseObserved,{status:'close_observed'});
  await tick();assert.deepEqual(p.queries,['select first']);
  assert.equal(await p.owner.drain(),'unconfirmed');
  await p.raw.end({timeout:0});assert.equal((await next).ok,false);
});

for(const rejectRaw of [false,true])test('CF synthetic cancel transport close owns auxiliary raw.closed '+(rejectRaw?'rejection':'fulfillment'),{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true,holdReady:q=>q==='select first',holdCancelClose:true,cancelRawCloseGate:true});
  const statement=p.owner.ownedStatement('select first');await p.entered;
  const handle=statement.cancel();await p.cancelled;
  p.emitSyntheticCancelClose();
  assert.deepEqual(await handle.result,{status:'transport_closed'});
  assert.deepEqual(await handle.transportClosed,{status:'close_observed'});
  await p.cancelRawCloseRequested;assert.equal(p.cancelRawCloseCalls(),1);
  assert.equal(handle.snapshot().transportRawClose,'pending');
  p.release();await statement.completion;await handle.primaryCloseObserved;
  let drained=false;const drain=p.owner.drain().then(result=>{drained=true;return result;});
  await tick();assert.equal(drained,false);
  assert.equal(p.owner.snapshot().cancellation.transportRawClosePending,1);
  if(rejectRaw){
    p.rejectCancelRawClose();
    assert.deepEqual(await handle.transportRawClosed,{status:'raw_close_rejected'});
  }else{
    p.releaseCancelRawClose();
    assert.deepEqual(await handle.transportRawClosed,{status:'raw_closed'});
  }
  assert.equal(await drain,'unconfirmed');assert.equal(p.owner.pending(),0);
});

test('CF late raw.closed cannot dispatch queued SQL after pool end',{timeout:5000},async t=>{
  const p=await peer(t,{...options,holdPrimaryClose:true});
  const q=p.raw.unsafe('select first',[],{owned_cancel:true});
  const first=Promise.resolve(q);await p.entered;q.cancelOwned();await p.cancelled;
  let nextSettled=false;const next=Promise.resolve(p.raw.unsafe('select after')).then(
    ()=>{nextSettled=true;return {ok:true};},
    error=>{nextSettled=true;return {ok:false,code:error.code};},
  );
  p.release();await first;
  p.emitSyntheticPrimaryClose();await p.rawCloseRequested;
  assert.deepEqual(p.queries,['select first']);
  await p.raw.end();
  assert.deepEqual(await next,{ok:false,code:'CONNECTION_ENDED'});
  let timer;const dispatched=Promise.race([
    p.seen('select after').then(()=>true),
    new Promise(resolve=>{timer=setTimeout(()=>resolve(false),500);}),
  ]);
  p.releaseRawClose();
  const observed=await dispatched;clearTimeout(timer);
  assert.equal(observed,false,'retired pool must not dispatch SQL after end() resolved');
  assert.deepEqual(p.queries,['select first']);assert.equal(nextSettled,true);
});
