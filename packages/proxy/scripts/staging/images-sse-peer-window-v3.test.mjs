import assert from 'node:assert/strict';
import test from 'node:test';
import {setupPeerWindowV3} from './images-sse-peer-window-v3-fixture.mjs';
import {createSseCapacityPeerCoordinatorV3} from '../../../../scripts/deploy/staging-sse-capacity-peer-coordinator-v3.mjs';

for(const occupied of [false,true])for(const foreignFirst of [false,true])test('V3 one original reader through same-pool observation, recovery and containment: '+JSON.stringify({occupied,foreignFirst}),async t=>{
  const x=await setupPeerWindowV3(t,{occupied,foreignFirst}),running=x.window.run();assert.equal(x.window.run(),running);
  const result=await running;
  assert.equal(result.result,'OBSERVED',JSON.stringify(result));
  assert.equal(result.decision.result,occupied?'OCCUPIED_AFTER_NATIVE_MARKER':'AFTER_HOLD_PEER_V3_EVIDENCE_PASS');
  assert.equal(result.finalization.result,'CLOSED',JSON.stringify(result.finalization));
  assert.equal(result.finalization.cleanupPassed,true);assert.equal(x.deleteBatches,1);
  assert.equal(result.primarySends,1);assert.equal(x.sends,1);assert.equal(x.readers,1);assert.equal(x.clones,0);assert.equal(x.rpcCalls,2);
  assert.equal(x.attempts,foreignFirst?2:1);assert.equal(x.reserved,4+(foreignFirst?1:0));
  assert.deepEqual(x.financial().map(rows=>rows.length),[0,0,0,0,0,0]);
  assert.equal(x.tokens.length,0);assert.equal(x.tails.length,1);assert.ok([...x.state.values()].every(s=>s.enabled===false));
  const sealed=x.saved.findIndex(r=>r.kind==='peer-v3-sealed-evidence'),decision=x.saved.findIndex(r=>r.kind==='peer-joint-acceptance-v3');
  assert.ok(sealed>=0&&decision>sealed);assert.equal(x.saved[sealed].peerReport.stopped,true);assert.equal(x.saved[sealed].peerReport.failed,false);
  assert.deepEqual(x.saved[sealed].peerReport,result.coordinator.peerReport);
  assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);
  assert.doesNotMatch(JSON.stringify({result,saved:x.saved}),/LOCAL_SECRET|synthetic-joint/);
  assert.ok(x.waits.every(n=>n<=20000));
});

test('V3 cannot watch, mark held or cancel before its one original response',async t=>{
  const x=await setupPeerWindowV3(t);
  await assert.rejects(x.co.watch({}));await assert.rejects(x.co.held({}));assert.throws(()=>x.co.cancelPrimary());
  assert.equal(x.co.report().state,'NEW');assert.equal(x.session.requests.length,0);assert.equal(x.attempts,0);assert.equal(x.sends,0);
});

for(const reserve of [()=>Promise.resolve(),()=>{throw Error('reservation unavailable');}])test('V3 failed or asynchronous public-call reservation forbids dispatch',async t=>{
  const x=await setupPeerWindowV3(t);let sends=0,writes=0;
  const co=createSseCapacityPeerCoordinatorV3({session:x.session,reserve,persist(){writes++;},socketFactory(){assert.fail('No watch without primary');}});
  t.after(()=>co.close());
  await assert.rejects(co.dispatch(x.session.plan.plans[0],()=>{sends++;}));
  assert.equal(co.report().state,'FAILED');assert.equal(sends,0);assert.equal(writes,0);assert.equal(x.session.requests.length,1);
  await assert.rejects(co.dispatch(x.session.plan.plans[0],()=>{sends++;}));assert.equal(sends,0);
});

for(const fault of ['inference-journal','inference-ack-lost','watch-403','watch-403-after-held','changed-native','missing-native','lost-post-native-ack','rpc-ack-lost','sealed-journal','joint-journal'])
test('V3 failure remains incomplete without inference/RPC replay: '+fault,async t=>{
  const x=await setupPeerWindowV3(t,{fault}),result=await x.window.run();
  assert.notEqual(result.result,'OBSERVED');assert.equal(x.window.run(),x.window.run());
  assert.ok(result.primarySends<=1);assert.ok(x.sends<=1);assert.ok(x.readers<=1);assert.equal(x.clones,0);assert.ok(x.attempts<=1);
  assert.equal(x.tokens.length,0);assert.equal(x.tails.length,1);assert.ok([...x.state.values()].every(s=>s.enabled===false));
  assert.equal(result.finalization.keyRevoked,true);assert.equal(result.finalization.experimentResult,'FAILED_OR_INCOMPLETE');
  assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);
  assert.doesNotMatch(JSON.stringify({result,saved:x.saved}),/LOCAL_SECRET|synthetic-joint/);
  if(['inference-journal','inference-ack-lost','missing-native','watch-403'].includes(fault)){
    assert.equal(result.result,'ATTENTION_REQUIRED');assert.equal(x.deleteBatches,0);assert.equal(x.rpcCalls,0);
    assert.notEqual(result.finalization.cleanupPassed,true);
  }else{
    assert.equal(result.result,'FAILED',JSON.stringify(result.finalization));assert.equal(x.deleteBatches,1);
    assert.equal(result.finalization.cleanupPassed,true);assert.deepEqual(x.financial().map(rows=>rows.length),[0,0,0,0,0,0]);
  }
  if(fault==='inference-journal'){assert.equal(result.primarySends,0);assert.equal(x.attempts,0);}
  if(fault==='inference-ack-lost'){assert.equal(result.primarySends,1);assert.equal(x.attempts,0);}
  if(fault==='rpc-ack-lost'){
    assert.equal(x.rpcCalls,1);assert.equal(result.coordinator.recovery.calls.length,1);assert.equal(result.coordinator.recovery.calls[0].result,'PENDING');
    assert.ok(result.coordinator.lastRpcFinished);assert.equal(result.finalization.recoveryAttempts,0);
  }
  if(['sealed-journal','joint-journal'].includes(fault)){
    assert.equal(x.rpcCalls,2);assert.equal(result.coordinator.peerReport.stopped,true);assert.equal(result.finalization.recoveryAttempts,0);
    assert.equal(x.saved.some(r=>r.kind==='peer-joint-acceptance-v3'),false);
  }
  if(['watch-403-after-held','changed-native','lost-post-native-ack'].includes(fault)){
    assert.equal(x.rpcCalls,1);assert.equal(result.finalization.recoveryAttempts,1);
  }
  if(fault==='changed-native')assert.equal(result.coordinator.peerReport.markerAttempts,1);
  if(fault==='lost-post-native-ack')assert.equal(result.coordinator.peerReport.markerAttempts,2);
});
