import assert from 'node:assert/strict';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import {createServer} from 'node:http';
import {dispatchOpenAiEmbeddingsRoute} from './openai-embeddings-driver.ts';
import {dispatchOpenAiRerankRoute} from './openai-rerank-driver.ts';
import {withOwnedJsonUpload} from './with-owned-json-upload.ts';

const variants=['embeddings','rerank'],drivers={embeddings:dispatchOpenAiEmbeddingsRoute,rerank:dispatchOpenAiRerankRoute};
const route=v=>({targetId:'vector-upload',providerId:'synthetic',providerName:'Synthetic',providerModelName:'private-model',gatewayModelId:'public-model',upstreamProtocol:'openai',upstreamOperation:v,adapter:'passthrough',providerEndpoints:{openai:{base:'https://synthetic.invalid/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1});
const input=(v,text='hello')=>v==='embeddings'?{input:[text]}:{query:text,documents:['world']};
const output=v=>v==='embeddings'?{object:'list',model:'private-model',data:[{object:'embedding',index:0,embedding:[0.1]}],usage:{prompt_tokens:1,total_tokens:1}}:{model:'private-model',results:[{index:0,relevance_score:0.5}],usage:{total_tokens:1}};
const wire=(v,body)=>v==='embeddings'?{...body,model:'private-model'}:{model:'private-model',query:body.query,documents:body.documents};

for(const v of variants)for(const mode of ['full','unused','cancel','locked','partial','last-page'])
test(`vector upload ${v}/${mode}`,{timeout:5000},async t=>{
 const abort=new AbortController(),body=input(v,mode==='partial'?'x'.repeat(200000):'中😀\n"\\\ud800'),expected=JSON.stringify(wire(v,body));let sends=0,reader,upload;
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  sends++;upload=init.body;assert.ok(upload instanceof ReadableStream);assert.equal(init.duplex,'half');assert.equal(init.redirect,'manual');
  assert.equal(Number(new Headers(init.headers).get('Content-Length')),Buffer.byteLength(expected));
  if(mode==='full'){const chunks=[];for await(const chunk of upload){assert.ok(chunk.byteLength<=65536);chunks.push(chunk);}assert.equal(Buffer.concat(chunks).toString(),expected);}
  if(mode==='cancel')await upload.cancel();
  if(['locked','partial','last-page'].includes(mode)){reader=upload.getReader();if(mode!=='locked')assert.equal((await reader.read()).done,false);}
  return Response.json(output(v));
 });
 const result=await drivers[v](route(v),body,abort.signal);assert.equal(result.response.status,200);await result.response.text();
 assert.equal((await result.usagePromise).total_tokens,1);assert.equal(await result.resourceCompletion,['full','unused','cancel'].includes(mode)?'confirmed':'unconfirmed');
 assert.equal(getEventListeners(abort.signal,'abort').length,0);assert.equal(sends,1);
 if(reader){await assert.rejects(reader.read(),/JSON upload stopped/);reader.releaseLock();}
 abort.abort();assert.equal((await result.usagePromise).total_tokens,1);
});

for(const v of variants)for(const mode of ['snapshot','cancel-admission','throw-admission','bad-header','fetch-reject'])
test(`vector upload preparation ${v}/${mode}`,async t=>{
 const abort=new AbortController(),body=input(v),r=route(v);let sends=0,admissions=0,upload;
 const expected=JSON.stringify(wire(v,body));if(mode==='bad-header')r.providerApiKey='invalid\nheader';
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  sends++;upload=init.body;assert.ok(upload instanceof ReadableStream);
  if(mode==='fetch-reject'){upload.getReader().releaseLock();throw Error('synthetic transport failure');}
  assert.equal(await new Response(upload).text(),expected);return Response.json(output(v));
 });
 const pending=drivers[v](r,body,abort.signal,undefined,undefined,async()=>{
  admissions++;if(mode==='snapshot'){if(v==='embeddings')body.input[0]='mutated';else body.documents[0]='mutated';}
  if(mode==='cancel-admission')abort.abort();if(mode==='throw-admission')throw Error('synthetic admission failure');
 });
 if(['throw-admission','bad-header','fetch-reject'].includes(mode))await assert.rejects(pending);
 else {const result=await pending;assert.equal(result.response.status,mode==='cancel-admission'?499:200);await result.response.text();assert.equal(await result.resourceCompletion,'confirmed');}
 assert.equal(sends,['snapshot','fetch-reject'].includes(mode)?1:0);assert.equal(admissions,mode==='bad-header'?0:1);assert.equal(getEventListeners(abort.signal,'abort').length,0);
});

for(const v of variants)for(const uploadMode of ['full','partial'])for(const ack of ['resolve','reject'])
test(`vector upload and response owners ${v}/${uploadMode}/${ack}`,async t=>{
 const gate=Promise.withResolvers();let reader,cancels=0;t.after(()=>gate.resolve());
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  assert.ok(init.body instanceof ReadableStream);
  if(uploadMode==='full')await new Response(init.body).text();else {reader=init.body.getReader();await reader.read();}
  return new Response(new ReadableStream({cancel(){cancels++;return gate.promise;}}),{headers:{'Content-Type':'text/html'}});
 });
 const result=await drivers[v](route(v),input(v));assert.equal(result.response.status,502);await result.usagePromise;
 let done=false;void result.resourceCompletion.then(()=>{done=true;});await tick();assert.equal(done,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_ACK'));
 assert.equal(await result.resourceCompletion,uploadMode==='full'&&ack==='resolve'?'confirmed':'unconfirmed');reader?.releaseLock();
});

for(const mode of ['cycle','bigint','getter-failure'])test('JSON upload rejects projection before callback '+mode,async()=>{
 const abort=new AbortController(),body={};if(mode==='cycle')body.self=body;if(mode==='bigint')body.value=1n;
 if(mode==='getter-failure')Object.defineProperty(body,'value',{enumerable:true,get(){throw Error('synthetic getter');}});
 let calls=0;await assert.rejects(withOwnedJsonUpload(body,abort.signal,async()=>{calls++;return {response:new Response()};}));
 assert.equal(calls,0);assert.equal(getEventListeners(abort.signal,'abort').length,0);
});

test('JSON upload executes toJSON once before admission and preserves JSON projection',async()=>{
 let projections=0;const body={special:{toJSON(){projections++;return {value:'中😀',omit:undefined,items:[undefined,NaN],bytes:new Uint8Array([1,2])};}}};
 const expected=JSON.stringify(body);projections=0;
 const result=await withOwnedJsonUpload(body,undefined,async upload=>{assert.equal(projections,1);assert.equal(await new Response(upload.body).text(),expected);return {response:new Response()};});
 assert.equal(await result.resourceCompletion,'confirmed');assert.equal(projections,1);
});

for(const v of variants)test('vector upload native Node HTTP '+v,{timeout:10000},async t=>{
 const body=input(v,'中😀\n"\\'.repeat(30000)),expected=JSON.stringify(wire(v,body));let sends=0;
 const received=Promise.withResolvers();
 const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);sends++;
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/'+v);assert.equal(req.headers['transfer-encoding'],undefined);assert.equal(Number(req.headers['content-length']),Buffer.byteLength(expected));assert.equal(Buffer.concat(chunks).toString(),expected);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(output(v)));received.resolve();
 }catch(error){res.destroy();received.reject(error);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const r=route(v);r.providerEndpoints.openai.base='http://127.0.0.1:'+server.address().port+'/v1';
 const result=await drivers[v](r,body);await received.promise;assert.equal(result.response.status,200);await result.response.text();assert.equal(await result.resourceCompletion,'confirmed');assert.equal(sends,1);
});
