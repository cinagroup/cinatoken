import assert from 'node:assert/strict';
import test from 'node:test';
import {setupExpiryCleanup} from './images-sse-host-expiry-cleanup-fixture.mjs';
import {telemetrySseEvidence,assertSseHostExpiryEvidence} from '../../../../scripts/deploy/staging-sse-host-expiry-telemetry-evidence.mjs';
import {reconcileHostExpirySseStagingRun} from '../../../../scripts/deploy/staging-sse-host-expiry-telemetry-reconciliation.mjs';
// Explicitly synthetic persisted-log projection for local contract tests, not platform proof.
function modeled(f){
  const t=f.platform.events[0],r=f.journal.requests[0],end=t.waitUntilWarnings[0].timestamp;
  const common={service:t.scriptName,scriptName:t.scriptName,version:{id:t.version},requestId:'a'.repeat(32),requestUrl:'https://cinatoken-proxy-staging.cinagroup.workers.dev/v1/images/generations',method:'POST'};
  return {result:'PASS',status:200,success:true,count:3,startedAt:new Date(end+3000).toISOString(),finishedAt:new Date(end+4000).toISOString(),
    query:{dry:true,view:'events',limit:20,timeframe:{from:Date.parse(r.startedAt)-2000,to:Date.parse(r.cancelIssuedAt)+90000},parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:t.scriptName}]}},
    events:[{...common,id:'invocation',type:'cf-worker-event',outcome:'canceled',timestamp:end,wallTimeMs:end-Date.parse(r.startedAt),probeHeaders:{'x-c02-sse-cancel-observe':'v1','x-c02-sse-host-expiry':'v1','x-c02-sse-snapshot':t.probeHeader}},
      {...common,id:'warning',type:'cf-worker',level:'warn',timestamp:end,warning:t.waitUntilWarnings[0].message},
      {...common,id:'response',type:'cf-worker',timestamp:Date.parse(r.headersAt),sourceStatus:200,sourceMethod:'POST',sourcePath:'/v1/images/generations'}]};
}
for(const mode of ['before-hold','after-hold'])test('modeled persisted telemetry exact cleanup '+mode,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,mode),report=modeled(f),evidence=telemetrySseEvidence(report,f.journal,f.platform.version);
  const o=f.options();o.platform={version:f.platform.version,events:[evidence]};
  const result=await reconcileHostExpirySseStagingRun(o);
  assert.equal(result.platformCancelled,1);assert.deepEqual(f.counts(),f.baseline);assert.deepEqual(f.otherRows(),f.unrelated);assert.equal(f.sends,1);
  assert.equal(f.saved.find(x=>x.step==='host-expiry-sse-facts-observed').platform.events[0].kind,'native-persisted-wait-until-task-cancellation');
});
for(const fault of ['missing-warning','wrong-outcome','wrong-version','other-request','wrong-header','wrong-url','non-200','late-response','too-early-warning','wrong-warning','error-log','duplicate-event','truncated-query','wrong-query-scope','changed-held','cancel-too-early'])
test('persisted telemetry refuses '+fault,{timeout:10000},async t=>{
  const f=await setupExpiryCleanup(t,'before-hold'),report=modeled(f),r=f.journal.requests[0];
  const snapshotRow={...f.db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get(f.rowKey)};
  const cancelRow={...f.db.sqlite.prepare('SELECT key,value,description FROM system_config WHERE key=?').get('c02_sse_cancel:'+r.probeId)};
  if(fault==='missing-warning')delete report.events[1].warning;
  if(fault==='wrong-outcome')report.events[0].outcome='exception';
  if(fault==='wrong-version')report.events[1].version.id='00000000-0000-0000-0000-000000000000';
  if(fault==='other-request')report.events[1].requestId='b'.repeat(32);
  if(fault==='wrong-header')report.events[0].probeHeaders['x-c02-sse-host-expiry']='v2';
  if(fault==='wrong-url')report.events[0].requestUrl='https://example.com/v1/images/generations';
  if(fault==='non-200')report.events[2].sourceStatus=503;
  if(fault==='late-response')report.events[2].timestamp+=5000;
  if(fault==='too-early-warning'){report.events[1].timestamp-=10000;report.events[0].timestamp-=10000;report.events[0].wallTimeMs-=10000;}
  if(fault==='wrong-warning')report.events[1].warning='application waitUntil warning';
  if(fault==='error-log')report.events[2].level='error';
  if(fault==='duplicate-event')report.events[1].id=report.events[0].id;
  if(fault==='truncated-query')report.count++;
  if(fault==='wrong-query-scope')report.query.parameters.filters[0].value='cinatoken-proxy';
  if(fault==='changed-held')snapshotRow.value+=' ';
  if(fault==='cancel-too-early'){const c=JSON.parse(cancelRow.value);c.at=new Date(Date.parse(r.cancelIssuedAt)-10000).toISOString();cancelRow.value=JSON.stringify(c);}
  assert.throws(()=>assertSseHostExpiryEvidence({journal:f.journal,cancelRow,snapshotRow,tail:telemetrySseEvidence(report,f.journal,f.platform.version),version:f.platform.version}));
  assert.deepEqual(f.financial().map(x=>x.length),[1,0,0,0,0,1]);
});
