import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {extractSseHostExpiryTail,assertSseHostExpiryEvidence,SSE_HOST_EXPIRY_WARNING} from '../../../../scripts/deploy/staging-sse-host-expiry-evidence-v2.mjs';

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


import {createSseHostExpiryTailCollector} from '../../../../scripts/deploy/staging-sse-host-expiry-tail-collector.mjs';
const makeCollector=s=>createSseHostExpiryTailCollector({version:s.version,probeHeaders:[s.tail.probeHeader]});
for(const mode of ['before-hold','after-hold'])for(const missing of [false,true])test('canceled outcome retained / response missing='+missing+' / '+mode,()=>{
  const s=sample(mode);s.raw.outcome='canceled';s.journal.requests[0].responseStatus=200;if(missing)delete s.raw.event.response;
  s.tail=extractSseHostExpiryTail(s.raw,s.receivedAt);assert.equal(s.tail.outcome,'canceled');assert.equal(s.tail.responseStatus,missing?null:200);
  assert.equal(assertSseHostExpiryEvidence(s).kind,'native-wait-until-task-cancellation');
});
test('missing native response requires independent client 200',()=>{
  const s=sample();s.raw.outcome='canceled';delete s.raw.event.response;s.tail=extractSseHostExpiryTail(s.raw,s.receivedAt);
  assert.throws(()=>assertSseHostExpiryEvidence(s));s.journal.requests[0].responseStatus=503;assert.throws(()=>assertSseHostExpiryEvidence(s));
});
test('independent platform/local clocks: native intervals remain ordered',()=>{
  const s=sample();s.raw.outcome='canceled';s.raw.eventTimestamp+=5000;s.raw.logs[1].timestamp+=5000;
  const c=JSON.parse(s.cancelRow.value);c.at=new Date(Date.parse(c.at)+5000).toISOString();s.cancelRow.value=JSON.stringify(c);
  s.tail=extractSseHostExpiryTail(s.raw,s.receivedAt);assert.equal(assertSseHostExpiryEvidence(s).kind,'native-wait-until-task-cancellation');
});
for(const change of [r=>r.outcome='exception',r=>r.truncated=true,r=>{delete r.event.response;},r=>{r.event.response={};}])
test('unsupported/incomplete native envelope never accepted',()=>{const s=sample();change(s.raw);assert.throws(()=>extractSseHostExpiryTail(s.raw,s.receivedAt));});
test('collector stores valid projection, not credentials or arbitrary logs',()=>{
 const s=sample(),c=makeCollector(s),raw=Buffer.from(JSON.stringify(s.raw));const v=c.receive(raw,s.receivedAt);
 assert.equal(v.events.length,1);assert.equal(v.bytes,raw.length);assert.doesNotMatch(JSON.stringify(v),/PRIVATE_TEST_ONLY|Authorization/);
 v.events[0].outcome='forged';assert.equal(c.snapshot().events[0].outcome,'ok');
});
test('first validation stage survives transport error, close and later messages',()=>{
 const s=sample(),c=makeCollector(s);s.raw.outcome='PRIVATE_TEST_ONLY';const a=c.receive(Buffer.from(JSON.stringify(s.raw)),s.receivedAt);
 assert.equal(a.firstFailure.code,'validation');assert.equal(a.firstFailure.stage,'outcome');assert.equal(a.firstFailure.outcome,'other');
 assert.deepEqual(c.transportError(s.receivedAt),a);assert.deepEqual(c.transportClose(s.receivedAt),a);assert.deepEqual(c.receive(Buffer.from('{}'),s.receivedAt),a);
 assert.doesNotMatch(JSON.stringify(a),/PRIVATE_TEST_ONLY|Authorization/);
});
for(const fault of ['type','json','single-bytes','total-bytes','messages','deployment','correlation','duplicate'])
test('collector fail-closed budget/identity '+fault,()=>{
 const s=sample(),c=makeCollector(s);let expected;
 if(fault==='type'){c.receive('unsafe',s.receivedAt);expected='message-type';}
 if(fault==='json'){c.receive(Buffer.from('PRIVATE_TEST_ONLY'),s.receivedAt);expected='json';}
 if(fault==='single-bytes'){c.receive(Buffer.alloc(131073),s.receivedAt);expected='byte-budget';}
 if(['total-bytes','messages'].includes(fault)){
   const raw=structuredClone(s.raw);delete raw.event.request.headers['x-c02-sse-host-expiry'];if(fault==='total-bytes')raw.extra='x'.repeat(110000);
   for(let n=0;n<9;n++)c.receive(Buffer.from(JSON.stringify(raw)),s.receivedAt);expected=fault==='messages'?'message-budget':'byte-budget';
 }
 if(fault==='deployment'){s.raw.scriptVersion.id=randomUUID();c.receive(Buffer.from(JSON.stringify(s.raw)),s.receivedAt);expected='deployment';}
 if(fault==='correlation'){s.raw.event.request.headers['x-c02-sse-snapshot']=s.tail.probeHeader.replace(s.journal.runId,'c02-success-'+randomUUID());c.receive(Buffer.from(JSON.stringify(s.raw)),s.receivedAt);expected='correlation';}
 if(fault==='duplicate'){const raw=Buffer.from(JSON.stringify(s.raw));c.receive(raw,s.receivedAt);c.receive(raw,s.receivedAt);expected='duplicate';}
 assert.equal(c.snapshot().firstFailure.code,expected);assert.doesNotMatch(JSON.stringify(c.snapshot()),/PRIVATE_TEST_ONLY|Authorization/);
});
test('transport close remains first failure',()=>{const s=sample(),c=makeCollector(s),a=c.transportClose(s.receivedAt);assert.equal(a.firstFailure.code,'transport-close');assert.deepEqual(c.transportError(s.receivedAt),a);});
