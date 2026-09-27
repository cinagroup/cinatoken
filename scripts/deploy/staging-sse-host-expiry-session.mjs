import assert from 'node:assert/strict';
import {validateSseOperatorPlan} from './staging-sse-operator-plan.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';
import {createSseHostExpiryTailCollector} from './staging-sse-host-expiry-tail-collector.mjs';

/** Live operator glue. Import has no I/O; construct before any cloud request. The same object
 * captures real callbacks and supplies the clock later consumed by the financial oracle.
 */
export function createSseHostExpirySession({input,baseline,clock=createSseOperatorClock()}){
  const plan=validateSseOperatorPlan(input,baseline),requests=[],receipts=[];
  const collector=createSseHostExpiryTailCollector({version:plan.version,
    probeHeaders:plan.plans.map(p=>`c02-snapshot:${plan.runId}:${p.snapshot.probeId}:${p.mode}`)});
  const own=new Set();let preflightFinished,writesStarted=false,lastRpcFinished,rpcCount=0;
  function preflightComplete(){assert.equal(writesStarted,false);preflightFinished=clock.sample();return preflightFinished;}
  function assertWriteReady(){
    assert.ok(preflightFinished,'Fresh read-only preflight not completed');
    if(!writesStarted){assert.ok(clock.remaining(clock.after(preflightFinished,60000))>0,'Preflight expired before first write');writesStarted=true;}
  }
  function beginRequest(p){
    assertWriteReady();assert.ok(plan.plans.includes(p),'Unvalidated plan reference');
    assert.ok(!requests.some(r=>r.mode===p.mode),'Never replay an uncertain inference');
    const started=clock.sample();const e={kind:'inference',mode:p.mode,probeId:p.snapshot.probeId,upstreamProbeId:p.upstream.probeId,
      startedAt:started.wallAt,timing:{started}};requests.push(e);own.add(e);return e;
  }
  function markHeaders(e,response){
    assert.ok(own.has(e)&&!e.timing.headers);const headers=clock.sample();
    e.status=response.status;e.id=response.headers.get('X-Generation-Id');e.headersAt=headers.wallAt;e.timing.headers=headers;
    assert.equal(e.status,200);assert.match(e.id,/^gen-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.match(response.headers.get('Content-Type'),/text\/event-stream/);
  }
  function cancelRequest(e,abort){
    assert.ok(own.has(e)&&e.timing.headers&&!e.timing.cancel&&!e.timing.finished);
    const cancel=clock.sample();e.timing.cancel=cancel;e.cancelIssuedAt=cancel.wallAt;abort();
  }
  function finishRequest(e){
    assert.ok(own.has(e));if(!e.timing.finished){const finished=clock.sample();e.timing.finished=finished;e.finishedAt=finished.wallAt;}
    return e.timing.finished;
  }
  function receive(data){
    const sample=clock.sample(),state=collector.receive(data,sample.wallAt);
    if(!state.firstFailure)for(const event of state.events){
      if(!receipts.some(r=>r.probeHeader===event.probeHeader))receipts.push({probeHeader:event.probeHeader,sample});
    }
    return capture();
  }
  function capture(){return {...collector.snapshot(),receipts:structuredClone(receipts)};}
  function platform(){const state=capture();assert.equal(state.firstFailure,null,'Native collector failed');
    return {version:plan.version,events:state.events,receipts:state.receipts};}
  function abortScope(ms){
    const started=clock.sample(),deadline=clock.after(started,ms),controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),clock.remaining(deadline));
    return {started,deadline,signal:controller.signal,abort:()=>controller.abort(),dispose:()=>clearTimeout(timer)};
  }
  async function rpc(run){
    assert.ok(++rpcCount<=plan.budget.maxRpc,'Recovery RPC budget exhausted; uncertain calls consume budget');
    const scope=abortScope(30000);
    try{return await run(scope.signal,scope.started);}
    finally{try{lastRpcFinished=clock.sample();}finally{scope.dispose();}}
  }
  return Object.freeze({plan,clock,requests,preflightComplete,assertWriteReady,beginRequest,markHeaders,cancelRequest,finishRequest,receive,capture,platform,abortScope,rpc,
    get lastRpcFinished(){return lastRpcFinished;},
    transportError:()=>collector.transportError(clock.sample().wallAt),transportClose:()=>collector.transportClose(clock.sample().wallAt)});
}
