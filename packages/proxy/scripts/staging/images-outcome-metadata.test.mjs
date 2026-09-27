import assert from 'node:assert/strict';
import test from 'node:test';
import { wireFixture, assertWireSettled, assertNoDispatch } from './images-wire-boundary-fixture.mjs';
import { unknownImageOutcomeResponse } from '../../src/services/image-outcome-error.ts';
import { gatewayErrorResponse } from '../../src/services/gateway-error-response.ts';
import { GatewayErrorCode } from '../../src/services/gateway-error-codes.ts';

const send=(f,op)=>op==='generations'?f.json():f.multipart();
function unknown(body,id){
  assert.equal(body.error.metadata.outcome_unknown,true);
  assert.equal(body.error.metadata.retry_safe,false);
  assert.equal(body.error.metadata.request_id,id);
}
function unmarked(body){
  assert.equal(body.error?.metadata?.outcome_unknown,undefined);
  assert.equal(body.error?.metadata?.retry_safe,undefined);
}
for(const op of ['generations','edits']) {
  for(const kind of ['usage','property','no-data']) test(`${op}: ${kind} post-2xx unknown outcome is public and settled once`,async t=>{
    const upstreamBody=kind==='usage'?{data:[{b64_json:'AQID'}],usage:{opaque:'x'.repeat(65537)}}
      :kind==='property'?{data:[{b64_json:'AQID'}],['x'.repeat(257)]:0}:{data:[]};
    const f=await wireFixture(t,{upstreamBody});
    const response=await send(f,op);
    const result=await assertWireSettled(f,response,502);
    unknown(result.body,result.snapshot.value.intent.requestId);
    assert.equal(result.body.code,kind==='no-data'?'gateway.upstream_request_failed':'upstream.server_error');
    assert.equal(result.body.error.message,'Upstream provider is unavailable');
    assert.equal(response.headers.get('Retry-After'),null);
    assert.ok(JSON.stringify(result.body).length<1024);
  });
  test(`${op}: successful response stays unmarked`,async t=>{
    const f=await wireFixture(t);
    const result=await assertWireSettled(f,await send(f,op));unmarked(result.body);
    assert.equal(result.body.error,undefined);
  });
  for(const upstreamStatus of [400,401,429]) test(`${op}: explicit ${upstreamStatus} cannot spoof uncertainty and releases budget`,async t=>{
    const f=await wireFixture(t,{upstreamStatus,upstreamBody:{error:{message:'private-wire-rejection',
      metadata:{outcome_unknown:true,retry_safe:false,request_id:'spoofed'}},['x'.repeat(257)]:0}});
    const {body,status}=await f.response(await send(f,op));
    assert.equal(status,upstreamStatus===401?502:upstreamStatus);
    unmarked(body);assert.notEqual(body.error.metadata.request_id,'spoofed');
    assert.equal(f.sends,1);
    assert.deepEqual(f.account(),{budget_spent_micros:0,budget_reserved_micros:0});
    assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state,'committed');
    assert.equal(f.row('SELECT charged_cost FROM api_key_request_logs').charged_cost,0);
    const snapshot=await f.snapshot();assert.equal(snapshot.value.params.userBudgetSettlement.mode,'actual');
    const before=f.counts();assert.ok(Object.values(await f.recover()).every(v=>v===0||v===false));
    assert.deepEqual(f.counts(),before);assert.equal(f.sends,1);
  });
  test(`${op}: persistence uncertainty keeps its 503 contract and dispatch reservation`,async t=>{
    const f=await wireFixture(t,{hooks:{beforeStatement(sql){
      if(sql.startsWith('INSERT INTO request_usage_settlements'))throw Error('synthetic persistence failure');
    }}});
    const {body,status}=await f.response(await send(f,op));assert.equal(status,503);
    assert.equal(body.code,'gateway.image_settlement_unconfirmed');
    unknown(body,f.row('SELECT request_id FROM request_dispatch_intents').request_id);
    assert.equal(f.sends,1);assert.deepEqual(f.account(),{budget_spent_micros:0,budget_reserved_micros:100000});
    assert.equal(f.row('SELECT COUNT(*) AS n FROM request_usage_settlements').n,0);
  });
}
test('pre-dispatch validation is not marked as an unknown supplier outcome',async t=>{
  const f=await wireFixture(t);
  unmarked((await assertNoDispatch(f,await f.json({model:'x'.repeat(257)}),400,/model/)).body);
});

for(const code of [GatewayErrorCode.requestCancelled,GatewayErrorCode.requestDeadlineExceeded]) {
  test(`${code}: trusted cancellation/timeout envelope and legacy code survive annotation`,async()=>{
    const original=gatewayErrorResponse({status:502,code,message:'Stopped',metadata:{reason:'existing'}});
    const text=await original.clone().text();const expected=JSON.parse(text);
    original.headers.set('Retry-After','30');original.headers.set('ETag','stale');
    original.headers.set('Content-Length',String(text.length));
    const decorated=await unknownImageOutcomeResponse(original,text,'gen-local');
    assert.equal(decorated.status,original.status);
    const body=await decorated.json();unknown(body,'gen-local');
    assert.equal(body.code,expected.code);assert.equal(body.error.code,expected.error.code);
    assert.equal(body.error.message,expected.error.message);assert.equal(body.error.metadata.reason,'existing');
    for(const header of ['Retry-After','ETag','Content-Length'])assert.equal(decorated.headers.get(header),null);
  });
}
for(const text of [null,'not JSON','[]','{"error":null}','x'.repeat(65537)]) {
  test(`malformed internal envelope has bounded safe fallback (${text?.length??'null'})`,async()=>{
    const response=await unknownImageOutcomeResponse(new Response('unused',{status:502}),text,'gen-local');
    const body=await response.json();assert.equal(response.status,502);unknown(body,'gen-local');
    assert.equal(body.error.message,'Upstream provider is unavailable');assert.ok(JSON.stringify(body).length<1024);
  });
}
