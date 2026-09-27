import assert from 'node:assert/strict';
import test from 'node:test';
import {dispatchOpenAiImageGenerations,IMAGE_GENERATION_TIMEOUT_MS,IMAGE_MAX_SSE_EVENT_BYTES} from '../../src/services/egress/openai-images-driver.ts';

const id='gen-synthetic-sse-outcome';
const encode=s=>new TextEncoder().encode(s);
const frame=o=>'data: '+JSON.stringify(o)+'\n\n';
const done='data: [DONE]\n\n';
const completed={type:'image_generation.completed',b64_json:'AQID',usage:{input_tokens:3,output_tokens:7,total_tokens:10}};
const partial={type:'image_generation.partial_image',partial_image_index:0,b64_json:'AQID'};
const provider={type:'error',error:{message:'Synthetic provider failure sk-1234567890abcdef',code:'image_content_policy_violation',
  metadata:{retry_safe:true,outcome_unknown:false,request_id:'spoofed',secret:'PRIVATE_METADATA'}}};
const route={targetId:'target-image',modelSurfaceId:'surface-image',routePoolId:'pool-image',providerId:'openai',providerName:'OpenAI',
  providerModelName:'gpt-image-1',upstreamProtocol:'openai',upstreamOperation:'images.generations',adapter:'passthrough',
  providerEndpoints:{openai:{base:'https://example.invalid/v1'}},providerApiKey:'synthetic-key',priceOverrideRaw:null,
  routeMeteredProfileJson:null,routeChargedProfileJson:null,customParams:null,routeGroup:'default',routePriority:1,routeWeight:1};
async function dispatch(t,body,options={},signal){
  t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
  t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});
  let sends=0;
  const result=await dispatchOpenAiImageGenerations(route,{prompt:'synthetic',n:1,stream:true},signal,null,undefined,{
    requestId:id,...options,fetchImpl:async()=>{sends++;return new Response(body,{headers:{'Content-Type':'text/event-stream','Retry-After':'1'}});},
  });
  assert.equal(sends,1);assert.equal(result.meta.failoverForbidden,true);assert.equal(result.response.status,200);
  assert.equal(result.response.headers.get('Retry-After'),null);return result;
}
function check(text,{unknown=true,requestId=id,code='server_error'}={}){
  assert.ok(text.length<4096,'bounded synthetic response');
  const records=text.split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>s.slice(6));
  assert.equal(records.filter(s=>s==='[DONE]').length,1);assert.equal(records.at(-1),'[DONE]');
  const errors=records.filter(s=>s!=='[DONE]').map(JSON.parse).filter(o=>o.type==='error');assert.equal(errors.length,1);
  const error=errors[0].error;assert.equal(error.code,code);
  assert.deepEqual(error.metadata,{retry_safe:false,...(unknown?{outcome_unknown:true}:{}),...(requestId?{request_id:requestId}:{})});
  assert.ok(error.message.length<=512);assert.doesNotMatch(text,/sk-1234567890abcdef|spoofed|PRIVATE_METADATA/);
}
async function nonbillable(result,capacity=false){
  const settlement=await result.meta.imageStreamSettlement;
  assert.equal(settlement.completed,false);assert.equal(settlement.validImages,0);
  assert.equal(settlement.imageUsage,null);assert.equal(settlement.upstreamSupplierCostUsdTicks,null);
  assert.equal(settlement.upstreamOutcomeUnknown,capacity?true:undefined);
  const usage=await result.usagePromise;assert.equal(usage.total_tokens,0);assert.equal(usage.raw_usage,null);
  return settlement;
}
const cases=[
  ['null-body',null],['empty-body',''],['invalid-json','data: {invalid\n\n'],['invalid-event',frame([])],
  ['invalid-partial',frame({...partial,partial_image_index:-1})],['invalid-completed',frame({...completed,b64_json:''})],
  ['unsupported',frame({type:'unexpected'})],['too-many',frame(completed)+frame(completed)],['done-only',done],
  ['missing-done',frame(completed)],['missing-usage',frame({type:'image_generation.completed',b64_json:'AQID'})+done,{requireAuthoritativeUsage:true}],
  ['key-limit',frame({...completed,['x'.repeat(257)]:0}),{}, {capacity:true}],
  ['usage-limit',frame({...completed,usage:{opaque:'x'.repeat(65537)}}),{}, {capacity:true,code:'image_usage_too_large'}],
  ['depth-limit','data: '+JSON.stringify({type:'unexpected',nested:JSON.parse('['.repeat(65)+'0'+']'.repeat(65))})+'\n\n'],
  ['provider-error',frame(provider),{}, {unknown:false,code:provider.error.code}],
  ['malformed-provider-error',frame({type:'error',error:null})],
  ['partial-before-provider-error',frame(partial)+frame(provider),{}, {code:provider.error.code}],
  ['completed-before-provider-error',frame(completed)+frame(provider),{}, {code:provider.error.code}],
];
for(const [name,body,options,expected={}] of cases)test(`SSE metadata: ${name}`,async t=>{
  const result=await dispatch(t,body,options);check(await result.response.text(),expected);await nonbillable(result,expected.capacity);
});
for(const delimiter of [false,true])test(`SSE oversized event, delimiter=${delimiter}`,async t=>{
  let chunks=0;const page=encode('x'.repeat(65536));
  const source=new ReadableStream({pull(c){if(chunks++<IMAGE_MAX_SSE_EVENT_BYTES/page.length)c.enqueue(page);
    else {c.enqueue(encode('x'+(delimiter?'\n\n':'')));c.close();}}});
  const result=await dispatch(t,source);check(await result.response.text());await nonbillable(result);assert.equal(source.locked,false);
});
for(const activeRead of [false,true])test(`SSE deadline metadata, pending read=${activeRead}`,{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});let cancels=0;
  const source=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancels++;return new Promise(()=>{});}});
  const result=await dispatch(t,source);const reader=result.response.body.getReader();const pending=activeRead?reader.read():null;
  t.mock.timers.tick(IMAGE_GENERATION_TIMEOUT_MS);let text='';
  if(pending){const next=await pending;if(!next.done)text+=new TextDecoder().decode(next.value);}
  for(;;){const next=await reader.read();if(next.done)break;text+=new TextDecoder().decode(next.value);}
  check(text);const outcome=await nonbillable(result);assert.equal(outcome.imageAbortReason,'gateway_timeout');
  assert.equal(cancels,1);assert.equal(source.locked,false);reader.releaseLock();
});
for(const stop of ['client','reader'])test(`SSE ${stop} cancellation does not promise an error frame to a departed client`,async t=>{
  const parent=new AbortController();let cancels=0;
  const source=new ReadableStream({cancel(){cancels++;}});const result=await dispatch(t,source,{},parent.signal);
  if(stop==='client'){parent.abort();assert.equal(await result.response.text(),'');}else await result.response.body.cancel();
  const outcome=await nonbillable(result);assert.equal(outcome.cancelled,true);assert.equal(outcome.imageAbortReason,'client_abort');assert.equal(cancels,1);
});
test('SSE success keeps completed payload and usage without injected error metadata',async t=>{
  const result=await dispatch(t,frame(completed)+done,{requireAuthoritativeUsage:true});
  const text=await result.response.text();assert.doesNotMatch(text,/retry_safe|outcome_unknown|request_id|"type":"error"/);
  const settlement=await result.meta.imageStreamSettlement;assert.equal(settlement.completed,true);assert.equal(settlement.validImages,1);
  assert.equal((await result.usagePromise).total_tokens,10);
});
for(const requestId of [undefined,'x'.repeat(201),'sk-1234567890abcdef'])test(`SSE trusted ID boundary: ${requestId?.length??'absent'}`,async t=>{
  const result=await dispatch(t,'data: invalid\n\n',{requestId});
  check(await result.response.text(),{requestId:requestId?.startsWith('sk-')?'[redacted]':null});await nonbillable(result);
});
for(const precedingOutput of [false,true])test(`SSE transport interruption, prior output=${precedingOutput}`,async t=>{
  let controller;const source=new ReadableStream({start(c){controller=c;if(precedingOutput)c.enqueue(encode(frame(partial)));}});
  const result=await dispatch(t,source);const reader=result.response.body.getReader();let text='';
  if(precedingOutput)text+=new TextDecoder().decode((await reader.read()).value);
  controller.error(new Error('PRIVATE_METADATA'));
  for(;;){const next=await reader.read();if(next.done)break;text+=new TextDecoder().decode(next.value);}
  check(text);await nonbillable(result);reader.releaseLock();assert.equal(source.locked,false);
});
