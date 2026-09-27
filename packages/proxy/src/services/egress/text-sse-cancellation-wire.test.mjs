import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {dispatchOpenAiRoute} from './openai-driver.ts';
import {dispatchOpenAiResponsesRoute} from './openai-responses-driver.ts';
import {dispatchAnthropicRoute} from './anthropic-driver.ts';
import {createRequestDispatchBudget} from '../request-dispatch-budget.ts';
import {RequestExecutionStoppedError} from '../request-deadline.ts';

const event=x=>'data: '+JSON.stringify(x)+'\n\n';
const profiles=[
 {name:'chat',protocol:'openai',operation:'chat',direct:dispatchOpenAiRoute,
  chunk:event({id:'synthetic',choices:[],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}),terminal:'data: [DONE]\n\n'},
 {name:'responses',protocol:'openai',operation:'responses',direct:dispatchOpenAiResponsesRoute,
  chunk:event({type:'response.completed',response:{id:'synthetic',usage:{input_tokens:2,output_tokens:3,total_tokens:5}}}),terminal:'data: [DONE]\n\n'},
 {name:'messages',protocol:'anthropic',operation:'messages',direct:dispatchAnthropicRoute,
  chunk:event({type:'message_delta',usage:{input_tokens:2,output_tokens:3}}),terminal:event({type:'message_stop'})},
];
function route(p,base){return {targetId:'synthetic',providerId:'synthetic',providerName:'synthetic',providerModelName:'synthetic',gatewayModelId:'public/synthetic',upstreamProtocol:p.protocol,upstreamOperation:p.operation,adapter:'passthrough',providerEndpoints:{[p.protocol]:{base}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1};}
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
async function within(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No terminal state within 1500ms')),1500);})]);}finally{clearTimeout(timer);}}
function silence(t){for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});}
function checkStop(usage,mode){if(mode==='deadline_exceeded'){assert.notEqual(usage.cancelled,true);assert.equal(usage.stream_error,'Request deadline exceeded');}else assert.equal(usage.cancelled,true);}

for(const p of profiles)for(const mode of ['client_cancelled','deadline_exceeded','downstream'])for(const phase of ['silent','blocked-write'])
test(`text SSE wire cancellation: ${p.name} ${mode} ${phase}`,{timeout:10000},async t=>{
 silence(t);let sends=0,result;const closed=Promise.withResolvers(),abort=new AbortController(),budget=createRequestDispatchBudget();
 const server=createServer((req,res)=>{sends++;req.resume();req.on('end',()=>{res.on('close',()=>closed.resolve());res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();if(phase==='blocked-write')res.write(p.chunk);});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{abort.abort();await result?.response.body?.cancel().catch(()=>{});await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
 const base='http://127.0.0.1:'+server.address().port,native=globalThis.fetch;
 t.mock.method(globalThis,'fetch',(input,init)=>{assert.equal(new URL(String(input)).origin,base);return native(input,init);});
 result=await within(p.direct(route(p,base+'/v1'),{stream:true},abort.signal,undefined,undefined,async()=>budget.consume()));
 await flush();
 if(mode==='downstream')await result.response.body.cancel();else abort.abort(new RequestExecutionStoppedError(mode));
 const usage=await within(result.usagePromise);checkStop(usage,mode);await within(closed.promise);
 assert.equal(sends,1);assert.equal(budget.snapshot().permitsConsumed,1);
});

for(const p of profiles)for(const mode of ['signal','downstream','terminal'])for(const terminal of ['resolve','reject'])
test(`text SSE cancel ownership: ${p.name} ${mode} ${terminal}`,{timeout:10000},async t=>{
 silence(t);const gate=Promise.withResolvers(),started=Promise.withResolvers(),abort=new AbortController();let cancels=0,controller,result,readTask;
 const upstream=new ReadableStream({start(c){controller=c;if(mode==='terminal')c.enqueue(new TextEncoder().encode(p.chunk+p.terminal));},cancel(){cancels++;started.resolve();return gate.promise;}});
 t.mock.method(globalThis,'fetch',async()=>new Response(upstream,{headers:{'Content-Type':'text/event-stream'}}));
 t.after(async()=>{gate.resolve();abort.abort();if(!cancels)controller.error(Error('fixture cleanup'));if(!result?.response.body?.locked)await result?.response.body?.cancel().catch(()=>{});await readTask?.catch(()=>{});});
 result=await p.direct(route(p,'https://synthetic.invalid/v1'),{stream:true},abort.signal);
 let settled=false;void result.usagePromise.then(()=>{settled=true;});
 if(mode==='signal')abort.abort();else if(mode==='downstream')await result.response.body.cancel();else {readTask=result.response.text();void readTask.catch(()=>{});}
 await within(started.promise);await flush();assert.equal(cancels,1);
 if(mode==='terminal'){
  const usage=await within(result.usagePromise);assert.equal(upstream.locked,false);assert.notEqual(usage.cancelled,true);assert.equal(usage.stream_error,undefined);assert.equal(usage.total_tokens,5);
  assert.ok((await within(readTask)).includes(p.terminal.trim()),'Normal success does not wait for upstream cancel ACK');
 }else {assert.equal(settled,true,'Cancellation facts must not wait for an untrusted cleanup ACK');assert.equal(upstream.locked,true,'Pump retains pending reader cleanup separately');}
 if(terminal==='resolve')gate.resolve();else gate.reject(Error('synthetic cleanup failure'));
 const usage=await within(result.usagePromise);await flush();assert.equal(upstream.locked,false);assert.equal(cancels,1);
 if(mode==='terminal'){assert.notEqual(usage.cancelled,true);assert.equal(usage.stream_error,undefined);assert.equal(usage.total_tokens,5);assert.ok((await within(readTask)).includes(p.terminal.trim()));}else assert.equal(usage.cancelled,true);
});

for(const p of profiles)test(`text SSE cancellation discards incomplete event: ${p.name}`,{timeout:10000},async t=>{
 silence(t);const abort=new AbortController();let cancelled=false;
 const upstream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(p.chunk.trimEnd()));},cancel(){cancelled=true;}});
 t.mock.method(globalThis,'fetch',async()=>new Response(upstream,{headers:{'Content-Type':'text/event-stream'}}));
 const result=await p.direct(route(p,'https://synthetic.invalid/v1'),{stream:true},abort.signal);
 t.after(async()=>{abort.abort();await result.response.body.cancel().catch(()=>{});});
 await flush();abort.abort();const usage=await within(result.usagePromise);
 assert.equal(cancelled,true);assert.equal(usage.cancelled,true);assert.equal(usage.total_tokens,0,'Cancellation is not EOF permission to parse a partial event');assert.equal(usage.raw_usage,null);
});
