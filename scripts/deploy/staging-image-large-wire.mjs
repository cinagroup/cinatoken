// Independent, streaming wire expectations for the fixed synthetic endpoint contract.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const MiB=1024**2;
const prompt='synthetic boundary',dataUrl='data:image/png;base64,';
function* fill(n,byte=65){assert.ok(Number.isSafeInteger(n)&&n>=0);const page=Buffer.alloc(65536,byte);while(n){const k=Math.min(n,page.length);yield page.subarray(0,k);n-=k;}}
function fingerprint(chunks){let bytes=0;const hash=createHash('sha256');for(const chunk of chunks){bytes+=chunk.length;hash.update(chunk);}return {bytes,sha256:hash.digest('hex')};}

export function referenceJsonWire(model,totalBytes=4096) {
  assert.match(model,/^[a-z0-9-]{1,256}$/);
  const prefix=Buffer.from(JSON.stringify({model,prompt}).slice(0,-1)+',"image":"'+dataUrl),suffix=Buffer.from('"}');
  const referenceBytes=totalBytes-prefix.length-suffix.length;
  assert.ok(Number.isSafeInteger(totalBytes)&&totalBytes<=50*MiB&&referenceBytes>0);
  return {kind:'reference-json',bytes:totalBytes,type:'application/json',referenceBytes,
    *chunks(){yield prefix;yield* fill(referenceBytes);yield suffix;}};
}
export function expectedReferenceUpload(wire) {
  assert.equal(wire.kind,'reference-json');
  return fingerprint((function*(){yield Buffer.from('{"prompt":"'+prompt+'","n":1,"image":"'+dataUrl);yield* fill(wire.referenceBytes);yield Buffer.from('","model":"private-model"}');})());
}

function* multipartParts(boundary,fields,fileBytes) {
  for(const[name,value]of fields)yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  for(const[index,n]of fileBytes.entries()) {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${index}.png"\r\nContent-Type: image/png\r\n\r\n`);
    yield* fill(n,65+index);yield Buffer.from('\r\n');
  }
  yield Buffer.from(`--${boundary}--\r\n`);
}
export function fullMultipartWire(model,totalBytes=50*MiB) {
  assert.match(model,/^[a-z0-9-]{1,256}$/);assert.ok(Number.isSafeInteger(totalBytes)&&totalBytes<=50*MiB);
  const boundary='cinatoken-c02-full',fields=[['model',model],['prompt',prompt]];
  const overhead=fingerprint(multipartParts(boundary,fields,[0,0,0])).bytes;
  const fileBytes=[20*MiB,20*MiB,totalBytes-overhead-40*MiB];
  assert.ok(fileBytes.every(n=>n>0&&n<=20*MiB));
  return {kind:'multipart',bytes:totalBytes,type:`multipart/form-data; boundary=${boundary}`,fileBytes,
    chunks(){return multipartParts(boundary,fields,fileBytes);}};
}
export function expectedMultipartUpload(wire,boundary) {
  assert.equal(wire.kind,'multipart');assert.match(boundary,/^----cinatoken-[a-f0-9-]{36}$/);
  return fingerprint(multipartParts(boundary,[['model','private-model'],['prompt',prompt],['n','1']],wire.fileBytes));
}
export function parseUploadReceipt(id) {
  const match=/^c02-(small|limit|over|replacement)-(\d+)-([a-f0-9]{64})(?:\.(----cinatoken-[a-f0-9-]{36}))?$/.exec(id??'');
  assert.ok(match,'bounded private upstream receipt required');
  return {mode:match[1],bytes:Number(match[2]),sha256:match[3],boundary:match[4]};
}
export function expectedNormalizedResponse(mode) {
  assert.ok(['small','limit','replacement'].includes(mode));
  const prefix=Buffer.from('{"data":[{"b64_json":"AQID"}],"metadata":"'),rawSuffix=Buffer.from('","usage":{"input_tokens":3,"output_tokens":7}}');
  const suffix=Buffer.from('","usage":{"input_tokens":3,"output_tokens":7,"prompt_tokens":3,"completion_tokens":7,"total_tokens":10}}');
  const length=(mode==='small'?1024:32*MiB)-prefix.length-rawSuffix.length;
  return fingerprint((function*(){yield prefix;
    if(mode==='replacement'){let n=length;const page=Buffer.from('\ufffd'.repeat(8192));while(n){const k=Math.min(n,8192);yield page.subarray(0,k*3);n-=k;}}
    else yield* fill(length);
    yield suffix;})());
}
