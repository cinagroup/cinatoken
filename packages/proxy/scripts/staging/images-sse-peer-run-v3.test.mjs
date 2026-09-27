import assert from 'node:assert/strict';
import test from 'node:test';
import {setupPeerRunV3} from './images-sse-peer-run-v3-fixture.mjs';

for(const occupied of [false,true])for(const foreignFirst of [false,true])test('V3 full resource-run uses original primary, observer, tail and financial cleanup: '+JSON.stringify({occupied,foreignFirst}),async t=>{
  const x=await setupPeerRunV3(t,{occupied,foreignFirst}),running=x.run.run();assert.equal(x.run.run(),running);
  const result=await running;
  assert.equal(result.result,'OBSERVED',JSON.stringify(result));
  assert.equal(result.window.decision.result,occupied?'OCCUPIED_AFTER_NATIVE_MARKER':'AFTER_HOLD_PEER_V3_EVIDENCE_PASS');
  assert.equal(result.finalization.result,'CLOSED');assert.equal(result.finalIsolationVerified,true);
  assert.equal(x.seedBatches,1);assert.equal(x.deleteBatches,1);assert.deepEqual(x.counts(),x.baselineCounts);
  assert.equal(result.primarySends,1);assert.equal(x.sends,1);assert.equal(x.readers,1);assert.equal(x.clones,0);assert.equal(x.rpcCalls,2);
  assert.equal(x.attempts,foreignFirst?2:1);assert.equal(result.publicHttp,10+(foreignFirst?1:0));assert.equal(result.cumulativePublicHttp,390+result.publicHttp);
  assert.equal(result.publicHttp,x.http.length+x.attempts);assert.equal(result.rejectionCapture.inferenceAttempts,1);assert.equal(result.rejectionCapture.rejection,null);
  assert.equal(x.tokens.length+x.tails.length,0);assert.ok([...x.state.values()].every(s=>s.enabled===false));
  assert.equal(x.saved.filter(e=>e.step==='peer-tail').length,1);assert.equal(result.coordinator.native.platform.events.length,1);
  assert.deepEqual(x.run.report(),result);assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);
  assert.doesNotMatch(JSON.stringify({result,saved:x.saved}),/LOCAL_SECRET|synthetic-joint/);
});

for(const fault of ['preflight','v2-content','tail-handshake','tail-ack-lost','token-ack-lost','policy-ack-lost','auth','seed-ack-lost','seed-journal','inference-journal','primary-busy','primary-rejection-journal','rpc-ack-lost','sealed-journal','joint-journal','final-isolation'])
test('V3 resource-run contains failures without replay: '+fault,async t=>{
  const x=await setupPeerRunV3(t,{fault}),result=await x.run.run();
  assert.notEqual(result.result,'OBSERVED');assert.deepEqual(x.run.report(),result);
  assert.ok(result.primarySends<=1);assert.ok(x.sends<=1);assert.ok(x.readers<=1);assert.equal(x.clones,0);
  assert.equal(x.tokens.length,0);assert.ok([...x.state.values()].every(s=>s.enabled===false));
  assert.equal(result.c02GatePassed,false);assert.equal(result.isolateEvictionProven,false);
  assert.doesNotMatch(JSON.stringify({result,saved:x.saved}),/LOCAL_SECRET|synthetic-joint/);
  if(['preflight','v2-content'].includes(fault)){
    assert.equal(x.http.length,0);assert.equal(x.calls.length,0);assert.equal(x.seedBatches,0);
    assert.equal(result.management.cloudMutationAttempted,false);
  }
  if(['primary-busy','primary-rejection-journal'].includes(fault)){
    assert.equal(result.primarySends,1);assert.equal(x.sends,0);assert.equal(x.rpcCalls,0);
    assert.equal(result.rejectionCapture.inferenceAttempts,1);assert.equal(result.rejectionCapture.rejection.status,409);
    assert.equal(result.rejectionCapture.rejection.retryAllowed,false);assert.equal(x.deleteBatches,0);
    if(fault==='primary-busy')assert.deepEqual(result.rejectionCapture.rejection.gatewayDeclaration,{reason:'primary_busy',dispatch_started:false});
    else assert.equal(result.rejectionCapture.journalFailed,true);
  }
  if(fault==='rpc-ack-lost'){
    assert.equal(x.rpcCalls,1);assert.equal(result.coordinator.recovery.calls[0].result,'PENDING');
    assert.equal(result.finalization.recoveryAttempts,0);
  }
  if(['sealed-journal','joint-journal'].includes(fault)){
    assert.equal(x.rpcCalls,2);assert.equal(result.coordinator.peerReport.stopped,true);
    assert.equal(x.saved.some(row=>row.kind==='peer-joint-acceptance-v3'),false);
  }
});
