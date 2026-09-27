// Opt-in proposal test only. PGlite does not prove native multi-session locks,
// real origin identity, Workers behavior or production activation.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.GATEWAY_PGLITE_MODULE;
assert.ok(modulePath && !/^[a-z]+:\/\//iu.test(modulePath), 'Set GATEWAY_PGLITE_MODULE to a local PGlite ESM file');
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const migrations = new URL('../../../migrations-postgres/', import.meta.url);
const proposal = readFileSync(new URL('../../../migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url), 'utf8');
const gateway = 'cinatoken_gateway';
const intent = `${gateway}.request_dispatch_intents`;
const insert = `INSERT INTO ${intent}
  (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
  VALUES ($1,1,$2,$3,$4,'images.generations',$5,$6)`;
const claim = `UPDATE ${intent} SET state='dispatch_claimed',revision=revision+1,
  dispatch_claim_id=$1 WHERE request_id=$2 RETURNING state`;

test('proposal lets an intent-only role lock key scope through a bound definer trigger', async () => {
  const pg = await PGlite.create();
  try {
    await pg.exec(`CREATE ROLE cinatoken_gateway_migrator;
      CREATE ROLE cinatoken_gateway_runtime;
      CREATE ROLE intent_producer;
      CREATE ROLE cinatoken_gateway_fact_producer;
      CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
      SET ROLE cinatoken_gateway_migrator;
      CREATE TABLE ${gateway}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
    assert.equal(files.length, 73);
    for (const name of files) {
      await pg.transaction(async tx => {
        await tx.exec(readFileSync(new URL(name, migrations), 'utf8'));
        await tx.query(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
      });
    }
    await pg.exec(`INSERT INTO ${gateway}.users(id,email,budget_max,budget_spent)
      VALUES ('user','intent-producer@example.invalid',10,0),
        ('other','other-intent-producer@example.invalid',10,0);
      INSERT INTO ${gateway}.users(id,email,budget_max,budget_spent,external_system,external_user_id)
      VALUES ('org-user','org-intent-producer@example.invalid',10,0,'cinaauth','org-subject'),
        ('org-internal','org-internal@example.invalid',10,0,NULL,NULL);
      INSERT INTO ${gateway}.organizations(id,source,name,status,source_updated_at)
      VALUES ('org','cinaauth','Intent Producer Org','active',CURRENT_TIMESTAMP);
      INSERT INTO ${gateway}.organization_memberships
        (organization_id,subject,status,source_updated_at)
      VALUES ('org','org-subject','active',CURRENT_TIMESTAMP);
      INSERT INTO ${gateway}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
      VALUES ('workspace','personal','user','Intent Producer','intent-producer','active'),
        ('other-workspace','personal','other','Other Workspace','other-intent-producer','active');
      INSERT INTO ${gateway}.workspaces
        (id,scope_type,organization_id,name,slug,is_default,default_scope_key,status)
      VALUES ('org-default','organization','org','Org Default','default',true,'organization:org','active'),
        ('org-custom','organization','org','Org Custom','custom',false,NULL,'active');
      INSERT INTO ${gateway}.workspace_memberships
        (id,membership_key,workspace_id,subject,status)
      VALUES ('org-custom-membership','${'b'.repeat(64)}','org-custom','org-subject','active');
      INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
      VALUES ('key','intent-producer-key','user','workspace'),
        ('org-default-key','org-default-key-secret','org-user','org-default'),
        ('org-custom-key','org-custom-key-secret','org-user','org-custom'),
        ('org-internal-key','org-internal-key-secret','org-internal','org-default');
      GRANT USAGE ON SCHEMA ${gateway} TO intent_producer;
      GRANT SELECT, INSERT, UPDATE ON TABLE ${intent} TO intent_producer;
      GRANT EXECUTE ON FUNCTION ${gateway}.guard_request_dispatch_intent()
        TO cinatoken_gateway_runtime`);

    await pg.exec('SET ROLE intent_producer');
    const baselineExpiry = Number((await pg.query(`SELECT
      (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 60000)::text AS n`)).rows[0].n);
    await assert.rejects(pg.query(insert, ['before-proposal', 'user', 'key', 'workspace', 'a'.repeat(64), baselineExpiry]),
      /permission denied/u);
    await pg.exec('SET ROLE cinatoken_gateway_migrator');

    await assert.rejects(pg.transaction(tx => tx.exec(proposal)),
      /Explicit dispatch intent definer activation assertion is missing/u);
    const before = (await pg.query(`SELECT prosecdef FROM pg_catalog.pg_proc
      WHERE oid = '${gateway}.guard_request_dispatch_intent()'::regprocedure`)).rows[0];
    assert.equal(before.prosecdef, false);
    await assert.rejects(pg.transaction(async tx => {
      await tx.exec(`CREATE OR REPLACE FUNCTION ${gateway}.guard_request_dispatch_intent()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
        SET search_path TO pg_catalog, pg_temp AS $drift$
        BEGIN RETURN NEW; END;
        $drift$`);
      await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.exec(proposal);
    }), /Dispatch intent guard source contract differs/u);
    assert.equal((await pg.query(`SELECT prosecdef FROM pg_catalog.pg_proc
      WHERE oid = '${gateway}.guard_request_dispatch_intent()'::regprocedure`)).rows[0].prosecdef,
    false, 'failed drift preflight must roll back the replacement');
    await pg.exec('RESET ROLE');
    await pg.exec('GRANT cinatoken_gateway_migrator TO cinatoken_gateway_runtime');
    await pg.exec('SET ROLE cinatoken_gateway_migrator');
    await assert.rejects(pg.transaction(async tx => {
      await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.exec(proposal);
    }), /role membership contract differs/u);
    await pg.exec('RESET ROLE');
    await pg.exec('REVOKE cinatoken_gateway_migrator FROM cinatoken_gateway_runtime');
    await pg.exec('SET ROLE cinatoken_gateway_migrator');
    await pg.exec(`GRANT SELECT ON TABLE ${gateway}.api_keys
      TO cinatoken_gateway_fact_producer`);
    await assert.rejects(pg.transaction(async tx => {
      await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.exec(proposal);
    }), /producer has effective Key read or write privilege/u);
    await pg.exec(`REVOKE SELECT ON TABLE ${gateway}.api_keys
      FROM cinatoken_gateway_fact_producer`);
    await pg.transaction(async tx => {
      await tx.exec("SET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1'");
      await tx.exec(proposal);
    });
    const catalog = (await pg.query(`SELECT p.prosecdef,p.proconfig,
      pg_catalog.has_function_privilege('cinatoken_gateway_runtime',p.oid,'EXECUTE') AS runtime_execute,
      pg_catalog.has_function_privilege('intent_producer',p.oid,'EXECUTE') AS producer_execute
      FROM pg_catalog.pg_proc p
      WHERE p.oid = '${gateway}.guard_request_dispatch_intent()'::regprocedure`)).rows[0];
    assert.equal(catalog.prosecdef, true);
    assert.deepEqual(catalog.proconfig, ['search_path=pg_catalog, pg_temp']);
    assert.equal(catalog.runtime_execute, false);
    assert.equal(catalog.producer_execute, false);

    await pg.exec('SET ROLE intent_producer');
    const expiry = Number((await pg.query(`SELECT
      (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 60000)::text AS n`)).rows[0].n);
    const hash = 'a'.repeat(64);
    await pg.query(insert, ['valid', 'user', 'key', 'workspace', hash, expiry]);
    const prepared = (await pg.query(`SELECT state,revision::text,created_at_ms::text AS created_at_ms
      FROM ${intent} WHERE request_id='valid'`)).rows[0];
    assert.equal(prepared.state, 'prepared');
    assert.equal(prepared.revision, '0');
    assert.ok(Number(prepared.created_at_ms) > 0);
    const claimId = '11111111-1111-4111-8111-111111111111';
    await pg.query(`UPDATE ${intent} SET state='dispatch_claimed',revision=revision+1,
      dispatch_claim_id=$1 WHERE request_id='valid'`, [claimId]);
    assert.deepEqual((await pg.query(`SELECT state,revision::text AS revision,
      dispatch_claim_id,claimed_at_ms IS NOT NULL AS claimed
      FROM ${intent} WHERE request_id='valid'`)).rows,
      [{ state: 'dispatch_claimed', revision: '1', dispatch_claim_id: claimId, claimed: true }]);
    await assert.rejects(pg.query(insert, ['wrong-user', 'other', 'key', 'workspace', hash, expiry]),
      /Dispatch intent scope mismatch/u);
    await assert.rejects(pg.query(insert, ['wrong-workspace', 'user', 'key', 'other-workspace', hash, expiry]),
      /Dispatch intent scope mismatch/u);
    assert.equal((await pg.query(`SELECT count(*)::integer AS n FROM ${intent}`)).rows[0].n, 1);

    let sequence = 1;
    const nextClaim = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    const preparedCase = async (label, user, key, workspace) => {
      const requestId = `claim-auth-${label}`;
      const deadline = Number((await pg.query(`SELECT
        (pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000)::bigint + 300000)::text AS n`)).rows[0].n);
      await pg.query(insert, [requestId, user, key, workspace, hash, deadline]);
      return requestId;
    };
    const asMigrator = async sql => {
      await pg.exec('SET ROLE cinatoken_gateway_migrator');
      try { await pg.exec(sql); }
      finally { await pg.exec('SET ROLE intent_producer'); }
    };
    const deniedCase = async (label, user, key, workspace, mutation, restore, noGrant = false) => {
      const requestId = await preparedCase(label, user, key, workspace);
      if (mutation) await asMigrator(mutation);
      try {
        if (noGrant) {
          assert.deepEqual((await pg.query(claim, [nextClaim(), requestId])).rows, []);
        } else {
          await assert.rejects(pg.query(claim, [nextClaim(), requestId]),
            /Dispatch intent authorization revoked/u);
        }
        assert.deepEqual((await pg.query(`SELECT state,revision::text AS revision FROM ${intent}
          WHERE request_id=$1`, [requestId])).rows,
          [{ state: 'prepared', revision: '0' }]);
      } finally {
        if (restore) await asMigrator(restore);
      }
    };
    const grantedCase = async (label, user, key, workspace) => {
      const requestId = await preparedCase(label, user, key, workspace);
      assert.deepEqual((await pg.query(claim, [nextClaim(), requestId])).rows,
        [{ state: 'dispatch_claimed' }]);
    };
    await deniedCase('key-revoked', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.api_keys SET status='disabled' WHERE id='key'`,
      `UPDATE ${gateway}.api_keys SET status='active' WHERE id='key'`);
    await deniedCase('key-expired', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.api_keys SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id='key'`,
      `UPDATE ${gateway}.api_keys SET expires_at=NULL WHERE id='key'`, true);
    await deniedCase('key-reassigned', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.api_keys SET user_id='other' WHERE id='key'`,
      `UPDATE ${gateway}.api_keys SET user_id='user' WHERE id='key'`);
    await deniedCase('key-workspace-reassigned', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.api_keys SET workspace_id='other-workspace' WHERE id='key'`,
      `UPDATE ${gateway}.api_keys SET workspace_id='workspace' WHERE id='key'`);
    await deniedCase('user-disabled', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.users SET status='disabled' WHERE id='user'`,
      `UPDATE ${gateway}.users SET status='active' WHERE id='user'`);
    await deniedCase('workspace-archived', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.workspaces SET status='archived' WHERE id='workspace'`,
      `UPDATE ${gateway}.workspaces SET status='active' WHERE id='workspace'`);
    await deniedCase('owner-changed', 'user', 'key', 'workspace',
      `UPDATE ${gateway}.workspaces SET personal_owner_user_id='other' WHERE id='workspace'`,
      `UPDATE ${gateway}.workspaces SET personal_owner_user_id='user' WHERE id='workspace'`);

    await grantedCase('org-default', 'org-user', 'org-default-key', 'org-default');
    await grantedCase('org-custom', 'org-user', 'org-custom-key', 'org-custom');
    await asMigrator(`UPDATE ${gateway}.organizations SET status='pending' WHERE id='org'`);
    try { await grantedCase('org-pending', 'org-user', 'org-default-key', 'org-default'); }
    finally { await asMigrator(`UPDATE ${gateway}.organizations SET status='active' WHERE id='org'`); }
    await deniedCase('org-internal-user', 'org-internal', 'org-internal-key', 'org-default');
    await deniedCase('org-suspended', 'org-user', 'org-default-key', 'org-default',
      `UPDATE ${gateway}.organizations SET status='suspended' WHERE id='org'`,
      `UPDATE ${gateway}.organizations SET status='active' WHERE id='org'`);
    await deniedCase('org-member-removed', 'org-user', 'org-default-key', 'org-default',
      `UPDATE ${gateway}.organization_memberships SET status='removed'
        WHERE organization_id='org' AND subject='org-subject'`,
      `UPDATE ${gateway}.organization_memberships SET status='active'
        WHERE organization_id='org' AND subject='org-subject'`);
    await deniedCase('org-subject-changed', 'org-user', 'org-default-key', 'org-default',
      `UPDATE ${gateway}.users SET external_user_id='stale-subject' WHERE id='org-user'`,
      `UPDATE ${gateway}.users SET external_user_id='org-subject' WHERE id='org-user'`);
    await deniedCase('org-source-changed', 'org-user', 'org-default-key', 'org-default',
      `UPDATE ${gateway}.users SET external_system='other-source' WHERE id='org-user'`,
      `UPDATE ${gateway}.users SET external_system='cinaauth' WHERE id='org-user'`);
    await deniedCase('org-default-flag-null', 'org-user', 'org-default-key', 'org-default',
      `ALTER TABLE ${gateway}.workspaces ALTER COLUMN is_default DROP NOT NULL;
        INSERT INTO ${gateway}.workspace_memberships
          (id,membership_key,workspace_id,subject,status)
          VALUES ('org-default-membership','${'c'.repeat(64)}','org-default','org-subject','active');
        UPDATE ${gateway}.workspaces SET is_default=NULL WHERE id='org-default'`,
      `UPDATE ${gateway}.workspaces SET is_default=true WHERE id='org-default';
        DELETE FROM ${gateway}.workspace_memberships WHERE id='org-default-membership';
        ALTER TABLE ${gateway}.workspaces ALTER COLUMN is_default SET NOT NULL`);
    await deniedCase('workspace-member-removed', 'org-user', 'org-custom-key', 'org-custom',
      `UPDATE ${gateway}.workspace_memberships SET status='removed'
        WHERE id='org-custom-membership'`,
      `UPDATE ${gateway}.workspace_memberships SET status='active'
        WHERE id='org-custom-membership'`);
    for (const table of ['api_keys', 'users', 'workspaces', 'organizations',
      'organization_memberships', 'workspace_memberships']) {
      await assert.rejects(pg.query(`SELECT * FROM ${gateway}.${table} LIMIT 1`), /permission denied/u);
    }
    await assert.rejects(pg.query(`UPDATE ${gateway}.api_keys SET status='disabled' WHERE id='key'`), /permission denied/u);

    await pg.exec('CREATE TEMP TABLE trigger_probe(request_id text)');
    await assert.rejects(pg.exec(`CREATE TRIGGER probe BEFORE INSERT ON trigger_probe FOR EACH ROW
      EXECUTE FUNCTION ${gateway}.guard_request_dispatch_intent()`), /permission denied/u);
    await pg.exec('RESET ROLE');
    await pg.exec(`GRANT EXECUTE ON FUNCTION ${gateway}.guard_request_dispatch_intent()
      TO intent_producer`);
    await pg.exec('SET ROLE intent_producer');
    await pg.exec(`CREATE TRIGGER probe BEFORE INSERT ON trigger_probe FOR EACH ROW
      EXECUTE FUNCTION ${gateway}.guard_request_dispatch_intent()`);
    await assert.rejects(pg.exec("INSERT INTO trigger_probe(request_id) VALUES ('forged')"),
      /Dispatch intent guard relation or event mismatch/u);
    assert.equal((await pg.query('SELECT count(*)::integer AS n FROM trigger_probe')).rows[0].n, 0);
  } finally {
    await pg.close();
  }
});
