import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {setupPeerFinalizerCleanup} from './images-sse-capacity-peer-finalizer-fixture.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createSseHostExpirySession} from '../../../../scripts/deploy/staging-sse-host-expiry-session.mjs';
import {createSseCapacityPeerCoordinator} from '../../../../scripts/deploy/staging-sse-capacity-peer-coordinator.mjs';
import {createSseCapacityPeerFinalizer} from '../../../../scripts/deploy/staging-sse-capacity-peer-finalizer.mjs';
import {PEER_PROFILE,PEER_WATCH_URL} from '../../../../scripts/deploy/staging-sse-capacity-peer-protocol.mjs';
import {SSE_STAGING_SCOPE as g} from '../../../../scripts/deploy/staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';

// Real SQLite financial/cleanup transactions and actual core coordinator. ALL
// platform envelopes, pool counters, API responses and clock offsets are local
// models, never Cloudflare acceptance or actual runtime-eviction evidence.
async function fixture(t,{pending=false,fault}={}) {
  const f=await setupPeerFinalizerCleanup(t,'after-hold',{recover:!pending}),r=f.journal.requests[0],native=f.platform.events[0];
  let ms=0,wall=r.startedAt,watch,seq=0,spent=0,rpcCalls=0,socketStops=0;
  const waits=[],events=[],calls=[],tailId=randomUUID(),foreignTail=randomUUID();let liveTails=[{id:tailId},{id:foreignTail}];
  const tokenId=randomUUID();let tokens=[];
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,wallNow:()=>wall,sleep:async n=>{waits.push(n);ms+=n;}});
  const at=(n,label=wall)=>{ms=n;wall=label;};
  const budget={previousPublicHttp:382,firstRoundUsdCap:2};
  const session=createSseHostExpirySession({clock,baseline:budget,input:{scope:{account:g.account,database:g.database,gateway:g.worker,controller:c.worker},
    version:f.platform.version,runId:f.journal.runId,keyHash:f.journal.keyHash,expiresAt:f.journal.expiresAt,tokenName:'cinatoken-sse-v213-'+randomUUID(),
    plans:[{mode:'after-hold',snapshot:{runId:f.journal.runId,probeId:r.probeId,mode:'after-hold'},upstream:f.journal.probes[0]},
      {mode:'before-hold',snapshot:{runId:f.journal.runId,probeId:randomUUID(),mode:'before-hold'},upstream:{runId:f.journal.runId,probeId:randomUUID(),mode:'success'}}],
    budget:{...budget,capReset:false,maxPublicHttp:32,maxRpc:2}}});
  const reserve=()=>{assert.ok(spent<32);spent++;},pool=randomUUID(),peer=pool+':1';
  const persist=async event=>{
    if(fault==='journal')throw Error('secret-must-not-appear');
    if(fault==='facts-journal'&&event.step==='host-expiry-sse-facts-observed')throw Error('secret-must-not-appear');
    events.push(structuredClone(event));
  };
  // Setup logging uses an independent writer in the journal-failure fixture:
  // the injected failure starts when the outer finalizer takes ownership.
  const co=createSseCapacityPeerCoordinator({session,reserve,persist:async e=>events.push(structuredClone(e)),fetchImpl:async(url,init)=>{
    const headers={'Content-Type':url===PEER_WATCH_URL?'application/x-ndjson':'application/json','Cache-Control':'no-store',
      'x-c02-capacity-instance':pool,'x-c02-capacity-peer':peer};
    const emit=(barrier,requests)=>watch.enqueue(Buffer.from(JSON.stringify({profile:PEER_PROFILE,kind:'sample',instanceId:pool,watchEpoch:1,barrier,
      sequence:++seq,maxRequests:1,maxReservedBytes:1024,requests,reservedBytes:requests*1024})+'\n'));
    if(url===PEER_WATCH_URL)return new Response(new ReadableStream({start(controller){watch=controller;emit(0,0);}}),{headers});
    const stage=init.headers.get('x-c02-capacity-barrier'),barrier=['held','post-native','post-recovery'].indexOf(stage)+1;
    emit(barrier,barrier===1?1:0);return Response.json({profile:PEER_PROFILE,kind:'barrier',instanceId:pool,watchEpoch:1,barrier,stage},{headers});
  }});t.after(()=>co.close());session.preflightComplete();
  const row=key=>({...f.db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get(key)});
  const snapshotRow=row(f.rowKey),cancelRow=row('c02_sse_cancel:'+r.probeId);
  const observation={snapshotRow,snapshot:JSON.parse(snapshotRow.value),upstream:JSON.parse(row('c02_images_sse_probe:'+r.upstreamProbeId).value),jobs:[{state:'pending'}],logs:[]};
  const facts=()=>({observed:f.financial(),probeRows:[row(f.rowKey)],cancelRows:[row('c02_sse_cancel:'+r.probeId)]});
  let bodyEnded=false;
  const start=async(noHeaders=false)=>{
    await co.open({'CF-Access-Client-Id':'local','CF-Access-Client-Secret':'local-secret'});at(1000,r.headersAt);
    if(noHeaders){await assert.rejects(co.dispatch(session.plan.plans[0],async()=>{throw Error('Lost inference ACK');}));return;}
    await co.dispatch(session.plan.plans[0],async()=>new Response(null,{headers:{'Content-Type':'text/event-stream','X-Generation-Id':r.id,'x-c02-capacity-instance':pool}}));
    at(1100);await co.held(observation);at(1200,r.cancelIssuedAt);
  };
  const receive=()=>{
    at(33000,native.receivedAt);
    session.receive(Buffer.from(JSON.stringify({scriptName:g.worker,scriptVersion:{id:f.platform.version},outcome:'ok',eventTimestamp:native.eventTimestamp,
      event:{request:{url:'https://'+g.domain+'/v1/images/generations',method:'POST',headers:{'x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1','x-c02-sse-snapshot':native.probeHeader}},response:{status:200}},
      logs:fault==='missing-native'?[]:native.waitUntilWarnings.map(w=>({level:w.level,message:[w.message],timestamp:w.timestamp})),exceptions:[]})));
  };
  const raw=async()=>{receive();return {observation,cancelRow};};
  const response=expected=>({status:200,body:{status:'finished',runId:randomUUID(),retry_safe:false,result:{scanned:expected,claimed:expected,committed:expected,
    blocked:0,deferred:0,lostOwnership:0,uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false}}});
  const state=new Map([g,c].map(s=>[s.worker,{enabled:true,previews_enabled:false}]));
  const apps=new Map([g,c].map(s=>[s.app,{id:s.app,type:'self_hosted',domain:s.domain,aud:s.audience,destinations:[{type:'public',uri:s.domain}],service_auth_401_redirect:false,
    policies:[{id:s.policy,name:s===g?'CinaToken staging closed':'CinaToken recovery staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}]}]));
  const api=async(path,method='GET',body)=>{
    calls.push({path,method});
    for(const s of [g,c])if(path===`/workers/scripts/${s.worker}/subdomain`){
      if(method==='POST'){
        assert.deepEqual(body,{enabled:false,previews_enabled:false});
        if(fault!=='ingress-stuck')state.set(s.worker,{...body});
        if(fault==='ingress-ack-lost')throw Error('secret-close-ack');
      }
      return {...state.get(s.worker)};
    }
    if(path==='/access/service_tokens')return structuredClone(tokens);
    if(path===`/access/service_tokens/${tokenId}`){
      if(method==='PUT')tokens[0].enabled=false;
      if(method==='DELETE'){assert.ok([...apps.values()].every(a=>a.policies[0].decision==='deny'));tokens=[];}
      return {};
    }
    for(const s of [g,c]){
      const a=apps.get(s.app);
      if(path===`/access/apps/${s.app}`){if(method==='PUT')apps.set(s.app,structuredClone(body));return structuredClone(apps.get(s.app));}
      if(path===`/access/apps/${s.app}/policies/${s.policy}`){assert.equal(method,'PUT');a.policies=[{id:s.policy,...body}];return {};}
    }
    if(path===`/d1/database/${g.database}`)return {uuid:g.database,name:'cinatoken-staging'};
    if(path===`/workers/scripts/${g.worker}/tails`)return structuredClone(liveTails);
    if(path===`/workers/scripts/${g.worker}/tails/${tailId}`){
      assert.equal(method,'DELETE');liveTails=liveTails.filter(t=>t.id!==tailId);
      if(fault==='tail-ack-lost')throw Error('secret-tail-ack');return {};
    }
    assert.fail('Unexpected management target '+path);
  };
  const originalBatch=f.options().batch;
  const batch=async statements=>{
    if(statements.some(s=>/^DELETE/.test(s.sql))) {
      assert.equal(bodyEnded,true);assert.equal(state.get(g.worker).enabled,false);assert.equal(state.get(c.worker).enabled,false);
      assert.ok(ms>=351001);assert.deepEqual(liveTails,[{id:foreignTail}]);
    }
    return originalBatch(statements);
  };
  const owner={runId:session.plan.runId,tokenName:session.plan.tokenName};
  const finalizer=createSseCapacityPeerFinalizer({session,coordinator:co,api,batch,persist,reserve,
    tail:fault==='unknown-tail'?{creation:'attempted'}:{creation:'attempted',id:tailId},stopTail:async()=>{socketStops++;}});
  const options={ownership:owner,awaitPrimary:async()=>{at(Math.max(ms,1300));bodyEnded=true;},readNative:raw,
    runRecovery:async()=>{
      rpcCalls++;assert.equal(state.get(g.worker).enabled,false);assert.equal(state.get(c.worker).enabled,true);
      f.db.hooks.beforeStatement=undefined;
      const now=Math.floor(Date.now()/1000)+60;f.db.sqlite.function('unixepoch',{varargs:true},()=>now);
      const result=await f.recoverOnce();events.push({localRecoveryResult:result});assert.equal(result.committed,1);
      if(fault==='rpc-ack-lost')throw Error('secret-rpc-ack');return response(1);
    }};
  const completeCore=async()=>{
    co.cancelPrimary();at(1300);bodyEnded=true;await co.finishPrimary();receive();
    await co.native({observation,cancelRow});at(34000);
    await co.recover({run:async({expected})=>response(expected),readFacts:facts});
  };
  const addSharedToken=()=>{
    owner.tokenId=tokenId;tokens=[{id:tokenId,name:owner.tokenName,enabled:true}];
    for(const app of apps.values()){app.service_auth_401_redirect=true;app.policies[0].decision='non_identity';app.policies[0].include=[{service_token:{token_id:tokenId}}];}
  };
  return {f,session,co,finalizer,options,start,completeCore,raw,response,state,events,calls,waits,facts,at,addSharedToken,
    get spent(){return spent;},get rpcCalls(){return rpcCalls;},get socketStops(){return socketStops;}};
}

test('actual coordinator success closes dual shared Access token, owned tail and real SQLite fixture in order',async t=>{
  const x=await fixture(t);await x.start();await x.completeCore();x.addSharedToken();
  const first=x.finalizer.finish(x.options);assert.equal(x.finalizer.finish(x.options),first);
  const result=await first;assert.deepEqual(result.errors,[]);assert.equal(result.result,'CLOSED');
  assert.equal(result.experimentResult,'AFTER_HOLD_PEER_EVIDENCE_PASS');assert.equal(result.cleanupPassed,true);assert.equal(result.c02GatePassed,false);
  assert.equal(x.rpcCalls,0);assert.equal(x.spent,7);assert.equal(x.socketStops,1);assert.ok(x.waits.length>0&&x.waits.every(n=>n<=20000));
  assert.deepEqual(x.f.counts(),x.f.baseline);assert.deepEqual(x.f.otherRows(),x.f.unrelated);assert.equal(x.f.sends,1);
});

for(const fault of [undefined,'rpc-ack-lost'])test('failed peer observation uses one original-budget recovery then guarded cleanup: '+fault,async t=>{
  const x=await fixture(t,{pending:true,fault});await x.start();
  const result=await x.finalizer.finish(x.options);
  assert.equal(result.experimentResult,'FAILED_OR_INCOMPLETE');assert.equal(result.cleanupPassed,true,JSON.stringify(result));
  assert.equal(result.result,fault?'ATTENTION_REQUIRED':'CLOSED',JSON.stringify({result,recovery:x.events.filter(e=>e.localRecoveryResult)}));assert.equal(x.rpcCalls,1);assert.equal(x.spent,4);
  assert.equal(x.co.report().journal.requests[0].timing.cancel.monoMs,1200);assert.equal(x.co.report().journal.requests[0].timing.finished.monoMs,1300);
  assert.deepEqual(x.f.counts(),x.f.baseline);assert.deepEqual(x.f.otherRows(),x.f.unrelated);assert.equal(x.f.sends,1);
});

for(const fault of ['missing-native','journal','facts-journal','unknown-tail','tail-ack-lost','ingress-stuck'])test('failed containment/proof preserves financial rows: '+fault,async t=>{
  const x=await fixture(t,{fault});await x.start();const before=x.f.financial();
  const result=await x.finalizer.finish(x.options);
  assert.equal(result.cleanupPassed,false);assert.equal(result.result,'ATTENTION_REQUIRED');assert.equal(x.rpcCalls,0);
  assert.deepEqual(x.f.financial(),before);assert.deepEqual(x.f.otherRows(),x.f.unrelated);
  for(const s of [g,c])assert.ok(x.calls.some(call=>call.path===`/workers/scripts/${s.worker}/subdomain`));
  assert.doesNotMatch(JSON.stringify(result),/secret-/);assert.equal(x.socketStops,1);
});

test('uncertain ingress ACK is confirmed by reads, never a second close write',async t=>{
  const x=await fixture(t,{fault:'ingress-ack-lost'});await x.start();const result=await x.finalizer.finish(x.options);
  assert.equal(result.cleanupPassed,true,JSON.stringify(result));
  for(const s of [g,c])assert.equal(x.calls.filter(call=>call.path===`/workers/scripts/${s.worker}/subdomain`&&call.method==='POST').length,1);
});

for(const pending of [false,true])test('a prior uncertain original-session RPC is not retried: pending='+pending,async t=>{
  const x=await fixture(t,{pending});await x.start();
  assert.equal(x.f.financial()[2][0].state,pending?'pending':'committed');
  await assert.rejects(x.session.rpc(async()=>{throw Error('lost prior RPC');}));
  const before=x.f.financial(),result=await x.finalizer.finish(x.options);
  assert.equal(x.rpcCalls,0);assert.equal(result.recoveryAttempts,0);assert.equal(result.cleanupPassed,!pending,JSON.stringify(result));
  if(pending)assert.deepEqual(x.f.financial(),before);else assert.deepEqual(x.f.counts(),x.f.baseline);
});

test('missing primary headers still closes both ingress and revokes the owned key, but preserves data',async t=>{
  const x=await fixture(t);await x.start(true);const before=x.f.financial();
  const result=await x.finalizer.finish(x.options);
  assert.equal(result.accessClosed,true);assert.equal(result.keyRevoked,true);assert.equal(result.fixtureRemoved,false);
  assert.deepEqual(x.f.financial(),before);assert.equal(x.rpcCalls,0);assert.equal(x.co.report().journal.requests[0].id,undefined);
});

test('foreign ownership does not authorize token or data deletion but fixed ingress closes',async t=>{
  const x=await fixture(t);await x.start();x.options.ownership={runId:'c02-success-'+randomUUID(),tokenName:'cinatoken-sse-v213-'+randomUUID()};
  const result=await x.finalizer.finish(x.options);assert.ok(result.errors.includes('ownership'));
  for(const s of [g,c])assert.equal(x.state.get(s.worker).enabled,false);
  assert.equal(result.fixtureRemoved,false);assert.equal(x.rpcCalls,0);assert.equal(x.calls.some(c=>c.path.startsWith('/access/')&&c.method!=='GET'),false);
});

test('body-finish timeout never fabricates completion and late callback cannot restart recovery',async t=>{
  const x=await fixture(t);await x.start();let reached,resolve;
  const entered=new Promise(r=>reached=r);
  x.options.awaitPrimary=()=>{reached();return new Promise(r=>resolve=r);};
  const work=x.finalizer.finish(x.options);await entered;t.mock.timers.tick(10001);await tick();
  const result=await work;assert.equal(result.fixtureRemoved,false);assert.equal(x.co.report().journal.requests[0].timing.finished,undefined);
  resolve();await tick();assert.equal(x.rpcCalls,0);assert.equal(x.co.report().journal.requests[0].timing.finished,undefined);
});

for(const fault of ['control','snapshot-changed','cancel-changed','budget-exhausted'])test('pending recovery fails closed before RPC: '+fault,async t=>{
  const x=await fixture(t,{pending:true});await x.start();
  if(fault==='control')x.f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run('c02_recovery_claim_delay_v1','{}','local-negative-test');
  if(fault==='snapshot-changed')x.f.db.sqlite.prepare('UPDATE system_config SET value=value||? WHERE key=?').run(' ',x.f.rowKey);
  if(fault==='cancel-changed')x.options.readNative=async()=>{const raw=await x.raw();raw.cancelRow.value+=' ';return raw;};
  if(fault==='budget-exhausted') {
    // Consume only the existing session's RPC authority, never reset it. No
    // network occurs in this local model, and the finalizer cannot refill it.
    await x.session.rpc(async()=>{});await x.session.rpc(async()=>{});
  }
  const before=x.f.financial(),result=await x.finalizer.finish(x.options);
  assert.equal(result.fixtureRemoved,false);assert.equal(x.rpcCalls,0);assert.deepEqual(x.f.financial(),before);
});
