import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIRED_TRIGGERS } from '../../../../../scripts/db/cutover/postgres-recovery-role-policy.ts';
import { createFinancialEngine, gateway } from '../../test-support/postgres-financial-engine.mjs';

test('formal recovery API-key helper locks the real key row and returns only a match bit', async (t) => {
  const fixture = await createFinancialEngine();
  t.after(() => fixture.pg.close());
  await fixture.reset('public,pg_temp,pg_catalog');

  const matches = async (keyId, workspaceId) => {
    const result = await fixture.pg.query(
      `SELECT ${gateway}.recovery_api_key_workspace_matches($1,$2) AS matches`,
      [keyId, workspaceId],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0].matches;
  };

  assert.equal(await matches('key', 'workspace'), true);
  assert.equal(await matches('key', 'other-workspace'), false);
  assert.equal(await matches('missing-key', 'workspace'), false);
  assert.equal(await matches(null, 'workspace'), false);
  assert.equal(await matches('key', null), false);

  // The fixture already contains same-id public and temp keys in a different
  // workspace; either one would mislead a caller-path-dependent helper.
  await fixture.pg.exec('SET search_path TO pg_temp, public, pg_catalog');
  assert.equal(await matches('key', 'workspace'), true);
  assert.equal(await matches('key', 'other-workspace'), false);

  await fixture.pg.exec(`UPDATE ${gateway}.api_keys SET workspace_id='other-workspace' WHERE id='key'`);
  assert.equal(await matches('key', 'workspace'), false);
  assert.equal(await matches('key', 'other-workspace'), true);

  const catalog = await fixture.pg.query(`SELECT p.prosecdef, p.provolatile, p.proretset,
      p.proconfig, pg_get_userbyid(p.proowner) AS owner
    FROM pg_catalog.pg_proc p
    WHERE p.oid = '${gateway}.recovery_api_key_workspace_matches(text,text)'::regprocedure`);
  assert.equal(catalog.rows.length, 1);
  assert.equal(catalog.rows[0].prosecdef, true);
  assert.equal(catalog.rows[0].provolatile, 'v');
  assert.equal(catalog.rows[0].proretset, false);
  assert.deepEqual(catalog.rows[0].proconfig, ['search_path=pg_catalog, pg_temp']);

  const publicAccess = await fixture.pg.query(`SELECT acl.grantee
    FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
    WHERE p.oid = '${gateway}.recovery_api_key_workspace_matches(text,text)'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`);
  assert.deepEqual(publicAccess.rows, []);

  for (const [table, name, functionName, triggerType, deferrable, initiallyDeferred] of REQUIRED_TRIGGERS) {
    const actual = await fixture.pg.query(`SELECT t.tgtype::integer AS trigger_type,
        t.tgdeferrable AS is_deferrable, t.tginitdeferred AS initially_deferred,
        t.tgfoid = pg_catalog.to_regprocedure($3) AS function_matches,
        t.tgqual IS NULL AS no_when, pg_catalog.cardinality(t.tgattr) AS column_count,
        t.tgnargs AS argument_count, t.tgoldtable IS NULL AS no_old_table,
        t.tgnewtable IS NULL AS no_new_table
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND t.tgname=$4
        AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')`,
    [gateway, table, `${gateway}.${functionName}`, name]);
    if (name === 'request_usage_log_recovery_guard') {
      assert.equal(actual.rows.length, 0, 'legacy log recovery guard remains a deployment blocker');
      continue;
    }
    assert.equal(actual.rows.length, 1, name);
    assert.equal(Number(actual.rows[0].trigger_type), triggerType, name);
    assert.equal(actual.rows[0].is_deferrable, deferrable, name);
    assert.equal(actual.rows[0].initially_deferred, initiallyDeferred, name);
    assert.equal(actual.rows[0].function_matches, true, name);
    assert.equal(actual.rows[0].no_when, true, name);
    assert.equal(Number(actual.rows[0].column_count), 0, name);
    assert.equal(Number(actual.rows[0].argument_count), 0, name);
    assert.equal(actual.rows[0].no_old_table, true, name);
    assert.equal(actual.rows[0].no_new_table, true, name);
  }
});
