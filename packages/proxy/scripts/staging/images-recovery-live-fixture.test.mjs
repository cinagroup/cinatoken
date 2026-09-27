import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup } from './images-recovery-test-support.mjs';
import { recoveryImagePlans, recoveryImageSeed, recoveryImageObservations, assertRecoveryImages, recoveryImageCleanup } from './images-recovery-live-fixture.mjs';
import { IMAGE_STORAGE_FAULT_HEADER } from './images-storage-fault-contract.ts';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';

test('operator seed creates only isolated synthetic admission/model/probe rows, no accepted usage',async()=>{
  const db=createSqliteD1();
  try {
    const f=await imageSuccessFixture('c02-success-'+randomUUID(),'sha256:'+'0'.repeat(64),new Date(Date.now()+3600000).toISOString());
    const plans=recoveryImagePlans(f),seed=recoveryImageSeed(f,plans);
    for(const s of seed)db.sqlite.prepare(s.sql).run(...s.params);
    assert.equal(db.sqlite.prepare('SELECT budget_max FROM users').get().budget_max,1);
    assert.equal(db.sqlite.prepare('SELECT limit_micros FROM api_keys').get().limit_micros,null);
    for(const r of db.sqlite.prepare('SELECT image_capabilities FROM model_endpoints').all())assert.equal(JSON.parse(r.image_capabilities).pricing[0].cost_usd,'0.1');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n,0);
    assert.equal(plans.filter(p=>p.probe).length,4);
    assert.equal(seed.some(s=>/INSERT INTO request_(dispatch_intents|usage_)/.test(s.sql)),false);
  } finally {db.sqlite.close();}
});

test('six real handler cases validate partial/complete accounting and exact fixture cleanup',async t=>{
  const f=await setup(t,{composition:'staging',cost:0.1}),plans=recoveryImagePlans(f.fixture);
  for(const p of plans.filter(p=>p.probe)){const r=p.probeRow;f.db.sqlite.prepare('INSERT INTO system_config(key,value,description) VALUES(?,?,?)').run(r.key,r.value,r.description);}
  for(const p of plans){
    const r=await f.request(p.operation,{},undefined,p.header?{[IMAGE_STORAGE_FAULT_HEADER]:p.header}:{});
    assert.equal(r.status,200,JSON.stringify(f.messages));p.requestId=r.headers.get('X-Generation-Id');await r.body.cancel();await f.drain();
  }
  const observe=()=>Object.fromEntries(Object.entries(recoveryImageObservations(f.fixture)).map(([k,s])=>[k,f.db.sqlite.prepare(s.sql).all(...s.params).map(r=>({...r}))]));
  const before=observe();assertRecoveryImages(f.fixture,plans,before);
  for(const field of ['account','receipts','logs','audit','attempts','stats','snapshots']) {
    const changed=structuredClone(before);changed[field]=[];assert.throws(()=>assertRecoveryImages(f.fixture,plans,changed),field);
  }
  f.advance(31);assert.equal((await f.recover()).committed,2);
  const complete=observe();assertRecoveryImages(f.fixture,plans,complete,true);
  assert.equal(f.sends,6);assert.equal((await f.recover()).claimed,0);assert.deepEqual(observe(),complete);
  f.db.sqlite.prepare(f.fixture.revoke.sql).run(...f.fixture.revoke.params);
  for(const s of recoveryImageCleanup(f.fixture,plans))f.db.sqlite.prepare(s.sql).run(...s.params);
  assert.ok(Object.values(observe()).every(rows=>rows.length===0));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM model_endpoints').get().n,0);
  assert.deepEqual(f.db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('operator helpers refuse forged synthetic tenant identity',async t=>{
  const f=await setup(t),bad=structuredClone(f.fixture);bad.ids.user='another-user';
  for(const call of [()=>recoveryImagePlans(bad),()=>recoveryImageObservations(bad),()=>recoveryImageCleanup(bad,[]),()=>recoveryImageSeed(bad,[])])assert.throws(call);
});
