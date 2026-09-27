import assert from 'node:assert/strict';
import test from 'node:test';
import {rejectionRunFixture} from './images-sse-peer-rejection-run-fixture.mjs';

for(const fault of ['reject','reject-secret','reject-journal','inference-ack-lost'])
test('rejection capture composes with real resource/window/finalizer and SQLite: '+fault,async t=>{
  const x=rejectionRunFixture(t,fault),pending=x.run.run();assert.equal(x.run.run(),pending);const r=await pending;
  assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.primarySends,1);assert.equal(r.rejectionCapture.inferenceAttempts,1);
  assert.equal(x.http.filter(h=>h.url.endsWith('/v1/images/generations')).length,1);
  assert.equal(r.publicHttp,8);assert.equal(r.cumulativePublicHttp,390);assert.equal(r.c02GatePassed,false);
  assert.equal(x.seedBatches,1);assert.equal(x.deleteBatches,0);assert.notDeepEqual(x.counts(),x.baseline);
  assert.equal(r.finalization.keyRevoked,true);assert.equal(r.finalization.fixtureRemoved,false);
  assert.equal(r.finalIsolationVerified,true);assert.equal(x.tokens.length+x.tails.length,0);
  assert.equal(x.session.lastRpcFinished,undefined);assert.equal(x.session.requests.length,1);
  assert.equal(x.session.requests[0].timing.finished,undefined,'Local rejection EOF is not an invented native session completion');
  assert.doesNotMatch(JSON.stringify(r),/local-secret|synthetic-[a-f0-9]/);
  const f=r.rejectionCapture;
  if(fault==='inference-ack-lost'){assert.equal(f.rejection,null);return;}
  assert.equal(x.session.requests[0].status,409);assert.equal(x.session.requests[0].id,null);
  assert.equal(f.rejection.status,409);assert.equal(f.rejection.nativeProof,false);assert.equal(f.rejection.settlementProof,false);
  if(fault==='reject-journal'){
    assert.equal(f.journalFailed,true);assert.equal(f.rejection.naturalEof,false);assert.ok(r.errors.includes('rejection-journal'));
  }else{
    assert.equal(f.rejection.naturalEof,true);assert.ok(f.rejection.eofReceived);assert.equal(f.journalFailed,false);
    assert.equal(f.rejection.gatewayDeclaration?.reason??null,fault==='reject'?'peer_not_active_here':null);
    assert.equal(x.events.filter(e=>e.step==='peer-rejection').length,2);
  }
  assert.deepEqual(x.run.report().rejectionCapture,r.rejectionCapture);
});

test('unchanged unsent-failure cleanup remains available with the new wrapper',async t=>{
  const x=rejectionRunFixture(t),r=await x.run.run();assert.equal(r.primarySends,0);assert.equal(r.rejectionCapture.inferenceAttempts,0);
  assert.equal(r.rejectionCapture.rejection,null);assert.equal(r.unusedFixture.fixtureRemoved,true);
  assert.deepEqual(x.counts(),x.baseline);assert.equal(x.deleteBatches,1);assert.equal(r.c02GatePassed,false);
});
