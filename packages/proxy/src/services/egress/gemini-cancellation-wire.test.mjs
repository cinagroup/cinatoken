import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {dispatchGeminiRoute} from './gemini-driver.ts';
import {proxyGeminiContent} from '../proxy.ts';
import {createRequestDispatchBudget} from '../request-dispatch-budget.ts';
import {RequestExecutionStoppedError} from '../request-deadline.ts';
import {resetProviderCircuitStateForTests} from '../provider-circuit-breaker.ts';

const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function within(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Expected terminal state not observed within 1500ms')),1500);})]);}finally{clearTimeout(timer);}}
function route(base,i=0){return {targetId:'gemini-cancel-'+i,modelSurfaceId:null,routePoolId:'cancel-pool',providerId:'cancel-provider-'+i,providerName:'synthetic',providerModelName:'synthetic-model',gatewayModelId:'public/synthetic',upstreamProtocol:'gemini',upstreamOperation:'models.generate',adapter:'passthrough',providerEndpoints:{gemini:{base}},providerApiKey:'synthetic-only',providerSharedChannelType:null,priceOverrideRaw:null,routeMeteredProfileJson:null,routeChargedProfileJson:null,customParams:null,routeGroup:'default',routePriority:i,routeWeight:1,providerKeyId:null,providerKeyLabel:null,providerKeyFingerprint:null};}
const chunk='data: '+JSON.stringify({usageMetadata:{promptTokenCount:2,candidatesTokenCount:3,totalTokenCount:5}})+'\n\n';
async function wire(t,phase){
  const reached=Promise.withResolvers(),closed=Promise.withResolvers(),headersReceived=Promise.withResolvers();let sends=0,upstreamResponse;
  const server=createServer((req,res)=>{sends++;req.resume();req.on('end',()=>{
    res.on('close',()=>closed.resolve());
    if(phase!=='headers'){res.writeHead(200,{'Content-Type':phase==='json'?'application/json':'text/event-stream'});res.flushHeaders();if(phase==='json')res.write('{');if(phase==='blocked-write')res.write(chunk);}
    reached.resolve();
  });});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const native=globalThis.fetch;t.mock.method(globalThis,'fetch',async(input,init)=>{assert.equal(new URL(String(input)).origin,base);const response=await native(input,init);upstreamResponse=response;headersReceived.resolve();return response;});
  return {base:base+'/v1',reached:reached.promise,closed:closed.promise,headersReceived:headersReceived.promise,bodyLocked:()=>upstreamResponse?.body?.locked,sends:()=>sends};
}
for(const reason of ['client_cancelled','deadline_exceeded'])for(const [phase,action] of [['headers','generateContent'],['headers','streamGenerateContent'],['json','generateContent'],['silent','streamGenerateContent'],['blocked-write','streamGenerateContent']])
test(`Gemini wire stop: ${phase} ${action} ${reason}`,{timeout:10000},async t=>{
  const f=await wire(t,phase),abort=new AbortController(),budget=createRequestDispatchBudget();let result;
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  t.after(async()=>{abort.abort();if(result)await result.response.body?.cancel().catch(()=>{});});
  const pending=dispatchGeminiRoute(route(f.base),{},action,'',abort.signal,undefined,undefined,async()=>budget.consume()).then(value=>{result=value;return {value};},error=>({error}));
  await within(f.reached);
  if(phase==='json'){await within(f.headersReceived);await flush();assert.equal(f.bodyLocked(),true,'Actual JSON reader acquired before abort');}
  if(phase==='silent'||phase==='blocked-write'){const outcome=await within(pending);assert.ok(outcome.value);await flush();}
  abort.abort(new RequestExecutionStoppedError(reason));
  const outcome=await within(pending);
  if(phase==='headers')assert.equal(outcome.error?.upstreamOutcomeUnknown,true);
  else if(phase==='json'){assert.equal(outcome.value.meta?.upstreamOutcomeUnknown,true);assert.equal(outcome.value.meta?.failoverForbidden,true);}
  else {const usage=await within(outcome.value.usagePromise);if(reason==='deadline_exceeded'){assert.notEqual(usage.cancelled,true);assert.equal(usage.stream_error,'Request deadline exceeded');}else assert.equal(usage.cancelled,true);}
  await within(f.closed);assert.equal(f.sends(),1);assert.equal(budget.snapshot().permitsConsumed,1);
});
for(const reason of ['client_cancelled','deadline_exceeded'])test('Gemini outer dispatcher cannot replay a cancelled pending fetch: '+reason,{timeout:10000},async t=>{
  resetProviderCircuitStateForTests();const f=await wire(t,'headers'),abort=new AbortController(),budget=createRequestDispatchBudget();
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  const pending=proxyGeminiContent({},Array.from({length:40},(_,i)=>route(f.base,i)),'generateContent',{},'',abort.signal,{affinityKey:'',tierKeyPrefix:'',strategy:'weight_priority',dispatchBudget:budget,requestDeadlineAtMs:Date.now()+10000});
  void pending.catch(()=>{});await within(f.reached);abort.abort(new RequestExecutionStoppedError(reason));const result=await within(pending);
  await result.response.body?.cancel();await result.usagePromise;await within(f.closed);
  assert.equal(result.meta?.failoverForbidden,true);assert.equal(f.sends(),1);assert.equal(budget.snapshot().permitsConsumed,1);
});
for(const cancelMode of ['signal','downstream'])for(const terminal of ['resolve','reject'])
test(`Gemini synthetic cancel ownership: ${cancelMode} / ${terminal}`,{timeout:10000},async t=>{
  const gate=Promise.withResolvers(),abort=new AbortController();let source,closed=false,cancels=0,result;
  gate.promise.catch(()=>{});
  const upstream=new ReadableStream({start(c){source=c;},cancel(){closed=true;cancels++;return gate.promise;}});
  t.mock.method(globalThis,'fetch',async()=>new Response(upstream,{headers:{'Content-Type':'text/event-stream'}}));
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  t.after(async()=>{gate.resolve();if(!closed)source.error(Error('test cleanup'));await result?.response.body?.cancel().catch(()=>{});if(result)await within(result.usagePromise);});
  result=await dispatchGeminiRoute(route('https://synthetic.invalid/v1'),{},'streamGenerateContent','',abort.signal);
  let settled=false;void result.usagePromise.then(()=>{settled=true;});
  if(cancelMode==='signal')abort.abort();else await result.response.body.cancel();
  await flush();assert.equal(cancels,1);assert.equal(settled,true,'Usage facts must not wait for an untrusted cleanup ACK');assert.equal(upstream.locked,true,'Pending cleanup remains owned by the pump');
  if(terminal==='resolve')gate.resolve();else gate.reject(Error('synthetic cleanup rejected'));
  const usage=await within(result.usagePromise);await flush();assert.equal(usage.cancelled,true);assert.equal(cancels,1);assert.equal(upstream.locked,false);
});
