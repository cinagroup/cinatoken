// Adapter coverage for review-only SQL. PGlite does not prove native concurrent
// sessions, real transport ACK loss, trusted request digest or runtime grants.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createParentDispatchIntentRepositoryPostgres } from './dispatch-intent-postgres-parent.ts';
import { PostgresDispatchClaimUncertainError } from './dispatch-intent-postgres.ts';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath),
  'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const migrations = new URL('../../../migrations-postgres/', import.meta.url);
const proposal = name => readFileSync(new URL(`../../../migrations-proposals/postgres/${name}`, import.meta.url), 'utf8');
const g = 'cinatoken_gateway';
const parentTable = `${g}.request_dispatch_requests`;
const childTable = `${g}.request_dispatch_intents`;
const requestHash = 'a'.repeat(64);
const routeHash = 'b'.repeat(64);

function adapt(pg, hooks = {}) {
  return {
    unsafe: async (query, params = []) => {
      hooks.query?.(query, params);
      return (await pg.query(query, params)).rows;
    },
    begin: async run => {
      hooks.begin?.();
      const result = await pg.transaction(tx => run({
        unsafe: async (query, params = []) => {
          hooks.query?.(query, params);
          return (await tx.query(query, params)).rows;
        },
      }));
      await hooks.afterCommit?.();
      return result;
    },
  };
}

test('parent-aware repository calls owner-only functions and gates grant on COMMIT ACK',
  { timeout: 180_000 }, async () => {
    const indexSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(indexSource, /dispatch-intent-postgres-parent/u);
    const adapterSource = readFileSync(new URL('./dispatch-intent-postgres-parent.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(adapterSource, /(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO|FROM|TABLE)?\s*cinatoken_gateway\.request_dispatch_intents/iu);
    const pg = await PGlite.create();
    try {
      await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
        CREATE ROLE cinatoken_gateway_runtime;
        CREATE ROLE cinatoken_gateway_fact_producer;
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        SET ROLE cinatoken_gateway_migrator;
        CREATE TABLE ${g}.schema_migrations (
          version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 81);
      assert.equal(files.at(-1), '0081_tools_config_group_audit.sql');
      for (const name of files) {
        await pg.transaction(async tx => {
          await tx.exec(readFileSync(new URL(name, migrations), 'utf8'));
          await tx.query(`INSERT INTO ${g}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      await pg.exec(`INSERT INTO ${g}.users(id,email,budget_max,budget_spent)
          VALUES ('adapter-user','adapter@example.invalid',10,0);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('adapter-space','personal','adapter-user','Adapter','adapter','active');
        INSERT INTO ${g}.api_keys(id,key,user_id,workspace_id)
          VALUES ('adapter-key','adapter-secret','adapter-user','adapter-space')`);
      await pg.transaction(async tx => {
        await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
        await tx.exec(proposal('dispatch-intent-producer-definer.sql'));
        await tx.exec("SET LOCAL cinatoken.request_dispatch_single_claim_activation = 'reviewed-v1'");
        await tx.exec(proposal('request-dispatch-single-claim.sql'));
        await tx.exec("SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1'");
        await tx.exec(proposal('request-dispatch-parent-deadline-budget.sql'));
      });

      const now = async offset => Number((await pg.query(`SELECT
        (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + $1)::text AS ms`,
      [offset])).rows[0].ms);
      const ref = (requestId, attemptIndex = 1, contextSha256 = routeHash) => ({
        requestId, attemptIndex, userId: 'adapter-user', apiKeyId: 'adapter-key',
        workspaceId: 'adapter-space', operation: 'images.generations', requestSha256: requestHash,
        contextSha256,
      });
      const parent = async id => (await pg.query(`SELECT original_created_at_ms::text AS created,
        expires_at_ms::text AS expiry, max_attempts, prepared_count, claim_count, first_claim_id
        FROM ${parentTable} WHERE request_id=$1`, [id])).rows[0];
      const child = async (id, attemptIndex) => (await pg.query(`SELECT state, revision::text AS revision,
        context_sha256, dispatch_claim_id FROM ${childTable}
        WHERE request_id=$1 AND attempt_index=$2`, [id, attemptIndex])).rows[0];
      const repo = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: adapt(pg) });

      // Preparation reports only durable metadata. A second route can have a
      // different context digest and a shorter child deadline under one parent.
      const expiry = await now(60_000);
      assert.equal(await repo.prepare(ref('frozen'), expiry, 2), 'newly_prepared');
      const frozen = await parent('frozen');
      assert.equal(frozen.prepared_count, 1);
      assert.equal(frozen.claim_count, 0);
      assert.equal(await repo.prepare(ref('frozen'), expiry, 2), 'already_prepared');
      assert.deepEqual(await parent('frozen'), frozen);
      for (const [wrong, end, budget] of [
        [{ ...ref('frozen', 2), requestSha256: 'c'.repeat(64) }, expiry, 2],
        [ref('frozen', 2), expiry + 1, 2],
        [ref('frozen', 2), expiry, 3],
        [ref('frozen', 1, 'c'.repeat(64)), expiry, 2],
      ]) await assert.rejects(repo.prepare(wrong, end, budget));
      assert.equal(await repo.prepare(ref('frozen', 2, 'c'.repeat(64)), expiry - 1_000, 2),
        'newly_prepared');
      assert.equal((await parent('frozen')).prepared_count, 2);
      assert.equal((await child('frozen', 2)).context_sha256, 'c'.repeat(64));
      const firstClaim = randomUUID();
      assert.equal(await repo.claim(ref('frozen', 2, 'c'.repeat(64)), 0, firstClaim), 'granted');
      assert.equal(await repo.claim(ref('frozen'), 0, randomUUID()), 'not_granted');
      assert.equal((await parent('frozen')).claim_count, 1);
      assert.equal((await parent('frozen')).first_claim_id, firstClaim);

      const mutablePrepareRef = ref('owned-prepare');
      const ownedPrepare = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw:
        adapt(pg, { begin() { mutablePrepareRef.requestSha256 = 'd'.repeat(64); } }) });
      assert.equal(await ownedPrepare.prepare(mutablePrepareRef, await now(60_000), 1),
        'newly_prepared');
      assert.equal((await pg.query(`SELECT request_sha256 FROM ${parentTable}
        WHERE request_id='owned-prepare'`)).rows[0].request_sha256, requestHash);
      const mutableClaimRef = ref('owned-prepare');
      const ownedClaim = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw:
        adapt(pg, { begin() { mutableClaimRef.attemptIndex = 2; } }) });
      assert.equal(await ownedClaim.claim(mutableClaimRef, 0, randomUUID()), 'granted');
      assert.equal((await child('owned-prepare', 1)).state, 'dispatch_claimed');

      const prepareAckRef = ref('prepare-ack-lost');
      const prepareAckExpiry = await now(60_000);
      const prepareStatements = [];
      const prepareAckLost = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw:
        adapt(pg, { query(sql) { prepareStatements.push(sql); },
          afterCommit() { throw new Error('synthetic preparation ACK loss'); } }) });
      await assert.rejects(prepareAckLost.prepare(prepareAckRef, prepareAckExpiry, 1),
        /synthetic preparation ACK loss/u);
      assert.equal(prepareStatements.length, 1, 'preparation error cannot read back or grant');
      assert.equal((await parent('prepare-ack-lost')).prepared_count, 1);
      assert.equal((await parent('prepare-ack-lost')).claim_count, 0);
      assert.equal(await repo.prepare(prepareAckRef, prepareAckExpiry, 1), 'already_prepared');

      const unknownExpiry = await now(350);
      assert.equal(await repo.prepare(ref('unknown'), unknownExpiry, 2), 'newly_prepared');
      assert.equal(await repo.prepare(ref('unknown', 2, 'c'.repeat(64)), unknownExpiry, 2),
        'newly_prepared');
      assert.equal(await repo.claim(ref('unknown'), 0, randomUUID()), 'granted');
      await pg.query('SELECT pg_catalog.pg_sleep(0.4)');
      assert.equal(await repo.classifyOverdue(ref('unknown'), 1), true);
      assert.equal((await child('unknown', 1)).state, 'outcome_unknown');
      assert.equal(await repo.claim(ref('unknown', 2, 'c'.repeat(64)), 0, randomUUID()), 'not_granted');
      assert.equal((await parent('unknown')).claim_count, 1);

      const expired = await now(250);
      assert.equal(await repo.prepare(ref('expired'), expired, 1), 'newly_prepared');
      await pg.query('SELECT pg_catalog.pg_sleep(0.3)');
      assert.equal(await repo.claim(ref('expired'), 0, randomUUID()), 'not_granted');
      assert.equal(await repo.classifyOverdue(ref('expired'), 0), true);
      assert.equal((await child('expired', 1)).state, 'expired_before_dispatch');
      assert.equal((await parent('expired')).claim_count, 0);

      const ackExpiry = await now(60_000), ackRef = ref('ack-lost');
      assert.equal(await repo.prepare(ackRef, ackExpiry, 1), 'newly_prepared');
      const issued = [];
      const lostAck = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw:
        adapt(pg, { query(sql) { issued.push(sql); }, afterCommit() { throw new Error('synthetic lost ACK'); } }) });
      const ackClaim = randomUUID();
      await assert.rejects(lostAck.claim(ackRef, 0, ackClaim), PostgresDispatchClaimUncertainError);
      assert.equal(issued.length, 1, 'no readback or retry after ambiguous COMMIT');
      assert.match(issued[0], /claim_request_dispatch_intent_v1/u);
      assert.equal((await child('ack-lost', 1)).dispatch_claim_id, ackClaim,
        'the claim can be durable even though caller receives only uncertainty');
      assert.equal(await repo.claim(ackRef, 1, ackClaim), 'not_granted');

      const delayedRef = ref('delayed-ack');
      assert.equal(await repo.prepare(delayedRef, await now(60_000), 1), 'newly_prepared');
      let release, reached, settled = false;
      const gate = new Promise(resolveGate => { release = resolveGate; });
      const entered = new Promise(resolveEntered => { reached = resolveEntered; });
      const delayed = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw:
        adapt(pg, { async afterCommit() { reached(); await gate; } }) });
      const pending = delayed.claim(delayedRef, 0, randomUUID()).then(value => {
        settled = true; return value;
      });
      await entered;
      try {
        assert.equal(settled, false, 'a committed row before ACK must not become a visible grant');
        assert.equal((await child('delayed-ack', 1)).state, 'dispatch_claimed');
      } finally { release(); }
      assert.equal(await pending, 'granted');

      const forbidden = createParentDispatchIntentRepositoryPostgres({ driver: 'postgres', raw: {
        unsafe() { assert.fail('invalid input reached SQL'); },
        begin() { assert.fail('invalid input reached transaction'); },
      } });
      for (const bad of [
        { ...ref('bad'), requestId: 'bad\n' }, { ...ref('bad'), attemptIndex: 0 },
        { ...ref('bad'), attemptIndex: 4 }, { ...ref('bad'), apiKeyId: null },
        { ...ref('bad'), requestSha256: requestHash + '\n' },
        { ...ref('bad'), contextSha256: 'Z'.repeat(64) },
      ]) {
        await assert.rejects(forbidden.prepare(bad, 1, 3), TypeError);
        await assert.rejects(forbidden.claim(bad, 0, randomUUID()), TypeError);
        await assert.rejects(forbidden.classifyOverdue(bad, 0), TypeError);
      }
      for (const deadline of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(forbidden.prepare(ref('bad'), deadline, 1), TypeError);
      }
      for (const budget of [0, 4, 1.5]) {
        await assert.rejects(forbidden.prepare(ref('bad'), 1, budget), TypeError);
      }
      await assert.rejects(forbidden.prepare(ref('bad', 2), 1, 1), TypeError);
      for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(forbidden.claim(ref('bad'), revision, randomUUID()), TypeError);
        await assert.rejects(forbidden.classifyOverdue(ref('bad'), revision), TypeError);
      }
      await assert.rejects(forbidden.claim(ref('bad'), 0, randomUUID() + '\n'), TypeError);
      assert.throws(() => createParentDispatchIntentRepositoryPostgres({ driver: 'd1' }), TypeError);
    } finally { await pg.close(); }
  });
