import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import WebSocket from 'ws';
import {PEER_DIAGNOSTIC_ENTRY_SHA256,PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE} from './staging-sse-peer-diagnostic-candidate.mjs';
import {imageSseFixture} from './staging-image-sse-fixture.mjs';
import {canonicalSseOperatorRow} from './staging-sse-operator-fixture.mjs';
import {sseSnapshotFaultRow} from '../../packages/proxy/scripts/staging/images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from '../../packages/proxy/scripts/staging/images-sse-cancel-observer.ts';
import {inspectSseAccessResponse} from './staging-sse-access-response.mjs';
import {createSseCapacityPeerDiagnosticCoordinator} from './staging-sse-capacity-peer-diagnostic-coordinator.mjs';
import {createSseCapacityPeerFinalizerV3} from './staging-sse-capacity-peer-finalizer-v3.mjs';
import {createSseCapacityPeerWindowV3} from './staging-sse-capacity-peer-window-v3.mjs';
import {removeUnusedSsePeerFixture} from './staging-sse-capacity-peer-unused-fixture.mjs';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';

const copy=v=>structuredClone(v),cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};
const financial=['request_dispatch_intents','request_usage_settlements','request_usage_recovery_jobs','request_usage_commit_receipts','api_key_request_logs','user_budget_reservations'];

/** One-shot resource setup -> actual window -> same finalizer. Requires the
 * already closed candidate deployment and the SAME session/transport/preflight.
 * Does not deploy or infer a new budget; no I/O at construction/import time.
 */
export function createSsePeerDiagnosticRun({session,transport,preflight,expected,baselineCounts,key,persist,fetchImpl=fetch,Socket=WebSocket,peerSocketFactory,onWait}) {
  const {clock}=session,baseline=copy(baselineCounts),reference=copy(expected),api=transport.api;
  let running,fixture,seed,seedFinished,seedAcknowledged=false,token,socket,tailClosing=false,tailQueue=Promise.resolve(),tailQueued=0,tailJournalFailed=false;
  let window,finalizer,finalization,stopped=false;
  const report={result:'NOT_RUN',publicHttp:0,primarySends:0,seedAcknowledged:false,c02GatePassed:false,isolateEvictionProven:false,errors:[]};
  const reserve=()=>{assert.ok(!stopped&&report.publicHttp<session.plan.budget.maxPublicHttp);report.publicHttp++;};
  const bound=async(work,ms,signal)=>{
    const ac=new AbortController(),deadline=clock.after(clock.sample(),ms);let timer,onAbort;
    try{return await Promise.race([Promise.resolve().then(async()=>{ac.signal.throwIfAborted();const value=await work(ac.signal);ac.signal.throwIfAborted();assert.ok(clock.remaining(deadline)>0);return value;}),
      new Promise((_,reject)=>{onAbort=()=>{ac.abort();reject(Error('peer_run_aborted'));};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
        timer=setTimeout(()=>{ac.abort();reject(Error('peer_run_timeout'));},clock.remaining(deadline));})]);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();}
  };
  const save=e=>bound(signal=>persist(copy(e),{signal}),5000);
  const batch=(s,options={})=>transport.batch(s,options);
  const coordinator=createSseCapacityPeerDiagnosticCoordinator({session,reserve,persist:save,socketFactory:peerSocketFactory});
  const identity=(auth='valid')=>auth==='none'?{}:{'CF-Access-Client-Id':token.client_id,'CF-Access-Client-Secret':auth==='invalid'?'invalid':token.client_secret};
  async function startTail(){
    const created=await api(`/workers/scripts/${g.worker}/tails`,'POST',{filters:[{header:{key:'x-c02-sse-host-expiry'}}]});
    const url=new URL(created.url);assert.equal(url.protocol,'wss:');assert.equal(url.username+url.password+url.hash,'');
    assert.ok(created.url.length<=4096);
    await bound(signal=>new Promise((resolve,reject)=>{
      socket=new Socket(created.url,'trace-v1',{maxPayload:131072,handshakeTimeout:15000});
      const fail=()=>{session.transportError();socket.terminate();reject(Error('tail_transport'));};
      signal.addEventListener('abort',()=>{if(!report.tailConnected)fail();},{once:true});
      socket.on('error',fail);socket.on('close',()=>{if(!tailClosing){session.transportClose();reject(Error('tail_closed'));}});
      socket.on('message',data=>{
        if(tailClosing)return;
        try{
          const capture=session.receive(data);assert.equal(capture.firstFailure,null);assert.ok(++tailQueued<=8);
          tailQueue=tailQueue.then(()=>save({step:'peer-tail',capture})).catch(()=>{tailJournalFailed=true;session.transportError();socket.terminate();}).finally(()=>{tailQueued--;});
        }catch{fail();}
      });
      socket.once('open',()=>{try{if(signal.aborted){fail();return;}socket.send(JSON.stringify({debug:false}));report.tailConnected=true;resolve();}catch{fail();}});
    }),15000);
    await save({step:'peer-tail-ready',id:transport.ownership().tail.id});
  }
  const stopTail=async()=>{tailClosing=true;socket?.terminate();await tailQueue;if(tailJournalFailed)throw Error('tail_journal_failed');};
  function ownFinalizer(){
    if(!finalizer)finalizer=createSseCapacityPeerFinalizerV3({session,coordinator,api,batch:(s,options={})=>batch(s,{...options,write:!s.every(q=>q.sql.startsWith('SELECT '))}),persist:save,reserve,
      tail:transport.ownership().tail,stopTail});
    return {finish(options){transport.beginCleanup();return finalizer.finish(options).then(value=>{finalization=value;return value;});}};
  }
  async function authProbe(target,auth){
    reserve();const row={step:'peer-auth',target:target.worker,auth,started:clock.sample(),result:'PENDING'};await save(row);
    let response;
    try{return await bound(async signal=>{
      response=await fetchImpl('https://'+target.domain+(target===g?'/__staging/sse-capacity':'/_control/usage-recovery/run'),{
        method:target===g?'GET':'POST',headers:identity(auth),redirect:'manual',cache:'no-store',signal});
      if(signal.aborted){cancel(response.body);signal.throwIfAborted();}
      const inspected=await inspectSseAccessResponse(response,{target:target===g?'gateway':'controller',auth,signal});
      await save({...row,result:'ACK',...inspected});return inspected;
    },15000);}finally{cancel(response?.body);}
  }
  async function readObservation({plan,id,signal}){
    const rows=await batch([
      {sql:'SELECT key,value,description FROM system_config WHERE key IN (?,?) ORDER BY key LIMIT 3',params:['c02_sse_snapshot:'+plan.snapshot.probeId,'c02_images_sse_probe:'+plan.upstream.probeId]},
      {sql:'SELECT state FROM request_usage_recovery_jobs WHERE request_id=? LIMIT 2',params:[id]},
      {sql:'SELECT id,status,charged_cost,budget_charged_micros,upstream_attempt_count FROM api_key_request_logs WHERE id=? LIMIT 2',params:[id]},
    ],{signal});assert.equal(rows[0].length,2);
    const snapshotRow=rows[0].find(r=>r.key==='c02_sse_snapshot:'+plan.snapshot.probeId),upstream=rows[0].find(r=>r.key==='c02_images_sse_probe:'+plan.upstream.probeId);
    return {snapshotRow,snapshot:JSON.parse(snapshotRow.value),upstream:JSON.parse(upstream.value),jobs:rows[1],logs:rows[2]};
  }
  async function readCancel({plan,signal}){
    const rows=await batch([{sql:'SELECT key,value,description FROM system_config WHERE key=? AND description=? LIMIT 2',params:['c02_sse_cancel:'+plan.snapshot.probeId,'c02-cancel:'+session.plan.runId]}],{signal});
    assert.equal(rows[0].length,1);return rows[0][0];
  }
  async function readFacts(){
    const rows=await batch([...financial.map(t=>({sql:`SELECT * FROM ${t} ORDER BY ${t==='api_key_request_logs'?'id':'request_id'} LIMIT 3`,params:[]})),
      {sql:'SELECT key,value,description FROM system_config WHERE description=? ORDER BY key LIMIT 3',params:['c02-snapshot:'+session.plan.runId]},
      {sql:'SELECT key,value,description FROM system_config WHERE description=? ORDER BY key LIMIT 3',params:['c02-cancel:'+session.plan.runId]},
    ]);return {observed:rows.slice(0,6),probeRows:rows[6],cancelRows:rows[7]};
  }
  async function runRecovery({signal,expected}){
    const rows=await batch([
      {sql:'SELECT * FROM request_usage_recovery_jobs ORDER BY request_id LIMIT 3',params:[]},
      {sql:'SELECT key FROM system_config WHERE key IN (?,?) LIMIT 3',params:['c02_recovery_claim_delay_v1','c02_recovery_fencing_control_v1']},
    ],{signal});assert.equal(rows[0].length,1);assert.deepEqual(rows[1],[]);const job=rows[0][0];
    assert.equal(job.request_id,coordinator.report().journal.requests[0].id);assert.equal(job.user_id,fixture.ids.user);assert.equal(job.api_key_id,fixture.ids.key);assert.equal(job.workspace_id,fixture.ids.workspace);
    assert.equal(job.state,expected===1?'pending':'committed');let response,reader;
    try{return await bound(async inner=>{
      response=await fetchImpl('https://'+c.domain+'/_control/usage-recovery/run',{method:'POST',headers:{...identity(),'X-CinaToken-Recovery-Command':'run-once-v1'},redirect:'manual',cache:'no-store',signal:inner});
      if(inner.aborted){cancel(response.body);inner.throwIfAborted();}assert.equal(response.status,200);assert.ok(response.body);reader=response.body.getReader();
      inner.addEventListener('abort',()=>cancel(reader),{once:true});const parts=[];let size=0;
      for(;;){const next=await reader.read();inner.throwIfAborted();if(next.done)break;size+=next.value.byteLength;assert.ok(size<=8192);parts.push(Buffer.from(next.value));}
      return {status:response.status,body:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,size)))};
    },30000,signal);}finally{cancel(reader??response?.body);}
  }
  async function execute(){
    report.result='RUNNING';
    try{
      assert.equal('sha256:'+createHash('sha256').update(key).digest('hex'),session.plan.keyHash);assert.equal(session.requests.length,0);
      assert.deepEqual(reference.workers.map(w=>w.name).sort(),[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'].sort());
      assert.deepEqual(reference.production.map(w=>w.name).sort(),['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'].sort());
      assert.deepEqual(reference.workers.find(w=>w.name===g.worker).versions,[{version_id:session.plan.version,percentage:100}]);
      fixture=await imageSseFixture(session.plan.runId,session.plan.keyHash,session.plan.expiresAt);
      assert.equal(session.plan.budget.previousPublicHttp,PEER_DIAGNOSTIC_PUBLIC_HTTP_BASELINE);
      const checked=await preflight.run();assert.equal(checked.result,'PASS');
      assert.equal(checked.contentSha256,PEER_DIAGNOSTIC_ENTRY_SHA256,'Fresh preflight must attest the fixed V3 executable');
      await startTail();token=await api('/access/service_tokens','POST',{name:session.plan.tokenName,duration:'1h'});
      for(const value of [token.client_id,token.client_secret])assert.ok(typeof value==='string'&&value.length>0&&value.length<=4096);
      for(const t of [g,c]){
        const app=checked.originalApps.find(a=>a.id===t.app);assert.ok(app);
        await api(`/access/apps/${t.app}/policies/${t.policy}`,'PUT',{...app.policies[0],decision:'non_identity',include:[{service_token:{token_id:token.id}}]});
        const current=await api('/access/apps/'+t.app);await api('/access/apps/'+t.app,'PUT',{...current,service_auth_401_redirect:true});
        const armed=await api('/access/apps/'+t.app);assert.equal(armed.service_auth_401_redirect,true);assert.equal(armed.policies[0].decision,'non_identity');
        assert.deepEqual(armed.policies[0].include,[{service_token:{token_id:token.id}}]);
        await api(`/workers/scripts/${t.worker}/subdomain`,'POST',{enabled:true,previews_enabled:false});
      }
      for(const t of [g,c])for(const auth of ['none','invalid','valid']){
        let verdict;
        for(let n=0;n<3;n++){if(n)await clock.waitUntil(clock.after(clock.sample(),5000));verdict=(await authProbe(t,auth)).verdict;if(verdict==='PASS')break;assert.equal(verdict,'RETRY');}
        assert.equal(verdict,'PASS');
      }
      const plan=session.plan.plans.find(p=>p.mode==='after-hold');
      seed=[...fixture.seed,...[sseSnapshotFaultRow(plan.snapshot),canonicalSseOperatorRow(plan.upstream),sseCancelObservationRow(plan.snapshot)]
        .map(r=>({sql:'INSERT INTO system_config (key,value,description) VALUES (?,?,?)',params:[r.key,r.value,r.description]}))];
      await save({step:'peer-seed',result:'PENDING'});await batch(seed,{write:true});seedFinished=clock.sample();seedAcknowledged=true;report.seedAcknowledged=true;
      await save({step:'peer-seed',result:'ACK',finished:seedFinished});
      window=createSseCapacityPeerWindowV3({session,coordinator,finalizer:ownFinalizer(),fixture,key,ownership:transport.ownership(),accessHeaders:identity(),
        fetchImpl,readObservation,readCancel,readFacts,runRecovery,persist:save,onWait});
      report.window=await window.run();report.primarySends=report.window.primarySends;report.result=report.window.result;
    }catch{report.result='FAILED';report.errors.push('setup-or-window');}
    finally{
      coordinator.close();
      if(transport.report().cloudMutationAttempted&&!finalization){
        try{await ownFinalizer().finish({ownership:transport.ownership(),awaitPrimary:async()=>{throw Error('No window-owned body');},readNative:async()=>{throw Error('No native request proof');},runRecovery,onWait});}
        catch{report.errors.push('finalizer');}
      }
      report.primarySends=window?.report().primarySends??0;
      if(seedAcknowledged&&report.primarySends===0&&finalization){
        try{report.unusedFixture=await removeUnusedSsePeerFixture({session,fixture,seed,seedAcknowledged,seedFinished,primarySends:0,finalization,
          baselineCounts:baseline,batch:s=>batch(s,{write:!s.every(q=>q.sql.startsWith('SELECT '))}),persist:save,onWait});}
        catch{report.errors.push('unused-fixture');}
      }
      if(transport.report().cloudMutationAttempted){
        try{await bound(async signal=>{
          const get=path=>api(path,'GET',undefined,{signal}),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
          for(const w of reference.workers){
            signal.throwIfAborted();assert.equal(hash(await get(`/workers/scripts/${w.name}/settings`)),w.settingsSha256);
            assert.deepEqual((await get(`/workers/scripts/${w.name}/deployments`)).deployments[0].versions,w.versions);
            const ingress=await get(`/workers/scripts/${w.name}/subdomain`);assert.equal(ingress.enabled,false);assert.equal(ingress.previews_enabled,false);
            assert.deepEqual(await get('/workers/domains?service='+w.name),[]);assert.deepEqual((await get(`/workers/scripts/${w.name}/schedules`)).schedules,[]);
          }
          for(const p of reference.production){signal.throwIfAborted();assert.equal(hash(await get(`/workers/scripts/${p.name}/settings`)),p.settingsSha256);}
          report.finalIsolationVerified=true;await save({step:'peer-final-isolation',result:'PASS'});
        },60000);}catch{report.finalIsolationVerified=false;report.errors.push('final-isolation');report.result='ATTENTION_REQUIRED';}
      }
      stopped=true;report.finalization=finalization;report.coordinator=coordinator.report();report.management=transport.report();
      report.cumulativePublicHttp=session.plan.budget.previousPublicHttp+report.publicHttp;
      if(transport.report().cloudMutationAttempted&&!finalization?.cleanupPassed&&!report.unusedFixture?.fixtureRemoved)report.result='ATTENTION_REQUIRED';
      try{await save({step:'peer-run-complete',...report});}catch{report.result='ATTENTION_REQUIRED';report.errors.push('final-journal');}
      token=undefined;
    }
    return copy(report);
  }
  return Object.freeze({run(){return running??=execute();},report:()=>copy({...report,coordinator:coordinator.report(),cumulativePublicHttp:session.plan.budget.previousPublicHttp+report.publicHttp})});
}
