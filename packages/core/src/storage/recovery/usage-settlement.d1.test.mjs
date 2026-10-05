import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeUsageSettlement, decodeUsageSettlement, settlementDigest, MAX_SETTLEMENT_BYTES } from './usage-settlement-codec.ts';
import { createUsageSettlementRepositoryD1 } from './usage-settlement-d1.ts';
import { insertRequestUsageAndChargeTxD1 } from '../../db/d1/critical-writes.impl.ts';
import { createD1GuardrailBudgetsRepository } from '../../db/d1/guardrail-budgets.impl.ts';
import { sample, setup, prepare, counts } from './usage-settlement-test-support.mjs';

test('full migrated schema plus proposals has enforced foreign keys and stays outside automatic migrations', t => {
  const db = setup(t);
  assert.equal(db.migrationFiles.length, 77);
  assert.equal(db.migrationFiles.at(-1), '0077_withdrawal_balance_update_guards.sql');
  assert.equal(db.sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});

test('canonical content owns all caller state before async hashing and rejects noncanonical/duplicate JSON', async () => {
  const value = sample(), original = structuredClone(value), pending = encodeUsageSettlement(value);
  value.intent.userId = 'other-user'; value.params.requestLog.rawUsage = 'caller mutated';
  const first = await pending;
  assert.deepEqual(await decodeUsageSettlement(first.json, first.sha256), original);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.deepEqual(await encodeUsageSettlement(reordered), first);
  for (const bad of [' ' + first.json, first.json.replace('"version":1', '"version":1,"version":1')]) {
    await assert.rejects(decodeUsageSettlement(bad, await settlementDigest(bad)), /content mismatch/);
  }
  await assert.rejects(decodeUsageSettlement(first.json, 'b'.repeat(64)), /content mismatch/);
});

test('snapshot rejects unknown credential fields, bodies, accessors, nonfinite values and malformed facts', async () => {
  const edits = [v => v.params.requestLog.requestBody = 'prompt', v => v.params.requestLog.upstreamRequestBody = 'image',
    v => v.params.requestLog.apiToken = 'synthetic-not-secret', v => v.params.requestLog.providerAttempts[0].secret = 'x',
    v => v.params.requestLog.rawUsage = 'x'.repeat(65537), v => v.params.requestLog.rawUsage = '中'.repeat(23000),
    v => v.params.requestLog.modelId = 'x'.repeat(513), v => v.params.requestLog.totalTokens = Infinity,
    v => v.params.requestLog.providerAttempts[0].httpStatus = 999, v => v.params.requestLog.providerAttempts[0].reason = 'network_error',
    v => v.params.requestLog.providerResponses = [{status:200, token:'x'}], v => v.params.requestLog.status = 'paid',
    v => v.params.requestLog.providerAttempts = [], v => v.params.requestLog.inputTokens = 1.5,
    v => v.params.audit.requestLogId = 'other', v => v.params.audit.beforeSpent = 1,
    v => v.params.requestLog.chargedCost = 2, v => v.params.userBudgetSettlement = {requestId:'other',mode:'actual',reason:'ok'},
    v => Object.defineProperty(v.params, 'chargedCost', {get(){ throw new Error('getter executed'); }}),
    v => v.extra = new Map(), v => v.extra = v,
  ];
  for (const edit of edits) { const value = sample(); edit(value); await assert.rejects(encodeUsageSettlement(value), TypeError); }
});

test('snapshot rejects conflicting precomputed budget micros and final route identity', async () => {
  const wrongMicros=sample(); wrongMicros.params.requestLog.budgetChargedMicros=1;
  await assert.rejects(encodeUsageSettlement(wrongMicros),/accounting conflict/);
  const wrongRoute=sample(); wrongRoute.params.requestLog.routeTargetId='other-target';
  await assert.rejects(encodeUsageSettlement(wrongRoute),/accounting conflict/);
});

test('escaped JSON total byte bound is independent of per-field limits', async () => {
  const v = sample();
  // JSON-valid embedded string with many backslashes expands a second time in the envelope.
  v.params.requestLog.rawUsage = JSON.stringify('\\'.repeat(32000));
  v.params.requestLog.pricingAudit = v.params.requestLog.rawUsage;
  v.params.requestLog.routeTrace = JSON.stringify('\\'.repeat(16000));
  await assert.rejects(encodeUsageSettlement(v), /payload limit/);
  await assert.rejects(decodeUsageSettlement('x'.repeat(MAX_SETTLEMENT_BYTES + 1), 'a'.repeat(64)), /bounds/);
});

test('persist requires matching claimed intent, and unknown outcome may later receive actual facts', async t => {
  const db = setup(t), v = sample();
  await assert.rejects(db.repo.persist(v), /missing|conflict/);
  await prepare(db, v, {claim:false});
  await assert.rejects(db.repo.persist(v), /missing|conflict/);
  await db.intents.claim(v.intent, 0, v.dispatchClaimId, 200);
  await db.intents.classifyOverdue(v.intent, 1, 1000);
  const ref = await db.repo.persist(v);
  assert.equal(await db.repo.commit(ref), 'committed');
  assert.equal((await db.intents.inspect(v.intent)).state, 'outcome_unknown'); // Execution evidence != settlement progress.
});

test('persist is immutable/idempotent and different price, payload, operation, claim or tenant conflicts', async t => {
  const db = setup(t), v = sample(); await prepare(db, v);
  const ref = await db.repo.persist(v);
  assert.deepEqual(await db.repo.persist(v), ref);
  for (const edit of [x => x.params.requestLog.rawUsage = '{"images":2}', x => x.params.requestLog.standardCost = 1,
    x => x.dispatchClaimId = '11111111-1111-4111-8111-111111111111', x => x.intent.contextSha256 = 'b'.repeat(64),
    x => x.intent.userId = 'other-user', x => x.params.requestLog.requestOperation = 'images.edits']) {
    const other = structuredClone(v); edit(other); await assert.rejects(db.repo.persist(other));
  }
  for (const edit of [{userId:'other-user'}, {workspaceId:'other-workspace'}, {apiKeyId:'other-key'}, {payloadSha256:'b'.repeat(64)}]) {
    await assert.rejects(db.repo.commit({...ref,...edit}), /missing|conflict/);
  }
  assert.throws(() => db.sqlite.prepare('UPDATE request_usage_settlements SET payload_json=? WHERE request_id=?').run('{}',ref.requestId), /immutable/);
  assert.equal(counts(db).request_usage_settlements, 1);
  assert.equal(counts(db).api_key_request_logs, 0);
});

test('persist distinguishes failure before commit, lost ACK and unavailable readback', async t => {
  const db = setup(t), v = sample(); await prepare(db, v);
  db.hooks.beforeStatement = sql => { if (sql.startsWith('INSERT INTO request_usage_settlements')) throw new Error('before persist'); };
  await assert.rejects(db.repo.persist(v)); assert.equal(counts(db).request_usage_settlements, 0);
  db.hooks.beforeStatement = undefined;
  db.hooks.afterStatement = sql => { if (sql.startsWith('INSERT INTO request_usage_settlements')) throw new Error('lost ACK'); };
  const ref = await db.repo.persist(v); assert.equal(counts(db).request_usage_settlements, 1);
  db.hooks.beforeStatement = sql => { if (sql.startsWith('SELECT * FROM request_usage_settlements')) throw new Error('read unavailable'); };
  await assert.rejects(db.repo.persist(v), /read unavailable/);
  db.hooks.beforeStatement = undefined; db.hooks.afterStatement = undefined;
  assert.equal(await db.repo.commit(ref), 'committed');
});

test('commit owns tenant/digest reference throughout awaited reads', async t => {
  const db=setup(t),v=sample(); await prepare(db,v); const original=await db.repo.persist(v), mutable={...original};
  let release,entered; const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  db.hooks.afterStatement=async sql=>{if(sql.startsWith('SELECT * FROM request_usage_settlements')){entered();await held;}};
  const pending=db.repo.commit(mutable); await started; mutable.userId='other-user'; mutable.payloadSha256='b'.repeat(64); release();
  assert.equal(await pending,'committed');
  assert.equal(counts(db).api_key_request_logs,1);
});

test('unavailable schema never falls back to an unprotected critical write', async t => {
  const db=setup(t),v=sample(); await prepare(db,v); const ref=await db.repo.persist(v);
  db.sqlite.exec('DROP TABLE request_usage_commit_receipts');
  await assert.rejects(db.repo.commit(ref),/no such table/);
  assert.equal(countsWithoutReceipt(db),0);
  function countsWithoutReceipt(db){return db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_key_request_logs').get().n;}
});

test('existing expiry policy and one-race retry retain the original receipt and price', async t => {
  const db=setup(t),v=sample(0.25); await prepare(db,v); const ref=await db.repo.persist(v);
  let expired=false;
  db.hooks.afterStatement=async sql=>{
    if(!expired && sql.includes('SELECT id, user_id, api_key_id,') && sql.includes('FROM api_key_request_logs')) {
      expired=true;
      assert.equal(await db.budgets.forfeitDispatched(ref.requestId,'2026-09-07T00:11:00.000Z','existing_expiry_policy'),1);
    }
  };
  assert.equal(await db.repo.commit(ref),'committed'); assert.equal(expired,true);
  assert.equal(await db.repo.commit(ref),'committed');
  const reservation=db.sqlite.prepare('SELECT state,settled_micros FROM user_budget_reservations').get();
  assert.equal(reservation.state,'expired'); assert.equal(reservation.settled_micros,250000);
  assert.equal(counts(db).request_usage_commit_receipts,1); assert.equal(counts(db).user_audit_logs,1);
  assert.equal(db.sqlite.prepare('SELECT budget_spent_micros FROM users WHERE id=?').get(ref.userId).budget_spent_micros,250000);
});

test('recovery of an old epoch never debits the newer budget period', async t => {
  const db=setup(t),v=sample(0.25); await prepare(db,v); const ref=await db.repo.persist(v);
  db.sqlite.prepare('UPDATE users SET budget_epoch=1,budget_reserved_micros=0,budget_spent_micros=0,budget_spent=0 WHERE id=?').run(ref.userId);
  assert.equal(await db.repo.commit(ref),'committed'); assert.equal(await db.repo.commit(ref),'committed');
  assert.equal(db.sqlite.prepare('SELECT budget_spent_micros FROM users WHERE id=?').get(ref.userId).budget_spent_micros,0);
  assert.equal(db.sqlite.prepare('SELECT settled_micros FROM user_budget_reservations').get().settled_micros,250000);
});

test('receipt, ordinary budget and Guardrail budget share a transaction, including rollback after ordinary charge', async t => {
  const db=setup(t),v=sample(0.25); await prepare(db,v);
  const guardrails=createD1GuardrailBudgetsRepository(db.client),i=v.intent;
  assert.equal((await guardrails.reserveMany({requestId:i.requestId,reservedMicros:500000,nowIso:v.recordedAtIso,expiresAtIso:'2026-09-07T00:10:00.000Z',
    intents:[{workspaceId:i.workspaceId,assignmentId:'test-assignment',guardrailId:'test-guardrail',guardrailVersion:1,scopeType:'user',scopeId:i.userId,
      period:'daily',periodStart:'2026-09-06T00:00:00.000Z',periodEnd:'2026-09-07T00:00:00.000Z',limitMicros:1000000}]})).status,'reserved');
  await guardrails.markDispatched(i.requestId,v.recordedAtIso,'2026-09-07T00:10:00.000Z');
  v.params.guardrailBudgetSettlement={requestId:i.requestId,mode:'actual',reason:'combined_actual'};
  const ref=await db.repo.persist(v);
  db.hooks.beforeStatement=sql=>{if(sql.startsWith('UPDATE guardrail_budget_windows'))throw new Error('guardrail failed');};
  await assert.rejects(db.repo.commit(ref),/guardrail failed/);
  assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(counts(db).user_audit_logs,0);
  assert.equal(db.sqlite.prepare('SELECT budget_spent_micros FROM users WHERE id=?').get(i.userId).budget_spent_micros,0);
  db.hooks.beforeStatement=undefined;
  assert.equal(await db.repo.commit(ref),'committed'); assert.equal(await db.repo.commit(ref),'committed');
  assert.equal(db.sqlite.prepare('SELECT settled_micros FROM guardrail_budget_reservations').get().settled_micros,250000);
  assert.equal(db.sqlite.prepare('SELECT settled_micros FROM guardrail_budget_windows').get().settled_micros,250000);
});

test('lost batch ACK with a readable receipt is immediately reconciled', async t => {
  const db=setup(t),v=sample(); await prepare(db,v); const ref=await db.repo.persist(v);
  db.hooks.afterBatch=()=>{throw new Error('lost batch ACK');};
  assert.equal(await db.repo.commit(ref),'committed');
  assert.equal(await db.repo.commit(ref),'committed'); assert.equal(counts(db).api_key_request_logs,1);
});

for (const cost of [0, 0.25]) test('same economic event commits exactly once through concurrent/repeated consumers: ' + cost, async t => {
  const db = setup(t), v = sample(cost); await prepare(db, v); const ref = await db.repo.persist(v);
  const results = await Promise.all(Array.from({length:12}, () => createUsageSettlementRepositoryD1(db.client).commit(ref)));
  assert.ok(results.every(r => r === 'committed')); assert.equal(await db.repo.commit(ref), 'committed');
  assert.deepEqual(counts(db), {request_usage_settlements:1,request_usage_commit_receipts:1,api_key_request_logs:1,provider_attempt_availability:1,user_audit_logs:cost>0?1:0});
  const account = db.sqlite.prepare('SELECT budget_spent_micros,budget_reserved_micros FROM users WHERE id=?').get(v.intent.userId);
  assert.equal(account.budget_spent_micros, cost * 1e6); assert.equal(account.budget_reserved_micros, 0);
  const stats = db.sqlite.prepare('SELECT stat_date,request_count,total_tokens FROM public_model_daily_stats').get();
  assert.equal(stats.request_count,1); assert.equal(stats.total_tokens,11); assert.equal(stats.stat_date,'2026-09-06');
  const log = db.sqlite.prepare('SELECT created_at,pricing_audit,raw_usage FROM api_key_request_logs').get();
  assert.equal(log.created_at,v.recordedAtIso); assert.equal(log.pricing_audit,v.params.requestLog.pricingAudit); assert.equal(log.raw_usage,v.params.requestLog.rawUsage);
  assert.throws(() => db.sqlite.exec("UPDATE request_usage_commit_receipts SET payload_sha256='x'"), /immutable/);
});

for (const cost of [0, 0.25]) for (const fault of ['receipt','log','stats','attempt',...(cost > 0 ? ['audit'] : [])]) test(`rollback and later replay of original DTO: cost=${cost}, fault=${fault}`, async t => {
  const db = setup(t), v = sample(cost); await prepare(db,v); const ref = await db.repo.persist(v);
  const table = {receipt:'request_usage_commit_receipts',log:'api_key_request_logs',stats:'public_model_daily_stats',attempt:'provider_attempt_availability',audit:'user_audit_logs'}[fault];
  db.hooks.beforeStatement = sql => { if (sql.startsWith('INSERT INTO ' + table)) throw new Error('injected rollback'); };
  await assert.rejects(db.repo.commit(ref), /injected rollback/);
  assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(counts(db).api_key_request_logs,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM public_model_daily_stats').get().n,0);
  assert.equal(db.sqlite.prepare('SELECT budget_spent_micros FROM users WHERE id=?').get(v.intent.userId).budget_spent_micros,0);
  db.hooks.beforeStatement = undefined;
  assert.equal(await createUsageSettlementRepositoryD1(db.client).commit(ref),'committed');
});

for (const cost of [0,0.25]) test('lost final batch ACK and failed readback do not duplicate charges: '+cost, async t => {
  const db = setup(t), v = sample(cost); await prepare(db,v); const ref = await db.repo.persist(v);
  db.hooks.afterBatch = () => {
    db.hooks.beforeStatement = sql => { if (sql.includes('FROM request_usage_commit_receipts')) throw new Error('receipt unavailable'); };
    throw new Error('batch ACK lost');
  };
  await assert.rejects(db.repo.commit(ref), /receipt unavailable/);
  assert.equal(counts(db).api_key_request_logs,1);
  db.hooks.beforeStatement = undefined; db.hooks.afterBatch = undefined;
  assert.equal(await createUsageSettlementRepositoryD1(db.client).commit(ref),'committed');
  assert.equal(counts(db).user_audit_logs,cost>0?1:0);
  assert.equal(db.sqlite.prepare('SELECT budget_spent_micros FROM users WHERE id=?').get(v.intent.userId).budget_spent_micros,cost*1e6);
});

test('legacy log without receipt is never adopted as success, even for matching reserved identity and amount', async t => {
  const db = setup(t), v = sample(0.25); await prepare(db,v); const ref = await db.repo.persist(v);
  await insertRequestUsageAndChargeTxD1(db.client,v.params);
  await assert.rejects(db.repo.commit(ref), /not confirmed/);
  assert.equal(counts(db).request_usage_commit_receipts,0); assert.equal(counts(db).api_key_request_logs,1);
  assert.equal(counts(db).user_audit_logs,1);
});

test('receipt alone or wrong committed scope/model/amount is not confirmation', async t => {
  const db = setup(t), v = sample(); await prepare(db,v); const ref = await db.repo.persist(v);
  db.sqlite.prepare('INSERT INTO request_usage_commit_receipts VALUES(?,?,?)').run(ref.requestId,ref.payloadSha256,v.recordedAtIso);
  await assert.rejects(db.repo.commit(ref), /receipt or committed log conflict/);
  db.sqlite.prepare('DELETE FROM request_usage_commit_receipts WHERE request_id=?').run(ref.requestId);
  await db.repo.commit(ref);
  for (const [field,bad,good] of [['model_id','other','synthetic/image'],['user_id','other-user','recovery-user'],['charged_cost',1,0]]) {
    db.sqlite.prepare(`UPDATE api_key_request_logs SET ${field}=? WHERE id=?`).run(bad,ref.requestId);
    await assert.rejects(db.repo.commit(ref), /receipt or committed log conflict/);
    db.sqlite.prepare(`UPDATE api_key_request_logs SET ${field}=? WHERE id=?`).run(good,ref.requestId);
  }
});

for (const mode of ['persist-before','persist-after','batch-before','batch-after']) for (const cost of [0,0.25]) {
  test(`separate process recovers persisted result after abrupt exit: ${mode}, cost=${cost}`, {timeout:30000}, async () => {
    const root = mkdtempSync(path.join(tmpdir(),'cinatoken-settlement-')), filename = path.join(root,'settlement.sqlite');
    let db;
    try {
      const v = sample(cost); db = setup(null,{filename}); await prepare(db,v);
      const encoded = await encodeUsageSettlement(v);
      const ref = {requestId:v.intent.requestId,userId:v.intent.userId,apiKeyId:v.intent.apiKeyId,workspaceId:v.intent.workspaceId,payloadSha256:encoded.sha256};
      if (!mode.startsWith('persist')) await db.repo.persist(v);
      db.sqlite.close(); db = null;
      const run = (action,payload) => spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./usage-settlement.fixture.mjs',import.meta.url)),filename,action,JSON.stringify(payload)],{encoding:'utf8',timeout:12000,windowsHide:true});
      const killed = run(mode,mode.startsWith('persist') ? v : ref);
      assert.equal(killed.error,undefined); assert.equal(killed.status,73,killed.stderr);
      const recovered = run('recover',ref);
      if (mode === 'persist-before') { assert.equal(recovered.status,1); assert.match(recovered.stderr,/missing or identity conflict/); }
      else { assert.equal(recovered.error,undefined); assert.equal(recovered.status,0,recovered.stderr); }
      db = setup(null,{filename,applyMigrations:false});
      const n = mode === 'persist-before' ? 0 : 1;
      assert.equal(counts(db).request_usage_settlements,n); assert.equal(counts(db).request_usage_commit_receipts,n);
      assert.equal(counts(db).api_key_request_logs,n); assert.equal(counts(db).provider_attempt_availability,n);
      assert.equal(db.sqlite.prepare('SELECT budget_spent_micros FROM users WHERE id=?').get(v.intent.userId).budget_spent_micros,n*cost*1e6);
      assert.equal((await db.intents.inspect(v.intent)).state,'dispatch_claimed');
      assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {
      db?.sqlite.close();
      assert.equal(path.dirname(filename),root);
      for (const entry of readdirSync(root)) { assert.ok(['settlement.sqlite','settlement.sqlite-wal','settlement.sqlite-shm','settlement.sqlite-journal'].includes(entry)); rmSync(path.join(root,entry)); }
      rmdirSync(root);
    }
  });
}
