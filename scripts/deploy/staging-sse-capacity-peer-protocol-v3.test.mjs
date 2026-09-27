import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {
  PEER_V3_PROFILE, PEER_V3_LIMITS, PEER_V3_STAGES,
  captureSseCapacityPrimaryV3, assertSseCapacityPrimaryV3, isSseCapacityPeerV3Mismatch,
  assertSseCapacityPeerV3Record, createSseCapacityPeerV3Parser,
} from './staging-sse-capacity-peer-protocol-v3.mjs';

const instanceId = randomUUID(), peer = instanceId + ':1', requestId = 'gen-' + randomUUID();
const common = {profile:PEER_V3_PROFILE, instanceId, watchEpoch:1};
const sample = (patch={}) => ({...common, kind:'sample', barrier:0, sequence:1,
  maxRequests:1, maxReservedBytes:1024, requests:1, reservedBytes:1024, ...patch});
const ack = (barrier=1) => ({...common, kind:'barrier', barrier, stage:PEER_V3_STAGES[barrier-1]});
const end = (reason='deadline') => ({...common, kind:'end', reason});
const wire = value => Buffer.from(JSON.stringify(value));
const push = (parser, value) => parser.pushMessage(wire(value), false);
const ready = () => { const p = createSseCapacityPeerV3Parser(peer); push(p, sample()); return p; };
const mismatch = () => ({status:409, complete:true,
  headers:new Headers({'content-type':'application/json', 'cache-control':'no-store'}),
  body:Buffer.from('{"status":"rejected","reason":"peer_not_active_here","dispatch_started":false}')});
const primaryHeaders = () => new Headers({'content-type':'text/event-stream', 'cache-control':'no-store',
  'x-c02-capacity-primary':'v3', 'x-c02-capacity-before':'0/0', 'x-c02-capacity-peer':peer,
  'x-c02-capacity-instance':instanceId, 'x-generation-id':requestId});
const response = () => new Response(new ReadableStream({pull() {}}, {highWaterMark:0}), {headers:primaryHeaders()});

test('actual primary response capture preserves sole body ownership and records original clock', async () => {
  let pulls=0, cancels=0;
  const body = new ReadableStream({pull() { pulls++; }, cancel() { cancels++; }}, {highWaterMark:0});
  const r = new Response(body, {headers:primaryHeaders()}), clock = createSseOperatorClock(), receipt=clock.sample();
  const primary = captureSseCapacityPrimaryV3(r, receipt, clock.clockId);
  assert.equal(primary.before, '0/0'); assert.equal(primary.peer, peer); assert.deepEqual(primary.received, receipt);
  assert.equal(pulls+cancels, 0); assert.equal(r.body, body); assert.equal(r.bodyUsed, false); assert.equal(r.body.locked, false);
  assert.deepEqual(assertSseCapacityPrimaryV3(primary, clock.clockId), primary);
  assert.equal('nativeVerified' in primary, false);
  await r.body.cancel();
});
for (const [label, header, value] of [
  ['old profile','x-c02-capacity-primary','v2'], ['nonempty initial pool','x-c02-capacity-before','1/1024'],
  ['foreign instance','x-c02-capacity-instance',randomUUID()], ['old peer','x-c02-capacity-peer',instanceId+':0'],
  ['missing generation','x-generation-id',null], ['malformed generation','x-generation-id','gen-x'],
  ['cacheable','cache-control','public'], ['wrong content type','content-type','application/json'],
]) test('primary rejects '+label, async () => {
  const r=response(), clock=createSseOperatorClock();
  if(value===null)r.headers.delete(header);else r.headers.set(header,value);
  assert.throws(()=>captureSseCapacityPrimaryV3(r,clock.sample(),clock.clockId));
  assert.equal(r.bodyUsed,false);await r.body.cancel();
});
test('primary rejects mismatched epoch, already locked body, non200 and foreign URL', async () => {
  const r=response(), clock=createSseOperatorClock();
  assert.throws(()=>captureSseCapacityPrimaryV3(r,clock.sample(),randomUUID()));
  const reader=r.body.getReader();assert.throws(()=>captureSseCapacityPrimaryV3(r,clock.sample(),clock.clockId));reader.releaseLock();
  Object.defineProperty(r,'url',{value:'https://other.invalid/v1/images/generations'});
  assert.throws(()=>captureSseCapacityPrimaryV3(r,clock.sample(),clock.clockId));await r.body.cancel();
  assert.throws(()=>captureSseCapacityPrimaryV3(new Response('x',{status:409,headers:primaryHeaders()}),clock.sample(),clock.clockId));
});
test('primary evidence does not accept extra credentials or altered baseline', () => {
  const clock=createSseOperatorClock(), p=captureSseCapacityPrimaryV3(response(),clock.sample(),clock.clockId);
  assert.throws(()=>assertSseCapacityPrimaryV3({...p,secret:'never-include'},clock.clockId));
  assert.throws(()=>assertSseCapacityPrimaryV3({...p,before:'1/1024'},clock.clockId));
});

test('only exact complete peer mismatch declaration is recognizable', () => assert.equal(isSseCapacityPeerV3Mismatch(mismatch()), true));
for (const [label, mutate] of [
  ['incomplete',v=>v.complete=false], ['status',v=>v.status=401], ['missing EOF flag',v=>delete v.complete],
  ['unknown reason',v=>v.body=Buffer.from('{"status":"rejected","reason":"watch_already_used","dispatch_started":false}')],
  ['extra keys',v=>v.body=Buffer.from(v.body.toString().replace('}',',"extra":1}'))],
  ['duplicate keys',v=>v.body=Buffer.from(v.body.toString().replace('"dispatch_started":false','"dispatch_started":true,"dispatch_started":false'))],
  ['whitespace',v=>v.body=Buffer.concat([Buffer.from(' '),v.body])],
  ['BOM',v=>v.body=Buffer.concat([Buffer.from([239,187,191]),v.body])], ['invalid UTF8',v=>v.body=Buffer.from([255])],
  ['oversized',v=>v.body=Buffer.alloc(513)], ['empty',v=>v.body=Buffer.alloc(0)], ['string',v=>v.body=v.body.toString()],
  ['no no-store',v=>v.headers.delete('cache-control')], ['nonJSON',v=>v.headers.set('content-type','text/html')],
  ['generation id present',v=>v.headers.set('x-generation-id',requestId)], ['upgrade indicator',v=>v.headers.set('x-c02-capacity-watch','v3')],
  ['redirect location',v=>v.headers.set('location','https://other.invalid')],
]) test('mismatch classifier refuses '+label, () => { const v=mismatch();mutate(v);assert.equal(isSseCapacityPeerV3Mismatch(v), false); });

test('V3 baseline is occupied; three marks are ordered with same-stream ACK before sample', () => {
  const p=ready();let sequence=1;
  for (let i=1;i<=3;i++) {
    assert.equal(p.mark(PEER_V3_STAGES[i-1]),JSON.stringify({profile:PEER_V3_PROFILE,kind:'mark',barrier:i,stage:PEER_V3_STAGES[i-1]}));
    // A queued old-stage frame is still old evidence, not the new barrier.
    const old=push(p,sample({sequence:++sequence,barrier:i-1}));assert.equal(old.barrier,i-1);
    push(p,ack(i));assert.equal(p.stats().awaitingSample,true);
    push(p,sample({sequence:++sequence,barrier:i}));assert.equal(p.stats().awaitingSample,false);
  }
  push(p,end());p.finish();assert.equal(p.stats().frames,11);assert.equal(p.stats().issued,3);
});
test('maximum server output is 180 samples, 3 ACKs, one end with bounded numeric state', () => {
  const p=ready();
  for(let i=1;i<=3;i++){p.mark(PEER_V3_STAGES[i-1]);push(p,ack(i));push(p,sample({sequence:i+1,barrier:i}));}
  for(let i=5;i<=180;i++)push(p,sample({sequence:i,barrier:3}));
  push(p,end('sample-limit'));p.finish();
  assert.equal(p.stats().frames,PEER_V3_LIMITS.frames);assert.equal(p.stats().sequence,180);
  assert.ok(p.stats().bytes<=PEER_V3_LIMITS.bytes);assert.equal('records' in p.stats(),false);
  assert.throws(()=>push(p,end()));
});
for (const [label, mutate] of [
  ['V2',v=>v.profile='c02-sse-peer-v2'], ['foreign instance',v=>v.instanceId=randomUUID()], ['foreign epoch',v=>v.watchEpoch=2],
  ['extra key',v=>v.secret='not-allowed'], ['zero sequence',v=>v.sequence=0], ['sequence overflow',v=>v.sequence=181],
  ['fraction sequence',v=>v.sequence=1.5], ['string sequence',v=>v.sequence='1'],
  ['negative barrier',v=>v.barrier=-1], ['barrier overflow',v=>v.barrier=4],
  ['pool limit',v=>v.maxRequests=2], ['byte limit',v=>v.maxReservedBytes=2048], ['overadmission',v=>v.requests=2],
  ['inconsistent reservation',v=>v.reservedBytes=0],
]) test('V3 record rejects '+label, () => { const v=sample();mutate(v);assert.throws(()=>assertSseCapacityPeerV3Record(v,peer)); });
for (const [label, value, binary] of [
  ['binary',wire(sample()),true], ['unknown type',wire(sample()),undefined],
  ['string callback',JSON.stringify(sample()),false], ['empty',Buffer.alloc(0),false],
  ['oversized',Buffer.alloc(513),false], ['BOM',Buffer.concat([Buffer.from([239,187,191]),wire(sample())]),false],
  ['invalid UTF8',Buffer.from([255]),false], ['whitespace',Buffer.concat([Buffer.from(' '),wire(sample())]),false],
  ['duplicate keys',Buffer.from(JSON.stringify(sample()).replace('"sequence":1','"sequence":1,"sequence":1')),false],
  ['multiple records',Buffer.concat([wire(sample()),wire(sample())]),false],
  ['NDJSON frame',Buffer.concat([wire(sample()),Buffer.from('\n')]),false],
  ['V2 idle baseline',wire(sample({requests:0,reservedBytes:0})),false],
  ['sequence gap',wire(sample({sequence:2})),false], ['sample before ACK',wire(sample({barrier:1})),false],
]) test('message parser permanently fails on '+label, () => {
  const p=createSseCapacityPeerV3Parser(peer);
  assert.throws(()=>p.pushMessage(value,binary));assert.equal(p.stats().failed,true);
  assert.throws(()=>push(p,sample()));assert.throws(()=>p.mark('held'));assert.throws(()=>p.finish());
});
for (const [label, act] of [
  ['mark before baseline',p=>p.mark('held')], ['end before baseline',p=>push(p,end())],
  ['ACK before baseline',p=>push(p,ack())],
  ['unissued ACK',p=>{push(p,sample());push(p,ack());}],
  ['wrong first stage',p=>{push(p,sample());p.mark('post-native');}],
  ['resend before ACK',p=>{push(p,sample());p.mark('held');p.mark('held');}],
  ['new mark before ACK',p=>{push(p,sample());p.mark('held');p.mark('post-native');}],
  ['mark before ACK sample',p=>{push(p,sample());p.mark('held');push(p,ack());p.mark('post-native');}],
  ['end before ACK sample',p=>{push(p,sample());p.mark('held');push(p,ack());push(p,end());}],
  ['wrong ACK',p=>{push(p,sample());p.mark('held');push(p,ack(2));}],
  ['duplicate ACK',p=>{push(p,sample());p.mark('held');push(p,ack());push(p,ack());}],
  ['sample barrier regresses',p=>{push(p,sample());p.mark('held');push(p,ack());push(p,sample({sequence:2}));}],
  ['repeated sequence',p=>{push(p,sample());push(p,sample());}],
  ['premature sample-limit',p=>{push(p,sample());push(p,end('sample-limit'));}],
  ['close is not protocol end',p=>{push(p,sample());p.finish();}],
  ['mark after end',p=>{push(p,sample());push(p,end());p.mark('held');}],
]) test('causal parser refuses '+label, () => {
  const p=createSseCapacityPeerV3Parser(peer);assert.throws(()=>act(p));
  assert.equal(p.stats().failed,true);assert.throws(()=>push(p,sample()));
});
test('deadline while ACK pending is terminal, not successful marker evidence', () => {
  const p=ready();p.mark('held');push(p,end());p.finish();
  assert.equal(p.stats().issued,1);assert.equal(p.stats().barrier,0);
  assert.throws(()=>p.mark('held'));
});
test('fourth marker and marker after sample exhaustion cannot be issued', () => {
  const p=ready();for(let i=1;i<=3;i++){p.mark(PEER_V3_STAGES[i-1]);push(p,ack(i));push(p,sample({sequence:i+1,barrier:i}));}
  assert.throws(()=>p.mark('post-recovery'));
  const q=ready();for(let i=2;i<=180;i++)push(q,sample({sequence:i}));assert.throws(()=>q.mark('held'));
});
