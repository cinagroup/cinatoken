import assert from 'node:assert/strict';
import {assertCancelObservation} from './staging-sse-cancel-reconciliation.mjs';

export const SSE_HOST_EXPIRY_WARNING='waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.';
const warnings=[SSE_HOST_EXPIRY_WARNING,SSE_HOST_EXPIRY_WARNING+' See: https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil'];
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const probePattern=new RegExp(`^c02-snapshot:c02-success-${uuid}:${uuid}:(before-hold|after-hold)$`);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const iso=x=>{assert.equal(typeof x,'string');assert.equal(new Date(x).toISOString(),x);return Date.parse(x);};

/** Accept only an already size-limited native tail envelope. The caller must cap WebSocket
 * bytes BEFORE parsing. Never persist raw headers, body, credentials or unrelated log text.
 * This projection preserves the exact native warning, without rewriting its meaning.
 */
export class SseTailValidationError extends Error { constructor(stage){super('SSE tail validation failed: '+stage);this.code=stage;} }
export function extractSseHostExpiryTail(raw,receivedAt){
  let stage='envelope';try{
  assert.ok(raw&&typeof raw==='object'&&Buffer.byteLength(JSON.stringify(raw))<=131072);
  assert.ok(raw.truncated===undefined||raw.truncated===false,'Truncated native trace');
  stage='headers';const headers=raw.event?.request?.headers;
  assert.ok(headers&&typeof headers==='object'&&!Array.isArray(headers)&&Object.keys(headers).length<=128);
  const header=name=>{
    const matches=Object.entries(headers).filter(([key])=>key.toLowerCase()===name);
    assert.ok(matches.length<=1,'Ambiguous trace correlation header');return matches[0]?.[1];
  };
  const profile=header('x-c02-sse-host-expiry');
  if(profile===undefined)return null;
  stage='correlation';assert.equal(profile,'v1');assert.equal(header('x-c02-sse-cancel-observe'),'v1');
  const probeHeader=header('x-c02-sse-snapshot');assert.equal(typeof probeHeader,'string');assert.match(probeHeader,probePattern);
  stage='http';const url=new URL(raw.event.request.url);
  assert.equal(url.origin,'https://cinatoken-proxy-staging.cinagroup.workers.dev');
  assert.equal(url.pathname,'/v1/images/generations');assert.equal(url.search+url.hash+url.username+url.password,'');
  assert.equal(raw.event.request.method,'POST');if(raw.event.response===undefined){assert.equal(raw.outcome,'canceled');}else assert.equal(raw.event.response?.status,200);
  stage='deployment';assert.equal(raw.scriptName,'cinatoken-proxy-staging');assert.match(raw.scriptVersion?.id,new RegExp(`^${uuid}$`));
  assert.ok(integer(raw.eventTimestamp));iso(receivedAt);
  stage='logs';assert.ok(Array.isArray(raw.logs)&&raw.logs.length<=64);
  assert.ok(Array.isArray(raw.exceptions)&&raw.exceptions.length===0,'Exception/explicit abort is not natural expiry evidence');
  const waitUntilWarnings=[];
  for(const log of raw.logs){
    const messages=typeof log.message==='string'?[log.message]:log.message;
    assert.ok(Array.isArray(messages)&&messages.length<=16);
    for(const message of messages){
      if(typeof message!=='string'||!message.includes('waitUntil'))continue;
      assert.ok(message.length<=1024&&integer(log.timestamp));
      // Do not retain arbitrary application text that mentions waitUntil.
      assert.ok(warnings.includes(message)&&log.level==='warn','Unrecognized waitUntil warning');
      waitUntilWarnings.push({level:log.level,message,timestamp:log.timestamp});
    }
  }
  stage='warning';assert.equal(waitUntilWarnings.length,1,'Exactly one native cancellation warning is required');
  stage='outcome';assert.ok(['ok','canceled'].includes(raw.outcome)); // Preserve the native outcome; never normalize canceled to ok.
  return {probeHeader,profile,outcome:raw.outcome,eventTimestamp:raw.eventTimestamp,scriptName:raw.scriptName,
    version:raw.scriptVersion.id,path:url.pathname,method:'POST',responseStatus:raw.event.response?.status??null,receivedAt,waitUntilWarnings};
  }catch{throw new SseTailValidationError(stage);}
}

/** A held row alone is NOT platform evidence. Require original cancellation, unchanged owned
 * snapshot, exact request-header correlation, deployment identity and ordered native timestamps.
 * This proves request-scoped waitUntil task cancellation, NOT whole-isolate eviction or finance.
 */
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
  const started=iso(request.startedAt),headers=iso(request.headersAt),issued=iso(request.cancelIssuedAt),aborted=iso(cancel.at),received=iso(tail.receivedAt);
  assert.ok(started<=headers&&headers<=issued);
  assert.ok(tail.eventTimestamp<=aborted&&aborted-tail.eventTimestamp<=issued-started+10000,'Trace invocation outside request duration');
  assert.ok(aborted>=issued-2000&&aborted<=issued+10000,'Native cancellation outside bounded client observation');
  assert.ok(warning.timestamp>=aborted+29000&&warning.timestamp<=aborted+60000,'No ordered post-disconnect platform expiry');
  // Compare each duration on its own clock; the local client and edge clock need not agree within two seconds.
  assert.ok(received>=issued+29000&&received<=issued+90000,'Tail receipt outside local post-cancel window');
  return {requestId:request.id,mode:request.mode,kind:'native-wait-until-task-cancellation',isolateEvictionProven:false};
}
