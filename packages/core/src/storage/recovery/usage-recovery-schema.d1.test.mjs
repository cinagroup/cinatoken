import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setup, sample, prepare, counts } from './usage-settlement-test-support.mjs';
import { runUsageRecoveryD1 } from './run-usage-recovery-d1.ts';
import { RECOVERY_SCHEMA_ARTIFACT as artifact } from './usage-recovery-schema-artifact.ts';
import { assertUsageRecoverySchemaD1, UsageRecoverySchemaError } from './usage-recovery-schema-d1.ts';
import { createRequestCapacityPool } from '../../../../proxy/src/services/request-capacity.ts';
import { readRecoveryMigrationSources, verifyRecoverySchemaArtifact } from '../../../../../scripts/deploy/verify-recovery-schema-artifact.mjs';
const proposal=readFileSync(new URL('../../../migrations-proposals/d1/request-usage-recovery-jobs.sql',import.meta.url),'utf8');
const options={scope:{kind:'all'},maxItems:5,concurrency:1,leaseSeconds:30,runBudgetMs:5000,reservedBytesPerConsumer:1024};
function fixture(t){const db=setup(t);db.sqlite.exec(proposal);return db;}
const latch=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const schemaSQL=sql=>sql.includes('FROM main.sqlite_master');
const capacity=()=>createRequestCapacityPool({maxRequests:1,maxReservedBytes:1024});
async function queued(db){const value=sample(0.25);await prepare(db,value);await db.repo.persist(value);return value;}

test('reviewed sources reconstruct 24 exact objects including ALTERed receipt and 7 autoindexes',async t=>{
  const check=verifyRecoverySchemaArtifact();assert.equal(check.objects,24);assert.equal(check.definitionBytes,10072);
  assert.equal(check.formalMigrations,77);assert.equal(readRecoveryMigrationSources().base.at(-1).name,'0077_withdrawal_balance_update_guards.sql');
  const db=fixture(t),before=db.sqlite.prepare('SELECT total_changes() AS n').get().n;let calls=0;
  db.hooks.beforeStatement=sql=>{assert.ok(schemaSQL(sql));calls++;};await assertUsageRecoverySchemaD1(db.binding);
  assert.equal(calls,1);assert.equal(db.sqlite.prepare('SELECT total_changes() AS n').get().n,before);
  assert.equal(artifact.objects.filter(row=>row.sha256===null).length,7);
  assert.ok(Object.isFrozen(artifact)&&Object.isFrozen(artifact.objects)&&artifact.objects.every(Object.isFrozen));
});
for(const mode of ['base-content','base-order','base-name','base-missing','base-head-content','base-head-name','base-extra','proposal-content','proposal-order','proposal-name','proposal-extra'])test('source artifact rejects drift before SQLite execution: '+mode,()=>{
  const input=readRecoveryMigrationSources();
  if(mode==='base-content')input.base[0].sql='invalid unreviewed SQL';
  if(mode==='base-order')input.base.reverse();if(mode==='base-name')input.base[0].name='other.sql';if(mode==='base-missing')input.base.pop();
  if(mode==='base-head-content')input.base.at(-1).sql+='\nSELECT 1;';if(mode==='base-head-name')input.base.at(-1).name='0076_unreviewed.sql';
  if(mode==='base-extra')input.base.push({name:'0077_unreviewed.sql',sql:'SELECT 1'});
  if(mode==='proposal-content')input.proposals[2].sql= input.proposals[2].sql.replace('lease_expires_at>unixepoch', 'lease_expires_at>=unixepoch');
  if(mode==='proposal-order')input.proposals.reverse();if(mode==='proposal-name')input.proposals[0].name='other.sql';
  if(mode==='proposal-extra')input.proposals.push({name:'extra.sql',sql:'SELECT 1'});
  assert.throws(()=>verifyRecoverySchemaArtifact(input),/source drift|count drift/);
});
for(const item of artifact.objects.filter(row=>row.type==='trigger'))test('same-name no-op trigger fails even though all nine required names exist: '+item.name,async t=>{
  const db=fixture(t);await queued(db);const before=counts(db),pool=capacity();
  db.sqlite.exec(`DROP TRIGGER ${item.name}; CREATE TRIGGER ${item.name} BEFORE INSERT ON ${item.table} BEGIN SELECT 1; END`);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ("+artifact.objects.filter(x=>x.type==='trigger').map(()=>'?').join(',')+")").get(...artifact.objects.filter(x=>x.type==='trigger').map(x=>x.name)).n,9);
  await assert.rejects(runUsageRecoveryD1(db.client,options,pool),UsageRecoverySchemaError);assert.deepEqual(counts(db),before);
  assert.equal(db.sqlite.prepare('SELECT attempts FROM request_usage_recovery_jobs').get().attempts,0);assert.equal(pool.snapshot().requests,0);
  assert.equal(db.sqlite.prepare("SELECT budget_spent_micros FROM users WHERE id='recovery-user'").get().budget_spent_micros,0);
});
for(const item of artifact.objects.filter(row=>row.type==='index'&&row.sha256))test('same-name wrong index definition rejected: '+item.name,async t=>{
  const db=fixture(t);db.sqlite.exec(`DROP INDEX ${item.name}; CREATE INDEX ${item.name} ON ${item.table}(request_id)`);
  await assert.rejects(assertUsageRecoverySchemaD1(db.binding),UsageRecoverySchemaError);
});
for(const table of artifact.tables)test('altered table definition rejected: '+table,async t=>{
  const db=fixture(t);db.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN unexpected TEXT`);
  await assert.rejects(assertUsageRecoverySchemaD1(db.binding),UsageRecoverySchemaError);
});
for(const [name,ddl] of [
  ['extra trigger',"CREATE TRIGGER unexpected BEFORE INSERT ON request_usage_settlements BEGIN SELECT 1; END"],
  ['extra index','CREATE INDEX unexpected ON request_usage_settlements(request_id)'],
  ['wrong trigger table',"DROP TRIGGER request_usage_settlements_immutable; CREATE TRIGGER request_usage_settlements_immutable BEFORE UPDATE ON users BEGIN SELECT 1; END"],
  ['missing trigger','DROP TRIGGER request_usage_recovery_fence'],
  ['format drift',"DROP TRIGGER request_usage_settlements_immutable; CREATE TRIGGER request_usage_settlements_immutable BEFORE UPDATE ON request_usage_settlements BEGIN SELECT RAISE(ABORT, 'Settlement snapshot is immutable'); END"],
])test('schema mismatch rejected: '+name,async t=>{const db=fixture(t);db.sqlite.exec(ddl);await assert.rejects(assertUsageRecoverySchemaD1(db.binding),UsageRecoverySchemaError);});
test('large SQL text and long object names are capped in SQL before returning to JS',async t=>{
  const db=fixture(t);db.sqlite.exec("CREATE TRIGGER "+'x'.repeat(1000)+" BEFORE INSERT ON request_usage_settlements BEGIN SELECT '"+'a'.repeat(100000)+"'; END");
  let result;
  const binding={prepare(sql){const statement=db.binding.prepare(sql);return{bind(...args){const bound=statement.bind(...args);return{async all(){result=await bound.all();return result;}};}};}};
  await assert.rejects(assertUsageRecoverySchemaD1(binding),UsageRecoverySchemaError);
  assert.equal(result.results.length,25);const extra=result.results.find(r=>r.object_name===null);assert.ok(extra);assert.equal(extra.definition,null);assert.ok(extra.sql_bytes>100000);
  assert.ok(JSON.stringify(result).length<16000);
});
test('more than one extra object cannot cause an unbounded metadata response',async t=>{
  const db=fixture(t);for(let n=0;n<100;n++)db.sqlite.exec(`CREATE INDEX extra_${n} ON request_usage_settlements(request_id)`);
  let seen=0;const binding={prepare(sql){const statement=db.binding.prepare(sql);return{bind(...args){const bound=statement.bind(...args);return{async all(){const result=await bound.all();seen=result.results.length;return result;}};}};}};
  await assert.rejects(assertUsageRecoverySchemaD1(binding),UsageRecoverySchemaError);assert.equal(seen,25);
});
test('unrelated objects are outside this recovery-only schema attestation',async t=>{
  const db=fixture(t);db.sqlite.exec('CREATE TABLE unrelated(id TEXT); CREATE INDEX unrelated_idx ON unrelated(id)');
  await assertUsageRecoverySchemaD1(db.binding);
});
test('successful schema check is never cached across invocations',async t=>{
  const db=fixture(t);await assertUsageRecoverySchemaD1(db.binding);db.sqlite.exec('DROP TRIGGER request_usage_recovery_fence');
  await assert.rejects(assertUsageRecoverySchemaD1(db.binding),UsageRecoverySchemaError);
});
test('equal-length lease predicate mutation is detected by digest, not names or byte counts',async t=>{
  const db=fixture(t),old=db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='request_usage_recovery_fence'").get().sql;
  const changed=old.replace('lease_expires_at>unixepoch','lease_expires_at<unixepoch');assert.notEqual(changed,old);assert.equal(Buffer.byteLength(changed),Buffer.byteLength(old));
  db.sqlite.exec('DROP TRIGGER request_usage_recovery_fence');db.sqlite.exec(changed);
  assert.equal(db.sqlite.prepare("SELECT length(CAST(sql AS BLOB)) AS n FROM sqlite_master WHERE name='request_usage_recovery_fence'").get().n,artifact.objects.find(x=>x.name==='request_usage_recovery_fence').bytes);
  await assert.rejects(assertUsageRecoverySchemaD1(db.binding),UsageRecoverySchemaError);
});
test('equal-length table CHECK weakening is detected with the same columns and autoindexes',async t=>{
  const db=setup(t),changed=proposal.replace('attempts BETWEEN 0 AND 5','attempts BETWEEN 0 AND 9');assert.notEqual(changed,proposal);
  db.sqlite.exec(changed);assert.equal(db.sqlite.prepare("SELECT length(CAST(sql AS BLOB)) AS n FROM sqlite_master WHERE name='request_usage_recovery_jobs'").get().n,artifact.objects.find(x=>x.name==='request_usage_recovery_jobs').bytes);
  await assert.rejects(assertUsageRecoverySchemaD1(db.binding),UsageRecoverySchemaError);
});
for(const [name,alter] of [
  ['false success',r=>r.success=false],['missing rows',r=>delete r.results],['duplicate row',r=>r.results[1]=r.results[0]],
  ['bad definition',r=>r.results[0].definition={}],['unbounded definition',r=>r.results[0].definition='x'.repeat(100000)],
  ['autoindex SQL',r=>r.results.find(x=>x.definition===null).definition='CREATE INDEX fake'],
  ['byte count lie',r=>r.results[0].sql_bytes++],['wrong object type',r=>r.results[0].object_type='view'],
])test('malformed metadata result is rejected: '+name,async t=>{
  const db=fixture(t);const binding={prepare(sql){const statement=db.binding.prepare(sql);return{bind(...args){const bound=statement.bind(...args);return{async all(){const r=await bound.all();alter(r);return r;}};}};}};
  await assert.rejects(assertUsageRecoverySchemaD1(binding),UsageRecoverySchemaError);
});
test('schema IO starts after capacity acquisition and retains hold across deadline/abort',async t=>{
  const db=fixture(t);await queued(db);const entered=latch(),release=latch(),pool=capacity(),abort=new AbortController();let now=0,settled=false,reads=0;
  db.hooks.afterStatement=async sql=>{assert.ok(schemaSQL(sql));reads++;assert.equal(pool.snapshot().requests,1);entered.resolve();await release.promise;};
  const task=runUsageRecoveryD1(db.client,options,pool,{signal:abort.signal,now:()=>now}).finally(()=>settled=true);
  await entered.promise;abort.abort();now=5001;await Promise.resolve();assert.equal(settled,false);assert.equal(pool.snapshot().reservedBytes,1024);
  release.resolve();const result=await task;assert.equal(reads,1);assert.equal(result.scanned,0);assert.equal(result.claimed,0);assert.equal(result.admissionStopped,true);assert.equal(pool.snapshot().requests,0);
});
test('metadata read failure redacts raw error, returns capacity, and performs no writes',async t=>{
  const db=fixture(t);await queued(db);const pool=capacity(),before=counts(db);
  db.hooks.beforeStatement=()=>{throw new Error('private SQL credential marker');};
  await assert.rejects(runUsageRecoveryD1(db.client,options,pool),error=>error instanceof UsageRecoverySchemaError&&!String(error).includes('private'));
  assert.equal(pool.snapshot().requests,0);assert.deepEqual(counts(db),before);
});
