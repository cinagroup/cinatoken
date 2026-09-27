import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOwnedJsonUploadBody} from './owned-json-upload-body.ts';
import {createAudioTranscriptionUpload} from './audio-transcription-upload.ts';
import {audioUploadToDataUrlPages,DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES} from './dashscope-audio-driver.ts';

for(const length of [0,1,2,3,24575,24576,24577,49153])test(`ASR JSON paged Base64 ${length} preserves native encoding`,async()=>{
 const bytes=Uint8Array.from({length},(_,i)=>i%251),file={filename:'a.wav',mimeType:'audio/wav',bytes};let checks=0;
 const pages=audioUploadToDataUrlPages(file,()=>{checks++;});assert.ok(checks>=2);assert.ok([...pages.chunks()].every(x=>x.length<=65536));
 const upload=createOwnedJsonUploadBody({audio:pages},new AbortController().signal);const text=await new Response(upload.body).text();assert.equal(text,JSON.stringify({audio:'data:audio/wav;base64,'+Buffer.from(bytes).toString('base64')}));assert.equal(Buffer.byteLength(text),upload.contentLength);assert.equal(await upload.resourceCompletion,'confirmed');
});

test('ASR JSON Base64 limit is checked before encoding and remains exact',()=>{
 const max=Math.floor((DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES-'data:audio/wav;base64,'.length)/4)*3;
 const file={filename:'a.wav',mimeType:'audio/wav',bytes:new Uint8Array(max)};
 const pages=audioUploadToDataUrlPages(file,()=>{});assert.ok(pages.length<=DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES);assert.ok(pages.length>DASHSCOPE_SYNC_ASR_MAX_DATA_URL_BYTES-4);
 assert.throws(()=>audioUploadToDataUrlPages({...file,bytes:new Uint8Array(max+1)},()=>{}),/Data URL must be at most/);
});

test('ASR JSON Base64 stops between pages and never encodes the whole binary string',t=>{
 const original=btoa;let largest=0,calls=0;const reason=Error('synthetic stopped');
 t.mock.method(globalThis,'btoa',value=>{largest=Math.max(largest,value.length);calls++;return original(value);});
 assert.throws(()=>audioUploadToDataUrlPages({filename:'a.wav',mimeType:'audio/wav',bytes:new Uint8Array(80000)},()=>{if(calls===2)throw reason;}),error=>error===reason);
 assert.equal(calls,2);assert.equal(largest,24576);
});

for(const size of [1,70000])test(`ASR JSON encoder final page ${size} is not outer consumer EOF`,async()=>{
 const upload=createOwnedJsonUploadBody({text:'x'.repeat(size)},new AbortController().signal),reader=upload.body.getReader();let bytes=0,finished=false;
 void upload.resourceCompletion.then(()=>{finished=true;});
 while(bytes<upload.contentLength){const next=await reader.read();assert.equal(next.done,false);bytes+=next.value.length;}
 for(let i=0;i<10;i++)await Promise.resolve();assert.equal(finished,false);
 upload.stop();assert.equal(await upload.resourceCompletion,'unconfirmed');await assert.rejects(reader.read(),/JSON upload stopped/);reader.releaseLock();
});

for(const mode of ['untouched','locked','partial','released','cancel','pending-read'])test(`ASR JSON owner stop ${mode}`,async()=>{
 const parent=new AbortController(),upload=createOwnedJsonUploadBody({text:'中'.repeat(80000)},parent.signal);let reader;
 if(mode!=='untouched'){reader=upload.body.getReader();void reader.closed.catch(()=>{});}
 if(['partial','released','cancel'].includes(mode))await reader.read();
 if(mode==='released'){reader.releaseLock();reader=undefined;}
 if(mode==='cancel')await reader.cancel();
 const pending=mode==='pending-read'?reader.read():null;
 parent.abort(Error('PRIVATE_REASON'));upload.stop();assert.equal(await upload.resourceCompletion,['untouched','cancel'].includes(mode)?'confirmed':'unconfirmed');
 if(mode==='pending-read')await assert.rejects(pending,/JSON upload stopped/);
 else if(mode!=='cancel'){reader??=upload.body.getReader();await assert.rejects(reader.read(),/JSON upload stopped/);}
 reader?.releaseLock();
});

test('ASR JSON upload snapshots hooks once before pulls and preserves JSON projection',async()=>{
 let hooks=0,getters=0;const child={value:'before'};
 const value={child,get accessor(){getters++;return 'synthetic';},hook:{toJSON(){hooks++;return {a:NaN,b:undefined};}},array:[undefined,-0],text:'中文😀\ud800'};
 const expected=JSON.stringify(value);hooks=getters=0;
 const upload=createOwnedJsonUploadBody(value,new AbortController().signal);assert.equal(hooks,1);assert.equal(getters,1);child.value='after';
 assert.equal(await new Response(upload.body).text(),expected);assert.equal(hooks,1);assert.equal(getters,1);assert.equal(await upload.resourceCompletion,'confirmed');
});

test('ASR JSON upload encoding errors are sanitized and unconfirmed',async t=>{
 const upload=createOwnedJsonUploadBody({a:'synthetic'},new AbortController().signal);
 t.mock.method(TextEncoder.prototype,'encodeInto',()=>{throw Error('PRIVATE_DETAIL');});
 await assert.rejects(upload.body.getReader().read(),{message:'JSON upload encoding failed'});assert.equal(await upload.resourceCompletion,'unconfirmed');
});

test('ASR JSON upload refuses cycles and already aborted requests before source handoff',()=>{
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>createOwnedJsonUploadBody(cyclic,new AbortController().signal));
 const parent=new AbortController();parent.abort();assert.throws(()=>createOwnedJsonUploadBody({},parent.signal));
});

for(const kind of ['json','multipart'])test(`ASR ${kind} declares source length to workerd without a forwarding pipe`,async t=>{
 const Native=ReadableStream,sources=[];
 t.mock.method(globalThis,'ReadableStream',class extends Native{constructor(source,strategy){sources.push(source);super(source,strategy);}});
 const upload=kind==='json'?createOwnedJsonUploadBody({text:'中文😀'},new AbortController().signal):createAudioTranscriptionUpload(new FormData(),{filename:'a.wav',mimeType:'audio/wav',bytes:new Uint8Array([1])},new AbortController().signal);
 assert.equal(sources.at(-1).expectedLength,upload.contentLength);assert.equal((await new Response(upload.body).arrayBuffer()).byteLength,upload.contentLength);assert.equal(await upload.resourceCompletion,'confirmed');
});
