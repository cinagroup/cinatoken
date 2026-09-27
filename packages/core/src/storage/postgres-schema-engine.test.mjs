// Opt-in local SQL-engine suite. Requires a local PGlite ESM path, never a DSN.
// This executes PostgreSQL/WASM, not postgres.js wire transport or Hyperdrive.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createBudgetRepository, gatewayTables, identifier, tableQueries } from '../test-support/postgres-schema-contract.mjs';

assert.ok(process.env.GATEWAY_PGLITE_MODULE, 'Set GATEWAY_PGLITE_MODULE to a locally installed PGlite ESM file (not a database URL).');
assert.doesNotMatch(process.env.GATEWAY_PGLITE_MODULE, /^[a-z]+:\/\//i);
const { PGlite } = await import(pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href);
const schemaName = 'cinatoken_gateway';

test('PostgreSQL engine: all ORM tables ignore hostile or empty search paths', async t => {
  const pg = await PGlite.create();
  try {
    await pg.exec(`CREATE SCHEMA ${schemaName}`);
    for (const [name, table] of gatewayTables) {
      await t.test(name, async () => {
        const q = tableQueries(table);
        const target = identifier(q.config.name);
        const column = identifier(q.column.name);
        // Minimal synthetic relations test emitted DML, not migration correctness.
        const columns = q.config.columns.map(c => `${identifier(c.name)} ${c.getSQLType()}`).join(', ');
        await pg.exec(`CREATE TABLE ${schemaName}.${target} (${columns}); CREATE TABLE public.${target} (${columns})`);
        for (const searchPath of ['public', 'pg_catalog']) {
          await pg.exec(`TRUNCATE ${schemaName}.${target}, public.${target};
            INSERT INTO ${schemaName}.${target} (${column}) VALUES ('gateway');
            INSERT INTO public.${target} (${column}) VALUES ('shadow');
            SET search_path TO ${searchPath}`);
          // Executing generated SQL directly bypasses Drizzle's result-key mapper.
          assert.deepEqual((await pg.query(q.select.sql, q.select.params)).rows, [{ [q.column.name]: 'gateway' }]);
          assert.deepEqual((await pg.query(q.update.sql, q.update.params)).rows, [{ [q.column.name]: 'updated' }]);
          assert.deepEqual((await pg.query(q.insert.sql, q.insert.params)).rows, [{ [q.column.name]: 'inserted' }]);
          assert.deepEqual((await pg.query(q.delete.sql, q.delete.params)).rows, [{ [q.column.name]: 'updated' }]);
          assert.deepEqual((await pg.query(`SELECT ${column} AS value FROM public.${target}`)).rows, [{ value: 'shadow' }]);
          assert.deepEqual((await pg.query(`SELECT ${column} AS value FROM ${schemaName}.${target}`)).rows, [{ value: 'inserted' }]);
        }
      });
    }
  } finally { await pg.close(); }
});

const now = '2026-09-16T00:00:00.000Z';
const expires = '2026-09-16T00:01:00.000Z';
const later = '2026-09-16T00:03:00.000Z';
const reservation = (requestId = 'request', overrides = {}) => ({
  requestId, userId: 'user', apiKeyId: 'key', expectedBudgetEpoch: 0,
  reservedMicros: 100_000, nowIso: now, expiresAtIso: expires, ...overrides,
});
const migration = readFileSync(new URL('../../migrations-postgres/0040_user_budget_reservations.sql', import.meta.url), 'utf8');

test('PostgreSQL engine: raw user-budget reservation transactions stay in the gateway schema', async t => {
  const pg = await PGlite.create();
  try {
    await pg.exec(`CREATE SCHEMA ${schemaName}`);
    for (const schema of [schemaName, 'public']) {
      await pg.exec(`SET search_path TO ${schema};
        CREATE TABLE users (id text PRIMARY KEY, budget_max numeric(18,6), budget_spent numeric(18,6) NOT NULL DEFAULT 0,
          budget_period text NOT NULL DEFAULT 'none', budget_reset_at timestamptz, updated_at timestamptz NOT NULL);
        CREATE TABLE api_keys (id text PRIMARY KEY, user_id text NOT NULL, status text NOT NULL)`);
      await pg.exec(migration);
    }
    const account = async () => (await pg.query(`SELECT budget_epoch, budget_reserved_micros, budget_spent FROM ${schemaName}.users WHERE id = 'user'`)).rows[0];
    const row = async (id = 'request') => (await pg.query(`SELECT * FROM ${schemaName}.user_budget_reservations WHERE request_id = $1`, [id])).rows[0];
    for (const searchPath of ['public', 'pg_catalog']) {
      async function scenario(name, run) {
        await t.test(`${searchPath}: ${name}`, async () => {
          for (const schema of [schemaName, 'public']) {
            await pg.exec(`TRUNCATE ${schema}.user_budget_reservations, ${schema}.api_keys, ${schema}.users;
              INSERT INTO ${schema}.users (id, budget_max, budget_spent, updated_at) VALUES ('user', 10, 1, '${now}');
              INSERT INTO ${schema}.api_keys VALUES ('key', 'user', 'active')`);
          }
          await pg.exec(`SET search_path TO ${searchPath}`);
          const shadowBefore = (await pg.query('SELECT * FROM public.users')).rows;
          const queries = [];
          let beginCount = 0, loseAck = false;
          const adapter = engine => ({ unsafe: async (query, params = []) => {
            queries.push({ query, params });
            return (await engine.query(query, params)).rows;
          } });
          const raw = { ...adapter(pg), begin: async callback => {
            beginCount++;
            const result = await pg.transaction(tx => callback(adapter(tx)));
            if (loseAck) { loseAck = false; throw Error('synthetic_commit_ack_lost'); }
            return result;
          } };
          const repo = createBudgetRepository({ driver: 'postgres', raw, drizzle: {} });
          try {
            await run({ repo, queries, account, row, beginCount: () => beginCount, loseAck: () => { loseAck = true; } });
            for (const { query } of queries) {
              assert.doesNotMatch(query, /\b(?:FROM|UPDATE|INTO)\s+(?:users|api_keys|user_budget_reservations)\b/i);
              assert.doesNotMatch(query, /\bSET\s+search_path\b/i);
            }
          } finally {
            assert.deepEqual((await pg.query('SELECT * FROM public.users')).rows, shadowBefore);
            assert.deepEqual((await pg.query('SELECT * FROM public.user_budget_reservations')).rows, []);
          }
        });
      }
      await scenario('reserve and idempotent replay debit the same budget only once', async ({ repo, account, row }) => {
        assert.equal((await repo.reserve(reservation())).status, 'reserved');
        assert.equal((await repo.reserve(reservation())).status, 'idempotent');
        assert.equal(Number((await account()).budget_reserved_micros), 100_000);
        assert.equal((await row()).state, 'reserved');
        assert.equal((await repo.reserve(reservation('request', { reservedMicros: 200_000 }))).status, 'conflict');
      });
      await scenario('wrong key ownership cannot reserve', async ({ repo, account }) => {
        await pg.exec(`UPDATE ${schemaName}.api_keys SET user_id = 'someone_else'`);
        assert.equal((await repo.reserve(reservation())).status, 'conflict');
        assert.equal(Number((await account()).budget_reserved_micros), 0);
      });
      await scenario('blocked, stale and unlimited admissions do not write a reservation', async ({ repo, account, row }) => {
        assert.equal((await repo.reserve(reservation('request', { reservedMicros: 9_000_001 }))).status, 'blocked');
        assert.equal((await repo.reserve(reservation('request', { expectedBudgetEpoch: 1 }))).status, 'stale');
        await pg.exec(`UPDATE ${schemaName}.users SET budget_max = NULL`);
        assert.equal((await repo.reserve(reservation())).status, 'unlimited');
        assert.equal(Number((await account()).budget_reserved_micros), 0);
        assert.equal(await row(), undefined);
      });
      await scenario('dispatch and duplicate dispatch retain the reservation', async ({ repo, row }) => {
        assert.equal((await repo.reserve(reservation())).status, 'reserved');
        assert.equal(await repo.markDispatched('request', now, expires), true);
        assert.equal(await repo.markDispatched('request', now, expires), true);
        assert.equal((await row()).state, 'dispatched');
        assert.equal(await repo.release('request', now, 'client_abort'), 0);
        assert.equal((await row()).state, 'dispatched');
      });
      await scenario('pre-dispatch release does not bill, duplicate release is idempotent', async ({ repo, account, row }) => {
        await repo.reserve(reservation());
        assert.equal(await repo.release('request', now, 'cancel'), 1);
        assert.equal(await repo.release('request', now, 'cancel'), 1);
        assert.equal(Number((await account()).budget_reserved_micros), 0);
        assert.equal(Number((await account()).budget_spent), 1);
        assert.equal((await row()).state, 'released');
      });
      await scenario('forfeit after dispatch bills the reservation exactly once', async ({ repo, account, row }) => {
        await repo.reserve(reservation());
        assert.equal(await repo.markDispatched('request', now, expires), true);
        assert.equal(await repo.forfeitDispatched('request', later, 'unknown'), 1);
        assert.equal(await repo.forfeitDispatched('request', later, 'unknown'), 1);
        assert.equal(Number((await account()).budget_reserved_micros), 0);
        assert.equal(Number((await account()).budget_spent), 1.1);
        assert.equal((await row()).state, 'expired');
      });
      await scenario('expiry releases reserved work and bills dispatched work', async ({ repo, account, row }) => {
        await repo.reserve(reservation('reserved'));
        await repo.reserve(reservation('dispatched'));
        await repo.markDispatched('dispatched', now, expires);
        assert.equal(await repo.expireBefore(later, 10), 2);
        assert.equal(await repo.expireBefore(later, 10), 0);
        assert.equal((await row('reserved')).state, 'released');
        assert.equal((await row('dispatched')).state, 'expired');
        assert.equal(Number((await account()).budget_spent), 1.1);
        assert.equal(Number((await account()).budget_reserved_micros), 0);
      });
      await scenario('releasing an old epoch cannot change the current account', async ({ repo, account, row }) => {
        await repo.reserve(reservation());
        await pg.exec(`UPDATE ${schemaName}.users SET budget_epoch = 1, budget_reserved_micros = 0`);
        assert.equal(await repo.release('request', now, 'epoch_changed'), 1);
        assert.equal(Number((await account()).budget_epoch), 1);
        assert.equal(Number((await account()).budget_reserved_micros), 0);
        assert.equal((await row()).state, 'released');
      });
      await scenario('failed INSERT rolls back the account debit without mutation replay', async ({ repo, account, row, queries, beginCount }) => {
        await pg.exec(`ALTER TABLE ${schemaName}.user_budget_reservations ADD CONSTRAINT fixture_failure CHECK (FALSE) NOT VALID`);
        try {
          await assert.rejects(repo.reserve(reservation()), { code: '23514' });
          assert.equal(Number((await account()).budget_reserved_micros), 0);
          assert.equal(await row(), undefined);
          assert.equal(queries.filter(({ query }) => /INSERT INTO/.test(query)).length, 1);
          assert.equal(beginCount(), 1);
        } finally {
          await pg.exec(`ALTER TABLE ${schemaName}.user_budget_reservations DROP CONSTRAINT fixture_failure`);
        }
      });
      await scenario('synthetic lost commit ACK uses qualified readback, never a second transaction', async ({ repo, account, loseAck, beginCount }) => {
        loseAck();
        assert.equal((await repo.reserve(reservation())).status, 'idempotent');
        assert.equal(Number((await account()).budget_reserved_micros), 100_000);
        assert.equal(beginCount(), 1);
      });
      await scenario('missing gateway table fails instead of falling back to public', async ({ repo }) => {
        await pg.exec(`ALTER TABLE ${schemaName}.user_budget_reservations RENAME TO fixture_hidden_reservations`);
        try {
          await assert.rejects(repo.reserve(reservation()), { code: '42P01' });
        } finally {
          await pg.exec(`ALTER TABLE ${schemaName}.fixture_hidden_reservations RENAME TO user_budget_reservations`);
        }
      });
    }
  } finally { await pg.close(); }
});
