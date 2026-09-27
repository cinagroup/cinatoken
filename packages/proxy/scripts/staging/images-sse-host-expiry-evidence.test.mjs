import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {extractSseHostExpiryTail,assertSseHostExpiryEvidence,SSE_HOST_EXPIRY_WARNING} from '../../../../scripts/deploy/staging-sse-host-expiry-evidence.mjs';

function sample(mode='before-hold',suffix=''){
  const time=Date.parse('2026-09-08T10:00:00.000Z'),at=offset=>new Date(time+offset).toISOString();
  const runId='c02-success-'+randomUUID(),probeId=randomUUID(),id='gen-'+randomUUID(),upstreamProbeId=randomUUID(),version=randomUUID();
  const request={id,mode,probeId,upstreamProbeId,startedAt:at(0),headersAt:at(1000),cancelIssuedAt:at(2000)};
  const journal={runId,requests:[request],probes:[{runId,probeId:upstreamProbeId,mode:'success'}]};
  const value={runId,probeId,mode,requestId:id,payloadSha256:'a'.repeat(64),phase:mode==='before-hold'?'held-before-insert':'held-after-insert',
    ...(mode==='after-hold'?{nativeResult:{success:true,changes:2,rowsWritten:9,identityVerified:true}}:{})};
  const snapshotRow={key:'c02_sse_snapshot:'+probeId,description:'c02-snapshot:'+runId,value:JSON.stringify(value)};
  const cancelRow={key:'c02_sse_cancel:'+probeId,description:'c02-cancel:'+runId,
    value:JSON.stringify({runId,probeId,mode,phase:'request-aborted',requestId:id,at:at(2500),signalAborted:true,snapshotValue:snapshotRow.value})};
  const raw={scriptName:'cinatoken-proxy-staging',scriptVersion:{id:version},outcome:'ok',eventTimestamp:time+500,
    event:{request:{url:'https://cinatoken-proxy-staging.cinagroup.workers.dev/v1/images/generations',method:'POST',
      headers:{'x-c02-sse-host-expiry':'v1','x-c02-sse-cancel-observe':'v1','x-c02-sse-snapshot':`c02-snapshot:${runId}:${probeId}:${mode}`,Authorization:'PRIVATE_TEST_ONLY'}},response:{status:200}},
    logs:[{level:'log',message:['PRIVATE_TEST_ONLY'],timestamp:time+1000},{level:'warn',message:[SSE_HOST_EXPIRY_WARNING+suffix],timestamp:time+32500}],exceptions:[]};
  const receivedAt=at(33000),tail=extractSseHostExpiryTail(raw,receivedAt);
  return {journal,cancelRow,snapshotRow,tail,version,raw,receivedAt};
}

for(const mode of ['before-hold','after-hold'])for(const suffix of ['', ' See: https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil'])
test('native tail exact correlation and immutable projection: '+mode+suffix,()=>{
  const s=sample(mode,suffix),before=structuredClone(s);
  assert.deepEqual(assertSseHostExpiryEvidence(s),{requestId:s.journal.requests[0].id,mode,kind:'native-wait-until-task-cancellation',isolateEvictionProven:false});
  assert.deepEqual(s,before);assert.doesNotMatch(JSON.stringify(s.tail),/PRIVATE_TEST_ONLY|Authorization/);
});

for(const [label,change] of [
  ['wrong deployment',s=>s.tail.version=randomUUID()],
  ['wrong request header',s=>s.tail.probeHeader=s.tail.probeHeader.replace(s.journal.runId,'c02-success-'+randomUUID())],
  ['wrong native request identity',s=>{const v=JSON.parse(s.cancelRow.value);v.requestId='gen-'+randomUUID();s.cancelRow.value=JSON.stringify(v);}],
  ['native signal absent',s=>{const v=JSON.parse(s.cancelRow.value);v.signalAborted=false;s.cancelRow.value=JSON.stringify(v);}],
  ['timer survived',s=>{const v=JSON.parse(s.snapshotRow.value);v.phase='host-expiry-not-observed';s.snapshotRow.value=JSON.stringify(v);}],
  ['probe released',s=>{const v=JSON.parse(s.snapshotRow.value);v.phase='release-requested';s.snapshotRow.value=JSON.stringify(v);}],
  ['identity not verified',s=>{const v=JSON.parse(s.snapshotRow.value);v.nativeResult.identityVerified=false;s.snapshotRow.value=JSON.stringify(v);const c=JSON.parse(s.cancelRow.value);c.snapshotValue=s.snapshotRow.value;s.cancelRow.value=JSON.stringify(c);}],
  ['unrelated invocation time',s=>s.tail.eventTimestamp-=60000],
  ['application timeout too soon',s=>s.tail.waitUntilWarnings[0].timestamp-=20000],
  ['stale warning',s=>s.tail.waitUntilWarnings[0].timestamp+=60000],
  ['receipt before warning',s=>s.tail.receivedAt=s.journal.requests[0].startedAt],
  ['wrong warning text',s=>s.tail.waitUntilWarnings[0].message+=' extra'],
  ['wrong warning level',s=>s.tail.waitUntilWarnings[0].level='error'],
  ['missing warning',s=>s.tail.waitUntilWarnings=[]],
])test('reject indirect or mismatched host expiry evidence: '+label,()=>{
  const s=sample('after-hold');change(s);assert.throws(()=>assertSseHostExpiryEvidence(s));
});

for(const [label,change] of [
  ['native abort exception',r=>r.exceptions=[{name:'Error',message:'ctx.abort()'}]],
  ['application exception',r=>r.exceptions=[{name:'Error',message:'other'}]],
  ['unknown suffix',r=>r.logs[1].message=[SSE_HOST_EXPIRY_WARNING+' arbitrary']],
  ['foreign URL suffix',r=>r.logs[1].message=[SSE_HOST_EXPIRY_WARNING+' See: https://evil.invalid']],
  ['duplicate header spelling',r=>r.event.request.headers['X-C02-SSE-HOST-EXPIRY']='v1'],
  ['wrong route',r=>r.event.request.url+='/other'],
  ['query route',r=>r.event.request.url+='?a=1'],
  ['wrong response',r=>r.event.response.status=500],
  ['no warning',r=>r.logs=[]],
  ['overlong envelope',r=>r.extra='x'.repeat(131073)],
  ['too many logs',r=>r.logs=Array(65).fill(r.logs[1])],
])test('bounded native tail projection rejects '+label,()=>{
  const s=sample();change(s.raw);assert.throws(()=>extractSseHostExpiryTail(s.raw,s.receivedAt));
});

test('unmatched non-probe tail is ignored, not retained or promoted to success',()=>{
  const s=sample();delete s.raw.event.request.headers['x-c02-sse-host-expiry'];
  assert.equal(extractSseHostExpiryTail(s.raw,s.receivedAt),null);
});
