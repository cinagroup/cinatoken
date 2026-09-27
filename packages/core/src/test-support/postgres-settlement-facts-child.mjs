import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDispatchIntentRepositoryPostgres } from '../storage/recovery/dispatch-intent-postgres.ts';
import { createUsageSettlementFactsRepositoryPostgres } from '../storage/recovery/usage-settlement-facts-postgres.ts';
import { sample } from '../storage/recovery/usage-settlement-test-support.mjs';

const [dataDir, mode] = process.argv.slice(2);
assert.ok(dataDir && ['write', 'read'].includes(mode));
assert.ok(process.env.GATEWAY_PGLITE_MODULE);
assert.doesNotMatch(process.env.GATEWAY_PGLITE_MODULE, /^[a-z]+:\/\//i);
const { PGlite } = await import(pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href);
const pg = await PGlite.create({ dataDir });
const adapter = db => ({ unsafe: async (query, params = []) => (await db.query(query, params)).rows });
const client = { driver: 'postgres', raw: { ...adapter(pg), begin: run => pg.transaction(tx => run(adapter(tx))) } };
const facts = createUsageSettlementFactsRepositoryPostgres(client), intents = createDispatchIntentRepositoryPostgres(client);
try {
  if (mode === 'write') {
    await pg.exec('CREATE SCHEMA cinatoken_gateway');
    const dir = new URL('../../migrations-postgres/', import.meta.url);
    for (const file of readdirSync(dir).filter(x => x.endsWith('.sql') && x <= '0068_function_schema_resolution.sql').sort()) {
      await pg.transaction(tx => tx.exec(readFileSync(new URL(file, dir), 'utf8')));
    }
    for (const file of ['request-dispatch-intents.sql', 'request-usage-settlement-facts.sql']) {
      await pg.transaction(tx => tx.exec(readFileSync(new URL('../../migrations-proposals/postgres/' + file, import.meta.url), 'utf8')));
    }
    await pg.exec(`INSERT INTO cinatoken_gateway.users(id,email) VALUES ('recovery-user','restart@example.invalid');
      INSERT INTO cinatoken_gateway.workspaces(id,scope_type,personal_owner_user_id,name,slug,status) VALUES ('recovery-workspace','personal','recovery-user','Fixture','fixture','active');
      INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id) VALUES ('recovery-key','','recovery-user','recovery-workspace');`);
    const value = sample(0.25);
    value.params.requestLog.errorMessage = '\u0000\ud800图片';
    const expiry = Number((await pg.query('SELECT (floor(extract(epoch FROM clock_timestamp())*1000)::bigint+600000)::text AS n')).rows[0].n);
    await intents.prepare(value.intent, expiry);
    assert.equal(await intents.claim(value.intent, 0, value.dispatchClaimId), 'granted');
    const lostAckAndRead = createUsageSettlementFactsRepositoryPostgres({ ...client, raw: {
      async unsafe(query, params) {
        if (query.startsWith('SELECT')) throw new Error('synthetic read unavailable');
        await client.raw.unsafe(query, params); throw new Error('synthetic committed ACK loss');
      },
    } });
    await assert.rejects(lostAckAndRead.persist(value), /read unavailable/);
  } else {
    // No original in-memory request, digest, intent, price or claim is passed to this process.
    const entries = await facts.listForRecovery('recovery-user', 'recovery-workspace', 50);
    assert.equal(entries.length, 1);
    const ref = entries[0].reference, value = await facts.load(ref);
    assert.equal(value.params.chargedCost, 0.25);
    assert.equal(value.params.requestLog.pricingAudit, '{"fixture":"original-price","cost":0.25}');
    assert.equal(value.params.requestLog.errorMessage, '\u0000\ud800图片');
    assert.equal(value.intent.requestId, ref.requestId);
    assert.deepEqual(await facts.persist(value), ref);
    assert.equal(await intents.claim(value.intent, 1, ref.dispatchClaimId), 'not_granted');
    const row = (await pg.query(`SELECT
      (SELECT count(*)::int FROM cinatoken_gateway.request_usage_settlements) AS facts,
      (SELECT count(*)::int FROM cinatoken_gateway.request_usage_settlement_outbox) AS entries,
      (SELECT count(*)::int FROM cinatoken_gateway.api_key_request_logs) AS financial_logs,
      (SELECT budget_spent::text FROM cinatoken_gateway.users WHERE id='recovery-user') AS spent`)).rows[0];
    assert.deepEqual(row, { facts: 1, entries: 1, financial_logs: 0, spent: '0.000000' });
  }
} finally { await pg.close(); }
// Clean process close and disk reopen only; NOT abrupt crash, native WAL or financial recovery proof.
process.stdout.write(JSON.stringify({ mode }));
