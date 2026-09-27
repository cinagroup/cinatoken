import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hrtime} from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function assertOperatorSample(sample,clockId){
  assert.ok(sample&&typeof sample==='object');
  assert.deepEqual(Object.keys(sample).sort(),['clockId','monoMs','wallAt']);
  assert.match(sample.clockId,uuid);if(clockId!==undefined)assert.equal(sample.clockId,clockId,'Different operator clock epoch');
  assert.ok(integer(sample.monoMs));assert.equal(typeof sample.wallAt,'string');
  assert.equal(new Date(sample.wallAt).toISOString(),sample.wallAt);
  return sample.monoMs;
}

/** Node operator only. Never compare these offsets between process instances or to UTC.
 * wallAt is an audit label, not a deadline. Injected sources are for deterministic local tests.
 */
export function createSseOperatorClock({readNs=()=>hrtime.bigint(),wallNow=()=>new Date().toISOString(),sleep=delay}={}){
  const clockId=randomUUID(),origin=readNs();assert.equal(typeof origin,'bigint');assert.ok(origin>=0n);
  let previous=origin;
  const sample=()=>{
    const current=readNs();assert.equal(typeof current,'bigint');assert.ok(current>=previous,'Monotonic source moved backward');
    previous=current;const value={clockId,monoMs:Number((current-origin)/1000000n),wallAt:wallNow()};
    assertOperatorSample(value,clockId);return Object.freeze(value);
  };
  const after=(start,ms)=>{
    assertOperatorSample(start,clockId);assert.ok(integer(ms)&&ms<=600000,'Operator deadline exceeds ten-minute bound');
    // Samples floor nanoseconds to milliseconds. Add 1ms so rounding cannot shorten a safety wait.
    const atMs=start.monoMs+ms+1;assert.ok(integer(atMs));return Object.freeze({clockId,atMs});
  };
  const remaining=deadline=>{
    assert.deepEqual(Object.keys(deadline).sort(),['atMs','clockId']);assert.equal(deadline.clockId,clockId);
    assert.ok(integer(deadline.atMs));return Math.max(0,deadline.atMs-sample().monoMs);
  };
  const waitUntil=async(deadline,{signal,onWait=()=>{}}={})=>{
    // Each sleep is bounded; no UTC comparisons or retry of external work.
    for(;;){signal?.throwIfAborted();const left=remaining(deadline);if(!left)return sample();
      onWait(left);await sleep(Math.min(20000,left),undefined,{signal});}
  };
  return Object.freeze({clockId,sample,after,remaining,waitUntil});
}

/** All markers must be captured by the same live process; missing history cannot be fabricated. */
export function assertSseOperatorTiming(timing,receipt){
  assert.deepEqual(Object.keys(timing).sort(),['cancel','finished','headers','started']);
  const clockId=timing.started.clockId;
  const [started,headers,cancel,finished]=['started','headers','cancel','finished'].map(k=>assertOperatorSample(timing[k],clockId));
  const received=assertOperatorSample(receipt,clockId);
  assert.ok(started<=headers&&headers<=cancel&&cancel<=finished,'Invalid monotonic request order');
  assert.ok(cancel-started<=90000&&finished-cancel<=10000,'Request cancellation exceeded bound');
  assert.ok(received>=cancel+29000&&received<=cancel+90000,'Tail receipt outside cancellation window');
  assert.ok(received>=finished,'Tail receipt precedes completed client abort');
  return {clockId,clientClockOrderingVerified:true};
}

export function sseOperatorCleanupDeadline({clock,requests,lastRpcFinished}){
  assert.ok(Array.isArray(requests)&&requests.length>0&&requests.length<=2);
  // The original safety margin is preserved, not shortened to the 30s native waitUntil limit.
  const deadlines=requests.flatMap(r=>[
    clock.after(r.timing.started,350000),clock.after(r.timing.headers,350000),
    ...(r.timing.finished?[clock.after(r.timing.finished,30000)]:[]),
  ]);
  if(lastRpcFinished!==undefined)deadlines.push(clock.after(lastRpcFinished,30000));
  return Object.freeze({clockId:clock.clockId,atMs:Math.max(...deadlines.map(d=>d.atMs))});
}
