import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createSseOperatorClock,assertOperatorSample,assertSseOperatorTiming,sseOperatorCleanupDeadline} from './staging-sse-operator-clock.mjs';

function fixture(){
  let ns=0n,wall='2026-09-08T00:00:00.000Z';const sleeps=[];
  const clock=createSseOperatorClock({readNs:()=>ns,wallNow:()=>wall,sleep:async ms=>{sleeps.push(ms);ns+=BigInt(ms)*1000000n;}});
  return {clock,sleeps,at(ms){ns=BigInt(ms)*1000000n;return clock.sample();},wall(value){wall=value;},ns(value){ns=value;}};
}
for(const wall of ['2025-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z'])test('UTC jump does not change deadline: '+wall,async()=>{
  const f=fixture(),start=f.at(0),deadline=f.clock.after(start,65000);f.wall(wall);
  assert.equal(f.clock.remaining(deadline),65001);await f.clock.waitUntil(deadline);
  assert.deepEqual(f.sleeps,[20000,20000,20000,5001]);assert.equal(f.clock.remaining(deadline),0);
});
test('Clock uses real hrtime by default and is JSON serializable',()=>{
  const c=createSseOperatorClock(),a=c.sample(),b=c.sample();assertOperatorSample(JSON.parse(JSON.stringify(a)),c.clockId);assert.ok(b.monoMs>=a.monoMs);
});
test('Sub-millisecond regression is rejected before rounding',()=>{
  const f=fixture();f.ns(999999n);f.clock.sample();f.ns(999998n);assert.throws(()=>f.clock.sample());
});
test('Inaccurate sleep wakeups recheck monotonic deadline',async()=>{
  let ns=0n,calls=0;const c=createSseOperatorClock({readNs:()=>ns,sleep:async()=>{ns+=1000000n;assert.ok(++calls<=4);}});
  await c.waitUntil(c.after(c.sample(),3));assert.equal(calls,4);
});
test('Aborted wait never sleeps',async()=>{
  const f=fixture();await assert.rejects(f.clock.waitUntil(f.clock.after(f.at(0),1000),{signal:AbortSignal.abort()}));assert.deepEqual(f.sleeps,[]);
});
test('Cancellation during sleep interrupts the real timer',async()=>{
  const c=createSseOperatorClock(),ac=new AbortController();const waiting=c.waitUntil(c.after(c.sample(),50000),{signal:ac.signal});ac.abort();await assert.rejects(waiting,{name:'AbortError'});
});
test('Past deadline resolves without sleeping',async()=>{
  const f=fixture(),d=f.clock.after(f.at(0),1);f.at(2);await f.clock.waitUntil(d);assert.deepEqual(f.sleeps,[]);
});
test('Different process epochs cannot be reused after restart',()=>{
  const a=fixture(),b=fixture();assert.throws(()=>b.clock.after(a.at(0),1));assert.throws(()=>b.clock.remaining(a.clock.after(a.at(0),1)));
});
for(const ms of [-1,NaN,Infinity,0.5,600001,Number.MAX_SAFE_INTEGER])test('Refuses invalid deadline duration '+ms,()=>{
  const f=fixture();assert.throws(()=>f.clock.after(f.at(0),ms));
});
for(const [name,mutate] of [
  ['negative offset',s=>s.monoMs=-1],['unsafe offset',s=>s.monoMs=Number.MAX_SAFE_INTEGER+1],
  ['fractional offset',s=>s.monoMs=0.1],['bad epoch',s=>s.clockId='unknown'],['bad UTC',s=>s.wallAt='yesterday'],
  ['noncanonical UTC',s=>s.wallAt='2026-09-08'],['extra field',s=>s.secret='redacted'],
])test('Rejects malformed sample '+name,()=>{const s={...fixture().at(0)};mutate(s);assert.throws(()=>assertOperatorSample(s));});

function timingFixture(){const f=fixture();const timing={started:f.at(0),headers:f.at(1000),cancel:f.at(2000),finished:f.at(2100)};return {f,timing,receipt:f.at(32000)};}
test('Request timing ignores UTC rollback but preserves monotonic order',()=>{
  const {timing,receipt}=timingFixture();timing.started={...timing.started,wallAt:'2030-01-01T00:00:00.000Z'};
  assert.equal(assertSseOperatorTiming(timing,receipt).clientClockOrderingVerified,true);
});
for(const [name,mutate] of [
  ['missing start',x=>delete x.timing.started],['missing cancel',x=>delete x.timing.cancel],
  ['headers before start',x=>x.timing.started={...x.timing.started,monoMs:1500}],
  ['cancel before headers',x=>x.timing.cancel={...x.timing.cancel,monoMs:900}],
  ['finish before cancel',x=>x.timing.finished={...x.timing.finished,monoMs:1900}],
  ['slow cancellation',x=>x.timing.finished={...x.timing.finished,monoMs:12001}],
  ['mixed request epoch',x=>x.timing.headers={...x.timing.headers,clockId:randomUUID()}],
  ['mixed receipt epoch',x=>x.receipt={...x.receipt,clockId:randomUUID()}],
  ['early receipt',x=>x.receipt={...x.receipt,monoMs:30999}],
  ['late receipt',x=>x.receipt={...x.receipt,monoMs:92001}],
])test('Refuses incomplete/invalid timing '+name,()=>{const x=timingFixture();mutate(x);assert.throws(()=>assertSseOperatorTiming(x.timing,x.receipt));});
test('Cleanup keeps 350s after latest headers and 30s after last RPC',()=>{
  const f=fixture(),started=f.at(0),requests=[{timing:{started,headers:f.at(1000)}},{timing:{started,headers:f.at(2000)}}];
  assert.equal(sseOperatorCleanupDeadline({clock:f.clock,requests}).atMs,352001);
  assert.equal(sseOperatorCleanupDeadline({clock:f.clock,requests,lastRpcFinished:f.at(330000)}).atMs,360001);
});
test('Cleanup rejects missing header sample or cross-process recovery completion',()=>{
  const f=fixture(),started=f.at(0),requests=[{timing:{started,headers:f.at(0)}}];
  assert.throws(()=>sseOperatorCleanupDeadline({clock:f.clock,requests,lastRpcFinished:fixture().at(0)}));
  assert.throws(()=>sseOperatorCleanupDeadline({clock:f.clock,requests:[{timing:{}}]}));
});
