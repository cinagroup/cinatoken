import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PEER_PROFILE,PEER_MAX_BYTES,parseCapacityPeer,assertPeerRecord,createCapacityPeerParser} from './staging-sse-capacity-peer-protocol.mjs';
const instanceId=randomUUID(),peer=instanceId+':1';
const sample=(patch={})=>({profile:PEER_PROFILE,kind:'sample',instanceId,watchEpoch:1,barrier:0,sequence:1,maxRequests:1,maxReservedBytes:1024,requests:0,reservedBytes:0,...patch});
const wire=value=>Buffer.from(JSON.stringify(value)+'\n');
const end=(reason='deadline')=>({profile:PEER_PROFILE,kind:'end',instanceId,watchEpoch:1,reason});
test('arbitrary byte fragmentation and canonical reassembly stay bounded',()=>{
  const parser=createCapacityPeerParser(peer),rows=[];
  for(const byte of Buffer.concat([wire(sample()),wire(sample({sequence:2,barrier:1,requests:1,reservedBytes:1024})),wire(end())]))
    rows.push(...parser.push(Uint8Array.of(byte)));
  assert.equal(rows.length,3);parser.finish();assert.equal(parser.stats().partialBytes,0);
});
test('coalesced maximum sample count and end is accepted, no infinite history',()=>{
  const parser=createCapacityPeerParser(peer),body=Buffer.concat([...Array.from({length:180},(_,i)=>wire(sample({sequence:i+1}))),wire(end('sample-limit'))]);
  assert.ok(body.length<PEER_MAX_BYTES);assert.equal(parser.push(body).length,181);parser.finish();
});
for(const [label,mutate] of [
  ['old protocol',v=>v.profile='c02-sse-peer-v1'],['wrong instance',v=>v.instanceId=randomUUID()],['wrong epoch',v=>v.watchEpoch=2],
  ['extra field',v=>v.secret='do-not-log'],['zero sequence',v=>v.sequence=0],['large sequence',v=>v.sequence=181],
  ['string sequence',v=>v.sequence='1'],['fractional barrier',v=>v.barrier=.1],['negative barrier',v=>v.barrier=-1],
  ['large barrier',v=>v.barrier=4],['wrong pool limit',v=>v.maxRequests=2],['wrong weight',v=>v.maxReservedBytes=2048],
  ['inconsistent bytes',v=>v.reservedBytes=1024],['overadmission',v=>v.requests=2],
])test('strict record rejects '+label,()=>{
  const value=sample();mutate(value);assert.throws(()=>assertPeerRecord(value,peer));
});
for(const [label,body] of [
  ['duplicate key',Buffer.from(JSON.stringify(sample()).replace('"sequence":1','"sequence":1,"sequence":1')+'\n')],
  ['whitespace',Buffer.from(' '+JSON.stringify(sample())+'\n')],['empty line',Buffer.from('\n')],
  ['invalid UTF8',Uint8Array.of(255,10)],['BOM',Buffer.concat([Uint8Array.of(239,187,191),wire(sample())])],
  ['oversized line',Buffer.from('x'.repeat(512)+'\n')],['oversized chunk',new Uint8Array(PEER_MAX_BYTES+1)],
  ['empty chunk',new Uint8Array(0)],['string chunk','x'],
  ['sequence gap',wire(sample({sequence:2}))],['repeated sequence',Buffer.concat([wire(sample()),wire(sample())])],
  ['regressed barrier',Buffer.concat([wire(sample({barrier:1})),wire(sample({sequence:2,barrier:0}))])],
  ['premature sample-limit',Buffer.concat([wire(sample()),wire(end('sample-limit'))])],
  ['data after end',Buffer.concat([wire(sample()),wire(end()),wire(sample({sequence:2}))])],
])test('wire parser fails closed on '+label,()=>{
  const parser=createCapacityPeerParser(peer);assert.throws(()=>parser.push(body));assert.throws(()=>parser.push(wire(sample())));
});
test('EOF without terminal record or with partial line is rejected',()=>{
  const a=createCapacityPeerParser(peer);a.push(wire(sample()));assert.throws(()=>a.finish());
  const b=createCapacityPeerParser(peer);b.push(Uint8Array.of(123));assert.throws(()=>b.finish());
});
for(const value of ['',randomUUID()+':0',randomUUID()+':01',randomUUID()+':9007199254740992','x'.repeat(54),randomUUID()+':1:2'])
  test('identity parser rejects '+value.slice(-20),()=>assert.throws(()=>parseCapacityPeer(value)));
