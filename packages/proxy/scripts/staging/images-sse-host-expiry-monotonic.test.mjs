import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setupExpiryCleanup} from './images-sse-host-expiry-cleanup-fixture.mjs';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as control} from '../../../../scripts/deploy/staging-sse-recovery-access-v2.mjs';
import {reconcileHostExpirySseStagingRun} from '../../../../scripts/deploy/staging-sse-host-expiry-reconciliation-v3.mjs';

// ALL timing/tail samples below are synthetic local contract fixtures, not native Workers proof.
async function fixture(t,mode,recover){
  const f=await setupExpiryCleanup(t,mode,{recover}),o=f.options();
  let ns=0n,wall='2026-09-08T00:00:00.000Z';
  const clock=createSseOperatorClock({readNs:()=>ns,wallNow:()=>wall});
  const sample=(ms,at)=>{ns=BigInt(ms)*1000000n;wall=at;return clock.sample();};
  const r=f.journal.requests[0];r.responseStatus=200;r.finishedAt=r.cancelIssuedAt;
  r.startedAt='2030-01-01T00:00:00.000Z'; // Intentional local UTC rollback only.
  r.timing={started:sample(0,r.startedAt),headers:sample(100,r.headersAt),cancel:sample(200,r.cancelIssuedAt),finished:sample(300,r.finishedAt)};
  const tail=f.platform.events[0];tail.outcome='canceled';tail.responseStatus=null;
  f.platform.receipts=[{probeHeader:tail.probeHeader,sample:sample(31200,tail.receivedAt)}];
  const lastRpcFinished=sample(330000,'2025-01-01T00:00:00.000Z');
  sample(400000,'2024-01-01T00:00:00.000Z');
  const gatewayApi=o.api;
  o.api=async(path,method)=>{
    if(path===`/workers/scripts/${control.worker}/subdomain`){assert.ok(!method||method==='GET');return {enabled:false,previews_enabled:false};}
    if(path===`/access/apps/${control.app}`){assert.ok(!method||method==='GET');return {
      id:control.app,type:'self_hosted',domain:control.domain,aud:control.audience,destinations:[{type:'public',uri:control.domain}],
      policies:[{id:control.policy,name:'CinaToken recovery staging closed',precedence:1,decision:'deny',include:[{everyone:{}}],exclude:[],require:[]}],
    };}
    return gatewayApi(path,method);
  };
  delete o.nowMs;Object.assign(o,{clock,lastRpcFinished});
  return {f,o,r,clock,sample};
}

for(const mode of ['before-hold','after-hold'])for(const fault of [
  'none','missing-timing','missing-receipts','different-epoch','wrong-label','wrong-receipt-label',
  'early-receipt','late-receipt','duplicate-receipt','unrelated-receipt','cleanup-too-early',
  'rpc-too-recent','missing-warning','wrong-version','changed-held','pending-job','save-fail',
])test(`Monotonic cleanup ${mode} / ${fault}`,{timeout:10000},async t=>{
  const {f,o,r}=await fixture(t,mode,fault!=='pending-job');
  if(fault==='missing-timing')delete r.timing;
  if(fault==='missing-receipts')delete f.platform.receipts;
  if(fault==='different-epoch')r.timing.headers={...r.timing.headers,clockId:randomUUID()};
  if(fault==='wrong-label')r.headersAt='2020-01-01T00:00:00.000Z';
  if(fault==='wrong-receipt-label')f.platform.events[0].receivedAt='2020-01-01T00:00:00.000Z';
  if(fault==='early-receipt')f.platform.receipts[0].sample={...f.platform.receipts[0].sample,monoMs:29199};
  if(fault==='late-receipt')f.platform.receipts[0].sample={...f.platform.receipts[0].sample,monoMs:90201};
  if(fault==='duplicate-receipt')f.platform.receipts.push(structuredClone(f.platform.receipts[0]));
  if(fault==='unrelated-receipt')f.platform.receipts[0].probeHeader='unrelated';
  if(fault==='cleanup-too-early')r.timing.headers={...r.timing.headers,monoMs:100000};
  if(fault==='rpc-too-recent')o.lastRpcFinished={...o.lastRpcFinished,monoMs:399000};
  if(fault==='missing-warning')f.platform.events[0].waitUntilWarnings=[];
  if(fault==='wrong-version')f.platform.version=randomUUID();
  if(fault==='changed-held')f.db.sqlite.prepare('UPDATE system_config SET value=value||? WHERE key=?').run(' ',f.rowKey);
  if(fault==='save-fail')o.persist=async()=>{throw Error('Synthetic disk full');};
  if(fault==='none'||fault==='pending-job'&&mode==='before-hold'){
    const result=await reconcileHostExpirySseStagingRun(o);assert.equal(result.fixtureRemoved,true);assert.equal(result.experimentPassed,true);
    assert.equal(result.platformCancelled,1);assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);assert.equal(f.sends,1);
    const proof=f.saved.find(e=>e.step==='host-expiry-sse-facts-observed');assert.equal(proof.operatorCleanupTiming.notBefore.atMs,360001);
    assert.equal(proof.operatorCleanupTiming.observedNow.clockId,o.clock.clockId);
    assert.equal((await reconcileHostExpirySseStagingRun(o)).alreadyRemoved,true);
  }else{
    const before=f.financial();await assert.rejects(reconcileHostExpirySseStagingRun(o));assert.deepEqual(f.financial(),before);assert.deepEqual(f.otherRows(),f.unrelated);
  }
});
