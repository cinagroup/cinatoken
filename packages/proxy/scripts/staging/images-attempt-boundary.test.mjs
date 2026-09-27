import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchOpenAiImageGenerations,dispatchOpenAiImageEdits } from '../../src/services/egress/openai-images-driver.ts';
import { RequestTimingCollector } from '../../src/services/request-timing.ts';

const image={prompt:'synthetic',n:1,images:[{filename:'tiny.png',mimeType:'image/png',bytes:new Uint8Array([1,2,3])}]};
for(const operation of ['generations','edits'])for(const phase of ['transport-error','deadline','pre-dispatch','admission-error','explicit-400','accepted-body-error']) {
  test(`${operation}: attempt fact boundary ${phase}`,{timeout:5000},async t=>{
    t.mock.method(globalThis,'fetch',async()=>{throw Error('External network forbidden');});
    for(const method of ['log','warn','error'])t.mock.method(console,method,()=>{});
    t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
    const route={targetId:'synthetic-target',modelSurfaceId:null,routePoolId:null,providerId:'synthetic-provider',providerName:'Synthetic',
      providerModelName:'synthetic-image',upstreamProtocol:'openai',upstreamOperation:'images.'+operation,adapter:'passthrough',
      providerEndpoints:{openai:{base:'https://upstream.example.invalid/v1'}},providerApiKey:'synthetic-key',providerSharedChannelType:null,
      priceOverrideRaw:null,routeMeteredProfileJson:null,routeChargedProfileJson:null,customParams:null,routeGroup:'default',routePriority:1,routeWeight:1};
    const timing=new RequestTimingCollector(),attempt=timing.startAttempt(route),controller=new AbortController();
    let entered;const ready=new Promise(resolve=>entered=resolve);let sends=0;
    const config={deadlineAtMs:Date.now()+1000,fetchImpl:async()=>{
      sends++;entered();
      if(phase==='deadline')return new Promise(()=>{});
      if(phase==='transport-error')throw Error('Synthetic transport failure');
      return new Response(new ReadableStream({pull(c){c.error(Error('Synthetic body interruption'));}},{highWaterMark:0}),
        {status:phase==='explicit-400'?400:200});
    }};
    if(phase==='pre-dispatch')controller.abort();
    const admission=async()=>{if(phase==='admission-error')throw Error('Synthetic admission failure');};
    const pending=operation==='generations'?dispatchOpenAiImageGenerations(route,image,controller.signal,timing,attempt,config,admission)
      :dispatchOpenAiImageEdits(route,image,controller.signal,timing,attempt,config,admission);
    if(phase==='admission-error') {
      await assert.rejects(pending,/Synthetic admission failure/);assert.equal(sends,0);assert.deepEqual(timing.snapshot().providerAttempts,[]);return;
    }
    if(phase==='deadline'){await ready;t.mock.timers.tick(1000);}
    const result=await pending;await result.response.body?.cancel();await result.usagePromise;
    const facts=timing.snapshot().providerAttempts;
    if(phase==='pre-dispatch') {
      assert.equal(sends,0);assert.deepEqual(facts,[]);assert.notEqual(result.meta.upstreamOutcomeUnknown,true);return;
    }
    assert.equal(sends,1);assert.equal(facts.length,1);assert.equal(facts[0].attemptIndex,1);
    assert.equal(facts[0].providerId,route.providerId);assert.equal(facts[0].routeTargetId,route.targetId);
    if(phase==='explicit-400') {
      assert.equal(result.response.status,400);assert.equal(facts[0].httpStatus,400);assert.equal(facts[0].reason,'client_error');
      assert.notEqual(result.meta.upstreamOutcomeUnknown,true);
    } else {
      assert.equal(result.response.status,phase==='deadline'?504:502);
      assert.equal(result.meta.upstreamOutcomeUnknown,true);assert.equal(result.meta.failoverForbidden,true);
      assert.equal(facts[0].httpStatus,phase==='accepted-body-error'?200:null);
      if(phase!=='accepted-body-error'){assert.equal(facts[0].reason,'network_error');assert.equal(facts[0].outcome,'unavailable');}
    }
  });
}
