import assert from 'node:assert/strict';
import {assertCancelObservation} from './staging-sse-cancel-reconciliation.mjs';
import {assertSseHostExpiryEvidence as assertTail,SSE_HOST_EXPIRY_WARNING} from './staging-sse-host-expiry-evidence.mjs';
const origin='https://cinatoken-proxy-staging.cinagroup.workers.dev',path='/v1/images/generations';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const warnings=[SSE_HOST_EXPIRY_WARNING,SSE_HOST_EXPIRY_WARNING+' See: https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil'];
const iso=x=>{assert.equal(new Date(x).toISOString(),x);return Date.parse(x);};
/** Separate persisted-telemetry evidence, never converted into a synthetic live-tail envelope.
 * A native canceled outcome alone is insufficient: require the platform warning, invocation,
 * exact probe headers and response fact sharing a request ID, plus the original D1 observation.
 */
export function telemetrySseEvidence(report,journal,version){
  assert.equal(report.result,'PASS');assert.equal(report.status,200);assert.equal(report.success,true);
  assert.match(version,uuid);assert.equal(report.query.dry,true);assert.equal(report.query.view,'events');
  assert.equal(report.query.limit,20);assert.deepEqual(report.query.parameters,{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'cinatoken-proxy-staging'}]});
  assert.ok(Array.isArray(report.events)&&report.events.length>0&&report.events.length<=20);
  assert.equal(report.count,report.events.length,'Truncated query cannot prove the complete bounded observation');
  assert.equal(journal.requests.length,1,'Incident salvage only; never infer coverage of an unexecuted matrix');
  const r=journal.requests[0],started=iso(r.startedAt),issued=iso(r.cancelIssuedAt);
  assert.equal(report.query.timeframe.from,started-2000);assert.equal(report.query.timeframe.to,issued+90000);
  assert.ok(iso(report.startedAt)>=issued+30000&&iso(report.finishedAt)>=iso(report.startedAt));
  const invocation=report.events.filter(e=>e.type==='cf-worker-event');assert.equal(invocation.length,1);
  const i=invocation[0];assert.equal(i.outcome,'canceled');assert.match(i.requestId,/^[a-f0-9]{32}$/);
  assert.deepEqual(i.probeHeaders,{'x-c02-sse-cancel-observe':'v1','x-c02-sse-host-expiry':'v1','x-c02-sse-snapshot':`c02-snapshot:${journal.runId}:${r.probeId}:${r.mode}`});
  const seen=new Set();
  for(const e of report.events){
    assert.equal(e.service,'cinatoken-proxy-staging');assert.equal(e.scriptName,e.service);assert.deepEqual(e.version,{id:version});
    assert.equal(e.requestId,i.requestId);assert.equal(e.requestUrl,origin+path);assert.equal(e.method,'POST');
    assert.equal(typeof e.id,'string');assert.ok(!seen.has(e.id));seen.add(e.id);
    assert.ok(Number.isSafeInteger(e.timestamp)&&e.timestamp>=started-2000&&e.timestamp<=issued+90000);
    assert.ok(!['error','fatal'].includes(e.level));
  }
  const native=report.events.filter(e=>e.warning!==undefined);assert.equal(native.length,1);
  const w=native[0];assert.equal(w.type,'cf-worker');assert.equal(w.level,'warn');assert.ok(warnings.includes(w.warning));assert.equal(w.timestamp,i.timestamp);
  const response=report.events.filter(e=>e.sourceStatus!==undefined);assert.equal(response.length,1);
  assert.equal(response[0].sourceStatus,200);assert.equal(response[0].sourceMethod,'POST');assert.equal(response[0].sourcePath,path);
  assert.ok(response[0].timestamp<=i.timestamp);
  assert.ok(Number.isSafeInteger(i.wallTimeMs)&&i.wallTimeMs>0);
  assert.ok(i.timestamp-i.wallTimeMs>=started-2000&&i.timestamp-i.wallTimeMs<=iso(r.headersAt)+2000);
  assert.ok(iso(report.finishedAt)>=w.timestamp);
  return {kind:'native-persisted-wait-until-task-cancellation',probeHeader:i.probeHeaders['x-c02-sse-snapshot'],receivedAt:report.finishedAt,report};
}
export function assertSseHostExpiryEvidence(args){
  if(args.tail?.kind!=='native-persisted-wait-until-task-cancellation')return assertTail(args);
  const {journal,cancelRow,snapshotRow,tail,version}=args;
  assert.deepEqual(tail,telemetrySseEvidence(tail.report,journal,version));
  const cancel=assertCancelObservation(journal,cancelRow,true),r=journal.requests[0];
  assert.equal(snapshotRow.key,'c02_sse_snapshot:'+r.probeId);assert.equal(snapshotRow.description,'c02-snapshot:'+journal.runId);
  assert.equal(snapshotRow.value,cancel.snapshotValue,'Original held value must remain byte-identical');assert.ok(Buffer.byteLength(snapshotRow.value)<=2048);
  const snapshot=JSON.parse(snapshotRow.value),after=r.mode==='after-hold';
  assert.deepEqual(Object.keys(snapshot).sort(),['runId','probeId','mode','requestId','payloadSha256','phase',...(after?['nativeResult']:[])].sort());
  if(after){const n=snapshot.nativeResult;assert.deepEqual(Object.keys(n).sort(),['success','changes','rowsWritten','identityVerified'].sort());
    assert.equal(n.success,true);assert.equal(n.identityVerified,true);assert.ok(Number.isSafeInteger(n.changes)&&n.changes>0);assert.ok(n.rowsWritten===null||Number.isSafeInteger(n.rowsWritten)&&n.rowsWritten>=0);}
  const issued=iso(r.cancelIssuedAt),aborted=iso(cancel.at),warning=tail.report.events.find(e=>e.warning).timestamp;
  // Cloud response logs and native abort share a platform clock. Do not compare the
  // former to the local client's header clock with an invented 2-second skew bound.
  assert.ok(tail.report.events.find(e=>e.sourceStatus!==undefined).timestamp<=aborted);
  assert.ok(iso(r.startedAt)<=iso(r.headersAt)&&iso(r.headersAt)<=issued);
  assert.ok(aborted>=issued-2000&&aborted<=issued+10000);assert.ok(warning>=aborted+29000&&warning<=aborted+60000);
  return {requestId:r.id,mode:r.mode,kind:tail.kind,isolateEvictionProven:false,originalLiveTailExperimentPassed:false};
}
