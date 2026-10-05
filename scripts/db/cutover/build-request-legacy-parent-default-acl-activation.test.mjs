import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRequestLegacyParentDefaultAclActivation } from './build-request-legacy-parent-default-acl-activation.mjs';
import { createPg73LegacyParentBuilderFixture } from './pg73-legacy-parent-builder-fixture.mjs';

test('current formal filesystem keeps the production PG73 builder closed', async () => {
  await assert.rejects(buildRequestLegacyParentDefaultAclActivation(), /Explicit reviewed-v1/);
  await assert.rejects(buildRequestLegacyParentDefaultAclActivation({ activation: 'reviewed-v1' }),
    /Formal PostgreSQL migration version set changed/);
});

test('legacy parent ACL bundle pins the parent and keeps gate inside one transaction', async t => {
  const fixture = await createPg73LegacyParentBuilderFixture();
  t.after(() => fixture.cleanup());
  await assert.rejects(fixture.build(), /Explicit reviewed-v1/);
  const bundle = await fixture.build({ activation: 'reviewed-v1' });
  assert.equal(fixture.manifest.filter(file => file.kind === 'migration').length, 73);
  assert.equal(fixture.manifest.filter(file => file.kind === 'builder').length, 3);
  assert.equal(fixture.manifest.filter(file => file.kind === 'proposal').length, 3);
  for (const file of fixture.manifest) {
    assert.deepEqual(await readFile(file.target), await readFile(file.source),
      'The frozen builder graph and corpus must retain every source byte');
  }
  assert.match(bundle.originalParentSha256, /^[0-9a-f]{64}$/);
  assert.equal(bundle.gateSha256,
    '1079eb858811c70dd850b95be68f64e5c7b8361926e8c3f0a9e80621f6125b10');
  assert.equal(bundle.formalMigrationCount, 73);
  assert.equal(bundle.formalCorpusSha256,
    '23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc');
  assert.equal(bundle.reservationSourceSha256,
    'c288bbc43fad3bbb8b3b1a88fa1b1d01b9e5f2f9f520753873e0cdf21643c3d8');
  assert.match(bundle.sql, /\nBEGIN;\n/);
  assert.ok(bundle.sql.endsWith('COMMIT;\n'));
  assert.equal((bundle.sql.match(/^COMMIT;$/gm) ?? []).length, 1);
  assert.match(bundle.bodySql, /request_sha256 COLLATE "C" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(bundle.bodySql, /CREATE TEMP TABLE parent_default_acl_snapshot/);
  assert.match(bundle.bodySql, /Legacy request replay reservation backfill is incomplete/);
  assert.match(bundle.bodySql, /CREATE TRIGGER request_dispatch_requests_replay_reserve/);
  assert.match(bundle.bodySql, /Request parent default ACL restoration differs/);
  assert.match(bundle.bodySql, /Legacy parent formal migration ledger differs from reviewed 0001\.\.0073/);
  assert.ok(bundle.bodySql.indexOf('pg_advisory_xact_lock(746923551)')
    < bundle.bodySql.indexOf('LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE'));
  assert.ok(bundle.bodySql.indexOf('LOCK TABLE cinatoken_gateway.schema_migrations IN SHARE MODE')
    < bundle.bodySql.indexOf('DO $legacy_parent_migration_ledger$'));
  assert.ok(bundle.bodySql.indexOf('DO $legacy_parent_migration_ledger$')
    < bundle.bodySql.indexOf('DO $legacy_parent_replay_reservation_catalog$'));
  for (const name of ['reserve_request_dispatch_intent_id', 'reserve_request_log_replay_id']) {
    const anchor = `ALTER FUNCTION cinatoken_gateway.${name}()\n  COST 100;`;
    assert.equal(bundle.bodySql.split(anchor).length, 2);
    assert.ok(bundle.bodySql.indexOf('LOCK TABLE cinatoken_gateway.request_dispatch_intents')
      < bundle.bodySql.indexOf(anchor));
    assert.ok(bundle.bodySql.indexOf(anchor)
      < bundle.bodySql.indexOf('DO $legacy_parent_replay_reservation_catalog$'));
  }
  assert.match(bundle.bodySql, /server_version_num'\)::integer NOT BETWEEN 180000 AND 189999/);
  assert.ok(bundle.bodySql.indexOf('DO $legacy_parent_replay_reservation_catalog$')
    < bundle.bodySql.indexOf('CREATE TABLE cinatoken_gateway.request_dispatch_requests'));
  assert.match(bundle.bodySql, /p\.prosrc = \$expected_replay_body\$/);
  assert.match(bundle.bodySql, /t\.tgfoid/);
  assert.ok(bundle.bodySql.indexOf('CREATE TABLE cinatoken_gateway.request_dispatch_requests')
    < bundle.bodySql.indexOf('CREATE TRIGGER request_dispatch_requests_replay_reserve'));
  assert.doesNotMatch(bundle.bodySql, /Existing dispatch intents need separately reviewed request backfill/);
});

test('copied PG73 builder still rejects migration byte and version drift', async t => {
  const fixture = await createPg73LegacyParentBuilderFixture();
  t.after(() => fixture.cleanup());
  const migration = fixture.manifest.find(file => file.kind === 'migration');
  const bytes = await readFile(migration.target);
  await writeFile(migration.target, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(fixture.build({ activation: 'reviewed-v1' }),
    /Formal PostgreSQL migration corpus changed/);
  await writeFile(migration.target, bytes);
  await writeFile(join(fixture.root, 'packages/core/migrations-postgres/9999_unreviewed.sql'), '');
  await assert.rejects(fixture.build({ activation: 'reviewed-v1' }),
    /Formal PostgreSQL migration version set changed/);
});

test('owned builder fixture cleanup removes only its exact Temp directory', async () => {
  const fixture = await createPg73LegacyParentBuilderFixture();
  await fixture.cleanup();
  await assert.rejects(stat(fixture.root), error => error.code === 'ENOENT');
  await assert.rejects(fixture.build({ activation: 'reviewed-v1' }), /already been cleaned up/);
  await fixture.cleanup();
});
