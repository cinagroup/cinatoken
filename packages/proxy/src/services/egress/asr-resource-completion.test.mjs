import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dispatchOpenAiAudioTranscriptions} from './openai-audio-driver.ts';
import {dispatchDashScopeSyncAsr,dispatchDashScopeAsyncAsr,dispatchDashScopeMultimodalPassthrough} from './dashscope-audio-driver.ts';

const variants=['openai','qwen3','qwen-audio','fun','async','native'];
const req={file:{filename:'synthetic.wav',mimeType:'audio/wav',bytes:new Uint8Array([1,2,3])},fileSourceUrl:'https://audio.example/synthetic.wav',clientResponseFormat:'json'};
const route=v=>({targetId:'synthetic',providerId:'synthetic',providerName:'synthetic',providerModelName:'synthetic',upstreamProtocol:v==='openai'?'openai':'dashscope',upstreamOperation:v==='openai'?'audio.transcriptions':v==='async'?'audio.transcriptions.async':'audio.transcriptions.multimodal',adapter:({qwen3:'dashscope-asr-qwen-file','qwen-audio':'dashscope-asr-qwen-audio-file',fun:'dashscope-asr-fun-file',async:'dashscope-asr-file-async'})[v]??'passthrough',providerEndpoints:{openai:{base:'https://synthetic.invalid/v1'},dashscope:{base:'https://synthetic.invalid/api/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1});
const run=(v,options,signal)=>{
 const driver=v==='openai'?dispatchOpenAiAudioTranscriptions:v==='async'?dispatchDashScopeAsyncAsr:v==='native'?dispatchDashScopeMultimodalPassthrough:dispatchDashScopeSyncAsr;
 return driver(route(v),v==='native'?{input:{messages:[]}}:req,signal,undefined,undefined,{pollIntervalMs:0,...options});
};
const success=(v,url)=>Response.json(v==='async'?String(url).includes('/tasks/')?{output:{task_status:'SUCCEEDED',results:[{transcription_url:'https://result.example/transcript.json'}]},usage:{seconds:1}}:String(url).includes('result.example')?{transcripts:[{text:'synthetic'}]}:{output:{task_id:'synthetic-task'}}:v==='openai'?{text:'synthetic',duration:1}:{output:{text:'synthetic',choices:[{message:{content:[{text:'synthetic'}]}}]},usage:{seconds:1,duration:1}});
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const quiet=t=>{for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});};

for(const v of variants)for(const stage of ['body-cancel','declared-overflow','observed-overflow','late-header'])for(const ack of ['resolve','reject'])
test(`ASR resource ${v}/${stage}/${ack}`,{timeout:4000},async t=>{
 quiet(t);const gate=Promise.withResolvers(),entered=Promise.withResolvers(),headers=Promise.withResolvers(),parent=new AbortController();let cancels=0,sends=0;
 const source=new ReadableStream({pull(c){entered.resolve();if(stage==='observed-overflow')c.enqueue(new Uint8Array(101));},cancel(){cancels++;return gate.promise;}},{highWaterMark:0});
 t.after(()=>{gate.resolve();headers.resolve(new Response());parent.abort();});
 const pending=run(v,{maxResponseBytes:100,fetchImpl:async()=>{sends++;if(stage==='late-header'){entered.resolve();return headers.promise;}return new Response(source,{headers:stage==='declared-overflow'?{'Content-Length':'101'}:{}});}},parent.signal);
 if(stage==='body-cancel'||stage==='late-header'){await entered.promise;parent.abort();}
 const result=await pending;await result.response.text();await result.usagePromise;
 assert.ok(result.resourceCompletion instanceof Promise);let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
 if(stage==='late-header')headers.resolve(new Response(source));await flush();assert.equal(cleaned,false);assert.equal(cancels,1);assert.equal(sends,1);
 assert.equal(result.meta.upstreamOutcomeUnknown,true);assert.equal(result.meta.failoverForbidden,true);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_ACK'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');
});

for(const v of variants)test(`ASR resource ${v} successful body confirms`,async t=>{
 quiet(t);let submissions=0;const result=await run(v,{fetchImpl:async(url,init)=>{if(init.method==='POST')submissions++;return success(v,url);}});
 assert.equal(result.response.status,200);assert.match(await result.response.text(),/synthetic/);await result.usagePromise;
 assert.equal(await result.resourceCompletion,'confirmed');assert.equal(submissions,1);assert.equal(result.meta.audioDurationSeconds,1);
});

for(const stage of ['poll-headers','poll-body','download-headers','download-body','redirect-ack'])for(const ack of ['resolve','reject'])
test(`ASR resource async ${stage}/${ack} retains reads without resubmission`,{timeout:4000},async t=>{
 quiet(t);const gate=Promise.withResolvers(),headers=Promise.withResolvers(),entered=Promise.withResolvers(),parent=new AbortController();let submissions=0,reads=0,cancels=0;
 const source=new ReadableStream({pull(){entered.resolve();},cancel(){cancels++;entered.resolve();return gate.promise;}},{highWaterMark:0});
 t.after(()=>{gate.resolve();headers.resolve(new Response());parent.abort();});
 const pending=run('async',{fetchImpl:async(url,init)=>{
  if(init.method==='POST'){submissions++;return success('async',url);}reads++;
  const selected=stage.startsWith('poll')?String(url).includes('/tasks/'):String(url).includes('result.example');
  if(!selected)return success('async',url);
  if(stage.endsWith('headers')){entered.resolve();return headers.promise;}
  return new Response(source,stage==='redirect-ack'?{status:302,headers:{Location:'/next.json'}}:{});
 }},parent.signal);
 await entered.promise;parent.abort();const result=await pending;assert.equal(result.response.status,499);await result.usagePromise;
 assert.ok(result.resourceCompletion instanceof Promise);let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
 if(stage.endsWith('headers'))headers.resolve(new Response(source));await flush();assert.equal(cleaned,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_ACK'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');assert.equal(submissions,1);
 assert.equal(reads,stage.startsWith('poll')?1:2);assert.equal(result.meta.upstreamOutcomeUnknown,true);assert.equal(result.meta.failoverForbidden,true);
});

for(const location of ['http://127.0.0.1/private','https://127.0.0.1/private',''])test(`ASR resource rejected redirect ${location||'missing'} retains failed cleanup`,async t=>{
 quiet(t);let reads=0,cancels=0;
 const result=await run('async',{fetchImpl:async(url,init)=>{
  if(init.method==='POST'||String(url).includes('/tasks/'))return success('async',url);reads++;
  return new Response(new ReadableStream({cancel(){cancels++;return Promise.reject(Error('PRIVATE_ACK'));}}),{status:302,headers:location?{Location:location}:{}});
 }});
 assert.equal(result.response.status,502);assert.equal(await result.resourceCompletion,'unconfirmed');assert.equal(reads,1);assert.equal(cancels,1);
 assert.doesNotMatch(await result.response.text(),/PRIVATE_ACK/);
});

for(const v of variants)for(const status of [400,503])for(const ack of ['resolve','reject'])test(`ASR resource ${v} HTTP ${status} cleanup ${ack} preserves outcome certainty`,async t=>{
 quiet(t);const gate=Promise.withResolvers();let cancels=0;
 t.after(()=>{gate.resolve();});
 const result=await run(v,{maxResponseBytes:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancels++;return gate.promise;}}),{status,headers:{'Content-Length':'101'}})});
 assert.equal(result.response.status,status);assert.equal(result.meta.upstreamOutcomeUnknown,status===503?true:undefined);assert.equal(result.meta.failoverForbidden,status===503?true:undefined);await result.usagePromise;
 let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});await flush();assert.equal(cleaned,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_ACK'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');
});

for(const v of variants)test(`ASR resource ${v} late transport rejection remains unconfirmed`,async t=>{
 quiet(t);const entered=Promise.withResolvers(),headers=Promise.withResolvers(),parent=new AbortController();
 const pending=run(v,{fetchImpl:async()=>{entered.resolve();return headers.promise;}},parent.signal);
 await entered.promise;parent.abort();const result=await pending;headers.reject(Error('PRIVATE_TRANSPORT'));
 assert.equal(await result.resourceCompletion,'unconfirmed');assert.doesNotMatch(await result.response.text(),/PRIVATE_TRANSPORT/);
});

for(const ack of ['resolve','reject'])test(`ASR resource redirect deadline ${ack} stops follow-up and owns ACK`,async t=>{
 quiet(t);t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();let reads=0;
 t.after(()=>{gate.resolve();});
 const pending=run('async',{deadlineAtMs:Date.now()+100,fetchImpl:async(url,init)=>{
  if(init.method==='POST'||String(url).includes('/tasks/'))return success('async',url);reads++;
  return new Response(new ReadableStream({cancel(){entered.resolve();return gate.promise;}}),{status:302,headers:{Location:'/next'}});
 }});
 await entered.promise;t.mock.timers.tick(100);const result=await pending;assert.equal(result.response.status,504);
 let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});await flush();assert.equal(cleaned,false);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_ACK'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');assert.equal(reads,1);
});

for(const ack of ['resolve','reject'])test(`ASR resource safe relative redirect ${ack} preserves outcome and cleanup`,async t=>{
 quiet(t);let reads=0,submits=0;
 const result=await run('async',{fetchImpl:async(url,init)=>{
  if(init.method==='POST'){submits++;return success('async',url);}if(String(url).includes('/tasks/'))return success('async',url);
  reads++;if(reads===1)return new Response(new ReadableStream({cancel(){return ack==='resolve'?Promise.resolve():Promise.reject(Error('PRIVATE_ACK'));}}),{status:302,headers:{Location:'/next.json?signature=synthetic'}});
  assert.equal(String(url),'https://result.example/next.json?signature=synthetic');assert.equal(new Headers(init.headers).has('Authorization'),false);return success('async',url);
 }});
 assert.equal(result.response.status,200);assert.equal(result.meta.audioDurationSeconds,1);assert.equal(reads,2);assert.equal(submits,1);
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');
});

test('ASR resource redirect limit cleans every hop without extra fetch',async t=>{
 quiet(t);let reads=0,cancels=0;
 const result=await run('async',{fetchImpl:async(url,init)=>{
  if(init.method==='POST'||String(url).includes('/tasks/'))return success('async',url);reads++;
  return new Response(new ReadableStream({cancel(){cancels++;return Promise.reject(Error('PRIVATE_ACK'));}}),{status:302,headers:{Location:'/loop'}});
 }});
 assert.equal(result.response.status,502);assert.equal(reads,6);assert.equal(cancels,6);assert.equal(await result.resourceCompletion,'unconfirmed');
});
