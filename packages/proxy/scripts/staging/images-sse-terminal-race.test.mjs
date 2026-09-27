import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {dispatchOpenAiImageGenerations,IMAGE_GENERATION_TIMEOUT_MS} from '../../src/services/egress/openai-images-driver.ts';
const route={targetId:'t',modelSurfaceId:'s',routePoolId:'p',providerId:'test',providerName:'Test',providerModelName:'test',
  upstreamProtocol:'openai',upstreamOperation:'images.generations',adapter:'passthrough',providerEndpoints:{openai:{base:'https://example.invalid/v1'}},
  providerApiKey:'synthetic-key',priceOverrideRaw:null,routeMeteredProfileJson:null,routeChargedProfileJson:null,customParams:null,routeGroup:'default',routePriority:1,routeWeight:1};
const done='data: [DONE]\n\n',image='data: {"type":"image_generation.completed","b64_json":"AQID"}\n\n';
const cases=['done-only','early-eof','transport'].flatMap(mode=>[false,true].map(prefetch=>({mode,prefetch})))
  .concat([{mode:'missing-usage',prefetch:true},{mode:'success',prefetch:true}]);
for(const {mode,prefetch} of cases)test(`SSE terminal race: ${mode}, prefetch=${prefetch}`,{timeout:5000},async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});t.mock.method(console,'log',()=>{});
  t.mock.method(globalThis,'fetch',async()=>{throw Error('No external network');});
  const body=mode==='transport'?new ReadableStream({start(c){c.error(Error('Synthetic transport error'));}})
    :mode==='done-only'?done:mode==='early-eof'?'':image+done;
  let sends=0;
  const result=await dispatchOpenAiImageGenerations(route,{prompt:'synthetic',stream:true},undefined,null,undefined,{
    requestId:'gen-synthetic',requireAuthoritativeUsage:mode==='missing-usage',
    fetchImpl:async()=>{sends++;return new Response(body,{headers:{'Content-Type':'text/event-stream'}});},
  });
  const reader=result.response.body.getReader(),chunks=[];
  const first=await reader.read();chunks.push(new TextDecoder().decode(first.value));
  if(prefetch)await setImmediate();t.mock.timers.tick(IMAGE_GENERATION_TIMEOUT_MS);
  const outcome=await result.meta.imageStreamSettlement;
  // Preserve legacy cancellation/timeout accounting even with terminal bytes queued.
  assert.equal(outcome.completed,false);assert.equal(outcome.validImages,0);
  assert.equal(outcome.imageUsage,null);assert.equal(outcome.imageAbortReason,'gateway_timeout');
  assert.equal((await result.usagePromise).total_tokens,0);assert.equal(sends,1);
  for(let i=0;;i++){assert.ok(i<8);const next=await reader.read();if(next.done)break;chunks.push(new TextDecoder().decode(next.value));}
  reader.releaseLock();const records=chunks.join('').split('\n\n').filter(s=>s.startsWith('data: '))
    .map(s=>s==='data: [DONE]'?{type:'DONE'}:JSON.parse(s.slice(6)));
  assert.deepEqual(records.map(r=>r.type),mode==='success'?['image_generation.completed','DONE']
    :mode==='missing-usage'?['image_generation.completed','error','DONE']:['error','DONE']);
  for(const record of records.filter(r=>r.type==='error'))assert.deepEqual(record.error.metadata,
    {retry_safe:false,outcome_unknown:true,request_id:'gen-synthetic'});
  assert.equal(records.at(-1).type,'DONE');assert.equal(records.filter(r=>r.type==='DONE').length,1);
});
