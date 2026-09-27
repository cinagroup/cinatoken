import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('ASR native workerd multipart keeps exact HTTP length without chunked framing',{timeout:30000},async t=>{
 const observations=[];
 const server=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
   const form=await new Response(bytes,{headers:{'Content-Type':req.headers['content-type']}}).formData();
   const file=new Uint8Array(await form.get('file').arrayBuffer());
   observations.push({length:bytes.length,declared:req.headers['content-length']??null,transfer:req.headers['transfer-encoding']??null,fileLength:file.length,bytesValid:file.every((x,i)=>x===i%251),prompt:form.get('prompt')});
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({text:'synthetic',duration:1}));
  }catch{res.writeHead(500);res.end('synthetic fixture failure');}
 });
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const target=`http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`;
 const {outputFiles}=await build({stdin:{contents:`
  import {createAudioTranscriptionUpload} from './packages/proxy/src/services/egress/audio-transcription-upload.ts';
  export default {async fetch(request){
   const length=Number(new URL(request.url).searchParams.get('length'));
   if(![0,1,65535,65536,65537,131073].includes(length))return new Response(null,{status:400});
   const form=new FormData();form.append('prompt','synthetic\\n中文😀');
   const upload=createAudioTranscriptionUpload(form,{filename:'synthetic.wav',mimeType:'audio/wav',bytes:Uint8Array.from({length},(_,i)=>i%251)},new AbortController().signal);
   let status;try{
    const init={method:'POST',headers:{'Content-Type':upload.contentType,'Content-Length':String(upload.contentLength)},body:upload.body};
    const response=await fetch(${JSON.stringify(target)},init);status=response.status;await response.arrayBuffer();
   }finally{upload.stop();}
   return Response.json({status,expected:upload.contentLength,completion:await upload.resourceCompletion});
  }};`,resolveDir:fileURLToPath(new URL('../../../../',import.meta.url)),sourcefile:'asr-upload-workerd-fixture.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-08-24',compatibilityFlags:['nodejs_compat','enable_request_signal'],cf:false,host:'127.0.0.1',port:0}));
 t.after(()=>mf.dispose());
 for(const length of [0,1,65535,65536,65537,131073]){
  const response=await mf.dispatchFetch(`http://localhost/?length=${length}`);assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.status,200);assert.equal(result.completion,'confirmed');const wire=observations.at(-1);
  assert.equal(wire.length,result.expected);assert.equal(wire.fileLength,length);assert.equal(wire.bytesValid,true);assert.equal(wire.prompt,'synthetic\r\n中文😀');
  assert.equal(wire.declared,String(result.expected));assert.equal(wire.transfer,null);
 }
 assert.equal(observations.length,6);
});
