import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {dispatchDashScopeSyncAsr,dispatchDashScopeAsyncAsr,dispatchDashScopeMultimodalPassthrough,buildDashScopeSyncAsrBody,buildDashScopeQwenAudioAsrBody,buildDashScopeFunAsrBody,buildDashScopeAsyncAsrBody} from './dashscope-audio-driver.ts';
const variants=['qwen3','qwen-audio','fun','async','native'];
const request=()=>({file:{filename:'synthetic.wav',mimeType:'audio/wav',bytes:Uint8Array.from({length:60001},(_,i)=>i%251)},fileSourceUrl:'https://audio.example/synthetic.wav',clientResponseFormat:'json'});
const route=v=>({targetId:'synthetic',providerId:'synthetic',providerName:'synthetic',providerModelName:'synthetic',upstreamProtocol:'dashscope',upstreamOperation:v==='async'?'audio.transcriptions':'audio.transcriptions.multimodal',adapter:({qwen3:'dashscope-asr-qwen-file','qwen-audio':'dashscope-asr-qwen-audio-file',fun:'dashscope-asr-fun-file',async:'dashscope-asr-file-async'})[v]??'passthrough',providerEndpoints:{dashscope:{base:'https://synthetic.invalid/api/v1'}},providerApiKey:'synthetic-only',customParams:{large:'中😀'.repeat(40000)},routeGroup:'default',routePriority:0,routeWeight:1});
const native=()=>({model:'public',input:{messages:[{role:'user',content:[{audio:'data:audio/wav;base64,AQID'}]}]},parameters:{large:'中😀'.repeat(40000)}});
const success=(v,url,method)=>Response.json(v==='async'?method==='POST'?{output:{task_id:'synthetic-task'}}:String(url).includes('/tasks/')?{output:{task_status:'SUCCEEDED',results:[{transcription_url:'https://result.example/transcript.json'}]},usage:{seconds:1}}:{transcripts:[{text:'synthetic'}]}:{output:{text:'synthetic',choices:[{message:{content:[{text:'synthetic'}]}}]},usage:{seconds:1,duration:1}});
const quiet=t=>{for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});};
const run=(v,r,req,options,signal)=>(v==='async'?dispatchDashScopeAsyncAsr:v==='native'?dispatchDashScopeMultimodalPassthrough:dispatchDashScopeSyncAsr)(r,req,signal,undefined,undefined,{pollIntervalMs:0,...options});
const expected=(v,r,req)=>v==='native'?{...req,model:r.providerModelName}:v==='async'?buildDashScopeAsyncAsrBody(r,req.fileSourceUrl,req):({qwen3:buildDashScopeSyncAsrBody,'qwen-audio':buildDashScopeQwenAudioAsrBody,fun:buildDashScopeFunAsrBody})[v](r,req);

for(const v of variants)for(const mode of ['complete','cancel','untouched','locked','partial','released','suffix','503'])
test(`DashScope upload ${v}/${mode} preserves wire and resource outcome`,{timeout:5000},async t=>{
 quiet(t);const r=route(v),req=v==='native'?native():request();let sent,reader,submits=0,reads=0;
 t.after(()=>{reader?.releaseLock();});
 const result=await run(v,r,req,{fetchImpl:async(url,init)=>{
  if(init?.method!=='POST'){reads++;return success(v,url,init?.method);}
  submits++;sent=init.body;assert.ok(sent instanceof ReadableStream);assert.equal(init.duplex,'half');assert.equal(init.redirect,'manual');
  if(mode==='cancel')await sent.cancel();
  else if(mode!=='untouched'){
   reader=sent.getReader();void reader.closed.catch(()=>{});
   if(mode==='complete'){
    const chunks=[];while(true){const next=await reader.read();if(next.done)break;assert.ok(next.value.length<=65536);chunks.push(Buffer.from(next.value));}
    const bytes=Buffer.concat(chunks);assert.equal(bytes.length,Number(new Headers(init.headers).get('Content-Length')));assert.equal(bytes.toString(),JSON.stringify(expected(v,r,req)));
   }
   if(['partial','released','503'].includes(mode))await reader.read();
   if(mode==='released'){reader.releaseLock();reader=undefined;}
   if(mode==='suffix'){let bytes=0;const size=Number(new Headers(init.headers).get('Content-Length'));while(bytes<size){const next=await reader.read();assert.equal(next.done,false);bytes+=next.value.length;}assert.equal(bytes,size);}
  }
  return mode==='503'?Response.json({error:{message:'synthetic'}},{status:503}):success(v,url,'POST');
 }});
 assert.ok(sent instanceof ReadableStream);assert.equal(result.response.status,mode==='503'?503:200);assert.equal(submits,1);assert.equal(reads,v==='async'&&mode!=='503'?2:0);
 assert.equal(result.meta.upstreamOutcomeUnknown,mode==='503'?true:undefined);assert.equal(result.meta.failoverForbidden,mode==='503'?true:undefined);
 assert.equal(await result.resourceCompletion,['complete','cancel','untouched'].includes(mode)?'confirmed':'unconfirmed');await result.usagePromise;
 if(!['complete','cancel'].includes(mode))await assert.rejects(reader?reader.read():sent.getReader().read(),/JSON upload stopped/);
});

for(const v of variants)for(const stop of ['client','deadline'])for(const ack of ['resolve','reject'])
test(`DashScope upload ${v}/${stop}/${ack} owns late response without resubmission`,{timeout:5000},async t=>{
 quiet(t);if(stop==='deadline')t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const parent=new AbortController(),entered=Promise.withResolvers(),headers=Promise.withResolvers(),cleanup=Promise.withResolvers();let reader,submits=0,queries=0,cancels=0;
 t.after(()=>{headers.resolve(new Response());cleanup.resolve();parent.abort();reader?.releaseLock();});
 const pending=run(v,route(v),v==='native'?native():request(),{deadlineAtMs:Date.now()+100,fetchImpl:async(_url,init)=>{
  if(init?.method!=='POST'){queries++;throw Error('Unexpected query');}submits++;reader=init.body.getReader();void reader.closed.catch(()=>{});await reader.read();entered.resolve();return headers.promise;
 }},parent.signal);
 await entered.promise;if(stop==='client')parent.abort(Error('PRIVATE_ABORT'));else t.mock.timers.tick(100);
 const result=await pending;assert.equal(result.response.status,stop==='client'?499:504);assert.equal(result.meta.upstreamOutcomeUnknown,true);assert.equal(result.meta.failoverForbidden,true);
 assert.equal((await result.response.text()).includes('PRIVATE'),false);await result.usagePromise;
 let finished=false;void result.resourceCompletion.then(()=>{finished=true;});
 headers.resolve(new Response(new ReadableStream({cancel(){cancels++;return cleanup.promise;}})));
 for(let i=0;i<60;i++)await Promise.resolve();assert.equal(finished,false);assert.equal(cancels,1);assert.equal(submits,1);assert.equal(queries,0);
 if(ack==='resolve')cleanup.resolve();else cleanup.reject(Error('PRIVATE_CLEANUP'));
 assert.equal(await result.resourceCompletion,'unconfirmed');reader.releaseLock();reader=undefined;
});

for(const v of variants)test(`DashScope upload native Node HTTP ${v} preserves JSON in one submission`,{timeout:8000},async t=>{
 quiet(t);let submits=0,payload,wireLength,declared;const req=v==='native'?native():request();
 const server=createServer(async(incoming,outgoing)=>{
  submits++;const chunks=[];for await(const chunk of incoming)chunks.push(chunk);const body=Buffer.concat(chunks);wireLength=body.length;declared=Number(incoming.headers['content-length']);payload=JSON.parse(body.toString());
  const response=v==='async'?Response.json({error:{message:'synthetic explicit failure'}},{status:503}):success(v,'','POST');
  outgoing.writeHead(response.status,{'Content-Type':'application/json'});outgoing.end(await response.text());
 });
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const r={...route(v),providerEndpoints:{dashscope:{base:`http://127.0.0.1:${server.address().port}/api/v1`}}};
 const result=await run(v,r,req,{});assert.equal(result.response.status,v==='async'?503:200);assert.equal(await result.resourceCompletion,'confirmed');assert.equal(result.meta.upstreamOutcomeUnknown,v==='async'?true:undefined);assert.equal(result.meta.failoverForbidden,v==='async'?true:undefined);
 assert.equal(submits,1);assert.equal(wireLength,declared);assert.deepEqual(payload,expected(v,r,req));
});
