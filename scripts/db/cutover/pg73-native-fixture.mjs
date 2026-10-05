// Test-only bridge for review proposals pinned to the historical PG73 ledger.
// Call only with the migrator client and URL of a newly owned native cluster.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const lastPg73 = '0073_recovery_api_key_workspace_lock.sql';
const auditMigration = '0074_config_change_audit.sql';
const corpusSha256 = '23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc';
const ledgerMd5 = 'ca1ea96a1b4bcd0675642f30dcf48042';

export async function listPg73Migrations() {
  const files = (await readdir(migrations))
    .filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && name <= lastPg73)
    .sort();
  assert.equal(files.length, 73, 'Historical PG73 migration count differs');
  assert.equal(files.at(-1), lastPg73);
  const corpus = await Promise.all(files.map(async name =>
    `${name}\n${await readFile(new URL(name, migrations), 'utf8')}`));
  assert.equal(createHash('sha256').update(corpus.join('\n')).digest('hex'), corpusSha256,
    'Historical PG73 migration corpus differs');
  assert.equal(createHash('md5').update(files.join('\n')).digest('hex'), ledgerMd5,
    'Historical PG73 migration ledger differs');
  return files;
}

async function pg73State(migrator) {
  const [state] = await migrator.unsafe(`SELECT current_user AS current_role,
      (SELECT owner.rolname FROM pg_catalog.pg_namespace AS namespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid=namespace.nspowner
       WHERE namespace.nspname='cinatoken_gateway') AS schema_owner,
      (SELECT count(*)::int FROM cinatoken_gateway.schema_migrations) AS migration_count,
      (SELECT pg_catalog.md5(pg_catalog.string_agg(version,E'\\n'
        ORDER BY version COLLATE "C")) FROM cinatoken_gateway.schema_migrations) AS migration_md5,
      pg_catalog.to_regclass('cinatoken_gateway.config_change_audit') IS NOT NULL AS audit_table,
      EXISTS (SELECT 1 FROM cinatoken_gateway.schema_migrations
        WHERE version='0074_config_change_audit.sql') AS audit_ledger`);
  assert.equal(state?.current_role, 'cinatoken_gateway_migrator');
  assert.equal(state.schema_owner, state.current_role);
  assert.equal(state.migration_count, 73, 'PG73 fixture requires exactly 73 applied migrations');
  assert.equal(state.migration_md5, ledgerMd5, 'PG73 fixture ledger differs');
  assert.equal(state.audit_table, false, 'PG73 fixture requires 0074 table to be absent');
  assert.equal(state.audit_ledger, false, 'PG73 fixture requires 0074 ledger to be absent');
}

export async function grantPg73RuntimeFixture({ cluster, migrator, migratorUrl }) {
  assert.ok(migrator && typeof migrator.begin === 'function');
  let target;
  try { target = new URL(migratorUrl); }
  catch { throw new Error('PG73 grant fixture requires an owned loopback migrator URL'); }
  assert.ok(cluster?.owned && Number.isSafeInteger(cluster.port)
    && ['postgres:', 'postgresql:'].includes(target.protocol)
    && target.hostname === '127.0.0.1'
    && Number(target.port) === cluster.port
    && target.username === 'cinatoken_gateway_migrator'
    && target.pathname === '/postgres',
  'PG73 grant fixture requires an owned loopback migrator URL');
  await pg73State(migrator);
  const body = await readFile(new URL(auditMigration, migrations), 'utf8');
  let installed = false;
  try {
    await migrator.begin(async tx => {
      await tx.unsafe(body).simple();
      await tx.unsafe(`INSERT INTO cinatoken_gateway.schema_migrations(version)
        VALUES ($1)`, [auditMigration]);
    });
    installed = true;
    // The production reconciler still enforces 0074. The temporary object and
    // ledger exist only for this call, never for proposal activation or tests.
    await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
    const [acl] = await migrator.unsafe(`SELECT
      pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.config_change_audit','INSERT') AS can_insert,
      pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.config_change_audit','SELECT') AS can_select,
      pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.config_change_audit','UPDATE') AS can_update,
      pg_catalog.has_table_privilege('cinatoken_gateway_runtime',
        'cinatoken_gateway.config_change_audit','DELETE') AS can_delete`);
    assert.deepEqual(acl, { can_insert: true, can_select: false,
      can_update: false, can_delete: false },
      'Temporary 0074 audit ACL differs');
  } finally {
    if (installed) {
      await migrator.begin(async tx => {
        await tx.unsafe('DROP TABLE cinatoken_gateway.config_change_audit');
        await tx.unsafe(`DELETE FROM cinatoken_gateway.schema_migrations
          WHERE version=$1`, [auditMigration]);
      });
      await pg73State(migrator);
    }
  }
}
