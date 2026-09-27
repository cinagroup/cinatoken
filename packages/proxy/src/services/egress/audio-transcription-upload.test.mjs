import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAudioTranscriptionUpload} from './audio-transcription-upload.ts';

const make=(length=65537,fields=new FormData(),signal=new AbortController().signal)=>createAudioTranscriptionUpload(fields,{filename:'synthetic.wav',mimeType:'audio/wav',bytes:new Uint8Array(length).map((_,i)=>i%251)},signal);

for(const length of [0,1,65535,65536,65537,131073])test(`ASR multipart ${length} matches native bytes with bounded pages`,async()=>{
 const fields=new FormData();fields.append('model','whisper-1');fields.append('value','one\rtwo\nthree\r\nfour');fields.append('value','中文😀');
 const bytes=new Uint8Array(length).map((_,i)=>i%251),file={filename:'synthetic.wav',mimeType:'audio/wav',bytes};
 const upload=createAudioTranscriptionUpload(fields,file,new AbortController().signal),reader=upload.body.getReader(),chunks=[];
 let largest=0;while(true){const next=await reader.read();if(next.done)break;largest=Math.max(largest,next.value.byteLength);chunks.push(Buffer.from(next.value));}
 reader.releaseLock();assert.ok(largest<=65536);assert.equal(await upload.resourceCompletion,'confirmed');const body=Buffer.concat(chunks);assert.equal(body.length,upload.contentLength);
 const form=new FormData();for(const [key,value] of fields)form.append(key,value);form.append('file',new Blob([bytes],{type:file.mimeType}),file.filename);
 const native=new Request('https://synthetic.invalid',{method:'POST',body:form});
 const nativeBoundary=native.headers.get('Content-Type').split('boundary=')[1],boundary=upload.contentType.split('boundary=')[1];
 // Compare every byte after replacing only the deliberately random boundary.
 assert.equal(body.toString('latin1').split(boundary).join('BOUNDARY'),Buffer.from(await native.arrayBuffer()).toString('latin1').split(nativeBoundary).join('BOUNDARY'));
 upload.stop();assert.equal(await upload.resourceCompletion,'confirmed');assert.deepEqual(file.bytes,bytes);
});

for(const value of ['a'.repeat(8191)+'😀中文','x'.repeat(8192)+'\ud800','a\r\nb\rc\nd'])test(`ASR multipart UTF-8/line encoding ${value.length}`,async()=>{
 const fields=new FormData();fields.append('value',value);const upload=make(1,fields);
 const response=new Response(upload.body,{headers:{'Content-Type':upload.contentType}});const body=await response.arrayBuffer();assert.equal(body.byteLength,upload.contentLength);
 const form=await new Response(body,{headers:response.headers}).formData();assert.equal(form.get('value'),value.toWellFormed().replace(/\r\n|\r|\n/g,'\r\n'));assert.equal(await upload.resourceCompletion,'confirmed');
});

for(const mode of ['unread','partial'])test(`ASR multipart consumer cancellation ${mode} confirms and is idempotent`,async()=>{
 const upload=make(),reader=upload.body.getReader();if(mode==='partial')await reader.read();await reader.cancel('PRIVATE_REASON');reader.releaseLock();upload.stop();assert.equal(await upload.resourceCompletion,'confirmed');assert.equal((await upload.body.getReader().read()).done,true);
});

for(const mode of ['untouched','locked','released','suffix'])test(`ASR multipart source abort ${mode} is not consumer ACK`,async()=>{
 const parent=new AbortController(),upload=make(1,new FormData(),parent.signal);let reader;
 if(mode!=='untouched'){reader=upload.body.getReader();void reader.closed.catch(()=>{});}
 if(mode==='released'){await reader.read();reader.releaseLock();reader=undefined;}
 if(mode==='suffix'){let total=0;while(total<upload.contentLength){const next=await reader.read();assert.equal(next.done,false);total+=next.value.byteLength;}}
 parent.abort(Error('PRIVATE_ABORT'));upload.stop();assert.equal(await upload.resourceCompletion,mode==='untouched'?'confirmed':'unconfirmed');
 reader??=upload.body.getReader();await assert.rejects(reader.read(),{message:'Audio transcription upload stopped'});reader.releaseLock();
});

test('ASR multipart already aborted signal stops before reading',async()=>{
 const parent=new AbortController();parent.abort('PRIVATE_REASON');const upload=make(1,new FormData(),parent.signal);assert.equal(await upload.resourceCompletion,'confirmed');await assert.rejects(upload.body.getReader().read(),{message:'Audio transcription upload stopped'});
});

test('ASR multipart metadata cannot inject part headers',async()=>{
 const fields=new FormData();fields.append('quoted"\r\nname','synthetic');
 const upload=createAudioTranscriptionUpload(fields,{filename:'quoted"\r\nname.wav',mimeType:'audio/wav\r\nInjected: value',bytes:new Uint8Array([1])},new AbortController().signal);
 const text=await new Response(upload.body).text();assert.match(text,/name="quoted%22%0D%0Aname"/);assert.match(text,/filename="quoted%22%0D%0Aname.wav"/);assert.match(text,/Content-Type: application\/octet-stream/);assert.equal(text.includes('Injected:'),false);assert.equal(await upload.resourceCompletion,'confirmed');
});

test('ASR multipart handed-off audio page is isolated from caller storage',async()=>{
 const bytes=new Uint8Array(65537).fill(37);const upload=createAudioTranscriptionUpload(new FormData(),{filename:'a.wav',mimeType:'audio/wav',bytes},new AbortController().signal);const reader=upload.body.getReader();
 await reader.read();const audio=await reader.read();assert.equal(audio.value.length,65536);audio.value.fill(0);assert.ok(bytes.every(x=>x===37));await reader.cancel();reader.releaseLock();assert.equal(await upload.resourceCompletion,'confirmed');
});

test('ASR multipart encoding failure is sanitized and unconfirmed',async t=>{
 const upload=make();t.mock.method(TextEncoder.prototype,'encode',()=>{throw Error('PRIVATE_ENCODER_DETAIL');});
 await assert.rejects(upload.body.getReader().read(),{message:'Audio transcription upload encoding failed'});assert.equal(await upload.resourceCompletion,'unconfirmed');upload.stop();
});

test('ASR multipart rejects non-scalar FormData before creating a stream',()=>{
 const fields=new FormData();fields.append('wrong',new Blob(['synthetic']));assert.throws(()=>make(1,fields),{message:'Audio transcription scalar field expected'});
});
