import assert from 'node:assert/strict';
import test from 'node:test';
import { peer,tick } from './postgres-recovery-operation-owner.wire.test.mjs';

const firstHold={backendIdentity:true,holdReady:q=>q==='select first'};

test('application owner waits for auxiliary close after the primary query succeeds',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,holdCancelClose:true});
  const statement=p.owner.ownedStatement('select first');await p.entered;
  const handle=statement.cancel();await p.cancelled;
  assert.deepEqual(p.owner.snapshot().cancellation,{requested:1,resultPending:1,closePending:1,transportRawClosePending:1,primaryClosePending:1,primaryRawClosePending:0});
  p.release();await statement.completion;
  assert.ok(p.owner.pending()>=2);
  let finished=false;const drain=p.owner.drain().then(value=>{finished=true;return value;});
  await tick();assert.equal(finished,false);
  p.releaseCancel();assert.deepEqual(await handle.result,{status:'transport_closed'});
  assert.deepEqual(await handle.transportClosed,{status:'close_observed'});
  assert.deepEqual(await handle.transportRawClosed,{status:'not_observable'});
  assert.deepEqual(await handle.primaryCloseObserved,{status:'close_observed'});
  assert.deepEqual(await handle.primaryRawClosed,{status:'not_observable'});
  assert.equal(await drain,'unconfirmed');assert.equal(p.owner.pending(),0);
  assert.deepEqual(p.cancelPackets,[{pid:1001,secret:2001}]);
});

test('application owner observes cancel write failure and keeps the held transport',{timeout:5000},async t=>{
  const marker=Buffer.alloc(4);marker.writeUInt32BE(80877102);
  const p=await peer(t,{...firstHold,writeFault:{marker,acceptBeforeThrow:false,holdClose:true}});
  const statement=p.owner.ownedStatement('select first');await p.entered;p.armWriteFault();
  const handle=statement.cancel();await assert.rejects(handle.result,{code:'CANCEL_TRANSPORT_FAILED'});
  p.release();await statement.completion;
  let finished=false;const drain=p.owner.drain().then(value=>{finished=true;return value;});
  await tick();assert.equal(finished,false);assert.equal(p.owner.snapshot().cancellation.closePending,1);
  p.releaseFaultClose();assert.deepEqual(await handle.transportClosed,{status:'close_observed'});
  assert.deepEqual(await handle.transportRawClosed,{status:'not_observable'});
  assert.deepEqual(await handle.primaryCloseObserved,{status:'close_observed'});
  assert.equal(await drain,'unconfirmed');assert.equal(p.owner.pending(),0);
  assert.equal(p.writeFaultState().attempts,1);
});

test('application owner drains a cancel setup failure with no auxiliary socket',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,beforeSocket:n=>n===2?Promise.reject(new Error('synthetic cancel setup failure')):undefined});
  const statement=p.owner.ownedStatement('select first');await p.entered;
  const handle=statement.cancel();
  await assert.rejects(handle.result,{code:'CANCEL_TRANSPORT_FAILED'});
  assert.deepEqual(await handle.transportClosed,{status:'not_started'});
  assert.deepEqual(await handle.transportRawClosed,{status:'not_started'});
  p.release();await statement.completion;
  assert.equal(await p.owner.drain(),'unconfirmed');assert.equal(p.owner.pending(),0);
});

test('local pre-dispatch cancellation remains distinct from the primary rejection',{timeout:5000},async t=>{
  const p=await peer(t,{backendIdentity:true}),statement=p.owner.ownedStatement('select never');
  const handle=statement.cancel();assert.deepEqual(await handle.result,{status:'not_dispatched'});
  assert.deepEqual(await handle.transportClosed,{status:'not_started'});
  assert.deepEqual(await handle.transportRawClosed,{status:'not_started'});
  assert.deepEqual(await handle.primaryCloseObserved,{status:'not_started'});
  assert.deepEqual(await handle.primaryRawClosed,{status:'not_started'});
  await assert.rejects(statement.completion,{code:'57014'});
  assert.equal(await p.owner.drain(),'unconfirmed');assert.deepEqual(p.queries,[]);
  assert.deepEqual(p.cancelPackets,[]);
});

test('repeated owner cancellation retains one handle and one transport',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,holdCancelClose:true});
  const statement=p.owner.ownedStatement('select first');await p.entered;
  const handle=statement.cancel();assert.equal(statement.cancel(),handle);
  await p.cancelled;assert.equal(p.owner.snapshot().cancellation.requested,1);
  p.release();await statement.completion;
  p.releaseCancel();await handle.transportClosed;await handle.primaryCloseObserved;
  assert.equal(await p.owner.drain(),'unconfirmed');
  assert.deepEqual(p.cancelPackets,[{pid:1001,secret:2001}]);
});

test('primary close remains separately pending after SQL and cancel transport complete',{timeout:5000},async t=>{
  const p=await peer(t,{...firstHold,holdPrimaryClose:true}),statement=p.owner.ownedStatement('select first');
  await p.entered;const handle=statement.cancel();await p.cancelled;
  assert.deepEqual(await handle.transportClosed,{status:'close_observed'});
  p.release();await statement.completion;await tick();
  assert.deepEqual(handle.snapshot(),{result:'transport_closed',transportClose:'close_observed',transportRawClose:'not_observable',primaryClose:'pending',primaryRawClose:'not_observable'});
  let finished=false;const drain=p.owner.drain().then(value=>{finished=true;return value;});
  await tick();assert.equal(finished,false);assert.equal(p.owner.snapshot().cancellation.primaryClosePending,1);
  p.releasePrimaryClose();assert.deepEqual(await handle.primaryCloseObserved,{status:'close_observed'});
  assert.equal(await drain,'unconfirmed');
});
