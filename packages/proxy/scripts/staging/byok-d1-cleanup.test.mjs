import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {byokCleanupFixture} from './byok-d1-cleanup-fixture.mjs';
import {BYOK_D1_CONTROL_KEY} from './byok-d1-one-shot.ts';
const {captureByokD1CleanupBaseline,createByokD1Cleanup,BYOK_CLEANUP_TABLES}=await import(process.env.BYOK_D1_CLEANUP_MODULE
  ?pathToFileURL(resolve(process.env.BYOK_D1_CLEANUP_MODULE)).href:new URL('./byok-d1-cleanup.ts',import.meta.url).href);
const destructive=items=>items.some(s=>s.sql.startsWith('DELETE '));
async function setup(t,n=10){
  t.mock.method(globalThis,'fetch',()=>{throw Error('External network forbidden');});
  const f=byokCleanupFixture();t.after(()=>f.close());const before=f.allRows();
  const baseline=await captureByokD1CleanupBaseline(f.raw,f.schemaSha256);await f.complete(n);
  const options={db:f.raw,baseline,runId:f.runId,assertProducerClosed:f.assertProducerClosed,persist:f.persist};
  return {...f,fixture:f,before,baseline,options,task:()=>createByokD1Cleanup(options)};
}
for(const n of [0,1,3,10])test('atomic cleanup of known completed prefix / '+n,async t=>{
  const f=await setup(t,n),task=f.task(),first=task.run();assert.equal(task.run(),first);const r=await first;
  assert.equal(r.result,'CLEANED',JSON.stringify(r));assert.equal(r.deleteAcknowledged,true);assert.equal(r.fixtureRemoved,true);
  assert.equal(r.nativeAcceptanceProved,false);assert.equal(f.fixture.closedCalls,3);assert.deepEqual(f.allRows(),f.before);
  const writes=f.batches.filter(b=>destructive(b.statements));assert.equal(writes.length,1);assert.equal(writes[0].state,'COMMITTED');
  assert.equal(writes[0].statements.filter(s=>s.sql.startsWith('DELETE ')).length,6);
  assert.ok(r.statementCount<=256);assert.ok(r.statementBytes<=1048576);assert.equal(BYOK_CLEANUP_TABLES.length,56);
  const serial=JSON.stringify(f.events);assert.ok(!serial.includes('enc:v2:'));assert.ok(!serial.includes('SELECT '));assert.ok(!serial.includes('tokenHash'));
  assert.equal(f.events[0].result,'PENDING');assert.equal(f.events.at(-1).result,'ACK');
  if(n===10){assert.equal(r.removedRows,664);t.diagnostic(JSON.stringify({statementCount:r.statementCount,statementBytes:r.statementBytes,removedRows:r.removedRows,localSchemaObjects:f.schema().length}));}
});
test('baseline refuses incomplete 51-table migration-only schema and wrong schema digest',async t=>{
  const f=byokCleanupFixture();t.after(()=>f.close());
  await assert.rejects(captureByokD1CleanupBaseline(f.raw,'f'.repeat(64)),/schema_mismatch/);
  for(const table of ['request_usage_recovery_jobs','request_usage_commit_receipts','request_usage_settlements','request_dispatch_intents','d1_migrations'])f.db.exec('DROP TABLE '+table);
  const current=f.schema(),digest=createHash('sha256').update(JSON.stringify(current)).digest('hex');
  assert.equal(current.filter(r=>r.type==='table'&&!r.name.startsWith('sqlite_')).length,51);
  await assert.rejects(captureByokD1CleanupBaseline(f.raw,digest),/all_tables/);
});

test('formal migrations69–77 cannot be relabelled as the frozen68 cleanup candidate',async t=>{
  const f=byokCleanupFixture();t.after(()=>f.close());
  assert.equal(f.counts().d1_migrations,68);assert.equal(BYOK_CLEANUP_TABLES.length,56);
  const directory=new URL('../../../core/migrations-d1/',import.meta.url);
  const later=readdirSync(directory).filter(name=>name.endsWith('.sql')&&Number(name.slice(0,4))>=69&&Number(name.slice(0,4))<=77).sort();
  assert.equal(later.length,9);
  for(const name of later){
    f.db.exec(readFileSync(new URL(name,directory),'utf8'));
    f.db.prepare('INSERT INTO d1_migrations(id,name) VALUES(?,?)').run(Number(name.slice(0,4)),name);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM d1_migrations').get().n,77);
  const before=f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  await assert.rejects(captureByokD1CleanupBaseline(f.raw,f.schemaSha256),/schema_mismatch/);
  const digest=createHash('sha256').update(JSON.stringify(f.schema())).digest('hex');
  await assert.rejects(captureByokD1CleanupBaseline(f.raw,digest),/all_tables/);
  assert.equal(f.batches.length,0);
  assert.deepEqual(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),before);
});
test('live legacy admin cannot establish a cleanup baseline',async t=>{
  const f=byokCleanupFixture();t.after(()=>f.close());f.db.exec("UPDATE admin_api_keys SET status='active'");
  await assert.rejects(captureByokD1CleanupBaseline(f.raw,f.schemaSha256),/legacy_admin_live/);
});
for(const state of ['ready','pending','failed','stopped-pending'])test('unresolved state quarantined / '+state,async t=>{
  const f=await setup(t,0);const row=f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY);
  const v=JSON.parse(row.value);v.state=state==='stopped-pending'?'stopped':state;if(state.includes('pending'))v.pendingCase='changes-contract';
  f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(JSON.stringify(v),BYOK_D1_CONTROL_KEY);
  const before=f.allRows(),r=await f.task().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,false);assert.deepEqual(f.allRows(),before);
});
for(const [name,mutate] of [
  ['user money',f=>f.db.prepare('UPDATE users SET budget_spent_micros=1 WHERE id=?').run(f.runId+'-0-u')],
  ['user metadata',f=>f.db.prepare('UPDATE users SET metadata=? WHERE id=?').run('foreign',f.runId+'-0-u')],
  ['workspace owner',f=>f.db.prepare("UPDATE workspaces SET personal_owner_user_id=?,slug='changed-owner' WHERE id=?").run(f.runId+'-1-u',f.runId+'-0-w')],
  ['management last use',f=>f.db.exec("UPDATE management_api_keys SET last_used_at=datetime('now')")],
  ['credential ciphertext',f=>f.db.prepare('UPDATE byok_keys SET api_key_encrypted=? WHERE id=?').run('enc:v2:foreign-ciphertext',f.runId+'-0-k101')],
  ['credential slot',f=>f.db.prepare('UPDATE byok_keys SET sort_order=7 WHERE id=?').run(f.runId+'-0-k101')],
  ['audit actor',f=>f.db.exec("UPDATE user_audit_logs SET actor_id='foreign'")],
  ['audit payload',f=>f.db.exec("UPDATE user_audit_logs SET change_payload='{}'")],
  ['static same-count drift',f=>f.db.exec("UPDATE system_config SET description='changed' WHERE key <> 'c02_byok_d1_acceptance_v1'")],
  ['extra dependent row',f=>f.db.prepare('INSERT INTO user_earnings(user_id) VALUES(?)').run(f.runId+'-0-u')],
  ['new schema object',f=>f.db.exec('CREATE TABLE unexpected (id TEXT PRIMARY KEY)')],
])test('full ownership/baseline rejection / '+name,async t=>{
  const f=await setup(t);mutate(f);const before=f.allRows(),r=await f.task().run();
  assert.equal(r.result,'ATTENTION_REQUIRED',JSON.stringify(r));assert.equal(r.deleteAttempted,false);assert.deepEqual(f.allRows(),before);
});
for(const fault of ['closure-initial','closure-fresh','pending-journal','post-closure','ack-journal'])test('control boundary / '+fault,async t=>{
  const f=await setup(t,1);
  f.hooks.closed=async n=>{if(n===({'closure-initial':1,'closure-fresh':2,'post-closure':3}[fault]))throw Error('not closed');};
  f.hooks.persist=async e=>{if(fault==='pending-journal'&&e.result==='PENDING'||fault==='ack-journal'&&e.result==='ACK')throw Error('journal failed');};
  const task=f.task(),r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');
  assert.equal(r.deleteAttempted,['post-closure','ack-journal'].includes(fault));await task.run();
  assert.equal(f.batches.filter(b=>destructive(b.statements)).length,r.deleteAttempted?1:0);
});
for(const fault of ['row-race','count-race','schema-race','post-row','post-count','delete-count'])test('same-transaction rollback / '+fault,async t=>{
  const f=await setup(t,1);let injected=false;
  f.hooks.beforeBatch=async items=>{if(!destructive(items))return;
    if(fault==='row-race')f.db.exec("UPDATE users SET metadata='raced'");
    if(fault==='count-race')f.db.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run('raced','1');
    if(fault==='schema-race')f.db.exec('CREATE TABLE raced_table (id TEXT)');
    if(fault==='delete-count')items.find(s=>s.sql.startsWith('DELETE FROM byok_keys')).values[0]='[]';
  };
  f.hooks.afterStatement=s=>{if(injected||!s.sql.startsWith('DELETE FROM users'))return;injected=true;
    if(fault==='post-row')f.db.exec("UPDATE admin_api_keys SET description='side effect'");
    if(fault==='post-count')f.db.prepare('INSERT INTO system_config(key,value) VALUES(?,?)').run('side effect','1');
  };
  const task=f.task(),r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,true);
  assert.equal(r.deleteAcknowledged,false);assert.equal(f.counts().users,1);assert.equal(f.counts().byok_keys,3);
  const write=f.batches.find(b=>destructive(b.statements));assert.equal(write.state,'ROLLED_BACK');await task.run();
  assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);
});
test('lost commit ACK is not replayed or relabelled as proved cleanup',async t=>{
  const f=await setup(t);f.hooks.afterBatch=async items=>{if(destructive(items))throw Error('ack lost');};
  const task=f.task(),r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,true);
  assert.equal(r.deleteAcknowledged,false);assert.equal(r.fixtureRemoved,false);assert.deepEqual(f.allRows(),f.before);
  await task.run();assert.equal(f.batches.filter(b=>destructive(b.statements)).length,1);
});
test('row egress bound refuses overlong data before returning it to cleanup code',async t=>{
  const f=await setup(t,1);f.db.exec("UPDATE users SET metadata='"+'x'.repeat(8193)+"'");
  const r=await f.task().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,false);
  assert.equal(f.counts().users,1);
});
test('valid failed receipt with an ambiguously committed seed remains quarantined after stop',async t=>{
  const f=byokCleanupFixture();t.after(()=>f.close());const baseline=await captureByokD1CleanupBaseline(f.raw,f.schemaSha256);
  f.arm();f.hooks.afterBatch=async items=>{if(items[0].sql.startsWith('INSERT INTO users'))throw Error('lost seed ACK');};
  assert.equal((await f.send('changes-contract')).status,500);assert.equal((await f.send('stop')).status,200);
  const before=f.allRows(),task=createByokD1Cleanup({db:f.raw,baseline,runId:f.runId,assertProducerClosed:f.assertProducerClosed,persist:f.persist});
  const r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,false);assert.deepEqual(f.allRows(),before);
  assert.equal(f.counts().users,1);assert.equal(f.counts().byok_keys,3);
});
test('large but valid control record remains compatible with the 32 KiB protocol bound',async t=>{
  const f=await setup(t,0),original=f.db.prepare('SELECT value FROM system_config WHERE key=?').get(BYOK_D1_CONTROL_KEY).value;
  f.db.prepare('UPDATE system_config SET value=? WHERE key=?').run(original+' '.repeat(32768-original.length),BYOK_D1_CONTROL_KEY);
  const r=await f.task().run();assert.equal(r.result,'CLEANED');assert.deepEqual(f.allRows(),f.before);
});
test('real cascading child present before cleanup is preserved, not implicitly deleted',async t=>{
  const f=await setup(t,1);
  f.db.prepare('INSERT INTO workspace_memberships(id,membership_key,workspace_id,subject) VALUES(?,?,?,?)')
    .run('foreign-member','b'.repeat(64),f.runId+'-0-w','foreign-subject');
  const before=f.allRows(),r=await f.task().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,false);
  assert.deepEqual(f.allRows(),before);assert.equal(f.counts().workspace_memberships,1);
});
test('dishonest delete metadata cannot turn a committed but unverified result into success',async t=>{
  const f=await setup(t,1);f.hooks.afterBatch=async(items,ack)=>{if(destructive(items))ack[items.findIndex(s=>s.sql.startsWith('DELETE FROM byok_keys'))].meta.changes=999;};
  const r=await f.task().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAcknowledged,false);assert.equal(r.fixtureRemoved,false);
  assert.deepEqual(f.allRows(),f.before);
});
test('closure becoming stale while persisting PENDING forbids deletion',async t=>{
  const f=await setup(t,1);let ms=0;t.mock.method(performance,'now',()=>ms);
  f.hooks.persist=async e=>{if(e.result==='PENDING')ms=15000;};
  const r=await f.task().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.deleteAttempted,false);
  assert.equal(f.counts().users,1);assert.equal(f.counts().byok_keys,3);
});
test('baseline returns only row digests and counters, and cleanup freezes its input copy',async t=>{
  const f=await setup(t,1),task=f.task();
  assert.deepEqual(Object.keys(f.baseline).sort(),['counts','preservedRowSha256','schemaSha256','version']);
  assert.ok(!JSON.stringify(f.baseline).includes('secret_key'));
  f.baseline.schemaSha256='f'.repeat(64);f.baseline.counts.users=500;
  const r=await task.run();assert.equal(r.result,'CLEANED');assert.deepEqual(f.allRows(),f.before);
});
