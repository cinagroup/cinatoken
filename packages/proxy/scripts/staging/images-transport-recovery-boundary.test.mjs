import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './images-recovery-test-support.mjs';
import { RequestExecutionStoppedError } from '../../src/services/request-deadline.ts';
import { decodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { createUsageSettlementRepositoryD1 } from '../../../core/src/storage/recovery/usage-settlement-d1.ts';

for(const operation of ['generations','edits'])for(const mode of ['before-ledger','ledger-ack-lost','lease-ack-lost','deadline-signal']) {
  test(`${operation}: unknown transport outcome durable recovery ${mode}`,async t=>{
    let armed=true,faults=0;const stop=new AbortController();
    const f=await setup(t,{cost:0.1,composition:'worker',hooks:{
      beforeStatement(sql){if(armed&&mode==='before-ledger'&&sql.startsWith('INSERT INTO api_key_request_logs')){faults++;throw Error('Synthetic ledger unavailable');}},
      afterStatement(sql){if(armed&&mode==='lease-ack-lost'&&sql.startsWith('UPDATE request_usage_recovery_jobs SET')&&sql.includes('attempts=MIN')){faults++;throw Error('Synthetic lease acknowledgement lost');}},
      afterBatch(sql){if(armed&&mode==='ledger-ack-lost'&&sql.some(s=>s.startsWith('INSERT INTO api_key_request_logs'))){faults++;throw Error('Synthetic batch acknowledgement lost');}},
    },transport:async(input,init)=>{
      const request=new Request(input,init);let bytes=0;
      for await(const chunk of request.body){bytes+=chunk.byteLength;assert.ok(bytes<512*1024);}
      if(mode==='deadline-signal')stop.abort(new RequestExecutionStoppedError('deadline_exceeded'));
      throw Error('Synthetic transport failed');
    }});
    const response=await f.request(operation,{},stop.signal);const body=await response.json();await f.drain();
    assert.equal(response.status,mode==='deadline-signal'?504:502);
    assert.equal(body.error.metadata.outcome_unknown,true);assert.equal(body.error.metadata.retry_safe,false);
    assert.equal(f.sends,1);
    const raw=f.row('SELECT payload_json,payload_sha256 FROM request_usage_settlements');assert.ok(raw);
    const snapshot=await decodeUsageSettlement(raw.payload_json,raw.payload_sha256),p=snapshot.params;
    assert.equal(p.chargedCost,0);assert.equal(p.requestLog.providerAttempts.length,1);
    assert.equal(p.requestLog.providerAttempts[0].reason,'network_error');assert.equal(p.requestLog.providerAttempts[0].httpStatus,null);
    assert.equal(p.userBudgetSettlement.mode,mode==='deadline-signal'?'actual':'reserved');
    if(mode!=='deadline-signal')assert.ok(faults>0);
    const already=mode==='ledger-ack-lost'||mode==='deadline-signal';
    assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,Number(already));
    if(!already)assert.equal(f.row('SELECT budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user).budget_reserved_micros,100000);
    armed=false;f.advance(30);
    const recovered=await f.recover();assert.equal(recovered.committed,Number(!already));
    assert.equal(f.sends,1);assert.equal(f.row('SELECT payload_json FROM request_usage_settlements').payload_json,raw.payload_json);
    for(const table of ['api_key_request_logs','request_usage_commit_receipts','provider_attempt_availability','user_audit_logs'])assert.equal(f.row(`SELECT COUNT(*) AS n FROM ${table}`).n,1);
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'committed');
    const account=f.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user);
    assert.equal(account.budget_spent_micros,mode==='deadline-signal'?0:100000);assert.equal(account.budget_reserved_micros,0);
    assert.ok(Object.values(await f.recover()).every(v=>v===0||v===false));
    const i=snapshot.intent;
    assert.equal(await createUsageSettlementRepositoryD1(f.storage.client).commit({requestId:i.requestId,userId:i.userId,apiKeyId:i.apiKeyId,workspaceId:i.workspaceId,payloadSha256:raw.payload_sha256}),'committed');
    assert.equal(f.row('SELECT budget_spent_micros FROM users WHERE id=?',f.fixture.ids.user).budget_spent_micros,account.budget_spent_micros);
    assert.equal(f.sends,1);
  });
}
