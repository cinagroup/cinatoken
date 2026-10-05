import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSqliteD1 } from '../../../../proxy/src/test-support/sqlite-d1.ts';
import { createDispatchIntentRepositoryD1, DispatchClaimUncertainError } from './dispatch-intent-d1.ts';

const proposal = readFileSync(new URL('../../../migrations-proposals/d1/request-dispatch-intents.sql', import.meta.url), 'utf8');
const ref = () => ({ requestId: 'gen-' + randomUUID(), attemptIndex: 1, userId: 'intent-user', apiKeyId: 'intent-key',
  workspaceId: 'intent-workspace', operation: 'images.generations', contextSha256: 'a'.repeat(64) });
function setup(t, hooks = {}, options = {}) {
  const db = createSqliteD1(hooks, options);
  db.sqlite.exec(proposal);
  for (const id of ['intent', 'other']) {
    db.sqlite.prepare('INSERT INTO users(id,email,budget_max) VALUES(?,?,0)').run(id + '-user', id + '@example.invalid');
    db.sqlite.prepare("INSERT INTO workspaces(id,scope_type,personal_owner_user_id,name,slug) VALUES(?,'personal',?,?,?)")
      .run(id + '-workspace', id + '-user', id, id);
    db.sqlite.prepare('INSERT INTO api_keys(id,key,user_id,workspace_id,name) VALUES(?,?,?,?,?)')
      .run(id + '-key', 'synthetic-hash-ref-' + id, id + '-user', id + '-workspace', id);
  }
  if (t) t.after(() => db.sqlite.close());
  return { ...db, repo: createDispatchIntentRepositoryD1(db.binding) };
}
const intentInsert = sql => sql.startsWith('INSERT INTO request_dispatch_intents');
const claimUpdate = sql => sql.startsWith('UPDATE request_dispatch_intents') && sql.includes("SET state='dispatch_claimed'");

test('proposal expands all existing migrations without joining the automatic migration set', t => {
  const db = setup(t);
  assert.equal(db.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.migrationFiles.length, 77);
  assert.equal(db.migrationFiles.at(-1), '0077_withdrawal_balance_update_guards.sql');
  assert.ok(!db.migrationFiles.some(name => name.includes('dispatch-intent')));
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.ok(db.sqlite.prepare('PRAGMA table_info(request_dispatch_intents)').all().every(row => !/body|secret|token|cost|balance|payload/.test(row.name)));
});

test('exact intent replay does not create another record or confer a sending permit', async t => {
  const db = setup(t), id = ref();
  const first = await db.repo.prepare(id, 100, 1000);
  assert.equal(first.state, 'prepared');
  assert.equal(first.dispatch_claim_id, null);
  assert.deepEqual(await db.repo.prepare(id, 150, 1000), first);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_dispatch_intents').get().n, 1);
  for (const edit of [{ contextSha256: 'b'.repeat(64) }, { operation: 'images.edits' }, { apiKeyId: 'other-key' },
    { userId: 'other-user', workspaceId: 'other-workspace', apiKeyId: 'other-key' }]) {
    assert.equal(await db.repo.inspect({ ...id, ...edit }), null);
    await assert.rejects(db.repo.prepare({ ...id, ...edit }, 100, 1000), /conflict/);
  }
  await assert.rejects(db.repo.prepare(id, 100, 1001), /conflict/);
  assert.deepEqual(await db.repo.inspect(id), first);
});

test('key/user/workspace mismatch cannot create an intent, even if all ids independently exist', async t => {
  const db = setup(t);
  for (const edit of [{ userId: 'other-user' }, { workspaceId: 'other-workspace' }, { apiKeyId: 'other-key' }]) {
    await assert.rejects(db.repo.prepare({ ...ref(), ...edit }, 100, 1000), /conflict/);
  }
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM request_dispatch_intents').get().n, 0);
});

test('identity and bounded scan values reject malformed runtime inputs before I/O', async t => {
  let reads = 0; const db = setup(t); db.hooks.beforeStatement = () => { reads++; };
  for (const edit of [{ userId: undefined }, { requestId: null }, { apiKeyId: 123 }, { workspaceId: {} },
    { attemptIndex: 0 }, { attemptIndex: 33 }, { attemptIndex: 1.5 }, { requestId: 'x'.repeat(201) },
    { operation: 'chat' }, { contextSha256: 'A'.repeat(64) }]) {
    await assert.rejects(db.repo.prepare({ ...ref(), ...edit }, 100, 1000), TypeError);
  }
  for (const n of [0, 51, NaN, Infinity, 1.5]) await assert.rejects(db.repo.listOverdue('intent-user', 'intent-workspace', 1000, n), TypeError);
  for (const [a,b] of [[NaN,1000],[100,Infinity],[100,100],[100,99]]) await assert.rejects(db.repo.prepare(ref(),a,b),TypeError);
  assert.equal(reads, 0);
});

test('intent creation reconciles a committed write with lost ACK but never hides a missing write', async t => {
  const db = setup(t), id = ref();
  db.hooks.afterStatement = sql => { if (intentInsert(sql)) throw new Error('private database detail'); };
  assert.equal((await db.repo.prepare(id, 100, 1000)).state, 'prepared');
  db.hooks.afterStatement = undefined;
  db.hooks.beforeStatement = sql => { if (intentInsert(sql)) throw new Error('private database detail'); };
  await assert.rejects(db.repo.prepare(ref(), 100, 1000), /^Error: Dispatch intent persistence unconfirmed$/);
});

test('reconciliation read failure is not reported as confirmed persistence', async t => {
  const db = setup(t);
  db.hooks.afterStatement = sql => { if (intentInsert(sql)) throw new Error('write ACK unavailable'); };
  db.hooks.beforeStatement = sql => { if (sql.startsWith('SELECT * FROM request_dispatch_intents')) throw new Error('read unavailable'); };
  await assert.rejects(db.repo.prepare(ref(),100,1000));
});

test('prepare owns an immutable identity across the awaited persistence boundary', async t => {
  const db=setup(t),id=ref(),other=ref(),original=id.requestId;
  await db.repo.prepare(other,100,1000);
  let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  db.hooks.afterStatement=async(sql,values)=>{if(intentInsert(sql)&&values[0]===original){entered();await held;}};
  const pending=db.repo.prepare(id,100,1000);
  await started;Object.assign(id,other);release();
  assert.equal((await pending).request_id,original);
});

test('concurrent callers and repeated same claim get exactly one grant per attempt', async t => {
  const db = setup(t), id = ref(), claimId = randomUUID();
  await db.repo.prepare(id, 100, 1000);
  const results = await Promise.all(Array.from({length:20}, (_,i) => db.repo.claim(id,0,i%2 ? randomUUID() : claimId,200)));
  assert.equal(results.filter(r => r === 'granted').length, 1);
  assert.equal(await db.repo.claim(id,0,claimId,201), 'not_granted');
  const row = await db.repo.inspect(id); assert.equal(row.state,'dispatch_claimed'); assert.equal(row.revision,1);
  assert.equal((await db.repo.prepare(id, 210, 1000)).state, 'dispatch_claimed');
});

test('claim ACK loss is always uncertain; rereading the same claim cannot grant another send', async t => {
  const db = setup(t), id = ref(), claimId = randomUUID();
  await db.repo.prepare(id,100,1000);
  db.hooks.afterStatement = sql => { if (claimUpdate(sql)) throw new Error('private DB ACK error'); };
  await assert.rejects(db.repo.claim(id,0,claimId,200), DispatchClaimUncertainError);
  db.hooks.afterStatement = undefined;
  assert.equal((await db.repo.inspect(id)).dispatch_claim_id,claimId);
  assert.equal(await db.repo.claim(id,0,claimId,201),'not_granted');
  assert.equal(await db.repo.claim(id,1,randomUUID(),202),'not_granted');
});

test('claim failure before commit does not grant; expiry and stale context/revision fail closed', async t => {
  const db = setup(t), id = ref(); await db.repo.prepare(id,100,1000);
  db.hooks.beforeStatement = sql => { if (claimUpdate(sql)) throw new Error('before commit'); };
  await assert.rejects(db.repo.claim(id,0,randomUUID(),200),DispatchClaimUncertainError);
  db.hooks.beforeStatement = undefined;
  assert.equal((await db.repo.inspect(id)).state,'prepared');
  for (const [r,revision,now] of [[id,1,200],[{...id,contextSha256:'b'.repeat(64)},0,200],[id,0,99],[id,0,1000]]) {
    assert.equal(await db.repo.claim(r,revision,randomUUID(),now),'not_granted');
  }
});

test('overdue classification distinguishes never-claimed from possible execution and never mutates money', async t => {
  const db = setup(t), before = ref(), after = ref();
  await db.repo.prepare(before,100,1000); await db.repo.prepare(after,100,1000);
  await db.repo.claim(after,0,randomUUID(),200);
  const balance = db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(before.userId);
  assert.equal(await db.repo.classifyOverdue(after,1,999),false);
  assert.equal(await db.repo.classifyOverdue(after,0,1000),false);
  assert.equal(await db.repo.classifyOverdue(before,0,1000),true);
  assert.equal(await db.repo.classifyOverdue(after,1,1000),true);
  assert.equal((await db.repo.inspect(before)).state,'expired_before_dispatch');
  assert.equal((await db.repo.inspect(after)).state,'outcome_unknown');
  assert.equal(await db.repo.classifyOverdue(after,1,1001),false);
  assert.equal(await db.repo.claim(after,2,randomUUID(),1001),'not_granted');
  assert.deepEqual(db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(before.userId),balance);
  for(const table of ['api_key_request_logs','user_budget_reservations','user_audit_logs']) assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
});

test('recovery scan is tenant-scoped, indexed, ordered and explicitly bounded', async t => {
  const db = setup(t);
  for(let i=0;i<52;i++) await db.repo.prepare({...ref(),requestId:'gen-'+String(i).padStart(3,'0')},100,1000);
  await db.repo.prepare({...ref(),userId:'other-user',apiKeyId:'other-key',workspaceId:'other-workspace'},100,1000);
  assert.equal((await db.repo.listOverdue('intent-user','intent-workspace',999,50)).length,0);
  const rows=await db.repo.listOverdue('intent-user','intent-workspace',1000,50);
  assert.equal(rows.length,50);assert.equal(rows[0].request_id,'gen-000');assert.equal(rows[49].request_id,'gen-049');
  assert.equal((await db.repo.listOverdue('other-user','other-workspace',1000,50)).length,1);
  assert.match(JSON.stringify(db.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM request_dispatch_intents WHERE user_id=? AND workspace_id=? AND state IN ('prepared','dispatch_claimed') AND expires_at_ms<=? ORDER BY expires_at_ms,request_id,attempt_index LIMIT ?").all('intent-user','intent-workspace',1000,50)),/request_dispatch_intents_recovery/);
});

test('SQL state constraints reject null claims and non-integer CAS revisions', async t => {
  const db=setup(t),id=ref();await db.repo.prepare(id,100,1000);
  assert.throws(()=>db.sqlite.prepare("UPDATE request_dispatch_intents SET state='dispatch_claimed',revision=1 WHERE request_id=?").run(id.requestId),/CHECK/);
  assert.throws(()=>db.sqlite.prepare("UPDATE request_dispatch_intents SET state='expired_before_dispatch',updated_at_ms=1000,revision=0.5 WHERE request_id=?").run(id.requestId),/CHECK|Invalid dispatch intent transition/);
});

test('SQL trigger freezes identity/deadline and forbids reopening or changing a claim', async t => {
  const db=setup(t),id=ref(),claimId=randomUUID();await db.repo.prepare(id,100,1000);
  for(const [field,value] of [['context_sha256','b'.repeat(64)],['workspace_id','other-workspace'],['expires_at_ms',2000]]) {
    assert.throws(()=>db.sqlite.prepare(`UPDATE request_dispatch_intents SET ${field}=?,revision=1 WHERE request_id=?`).run(value,id.requestId),/Invalid dispatch intent transition/);
  }
  await db.repo.claim(id,0,claimId,200);
  assert.throws(()=>db.sqlite.prepare("UPDATE request_dispatch_intents SET state='prepared',dispatch_claim_id=NULL,claimed_at_ms=NULL,revision=2 WHERE request_id=?").run(id.requestId),/Invalid dispatch intent transition/);
  assert.throws(()=>db.sqlite.prepare("UPDATE request_dispatch_intents SET state='outcome_unknown',dispatch_claim_id=?,updated_at_ms=1000,revision=2 WHERE request_id=?").run(randomUUID(),id.requestId),/Invalid dispatch intent transition/);
  assert.equal((await db.repo.inspect(id)).dispatch_claim_id,claimId);
});

test('claim token cannot be reused for another attempt and failures do not partially mutate that attempt', async t => {
  const db=setup(t),id=ref(),second={...id,attemptIndex:2},claimId=randomUUID();
  await db.repo.prepare(id,100,1000);await db.repo.prepare(second,100,1000);
  assert.equal(await db.repo.claim(id,0,claimId,200),'granted');
  await assert.rejects(db.repo.claim(second,0,claimId,201),DispatchClaimUncertainError);
  assert.equal((await db.repo.inspect(second)).state,'prepared');
  assert.equal((await db.repo.inspect(second)).revision,0);
});

test('lost recovery acknowledgement is safely reread without reclassifying or granting execution', async t => {
  const db=setup(t),id=ref();await db.repo.prepare(id,100,1000);await db.repo.claim(id,0,randomUUID(),200);
  db.hooks.afterStatement=sql=>{if(sql.includes('SET state=CASE state'))throw new Error('classification ACK lost');};
  await assert.rejects(db.repo.classifyOverdue(id,1,1000));
  db.hooks.afterStatement=undefined;
  assert.equal((await db.repo.inspect(id)).state,'outcome_unknown');
  assert.equal(await db.repo.classifyOverdue(id,1,1001),false);
  assert.equal(await db.repo.claim(id,2,randomUUID(),1001),'not_granted');
});

for(const mode of ['prepare-after','claim-before','claim-after']) test('new process observes durable boundary after abrupt exit: '+mode,{timeout:15000},async () => {
  const root=mkdtempSync(path.join(tmpdir(),'cinatoken-intent-'));
  const filename=path.join(root,'intent.sqlite'),id=ref();let db;
  try {
    db=setup(null,{}, {filename});
    if(mode!=='prepare-after')await db.repo.prepare(id,100,1000);
    db.sqlite.close();db=null;
    const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./dispatch-intent.fixture.mjs',import.meta.url)),filename,mode,JSON.stringify(id)],{encoding:'utf8',timeout:10000,windowsHide:true});
    assert.equal(child.error,undefined);assert.equal(child.status,73,child.stderr);
    db=createSqliteD1({}, {filename,applyMigrations:false});
    const repo=createDispatchIntentRepositoryD1(db.binding),row=await repo.inspect(id);
    assert.equal(row.state,mode==='claim-after'?'dispatch_claimed':'prepared');
    if(mode==='claim-after')assert.equal(await repo.claim(id,0,randomUUID(),300),'not_granted');
    assert.equal(await repo.classifyOverdue(id,row.revision,1000),true);
    assert.equal((await repo.inspect(id)).state,mode==='claim-after'?'outcome_unknown':'expired_before_dispatch');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n,0);
  } finally {
    db?.sqlite.close();
    // Only this newly-created fixture directory, with a fixed allowlist of generated SQLite files.
    assert.equal(path.dirname(filename),root);
    for(const entry of readdirSync(root)){assert.ok(['intent.sqlite','intent.sqlite-wal','intent.sqlite-shm','intent.sqlite-journal'].includes(entry));rmSync(path.join(root,entry));}
    rmdirSync(root);
  }
});
