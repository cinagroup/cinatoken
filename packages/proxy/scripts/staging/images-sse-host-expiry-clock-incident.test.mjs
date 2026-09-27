import assert from 'node:assert/strict';
import test from 'node:test';
import {setupExpiryCleanup} from './images-sse-host-expiry-cleanup-fixture.mjs';
import {reconcileHostExpirySseStagingRun} from '../../../../scripts/deploy/staging-sse-host-expiry-clock-incident-reconciliation.mjs';

for(const mode of ['before-hold','after-hold'])for(const fault of ['none','missing-warning','wrong-version','wrong-cancel','changed-held','pending-job','too-early-warning','unrelated-invocation','save-fail'])
test('native-clock incident reconciliation '+mode+' / '+fault,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,mode,{recover:fault!=='pending-job'}),o=f.options(),r=f.journal.requests[0];
  r.responseStatus=200;r.startedAt=new Date(Date.parse(r.headersAt)+2000).toISOString(); // Modeled local clock rollback.
  f.platform.events[0].outcome='canceled';f.platform.events[0].responseStatus=null;
  if(fault==='missing-warning')f.platform.events[0].waitUntilWarnings=[];
  if(fault==='wrong-version')f.platform.version='00000000-0000-0000-0000-000000000000';
  if(fault==='wrong-cancel')f.db.sqlite.prepare('DELETE FROM system_config WHERE key=?').run('c02_sse_cancel:'+r.probeId);
  if(fault==='changed-held')f.db.sqlite.prepare('UPDATE system_config SET value=value||? WHERE key=?').run(' ',f.rowKey);
  if(fault==='too-early-warning')f.platform.events[0].waitUntilWarnings[0].timestamp-=20000;
  if(fault==='unrelated-invocation')f.platform.events[0].eventTimestamp-=120000;
  if(fault==='save-fail')o.persist=async()=>{throw Error('synthetic evidence persistence failure');};
  if(fault==='none'||fault==='pending-job'&&mode==='before-hold'){
    const result=await reconcileHostExpirySseStagingRun(o);assert.equal(result.fixtureRemoved,true);assert.equal(result.platformCancelled,1);assert.equal(result.experimentPassed,false);
    assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);assert.equal(f.sends,1);
  }else{const rows=f.financial();await assert.rejects(reconcileHostExpirySseStagingRun(o));assert.deepEqual(f.financial(),rows);}
});
