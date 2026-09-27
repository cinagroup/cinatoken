import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const migrations = fileURLToPath(new URL('../../packages/core/migrations-d1/', import.meta.url));
const initialization = readFileSync(new URL('./staging-post-migrate.sql', import.meta.url), 'utf8');

function createMigratedDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      // Approximate the migration transaction boundary, not the D1 runtime.
      db.exec('BEGIN');
      try {
        db.exec(readFileSync(join(migrations, name), 'utf8'));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw new Error(`Local staging migration failed: ${name}`, { cause: error });
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function populatedTables(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
    .filter(({ name }) => !name.startsWith('sqlite_'))
    .map(({ name }) => ({
      table: name,
      rows: db.prepare(`SELECT COUNT(*) AS total FROM "${name.replaceAll('"', '""')}"`).get().total,
    }))
    .filter(({ rows }) => rows > 0)
    .sort((a, b) => a.table.localeCompare(b.table));
}

test('fresh staging migrations contain no tenant data and initialization revokes the demo admin key', () => {
  const db = createMigratedDatabase();
  try {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM system_config WHERE key = 'MASTER_KEY'").get().total, 0);
    const legacy = db.prepare("SELECT id, secret_key, status FROM admin_api_keys WHERE id = 'legacy-master'").get();
    assert.equal(legacy?.status, 'active');
    assert.equal(legacy?.secret_key, 'sk-dev-admin-key');
    assert.deepEqual(populatedTables(db), [
      { table: 'admin_api_keys', rows: 1 },
      { table: 'model_endpoint_backfill_database_identity', rows: 1 },
      { table: 'system_config', rows: 12 },
    ]);
    db.exec(initialization);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM admin_api_keys WHERE status = 'active'").get().total, 0);
    const revoked = db.prepare("SELECT status, revoked_at, updated_at FROM admin_api_keys WHERE id = 'legacy-master'").get();
    assert.equal(revoked.status, 'revoked');
    assert.ok(revoked.revoked_at);
    db.exec(initialization);
    assert.deepEqual(db.prepare("SELECT status, revoked_at, updated_at FROM admin_api_keys WHERE id = 'legacy-master'").get(), revoked);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('staging initialization leaves rotated legacy and custom administrator keys unchanged', () => {
  const db = createMigratedDatabase();
  try {
    db.prepare("UPDATE admin_api_keys SET secret_key = ? WHERE id = 'legacy-master'")
      .run('synthetic-rotated-key-not-a-real-secret');
    db.prepare(`INSERT INTO admin_api_keys (id, name, secret_key, key_prefix)
      VALUES ('custom-test', 'custom-test', ?, 'synthetic')`)
      .run('synthetic-custom-key-not-a-real-secret');
    const before = db.prepare('SELECT * FROM admin_api_keys ORDER BY id').all();
    db.exec(initialization);
    db.exec(initialization);
    assert.deepEqual(db.prepare('SELECT * FROM admin_api_keys ORDER BY id').all(), before);
  } finally {
    db.close();
  }
});
