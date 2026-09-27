import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dispatchGeminiRoute} from './gemini-driver.ts';
import {RequestExecutionStoppedError} from '../request-deadline.ts';

const route = {
  targetId:'gemini-settlement', providerId:'synthetic', providerName:'synthetic',
  providerModelName:'synthetic', upstreamProtocol:'gemini', upstreamOperation:'models.generate',
  adapter:'passthrough', providerEndpoints:{gemini:{base:'https://synthetic.invalid/v1beta/models'}},
  providerApiKey:'synthetic-only', priceOverrideRaw:null, routeMeteredProfileJson:null,
  routeChargedProfileJson:null, customParams:null, routeGroup:'default', routePriority:0, routeWeight:1,
};
const encode = text => new TextEncoder().encode(text);
const flush = async () => { for(let i=0;i<40;i++)await Promise.resolve(); };
async function within(p) {
  let timer;
  try { return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Lifecycle did not complete within 1500ms')),1500);})]); }
  finally { clearTimeout(timer); }
}
function silence(t) { for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{}); }

for(const action of ['generateContent','streamGenerateContent'])for(const count of [0,5])
test(`Gemini normal settlement is immutable after EOF: ${action}/${count}`,{timeout:5000},async t=>{
  silence(t);
  const metadata={promptTokenCount:count,candidatesTokenCount:count,totalTokenCount:count*2};
  const json=JSON.stringify({usageMetadata:metadata,responseId:'synthetic-response-id'});
  t.mock.method(globalThis,'fetch',async()=>new Response(action==='generateContent'?json:'data: '+json+'\n\n',
    {headers:{'Content-Type':action==='generateContent'?'application/json':'text/event-stream'}}));
  const abort=new AbortController();
  const result=await dispatchGeminiRoute(route,{},action,'',abort.signal);
  const body=await within(result.response.text()); const usage=await within(result.usagePromise);
  const snapshot=JSON.stringify(usage);
  assert.ok(body.includes(json)); assert.equal(usage.total_tokens,count*2);
  assert.equal(usage.raw_usage,JSON.stringify(metadata));assert.equal(usage.upstreamMessageId,'synthetic-response-id');
  assert.notEqual(usage.cancelled,true);assert.equal(usage.stream_error,undefined);
  abort.abort();await flush();assert.equal(JSON.stringify(usage),snapshot);
});

for(const ack of ['resolve','reject'])
test(`Gemini malformed SSE records failure without cleanup ACK: ${ack}`,{timeout:5000},async t=>{
  silence(t);const gate=Promise.withResolvers();let cancels=0;
  const source=new ReadableStream({start(c){c.enqueue(new Uint8Array([255]));},cancel(){cancels++;return gate.promise;}});
  t.mock.method(globalThis,'fetch',async()=>new Response(source,{headers:{'Content-Type':'text/event-stream'}}));
  let result;t.after(async()=>{gate.resolve();await result?.response.body?.cancel().catch(()=>{});await flush();});
  result=await dispatchGeminiRoute(route,{},'streamGenerateContent','');
  const usage=await within(result.usagePromise);
  assert.ok(usage.stream_error);assert.notEqual(usage.cancelled,true);assert.equal(usage.raw_usage,null);
  assert.equal(cancels,1);assert.equal(source.locked,true);
  assert.equal(await within(result.response.text()),'');
  if(ack==='resolve')gate.resolve();else gate.reject(Error('synthetic cleanup rejection'));
  await flush();assert.equal(source.locked,false);assert.equal(cancels,1);
});

test('Gemini cancelled partial event cannot fabricate authoritative usage',{timeout:5000},async t=>{
  silence(t);const abort=new AbortController();let cancels=0;
  const source=new ReadableStream({start(c){c.enqueue(encode('data: {"usageMetadata":{"promptTokenCount":99}}'));},cancel(){cancels++;}});
  t.mock.method(globalThis,'fetch',async()=>new Response(source,{headers:{'Content-Type':'text/event-stream'}}));
  const result=await dispatchGeminiRoute(route,{},'streamGenerateContent','',abort.signal);
  await flush();abort.abort();const usage=await within(result.usagePromise);await flush();
  assert.equal(usage.cancelled,true);assert.equal(usage.raw_usage,null);assert.equal(usage.total_tokens,0);
  assert.equal(cancels,1);assert.equal(source.locked,false);await result.response.body.cancel();
});

test('Gemini driver deadline records failure before cleanup ACK without client-cancel reclassification',{timeout:5000},async t=>{
  silence(t);const gate=Promise.withResolvers(),abort=new AbortController();let cancels=0;
  const source=new ReadableStream({cancel(){cancels++;return gate.promise;}});
  t.mock.method(globalThis,'fetch',async()=>new Response(source,{headers:{'Content-Type':'text/event-stream'}}));
  let result;t.after(async()=>{gate.resolve();await result?.response.body?.cancel().catch(()=>{});await flush();});
  result=await dispatchGeminiRoute(route,{},'streamGenerateContent','',abort.signal);
  abort.abort(new RequestExecutionStoppedError('deadline_exceeded'));
  const usage=await within(result.usagePromise);
  assert.equal(usage.stream_error,'Request deadline exceeded');assert.notEqual(usage.cancelled,true);
  assert.equal(cancels,1);assert.equal(source.locked,true);
  gate.resolve();await flush();assert.equal(source.locked,false);await result.response.body.cancel();
});
