// Owned loopback PostgreSQL only. No ambient DATABASE_URL or remote database is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createPostgresUsersRepository } from '../../../packages/core/src/db/postgres/users.impl.ts';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const gateway = 'cinatoken_gateway';
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);

function deletionAudit(userId) {
  return {
    id: randomUUID(), userId, eventType: 'user_deleted', actorType: 'admin',
    actorId: 'admin:native-fixture', source: 'admin_users', reasonCode: 'admin_user_delete',
    changePayload: JSON.stringify({ deleted_user_id: userId }),
    beforeUserSnapshot: JSON.stringify({ id: userId, email: `${userId}@example.invalid` }),
    afterUserSnapshot: null,
  };
}

test('native PostgreSQL user deletion keeps audit truthful before and after recovery FK',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    try {
      const { admin } = cluster;
      const [version] = await admin.unsafe(`SELECT current_setting('server_version_num')::int AS version_num`);
      assert.ok(version.version_num >= 180000);
      await admin.unsafe(`CREATE SCHEMA ${gateway}`);
      const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const migrate = async name => admin.begin(async tx => {
        await tx.unsafe(await readFile(new URL(name, migrationDir), 'utf8')).simple();
      });
      for (const name of files.filter(name => name <= '0068_function_schema_resolution.sql')) await migrate(name);

      const users = createPostgresUsersRepository({
        driver: 'postgres', raw: admin, drizzle: drizzle(admin, { schema: pgCoreSchema }),
      });
      assert.equal(typeof users.deleteUserHardWithAudit, 'function');
      const count = async (table, clause = '') => Number((await admin.unsafe(
        `SELECT count(*)::int AS n FROM ${gateway}.${table} ${clause}`,
      ))[0].n);

      await admin.unsafe(`INSERT INTO ${gateway}.users(id,email)
        VALUES ('pre-0069','pre-0069@example.invalid')`);
      assert.equal(await users.deleteUserHardWithAudit('pre-0069', deletionAudit('pre-0069')), 'deleted');
      assert.equal(await count('users', `WHERE id='pre-0069'`), 0);
      assert.equal(await count('user_audit_logs', `WHERE event_type='user_deleted' AND source='admin_users'`), 1);

      for (const name of files.filter(name => name > '0068_function_schema_resolution.sql')) await migrate(name);
      await admin.unsafe(`INSERT INTO ${gateway}.users(id,email)
          VALUES ('intent-victim','intent-victim@example.invalid'),
            ('clean-victim','clean-victim@example.invalid'),
            ('audit-victim','audit-victim@example.invalid');
        INSERT INTO ${gateway}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('intent-space','personal','intent-victim','Intent Space','intent-space','active');
        INSERT INTO ${gateway}.api_keys(id,key,user_id,workspace_id)
          VALUES ('intent-key','hashref:sha256:${'a'.repeat(64)}','intent-victim','intent-space');`)
        .simple();
      await admin.unsafe(`INSERT INTO ${gateway}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('admin-delete-intent',1,'intent-victim','intent-key','intent-space',
          'images.generations',repeat('b',64),floor(extract(epoch FROM clock_timestamp())*1000)::bigint+60000)`);

      const beforeBlockedAudit = await count('user_audit_logs', `WHERE event_type='user_deleted'`);
      assert.equal(await users.deleteUserHardWithAudit('intent-victim', deletionAudit('intent-victim')), 'dispatch_history');
      assert.equal(await count('users', `WHERE id='intent-victim'`), 1);
      assert.equal(await count('user_audit_logs', `WHERE event_type='user_deleted'`), beforeBlockedAudit);

      await admin.unsafe(`ALTER TABLE ${gateway}.user_audit_logs ADD CONSTRAINT native_reject_admin_delete
        CHECK (change_payload NOT LIKE '%audit-victim%')`);
      try {
        await assert.rejects(
          () => users.deleteUserHardWithAudit('audit-victim', deletionAudit('audit-victim')),
          error => error.cause?.code === '23514'
            && error.cause?.constraint_name === 'native_reject_admin_delete',
        );
      } finally {
        await admin.unsafe(`ALTER TABLE ${gateway}.user_audit_logs DROP CONSTRAINT native_reject_admin_delete`);
      }
      assert.equal(await count('users', `WHERE id='audit-victim'`), 1);
      assert.equal(await count('user_audit_logs', `WHERE event_type='user_deleted'`), beforeBlockedAudit);

      await admin.unsafe(`CREATE TABLE ${gateway}.native_user_ref
        (user_id text NOT NULL REFERENCES ${gateway}.users(id) ON DELETE RESTRICT);
        INSERT INTO ${gateway}.users(id,email)
          VALUES ('other-fk-victim','other-fk-victim@example.invalid');
        INSERT INTO ${gateway}.native_user_ref(user_id) VALUES ('other-fk-victim')`).simple();
      try {
        await assert.rejects(
          () => users.deleteUserHardWithAudit('other-fk-victim', deletionAudit('other-fk-victim')),
          error => error.cause?.code === '23001'
            && error.cause?.constraint_name === 'native_user_ref_user_id_fkey',
        );
      } finally {
        await admin.unsafe(`DROP TABLE ${gateway}.native_user_ref`);
      }
      assert.equal(await count('users', `WHERE id='other-fk-victim'`), 1);
      assert.equal(await count('user_audit_logs', `WHERE event_type='user_deleted'`), beforeBlockedAudit);

      assert.equal(await users.deleteUserHardWithAudit('clean-victim', deletionAudit('clean-victim')), 'deleted');
      assert.equal(await count('users', `WHERE id='clean-victim'`), 0);
      const [audit] = await admin.unsafe(`SELECT user_id,before_user_snapshot,change_payload
        FROM ${gateway}.user_audit_logs WHERE event_type='user_deleted'
          AND change_payload LIKE '%clean-victim%'`);
      assert.equal(audit.user_id, null);
      assert.equal(JSON.parse(audit.before_user_snapshot).id, 'clean-victim');
      assert.equal(JSON.parse(audit.change_payload).deleted_user_id, 'clean-victim');
      assert.equal(await users.deleteUserHardWithAudit('missing-user', deletionAudit('missing-user')), 'not_deleted');
      assert.equal(await count('user_audit_logs', `WHERE event_type='user_deleted'`), beforeBlockedAudit + 1);
    } finally {
      await cluster.cleanup();
    }
  });
