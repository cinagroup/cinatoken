import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SSE_STAGING_SCOPE as g} from './staging-sse-reconciliation.mjs';
import {SSE_RECOVERY_ACCESS_SCOPE as c} from './staging-sse-recovery-access-v2.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';

const copy=v=>structuredClone(v),sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const workers=[g.worker,c.worker,'cinatoken-staging-images-upstream','cinatoken-staging-usage-recovery'];
const production=['cinatoken-proxy','cinatoken-admin','cinatoken-chain-worker'];
const hex=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validate(expected) {
  assert.deepEqual(Object.keys(expected).sort(),['access','previousTokenIds','production','workers']);
  for(const [rows,names] of [[expected.workers,workers],[expected.production,production]]) {
    assert.deepEqual(rows.map(r=>r.name).sort(),names.slice().sort());for(const r of rows)assert.match(r.settingsSha256,hex);
  }
  for(const w of expected.workers){assert.equal(w.versions.length,1);assert.match(w.versions[0].version_id,uuid);assert.equal(w.versions[0].percentage,100);}
  assert.deepEqual(expected.access.map(a=>a.id).sort(),[g.app,c.app].sort());for(const a of expected.access)assert.match(a.sha256,hex);
  assert.ok(Array.isArray(expected.previousTokenIds)&&expected.previousTokenIds.length<=100);for(const id of expected.previousTokenIds)assert.match(id,uuid);
}

/** Operator-side, read-only, fixed targets. api must be the bounded account-scoped
 * transport, whose service-token listing consumes and validates ALL pages.
 * Two matching sweeps are observations, NOT an atomic cloud lock, proof of
 * drained native writes, or authorization to delete. No D1 data read/write here.
 */
export function createByokD1IngressClosure({api,expected,clock=createSseOperatorClock(),timeoutMs=60000,signal,maintenance}) {
  const baseline=copy(expected);validate(baseline);assert.equal(typeof api,'function');
  const prepared=maintenance===undefined?undefined:copy(maintenance);
  if(prepared){assert.deepEqual(Object.keys(prepared).sort(),['runId','tokenId']);assert.match(prepared.runId,/^c02-byok-[a-f0-9]{12}$/);
    assert.match(prepared.tokenId,uuid);assert.ok(!baseline.previousTokenIds.includes(prepared.tokenId));}
  else assert.equal(maintenance,undefined);
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000);
  assert.ok(signal===undefined||signal instanceof AbortSignal);
  let running,finished;
  const report={result:'NOT_RUN',logicalApiReads:0,activeLogicalReads:0,peakLogicalReads:0,completedSweeps:0,
    knownIngressClosed:false,knownProducerIngressClosed:false,maintenanceOnlyConfigured:false,
    allInvocationPathsClosed:false,databaseQuiescenceProved:false,cleanupAuthorized:false};
  async function execute() {
    report.result='RUNNING';const ac=new AbortController(),started=clock.sample(),deadline=clock.after(started,timeoutMs),reads=[];let timer,onAbort;
    const timeout=new Promise((_,reject)=>{onAbort=()=>{ac.abort();reject(Error('closure_interrupted'));};
      signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();timer=setTimeout(onAbort,timeoutMs);});
    let rejectFailed;const failed=new Promise((_,reject)=>{rejectFailed=reject;});
    // A failure before the first GET must not leave an unobserved rejection.
    timeout.catch(()=>{});failed.catch(()=>{});
    let round=0;
    const get=async path=>{
      assert.ok(clock.remaining(deadline)>0);ac.signal.throwIfAborted();report.logicalApiReads++;report.activeLogicalReads++;
      report.peakLogicalReads=Math.max(report.peakLogicalReads,report.activeLogicalReads);
      try{
        const value=await Promise.race([Promise.resolve().then(()=>{ac.signal.throwIfAborted();return api(path,'GET',undefined,{signal:ac.signal});}),timeout,failed]);
        ac.signal.throwIfAborted();assert.ok(clock.remaining(deadline)>0);reads.push({round,path,sha256:sha(value)});return value;
      }finally{report.activeLogicalReads--;}
    };
    async function sweep() {
      const jobs=baseline.workers.map(w=>async()=>{
        const settings=await get(`/workers/scripts/${w.name}/settings`);assert.equal(sha(settings),w.settingsSha256);
        if(prepared&&w.name===c.worker){
          // This exception is only the frozen, no-DB BYOK cleanup controller,
          // never the old experiment controller or an arbitrary open Worker.
          assert.equal(settings.bindings.length,4);
          const plain=settings.bindings.filter(b=>b.type==='plain_text');assert.equal(plain.length,3);
          assert.deepEqual(Object.fromEntries(plain.map(b=>[b.name,b.text])),{BYOK_MAINTENANCE_CONTROL_ENVIRONMENT:'staging',
            BYOK_MAINTENANCE_CONTROL_ENABLED:'true',BYOK_MAINTENANCE_ACCESS_AUD:c.audience});
          const service=settings.bindings.find(b=>b.type==='service');assert.ok(service);assert.equal(service.name,'USAGE_RECOVERY');
          assert.equal(service.service,'cinatoken-staging-usage-recovery');assert.equal(service.entrypoint,'UsageRecovery');
          assert.ok(service.environment==null||service.environment==='production');
          assert.deepEqual(settings.tail_consumers??[],[]);assert.deepEqual(settings.streaming_tail_consumers??[],[]);
        }
        assert.deepEqual((await get(`/workers/scripts/${w.name}/deployments`)).deployments[0].versions,w.versions);
        const s=await get(`/workers/scripts/${w.name}/subdomain`);assert.equal(s.enabled,Boolean(prepared&&w.name===c.worker));assert.equal(s.previews_enabled,false);
        assert.deepEqual(await get('/workers/domains?service='+w.name),[]);
        assert.deepEqual((await get(`/workers/scripts/${w.name}/schedules`)).schedules,[]);
      });
      jobs.push(...baseline.production.map(p=>async()=>{assert.equal(sha(await get(`/workers/scripts/${p.name}/settings`)),p.settingsSha256);}));
      jobs.push(...[g,c].map(t=>async()=>{
        const a=await get('/access/apps/'+t.app);assert.equal(sha(a),baseline.access.find(x=>x.id===t.app).sha256);
        assert.equal(a.id,t.app);assert.equal(a.type,'self_hosted');assert.equal(a.domain,t.domain);assert.equal(a.aud,t.audience);
        assert.deepEqual(a.destinations,[{type:'public',uri:t.domain}]);assert.notEqual(a.service_auth_401_redirect,true);
        assert.equal(a.policies.length,1);const p=a.policies[0];assert.equal(p.id,t.policy);assert.equal(p.precedence,1);
        const allowed=prepared&&t===c;
        assert.equal(p.decision,allowed?'non_identity':'deny');
        assert.deepEqual(p.include,allowed?[{service_token:{token_id:prepared.tokenId}}]:[{everyone:{}}]);assert.deepEqual(p.exclude??[],[]);assert.deepEqual(p.require??[],[]);
      }));
      jobs.push(async()=>{const tokens=await get('/access/service_tokens');assert.ok(Array.isArray(tokens)&&tokens.length<=20000);
        assert.ok(tokens.every(t=>!baseline.previousTokenIds.includes(t.id)));
        if(prepared){const own=tokens.filter(t=>t.id===prepared.tokenId||t.name===prepared.runId+'-access');
          assert.equal(own.length,1);assert.equal(own[0].id,prepared.tokenId);assert.equal(own[0].name,prepared.runId+'-access');}});
      jobs.push(async()=>{assert.deepEqual(await get(`/workers/scripts/${g.worker}/tails`),[]);});
      let cursor=0;
      async function lane(){
        try{while(cursor<jobs.length){ac.signal.throwIfAborted();const job=jobs[cursor++];await job();}}
        catch{ac.abort();rejectFailed(Error('closure_failed'));throw Error('closure_failed');}
      }
      const settled=await Promise.allSettled(Array.from({length:4},lane));
      assert.ok(settled.every(r=>r.status==='fulfilled'));assert.equal(report.activeLogicalReads,0);report.completedSweeps++;
    }
    try {
      const db=await get('/d1/database/'+g.database);assert.equal(db.uuid,g.database);assert.equal(db.name,'cinatoken-staging');
      round=1;await sweep();round=2;await sweep();finished=clock.sample();report.finished=finished;
      report.elapsedMs=finished.monoMs-started.monoMs;
      // Scheduling order is not cloud state. Keep both rounds but canonicalize
      // within-round evidence; the second cannot begin before the first drains.
      reads.sort((a,b)=>a.round-b.round||a.path.localeCompare(b.path));
      report.evidenceSha256=sha({expected:baseline,...(prepared?{maintenance:prepared}:{}),reads});
      report.knownIngressClosed=!prepared;report.knownProducerIngressClosed=true;report.maintenanceOnlyConfigured=Boolean(prepared);
      if(prepared)report.maintenance=copy(prepared);report.result=prepared?'MAINTENANCE_READY':'CLOSED';
    }catch {report.result='FAIL';report.knownIngressClosed=false;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);ac.abort();}
    return copy(report);
  }
  return Object.freeze({run:()=>running??=execute(),report:()=>copy(report),
    assertFreshIngressClosed(){assert.equal(report.result,'CLOSED');assert.ok(clock.remaining(clock.after(finished,5000))>0);return copy(report);},
    assertFreshMaintenanceIngress(){assert.equal(report.result,'MAINTENANCE_READY');assert.ok(clock.remaining(clock.after(finished,5000))>0);return copy(report);},
  });
}

/** Connect the read-only check to the exclusive host journal; no cloud write,
 * credential, automatic second attempt, or database cleanup is introduced. */
export async function journalByokD1IngressClosure({journal,phase,...options}) {
  assert.ok(['before','fresh','after'].includes(phase));const check=createByokD1IngressClosure(options);
  return journal.attempt('closure-'+phase,()=>check.run(),r=>{
    assert.equal(r.result,'CLOSED');return {logicalApiReads:r.logicalApiReads,evidenceSha256:r.evidenceSha256};
  });
}
