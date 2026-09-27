import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dispatchOpenAiAudioSpeech,dispatchDashScopeSpeechSynthesizer,dispatchDashScopeQwenTts,dispatchDashScopeMiniMaxTts,AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES} from './audio-speech-driver.ts';
import {observeResourceCleanup} from '../resource-completion.ts';

const variants=['openai','speech','qwen','minimax'];
const drivers={openai:dispatchOpenAiAudioSpeech,speech:dispatchDashScopeSpeechSynthesizer,qwen:dispatchDashScopeQwenTts,minimax:dispatchDashScopeMiniMaxTts};
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
function quiet(t){for(const name of ['log','warn','error'])t.mock.method(console,name,()=>{});}
function route(v){return {targetId:'tts-resource',providerId:'synthetic',providerName:'synthetic',providerModelName:'synthetic',upstreamProtocol:v==='openai'?'openai':'dashscope',upstreamOperation:v==='openai'||v==='speech'?'audio.speech':'audio.speech.multimodal',adapter:v==='openai'?'passthrough':'dashscope-tts-'+v,providerEndpoints:{openai:{base:'https://synthetic.invalid/v1'},dashscope:{base:'https://synthetic.invalid/api/v1'}},providerApiKey:'synthetic-only',customParams:null,routeGroup:'default',routePriority:0,routeWeight:1};}
function request(streamFormat='audio'){return {input:'hello',voice:'synthetic',responseFormat:'wav',speed:1,streamFormat};}
function event(v,terminal=false){return new TextEncoder().encode('data: '+JSON.stringify(v==='openai'?terminal?{type:'speech.audio.done',usage:{input_tokens:2,output_tokens:3,total_tokens:5}}:{type:'speech.audio.delta',audio:'AQID'}:{output:v==='minimax'?{data:{audio:'010203',status:terminal?2:1}}:{audio:{data:'AQID'},finish_reason:terminal?'stop':null},usage:{characters:5,input_tokens:2,output_tokens:3,total_tokens:5}})+'\n\n');}
const contentType=(v,format)=>v==='openai'&&format==='audio'?'audio/wav':'text/event-stream';

for(const v of variants)for(const format of ['audio','sse'])for(const stop of ['client','downstream','deadline'])for(const ack of ['resolve','reject'])
test(`TTS resource stream ${v}/${format}/${stop}/${ack}`,{timeout:4000},async t=>{
 quiet(t);t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const gate=Promise.withResolvers(),abort=new AbortController();let cancels=0,sends=0;
 const source=new ReadableStream({start(c){if(v!=='openai')c.enqueue(event(v));},cancel(){cancels++;return gate.promise;}},{highWaterMark:0});
 const result=await drivers[v](route(v),request(format),abort.signal,undefined,undefined,{deadlineAtMs:Date.now()+100,fetchImpl:async()=>{sends++;return new Response(source,{headers:{'Content-Type':contentType(v,format)}});}});
 t.after(async()=>{gate.resolve();abort.abort();await result.response.body.cancel().catch(()=>{});});
 assert.ok(result.resourceCompletion instanceof Promise);let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
 if(stop==='client')abort.abort();else if(stop==='downstream')await result.response.body.cancel();else t.mock.timers.tick(100);
 const usage=await result.usagePromise;await flush();
 assert.equal(cleaned,false);assert.equal(cancels,1);assert.equal(source.locked,false,'lock release is not cleanup confirmation');
 if(stop==='deadline'){assert.notEqual(usage.cancelled,true);assert.match(usage.stream_error,/deadline/);}else assert.equal(usage.cancelled,true);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE_CLEANUP'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');assert.equal(sends,1);
});

for(const v of variants)for(const format of ['audio','sse'])for(const ack of ['resolve','reject']){
 if(v==='openai'&&format==='audio')continue;
 test(`TTS resource success ${v}/${format}/${ack} settles before cleanup`,{timeout:4000},async t=>{
  quiet(t);const gate=Promise.withResolvers();let cancels=0;
  const source=new ReadableStream({start(c){c.enqueue(event(v,true));},cancel(){cancels++;return gate.promise;}});
  t.after(()=>{gate.resolve();});const result=await drivers[v](route(v),request(format),undefined,undefined,undefined,{fetchImpl:async()=>new Response(source,{headers:{'Content-Type':contentType(v,format)}})});
  let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
  assert.ok((await result.response.arrayBuffer()).byteLength>0);const usage=await result.usagePromise;await flush();
  assert.equal(usage.total_tokens,5);assert.notEqual(usage.cancelled,true);assert.equal(usage.stream_error,undefined);assert.equal(cleaned,false);assert.equal(cancels,1);
  if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE'));
  assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');assert.equal((await result.usagePromise).total_tokens,5);
 });
}

test('TTS resource OpenAI binary EOF confirms without cancellation',async()=>{
 const result=await drivers.openai(route('openai'),request(),undefined,undefined,undefined,{fetchImpl:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/wav'}})});
 await result.response.arrayBuffer();assert.equal(await result.resourceCompletion,'confirmed');assert.equal((await result.usagePromise).cancelled,undefined);
});

for(const v of variants)for(const kind of ['declared-error-size','observed-error-size','error-body-cancel'])for(const ack of ['resolve','reject'])
test(`TTS resource error body ${v}/${kind}/${ack}`,{timeout:4000},async t=>{
 quiet(t);const gate=Promise.withResolvers(),entered=Promise.withResolvers(),abort=new AbortController();let cancels=0;
 const source=new ReadableStream({pull(c){entered.resolve();if(kind==='observed-error-size')c.enqueue(new Uint8Array(AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES+1));},cancel(){cancels++;return gate.promise;}},{highWaterMark:0});
 const pending=drivers[v](route(v),request(),abort.signal,undefined,undefined,{fetchImpl:async()=>new Response(source,{status:503,headers:{'Content-Type':'application/json',...(kind==='declared-error-size'?{'Content-Length':String(AUDIO_SPEECH_MAX_ERROR_RESPONSE_BYTES+1)}:{})}})});
 t.after(()=>{gate.resolve();abort.abort();});if(kind==='error-body-cancel'){await entered.promise;abort.abort();}
 const result=await pending;let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
 await result.response.text();await result.usagePromise;await flush();assert.equal(cleaned,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');
});

for(const v of variants.slice(1))for(const kind of ['invalid-json','invalid-utf8','application-error'])for(const ack of ['resolve','reject'])
test(`TTS resource first event ${v}/${kind}/${ack}`,{timeout:4000},async t=>{
 quiet(t);const gate=Promise.withResolvers();let cancels=0;
 const source=new ReadableStream({start(c){c.enqueue(kind==='invalid-utf8'?new Uint8Array([255]):new TextEncoder().encode(kind==='invalid-json'?'data: {invalid}\n\n':'data: {"code":"synthetic_failure","message":"synthetic"}\n\n'));},cancel(){cancels++;return gate.promise;}});
 t.after(()=>{gate.resolve();});const result=await drivers[v](route(v),request(),undefined,undefined,undefined,{fetchImpl:async()=>new Response(source,{headers:{'Content-Type':'text/event-stream'}})});
 assert.equal(result.response.status,502);let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});
 await result.usagePromise;await flush();assert.equal(cleaned,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');
});

for(const ack of ['resolve','reject'])test(`TTS resource wrong content type ${ack}`,{timeout:4000},async t=>{
 quiet(t);const gate=Promise.withResolvers();let cancels=0;
 const source=new ReadableStream({cancel(){cancels++;return gate.promise;}});t.after(()=>{gate.resolve();});
 const result=await drivers.openai(route('openai'),request(),undefined,undefined,undefined,{fetchImpl:async()=>new Response(source,{headers:{'Content-Type':'text/html'}})});
 assert.equal(result.response.status,502);let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});await flush();assert.equal(cleaned,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');
});

for(const v of variants)for(const stop of ['client','deadline'])for(const ack of ['resolve','reject'])
test(`TTS resource late headers ${v}/${stop}/${ack}`,{timeout:4000},async t=>{
 quiet(t);t.mock.timers.enable({apis:['Date','setTimeout'],now:1700000000000});
 const headers=Promise.withResolvers(),gate=Promise.withResolvers(),entered=Promise.withResolvers(),abort=new AbortController();let sends=0,cancels=0;
 const pending=drivers[v](route(v),request(),abort.signal,undefined,undefined,{deadlineAtMs:Date.now()+100,fetchImpl:async()=>{sends++;entered.resolve();return headers.promise;}});
 await entered.promise;if(stop==='client')abort.abort();else t.mock.timers.tick(100);
 const result=await pending;assert.equal(result.response.status,stop==='client'?499:504);
 let cleaned=false;void result.resourceCompletion.then(()=>{cleaned=true;});await flush();assert.equal(cleaned,false);
 headers.resolve(new Response(new ReadableStream({cancel(){cancels++;return gate.promise;}})));
 await flush();assert.equal(cleaned,false);assert.equal(cancels,1);
 if(ack==='resolve')gate.resolve();else gate.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,ack==='resolve'?'confirmed':'unconfirmed');assert.equal(sends,1);
});

for(const v of variants)test(`TTS resource late transport rejection ${v} is unconfirmed`,async t=>{
 quiet(t);const headers=Promise.withResolvers(),entered=Promise.withResolvers(),abort=new AbortController();
 const pending=drivers[v](route(v),request(),abort.signal,undefined,undefined,{fetchImpl:async()=>{entered.resolve();return headers.promise;}});
 await entered.promise;abort.abort();const result=await pending;headers.reject(Error('PRIVATE'));
 assert.equal(await result.resourceCompletion,'unconfirmed');
});

for(const mode of ['resolve','reject','throw'])test(`TTS resource cleanup normalization ${mode}`,async()=>{
 const result=await observeResourceCleanup(()=>{if(mode==='throw')throw Error('PRIVATE');return mode==='reject'?Promise.reject(Error('PRIVATE')):Promise.resolve();});
 assert.equal(result,mode==='resolve'?'confirmed':'unconfirmed');
});
