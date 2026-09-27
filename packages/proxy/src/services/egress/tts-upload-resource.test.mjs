import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {dispatchOpenAiAudioSpeech} from './audio-speech-driver.ts';
import {createRequestCapacityPool} from '../request-capacity.ts';
import {scheduleResourceCompletion} from '../../runtime/schedule-resource-completion.ts';

const route={targetId:'synthetic',providerId:'synthetic',providerName:'synthetic',providerModelName:'synthetic',upstreamProtocol:'openai',upstreamOperation:'audio.speech',adapter:'passthrough',providerEndpoints:{openai:{base:'https://synthetic.invalid/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1};
const success=()=>new Response(new Uint8Array([1]),{headers:{'Content-Type':'audio/wav'}});
const request=(length=0x12000,encoding={kind:'raw_base64'})=>({input:'hello',responseFormat:'wav',streamFormat:'audio',speed:1,inputReferences:[{type:'input_audio',inputAudio:{bytes:Uint8Array.from({length},(_,i)=>i%251),encoding}},{type:'text',text:'synthetic transcript'}]});
const run=(req,options,signal)=>dispatchOpenAiAudioSpeech(route,req,signal,undefined,undefined,options);

for(const stop of ['accepted','rejected','client','deadline'])test(`TTS upload locked early ${stop} never confirms cleanup`,{timeout:4000},async t=>{
 t.mock.method(console,'warn',()=>{});t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const headers=Promise.withResolvers(),entered=Promise.withResolvers(),parent=new AbortController();let reader,sends=0,upload;
 const pending=run(request(),{deadlineAtMs:Date.now()+100,fetchImpl:async(_url,init)=>{
  sends++;upload=init.body;reader=upload.getReader();await reader.read();entered.resolve();
  return stop==='accepted'?success():stop==='rejected'?Response.json({}, {status:503}):headers.promise;
 }},parent.signal);
 await entered.promise;if(stop==='client')parent.abort();if(stop==='deadline')t.mock.timers.tick(100);
 const result=await pending;
 t.after(()=>{parent.abort();headers.resolve(success());try{reader.releaseLock();}catch{}});
 await assert.rejects(reader.read(),{message:'Audio speech upload stopped'});
 assert.equal(upload.locked,true,'producer stop is not consumer release');
 await result.response.arrayBuffer();await result.usagePromise;
 if(stop==='client'||stop==='deadline')headers.resolve(success());
 const pool=createRequestCapacityPool({maxRequests:1,maxReservedBytes:100});const lease=pool.tryAcquire(100);const tasks=[];
 scheduleResourceCompletion({get:()=>lease,executionCtx:{waitUntil(p){tasks.push(p);}}},result.resourceCompletion);lease.release();
 await Promise.all(tasks);
 assert.equal(await result.resourceCompletion,'unconfirmed');assert.equal(pool.snapshot().requests,1);assert.equal(sends,1);
 reader.releaseLock();assert.equal(upload.locked,false);
 assert.equal(await result.resourceCompletion,'unconfirmed','a later unlock cannot retroactively prove transport cleanup');
});

for(const length of [0,1,2,3,0x5fff,0x6000,0x6001,0xc001])for(const kind of ['raw_base64','data_uri'])
test(`TTS upload complete ${length}/${kind} preserves bytes and confirms`,{timeout:4000},async()=>{
 const req=request(length,kind==='raw_base64'?{kind}:{kind,mediaType:'audio/wav'});let payload,largest=0;
 const result=await run(req,{fetchImpl:async(_url,init)=>{
  assert.equal(init.duplex,'half');const reader=init.body.getReader();const chunks=[];
  while(true){const next=await reader.read();if(next.done)break;largest=Math.max(largest,next.value.length);chunks.push(Buffer.from(next.value));}
  reader.releaseLock();payload=JSON.parse(Buffer.concat(chunks).toString());return success();
 }});
 await result.response.arrayBuffer();await result.usagePromise;assert.equal(await result.resourceCompletion,'confirmed');
 assert.equal(payload.input_references[0].input_audio.data,(kind==='data_uri'?'data:audio/wav;base64,':'')+Buffer.from(req.inputReferences[0].inputAudio.bytes).toString('base64'));
 assert.deepEqual(payload.input_references[1],{type:'text',text:'synthetic transcript'});assert.ok(largest<=32768);
 assert.equal(req.inputReferences[0].inputAudio.bytes.length,length,'caller payload is never mutated');
});

for(const mode of ['unused','consumer-cancel','drain-then-cancel'])test(`TTS upload ${mode} is confirmed`,async()=>{
 const result=await run(request(),{fetchImpl:async(_url,init)=>{
  if(mode==='consumer-cancel'){const r=init.body.getReader();await r.read();await r.cancel();r.releaseLock();}
  if(mode==='drain-then-cancel'){const r=init.body.getReader();while(!(await r.read()).done){}await r.cancel();r.releaseLock();}
  return success();
 }});
 await result.response.arrayBuffer();await result.usagePromise;assert.equal(await result.resourceCompletion,'confirmed');
});

test('TTS upload response ACK cannot hide an unfinished upload',async()=>{
 const ack=Promise.withResolvers();let uploadReader,cancels=0;
 const result=await run(request(),{fetchImpl:async(_url,init)=>{
  uploadReader=init.body.getReader();await uploadReader.read();return new Response(new ReadableStream({cancel(){cancels++;return ack.promise;}}),{headers:{'Content-Type':'audio/wav'}});
 }});
 let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});await result.response.body.cancel();await result.usagePromise;
 assert.equal(cleaned,false);assert.equal(cancels,1);ack.resolve();assert.equal(await result.resourceCompletion,'unconfirmed');uploadReader.releaseLock();
});

for(const mode of ['locked-unread','unlocked-partial','suffix-without-eof'])test(`TTS upload ${mode} is not completion`,async()=>{
 let reader;
 const result=await run(request(1),{fetchImpl:async(_url,init)=>{
  reader=init.body.getReader();
  if(mode==='unlocked-partial'){await reader.read();reader.releaseLock();}
  if(mode==='suffix-without-eof')for(let i=0;i<3;i++)assert.equal((await reader.read()).done,false);
  return success();
 }});
 await result.response.arrayBuffer();assert.equal(await result.resourceCompletion,'unconfirmed');
 if(mode!=='unlocked-partial')reader.releaseLock();
});

test('TTS upload encoder failure is sanitized and unconfirmed',async t=>{
 t.mock.method(globalThis,'btoa',()=>{throw Error('PRIVATE_ENCODER_DETAIL');});
 let reader;
 const result=await run(request(1),{fetchImpl:async(_url,init)=>{
  reader=init.body.getReader();await reader.read();
  await assert.rejects(reader.read(),{message:'Audio speech upload encoding failed'});return success();
 }});
 await result.response.arrayBuffer();assert.equal(await result.resourceCompletion,'unconfirmed');reader.releaseLock();
});

test('TTS upload does not prefetch while admission is pending and cancelled',async t=>{
 let sends=0,encodes=0;const admission=Promise.withResolvers(),entered=Promise.withResolvers(),parent=new AbortController();
 t.mock.method(globalThis,'btoa',()=>{encodes++;throw Error('Unexpected encode');});
 const pending=run(request(),{beforeUpstreamDispatch:async()=>{entered.resolve();await admission.promise;},fetchImpl:async()=>{sends++;return success();}},parent.signal);
 await entered.promise;parent.abort();admission.resolve();const result=await pending;
 assert.equal(result.response.status,499);assert.equal(await result.resourceCompletion,'confirmed');assert.equal(sends,0);assert.equal(encodes,0);
});

test('TTS upload native Node HTTP preserves streamed JSON and completes once',{timeout:8000},async t=>{
 const req=request(0x6001,{kind:'data_uri',mediaType:'audio/wav'});let sends=0,payload;
 const server=createServer(async(incoming,outgoing)=>{
  sends++;const chunks=[];for await(const chunk of incoming)chunks.push(chunk);payload=JSON.parse(Buffer.concat(chunks).toString());
  outgoing.writeHead(200,{'Content-Type':'audio/wav'});outgoing.end(Buffer.from([1]));
 });
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const candidate={...route,providerEndpoints:{openai:{base:`http://127.0.0.1:${server.address().port}/v1`}}};
 const result=await dispatchOpenAiAudioSpeech(candidate,req);
 assert.equal(result.response.status,200);assert.equal((await result.response.arrayBuffer()).byteLength,1);await result.usagePromise;
 assert.equal(await result.resourceCompletion,'confirmed');assert.equal(sends,1);
 assert.equal(payload.input_references[0].input_audio.data,'data:audio/wav;base64,'+Buffer.from(req.inputReferences[0].inputAudio.bytes).toString('base64'));
});
