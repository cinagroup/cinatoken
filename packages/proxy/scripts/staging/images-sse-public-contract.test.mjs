import assert from 'node:assert/strict';
import test from 'node:test';
import {setup} from './images-recovery-test-support.mjs';
import {RequestExecutionStoppedError} from '../../src/services/request-deadline.ts';
const frame=o=>'data: '+JSON.stringify(o)+'\n\n',done='data: [DONE]\n\n';
const image={type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}};
const partial={type:'image_generation.partial_image',partial_image_index:0,b64_json:'AQID'};
const provider={type:'error',error:{message:'Synthetic refusal',code:'image_content_policy_violation',
  metadata:{request_id:'spoofed-provider',retry_safe:true,outcome_unknown:false,private:'PRIVATE_DETAIL'}}};
const cases=[
  ['null',null],['invalid-json','data: invalid\n\n'],['missing-done',frame(image)],['no-image',done],
  ['key-limit',frame({...image,['x'.repeat(257)]:0}),true],
  ['usage-limit',frame({...image,usage:{opaque:'x'.repeat(65537)}}),true],
  ['provider-error',frame(provider),false,false],['partial-provider-error',frame(partial)+frame(provider)],
  ['success',frame(image)+done],['transport',null],['deadline',null],['client-abort',null],
];
for(const [mode,body,capacity=false,unknown=true] of cases)test(`Worker SSE public/SQLite contract: ${mode}`,{timeout:15000},async t=>{
  const parent=new AbortController();let sourceController;
  const source=['transport','deadline','client-abort'].includes(mode)?new ReadableStream({start(c){sourceController=c;}}):body;
  const f=await setup(t,{cost:0.1,composition:'worker',expectIntent:false,transport:async(input,init)=>{
    const request=new Request(input,init);let size=0;for await(const page of request.body){size+=page.byteLength;assert.ok(size<65536);}
    return new Response(source,{headers:{'Content-Type':'text/event-stream','X-Generation-Id':'spoofed-provider','Retry-After':'1'}});
  }});
  for(const endpoint of f.fixture.ids.endpoints){
    const caps=JSON.parse(f.row('SELECT image_capabilities FROM model_endpoints WHERE id=?',endpoint).image_capabilities);
    caps.supports_streaming=true;f.db.sqlite.prepare('UPDATE model_endpoints SET image_capabilities=? WHERE id=?').run(JSON.stringify(caps),endpoint);
  }
  const response=await f.request('generations',{stream:true},parent.signal,{'X-Generation-Id':'spoofed-client'});
  assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/text\/event-stream/);
  const id=response.headers.get('X-Generation-Id');assert.match(id,/^gen-[a-f0-9-]{36}$/);
  if(mode==='transport')sourceController.error(new Error('PRIVATE_DETAIL'));
  if(mode==='deadline')parent.abort(new RequestExecutionStoppedError('deadline_exceeded'));
  if(mode==='client-abort')parent.abort();
  const text=await response.text();assert.ok(text.length<4096);await f.drain();
  assert.doesNotMatch(text,/spoofed-provider|spoofed-client|PRIVATE_DETAIL/);
  assert.equal(response.headers.get('Retry-After'),null);
  const records=text.split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>s.slice(6));
  if(mode==='client-abort')assert.equal(text,'');
  else {
    assert.equal(records.at(-1),'[DONE]');assert.equal(records.filter(s=>s==='[DONE]').length,1);
    const errors=records.filter(s=>s!=='[DONE]').map(JSON.parse).filter(s=>s.type==='error');
    assert.equal(errors.length,mode==='success'?0:1);
    if(errors.length)assert.deepEqual(errors[0].error.metadata,{retry_safe:false,...(unknown?{outcome_unknown:true}:{}),request_id:id});
  }
  assert.equal(f.sends,1);
  const log=f.row('SELECT id,status,charged_cost FROM api_key_request_logs');assert.equal(log.id,id);
  assert.equal(log.status,mode==='success'?'success':'error');assert.equal(log.charged_cost,mode==='success'?0.1:0);
  const account=f.row('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?',f.fixture.ids.user);
  assert.deepEqual({...account},{budget_spent_micros:capacity||mode==='success'?100000:0,budget_reserved_micros:0});
  assert.equal(f.row('SELECT COUNT(*) AS n FROM api_key_request_logs').n,1);
  // SSE does not silently opt into ordinary-response durable recovery.
  for(const table of ['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs'])assert.equal(f.row(`SELECT COUNT(*) AS n FROM ${table}`).n,0);
  assert.ok(Object.values(await f.recover()).every(v=>v===0||v===false));assert.equal(f.sends,1);
  assert.deepEqual({...f.row('SELECT id,status,charged_cost FROM api_key_request_logs')},{...log});
});
