import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as current from '@octafuse/core';
import { postgresInitializationPeer as peer, assertOneClosedInitialization } from '../test-support/postgres-initialization-peer.mjs';

// This is a bounded PostgreSQL wire peer, not a SQL engine, database or Hyperdrive.
// Optional immutable old bundle enables same-test comparison without changing source.
const core = process.env.PG_INIT_V249_BASELINE ? await import(pathToFileURL(process.env.PG_INIT_V249_BASELINE).href) : current;

for (const entry of ['database', 'context', 'worker']) for (const mode of ['error', 'disconnect']) {
  test(`real postgres.js initialization ${entry}/${mode} closes and never replays`, { timeout: 5000 }, async t => {
    t.mock.method(console, 'warn', () => {});
    const p = await peer(t, mode), options = { fetch_types: false, connect_timeout: 1, max: 1 };
    const pending = entry === 'database' ? core.createPostgresDatabaseClient(p.url, options)
      : entry === 'context' ? core.createPostgresStorageContext(p.url, options)
        : core.createWorkerStorageContext({ driver: 'postgres', connectionString: p.url });
    await assert.rejects(pending);
    await assertOneClosedInitialization(p);
  });
}
test('successful real postgres.js context retains client until its consumer closes it', { timeout: 5000 }, async t => {
  const p = await peer(t, 'success');
  const value = await core.createWorkerStorageContext({ driver: 'postgres', connectionString: p.url });
  t.after(() => value.client.raw.end({ timeout: 0 }));
  assert.equal(value.client.driver, 'postgres'); assert.equal(p.observations.connections, 1); assert.equal(p.observations.closes, 0);
  await value.client.raw.end({ timeout: 1 });
  await assertOneClosedInitialization(p);
});
