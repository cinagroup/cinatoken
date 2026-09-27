import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { partialImagePlans, partialImageSeed, partialImageObservations, assertPartialImages, readPartialImageResponse } from './images-partial-delivery-live-fixture.mjs';
import { recoveryImageCleanup } from './images-recovery-live-fixture.mjs';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
const prior=JSON.parse(readFileSync(new URL('../../../../docs/developers/architecture/implementation-evidence/C02-staging-native-abort-recovery-results.json',import.meta.url))).cloud.experiment;

test('six-model fixture seeds only synthetic inputs; all twelve scoped queries and cleanup execute',async()=>{
  const f=await imageSuccessFixture('c02-success-'+randomUUID(),'sha256:'+'0'.repeat(64),new Date(Date.now()+3600000).toISOString(),{includeLimitEdits:true});
  const plans=partialImagePlans(f),db=createSqliteD1();
  try {
    for(const name of ['request-dispatch-intents.sql','request-usage-settlements.sql','request-usage-recovery-jobs.sql'])db.sqlite.exec(readFileSync(new URL('../../../core/migrations-proposals/d1/'+name,import.meta.url),'utf8'));
    assert.equal(f.ids.models.length,6);assert.equal(plans.length,4);
    const seed=partialImageSeed(f,plans);
    assert.equal(seed.some(s=>/INSERT INTO request_(dispatch_intents|usage_)/.test(s.sql)),false);
    for(const s of seed)db.sqlite.prepare(s.sql).run(...s.params);
    const queries=partialImageObservations(f);assert.equal(Object.keys(queries).length,12);
    for(const [key,s] of Object.entries(queries))assert.equal(db.sqlite.prepare(s.sql).all(...s.params).length,['account','key'].includes(key)?1:0);
    for(const s of recoveryImageCleanup(f,plans))db.sqlite.prepare(s.sql).run(...s.params);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM system_config WHERE key LIKE 'c02_images_storage:%'").get().n,0);
    assert.throws(()=>partialImageObservations({...f,ids:{...f.ids,user:'other'}}));
    assert.throws(()=>partialImageSeed(f,[plans[0],plans[0],...plans.slice(2)]));
  } finally {db.sqlite.close();}
});

test('partial reader consumes one bounded chunk then cancels without claiming EOF or full JSON',async()=>{
  let pulls=0,cancels=0;
  const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(16384));},cancel(){cancels++;}},{highWaterMark:0});
  assert.deepEqual(await readPartialImageResponse(new Response(stream),32*1024**2),{bytes:16384,expectedFullBytes:32*1024**2,eofObserved:false,clientCancellationRequested:true,clientCancellationCompleted:true,fullBodyParsed:false});
  assert.equal(pulls,1);assert.equal(cancels,1);
});
test('partial reader rejects empty EOF, excessive first chunk, and failed cancellation',async()=>{
  await assert.rejects(readPartialImageResponse(new Response(new ReadableStream({start(c){c.close();}})),32*1024**2));
  await assert.rejects(readPartialImageResponse(new Response(new Uint8Array(262145)),32*1024**2));
  await assert.rejects(readPartialImageResponse(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1));},cancel(){throw Error('cancel failed');}})),32*1024**2));
});

// Projection-only vectors from published native-abort observations. Not live edge evidence.
for(const recovered of [false,true])test('partial financial validator rejects accounting/lease/coverage drift: recovered='+recovered,async()=>{
  const f=await imageSuccessFixture(prior.fixtureIds.runId,'sha256:'+'0'.repeat(64),new Date(Date.now()+3600000).toISOString(),{includeLimitEdits:true});
  const plans=partialImagePlans(f).map(p=>({...p,requestId:prior.plans.find(v=>v.operation===p.operation&&v.mode===p.mode).requestId}));
  const ids=new Set(plans.map(p=>p.requestId));
  const o=structuredClone(recovered?prior.afterRecovery:prior.beforeRecovery);
  for(const k of ['intents','snapshots','jobs','reservations','receipts'])o[k]=o[k].filter(v=>ids.has(v.request_id));
  o.logs=o.logs.filter(v=>ids.has(v.id));
  for(const k of ['attempts','audit'])o[k]=o[k].filter(v=>ids.has(v.request_log_id));
  for(const v of [...o.snapshots,...o.logs])v.model_id=v.model_id.replace('-small-','-limit-');
  if(!recovered)for(const j of o.jobs.filter(j=>j.state==='leased'))j.lease_expires_at=j.available_at=j.updated_at+5;
  o.account[0].budget_spent_micros=o.receipts.length*100000;
  o.stats=[];
  for(const l of o.logs){let s=o.stats.find(s=>s.model_id===l.model_id&&s.stat_date===l.created_at.slice(0,10));if(!s){s={model_id:l.model_id,stat_date:l.created_at.slice(0,10),request_count:0,success_count:0,error_count:0};o.stats.push(s);}s.request_count++;s.success_count++;}
  o.stats.sort((a,b)=>a.model_id.localeCompare(b.model_id)||a.stat_date.localeCompare(b.stat_date));
  assertPartialImages(f,plans,o,recovered);
  for(const mutate of [v=>v.account[0].budget_spent_micros++,v=>v.account[0].budget_reserved_micros++,v=>v.jobs[0].revision++,v=>v.jobs[0].attempts++,v=>v.jobs[0].last_error='execution_error',v=>v.snapshots[0].bytes=262145,v=>v.snapshots[0].payload_sha256='bad',v=>v.receipts.pop(),v=>v.logs.pop(),v=>v.attempts.pop(),v=>v.audit.pop(),v=>v.stats.pop()]){const bad=structuredClone(o);mutate(bad);assert.throws(()=>assertPartialImages(f,plans,bad,recovered));}
  assert.throws(()=>assertPartialImages(f,[plans[0],plans[0],...plans.slice(2)],o,recovered));
  assert.throws(()=>assertPartialImages(f,plans.map(p=>({...p,mode:'before-fail'})),o,recovered));
});
