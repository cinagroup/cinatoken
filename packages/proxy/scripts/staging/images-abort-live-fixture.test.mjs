import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { abortImagePlans, assertAbortImages } from './images-abort-live-fixture.mjs';
import { recoveryImageSeed } from './images-recovery-live-fixture.mjs';
import { parseImageStorageFault } from './images-storage-fault-contract.ts';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
const prior = JSON.parse(readFileSync(new URL('../../../../docs/developers/architecture/implementation-evidence/C02-staging-images-recovery-results.json', import.meta.url))).cloud.experiment;

test('abort experiment seed preserves fresh tenant/no accepted usage and exactly four one-shot probes', async () => {
  const f = await imageSuccessFixture('c02-success-' + randomUUID(), 'sha256:' + '0'.repeat(64), new Date(Date.now()+3600000).toISOString());
  const plans = abortImagePlans(f), db = createSqliteD1();
  try {
    assert.deepEqual(plans.map(p=>p.mode), ['normal','normal','before-abort','before-abort','after-abort','after-abort']);
    for (const p of plans.filter(p=>p.probe)) assert.deepEqual(parseImageStorageFault(p.header), p.probe);
    for (const s of recoveryImageSeed(f, plans)) db.sqlite.prepare(s.sql).run(...s.params);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n, 0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM system_config WHERE key LIKE 'c02_images_storage:%'").get().n, 4);
    assert.equal(recoveryImageSeed(f, plans).some(s=>/INSERT INTO request_(dispatch_intents|usage_)/.test(s.sql)), false);
  } finally { db.sqlite.close(); }
});

// Validator-only vectors derived from published financial projections. Changing
// their lease fields is NOT execution/termination evidence; only cloud can supply that.
for (const recovered of [false, true]) test(`abort validator vectors reject ordinary-error transitions and accounting drift: recovered=${recovered}`, () => {
  const f = { ids: prior.fixtureIds }, plans = prior.plans.map(p=>({...p, mode:p.mode.replace('fail','abort')}));
  const o = structuredClone(recovered ? prior.afterRecovery : prior.beforeRecovery);
  for (const p of plans.filter(p=>p.mode==='before-abort')) {
    const job=o.jobs.find(j=>j.request_id===p.requestId);
    if(recovered){job.revision=3;o.receipts.find(r=>r.request_id===p.requestId).lease_revision=2;}
    else {job.state='leased';job.revision=1;job.last_error=null;job.lease_expires_at=job.updated_at+30;job.available_at=job.lease_expires_at;}
  }
  assertAbortImages(f,plans,o,recovered);
  const id=plans.find(p=>p.mode==='before-abort').requestId;
  for(const mutate of [
    v=>{v.jobs.find(j=>j.request_id===id).revision=4;},
    v=>{v.jobs.find(j=>j.request_id===id).state='pending';},
    v=>{v.jobs.find(j=>j.request_id===id).last_error='execution_error';},
    v=>{v.account[0].budget_spent_micros++;},
    v=>{v.account[0].budget_reserved_micros++;},
    v=>{v.snapshots[0].payload_sha256='invalid';},
    v=>{v.receipts.pop();}, v=>{v.logs.pop();}, v=>{v.attempts.pop();}, v=>{v.audit.pop();},v=>{v.stats=[];},
  ]) {const bad=structuredClone(o);mutate(bad);assert.throws(()=>assertAbortImages(f,plans,bad,recovered));}
  if(recovered){const bad=structuredClone(o);bad.receipts.find(r=>r.request_id===id).lease_revision=3;assert.throws(()=>assertAbortImages(f,plans,bad,true));}
  else {const bad=structuredClone(o);bad.jobs.find(j=>j.request_id===id).available_at++;assert.throws(()=>assertAbortImages(f,plans,bad));}
  assert.throws(()=>assertAbortImages(f,prior.plans,o,recovered),'old fail modes must not stand in for native abort');
});

test('abort operator rejects forged tenant or duplicate scenario coverage',()=>{
  const bad={ids:{...prior.fixtureIds,user:'other-user'}};
  assert.throws(()=>assertAbortImages(bad,prior.plans,prior.beforeRecovery));
  const plans=prior.plans.map(p=>({...p,mode:p.mode.replace('fail','abort')}));
  plans[1]={...plans[0]};assert.throws(()=>assertAbortImages({ids:prior.fixtureIds},plans,prior.beforeRecovery));
});
