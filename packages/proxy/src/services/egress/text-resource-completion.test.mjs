import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchOpenAiRoute } from './openai-driver.ts';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver.ts';
import { dispatchAnthropicRoute } from './anthropic-driver.ts';
import { dispatchGeminiRoute } from './gemini-driver.ts';
import { failoverDispatch } from '../failover-dispatch.ts';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker.ts';
import { EMPTY_USAGE } from '../proxy.ts';

const event = x => 'data: ' + JSON.stringify(x) + '\n\n';
const profiles = [
 { name: 'chat', protocol: 'openai', operation: 'chat', direct: (r,s) => dispatchOpenAiRoute(r,{stream:true},s), terminal: 'data: [DONE]\n\n' },
 { name: 'responses', protocol: 'openai', operation: 'responses', direct: (r,s) => dispatchOpenAiResponsesRoute(r,{stream:true},s), terminal: event({type:'response.completed',response:{id:'synthetic',usage:{input_tokens:2,output_tokens:3,total_tokens:5}}})+'data: [DONE]\n\n' },
 { name: 'messages', protocol: 'anthropic', operation: 'messages', direct: (r,s) => dispatchAnthropicRoute(r,{stream:true},s), terminal: event({type:'message_stop'}) },
 { name: 'gemini', protocol: 'gemini', operation: 'models.generate', direct: (r,s) => dispatchGeminiRoute(r,{},'streamGenerateContent','',s), terminal: event({usageMetadata:{promptTokenCount:2,candidatesTokenCount:3,totalTokenCount:5}}) },
];
function route(p, index=0) { return {targetId:'resource-'+index,providerId:'resource-'+index,providerName:'synthetic',providerModelName:'synthetic',gatewayModelId:'public/synthetic',upstreamProtocol:p.protocol,upstreamOperation:p.operation,adapter:'passthrough',providerEndpoints:{[p.protocol]:{base:'https://synthetic.invalid/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:index,routeWeight:1}; }
const flush = async () => { for(let i=0;i<60;i++) await Promise.resolve(); };
function silence(t) { for(const n of ['log','warn','error']) t.mock.method(console,n,()=>{}); }

for(const p of profiles) for(const mode of ['signal','downstream']) for(const terminal of ['resolve','reject'])
test(`text resource ${p.name}/${mode}/${terminal}`, {timeout:3000}, async t => {
 silence(t); const gate=Promise.withResolvers(), started=Promise.withResolvers(), abort=new AbortController(); let cancels=0;
 const upstream=new ReadableStream({cancel(){cancels++;started.resolve();return gate.promise;}});
 t.mock.method(globalThis,'fetch',async()=>new Response(upstream,{headers:{'Content-Type':'text/event-stream'}}));
 const result=await p.direct(route(p),abort.signal); assert.ok(result.resourceCompletion instanceof Promise);
 t.after(async()=>{gate.resolve();abort.abort();await result.response.body.cancel().catch(()=>{});});
 let cleaned=false; void result.resourceCompletion.then(()=>{cleaned=true;});
 if(mode==='signal') abort.abort(); else await result.response.body.cancel();
 await started.promise; const usage=await result.usagePromise; await flush();
 assert.equal(usage.cancelled,true); assert.equal(cleaned,false); assert.equal(upstream.locked,true);
 if(terminal==='resolve') gate.resolve(); else gate.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,terminal==='resolve'?'confirmed':'unconfirmed');
 assert.equal(upstream.locked,false); assert.equal(cancels,1);
});

for(const p of profiles.slice(0,3)) for(const terminal of ['resolve','reject'])
test(`text resource normal terminal ${p.name}/${terminal} does not delay usage or DONE`, {timeout:3000}, async t => {
 silence(t); const gate=Promise.withResolvers(); let cancels=0;
 const upstream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(p.terminal));},cancel(){cancels++;return gate.promise;}});
 t.mock.method(globalThis,'fetch',async()=>new Response(upstream,{headers:{'Content-Type':'text/event-stream'}}));
 t.after(()=>{gate.resolve();}); const result=await p.direct(route(p));
 let cleaned=false; void result.resourceCompletion.then(()=>{cleaned=true;});
 const body=await result.response.text(); const usage=await result.usagePromise; await flush();
 assert.ok(body.length>0); assert.notEqual(usage.cancelled,true); assert.equal(usage.stream_error,undefined);
 assert.equal(cleaned,false); assert.equal(cancels,1); assert.equal(upstream.locked,false);
 if(terminal==='resolve') gate.resolve(); else gate.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,terminal==='resolve'?'confirmed':'unconfirmed');
});

for(const p of profiles) test(`text resource EOF ${p.name} confirms cleanup independent of protocol success`, {timeout:3000}, async t => {
 silence(t); let cancels=0;
 const upstream=new ReadableStream({start(c){c.close();},cancel(){cancels++;}});
 t.mock.method(globalThis,'fetch',async()=>new Response(upstream,{headers:{'Content-Type':'text/event-stream'}}));
 const result=await p.direct(route(p)); await result.response.text(); await result.usagePromise;
 assert.equal(await result.resourceCompletion,'confirmed'); assert.equal(upstream.locked,false); assert.equal(cancels,0);
});

const options={affinityKey:'',tierKeyPrefix:'',strategy:'weight_priority'};
for(const ack of ['confirmed','unconfirmed','reject']) test(`text resource failover keeps earlier attempt ${ack}`, {timeout:3000}, async t => {
 silence(t); resetProviderCircuitStateForTests(); const gate=Promise.withResolvers(); let registered, calls=0;
 const result=await failoverDispatch({},[route(profiles[0]),route(profiles[0],1)],'openai',async()=>{
  assert.ok(registered,'register before any dispatch'); calls++;
  return {response:new Response(calls===1?'unavailable':'ok',{status:calls===1?503:200}),usagePromise:Promise.resolve(EMPTY_USAGE),upstreamRequestId:null,resourceCompletion:calls===1?gate.promise:Promise.resolve('confirmed')};
 },undefined,{...options,registerResourceCompletion:task=>{registered=task;}});
 assert.equal(calls,2); assert.equal(result.resourceCompletion,registered); let cleaned=false; void registered.then(()=>{cleaned=true;});
 await result.response.text(); await result.usagePromise; await flush(); assert.equal(cleaned,false);
 if(ack==='reject') gate.reject(Error('PRIVATE')); else gate.resolve(ack);
 assert.equal(await registered,ack==='confirmed'?'confirmed':'unconfirmed');
});

for(const ack of ['confirmed','unconfirmed']) test(`text resource late dispatch remains owned after deadline: ${ack}`, {timeout:3000}, async t => {
 silence(t); resetProviderCircuitStateForTests(); t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const headers=Promise.withResolvers(),cleanup=Promise.withResolvers(),started=Promise.withResolvers(); let registered,calls=0;
 const pending=failoverDispatch({},[route(profiles[0]),route(profiles[0],1)],'openai',async()=>{calls++;started.resolve();return headers.promise;},undefined,{...options,requestDeadlineAtMs:Date.now()+100,registerResourceCompletion:task=>{registered=task;}});
 await started.promise; t.mock.timers.tick(100); const result=await pending;
 assert.equal(result.response.status,504); assert.equal(calls,1); let cleaned=false; void registered.then(()=>{cleaned=true;});
 await flush(); assert.equal(cleaned,false);
 headers.resolve({response:new Response(null),usagePromise:Promise.resolve(EMPTY_USAGE),upstreamRequestId:null,resourceCompletion:cleanup.promise});
 await flush(); assert.equal(cleaned,false); cleanup.resolve(ack); assert.equal(await registered,ack); assert.equal(calls,1);
});

test('text resource registration failure prevents dispatch', async () => {
 let calls=0; await assert.rejects(failoverDispatch({},[route(profiles[0])],'openai',async()=>{calls++;throw Error('unexpected');},undefined,{...options,registerResourceCompletion(){throw Error('registration failed');}}),/registration failed/);
 assert.equal(calls,0);
});
