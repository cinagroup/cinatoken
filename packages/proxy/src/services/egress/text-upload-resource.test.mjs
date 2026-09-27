import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { setImmediate as tick } from 'node:timers/promises';
import { GCP_OAUTH_TOKEN_URL, clearGcpServiceAccountTokenCache } from '@octafuse/core';
import { dispatchOpenAiRoute } from './openai-driver.ts';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver.ts';
import { dispatchAnthropicRoute } from './anthropic-driver.ts';
import { dispatchGeminiRoute } from './gemini-driver.ts';

const profiles = [
  { name: 'chat', protocol: 'openai', operation: 'chat', driver: dispatchOpenAiRoute },
  { name: 'responses', protocol: 'openai', operation: 'responses', driver: dispatchOpenAiResponsesRoute },
  { name: 'messages', protocol: 'anthropic', operation: 'messages', driver: dispatchAnthropicRoute },
  { name: 'gemini', protocol: 'gemini', operation: 'models.generate' },
];
const route = p => ({ targetId: 'text-upload', providerId: 'synthetic', providerName: 'Synthetic', providerModelName: 'private-model', gatewayModelId: 'public-model',
  upstreamProtocol: p.protocol, upstreamOperation: p.operation, adapter: 'passthrough', providerEndpoints: { [p.protocol]: { base: 'https://synthetic.invalid/v1', ...(p.name === 'gemini' ? { auth: 'bearer' } : {}) } },
  providerApiKey: 'synthetic-only', customParams: null, routeGroup: 'default', routePriority: 0, routeWeight: 1 });
const input = (p, text = 'hello', stream = false) => p.name === 'gemini' ? { contents: [{ role: 'user', parts: [{ text }] }] }
  : p.name === 'responses' ? { input: text, stream } : { messages: [{ role: 'user', content: text }], stream };
const call = (p,r,b,s,admit,stream=false) => p.name === 'gemini' ? dispatchGeminiRoute(r,b,stream?'streamGenerateContent':'generateContent','',s,undefined,undefined,admit)
  : p.driver(r,b,s,undefined,undefined,admit);
const wire = (p,b) => p.name === 'gemini' ? b : { ...b, model: 'private-model', ...(p.name === 'chat' && b.stream ? { stream_options: { include_usage: true } } : {}) };
const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
const chatUsage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
const geminiUsage = { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 };
const output = p => p.name === 'chat' ? { id:'synthetic', object:'chat.completion', created:1, model:'private-model', choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}], usage:chatUsage }
  : p.name === 'responses' ? {id:'synthetic',object:'response',created_at:1,completed_at:2,status:'completed',model:'private-model',output:[],usage}
  : p.name === 'messages' ? {id:'synthetic',type:'message',role:'assistant',model:'private-model',content:[],stop_reason:'end_turn',stop_sequence:null,usage}
  : {responseId:'synthetic',candidates:[{content:{parts:[{text:'ok'}]}}],usageMetadata:geminiUsage};
const event = v => 'data: '+JSON.stringify(v)+'\n\n';
function response(p, stream) {
  if (!stream) return Response.json(output(p));
  const text = p.name === 'chat' ? event({id:'synthetic',choices:[],usage:chatUsage})+'data: [DONE]\n\n'
    : p.name === 'responses' ? event({type:'response.completed',response:output(p)})+'data: [DONE]\n\n'
    : p.name === 'messages' ? event({type:'message_start',message:{id:'synthetic',usage}})+event({type:'message_stop'})
    : event({usageMetadata:geminiUsage});
  return new Response(text,{headers:{'Content-Type':'text/event-stream'}});
}

for (const p of profiles) for (const stream of [false,true]) for (const mode of ['full','unused','cancel','locked','partial','last-page'])
test(`text upload ${p.name}/${stream?'sse':'json'}/${mode}`,{timeout:5000},async t=>{
  const parent=new AbortController(),body=input(p,mode==='partial'?'x'.repeat(200000):'中😀\n"\\\ud800',stream),expected=JSON.stringify(wire(p,body));let sends=0,reader;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    sends++;assert.ok(init.body instanceof ReadableStream);assert.equal(init.duplex,'half');assert.equal(init.redirect,'manual');
    assert.equal(Number(new Headers(init.headers).get('Content-Length')),Buffer.byteLength(expected));
    if(mode==='full'){const chunks=[];for await(const chunk of init.body){assert.ok(chunk.byteLength<=65536);chunks.push(chunk);}assert.equal(Buffer.concat(chunks).toString(),expected);}
    if(mode==='cancel')await init.body.cancel();
    if(['locked','partial','last-page'].includes(mode)){reader=init.body.getReader();if(mode!=='locked')assert.equal((await reader.read()).done,false);}
    return response(p,stream);
  });
  const result=await call(p,route(p),body,parent.signal,undefined,stream);
  assert.equal(result.response.status,200);await result.response.text();assert.equal((await result.usagePromise).total_tokens,5);
  assert.equal(await result.resourceCompletion,['full','unused','cancel'].includes(mode)?'confirmed':'unconfirmed');
  assert.equal(getEventListeners(parent.signal,'abort').length,0);assert.equal(sends,1);
  if(reader){await assert.rejects(reader.read(),/JSON upload stopped/);reader.releaseLock();}
  parent.abort();assert.equal((await result.usagePromise).total_tokens,5);
});

for(const p of profiles)for(const mode of ['snapshot','cancel-admission','throw-admission','bad-header','fetch-reject'])
test(`text upload preparation ${p.name}/${mode}`,async t=>{
  const parent=new AbortController(),body={...input(p),metadata:{value:'original'}},r=route(p),expected=JSON.stringify(wire(p,body));let sends=0,admissions=0;
  if(mode==='bad-header')r.providerApiKey='invalid\nheader';
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    sends++;assert.ok(init.body instanceof ReadableStream);if(mode==='fetch-reject')throw Error('synthetic transport failure');
    assert.equal(await new Response(init.body).text(),expected);return response(p,false);
  });
  const pending=call(p,r,body,parent.signal,async()=>{admissions++;if(mode==='snapshot')body.metadata.value='mutated';if(mode==='cancel-admission')parent.abort();if(mode==='throw-admission')throw Error('synthetic admission failure');});
  if(['throw-admission','bad-header','fetch-reject'].includes(mode))await assert.rejects(pending);
  else{const result=await pending;assert.equal(result.response.status,mode==='cancel-admission'?499:200);await result.response.text();assert.equal(await result.resourceCompletion,'confirmed');}
  assert.equal(sends,['snapshot','fetch-reject'].includes(mode)?1:0);assert.equal(admissions,mode==='bad-header'?0:1);assert.equal(getEventListeners(parent.signal,'abort').length,0);
});

for(const p of profiles)for(const uploadMode of ['full','partial'])for(const ack of ['resolve','reject'])
test(`text upload and response ${p.name}/${uploadMode}/${ack}`,async t=>{
  const gate=Promise.withResolvers();let reader,cancels=0;t.after(()=>gate.resolve());
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    assert.ok(init.body instanceof ReadableStream);if(uploadMode==='full')await new Response(init.body).text();else{reader=init.body.getReader();await reader.read();}
    return new Response(new ReadableStream({cancel(){cancels++;return gate.promise;}}),{status:400});
  });
  const result=await call(p,route(p),input(p));assert.equal(result.response.status,400);await result.response.body.cancel();await result.usagePromise;
  let settled=false;void result.resourceCompletion.then(()=>{settled=true;});await tick();assert.equal(settled,false);assert.equal(cancels,1);
  if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_ACK'));
  assert.equal(await result.resourceCompletion,uploadMode==='full'&&ack==='resolve'?'confirmed':'unconfirmed');reader?.releaseLock();
});

const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const credential=p=>JSON.stringify({type:'service_account',client_email:p.name+'@synthetic.invalid',private_key:privateKey});
for(const p of profiles)for(const mode of ['cycle','bigint','getter'])test(`text upload projection before OAuth ${p.name}/${mode}`,async t=>{
  clearGcpServiceAccountTokenCache();const r=route(p);r.providerApiKey=credential(p);const body=input(p);let fetches=0,admissions=0;
  if(mode==='cycle')body.extra=body;if(mode==='bigint')body.extra=1n;
  if(mode==='getter')body.extra={get value(){throw Error('synthetic getter');}};
  t.mock.method(globalThis,'fetch',async()=>{fetches++;throw Error('unexpected auth or inference');});
  await assert.rejects(call(p,r,body,undefined,async()=>{admissions++;}));assert.equal(fetches,0);assert.equal(admissions,0);
});
for(const p of profiles)test(`text upload snapshot precedes OAuth and invokes toJSON once ${p.name}`,async t=>{
  clearGcpServiceAccountTokenCache();const r=route(p);r.providerApiKey=credential(p);let projections=0,auth=0,sends=0;
  const body={...input(p),metadata:{toJSON(){projections++;return{value:'original',omit:undefined,items:[undefined,NaN],bytes:new Uint8Array([1,2])};}}};
  const expected=JSON.stringify(wire(p,body));projections=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(String(url)===GCP_OAUTH_TOKEN_URL){auth++;assert.equal(projections,1);body.metadata.toJSON=()=>({value:'changed'});return Response.json({access_token:'synthetic',expires_in:3600});}
    sends++;assert.equal(await new Response(init.body).text(),expected);return response(p,false);
  });
  const result=await call(p,r,body);await result.response.text();assert.equal(await result.resourceCompletion,'confirmed');assert.equal(projections,1);assert.equal(auth,1);assert.equal(sends,1);clearGcpServiceAccountTokenCache();
});

for(const p of profiles)test(`text upload native Node HTTP ${p.name}`,{timeout:10000},async t=>{
  const body=input(p,'中😀\n"\\'.repeat(30000)),expected=JSON.stringify(wire(p,body)),received=Promise.withResolvers();let sends=0;
  void received.promise.catch(()=>{});
  const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);sends++;
    assert.equal(req.method,'POST');assert.equal(req.url,p.name==='chat'?'/v1/chat/completions':p.name==='gemini'?'/v1/private-model:generateContent':'/v1/'+p.operation);
    assert.equal(req.headers['transfer-encoding'],undefined);assert.equal(Number(req.headers['content-length']),Buffer.byteLength(expected));assert.equal(Buffer.concat(chunks).toString(),expected);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(output(p)));received.resolve();
  }catch(error){res.destroy();received.reject(error);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const r=route(p);r.providerEndpoints[p.protocol].base='http://127.0.0.1:'+server.address().port+(p.name==='messages'?'':'/v1');
  const result=await call(p,r,body);await received.promise;assert.equal(result.response.status,200);await result.response.text();assert.equal(await result.resourceCompletion,'confirmed');assert.equal(sends,1);
});
