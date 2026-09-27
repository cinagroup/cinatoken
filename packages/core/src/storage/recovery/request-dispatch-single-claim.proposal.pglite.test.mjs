// Review-only SQL proposal test. PGlite serializes sessions; native concurrent
// index conflicts, real origin identity and production activation need separate evidence.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createDispatchIntentRepositoryPostgres, PostgresDispatchClaimUncertainError } from './dispatch-intent-postgres.ts';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath),
  'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const migrationDir = new URL('../../../migrations-postgres/', import.meta.url);
const proposal = readFileSync(new URL('../../../migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url), 'utf8');
const definerProposal = readFileSync(new URL('../../../migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url), 'utf8');
const gateway = 'cinatoken_gateway';
const intents = `${gateway}.request_dispatch_intents`;
const indexName = 'request_dispatch_intents_one_claim_per_request';
const activation = "SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'";
const hash = 'a'.repeat(64);

function adapt(source, pg) {
  return {
    unsafe: async (query, params = []) => (await source.query(query, params)).rows,
    begin: run => pg.transaction(tx => run(adapt(tx, pg))),
  };
}

test('review-only PostgreSQL index gates one durable request claim across attempts',
  { timeout: 150_000 }, async () => {
    assert.doesNotMatch(proposal, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/imu,
      'the caller must own the activation transaction');
    assert.doesNotMatch(proposal, /^\s*(?:DELETE|TRUNCATE|DROP)\s/imu,
      'the proposal must never erase prior dispatch evidence');
    const pg = await PGlite.create();
    try {
      await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
        CREATE ROLE cinatoken_gateway_runtime;
        CREATE ROLE cinatoken_gateway_fact_producer;
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        SET ROLE cinatoken_gateway_migrator;
        CREATE TABLE ${gateway}.schema_migrations (
          version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrations = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort();
      assert.equal(migrations.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      for (const name of migrations) {
        await pg.transaction(async tx => {
          await tx.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
          await tx.query(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      await pg.exec(`INSERT INTO ${gateway}.users(id,email,budget_max,budget_spent)
          VALUES ('single-claim-user','single-claim@example.invalid',10,0);
        INSERT INTO ${gateway}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('single-claim-space','personal','single-claim-user','Single Claim','single-claim','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('single-claim-key','single-claim-secret','single-claim-user','single-claim-space')`);
      const deadline = async (delta = 60_000) => Number((await pg.query(`SELECT
        (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + $1)::text AS n`, [delta])).rows[0].n);
      const prepare = (requestId, attemptIndex, expiry) => pg.query(`INSERT INTO ${intents}
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ($1,$2,'single-claim-user','single-claim-key','single-claim-space','images.generations',$3,$4)`,
      [requestId, attemptIndex, hash, expiry]);
      let claimSequence = 0;
      const claim = (source, requestId, attemptIndex) => source.query(`UPDATE ${intents}
        SET state='dispatch_claimed', revision=revision+1, dispatch_claim_id=$1
        WHERE request_id=$2 AND attempt_index=$3 AND state='prepared' AND revision=0
        RETURNING request_id`,
      [`00000000-0000-4000-8000-${String(++claimSequence).padStart(12, '0')}`, requestId, attemptIndex]);
      const state = async (requestId, attemptIndex) => (await pg.query(`SELECT state,dispatch_claim_id
        FROM ${intents} WHERE request_id=$1 AND attempt_index=$2`, [requestId, attemptIndex])).rows[0];
      const index = async () => (await pg.query(`SELECT i.indisunique,i.indisvalid,
        pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
        FROM pg_catalog.pg_index i WHERE i.indexrelid=$1::pg_catalog.regclass`,
      [`${gateway}.${indexName}`])).rows[0];

      await assert.rejects(pg.transaction(tx => tx.exec(proposal)),
        /Explicit request dispatch single-claim activation assertion is missing/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS relation`,
        [`${gateway}.${indexName}`])).rows[0].relation, null);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(`CREATE OR REPLACE FUNCTION ${gateway}.guard_request_dispatch_intent()
          RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
          SET search_path TO pg_catalog, pg_temp AS $drift$
          BEGIN
            IF TG_OP = 'UPDATE' THEN NEW.dispatch_claim_id := NULL; END IF;
            RETURN NEW;
          END;
          $drift$`);
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /Request dispatch intent guard source contract differs/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS relation`,
        [`${gateway}.${indexName}`])).rows[0].relation, null,
      'a drifted guard must not install the index');
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(`DROP TRIGGER request_dispatch_intents_guard ON ${intents};
          CREATE TRIGGER request_dispatch_intents_guard
            BEFORE INSERT ON ${intents} FOR EACH ROW
            EXECUTE FUNCTION ${gateway}.guard_request_dispatch_intent()`);
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /Request dispatch intent guard binding differs/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS relation`,
        [`${gateway}.${indexName}`])).rows[0].relation, null,
      'a trigger missing UPDATE must not install the index');
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.exec(definerProposal);
        await tx.exec(activation);
        await tx.exec(proposal);
        assert.notEqual((await tx.query(`SELECT pg_catalog.to_regclass($1) AS relation`,
          [`${gateway}.${indexName}`])).rows[0].relation, null,
        'the reviewed definer guard is also an accepted exact source');
        throw new Error('synthetic combined-proposal rollback');
      }), /synthetic combined-proposal rollback/u);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS relation`,
        [`${gateway}.${indexName}`])).rows[0].relation, null);

      // These committed rows model a database with multiple historical claims.
      // The failed proposal leaves both untouched; only this disposable fixture
      // explicitly deletes them before the clean activation case.
      const duplicateExpiry = await deadline();
      await prepare('duplicate-history', 1, duplicateExpiry);
      await prepare('duplicate-history', 2, duplicateExpiry);
      await claim(pg, 'duplicate-history', 1);
      await claim(pg, 'duplicate-history', 2);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /Preexisting multiple dispatch claims for one request/u);
      assert.equal((await pg.query(`SELECT count(*)::int AS n FROM ${intents}
        WHERE request_id='duplicate-history' AND dispatch_claim_id IS NOT NULL`)).rows[0].n, 2);
      assert.equal((await pg.query(`SELECT pg_catalog.to_regclass($1) AS relation`,
        [`${gateway}.${indexName}`])).rows[0].relation, null);
      await pg.query(`DELETE FROM ${intents} WHERE request_id='duplicate-history'`);

      await pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      });
      assert.deepEqual(await index(), {
        indisunique: true, indisvalid: true, predicate: '(dispatch_claim_id IS NOT NULL)',
      });

      const claimedExpiry = await deadline();
      await prepare('first-committed', 1, claimedExpiry);
      await prepare('first-committed', 2, claimedExpiry);
      assert.equal((await claim(pg, 'first-committed', 1)).rows.length, 1);
      const repository = createDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: adapt(pg, pg) });
      const second = { requestId: 'first-committed', attemptIndex: 2,
        userId: 'single-claim-user', apiKeyId: 'single-claim-key', workspaceId: 'single-claim-space',
        operation: 'images.generations', contextSha256: hash };
      await assert.rejects(repository.claim(second, 0, '11111111-1111-4111-8111-111111111111'),
        PostgresDispatchClaimUncertainError);
      assert.equal((await state('first-committed', 1)).state, 'dispatch_claimed');
      assert.deepEqual(await state('first-committed', 2), { state: 'prepared', dispatch_claim_id: null });

      await prepare('classified-unknown', 1, await deadline(20));
      assert.equal((await claim(pg, 'classified-unknown', 1)).rows.length, 1);
      await pg.query('SELECT pg_catalog.pg_sleep(0.05)');
      assert.equal((await pg.query(`UPDATE ${intents}
        SET state='outcome_unknown',revision=revision+1
        WHERE request_id='classified-unknown' AND attempt_index=1
        RETURNING state`)).rows[0].state, 'outcome_unknown');
      await prepare('classified-unknown', 2, await deadline());
      await assert.rejects(claim(pg, 'classified-unknown', 2),
        /duplicate key value violates unique constraint/u);
      assert.deepEqual(await state('classified-unknown', 2), { state: 'prepared', dispatch_claim_id: null });

      const rollbackExpiry = await deadline();
      await prepare('first-rolled-back', 1, rollbackExpiry);
      await prepare('first-rolled-back', 2, rollbackExpiry);
      await assert.rejects(pg.transaction(async tx => {
        assert.equal((await claim(tx, 'first-rolled-back', 1)).rows.length, 1);
        throw new Error('synthetic rollback before claim commit');
      }), /synthetic rollback before claim commit/u);
      assert.deepEqual(await state('first-rolled-back', 1), { state: 'prepared', dispatch_claim_id: null });
      assert.equal((await claim(pg, 'first-rolled-back', 2)).rows.length, 1);

      await prepare('expired-unclaimed', 1, await deadline(20));
      await pg.query('SELECT pg_catalog.pg_sleep(0.05)');
      assert.equal((await pg.query(`UPDATE ${intents}
        SET state='expired_before_dispatch',revision=revision+1
        WHERE request_id='expired-unclaimed' AND attempt_index=1
        RETURNING state`)).rows[0].state, 'expired_before_dispatch');
      // The longer second deadline isolates the index's predicate. A future
      // dispatcher must independently freeze the original request deadline.
      await prepare('expired-unclaimed', 2, await deadline());
      assert.equal((await claim(pg, 'expired-unclaimed', 2)).rows.length, 1);
      assert.equal((await state('expired-unclaimed', 1)).dispatch_claim_id, null);
    } finally {
      await pg.close();
    }
  });
