import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './images-recovery-test-support.mjs';
import { decodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { RequestTimingCollector } from '../../src/services/request-timing.ts';

for(const operation of ['generations','edits'])for(const mode of ['transport-error','client-abort']) {
  test(`${operation}/${mode}: post-dispatch unknown result survives the public Worker handler`,async t=>{
    const controller=new AbortController();
    const snapshots=[];const original=RequestTimingCollector.prototype.snapshot;
    t.mock.method(RequestTimingCollector.prototype,'snapshot',function(...args){
      const value=Reflect.apply(original,this,args);assert.ok(snapshots.length<64);
      snapshots.push({upstreamAttemptCount:value.upstreamAttemptCount,providerAttempts:value.providerAttempts});return value;
    });
    const f=await setup(t,{cost:0.1,composition:'worker',transport:async(input,init)=>{
      const request=new Request(input,init);let bytes=0;
      for await(const chunk of request.body){bytes+=chunk.byteLength;assert.ok(bytes<=512*1024);}
      if(mode==='client-abort')controller.abort();
      throw mode==='client-abort'?new DOMException('Synthetic cancellation','AbortError'):new Error('private upstream failure');
    }});
    const response=await f.request(operation,{},controller.signal);const body=await response.json();await f.drain();
    t.diagnostic(JSON.stringify({operation,mode,status:response.status,body,sends:f.sends,
      account:f.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user),
      snapshots:f.row('SELECT COUNT(*) AS n FROM request_usage_settlements'),
      intent:f.row('SELECT state FROM request_dispatch_intents'),lastTiming:snapshots.at(-1)}));
    assert.equal(response.status,mode==='client-abort'?499:502);
    assert.equal(body.error.metadata.outcome_unknown,true);
    assert.equal(body.error.metadata.retry_safe,false);
    assert.equal(body.error.metadata.request_id,f.row('SELECT request_id FROM request_dispatch_intents').request_id);
    assert.equal(f.sends,1);
    const raw=f.row('SELECT payload_json,payload_sha256 FROM request_usage_settlements');
    const snapshot=await decodeUsageSettlement(raw.payload_json,raw.payload_sha256);
    assert.equal(body.error.metadata.request_id,snapshot.intent.requestId);
    assert.equal(body.code,mode==='client-abort'?'gateway.request_cancelled':'upstream.server_error');
    const facts=snapshot.params.requestLog.providerAttempts;
    assert.equal(facts.length,1);assert.equal(facts[0].attemptIndex,snapshot.intent.attemptIndex);
    assert.equal(facts[0].providerId,snapshot.params.requestLog.providerId);
    assert.equal(facts[0].routeTargetId,snapshot.params.requestLog.routeTargetId);
    assert.equal(facts[0].reason,mode==='client-abort'?'client_cancelled':'network_error');
    assert.equal(facts[0].outcome,mode==='client-abort'?'excluded':'unavailable');
    assert.equal(facts[0].httpStatus,null);
    assert.equal(snapshot.params.chargedCost,0);
    assert.equal(snapshot.params.userBudgetSettlement.mode,mode==='client-abort'?'actual':'reserved');
    const account=f.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user);
    assert.equal(account.budget_spent_micros,mode==='client-abort'?0:100000);assert.equal(account.budget_reserved_micros,0);
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'committed');
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
    assert.equal(f.sends,1);assert.ok(Object.values(await f.recover()).every(v=>v===0||v===false));assert.equal(f.sends,1);
    assert.equal(JSON.stringify(body).includes('private upstream'),false);
  });
}
