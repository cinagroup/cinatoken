// Local SQL semantics only. PGlite does not prove native multi-session lock behavior.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPostgresPortalLedgerRepository } from './portal-marketplace.impl.ts';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath), 'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);

test('PostgreSQL shared-key usage projection rebuilds from earning detail and rejects mismatched identity', async () => {
  const pg = await PGlite.create();
  try {
    await pg.exec(`
      CREATE SCHEMA cinatoken_gateway;
      CREATE TABLE cinatoken_gateway.shared_keys (
        id text PRIMARY KEY, served_input_tokens bigint NOT NULL DEFAULT 0,
        served_output_tokens bigint NOT NULL DEFAULT 0, earned_total numeric(18,6) NOT NULL DEFAULT 0,
        last_used_at timestamptz, updated_at timestamptz
      );
      CREATE TABLE cinatoken_gateway.shared_key_earnings (
        id text PRIMARY KEY, request_log_id text NOT NULL UNIQUE,
        shared_key_id text NOT NULL REFERENCES cinatoken_gateway.shared_keys(id),
        input_tokens integer NOT NULL, output_tokens integer NOT NULL,
        net_amount numeric(18,6) NOT NULL, created_at timestamptz NOT NULL
      );
      INSERT INTO cinatoken_gateway.shared_keys VALUES ('k1', 999, 999, 999, NULL, NULL);
      INSERT INTO cinatoken_gateway.shared_key_earnings VALUES
        ('e1','r1','k1',10,20,1.25,'2026-09-01T00:00:00.000Z'),
        ('e2','r2','k1',30,40,2.75,'2026-09-02T00:00:00.000Z');
    `);
    const raw = {
      begin: run => pg.transaction(tx => run({ unsafe: async (query, params = []) => (await tx.query(query, params)).rows })),
    };
    const ledger = createPostgresPortalLedgerRepository({ driver: 'postgres', raw, drizzle: {} });
    const projection = async () => (await pg.query(`SELECT served_input_tokens::text AS input,
      served_output_tokens::text AS output, earned_total::text AS net,
      last_used_at::text AS last_used_at FROM cinatoken_gateway.shared_keys WHERE id='k1'`)).rows[0];
    const first = async () => {
      const row = await projection();
      assert.equal(row.input, '40');
      assert.equal(row.output, '60');
      assert.equal(row.net, '4.000000');
      assert.match(row.last_used_at, /2026-09-02/);
    };
    await ledger.rebuildSharedKeyUsageFromEarnings('r1', 'k1', '2026-09-03T00:00:00.000Z');
    await first();
    await ledger.rebuildSharedKeyUsageFromEarnings('r1', 'k1', '2026-09-03T00:00:00.000Z');
    await first();
    await assert.rejects(ledger.rebuildSharedKeyUsageFromEarnings('r1', 'wrong-key', '2026-09-03T00:00:00.000Z'),
      /shared_key_usage_rebuild_key_missing/);
    await assert.rejects(ledger.rebuildSharedKeyUsageFromEarnings('missing', 'k1', '2026-09-03T00:00:00.000Z'),
      /shared_key_usage_rebuild_earning_missing_or_mismatched/);
    await first();
    await pg.exec(`INSERT INTO cinatoken_gateway.shared_key_earnings VALUES
      ('e3','r3','k1',5,7,0.5,'2026-09-04T00:00:00.000Z')`);
    await ledger.rebuildSharedKeyUsageFromEarnings('r3', 'k1', '2026-09-05T00:00:00.000Z');
    const final = await projection();
    assert.equal(final.input, '45');
    assert.equal(final.output, '67');
    assert.equal(final.net, '4.500000');
    assert.match(final.last_used_at, /2026-09-04/);
  } finally {
    await pg.close();
  }
});
