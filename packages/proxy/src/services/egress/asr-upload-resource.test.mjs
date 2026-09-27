import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {dispatchOpenAiAudioTranscriptions} from './openai-audio-driver.ts';
import {createRequestCapacityPool} from '../request-capacity.ts';
import {scheduleResourceCompletion} from '../../runtime/schedule-resource-completion.ts';

const route={targetId:'synthetic',providerId:'synthetic',providerName:'synthetic',providerModelName:'whisper-1',upstreamProtocol:'openai',upstreamOperation:'audio.transcriptions',adapter:'passthrough',providerEndpoints:{openai:{base:'https://synthetic.invalid/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1};
const request=()=>({file:{filename:'synthetic.wav',mimeType:'audio/wav',bytes:new Uint8Array(150_001).fill(37)},clientResponseFormat:'json',prompt:'hello\nworld',extra:{'timestamp_granularities[]':['word','segment']}});
const quiet=t=>{for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});};
const run=(req,options,signal)=>dispatchOpenAiAudioTranscriptions(route,req,signal,undefined,undefined,options);

for(const status of [200,503])for(const mode of ['complete','cancel','untouched','locked','partial','released','suffix'])
test(`ASR upload ${status}/${mode} has independent resource outcome`,async t=>{
 quiet(t);let observedBody,reader,sends=0;const req=request();
 t.after(()=>{reader?.releaseLock();});
 const result=await run(req,{fetchImpl:async(_url,init)=>{
  sends++;observedBody=init.body;assert.ok(observedBody instanceof ReadableStream);
  assert.equal(init.duplex,'half');assert.equal(init.redirect,'manual');
  if(mode==='cancel')await observedBody.cancel('synthetic consumer stop');
  else if(mode!=='untouched'){
   reader=observedBody.getReader();void reader.closed.catch(()=>{});
   if(mode==='complete')while(!(await reader.read()).done){}
   if(mode==='partial'||mode==='released')await reader.read();
   if(mode==='released'){reader.releaseLock();reader=undefined;}
   if(mode==='suffix'){
    const size=Number(new Headers(init.headers).get('Content-Length'));let read=0;
    while(read<size){const next=await reader.read();assert.equal(next.done,false);assert.ok(next.value.byteLength<=65536);read+=next.value.byteLength;}
    assert.equal(read,size);
   }
  }
  return Response.json(status===200?{text:'synthetic',duration:1}:{error:{message:'synthetic failure'}},{status});
 }});
 assert.ok(observedBody instanceof ReadableStream);assert.equal(result.response.status,status);assert.equal(sends,1);
 assert.equal(result.meta.upstreamOutcomeUnknown,status===503?true:undefined);assert.equal(result.meta.failoverForbidden,status===503?true:undefined);
 assert.equal(await result.resourceCompletion,['complete','cancel','untouched'].includes(mode)?'confirmed':'unconfirmed');
 if(mode!=='complete'&&mode!=='cancel')await assert.rejects(reader?reader.read():observedBody.getReader().read(),/Audio transcription upload stopped/);
 assert.equal(req.file.bytes.length,150_001);assert.ok(req.file.bytes.every(x=>x===37));await result.usagePromise;
});

for(const stop of ['client','deadline'])for(const ack of ['resolve','reject'])
test(`ASR upload ${stop}/${ack} retains capacity after late response cleanup`,{timeout:4000},async t=>{
 quiet(t);if(stop==='deadline')t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const parent=new AbortController(),entered=Promise.withResolvers(),headers=Promise.withResolvers(),cancelAck=Promise.withResolvers();let reader,sends=0,cancels=0;
 t.after(()=>{headers.resolve(new Response());cancelAck.resolve();parent.abort();reader?.releaseLock();});
 const pending=run(request(),{deadlineAtMs:Date.now()+100,fetchImpl:async(_url,init)=>{
  sends++;reader=init.body.getReader();void reader.closed.catch(()=>{});await reader.read();entered.resolve();return headers.promise;
 }},parent.signal);
 await entered.promise;if(stop==='client')parent.abort(Error('PRIVATE_ABORT_DETAIL'));else t.mock.timers.tick(100);
 const result=await pending;assert.equal(result.response.status,stop==='client'?499:504);assert.equal(result.meta.failoverForbidden,true);assert.equal(result.meta.upstreamOutcomeUnknown,true);
 assert.equal((await result.response.text()).includes('PRIVATE'),false);await result.usagePromise;
 const pool=createRequestCapacityPool({maxRequests:1,maxReservedBytes:100}),lease=pool.tryAcquire(100),tasks=[];
 scheduleResourceCompletion({get:()=>lease,executionCtx:{waitUntil(p){tasks.push(p);}}},result.resourceCompletion);lease.release();
 let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
 headers.resolve(new Response(new ReadableStream({cancel(){cancels++;return cancelAck.promise;}})));
 for(let i=0;i<60;i++)await Promise.resolve();assert.equal(cleaned,false);assert.equal(cancels,1);assert.equal(pool.snapshot().requests,1);
 if(ack==='resolve')cancelAck.resolve();else cancelAck.reject(Error('PRIVATE_ACK_DETAIL'));
 await Promise.all(tasks);assert.equal(await result.resourceCompletion,'unconfirmed');assert.equal(pool.snapshot().requests,1);assert.equal(sends,1);
 reader.releaseLock();reader=undefined;assert.equal(await result.resourceCompletion,'unconfirmed');
});

for(const stop of ['before','admission'])test(`ASR upload ${stop} cancellation prevents HTTP`,async t=>{
 quiet(t);const parent=new AbortController(),entered=Promise.withResolvers(),admission=Promise.withResolvers();let sends=0,settled=false;
 if(stop==='before')parent.abort();
 const pending=run(request(),{beforeUpstreamDispatch:async()=>{entered.resolve();await admission.promise;},fetchImpl:async()=>{sends++;return Response.json({text:'wrong'});}},parent.signal);
 void pending.then(()=>{settled=true;});
 if(stop==='admission'){await entered.promise;parent.abort();for(let i=0;i<20;i++)await Promise.resolve();assert.equal(settled,false,'do not abandon durable admission');admission.resolve();}
 const result=await pending;assert.equal(result.response.status,499);assert.equal(result.meta.upstreamOutcomeUnknown,undefined);assert.equal(await result.resourceCompletion,'confirmed');assert.equal(sends,0);
});

test('ASR upload native Node HTTP preserves multipart and sends once',{timeout:8000},async t=>{
 quiet(t);let sends=0,payload,wireLength,declaredLength;const req=request();
 const server=createServer(async(incoming,outgoing)=>{
  sends++;const chunks=[];for await(const chunk of incoming)chunks.push(chunk);const body=Buffer.concat(chunks);wireLength=body.length;declaredLength=Number(incoming.headers['content-length']);
  payload=await new Response(body,{headers:{'Content-Type':incoming.headers['content-type']}}).formData();
  outgoing.writeHead(200,{'Content-Type':'application/json'});outgoing.end(JSON.stringify({text:'synthetic',duration:1}));
 });
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const candidate={...route,providerEndpoints:{openai:{base:`http://127.0.0.1:${server.address().port}/v1`}}};
 const result=await dispatchOpenAiAudioTranscriptions(candidate,req);
 assert.equal(result.response.status,200);assert.equal(await result.resourceCompletion,'confirmed');assert.equal(sends,1);assert.equal(wireLength,declaredLength);
 assert.equal(payload.get('model'),'whisper-1');assert.equal(payload.get('response_format'),'verbose_json');assert.equal(payload.get('prompt'),'hello\r\nworld');
 assert.deepEqual(payload.getAll('timestamp_granularities[]'),['word','segment']);assert.equal(payload.get('file').name,'synthetic.wav');
 assert.deepEqual(new Uint8Array(await payload.get('file').arrayBuffer()),req.file.bytes);
});
