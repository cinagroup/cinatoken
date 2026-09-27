import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { imageSuccessFixture, successJsonWire, successMultipartWire } from './staging-image-success-fixture.mjs';

test('success fixture uses unique synthetic IDs, zero budgets, hash-only auth, bound endpoints and exact cleanup', async () => {
  const run='c02-success-00000000-0000-0000-0000-000000000001',hash='sha256:'+'a'.repeat(64);
  const f=await imageSuccessFixture(run,hash,'2026-09-07T10:00:00.000Z');
  assert.equal(f.seed.length,27);assert.equal(f.ids.models.length,5);assert.equal(f.ids.providers.length,4);
  assert.equal(f.seed[0].params[2],0);assert.ok(f.seed[2].params.includes('hashref:'+hash));assert.equal(f.seed[2].params.at(-1),0);
  const links=f.seed.filter(s=>s.sql.startsWith('INSERT INTO model_endpoint_routes '));assert.equal(links.length,5);
  for(const s of links)assert.match(s.params.at(-1),/^[a-f0-9]{64}$/);
  for(const s of f.seed){assert.equal((s.sql.match(/\?/g)||[]).length,s.params.length);assert.ok(!s.params.includes(undefined));}
  for(const s of [...f.cleanup,f.revoke]){assert.match(s.sql,/ WHERE /);assert.ok(s.params.some(p=>typeof p==='string'&&p.startsWith(run)));}
  await assert.rejects(imageSuccessFixture('production',hash,'2026-09-07T10:00:00.000Z'));
  await assert.rejects(imageSuccessFixture(run,'plaintext-key','2026-09-07T10:00:00.000Z'));
});

test('success request fixtures stream the exact declared byte count in bounded chunks', () => {
  for(const wire of [successJsonWire('fixture-model'),successJsonWire('fixture-model',50*1024**2),successMultipartWire('fixture-model',20*1024**2)]) {
    let bytes=0;for(const chunk of wire.chunks()){assert.ok(chunk.length<=65536);bytes+=chunk.length;}assert.equal(bytes,wire.bytes);
  }
  assert.throws(()=>successJsonWire('m',1));assert.throws(()=>successMultipartWire('m',20*1024**2+1));
});

test('all migrations accept the fixture; cleanup is idempotent and preserves an unrelated fixture and its logs', async () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const directory=new URL('../../packages/core/migrations-d1/',import.meta.url);
    for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(name,directory),'utf8'));
    const make=c=>imageSuccessFixture('c02-success-'+c.repeat(8)+'-1111-4111-8111-'+c.repeat(12),'sha256:'+c.repeat(64),'2026-09-07T12:00:00.000Z');
    const own=await make('a'),other=await make('b');
    const run=statements=>statements.forEach(({sql,params})=>db.prepare(sql).run(...params));
    for(const f of [own,other]) {
      run(f.seed);
      db.prepare("INSERT INTO api_key_request_logs(id,user_id,api_key_id,workspace_id,model_id,status) VALUES(?,?,?,?,?,'success')").run(f.ids.runId,f.ids.user,f.ids.key,f.ids.workspace,f.ids.models[0]);
      db.prepare("INSERT INTO provider_attempt_availability(request_log_id,attempt_index,route_target_id,provider_id,outcome,reason,observed_at) VALUES(?,1,?,?,'available','accepted','2026-09-07')").run(f.ids.runId,f.ids.routes[0],f.ids.providers[0]);
      db.prepare("INSERT INTO public_model_daily_stats(stat_date,model_id,shard,request_count) VALUES('2026-09-07',?,0,1)").run(f.ids.models[0]);
    }
    const unrelated=db.prepare('SELECT * FROM api_keys WHERE id=?').get(other.ids.key);
    run([own.revoke]);assert.equal(db.prepare('SELECT status FROM api_keys WHERE id=?').get(own.ids.key).status,'revoked');
    run(own.cleanup);run(own.cleanup);
    assert.deepEqual(db.prepare('SELECT * FROM api_keys WHERE id=?').get(other.ids.key),unrelated);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM models').get().n,5);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM providers').get().n,4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM api_key_request_logs').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_attempt_availability').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM public_model_daily_stats').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.close();}
});
