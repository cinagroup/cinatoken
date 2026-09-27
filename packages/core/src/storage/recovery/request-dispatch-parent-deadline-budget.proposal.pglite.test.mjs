// Local proposal coverage only. PGlite does not prove native multi-session
// parent/attempt locks, lost COMMIT ACK, Workers identity or production grants.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath),
  'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const migrations = new URL('../../../migrations-postgres/', import.meta.url);
const sql = name => readFileSync(new URL(`../../../migrations-proposals/postgres/${name}`, import.meta.url), 'utf8');
const definer = sql('dispatch-intent-producer-definer.sql');
const oneClaim = sql('request-dispatch-single-claim.sql');
const parent = sql('request-dispatch-parent-deadline-budget.sql');
const g = 'cinatoken_gateway';
const requestTable = `${g}.request_dispatch_requests`;
const intentTable = `${g}.request_dispatch_intents`;
const hash = 'a'.repeat(64);
const requestHash = 'b'.repeat(64);
const alternateRouteHash = 'c'.repeat(64);
const base = (requestId, attemptIndex, expiry, maxAttempts = 2) => [
  requestId, attemptIndex, 'parent-user', 'parent-key', 'parent-space',
  'images.generations', requestHash, hash, expiry, maxAttempts,
];
const activation = "SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1'";

test('review-only request parent freezes scope, original deadline and attempt budget',
  { timeout: 150_000 }, async () => {
    assert.doesNotMatch(parent, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/imu);
    assert.doesNotMatch(parent, /^\s*(?:DELETE|TRUNCATE|DROP)\s/imu);
    assert.doesNotMatch(parent, /^\s*GRANT\s/imu);
    const pg = await PGlite.create();
    try {
      await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
        CREATE ROLE cinatoken_gateway_runtime;
        CREATE ROLE cinatoken_gateway_fact_producer;
        CREATE ROLE intent_producer;
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        SET ROLE cinatoken_gateway_migrator;
        CREATE TABLE ${g}.schema_migrations (
          version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      for (const name of files) {
        await pg.transaction(async tx => {
          await tx.exec(readFileSync(new URL(name, migrations), 'utf8'));
          await tx.query(`INSERT INTO ${g}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      await pg.exec(`INSERT INTO ${g}.users(id,email,budget_max,budget_spent)
          VALUES ('parent-user','parent@example.invalid',10,0),
            ('other-user','other-parent@example.invalid',10,0);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('parent-space','personal','parent-user','Parent','parent','active'),
            ('other-space','personal','other-user','Other','other-parent','active');
        INSERT INTO ${g}.api_keys(id,key,user_id,workspace_id)
          VALUES ('parent-key','parent-secret','parent-user','parent-space'),
            ('other-key','other-secret','other-user','other-space');`);
      const now = async (delta = 0) => Number((await pg.query(`SELECT
        (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + $1)::text AS n`,
      [delta])).rows[0].n);
      const prepare = (...args) => pg.query(`SELECT ${g}.prepare_request_dispatch_intent_v1(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`, args);
      const claim = (requestId, attemptIndex, id, revision = 0, routeHash = hash) => pg.query(`SELECT
        ${g}.claim_request_dispatch_intent_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`,
      [requestId, attemptIndex, 'parent-user', 'parent-key', 'parent-space',
        'images.generations', requestHash, routeHash, revision, id]);
      const classify = (requestId, attemptIndex, revision) => pg.query(`SELECT
        ${g}.classify_request_dispatch_intent_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) AS changed`,
      [requestId, attemptIndex, 'parent-user', 'parent-key', 'parent-space',
        'images.generations', requestHash, hash, revision]);
      const row = async requestId => (await pg.query(`SELECT
        original_created_at_ms::text AS created,expires_at_ms::text AS expiry,
        max_attempts,prepared_count,claim_count,first_claim_id
        FROM ${requestTable} WHERE request_id=$1`, [requestId])).rows[0];
      const install = async source => pg.transaction(async tx => {
        await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.exec(definer);
        await tx.exec("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
        await tx.exec(oneClaim);
        if (source) { await tx.exec(activation); await tx.exec(source); }
      });

      await install();
      await assert.rejects(pg.transaction(tx => tx.exec(parent)),
        /Explicit request dispatch parent activation assertion is missing/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS rel`,
        [requestTable])).rows[0].rel, null);

      // Neither old intent rows nor direct writer grants can be guessed into a
      // request-wide deadline/budget. Failed proposals leave data untouched.
      const oldExpiry = await now(60_000);
      await pg.query(`INSERT INTO ${intentTable}
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('old-request',1,'parent-user','parent-key','parent-space','images.generations',$1,$2)`,
      [hash, oldExpiry]);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation); await tx.exec(parent);
      }), /Existing dispatch intents need separately reviewed request backfill/u);
      assert.equal((await pg.query(`SELECT count(*)::int AS n FROM ${intentTable}
        WHERE request_id='old-request'`)).rows[0].n, 1);
      await pg.query(`DELETE FROM ${intentTable} WHERE request_id='old-request'`);

      await pg.exec(`GRANT INSERT ON ${intentTable} TO intent_producer`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation); await tx.exec(parent);
      }), /Direct dispatch intent writer privilege remains/u);
      await pg.exec(`REVOKE INSERT ON ${intentTable} FROM intent_producer`);
      await pg.exec(`RESET ROLE;
        GRANT cinatoken_gateway_migrator TO cinatoken_gateway_fact_producer;
        SET ROLE cinatoken_gateway_migrator`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation); await tx.exec(parent);
      }), /Known dispatch producer or runtime can bypass parent gate/u);
      await pg.exec(`RESET ROLE;
        REVOKE cinatoken_gateway_migrator FROM cinatoken_gateway_fact_producer;
        SET ROLE cinatoken_gateway_migrator`);
      await pg.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${g}
        GRANT EXECUTE ON FUNCTIONS TO intent_producer`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation); await tx.exec(parent);
      }), /New request parent function ACL exposes a nonowner/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS rel`,
        [requestTable])).rows[0].rel, null, 'unexpected default function grants roll back all DDL');
      await pg.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${g}
        REVOKE EXECUTE ON FUNCTIONS FROM intent_producer`);
      await pg.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${g}
        GRANT SELECT ON TABLES TO intent_producer`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation); await tx.exec(parent);
      }), /New request parent table ACL exposes a nonowner/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS rel`,
        [requestTable])).rows[0].rel, null, 'unexpected default table grants roll back all DDL');
      await pg.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${g}
        REVOKE SELECT ON TABLES FROM intent_producer`);
      await pg.exec(`RESET ROLE;
        GRANT cinatoken_gateway_migrator TO intent_producer;
        SET ROLE cinatoken_gateway_migrator`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation); await tx.exec(parent);
      }), /Nonowner migrator role membership can bypass parent gate/u);
      await pg.exec(`RESET ROLE;
        REVOKE cinatoken_gateway_migrator FROM intent_producer;
        SET ROLE cinatoken_gateway_migrator`);
      await pg.transaction(async tx => { await tx.exec(activation); await tx.exec(parent); });
      assert.notEqual((await pg.query(`SELECT pg_catalog.to_regclass($1) AS rel`,
        [requestTable])).rows[0].rel, null);

      await assert.rejects(prepare(...base('too-many-attempts', 1, await now(60_000), 4)),
        /max_attempts|attempt|check constraint/u);
      assert.equal(await row('too-many-attempts'), undefined);
      await assert.rejects(prepare(...base('too-long-request', 1, await now(301_000))),
        /Dispatch request V1 attempt or time ceiling exceeded/u);
      assert.equal(await row('too-long-request'), undefined);

      const expiry = await now(60_000);
      assert.equal((await prepare(...base('frozen', 1, expiry))).rows[0].accepted, true);
      const original = await row('frozen');
      assert.ok(Number(original.created) <= await now());
      assert.equal(original.expiry, String(expiry));
      assert.equal(original.max_attempts, 2);
      assert.equal(original.prepared_count, 1);
      assert.equal((await prepare(...base('frozen', 1, expiry))).rows[0].accepted, false);
      assert.deepEqual(await row('frozen'), original, 'duplicate does not reset parent time or budget');
      await assert.rejects(prepare(...base('frozen', 2, expiry + 1)),
        /frozen scope, deadline or attempt budget differs/u);
      await assert.rejects(prepare(...base('frozen', 2, expiry, 3)),
        /frozen scope, deadline or attempt budget differs/u);
      await assert.rejects(prepare(...base('frozen', 2, expiry).map((value, i) =>
        i === 6 ? 'd'.repeat(64) : value)),
      /frozen scope, deadline or attempt budget differs/u);
      await assert.rejects(prepare(...base('frozen', 2, expiry).map((value, i) => i === 3 ? 'other-key' : value)),
        /frozen scope, deadline or attempt budget differs/u);
      assert.equal((await prepare(...base('frozen', 2, expiry - 1000).map((value, i) =>
        i === 7 ? alternateRouteHash : value))).rows[0].accepted, true,
      'a second route can use another attempt context under the same request digest');
      assert.equal((await row('frozen')).prepared_count, 2);
      await assert.rejects(prepare(...base('frozen', 3, expiry - 1000)),
        /frozen scope, deadline or attempt budget differs/u);

      const grant = '11111111-1111-4111-8111-111111111111';
      assert.equal((await claim('frozen', 2, grant, 0, alternateRouteHash)).rows[0].accepted, true);
      assert.equal((await claim('frozen', 1, '22222222-2222-4222-8222-222222222222')).rows[0].accepted, false);
      assert.equal((await row('frozen')).claim_count, 1);
      assert.equal((await row('frozen')).first_claim_id, grant);

      const unknownExpiry = await now(1_000);
      assert.equal((await prepare(...base('unknown', 1, unknownExpiry))).rows[0].accepted, true);
      const unknownId = '33333333-3333-4333-8333-333333333333';
      assert.equal((await claim('unknown', 1, unknownId)).rows[0].accepted, true);
      await pg.query('SELECT pg_catalog.pg_sleep(1.1)');
      assert.equal((await classify('unknown', 1, 1)).rows[0].changed, true);
      assert.equal((await pg.query(`SELECT state FROM ${intentTable}
        WHERE request_id='unknown' AND attempt_index=1`)).rows[0].state, 'outcome_unknown');
      assert.equal((await row('unknown')).first_claim_id, unknownId);
      assert.equal((await row('unknown')).claim_count, 1);
      await assert.rejects(prepare(...base('unknown', 2, await now(60_000))),
        /frozen scope, deadline or attempt budget differs/u,
      'an expired first attempt cannot extend the original request deadline');

      const expiring = await now(1_000);
      assert.equal((await prepare(...base('expired-before', 1, expiring))).rows[0].accepted, true);
      await pg.query('SELECT pg_catalog.pg_sleep(1.1)');
      assert.equal((await classify('expired-before', 1, 0)).rows[0].changed, true);
      await assert.rejects(prepare(...base('expired-before', 2, await now(60_000))),
        /frozen scope, deadline or attempt budget differs/u);
      assert.equal((await claim('expired-before', 1, '44444444-4444-4444-8444-444444444444')).rows[0].accepted,
      false);

      const rollbackExpiry = await now(60_000);
      await assert.rejects(pg.transaction(async tx => {
        const rolled = await tx.query(`SELECT ${g}.prepare_request_dispatch_intent_v1(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS accepted`, base('rolled-back', 1, rollbackExpiry));
        assert.equal(rolled.rows[0].accepted, true);
        throw new Error('synthetic parent rollback');
      }), /synthetic parent rollback/u);
      assert.equal(await row('rolled-back'), undefined);

      await pg.exec(`GRANT USAGE ON SCHEMA ${g} TO intent_producer`);
      await pg.exec('SET ROLE intent_producer');
      assert.equal((await pg.query(`SELECT pg_catalog.has_table_privilege(
        'intent_producer',$1,'INSERT, UPDATE, DELETE, TRUNCATE') AS allowed`,
      [requestTable])).rows[0].allowed, false);
      await assert.rejects(prepare(...base('producer-denied', 1, await now(60_000))),
        /permission denied/u);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
    } finally {
      await pg.close();
    }
  });
