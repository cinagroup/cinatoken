import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {
  SOURCE_PINS_V400, BASELINE_RAW_SHA256_V400, BASELINE_CANONICAL_SHA256_V400,
  normalizeBaselineV400, assertSelectedBaselineV400, projectFinalCatalogV400,
  assertFinalCatalogV400, renderInstallerV400, extractFrozenActionsV400,
  loadSourcesV400, captureCatalogV400, catalogDigestV400,
} from './build-complete-text-auth-routing-recovery-coinstall-v400.mjs';

const root = new URL('../../../', import.meta.url);
const rawText = await readFile(new URL('scripts/db/cutover/fixtures/complete-text-auth-routing-recovery-coinstall-baseline-v400.json', root), 'utf8');
const sources = await loadSourcesV400();
const baseline = normalizeBaselineV400(JSON.parse(rawText));
const final = projectFinalCatalogV400(baseline, sources);
const sha = text => createHash('sha256').update(text).digest('hex');
const key = 'cinatoken_gateway.';

test('trusted native baseline and frozen source pins are exact', () => {
  assert.equal(sha(rawText), BASELINE_RAW_SHA256_V400);
  assert.equal(catalogDigestV400(baseline), BASELINE_CANONICAL_SHA256_V400);
  for (const [name, digest] of Object.entries(SOURCE_PINS_V400)) assert.equal(sha(sources[name]), digest);
  assert.doesNotThrow(() => assertSelectedBaselineV400(baseline));
});

test('committed successor is deterministically generated from complete strict gates', async () => {
  const sql = await readFile(new URL('packages/core/migrations-proposals/postgres/complete-text-auth-routing-recovery-coinstall-v400.sql', root), 'utf8');
  assert.equal(sql, renderInstallerV400(baseline, sources));
  const actions = extractFrozenActionsV400(sources);
  assert.equal(sql.slice(sql.indexOf('-- BEGIN unchanged frozen v396 action DDL\n') + '-- BEGIN unchanged frozen v396 action DDL\n'.length, sql.indexOf('-- END unchanged frozen v396 action DDL')), actions.routing);
  assert.equal(sql.slice(sql.indexOf('-- BEGIN unchanged frozen v398 action DDL\n') + '-- BEGIN unchanged frozen v398 action DDL\n'.length, sql.indexOf('\n-- END unchanged frozen v398 action DDL')), actions.sticky);
});

test('final contract adds exactly 9 functions, 4 relations and 13 triggers', () => {
  assert.equal(final.functions.length, 142);
  assert.equal(final.relations.length, 93);
  assert.equal(final.triggers.length, 135);
  const changedFunctions = [];
  for (const f of baseline.functions) {
    const actual = final.functions.find(a => a.signature === f.signature);
    if (f.signature === key + 'grant_complete_flat_text_attempt_v362(uuid,jsonb)') {
      assert.deepEqual(actual, {...f, body_md5: 'd12fadd87e87c9a74c9060b9ba9f4c6b'});
      changedFunctions.push(f.signature);
    } else assert.deepEqual(actual, f);
  }
  assert.deepEqual(changedFunctions, [key + 'grant_complete_flat_text_attempt_v362(uuid,jsonb)']);
  for (const t of baseline.triggers) assert.deepEqual(final.triggers.find(a => a.table === t.table && a.name === t.name), t);
  assert.deepEqual(final.principals, baseline.principals);
  assert.deepEqual(final.defaults, baseline.defaults);
});

test('inherited unlimited-grant repair changes exactly one qualified row type declaration', () => {
  const actions = extractFrozenActionsV400(sources);
  assert.equal(actions.grantRepair.replace('CREATE OR REPLACE FUNCTION ', 'CREATE FUNCTION ')
    .replace('ordinary cinatoken_gateway.user_budget_reservations%ROWTYPE;', 'ordinary record;'), actions.originalGrant);
  assert.equal(actions.grantRepair.split('ordinary cinatoken_gateway.user_budget_reservations%ROWTYPE;').length - 1, 1);
  const oldGrant = baseline.functions.find(f => f.signature === key + 'grant_complete_flat_text_attempt_v362(uuid,jsonb)');
  assert.equal(oldGrant.body_md5, '0339e4f95fff26784032d2d73ec09a7a');
  const sql = renderInstallerV400(baseline, sources);
  assert.ok(sql.indexOf('-- BEGIN narrow v362 inherited grant typed-row declaration repair') > sql.indexOf('$preflight$;'));
  assert.ok(sql.indexOf('-- END narrow v362 inherited grant typed-row declaration repair') < sql.indexOf('-- BEGIN unchanged frozen v396 action DDL'));
});

test('financial table and column authority is unchanged outside three verifier reads', () => {
  for (const prior of baseline.relations) {
    const current = final.relations.find(t => t.name === prior.name);
    const {acl: oldAcl, ...oldShape} = prior;
    const {acl: newAcl, ...newShape} = current;
    assert.deepEqual(newShape, oldShape);
    if (['models','model_surfaces','system_config'].some(t => prior.name === key + t)) {
      assert.equal(newAcl.length, oldAcl.length + 1);
      assert.deepEqual(newAcl.filter(a => a.grantee !== 'cinatoken_gateway_route_source_verifier'), oldAcl);
      assert.deepEqual(newAcl.find(a => a.grantee === 'cinatoken_gateway_route_source_verifier'), {
        grantee: 'cinatoken_gateway_route_source_verifier', grantor: 'cinatoken_gateway_migrator', privilege: 'SELECT', grantable: false,
      });
    } else assert.deepEqual(newAcl, oldAcl);
  }
});

test('v388 enrolled-hold body and all admission/recovery/observation fences survive the merge', () => {
  assert.equal(final.functions.find(f => f.signature === key + 'reject_complete_text_enrolled_hold_mutation_v366()').body_md5, '6e5666a4e25b0645537c0742cd44b52e');
  for (const [table, count] of [['complete_text_attempt_grants_v362',5],['complete_text_send_custody_v365',4],['complete_text_send_starts_v365',4]]) {
    assert.equal(final.triggers.filter(t => t.table === key + table).length, count);
  }
  assert.equal(final.triggers.filter(t => t.table === 'cinatoken_response_observation.observations_v392').length, 3);
  assert.ok(final.functions.some(f => f.signature === key + 'authenticate_personal_gateway_key_v395(text)'));
});

const tamperCases = {
  body: b => {b.functions[0].body_md5 = '0'.repeat(32);},
  argumentDefault: b => {b.functions[0].arguments += " DEFAULT 'unsafe'::text";},
  outContract: b => {b.functions[0].result_definition = 'TABLE(secret text)';},
  grantor: b => {b.functions[0].acl[0].grantor = 'cinatoken_gateway_runtime';},
  grantOption: b => {b.functions[0].acl[0].grantable = true;},
  trigger: b => {b.triggers.push({...b.triggers[0], name: 'unexpected_trigger'});},
  rls: b => {b.relations[0].rls = true;},
  rule: b => {b.relations[0].rules.push({name: 'unexpected_rule', enabled: 'O', definition: 'unsafe'});},
  column: b => {b.relations[0].columns[0].type = 'bigint';},
  defaultAcl: b => {b.defaults[0].acl[0].grantable = true;},
  principal: b => {b.principals[0].inherit = true;},
  schema: b => {b.schemas[0].acl[0].grantable = true;},
};
for (const [name, mutate] of Object.entries(tamperCases)) test(`generator rejects tampered selected baseline: ${name}`, () => {
  const altered = structuredClone(baseline);
  mutate(altered);
  assert.throws(() => renderInstallerV400(altered, sources), /selected baseline catalog differs/u);
});

test('frozen source drift cannot enter the successor compilation', () => {
  for (const name of Object.keys(SOURCE_PINS_V400)) {
    assert.throws(() => extractFrozenActionsV400({...sources, [name]: sources[name] + '\n'}), /frozen source differs/u);
  }
});

test('independent final audit catches hidden authority mutation', () => {
  assert.equal(assertFinalCatalogV400(final, baseline, sources).triggers, 135);
  const changed = structuredClone(final);
  changed.functions.find(f => f.signature.includes('complete_text_sticky_action_v398')).acl.push({
    grantee: 'PUBLIC', grantor: 'cinatoken_gateway_migrator', privilege: 'EXECUTE', grantable: false,
  });
  assert.throws(() => assertFinalCatalogV400(changed, baseline, sources), /final catalog differs: functions/u);
});

test('shared metadata capture owns one transaction and requires a catalog response', async () => {
  let begins = 0;
  const statements = [];
  const sql = {begin: async callback => {begins++; return await callback({unsafe: async statement => {
    statements.push(statement);
    return statements.length === 1 ? [] : [{catalog: baseline}];
  }});}};
  assert.deepEqual(await captureCatalogV400(sql), baseline);
  assert.equal(begins, 1);
  assert.equal(statements.length, 2);
  assert.equal(statements[0], 'SET LOCAL search_path TO pg_catalog,pg_temp');
  await assert.rejects(() => captureCatalogV400({begin: async callback => await callback({unsafe: async () => []})}), /catalog capture differs/u);
});
