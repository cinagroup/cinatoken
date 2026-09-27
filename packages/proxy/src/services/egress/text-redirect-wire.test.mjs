import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {dispatchOpenAiRoute} from './openai-driver.ts';
import {dispatchOpenAiResponsesRoute} from './openai-responses-driver.ts';
import {dispatchAnthropicRoute} from './anthropic-driver.ts';
import {dispatchGeminiRoute} from './gemini-driver.ts';
import {proxyChatCompletions,proxyResponses,proxyAnthropicMessages,proxyGeminiContent} from '../proxy.ts';
import {createRequestDispatchBudget} from '../request-dispatch-budget.ts';
import {resetProviderCircuitStateForTests} from '../provider-circuit-breaker.ts';

// Real Node fetch and HTTP sockets, synthetic credentials only. This does not
// emulate Workers cancellation or prove financial persistence / heap capacity.
const profiles=[
  {name:'chat',protocol:'openai',operation:'chat',direct:dispatchOpenAiRoute,proxy:proxyChatCompletions},
  {name:'responses',protocol:'openai',operation:'responses',direct:dispatchOpenAiResponsesRoute,proxy:proxyResponses},
  {name:'messages',protocol:'anthropic',operation:'messages',direct:dispatchAnthropicRoute,proxy:proxyAnthropicMessages},
  {name:'gemini',protocol:'gemini',operation:'models.generate',
    direct:(r,b,s,t,a,before)=>dispatchGeminiRoute(r,b,b.stream?'streamGenerateContent':'generateContent','',s,t,a,before),
    proxy:(repos,r,b,s,o)=>proxyGeminiContent(repos,r,'generateContent',b,'',s,o)},
];
function route(p,base,index=0){
  return {targetId:'wire-target-'+index,modelSurfaceId:null,routePoolId:'wire-pool',providerId:'wire-provider-'+index,
    providerName:'synthetic',providerModelName:'synthetic-model',gatewayModelId:'public/synthetic',upstreamProtocol:p.protocol,
    upstreamOperation:p.operation,adapter:'passthrough',providerEndpoints:{[p.protocol]:{base}},providerApiKey:'synthetic-wire-secret',
    providerSharedChannelType:null,priceOverrideRaw:null,routeMeteredProfileJson:null,routeChargedProfileJson:null,customParams:null,
    routeGroup:'default',routePriority:index,routeWeight:1,providerKeyId:'wire-key-'+index,providerKeyLabel:null,providerKeyFingerprint:null};
}
async function listen(server){
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return 'http://127.0.0.1:'+server.address().port;
}
async function wire(t,status,sameOrigin=false){
  const hits=[],servers=[];
  t.after(async()=>{await Promise.all(servers.map(s=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();})));});
  const receive=(kind,req,res)=>{
    const row={kind,method:req.method,bytes:0,credentialPresent:Boolean(req.headers.authorization||req.headers['x-api-key']||new URL(req.url,'http://localhost').searchParams.has('key'))};
    hits.push(row);req.on('data',chunk=>{row.bytes+=chunk.length;if(row.bytes>4096)req.destroy();});req.on('end',()=>{
      if(kind==='origin'&&status>=300&&status<400){res.writeHead(status,{Location:destination+'/sink'});res.end();}
      else {res.writeHead(kind==='sink'?400:status,{'Content-Type':'application/json'});res.end('{"error":{"message":"synthetic rejection"}}');}
    });
  };
  const sink=createServer((req,res)=>receive('sink',req,res));servers.push(sink);const sinkOrigin=await listen(sink);
  const origin=createServer((req,res)=>receive(req.url.startsWith('/sink')?'sink':'origin',req,res));servers.push(origin);
  const base=await listen(origin),destination=sameOrigin?base:sinkOrigin;
  const nativeFetch=globalThis.fetch;
  // The fixture emits only these two exact loopback origins as redirect targets.
  t.mock.method(globalThis,'fetch',(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    assert.ok([base,sinkOrigin].includes(url.origin),'No external transport allowed');
    return nativeFetch(input,init);
  });
  return {base:base+'/v1',hits};
}
for(const p of profiles)for(const status of [301,302,303,307,308])for(const stream of [false,true])for(const sameOrigin of [false,true])
test(`wire redirect blocked: ${p.name} ${status} stream=${stream} sameOrigin=${sameOrigin}`,{timeout:10000},async t=>{
  const f=await wire(t,status,sameOrigin),budget=createRequestDispatchBudget();let result,error;
  try{result=await p.direct(route(p,f.base),{messages:[],input:'synthetic',stream},undefined,undefined,undefined,async()=>budget.consume());}
  catch(e){error=e;}
  finally{await result?.response.body?.cancel();if(result)await result.usagePromise;}
  t.diagnostic(JSON.stringify({originRequests:f.hits.filter(h=>h.kind==='origin').length,redirectRequests:f.hits.filter(h=>h.kind==='sink').length,permits:budget.snapshot().permitsConsumed}));
  assert.equal(f.hits.filter(h=>h.kind==='sink').length,0,'No unbudgeted redirect GET/POST, body or credential forwarding');
  assert.equal(f.hits.length,1);assert.equal(f.hits[0].method,'POST');assert.ok(f.hits[0].bytes>0);
  assert.equal(budget.snapshot().permitsConsumed,1);assert.equal(error?.upstreamOutcomeUnknown,true);
});
for(const p of profiles)for(const count of [4,40])for(const status of [307,308])
test(`redirect cannot become another model/key attempt: ${p.name} ${status} candidates=${count}`,{timeout:10000},async t=>{
  resetProviderCircuitStateForTests();const f=await wire(t,status),budget=createRequestDispatchBudget();
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  const result=await p.proxy({},Array.from({length:count},(_,i)=>route(p,f.base,i)),{messages:[],input:'synthetic'},undefined,
    {affinityKey:'',tierKeyPrefix:'',strategy:'weight_priority',dispatchBudget:budget});
  await result.response.body?.cancel();await result.usagePromise;
  assert.equal(f.hits.filter(h=>h.kind==='sink').length,0);assert.equal(f.hits.length,1);
  assert.equal(budget.snapshot().permitsConsumed,1);assert.equal(result.meta?.upstreamOutcomeUnknown,true);assert.equal(result.meta?.failoverForbidden,true);
});
for(const p of profiles)for(const count of [4,40])for(const status of [429,503])
test(`sent POST rejection respects replay boundary: ${p.name} ${status} candidates=${count}`,{timeout:10000},async t=>{
  resetProviderCircuitStateForTests();const f=await wire(t,status),budget=createRequestDispatchBudget();
  for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
  const result=await p.proxy({},Array.from({length:count},(_,i)=>route(p,f.base,i)),{messages:[],input:'synthetic'},undefined,
    {affinityKey:'',tierKeyPrefix:'',strategy:'weight_priority',dispatchBudget:budget});
  await result.response.body?.cancel();await result.usagePromise;
  const expectedSends=status===503?1:3;
  assert.equal(f.hits.length,expectedSends);assert.ok(f.hits.every(h=>h.kind==='origin'&&h.method==='POST'));
  assert.equal(budget.snapshot().permitsConsumed,expectedSends);assert.equal(result.meta?.failoverForbidden,true);
  assert.equal(result.meta?.upstreamOutcomeUnknown,status===503?true:undefined);
  if(status===429)assert.equal(result.response.headers.get('X-OctaFuse-Error-Code'),'gateway.dispatch_limit_exceeded');
});
