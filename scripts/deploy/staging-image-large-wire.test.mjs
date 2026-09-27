import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { referenceJsonWire,expectedReferenceUpload,fullMultipartWire,expectedMultipartUpload,parseUploadReceipt,expectedNormalizedResponse,MiB } from './staging-image-large-wire.mjs';

test('large reference and multipart inputs preserve exact public size with bounded chunks',()=>{
  for(const wire of [referenceJsonWire('model'),referenceJsonWire('model',50*MiB),fullMultipartWire('model')]) {
    let bytes=0;for(const chunk of wire.chunks()){assert.ok(chunk.length<=65536);bytes+=chunk.length;}assert.equal(bytes,wire.bytes);
  }
  assert.throws(()=>referenceJsonWire('model',50*MiB+1));assert.throws(()=>fullMultipartWire('model',50*MiB+1));
});
test('reference expectation matches independent native serialization for a small sample',()=>{
  const wire=referenceJsonWire('model');
  const input=JSON.parse(Buffer.concat([...wire.chunks()]).toString('utf8'));
  assert.ok(!('padding'in input));assert.ok(input.image.startsWith('data:image/png;base64,'));
  const expected=Buffer.from(JSON.stringify({prompt:input.prompt,n:1,image:input.image,model:'private-model'}));
  assert.deepEqual(expectedReferenceUpload(wire),{bytes:expected.length,sha256:createHash('sha256').update(expected).digest('hex')});
});
test('receipt rejects malformed data and contains enough metadata to verify multipart hashing',()=>{
  const boundary='----cinatoken-00000000-0000-0000-0000-000000000000',wire=fullMultipartWire('model'),expected=expectedMultipartUpload(wire,boundary);
  const receipt=parseUploadReceipt(`c02-limit-${expected.bytes}-${expected.sha256}.${boundary}`);
  assert.deepEqual(receipt,{mode:'limit',...expected,boundary});
  assert.throws(()=>parseUploadReceipt('c02-limit-1'));assert.throws(()=>parseUploadReceipt('c02-limit-1-'+'a'.repeat(64)+'.arbitrary'));
  assert.equal(expectedNormalizedResponse('limit').bytes,32*MiB+58);
  assert.equal(expectedNormalizedResponse('replacement').bytes,100663176);
});
