import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFinancialEngine } from '../../test-support/postgres-financial-engine.mjs';
import { createDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres, ownPostgresSettlementReference } from './usage-settlement-facts-postgres.ts';
import { encodeUsageSettlement, settlementDigest } from './usage-settlement-codec.ts';
import { sample as existingSample } from './usage-settlement-test-support.mjs';
import { SettlementConflictError, SettlementSnapshotInvalidError } from './settlement-recovery-types.ts';

const g = 'cinatoken_gateway', fact = `${g}.request_usage_settlements`, outbox = `${g}.request_usage_settlement_outbox`;
const proposal = name => readFileSync(new URL('../../../migrations-proposals/postgres/' + name, import.meta.url), 'utf8');
function sample(cost = 0.25) {
  const value = existingSample(cost);
  Object.assign(value.intent, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
  Object.assign(value.params.requestLog, { userId: 'user', apiKeyId: 'key', workspaceId: 'workspace' });
  value.params.userId = 'user'; value.params.audit.apiKeyId = 'key'; return value;
}
const reference = async value => ownPostgresSettlementReference({ ...value.intent, dispatchClaimId: value.dispatchClaimId,
  payloadSha256: (await encodeUsageSettlement(value)).sha256 });
const insertSql = `INSERT INTO ${fact}
  (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,dispatch_claim_id,payload_sha256,payload_version,payload_json,recorded_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
async function insertArgs(value) {
  const { json, sha256 } = await encodeUsageSettlement(value), i = value.intent;
  return [i.requestId, i.attemptIndex, i.userId, i.apiKeyId, i.workspaceId, i.operation, i.contextSha256,
    value.dispatchClaimId, sha256, value.version, json, value.recordedAtIso];
}

test('PostgreSQL immutable settlement facts + atomic outbox local engine', { timeout: 150_000 }, async t => {
  assert.ok(!process.env.GATEWAY_PG_FINANCIAL_BASELINE);
  const f = await createFinancialEngine({ migrationHead: '0068_function_schema_resolution.sql' }); t.after(() => f.pg.close());
  await f.pg.transaction(tx => tx.exec(proposal('request-dispatch-intents.sql')));
  await f.pg.transaction(tx => tx.exec(proposal('request-usage-settlement-facts.sql')));
  for (const name of ['request_usage_settlements', 'request_usage_settlement_outbox']) {
    await f.pg.exec(`CREATE TABLE public.${name} (LIKE ${g}.${name} INCLUDING ALL); CREATE TEMP TABLE ${name} (LIKE ${g}.${name} INCLUDING ALL)`);
  }
  const repo = createUsageSettlementFactsRepositoryPostgres(f.client), intents = createDispatchIntentRepositoryPostgres(f.client);
  const deadline = async (delta = 60_000) => Number((await f.pg.query('SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$1)::text AS n', [delta])).rows[0].n);
  const count = async () => (await f.pg.query(`SELECT (SELECT count(*)::int FROM ${fact}) AS facts, (SELECT count(*)::int FROM ${outbox}) AS entries`)).rows[0];
  const prepare = async (value, claim = true, expiry) => {
    await intents.prepare(value.intent, expiry ?? await deadline());
    if (claim) assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
  };
  const wrapper = (hooks = {}) => createUsageSettlementFactsRepositoryPostgres({ ...f.client, raw: {
    async unsafe(query, params) {
      await hooks.before?.(query, params);
      const rows = await f.client.raw.unsafe(query, params);
      await hooks.after?.(query, params, rows); return rows;
    },
  } });
  async function check(name, run) {
    await t.test(name, async () => {
      await f.reset('public, pg_temp, pg_catalog');
      await f.pg.exec('TRUNCATE public.request_usage_settlements, public.request_usage_settlement_outbox, pg_temp.request_usage_settlements, pg_temp.request_usage_settlement_outbox');
      await run();
    });
  }
  await check('schema follows 68 migrations, fully binds claim identity and requires a committed outbox', async () => {
    assert.equal(f.migrations.length, 68); assert.ok(!f.migrations.some(x => x.includes('settlement-facts')));
    const constraints = (await f.pg.query(`SELECT conname, condeferrable, condeferred, convalidated FROM pg_catalog.pg_constraint
      WHERE conrelid=$1::regclass`, [fact])).rows;
    assert.ok(constraints.every(x => x.convalidated));
    const reciprocal = constraints.find(x => x.conname === 'request_usage_settlements_require_outbox');
    assert.equal(reciprocal.condeferrable, true); assert.equal(reciprocal.condeferred, true);
    assert.ok(constraints.some(x => x.conname === 'request_usage_settlements_claim'));
    const funcs = (await f.pg.query(`SELECT p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname IN ('guard_usage_settlement_fact','enqueue_usage_settlement_fact','reject_usage_settlement_mutation')`, [g])).rows;
    assert.equal(funcs.length, 3); assert.ok(funcs.every(x => !x.prosecdef && x.proconfig[0] === 'search_path=pg_catalog, pg_temp'));
    assert.equal(typeof repo.commit, 'undefined'); assert.equal(typeof repo.claim, 'undefined');
    for (const path of ['../context.ts', '../../index.ts']) assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /usage-settlement-facts-postgres/);
  });
  await check('missing, prepared, and expired-before-dispatch intents cannot accept a fact', async () => {
    const value = sample(); await assert.rejects(repo.persist(value), SettlementConflictError);
    await prepare(value, false, await deadline(100)); await assert.rejects(repo.persist(value), SettlementConflictError);
    await f.pg.query('SELECT pg_sleep(0.15)'); assert.equal(await intents.classifyOverdue(value.intent, 0), true);
    await assert.rejects(repo.persist(value), SettlementConflictError); assert.deepEqual(await count(), { facts: 0, entries: 0 });
  });
  await check('a matching claimed intent accepts one immutable fact and discovery entry without any monetary write', async () => {
    const value = sample(); await prepare(value); const before = await f.snapshot(g);
    const ref = await repo.persist(value); assert.equal(Object.isFrozen(ref), true);
    assert.deepEqual(await repo.load(ref), value); assert.deepEqual(await repo.persist(value), ref);
    assert.deepEqual(await count(), { facts: 1, entries: 1 }); assert.deepEqual(await f.snapshot(g), before);
    const [{ reference: listed }] = await repo.listForRecovery('user', 'workspace', 1); assert.deepEqual(listed, ref);
  });
  await check('late authoritative input for an unknown dispatch retains execution uncertainty', async () => {
    const value = sample(); await prepare(value, true, await deadline(150)); await f.pg.query('SELECT pg_sleep(0.2)');
    assert.equal(await intents.classifyOverdue(value.intent, 1), true); const before = await intents.inspect(value.intent);
    const ref = await repo.persist(value); assert.deepEqual(await repo.load(ref), value);
    assert.deepEqual(await intents.inspect(value.intent), before); assert.equal(before.state, 'outcome_unknown');
  });
  for (const [name, edit] of [
    ['claim', x => x.dispatchClaimId = randomUUID()], ['context', x => x.intent.contextSha256 = 'b'.repeat(64)],
    ['price', x => x.params.requestLog.standardCost = 1], ['usage', x => x.params.requestLog.rawUsage = '{"images":2}'],
    ['recorded time', x => x.recordedAtIso = '2026-09-07T00:00:00.000Z'],
    ['operation', x => { x.intent.operation = 'images.edits'; x.params.requestLog.requestOperation = 'images.edits'; }],
  ]) await check(`same request cannot replace frozen ${name}`, async () => {
    const value = sample(); await prepare(value); const ref = await repo.persist(value), changed = structuredClone(value); edit(changed);
    await assert.rejects(repo.persist(changed)); assert.deepEqual(await repo.load(ref), value);
    assert.deepEqual(await count(), { facts: 1, entries: 1 });
  });
  await check('a different already-claimed attempt cannot overwrite the existing final-request fact', async () => {
    const value = sample(); await prepare(value); const ref = await repo.persist(value);
    const next = structuredClone(value); next.intent.attemptIndex = 2; next.dispatchClaimId = randomUUID();
    next.params.requestLog.providerAttempts.push({ ...next.params.requestLog.providerAttempts[0], attemptIndex: 2 });
    await prepare(next); await assert.rejects(repo.persist(next), SettlementConflictError);
    assert.deepEqual(await repo.load(ref), value); assert.deepEqual(await count(), { facts: 1, entries: 1 });
  });
  for (const patch of [{ requestId: 'other' }, { attemptIndex: 2 }, { userId: 'other' }, { apiKeyId: 'other-key' },
    { workspaceId: 'other-workspace' }, { operation: 'images.edits' }, { contextSha256: 'b'.repeat(64) },
    { dispatchClaimId: '00000000-0000-0000-0000-000000000001' }, { payloadSha256: 'b'.repeat(64) }]) {
    await check(`load rejects mismatched reference ${Object.keys(patch)[0]}`, async () => {
      const value = sample(); await prepare(value); const ref = await repo.persist(value);
      await assert.rejects(repo.load({ ...ref, ...patch }), SettlementConflictError);
      assert.deepEqual(await repo.listForRecovery('other', 'other-workspace', 50), []);
    });
  }
  await check('invalid references, cursors, batches and payloads reject before SQL', async () => {
    let sql = 0; const bad = createUsageSettlementFactsRepositoryPostgres({ driver: 'postgres', raw: { unsafe() { sql++; throw new Error('unexpected SQL'); } } });
    const ref = await reference(sample());
    for (const patch of [{ requestId: 'x\n' }, { requestId: 'x'.repeat(201) }, { userId: null }, { apiKeyId: 1 },
      { workspaceId: undefined }, { attemptIndex: 0 }, { attemptIndex: 33 }, { contextSha256: 'a'.repeat(64)+'\n' },
      { dispatchClaimId: randomUUID()+'\n' }, { payloadSha256: 'b'.repeat(64)+'\n' }, { operation: 'chat' }]) {
      await assert.rejects(bad.load({ ...ref, ...patch }), TypeError);
    }
    for (const limit of [0, 51, NaN, 0.5]) await assert.rejects(bad.listForRecovery('user', 'workspace', limit), TypeError);
    for (const createdAtMs of [-1, NaN, Number.MAX_SAFE_INTEGER+1]) await assert.rejects(bad.listForRecovery('user', 'workspace', 1, { createdAtMs, requestId: 'x' }), TypeError);
    await assert.rejects(bad.listForRecovery('user', 'workspace', 1, { createdAtMs: 1, requestId: 'x\n' }), TypeError);
    for (const edit of [x => x.params.requestLog.requestBody='body', x => x.params.requestLog.apiToken='not-a-real-token',
      x => x.params.requestLog.rawUsage='x'.repeat(65537), x => x.params.requestLog.totalTokens=NaN,
      x => Object.defineProperty(x.params,'chargedCost',{get(){ assert.fail('Getter executed'); }})]) {
      const value = sample(); edit(value); await assert.rejects(bad.persist(value), TypeError);
    }
    assert.equal(sql, 0);
    for (const driver of ['d1','mysql',undefined]) assert.throws(() => createUsageSettlementFactsRepositoryPostgres({ driver }), /PostgreSQL/);
  });
  await check('persistence and load own caller values across asynchronous boundaries', async () => {
    const value = sample(), original = structuredClone(value); await prepare(value);
    const pending = repo.persist(value); value.intent.userId='other'; value.params.requestLog.rawUsage='changed';
    const ref = await pending; assert.deepEqual(await repo.load(ref), original);
    const mutable = { ...ref };
    const delayed = wrapper({ after(query) { if (query.startsWith('SELECT')) mutable.userId='other'; } });
    assert.deepEqual(await delayed.load(mutable), original);
  });
  await check('before-write failure leaves neither row; committed ACK loss reconciles both without resubmission', async () => {
    const value = sample(); await prepare(value);
    await assert.rejects(wrapper({ before(query) { if(query.startsWith('INSERT')) throw new Error('before write'); } }).persist(value), SettlementConflictError);
    assert.deepEqual(await count(), { facts: 0, entries: 0 }); let writes=0;
    const ref = await wrapper({ after(query) { if(query.startsWith('INSERT')) { writes++; throw new Error('ACK lost'); } } }).persist(value);
    assert.equal(writes,1); assert.deepEqual(await count(),{ facts:1,entries:1 }); assert.deepEqual(await repo.load(ref),value);
  });
  await check('ACK and readback loss never claims confirmed persistence or retries the write', async () => {
    const value=sample(); await prepare(value); let writes=0;
    await assert.rejects(wrapper({ before(query) { if(query.startsWith('SELECT')) throw new Error('read unavailable'); },
      after(query) { if(query.startsWith('INSERT')) { writes++; throw new Error('ACK lost'); } } }).persist(value), /read unavailable/);
    assert.equal(writes,1); assert.deepEqual(await count(),{ facts:1,entries:1 });
    assert.deepEqual(await repo.load(await reference(value)),value);
  });
  await check('actual enqueue error rolls back the snapshot and does not touch funds', async () => {
    const value=sample(); await prepare(value); const before=await f.snapshot(g);
    await f.pg.exec(`CREATE FUNCTION ${g}.fixture_reject_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture enqueue failed'; END $$;
      CREATE TRIGGER fixture_reject_enqueue BEFORE INSERT ON ${outbox} FOR EACH ROW EXECUTE FUNCTION ${g}.fixture_reject_enqueue()`);
    try { await assert.rejects(repo.persist(value),SettlementConflictError); assert.deepEqual(await count(),{facts:0,entries:0}); }
    finally { await f.pg.exec(`DROP TRIGGER fixture_reject_enqueue ON ${outbox}; DROP FUNCTION ${g}.fixture_reject_enqueue()`); }
    assert.deepEqual(await f.snapshot(g),before);
  });
  await check('disabled enqueue trigger cannot leave an undiscoverable committed fact: reciprocal FK rejects at COMMIT', async () => {
    const value=sample(); await prepare(value);
    await f.pg.exec(`ALTER TABLE ${fact} DISABLE TRIGGER request_usage_settlements_enqueue`);
    try {
      let inserted=false;
      await assert.rejects(f.pg.transaction(async tx => { await tx.query(insertSql,await insertArgs(value)); inserted=true; }), /require_outbox/);
      assert.equal(inserted,true,'INSERT succeeds but deferred constraint must fail COMMIT');
      assert.deepEqual(await count(),{facts:0,entries:0});
      await assert.rejects(repo.persist(value),SettlementConflictError);
      assert.deepEqual(await count(),{facts:0,entries:0});
    } finally { await f.pg.exec(`ALTER TABLE ${fact} ENABLE TRIGGER request_usage_settlements_enqueue`); }
  });
  await check('orphan outbox or forged digest/metadata cannot be inserted through direct SQL', async () => {
    await assert.rejects(f.pg.query(`INSERT INTO ${outbox} VALUES ('orphan',$1,1)`,['a'.repeat(64)]),/foreign key/);
    const value=sample(); await prepare(value); const good=await insertArgs(value);
    for (const [index, replacement] of [[2,'other'],[4,'other-workspace'],[6,'b'.repeat(64)],[7,randomUUID()],[8,'b'.repeat(64)],[9,2],[10,'{}'],[11,'2026-02-31T00:00:00.000Z']]) {
      const params=[...good]; params[index]=replacement; await assert.rejects(f.pg.query(insertSql,params));
    }
    assert.deepEqual(await count(),{facts:0,entries:0});
  });
  await check('v1 envelope rejects duplicate outer fields, nested lookalikes, invalid params and trailing tokens',async()=>{
    const value=sample(); await prepare(value); const good=await insertArgs(value);
    const marker=',"params":', suffix=`,"recordedAtIso":"${value.recordedAtIso}","version":1}`;
    const prefix=good[10].slice(0,good[10].indexOf(marker)+marker.length);
    for(const body of ['null','[]','"object"','1','{} , "intent":{}','{} , "dispatchClaimId":"other"',
      '{} , "params":{}','{} , "recordedAtIso":"other"','{} , "version":2','{} {}','{"broken":}',
      '{"lookalike":'+JSON.stringify({intent:value.intent,dispatchClaimId:value.dispatchClaimId})+'},"intent":{}']) {
      const params=[...good]; params[10]=prefix+body+suffix; params[8]=await settlementDigest(params[10]);
      await assert.rejects(f.pg.query(insertSql,params));
    }
    // Valid JSON with the exact body but noncanonical outer order or an added field is rejected too.
    for(const json of [good[10].replace('"version":1}', '"version":1,"extra":0}'),
      good[10].replace('"dispatchClaimId":', '"wrongClaimField":'), ' '+good[10],good[10]+' ']) {
      const params=[...good]; params[10]=json; params[8]=await settlementDigest(json); await assert.rejects(f.pg.query(insertSql,params));
    }
    assert.deepEqual(await count(),{facts:0,entries:0});
  });
  for (const relation of [fact,outbox]) for (const verb of ['UPDATE','DELETE']) {
    await check(`${verb} cannot mutate immutable ${relation}`,async()=>{
      const value=sample(); await prepare(value); const ref=await repo.persist(value);
      await assert.rejects(f.pg.query(verb==='UPDATE'?`UPDATE ${relation} SET payload_sha256=$1 WHERE request_id=$2`:`DELETE FROM ${relation} WHERE payload_sha256=$1 AND request_id=$2`,[ref.payloadSha256,ref.requestId]),/immutable/);
      assert.deepEqual(await repo.load(ref),value); assert.deepEqual(await count(),{facts:1,entries:1});
    });
  }
  await check('corrupt/noncanonical returned content fails validation rather than becoming accepted facts',async()=>{
    const value=sample(); await prepare(value); const ref=await repo.persist(value);
    for(const edit of [row=>row.payload_json='{}',row=>row.payload_json=' '+row.payload_json,row=>row.payload_json=row.payload_json.replace('"version":1','"version":1,"version":1')]) {
      await assert.rejects(wrapper({after(query,params,rows){if(query.startsWith('SELECT'))edit(rows[0]);}}).load(ref),SettlementSnapshotInvalidError);
    }
    await assert.rejects(wrapper({after(query,params,rows){if(query.startsWith('SELECT'))rows[0].recorded_at='different';}}).load(ref),SettlementConflictError);
    await assert.rejects(wrapper({after(query,params,rows){if(query.startsWith('SELECT'))rows[0].user_id='other';}}).load(ref),SettlementConflictError);
  });
  await check('UTF-8 and escaped control characters preserve exact encoder bytes and database digest',async()=>{
    const value=sample(); value.params.requestLog.rawUsage=JSON.stringify({unit:'图片',extra:'\u0000',tag:'🚀'});
    value.params.requestLog.errorMessage=String.fromCharCode(...Array.from({length:32},(_,i)=>i))+'\ud800|\udfff|🚀|图片|\\u0000|\"},\"intent\":{}';
    await prepare(value); const ref=await repo.persist(value); const encoded=await encodeUsageSettlement(value);
    const row=(await f.pg.query(`SELECT payload_json,payload_sha256 FROM ${fact} WHERE request_id=$1`,[ref.requestId])).rows[0];
    assert.equal(row.payload_json,encoded.json); assert.equal(row.payload_sha256,encoded.sha256); assert.deepEqual(await repo.load(ref),value);
  });
  await check('edits and the maximum compatible attempt retain the same v1 framing',async()=>{
    const value=sample(); value.intent.operation='images.edits'; value.params.requestLog.requestOperation='images.edits';
    value.intent.attemptIndex=32;
    value.params.requestLog.providerAttempts=Array.from({length:32},(_,i)=>({...value.params.requestLog.providerAttempts[0],attemptIndex:i+1}));
    await prepare(value); const ref=await repo.persist(value); assert.deepEqual(await repo.load(ref),value);
  });
  await check('many duplicate producers retain one fact and one discovery entry',async()=>{
    const value=sample(); await prepare(value); const refs=await Promise.all(Array.from({length:8},()=>repo.persist(value)));
    assert.ok(refs.every(x=>x.payloadSha256===refs[0].payloadSha256)); assert.deepEqual(await count(),{facts:1,entries:1});
  });
  await check('bounded keyset discovery pages return references only and can resume within a full sweep',async()=>{
    const refs=[];
    for(let index=0;index<53;index++){const value=sample();await prepare(value);refs.push(await repo.persist(value));}
    const first=await repo.listForRecovery('user','workspace',50); assert.equal(first.length,50);
    const second=await repo.listForRecovery('user','workspace',50,first.at(-1).cursor);assert.equal(second.length,3);
    assert.deepEqual(new Set([...first,...second].map(x=>x.reference.requestId)),new Set(refs.map(x=>x.requestId)));
    assert.ok([...first,...second].every(x=>Object.isFrozen(x)&&Object.isFrozen(x.reference)&&Object.isFrozen(x.cursor)));
    assert.deepEqual(await repo.listForRecovery('other','other-workspace',50),[]);
    assert.ok(f.queries.filter(x=>x.query.includes('ORDER BY s.created_at_ms')).every(x=>!x.query.includes('payload_json')));
    // A pagination cursor is NOT a durable processed watermark; consumers must rescan and deduplicate.
  });
  for(const searchPath of ['public,pg_temp,pg_catalog','pg_temp,public,pg_catalog','pg_catalog,cinatoken_gateway,pg_temp']) {
    await check(`schema-qualified facts and outbox ignore shadows: ${searchPath}`,async()=>{
      await f.pg.exec(`SET search_path TO ${searchPath}`); const value=sample();await prepare(value);
      const before={public:await f.snapshot('public'),temp:await f.snapshot('pg_temp'),actual:await f.snapshot(g)};
      const ref=await repo.persist(value);assert.deepEqual(await repo.load(ref),value);assert.equal((await repo.listForRecovery('user','workspace',50)).length,1);
      assert.deepEqual(await f.snapshot('public'),before.public);assert.deepEqual(await f.snapshot('pg_temp'),before.temp);assert.deepEqual(await f.snapshot(g),before.actual);
      for(const schema of ['public','pg_temp'])for(const name of ['request_usage_settlements','request_usage_settlement_outbox'])assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${schema}.${name}`)).rows[0].n,0);
    });
  }
  await check('scan has a tenant-first ordered index, with no performance claim from a tiny fixture',async()=>{
    const rows=(await f.pg.query(`SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND indexname='request_usage_settlements_scope_scan'`,[g])).rows;
    assert.match(rows[0].indexdef,/user_id, workspace_id, created_at_ms, request_id/);
    await f.pg.transaction(async tx=>{
      await tx.exec('SET LOCAL enable_seqscan=off');
      const plan=(await tx.query(`EXPLAIN SELECT s.request_id FROM ${fact} s JOIN ${outbox} o
        ON o.request_id=s.request_id AND o.payload_sha256=s.payload_sha256 AND o.created_at_ms=s.created_at_ms
        WHERE s.user_id='user' AND s.workspace_id='workspace' ORDER BY s.created_at_ms,s.request_id LIMIT 50`)).rows.map(x=>x['QUERY PLAN']).join('\n');
      assert.match(plan,/request_usage_settlements_scope_scan/);
    });
  });
  await check('missing outbox schema rejects instead of falling back to unprotected persistence',async()=>{
    const value=sample();await prepare(value);await f.pg.exec(`DROP TABLE ${outbox} CASCADE`);
    await assert.rejects(repo.persist(value),/does not exist/);
    assert.equal((await f.pg.query(`SELECT count(*)::int AS n FROM ${fact}`)).rows[0].n,0);
  });
});

test('fresh process discovers and validates the original fact after ACK/read loss without charging or inference', { timeout: 90_000 }, () => {
  const parent = realpathSync(tmpdir()), owned = mkdtempSync(join(parent, 'cinatoken-pg-facts-'));
  const child = fileURLToPath(new URL('../../test-support/postgres-settlement-facts-child.mjs', import.meta.url));
  try {
    for (const mode of ['write', 'read']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', child, join(owned, 'db'), mode], {
        encoding: 'utf8', timeout: 40_000, env: { ...process.env, GATEWAY_PG_FINANCIAL_BASELINE: '' },
      });
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).mode, mode);
    }
  } finally {
    // Only remove this exact, disposable mkdtemp fixture after both bounded child runs finish.
    const target = realpathSync(owned);
    assert.equal(dirname(target), parent); assert.equal(resolve(target), resolve(owned));
    assert.ok(basename(target).startsWith('cinatoken-pg-facts-'));
    rmSync(target, { recursive: true });
  }
});
