import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setup, prepare, sample, counts } from './usage-settlement-test-support.mjs';
import { createUsageRecoveryJobsD1 } from './usage-recovery-jobs-d1.ts';
import { runUsageRecoveryD1 } from './run-usage-recovery-d1.ts';
import { insertRequestUsageAndChargeTxD1 } from '../../db/d1/critical-writes.impl.ts';
import { createRequestCapacityPool } from '../../../../proxy/src/services/request-capacity.ts';

const proposal = readFileSync(new URL('../../../migrations-proposals/d1/request-usage-recovery-jobs.sql', import.meta.url), 'utf8');
const all = { kind: 'all' };
// Synthetic logical reservation ONLY, not a Workers memory profile.
const options = { scope: all, maxItems: 50, concurrency: 2, leaseSeconds: 10, runBudgetMs: 10000, reservedBytesPerConsumer: 1024 };
const pool = (n = 2) => createRequestCapacityPool({ maxRequests: n, maxReservedBytes: n * 1024 });
const claimSQL = sql => sql.startsWith('UPDATE request_usage_recovery_jobs SET') && sql.includes('attempts=MIN');
function fixture(t) {
  const db = setup(t), clock = { seconds: 2000000000 };
  // Replace only this test connection's DB clock; production uses SQLite's UTC clock.
  db.sqlite.function('unixepoch', { varargs: true }, () => clock.seconds);
  db.sqlite.exec(proposal);
  return { ...db, clock, jobs: createUsageRecoveryJobsD1(db.binding) };
}
async function enqueue(db, cost = 0) {
  const value = sample(cost); await prepare(db, value);
  return { value, ref: await db.repo.persist(value) };
}
async function claimOne(db) {
  const candidate = (await db.jobs.scanDue(all, 1))[0]; assert.ok(candidate);
  const claim = await db.jobs.claim(candidate, 10); assert.equal(claim.status, 'claimed'); return claim.lease;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function account(db) { return db.sqlite.prepare("SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id='recovery-user'").get(); }

test('68 formal migrations plus local proposals preserve constraints and atomic snapshot enqueue', async t => {
  const db = fixture(t); assert.equal(db.migrationFiles.length, 68);
  const v = sample(); await prepare(db, v);
  db.sqlite.exec("CREATE TRIGGER reject_test_job BEFORE INSERT ON request_usage_recovery_jobs BEGIN SELECT RAISE(ABORT,'test'); END");
  await assert.rejects(db.repo.persist(v));
  assert.equal(counts(db).request_usage_settlements, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM request_usage_recovery_jobs').get().n, 0);
  db.sqlite.exec('DROP TRIGGER reject_test_job');
  const ref = await db.repo.persist(v), row = await db.jobs.inspect(ref);
  assert.equal(row.state, 'pending'); assert.equal(row.revision, 0); assert.equal(row.attempts, 0);
  assert.equal(row.available_at, db.clock.seconds);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});

test('backfill separates accepted receipts from pending and orphaned receipts without accounting replay', async t => {
  const db = setup(t), pending = await enqueue(db), complete = await enqueue(db, 0.25), orphan = await enqueue(db);
  await db.repo.commit(complete.ref);
  db.sqlite.prepare('INSERT INTO request_usage_commit_receipts VALUES(?,?,?)').run(orphan.ref.requestId, orphan.ref.payloadSha256, orphan.value.recordedAtIso);
  const before = counts(db); db.sqlite.exec(proposal);
  const jobs = createUsageRecoveryJobsD1(db.binding);
  assert.equal((await jobs.inspect(complete.ref)).state, 'committed');
  assert.equal((await jobs.inspect(pending.ref)).state, 'pending'); assert.equal((await jobs.inspect(orphan.ref)).state, 'pending');
  assert.deepEqual(counts(db), before); assert.equal(account(db).budget_spent_micros, 250000);
});

test('exact tenant scans are indexed, bounded and contain no settlement bodies', async t => {
  const db = fixture(t), { ref } = await enqueue(db);
  for (const scope of [{ kind: 'tenant', userId: 'other-user', workspaceId: 'recovery-workspace' },
    { kind: 'tenant', userId: 'recovery-user', workspaceId: 'other-workspace' }]) assert.deepEqual(await db.jobs.scanDue(scope, 5), []);
  const rows = await db.jobs.scanDue({ kind: 'tenant', userId: ref.userId, workspaceId: ref.workspaceId }, 1);
  assert.deepEqual(rows, [{ ref, revision: 0 }]); assert.equal(Object.isFrozen(rows[0].ref), true);
  for (const [clause, index] of [['', 'request_usage_recovery_due'],
    ["user_id='recovery-user' AND workspace_id='recovery-workspace' AND ", 'request_usage_recovery_tenant_due']]) {
    const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT request_id FROM request_usage_recovery_jobs WHERE ${clause}state IN ('pending','leased') AND available_at<=unixepoch('now') ORDER BY available_at,request_id LIMIT 50`).all();
    assert.ok(plan.some(r => r.detail.includes(index)), JSON.stringify(plan));
    assert.ok(!plan.some(r => r.detail.includes('TEMP B-TREE')));
  }
  for (const n of [0,51,1.5,Infinity]) await assert.rejects(db.jobs.scanDue(all,n), /limit/);
  await assert.rejects(db.jobs.scanDue({},1), /scope/);
});

for (const cost of [0,0.25]) test('independent bounded runner settles original event exactly once: ' + cost, async t => {
  const db = fixture(t), { ref, value } = await enqueue(db,cost), capacity = pool();
  const results = await Promise.all(Array.from({ length: 6 }, () => runUsageRecoveryD1(db.client, options, capacity)));
  assert.equal(results.reduce((sum,r) => sum+r.committed,0),1);
  assert.equal((await db.jobs.inspect(ref)).state,'committed'); assert.equal(capacity.snapshot().requests,0);
  assert.deepEqual(counts(db), {request_usage_settlements:1,request_usage_commit_receipts:1,api_key_request_logs:1,provider_attempt_availability:1,user_audit_logs:cost>0?1:0});
  assert.equal(account(db).budget_spent_micros,cost*1e6); assert.equal(account(db).budget_reserved_micros,0);
  assert.equal(db.sqlite.prepare('SELECT created_at FROM api_key_request_logs').get().created_at,value.recordedAtIso);
  assert.equal((await runUsageRecoveryD1(db.client,options,capacity)).scanned,0);
});

test('single CAS claim winner; wrong scope, digest and stale revision never gain ownership', async t => {
  const db = fixture(t); await enqueue(db); const c = (await db.jobs.scanDue(all,1))[0];
  for (const ref of [{...c.ref,userId:'other-user'},{...c.ref,workspaceId:'other-workspace'}, {...c.ref,apiKeyId:'other-key'}, {...c.ref,payloadSha256:'b'.repeat(64)}]) {
    assert.equal((await db.jobs.claim({...c,ref},10)).status,'not_claimed');
  }
  const results = await Promise.all(Array.from({length:10},()=>db.jobs.claim(c,10)));
  assert.equal(results.filter(r=>r.status==='claimed').length,1);
  assert.equal((await db.jobs.claim(c,10)).status,'not_claimed');
  assert.deepEqual(await db.jobs.scanDue(all,50),[]);
});

test('SQL rejects identity mutation, null lease shapes, unfenced completion and terminal reopening', async t => {
  const db=fixture(t), {ref}=await enqueue(db), lease=await claimOne(db);
  for(const change of ["user_id='other-user'",'revision=revision', 'lease_token=NULL',
    'available_at=NULL', "state='committed',lease_token=NULL,lease_expires_at=NULL,available_at=NULL",
    "state='pending',lease_token=NULL,lease_expires_at=NULL,available_at=unixepoch('now')+5,last_error=NULL"]) {
    const set=change.startsWith('revision=') ? change : 'revision=revision+1,'+change;
    assert.throws(()=>db.sqlite.exec('UPDATE request_usage_recovery_jobs SET '+set), /transition|constraint/i);
  }
  assert.equal(await db.jobs.fail(lease,'snapshot_invalid'),'blocked');
  assert.throws(()=>db.sqlite.exec("UPDATE request_usage_recovery_jobs SET revision=revision+1,state='pending',attempts=0,available_at=unixepoch('now')"), /transition/);
  assert.equal((await db.jobs.inspect(ref)).state,'blocked'); assert.equal(counts(db).request_usage_commit_receipts,0);
});

test('invalid stored payload is quarantined with a fixed reason, without economic writes', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25);
  // Deliberate test-only corruption, not a supported operational mutation.
  const immutableSql=db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='request_usage_settlements_immutable'").get().sql;
  db.sqlite.exec('DROP TRIGGER request_usage_settlements_immutable');
  db.sqlite.exec("UPDATE request_usage_settlements SET payload_json='{}'");
  // Isolate payload validation from schema validation: restore the exact definition.
  db.sqlite.exec(immutableSql);
  const result=await runUsageRecoveryD1(db.client,options,pool());
  assert.equal(result.blocked,1); assert.equal((await db.jobs.inspect(ref)).last_error,'snapshot_invalid');
  assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(account(db).budget_spent_micros,0);
  assert.equal(account(db).budget_reserved_micros,500000);
});

test('scan limit bounds work and admission reserves before loading scalar references', async t => {
  const db=fixture(t); for(let n=0;n<5;n++) await enqueue(db);
  const capacity=pool(2), input={...options,maxItems:3,concurrency:4}; let scans=0, peak=0;
  db.hooks.beforeStatement=sql=>{
    peak=Math.max(peak,capacity.snapshot().requests);
    if(sql.includes('FROM request_usage_recovery_jobs') && sql.includes('ORDER BY')) {
      scans++; assert.equal(capacity.snapshot().reservedBytes,2048);
      assert.ok(!sql.includes('payload_json')); input.maxItems=50; input.concurrency=1;
    }
  };
  const result=await runUsageRecoveryD1(db.client,input,capacity);
  assert.equal(result.scanned,3); assert.equal(result.committed,3); assert.equal(result.capacityLimited,true);
  assert.equal(scans,1); assert.equal(peak,2); assert.equal(capacity.snapshot().requests,0);
  db.hooks.beforeStatement=undefined; assert.equal((await db.jobs.scanDue(all,50)).length,2);
});

test('expired and superseded leases are fenced inside accounting, including legacy unfenced commit', async t => {
  const db = fixture(t), {ref} = await enqueue(db,0.25), old = await claimOne(db);
  await assert.rejects(db.repo.commit(ref), /lease invalid/);
  db.clock.seconds=old.expiresAtSeconds;
  await assert.rejects(db.repo.commit(ref,old.proof), /lease invalid/);
  const current=await claimOne(db); assert.equal(current.revision,old.revision+1);
  await assert.rejects(db.repo.commit(ref,old.proof), /lease invalid/);
  assert.equal(await db.jobs.fail(old,'execution_error'),'not_owned');
  assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(account(db).budget_spent_micros,0);
  assert.equal(await db.repo.commit(ref,current.proof),'committed');
  assert.equal(await db.repo.commit(ref,old.proof),'committed'); // read-only proof of the same committed event
  assert.equal(await db.jobs.fail(current,'execution_error'),'not_owned'); assert.equal(account(db).budget_spent_micros,250000);
});

test('DB clock at actual batch commit rejects lease that expired during prior reads', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25), lease=await claimOne(db);
  db.hooks.beforeStatement=sql=>{ if(sql.startsWith('INSERT INTO request_usage_commit_receipts')) db.clock.seconds=lease.expiresAtSeconds; };
  await assert.rejects(db.repo.commit(ref,lease.proof), /lease invalid/);
  assert.equal(counts(db).api_key_request_logs,0); assert.equal(account(db).budget_spent_micros,0);
  db.hooks.beforeStatement=undefined;
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).committed,1);
});

test('snapshot ACK loss leaves an atomic discoverable pending job', async t => {
  const db=fixture(t);
  db.hooks.afterStatement=sql=>{if(sql.startsWith('INSERT INTO request_usage_settlements')) throw new Error('test ACK loss');};
  const {ref}=await enqueue(db);
  assert.equal((await db.jobs.inspect(ref)).state,'pending');
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).committed,1);
});

for (const boundary of ['before','after']) test('uncertain claim never grants execution and is recoverable: '+boundary, async t => {
  const db=fixture(t), {ref}=await enqueue(db), c=(await db.jobs.scanDue(all,1))[0];
  db.hooks[boundary==='before'?'beforeStatement':'afterStatement']=sql=>{if(claimSQL(sql)) throw new Error('claim interrupted');};
  await assert.rejects(db.jobs.claim(c,10), /acknowledgement uncertain/);
  db.hooks.beforeStatement=undefined; db.hooks.afterStatement=undefined;
  const row=await db.jobs.inspect(ref); assert.equal(row.state,boundary==='before'?'pending':'leased');
  assert.equal(counts(db).api_key_request_logs,0);
  if(boundary==='after') { assert.deepEqual(await db.jobs.scanDue(all,1),[]); db.clock.seconds=row.lease_expires_at; }
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).committed,1);
});

test('five lost claim ACKs exhaust recovery attempts without inference or invented money', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25);
  db.hooks.afterStatement=sql=>{if(claimSQL(sql)) throw new Error('lost');};
  for(let i=1;i<=5;i++) {
    assert.equal((await runUsageRecoveryD1(db.client,options,pool())).uncertain,1);
    const row=await db.jobs.inspect(ref); assert.equal(row.attempts,i); db.clock.seconds=row.lease_expires_at;
  }
  db.hooks.afterStatement=undefined;
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).blocked,1);
  assert.equal((await db.jobs.inspect(ref)).last_error,'retry_exhausted');
  assert.equal(counts(db).api_key_request_logs,0); assert.equal(account(db).budget_spent_micros,0);
  assert.equal(account(db).budget_reserved_micros,500000); assert.deepEqual(await db.jobs.scanDue(all,50),[]);
});

test('failed accounting rolls back completion and money; bounded backoff ends in blocked state', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25);
  db.hooks.beforeStatement=sql=>{if(sql.startsWith('INSERT INTO user_audit_logs')) throw new Error('secret-do-not-store');};
  for(let attempt=1;attempt<=5;attempt++) {
    const result=await runUsageRecoveryD1(db.client,options,pool()), row=await db.jobs.inspect(ref);
    assert.equal(row.attempts,attempt); assert.equal(counts(db).api_key_request_logs,0);
    assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(account(db).budget_spent_micros,0);
    assert.equal(account(db).budget_reserved_micros,500000);
    if(attempt<5) {
      assert.equal(result.deferred,1); assert.equal(row.last_error,'execution_error');
      assert.equal(row.available_at,db.clock.seconds+5*2**(attempt-1));
      assert.deepEqual(await db.jobs.scanDue(all,50),[]); db.clock.seconds=row.available_at;
    } else { assert.equal(result.blocked,1); assert.equal(row.last_error,'retry_exhausted'); }
  }
  db.hooks.beforeStatement=undefined;
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).scanned,0);
});

test('one transient failure can recover on a new lease after backoff', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25);
  db.hooks.beforeStatement=sql=>{if(sql.startsWith('INSERT INTO api_key_request_logs')) throw new Error('transient');};
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).deferred,1);
  db.clock.seconds=(await db.jobs.inspect(ref)).available_at; db.hooks.beforeStatement=undefined;
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).committed,1);
  assert.equal((await db.jobs.inspect(ref)).attempts,2); assert.equal(account(db).budget_spent_micros,250000);
});

test('lost defer ACK is not reported as acknowledged and does not erase the durable backoff', async t => {
  const db=fixture(t), {ref}=await enqueue(db);
  db.hooks.beforeStatement=sql=>{if(sql.startsWith('INSERT INTO api_key_request_logs')) throw new Error('test');};
  db.hooks.afterStatement=sql=>{if(sql.startsWith('UPDATE request_usage_recovery_jobs SET')&&!claimSQL(sql)) throw new Error('lost defer ACK');};
  const result=await runUsageRecoveryD1(db.client,options,pool());
  assert.equal(result.uncertain,1); assert.equal(result.deferred,0);
  const row=await db.jobs.inspect(ref); assert.equal(row.state,'pending'); assert.equal(row.last_error,'execution_error');
  db.hooks.beforeStatement=undefined; db.hooks.afterStatement=undefined; db.clock.seconds=row.available_at;
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).committed,1);
});

test('legacy financial log without receipt is blocked for reconciliation, never charged again', async t => {
  const db=fixture(t), {ref,value}=await enqueue(db,0.25);
  await insertRequestUsageAndChargeTxD1(db.client,value.params);
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).blocked,1);
  assert.equal((await db.jobs.inspect(ref)).last_error,'settlement_conflict');
  assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(account(db).budget_spent_micros,250000);
});

test('lost final ACK plus failed confirmation still atomically completes job and money once', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25);
  db.hooks.afterBatch=()=>{
    db.hooks.beforeStatement=sql=>{if(sql.includes('FROM request_usage_commit_receipts')) throw new Error('readback unavailable');};
    throw new Error('lost batch ACK');
  };
  const result=await runUsageRecoveryD1(db.client,options,pool()); assert.equal(result.lostOwnership,1); assert.equal(result.committed,0);
  db.hooks.beforeStatement=undefined; db.hooks.afterBatch=undefined;
  assert.equal((await db.jobs.inspect(ref)).state,'committed'); assert.equal(await db.repo.commit(ref),'committed');
  assert.equal((await runUsageRecoveryD1(db.client,options,pool())).scanned,0); assert.equal(account(db).budget_spent_micros,250000);
});

test('capacity rejection, pre-abort and invalid options perform no database IO', async t => {
  const db=fixture(t), capacity=pool(1), hold=capacity.tryAcquire(1024), abort=new AbortController(); abort.abort();
  db.hooks.beforeStatement=()=>{throw new Error('unexpected IO');};
  assert.equal((await runUsageRecoveryD1(db.client,options,capacity)).capacityLimited,true); hold.release();
  assert.equal((await runUsageRecoveryD1(db.client,options,capacity,{signal:abort.signal})).admissionStopped,true);
  for(const changed of [{maxItems:51},{concurrency:5},{leaseSeconds:301},{runBudgetMs:0},{reservedBytesPerConsumer:0},{scope:{}}]) {
    await assert.rejects(runUsageRecoveryD1(db.client,{...options,...changed},capacity), /Invalid|scope/);
  }
  assert.equal(capacity.snapshot().requests,0);
});

test('run deadline and cancellation stop admission, not in-flight D1 ownership', async t => {
  const db=fixture(t); await enqueue(db); await enqueue(db);
  const capacity=pool(1), reached=deferred(), release=deferred(), abort=new AbortController(); let tick=0, finished=false;
  db.hooks.afterBatch=async()=>{reached.resolve(); await release.promise;};
  const task=runUsageRecoveryD1(db.client,{...options,concurrency:1},capacity,{now:()=>tick,signal:abort.signal}).finally(()=>{finished=true;});
  await reached.promise; tick=options.runBudgetMs; abort.abort();
  await Promise.resolve(); assert.equal(finished,false); assert.equal(capacity.snapshot().requests,1);
  assert.equal(capacity.tryAcquire(1024),null);
  release.resolve(); const result=await task;
  assert.equal(result.committed,1); assert.equal(result.admissionStopped,true); assert.equal(capacity.snapshot().requests,0);
  assert.equal((await db.jobs.scanDue(all,50)).length,1);
});

test('scan IO retains capacity until it settles even after cancellation', async t => {
  const db=fixture(t); await enqueue(db);
  const capacity=pool(1), reached=deferred(), release=deferred(), abort=new AbortController(); let finished=false;
  db.hooks.afterStatement=async sql=>{
    if(sql.includes('FROM request_usage_recovery_jobs')&&sql.includes('ORDER BY')) {reached.resolve(); await release.promise;}
  };
  const task=runUsageRecoveryD1(db.client,options,capacity,{signal:abort.signal}).finally(()=>{finished=true;});
  await reached.promise; abort.abort(); await Promise.resolve();
  assert.equal(finished,false); assert.equal(capacity.snapshot().requests,1);
  release.resolve(); const result=await task;
  assert.equal(result.claimed,0); assert.equal(result.admissionStopped,true); assert.equal(capacity.snapshot().requests,0);
});

test('unexpected failure in one consumer cannot release another consumers in-flight work', async t => {
  const db=fixture(t); await enqueue(db); await enqueue(db);
  const capacity=pool(2), reached=deferred(), release=deferred(); let breakClock=false, finished=false, batches=0;
  db.hooks.afterBatch=async()=>{
    if(++batches===1) {reached.resolve(); await release.promise;} else {breakClock=true;}
  };
  const task=runUsageRecoveryD1(db.client,options,capacity,{now:()=>{if(breakClock) throw new Error('clock failed'); return 0;}})
    .then(value=>({value}),error=>({error})).finally(()=>{finished=true;});
  await reached.promise;
  // The second consumer may finish its independent SQL, but the first still owns D1 acknowledgement.
  for(let i=0;i<200&&!breakClock;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(breakClock,true); assert.equal(finished,false); assert.equal(capacity.snapshot().requests,2);
  release.resolve(); assert.match((await task).error.message,/clock failed/); assert.equal(capacity.snapshot().requests,0);
  assert.equal(counts(db).api_key_request_logs,2);
});

test('scan failure returns all reserved capacity and starts no consumer', async t => {
  const db=fixture(t), capacity=pool(); await enqueue(db);
  db.hooks.beforeStatement=sql=>{if(sql.includes('ORDER BY available_at')) throw new Error('scan unavailable');};
  await assert.rejects(runUsageRecoveryD1(db.client,options,capacity), /scan unavailable/);
  assert.equal(capacity.snapshot().requests,0); assert.equal(counts(db).api_key_request_logs,0);
});

test('abort after claim but before commit defers a bounded attempt, not settlement or refund', async t => {
  const db=fixture(t), {ref}=await enqueue(db,0.25), abort=new AbortController();
  db.hooks.afterStatement=sql=>{if(claimSQL(sql)) abort.abort();};
  const result=await runUsageRecoveryD1(db.client,options,pool(),{signal:abort.signal});
  assert.equal(result.claimed,1); assert.equal(result.deferred,1); assert.equal(result.committed,0);
  assert.equal((await db.jobs.inspect(ref)).last_error,'interrupted'); assert.equal(account(db).budget_reserved_micros,500000);
});

for (const mode of ['claim-after','batch-before','batch-after']) for (const cost of [0,0.25]) {
  test(`new process scans persisted jobs after abrupt exit: ${mode}, cost=${cost}`, {timeout:30000}, async () => {
    const root=mkdtempSync(path.join(tmpdir(),'cinatoken-recovery-')), filename=path.join(root,'recovery.sqlite'); let db;
    try {
      db=setup(null,{filename}); db.sqlite.function('unixepoch',{varargs:true},()=>2000000000); db.sqlite.exec(proposal);
      const {ref}=await enqueue(db,cost); db.sqlite.close(); db=null;
      const run=(action,seconds)=>spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./usage-recovery.fixture.mjs',import.meta.url)),filename,action,String(seconds)],{encoding:'utf8',timeout:12000,windowsHide:true});
      const killed=run(mode,2000000000); assert.equal(killed.error,undefined); assert.equal(killed.status,73,killed.stderr);
      const recovered=run('recover',2000000011); assert.equal(recovered.error,undefined); assert.equal(recovered.status,0,recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).committed,mode==='batch-after'?0:1);
      db=setup(null,{filename,applyMigrations:false});
      assert.equal(counts(db).api_key_request_logs,1); assert.equal(counts(db).request_usage_commit_receipts,1);
      assert.equal(counts(db).provider_attempt_availability,1); assert.equal(account(db).budget_spent_micros,cost*1e6);
      assert.equal(account(db).budget_reserved_micros,0);
      assert.equal((await createUsageRecoveryJobsD1(db.binding).inspect(ref)).state,'committed');
      assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {
      db?.sqlite.close(); assert.equal(path.dirname(filename),root);
      for(const entry of readdirSync(root)) { assert.ok(['recovery.sqlite','recovery.sqlite-wal','recovery.sqlite-shm','recovery.sqlite-journal'].includes(entry)); rmSync(path.join(root,entry)); }
      rmdirSync(root);
    }
  });
}
