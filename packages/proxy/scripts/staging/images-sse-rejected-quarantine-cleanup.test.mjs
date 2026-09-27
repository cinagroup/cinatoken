import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createSqliteD1} from '../../src/test-support/sqlite-d1.ts';
import {imageSseFixture} from '../../../../scripts/deploy/staging-image-sse-fixture.mjs';
import {canonicalSseOperatorRow} from '../../../../scripts/deploy/staging-sse-operator-fixture.mjs';
import {sseSnapshotFaultRow} from './images-sse-snapshot-fault-v2.ts';
import {sseCancelObservationRow} from './images-sse-cancel-observer.ts';
import {createSseOperatorClock} from '../../../../scripts/deploy/staging-sse-operator-clock.mjs';
import {createRejectedSseQuarantineCleanup} from '../../../../scripts/deploy/staging-sse-rejected-quarantine-cleanup.mjs';

async function setup(t,fault){
  t.mock.method(globalThis,'fetch',()=>{throw Error('No external network');});
  const db=createSqliteD1();t.after(()=>db.sqlite.close());
  // Wrangler owns this bookkeeping table remotely; the lightweight test D1
  // applies migrations directly. Model the extra unrelated table explicitly.
  db.sqlite.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  for(const name of ['request-dispatch-intents','request-usage-settlements','request-usage-recovery-jobs'])db.sqlite.exec(readFileSync(new URL(`../../../core/migrations-proposals/d1/${name}.sql`,import.meta.url),'utf8'));
  const count=()=>Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.sqlite.prepare('SELECT COUNT(*) n FROM '+name).get().n]));
  const baselineCounts=count();assert.equal(Object.keys(baselineCounts).length,56);
  const runId='c02-success-'+randomUUID(),plan={runId,keyHash:'sha256:'+'a'.repeat(64),expiresAt:new Date(Date.now()+3600000).toISOString(),plans:[]};
  const p={mode:'after-hold',snapshot:{runId,mode:'after-hold',probeId:randomUUID()},upstream:{runId,mode:'success',probeId:randomUUID()}};plan.plans=[p];
  const fixture=await imageSseFixture(runId,plan.keyHash,plan.expiresAt),probes=[sseSnapshotFaultRow(p.snapshot),canonicalSseOperatorRow(p.upstream),sseCancelObservationRow(p.snapshot)].sort((a,b)=>a.key<b.key?-1:1);
  for(const s of fixture.seed)db.sqlite.prepare(s.sql).run(...s.params);
  for(const r of probes)db.sqlite.prepare('INSERT INTO system_config (key,value,description) VALUES (?,?,?)').run(r.key,r.value,r.description);
  db.sqlite.prepare(fixture.revoke.sql).run(...fixture.revoke.params);
  const seedRows=fixture.seed.map(s=>{const m=/^INSERT INTO ([a-z_]+) \(([^)]+)\)/.exec(s.sql),names=m[2].split(',');const pairs=names.map((n,i)=>[n,s.params[i]]);
    return {table:m[1],row:{...db.sqlite.prepare('SELECT * FROM '+m[1]+' WHERE '+pairs.map(([n])=>n+' IS ?').join(' AND ')).get(...pairs.map(([,v])=>v))}};});
  const schema=db.sqlite.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513').all().map(r=>({...r}));
  const reference={result:'PASS',runId,armedProbesVerified:true,seedRows,probes,counts:count(),schema:{objects:schema.length,sha256:createHash('sha256').update(JSON.stringify(schema)).digest('hex')}};
  const run={result:'ATTENTION_REQUIRED',run:{primarySends:1,seedAcknowledged:true,finalIsolationVerified:true,
    finalization:{accessClosed:true,tailAbsent:true,keyRevoked:true,recoveryAttempts:0,fixtureRemoved:false,errors:['primary-finish','native-proof']},
    coordinator:{journal:{runId,keyHash:plan.keyHash,expiresAt:plan.expiresAt,requests:[{responseStatus:409,id:null,mode:'after-hold',timing:{},probeId:p.snapshot.probeId,upstreamProbeId:p.upstream.probeId}]}}}};
  let ms=0,closedCalls=0,writeCalls=0;const events=[],waits=[],batches=[];
  const clock=createSseOperatorClock({readNs:()=>BigInt(ms)*1000000n,sleep:async n=>{ms+=n;waits.push(n);if(fault==='armed-after-wait')db.sqlite.prepare('UPDATE system_config SET value=? WHERE key=?').run('{}',probes[0].key);
    if(fault==='probe-metadata-after-wait')db.sqlite.prepare('UPDATE system_config SET updated_at=? WHERE key=?').run('changed',probes[0].key);}});
  const batch=async(statements,{write})=>{
    batches.push({statements:structuredClone(statements),write});
    if(write){writeCalls++;assert.ok(ms>=350001);assert.ok(statements.length<=256);assert.ok(statements.every(s=>!/^DELETE FROM (request_|api_key_request_logs|user_budget)/.test(s.sql)));
      if(fault==='budget-race')db.sqlite.prepare('UPDATE users SET budget_spent_micros=1 WHERE id=?').run(fixture.ids.user);
      if(fault==='schema-race')db.sqlite.exec('CREATE TABLE unexpected_schema_change (id TEXT)');
      if(fault==='row-race')db.sqlite.prepare('UPDATE providers SET description=? WHERE id=?').run('different',fixture.ids.providers[0]);
      if(fault==='count-race')db.sqlite.prepare('INSERT INTO system_config (key,value) VALUES (?,?)').run('racer','1');
    }
    db.sqlite.exec('BEGIN');try{const rows=statements.map(s=>{
      if(/^SELECT /.test(s.sql))return db.sqlite.prepare(s.sql).all(...s.params).map(r=>({...r}));
      db.sqlite.prepare(s.sql).run(...s.params);
      // A modeled in-transaction unexpected side effect must be rolled back by
      // the postcondition, not merely noticed by a later read after COMMIT.
      if(fault==='postcondition'&&s.sql.startsWith('DELETE FROM users '))db.sqlite.prepare('INSERT INTO system_config (key,value) VALUES (?,?)').run('side-effect','1');
      return [];
    });db.sqlite.exec('COMMIT');
      if(write&&fault==='ack-lost')throw Error('unknown acknowledgement');return rows;
    }catch(error){try{db.sqlite.exec('ROLLBACK');}catch{}throw error;}
  };
  const checkClosed=async()=>{closedCalls++;return Object.fromEntries(['stagingIdentity','versionAndModule','ingressClosed','accessClosed','tailAbsent','tokenAbsent','productionUnchanged','billingAllowed'].map(k=>[k,!((fault==='closure-before'||(fault==='closure-after'&&closedCalls===2))&&k==='accessClosed')]));};
  const persist=async e=>{events.push(e);if(fault==='journal-before-delete'&&e.step==='quarantine-delete'&&e.result==='PENDING')throw Error('disk full');};
  const input={reference,run,plan,baselineCounts,clock,checkClosed,batch,persist};
  return {input,db,fixture,events,waits,batches,count,get writeCalls(){return writeCalls;},get closedCalls(){return closedCalls;},go(){return createRejectedSseQuarantineCleanup(input);}};
}

test('quarantine cleanup uses actual SQLite atomic guards and fresh 350s wait, preserving sent/unknown status',async t=>{
  const f=await setup(t),task=f.go(),a=task.run();assert.equal(task.run(),a);const r=await a;
  assert.equal(r.result,'CLEANED_QUARANTINE');assert.equal(r.primarySends,1);assert.equal(r.nativeProof,false);assert.equal(r.experimentPassed,false);assert.equal(r.fixtureRemoved,true);assert.equal(r.removedRows,31);
  assert.deepEqual(f.count(),f.input.baselineCounts);assert.equal(f.writeCalls,1);assert.equal(f.closedCalls,2);assert.ok(f.waits.every(n=>n<=20000));
  const writes=f.batches.find(b=>b.write).statements;assert.equal(writes.filter(s=>s.sql.startsWith('DELETE ')).length,31);assert.ok(writes[0].sql.includes('sqlite_master'));
});
for(const fault of ['closure-before','closure-after','armed-after-wait','probe-metadata-after-wait','journal-before-delete'])test('quarantine keeps all rows on '+fault,async t=>{
  const f=await setup(t,fault),r=await f.go().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(f.writeCalls,0);assert.equal(f.count().users,1);assert.equal(r.fixtureRemoved,false);
});
for(const fault of ['budget-race','schema-race','row-race','count-race','postcondition'])test('same-transaction guards roll back every deletion on '+fault,async t=>{
  const f=await setup(t,fault),task=f.go(),r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(f.writeCalls,1);assert.equal(r.deleteAcknowledged,undefined);assert.equal(f.count().users,1);assert.equal(f.count().model_endpoint_routes,5);await task.run();assert.equal(f.writeCalls,1);
});
test('lost deletion ACK is never replayed or promoted to proven cleanup',async t=>{
  const f=await setup(t,'ack-lost'),task=f.go(),r=await task.run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(r.fixtureRemoved,false);assert.equal(f.writeCalls,1);assert.deepEqual(f.count(),f.input.baselineCounts);await task.run();assert.equal(f.writeCalls,1);
});
for(const [label,change] of [
  ['not 409',i=>i.run.run.coordinator.journal.requests[0].responseStatus=500],
  ['generation exists',i=>i.run.run.coordinator.journal.requests[0].id='gen-known'],
  ['unsent relabel',i=>i.run.run.primarySends=0],
  ['recovery attempted',i=>i.run.run.finalization.recoveryAttempts=1],
  ['journal failure',i=>i.run.run.finalization.errors.push('journal')],
  ['foreign owner',i=>i.reference.seedRows.find(r=>r.table==='users').row.id='foreign'],
  ['live key',i=>i.reference.seedRows.find(r=>r.table==='api_keys').row.status='active'],
  ['nonempty financial baseline',i=>i.baselineCounts.request_dispatch_intents=1],
  ['changed canonical probe',i=>i.reference.probes[0].value='{}'],
  ['missing full row field',i=>delete i.reference.seedRows.find(r=>r.table==='users').row.updated_at],
])test('quarantine rejects '+label,async t=>{
  const f=await setup(t);change(f.input);const r=await f.go().run();assert.equal(r.result,'ATTENTION_REQUIRED');assert.equal(f.writeCalls,0);assert.equal(f.count().users,1);
});
