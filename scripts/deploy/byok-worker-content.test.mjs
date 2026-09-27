import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {parseByokWorkerContent:parse}=await import(process.env.BYOK_WORKER_CONTENT_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_WORKER_CONTENT_MODULE)).href:new URL('./byok-worker-content.mjs',import.meta.url).href);
const sha=v=>createHash('sha256').update(v).digest('hex'),type='multipart/form-data; boundary=synthetic-boundary';
const multipart=(parts,tail='\r\n--synthetic-boundary--\r\n')=>Buffer.concat(parts.flatMap((p,i)=>[
  Buffer.from((i?'\r\n':'')+'--synthetic-boundary\r\n'+(p.header??`Content-Disposition: form-data; name="${p.name??'main.js'}"`)+ '\r\n\r\n'),
  Buffer.from(p.body??'export default {};')]).concat(Buffer.from(tail)));
test('name-only multipart fields preserve CRLF, binary and invalid UTF-8 bytes exactly',()=>{
  const bytes=Buffer.from([65,13,10,0,255,239,191,189,66]);const result=parse({data:multipart([{body:bytes}]),type,entrypoint:'main.js'});
  assert.equal(result.entrypoint,'main.js');assert.deepEqual(result.modules[0].bytes,bytes);assert.equal(result.modules[0].sha256,sha(bytes));
});
test('file parts and every extra module are retained, never just the matching entry',()=>{
  const result=parse({data:multipart([{header:'Content-Disposition: form-data; name="main.js"; filename="main.js"\r\nContent-Type: application/javascript'},
    {name:'data/values.bin',body:Buffer.from([1,2,255])}]),type,entrypoint:'main.js'});
  assert.deepEqual(result.modules.map(m=>m.name),['main.js','data/values.bin']);
});
test('boundary-like payload with non-delimiter suffix remains code',()=>{
  const bytes=Buffer.from('x\r\n--synthetic-boundary-not-a-delimiter\r\ny');
  assert.deepEqual(parse({data:multipart([{body:bytes}]),type,entrypoint:'main.js'}).modules[0].bytes,bytes);
});
for(const mime of ['application/javascript','application/javascript+module','text/javascript; charset=utf-8'])test('raw single-module / '+mime,()=>{
  const data=Buffer.from('export default {};');assert.equal(parse({data,type:mime}).modules[0].name,'index.js');
  assert.equal(parse({data,type:mime,entrypoint:'main.js'}).modules[0].sha256,sha(data));
});
test('quoted boundary and closing marker without final CRLF',()=>{
  assert.equal(parse({data:multipart([{}],'\r\n--synthetic-boundary--'),type:'multipart/form-data; boundary="synthetic-boundary"',entrypoint:'main.js'}).modules.length,1);
});
for(const kind of ['empty','oversize','bad-mime','no-entry','wrong-entry','duplicate','truncated','epilogue','preamble','traversal','absolute','backslash','header-duplicate','encoding','header-long','too-many'])test('reject incomplete or ambiguous module set / '+kind,()=>{
  let data=multipart([{}]),mime=type,entrypoint='main.js';
  if(kind==='empty')data=Buffer.alloc(0);if(kind==='oversize')data=Buffer.alloc(12582913);
  if(kind==='bad-mime')mime='application/json';if(kind==='no-entry')entrypoint=undefined;if(kind==='wrong-entry')entrypoint='unknown.js';
  if(kind==='duplicate')data=multipart([{},{}]);if(kind==='truncated')data=data.subarray(0,data.length-10);
  if(kind==='epilogue')data=Buffer.concat([data,Buffer.from('extra')]);if(kind==='preamble')data=Buffer.concat([Buffer.from('prefix'),data]);
  if(kind==='traversal')data=multipart([{name:'../main.js'}]);if(kind==='absolute')data=multipart([{name:'/main.js'}]);if(kind==='backslash')data=multipart([{name:'dir\\main.js'}]);
  if(kind==='header-duplicate')data=multipart([{header:'Content-Disposition: form-data; name="main.js"\r\nContent-Disposition: form-data; name="other.js"'}]);
  if(kind==='encoding')data=multipart([{header:'Content-Disposition: form-data; name="main.js"\r\nContent-Transfer-Encoding: base64'}]);
  if(kind==='header-long')data=multipart([{header:'Content-Disposition: form-data; name="main.js"\r\nContent-Type: '+ 'a'.repeat(5000)}]);
  if(kind==='too-many')data=multipart(Array.from({length:33},(_,i)=>({name:i+'.js'})));
  assert.throws(()=>parse({data,type:mime,entrypoint}),/^Error: byok_worker_content_invalid$/);
});
