// Opt-in proposal test only. PGlite does not establish native lock timing,
// Workers/Hyperdrive behavior, production identity or activation safety.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { encodeUsageSettlement } from './usage-settlement-codec.ts';
import { sample } from './usage-settlement-test-support.mjs';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath),
  'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const migrationDir = new URL('../../../migrations-postgres/', import.meta.url);
const proposal = readFileSync(new URL('../../../migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url), 'utf8');
const gateway = 'cinatoken_gateway';
const fact = `${gateway}.request_usage_settlements`;
const outbox = `${gateway}.request_usage_settlement_outbox`;
const enqueue = `${gateway}.enqueue_usage_settlement_fact()`;
const producer = 'cinatoken_gateway_fact_producer';

async function claimedValue(pg) {
  const value = sample(0);
  const expiry = Number((await pg.query(`SELECT
    (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 60000)::text AS n`)).rows[0].n);
  await pg.query(`INSERT INTO ${gateway}.request_dispatch_intents
    (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
    VALUES ($1,1,$2,$3,$4,$5,$6,$7)`, [value.intent.requestId,
    value.intent.userId, value.intent.apiKeyId, value.intent.workspaceId,
    value.intent.operation, value.intent.contextSha256, expiry]);
  await pg.query(`UPDATE ${gateway}.request_dispatch_intents
    SET state='dispatch_claimed',revision=revision+1,dispatch_claim_id=$2
    WHERE request_id=$1`, [value.intent.requestId, value.dispatchClaimId]);
  const encoded = await encodeUsageSettlement(value);
  const params = [value.intent.requestId, value.intent.attemptIndex,
    value.intent.userId, value.intent.apiKeyId, value.intent.workspaceId,
    value.intent.operation, value.intent.contextSha256, value.dispatchClaimId,
    encoded.sha256, value.version, encoded.json, value.recordedAtIso];
  return { value, params, digest: encoded.sha256 };
}

const insertFact = `INSERT INTO ${fact}
  (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,
   context_sha256,dispatch_claim_id,payload_sha256,payload_version,payload_json,recorded_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;

test('manual outbox definer lets fact-only producer enqueue atomically without outbox INSERT',
  { timeout: 150_000 }, async () => {
    assert.doesNotMatch(proposal, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/imu,
      'caller must own one explicit activation transaction');
    const pg = await PGlite.create();
    try {
      await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
        CREATE ROLE cinatoken_gateway_runtime;
        CREATE ROLE ${producer};
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        SET ROLE cinatoken_gateway_migrator;
        CREATE TABLE ${gateway}.schema_migrations (
          version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 81);
      assert.equal(files.at(-1), '0081_tools_config_group_audit.sql');
      for (const name of files) {
        await pg.transaction(async tx => {
          await tx.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
          await tx.query(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      await pg.exec(`INSERT INTO ${gateway}.users(id,email,budget_max,budget_spent)
          VALUES ('recovery-user','outbox-producer@example.invalid',10,0);
        INSERT INTO ${gateway}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('recovery-workspace','personal','recovery-user','Recovery','outbox-producer','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('recovery-key','outbox-producer-key','recovery-user','recovery-workspace');
        GRANT USAGE ON SCHEMA ${gateway} TO ${producer};
        GRANT SELECT, INSERT ON TABLE ${fact} TO ${producer};
        GRANT SELECT ON TABLE ${outbox} TO ${producer};
        GRANT EXECUTE ON FUNCTION ${enqueue}
          TO cinatoken_gateway_runtime, ${producer}`);

      const before = await claimedValue(pg);
      await pg.exec(`SET ROLE ${producer}`);
      await assert.rejects(pg.query(insertFact, before.params), /permission denied/u,
        '0070 invoker enqueue requires outbox INSERT, which producer does not have');
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      assert.deepEqual((await pg.query(`SELECT
        (SELECT count(*)::int FROM ${fact}) AS facts,
        (SELECT count(*)::int FROM ${outbox}) AS outbox`)).rows[0],
      { facts: 0, outbox: 0 }, 'failed fact insert must roll back both rows');

      await assert.rejects(pg.transaction(tx => tx.exec(proposal)),
        /Explicit settlement outbox definer activation assertion is missing/u);
      assert.equal((await pg.query(`SELECT prosecdef FROM pg_catalog.pg_proc
        WHERE oid='${enqueue}'::regprocedure`)).rows[0].prosecdef, false);

      const activation = "SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'";
      const assertDriftRejected = async (change, expected) => {
        await assert.rejects(pg.transaction(async tx => {
          await tx.exec(change);
          await tx.exec(activation);
          await tx.exec(proposal);
        }), expected);
      };

      await assertDriftRejected(`CREATE OR REPLACE FUNCTION ${enqueue}
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
        SET search_path TO pg_catalog, pg_temp AS $$
        BEGIN RETURN NEW; END; $$`, /enqueue source contract differs/u);
      for (const functionName of ['guard_usage_settlement_fact()',
        'reject_usage_settlement_mutation()']) {
        await assertDriftRejected(`CREATE OR REPLACE FUNCTION ${gateway}.${functionName}
          RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
          SET search_path TO pg_catalog, pg_temp AS $$
          BEGIN RETURN NEW; END; $$`,
        /guard or immutable function source contract differs/u);
      }

      await assertDriftRejected(`DROP TRIGGER request_usage_settlements_guard ON ${fact};
        CREATE TRIGGER request_usage_settlements_guard BEFORE INSERT ON ${fact}
          FOR EACH ROW WHEN (false)
          EXECUTE FUNCTION ${gateway}.guard_usage_settlement_fact()`,
      /guard\/immutable trigger differs: request_usage_settlements_guard/u);
      await assertDriftRejected(`DROP TRIGGER request_usage_settlement_outbox_immutable ON ${outbox};
        CREATE TRIGGER request_usage_settlement_outbox_immutable
          BEFORE UPDATE OR DELETE ON ${outbox} FOR EACH ROW WHEN (false)
          EXECUTE FUNCTION ${gateway}.reject_usage_settlement_mutation()`,
      /guard\/immutable trigger differs: request_usage_settlement_outbox_immutable/u);

      await assertDriftRejected(`ALTER TABLE ${fact}
          DROP CONSTRAINT request_usage_settlements_require_outbox;
        ALTER TABLE ${fact} ADD CONSTRAINT request_usage_settlements_require_outbox
          FOREIGN KEY (request_id) REFERENCES ${outbox}(request_id)
          DEFERRABLE INITIALLY DEFERRED`,
      /reciprocal FK contract differs/u);
      await assertDriftRejected(`ALTER TABLE ${outbox}
          DROP CONSTRAINT request_usage_settlement_outbox_fact;
        ALTER TABLE ${outbox} ADD CONSTRAINT request_usage_settlement_outbox_fact
          FOREIGN KEY (request_id, payload_sha256, created_at_ms)
          REFERENCES ${fact}(request_id, payload_sha256, created_at_ms)
          ON DELETE CASCADE`, /reciprocal FK contract differs/u);

      await pg.exec(`GRANT INSERT ON TABLE ${outbox} TO ${producer}`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /runtime or producer has effective outbox write privilege/u);
      await pg.exec(`REVOKE INSERT ON TABLE ${outbox} FROM ${producer}`);

      await pg.exec(`GRANT INSERT ON TABLE ${outbox} TO cinatoken_gateway_runtime`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /runtime or producer has effective outbox write privilege/u);
      await pg.exec(`REVOKE INSERT ON TABLE ${outbox} FROM cinatoken_gateway_runtime`);

      await pg.exec('RESET ROLE');
      await pg.exec(`GRANT cinatoken_gateway_migrator TO ${producer}`);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /role membership contract differs/u);
      await pg.exec('RESET ROLE');
      await pg.exec(`REVOKE cinatoken_gateway_migrator FROM ${producer}`);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');

      await pg.exec('RESET ROLE');
      await pg.exec('GRANT cinatoken_gateway_migrator TO cinatoken_gateway_runtime');
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /role membership contract differs/u);
      await pg.exec('RESET ROLE');
      await pg.exec('REVOKE cinatoken_gateway_migrator FROM cinatoken_gateway_runtime');
      await pg.exec('SET ROLE cinatoken_gateway_migrator');

      await pg.exec('RESET ROLE');
      await pg.exec('CREATE ROLE outbox_writer');
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      await pg.exec(`GRANT INSERT ON TABLE ${outbox} TO outbox_writer`);
      await pg.exec('RESET ROLE');
      await pg.exec(`GRANT outbox_writer TO ${producer}`);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec(activation);
        await tx.exec(proposal);
      }), /runtime or producer has effective outbox write privilege/u);
      await pg.exec('RESET ROLE');
      await pg.exec(`REVOKE outbox_writer FROM ${producer}`);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      await pg.exec(`REVOKE INSERT ON TABLE ${outbox} FROM outbox_writer`);

      await pg.exec(`ALTER TABLE ${fact} DISABLE TRIGGER request_usage_settlements_enqueue`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec("SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'");
        await tx.exec(proposal);
      }), /enqueue trigger binding differs/u);
      await pg.exec(`ALTER TABLE ${fact} ENABLE TRIGGER request_usage_settlements_enqueue`);
      assert.equal((await pg.query(`SELECT prosecdef FROM pg_catalog.pg_proc
        WHERE oid='${enqueue}'::regprocedure`)).rows[0].prosecdef, false);
      await pg.exec(`ALTER TABLE ${outbox} DISABLE TRIGGER request_usage_settlement_outbox_immutable`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.exec("SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'");
        await tx.exec(proposal);
      }), /guard\/immutable trigger differs: request_usage_settlement_outbox_immutable/u);
      await pg.exec(`ALTER TABLE ${outbox} ENABLE TRIGGER request_usage_settlement_outbox_immutable`);

      await pg.transaction(async tx => {
        await tx.exec("SET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1'");
        await tx.exec(proposal);
      });
      const catalog = (await pg.query(`SELECT p.prosecdef,p.proconfig,owner.rolname AS owner,
        pg_catalog.has_function_privilege('cinatoken_gateway_runtime',p.oid,'EXECUTE') AS runtime_execute,
        pg_catalog.has_function_privilege('${producer}',p.oid,'EXECUTE') AS producer_execute,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
        WHERE p.oid='${enqueue}'::regprocedure`)).rows[0];
      assert.equal(catalog.prosecdef, true);
      assert.deepEqual(catalog.proconfig, ['search_path=pg_catalog, pg_temp']);
      assert.equal(catalog.owner, 'cinatoken_gateway_migrator');
      assert.equal(catalog.runtime_execute, false);
      assert.equal(catalog.producer_execute, false);
      assert.equal(catalog.public_execute, false);

      const after = await claimedValue(pg);
      await pg.exec(`SET ROLE ${producer}`);
      await assert.rejects(pg.query(`INSERT INTO ${outbox}(request_id,payload_sha256,created_at_ms)
        VALUES ('forged',$1,1)`, [after.digest]), /permission denied/u);
      await pg.query(insertFact, after.params);
      const joined = (await pg.query(`SELECT s.request_id,s.payload_sha256,
        s.created_at_ms::text AS fact_time,o.created_at_ms::text AS outbox_time
        FROM ${fact} s JOIN ${outbox} o ON o.request_id=s.request_id
        WHERE s.request_id=$1`, [after.value.intent.requestId])).rows;
      assert.deepEqual(joined, [{ request_id: after.value.intent.requestId,
        payload_sha256: after.digest, fact_time: joined[0].fact_time,
        outbox_time: joined[0].fact_time }]);
      await assert.rejects(pg.query(`UPDATE ${fact} SET payload_json='{}'
        WHERE request_id=$1`, [after.value.intent.requestId]), /permission denied/u);
      await assert.rejects(pg.query(`DELETE FROM ${outbox}
        WHERE request_id=$1`, [after.value.intent.requestId]), /permission denied/u);

      await pg.exec(`CREATE TEMP TABLE shadow_fact
        (request_id text,payload_sha256 text,created_at_ms bigint)`);
      await assert.rejects(pg.exec(`CREATE TRIGGER request_usage_settlements_enqueue
        AFTER INSERT ON shadow_fact FOR EACH ROW EXECUTE FUNCTION ${enqueue}`),
      /permission denied/u);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      await pg.exec(`GRANT EXECUTE ON FUNCTION ${enqueue} TO ${producer}`);
      await pg.exec(`SET ROLE ${producer}`);
      await pg.exec(`CREATE TRIGGER request_usage_settlements_enqueue
        AFTER INSERT ON shadow_fact FOR EACH ROW EXECUTE FUNCTION ${enqueue}`);
      await assert.rejects(pg.query(`INSERT INTO shadow_fact
        (request_id,payload_sha256,created_at_ms) VALUES ($1,$2,1)`,
      [after.value.intent.requestId, after.digest]),
      /Settlement outbox enqueue relation or event mismatch/u);
      assert.equal((await pg.query('SELECT count(*)::int AS n FROM shadow_fact')).rows[0].n, 0);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      assert.equal((await pg.query(`SELECT count(*)::int AS n FROM ${outbox}`)).rows[0].n, 1);

      // The proposal replaced no table constraint or immutable trigger.
      await assert.rejects(pg.query(`UPDATE ${fact} SET payload_json='{}'
        WHERE request_id=$1`, [after.value.intent.requestId]),
      /Settlement fact and discovery entry are immutable/u);
      await assert.rejects(pg.query(`DELETE FROM ${outbox}
        WHERE request_id=$1`, [after.value.intent.requestId]),
      /Settlement fact and discovery entry are immutable/u);

      const rolledBack = await claimedValue(pg);
      await pg.exec(`SET ROLE ${producer}`);
      await assert.rejects(pg.transaction(async tx => {
        await tx.query(insertFact, rolledBack.params);
        throw new Error('synthetic transaction rollback');
      }), /synthetic transaction rollback/u);
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      assert.deepEqual((await pg.query(`SELECT
        (SELECT count(*)::int FROM ${fact} WHERE request_id=$1) AS facts,
        (SELECT count(*)::int FROM ${outbox} WHERE request_id=$1) AS outbox`,
      [rolledBack.value.intent.requestId])).rows[0], { facts: 0, outbox: 0 });
    } finally {
      await pg.close();
    }
  });
