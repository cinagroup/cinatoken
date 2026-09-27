import assert from 'node:assert/strict';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import {ownUpstreamResponse} from './owned-upstream-response.ts';
import {dispatchOpenAiEmbeddingsRoute,OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES} from './openai-embeddings-driver.ts';
import {dispatchOpenAiRerankRoute,OPENAI_RERANK_RESPONSE_MAX_BYTES} from './openai-rerank-driver.ts';

const variants=['embeddings','rerank'];
const drivers={embeddings:dispatchOpenAiEmbeddingsRoute,rerank:dispatchOpenAiRerankRoute};
const limits={embeddings:OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES,rerank:OPENAI_RERANK_RESPONSE_MAX_BYTES};
const encode=value=>new TextEncoder().encode(value);
const route=v=>({targetId:'vector-resource',providerId:'synthetic',providerName:'Synthetic',providerModelName:'private-model',gatewayModelId:'public-model',upstreamProtocol:'openai',upstreamOperation:v,adapter:'passthrough',providerEndpoints:{openai:{base:'https://synthetic.invalid/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1});
const input=v=>v==='embeddings'?{input:['hello']}:{query:'hello',documents:['world']};
const output=v=>v==='embeddings'?{object:'list',model:'private-model',data:[{object:'embedding',index:0,embedding:[0.1]}],usage:{prompt_tokens:1,total_tokens:1}}:{model:'private-model',results:[{index:0,relevance_score:0.5}],usage:{total_tokens:1}};

for(const v of variants)for(const kind of ['mime','declared-size','observed-size','abort-read','non-ok-cancel','late-non-ok'])for(const ack of ['resolve','reject'])
test(`vector response resource ${v}/${kind}/${ack}`,{timeout:5000},async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers(),headers=Promise.withResolvers(),abort=new AbortController();let cancels=0,sends=0;
 const source=new ReadableStream({pull(c){entered.resolve();if(kind==='observed-size')c.enqueue(new Uint8Array(limits[v]+1));},cancel(){cancels++;return gate.promise;}},{highWaterMark:0});
 t.after(()=>{gate.resolve();abort.abort();});
 t.mock.method(globalThis,'fetch',async()=>{sends++;if(kind==='late-non-ok')await headers.promise;return new Response(source,{status:kind.includes('non-ok')?400:200,headers:{'Content-Type':kind==='mime'?'text/html':'application/json',...(kind==='declared-size'?{'Content-Length':String(limits[v]+1)}:{})}});});
 const pending=drivers[v](route(v),input(v),abort.signal);
 if(kind==='abort-read'){await entered.promise;abort.abort();}
 if(kind==='late-non-ok'){await tick();assert.equal(sends,1);abort.abort();headers.resolve();}
 const result=await pending;assert.ok(result.resourceCompletion instanceof Promise);
 if(kind==='non-ok-cancel')await result.response.body.cancel();
 if(kind==='late-non-ok')await assert.rejects(result.response.text(),/stopped/);
 assert.equal(result.response.status,kind.includes('non-ok')?400:502);
 let finished=false;void result.resourceCompletion.then(()=>{finished=true;});
 await result.usagePromise;await tick();assert.equal(finished,false);assert.equal(cancels,1);assert.equal(source.locked,false);assert.equal(getEventListeners(abort.signal,'abort').length,0);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_CANCEL_DETAIL'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');assert.equal(sends,1);
});

for(const v of variants)for(const mode of ['success','invalid-json','invalid-schema','non-ok-eof','no-body'])
test(`vector response EOF ${v}/${mode}`,async t=>{
 const abort=new AbortController();
 t.mock.method(globalThis,'fetch',async()=>mode==='no-body'?new Response(null,{status:204}):new Response(mode==='invalid-json'?'{':JSON.stringify(mode==='invalid-schema'?{}:output(v)),{status:mode==='non-ok-eof'?400:200,headers:{'Content-Type':'application/json','X-Request-Id':'upstream-trusted'}}));
 const result=await drivers[v](route(v),input(v),abort.signal);await result.response.text();
 assert.equal(await result.resourceCompletion,'confirmed');assert.equal(result.response.status,mode==='success'?200:mode==='non-ok-eof'?400:502);
 if(mode==='success')assert.equal((await result.usagePromise).total_tokens,1);
 assert.equal(getEventListeners(abort.signal,'abort').length,0);abort.abort();assert.equal(await result.resourceCompletion,'confirmed');
});

test('owned response does not prefetch; final chunk is not consumer EOF',async()=>{
 let pulls=0,cancels=0;const source=new ReadableStream({pull(c){if(pulls++===0)c.enqueue(encode('hello'));else c.close();},cancel(){cancels++;}},{highWaterMark:0});
 const result=ownUpstreamResponse(new Response(source,{status:400,statusText:'Synthetic',headers:{'X-Example':'yes'}}));
 await tick();assert.equal(pulls,0);let done=false;void result.resourceCompletion.then(()=>{done=true;});
 const reader=result.response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'hello');await tick();assert.equal(done,false);assert.equal(pulls,1);
 assert.equal((await reader.read()).done,true);assert.equal(await result.resourceCompletion,'confirmed');assert.equal(cancels,0);assert.equal(source.locked,false);assert.equal(result.response.statusText,'Synthetic');assert.equal(result.response.headers.get('X-Example'),'yes');
});

test('owned response source read error is unconfirmed and does not leak error detail',async()=>{
 const source=new ReadableStream({pull(c){c.error(Error('PRIVATE_READ_DETAIL'));}},{highWaterMark:0});
 const result=ownUpstreamResponse(new Response(source));await assert.rejects(result.response.text(),/Upstream response body unavailable/);
 assert.equal(await result.resourceCompletion,'unconfirmed');assert.equal(source.locked,false);
});

for(const mode of ['pre-abort','abort-pending-read','downstream-cancel'])test('owned response delayed cancellation '+mode,async t=>{
 const gate=Promise.withResolvers(),abort=new AbortController();let cancels=0;
 const source=new ReadableStream({cancel(){cancels++;return gate.promise;}},{highWaterMark:0});
 if(mode==='pre-abort')abort.abort();
 const result=ownUpstreamResponse(new Response(source),abort.signal);t.after(()=>gate.resolve());
 if(mode==='downstream-cancel')await result.response.body.cancel();
 else {const reading=result.response.text();if(mode==='abort-pending-read')abort.abort();await assert.rejects(reading,/stopped/);}
 let finished=false;void result.resourceCompletion.then(()=>{finished=true;});await tick();assert.equal(finished,false);assert.equal(cancels,1);assert.equal(source.locked,false);
 gate.resolve();assert.equal(await result.resourceCompletion,'confirmed');abort.abort();assert.equal(cancels,1);
});
