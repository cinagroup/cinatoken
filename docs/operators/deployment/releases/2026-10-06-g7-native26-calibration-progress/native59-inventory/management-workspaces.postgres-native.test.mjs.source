// Isolated localhost PostgreSQL only. No ambient database URL or cloud service.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { startNativePostgres } from '../test-support/postgres-native-cluster.mjs';
import { deleteManagementWorkspace } from './management-workspaces.ts';
import { createProxyApp } from '../../../proxy/src/app.ts';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../migrations-postgres/', import.meta.url);
const secret = `sk-cina-mgmt-${'d'.repeat(64)}`;
const principal = {
  keyId: 'management', createdByUserId: 'owner',
  account: { accountType: 'personal', personalOwnerUserId: 'owner', organizationId: null },
};

test('workspace delete maps only recovery FK restrictions and preserves revoked-key history',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async t => {
    const cluster = await startNativePostgres();
    t.after(async () => {
      await cluster.stop();
      await cluster.cleanup();
      t.diagnostic('Native fixture stopped and removed its owned cluster');
    });
    const sql = cluster.admin;
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    const files = (await readdir(migrations)).filter(file => file.endsWith('.sql')
      && file <= '0069_recovery_dispatch_intents.sql').sort();
    assert.equal(files.length, 69);
    for (const file of files) {
      const body = await readFile(new URL(file, migrations), 'utf8');
      await sql.begin(tx => tx.unsafe(body).simple());
    }
    await sql.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES ('owner','owner@example.invalid');
      INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,
        is_default,default_scope_key,status,created_by_user_id)
        VALUES ('owned-workspace','personal','owner','Owned','owned',TRUE,'owned-workspace','active','owner'),
          ('empty-workspace','personal','owner','Empty','empty',FALSE,NULL,'active','owner');
      INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id,status)
        VALUES ('revoked-key','revoked-fixture-key','owner','owned-workspace','revoked');
      INSERT INTO ${schema}.management_api_keys(id,key_hash,key_preview,account_type,
        personal_owner_user_id,name,status,created_by_user_id)
        VALUES ('management','sha256:${'d'.repeat(64)}','fixture','personal',
          'owner','Fixture','active','owner');`).simple();
    await sql.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
      (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
      VALUES ('workspace-delete-fixture',1,'owner','revoked-key','owned-workspace',
        'images.generations',$1,
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint+60000)`, ['a'.repeat(64)]);

    let observedConstraint;
    await assert.rejects(sql.unsafe(`DELETE FROM ${schema}.workspaces WHERE id='owned-workspace'`),
      error => {
        assert.ok(['23001', '23503'].includes(error.code));
        observedConstraint = error.constraint_name;
        assert.ok([
          'request_dispatch_intents_workspace_id_fkey',
          'request_dispatch_intents_api_key_id_fkey',
        ].includes(observedConstraint), `unexpected restriction: ${observedConstraint}`);
        return true;
      });
    t.diagnostic(`Native workspace DELETE restriction: ${observedConstraint}`);

    const client = { driver: 'postgres', raw: sql, drizzle: null };
    const before = (await sql.unsafe(`SELECT
      (SELECT count(*)::int FROM ${schema}.workspaces WHERE id='owned-workspace' AND status='active') AS workspace,
      (SELECT count(*)::int FROM ${schema}.api_keys WHERE id='revoked-key' AND status='revoked') AS revoked_key,
      (SELECT count(*)::int FROM ${schema}.request_dispatch_intents WHERE request_id='workspace-delete-fixture') AS intent,
      (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE event_type='workspace_deleted') AS delete_audits`))[0];
    assert.deepEqual(before, { workspace: 1, revoked_key: 1, intent: 1, delete_audits: 0 });
    assert.equal(await deleteManagementWorkspace(client, principal, 'owned-workspace', true), 'recovery_history');

    const repositories = {
      client,
      managementApiKeys: { getActiveBySecret: async candidate => candidate === secret ? {
        id: 'management', key_hash: `sha256:${'d'.repeat(64)}`, key_preview: 'fixture',
        account_type: 'personal', personal_owner_user_id: 'owner', organization_id: null,
        name: 'Fixture', status: 'active', expires_at: null, last_used_at: null,
        created_by_user_id: 'owner', created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      } : null },
    };
    const app = createProxyApp(async () => ({ client, repositories }));
    const response = await app.request('http://localhost/api/v1/workspaces/owned-workspace?confirm_default_workspace_deletion=true',
      { method: 'DELETE', headers: { Authorization: `Bearer ${secret}` } },
      { REQUEST_BODY_LOGGING: 'off' });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /request recovery history cannot be deleted/);

    const after = (await sql.unsafe(`SELECT
      (SELECT count(*)::int FROM ${schema}.workspaces WHERE id='owned-workspace' AND status='active') AS workspace,
      (SELECT count(*)::int FROM ${schema}.api_keys WHERE id='revoked-key' AND status='revoked') AS revoked_key,
      (SELECT count(*)::int FROM ${schema}.request_dispatch_intents WHERE request_id='workspace-delete-fixture') AS intent,
      (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE event_type='workspace_deleted') AS delete_audits`))[0];
    assert.deepEqual(after, before, 'blocked deletion rolls back the workspace, key, intent and audit');
    assert.equal(await deleteManagementWorkspace(client, principal, 'empty-workspace', false), 'deleted');
    const [control] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${schema}.workspaces WHERE id='empty-workspace'`);
    assert.equal(control.n, 0);
  });

test('workspace delete classifies both recovery FK paths without swallowing other SQL failures', async () => {
  const base = { code: '23503', schema_name: schema,
    table_name: 'request_dispatch_intents' };
  const invoke = error => deleteManagementWorkspace({
    driver: 'postgres', raw: { begin: async () => { throw error; } }, drizzle: null,
  }, principal, 'owned-workspace', true);
  for (const constraint_name of [
    'request_dispatch_intents_workspace_id_fkey',
    'request_dispatch_intents_api_key_id_fkey',
  ]) {
    assert.equal(await invoke({ ...base, constraint_name }), 'recovery_history');
    assert.equal(await invoke({ ...base, code: '23001', constraint_name }), 'recovery_history');
  }
  for (const error of [
    { ...base, constraint_name: 'other_workspace_id_fkey' },
    { ...base, constraint_name: 'request_dispatch_intents_api_key_id_fkey', table_name: 'other' },
    { ...base, constraint_name: 'request_dispatch_intents_workspace_id_fkey', code: '08006' },
    new Error('foreign key constraint request_dispatch_intents_workspace_id_fkey'),
  ]) {
    await assert.rejects(invoke(error), actual => actual === error);
  }
});
