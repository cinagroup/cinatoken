import assert from 'node:assert/strict';
import {assertCancelObservation} from './staging-sse-cancel-reconciliation.mjs';
import {SSE_HOST_EXPIRY_WARNING} from './staging-sse-host-expiry-evidence-v2.mjs';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const warnings=[SSE_HOST_EXPIRY_WARNING,SSE_HOST_EXPIRY_WARNING+' See: https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil'];
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const iso=x=>{assert.equal(typeof x,'string');assert.equal(new Date(x).toISOString(),x);return Date.parse(x);};
export function assertSseHostExpiryEvidence({journal,cancelRow,snapshotRow,tail,version}){
  assert.match(version,new RegExp(`^${uuid}$`));
  const cancel=assertCancelObservation(journal,cancelRow,true);
  const request=journal.requests.find(r=>r.id===cancel.requestId);assert.ok(request);
  assert.equal(snapshotRow.key,'c02_sse_snapshot:'+request.probeId);
  assert.equal(snapshotRow.description,'c02-snapshot:'+journal.runId);
  assert.equal(snapshotRow.value,cancel.snapshotValue,'Held snapshot changed after native cancellation');
  assert.ok(Buffer.byteLength(snapshotRow.value)<=2048);
  const snapshot=JSON.parse(snapshotRow.value),after=request.mode==='after-hold';
  assert.deepEqual(Object.keys(snapshot).sort(),['runId','probeId','mode','requestId','payloadSha256','phase',...(after?['nativeResult']:[])].sort());
  if(after){
    const n=snapshot.nativeResult;
    assert.deepEqual(Object.keys(n).sort(),['success','changes','rowsWritten','identityVerified'].sort());
    assert.equal(n.success,true);assert.equal(n.identityVerified,true);assert.ok(integer(n.changes)&&n.changes>0);
    assert.ok(n.rowsWritten===null||integer(n.rowsWritten));
  }
  assert.deepEqual(Object.keys(tail).sort(),['probeHeader','profile','outcome','eventTimestamp','scriptName','version','path','method','responseStatus','receivedAt','waitUntilWarnings'].sort());
  assert.equal(tail.probeHeader,`c02-snapshot:${journal.runId}:${request.probeId}:${request.mode}`);
  assert.equal(tail.profile,'v1');assert.equal(tail.scriptName,'cinatoken-proxy-staging');assert.equal(tail.version,version);
  assert.equal(tail.path,'/v1/images/generations');assert.equal(tail.method,'POST');assert.ok(['ok','canceled'].includes(tail.outcome));
  if(tail.responseStatus===null){assert.equal(tail.outcome,'canceled');assert.equal(request.responseStatus,200,'Missing native response requires separately observed client 200');}else assert.equal(tail.responseStatus,200);
  assert.ok(integer(tail.eventTimestamp));assert.equal(tail.waitUntilWarnings.length,1);
  const warning=tail.waitUntilWarnings[0];assert.equal(warning.level,'warn');assert.ok(warnings.includes(warning.message)&&integer(warning.timestamp));
  // Incident reconciliation only: recorded local wall-clock order is not reliable.
  // Correlation relies on original Request.signal + exact held bytes + native invocation/warning
  // timestamps on the same platform clock. Do not rewrite historical timestamps or promote the run.
  for(const value of [request.startedAt,request.headersAt,request.cancelIssuedAt,tail.receivedAt])iso(value);
  assert.equal(request.responseStatus,200);
  const aborted=iso(cancel.at);
  assert.ok(tail.eventTimestamp<=aborted&&aborted-tail.eventTimestamp<=90000,'Native invocation outside bounded case');
  assert.ok(warning.timestamp>=aborted+29000&&warning.timestamp<=aborted+60000,'No native post-disconnect cancellation');
  return {requestId:request.id,mode:request.mode,kind:'native-wait-until-task-cancellation',isolateEvictionProven:false,clientClockOrderingVerified:false,originalExperimentPassed:false};
}
