import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDispatchIntentRepositoryPostgres, PostgresDispatchClaimUncertainError } from '../storage/recovery/dispatch-intent-postgres.ts';

const [dataDir, mode] = process.argv.slice(2);
assert.ok(dataDir && ['write', 'read'].includes(mode));
assert.ok(process.env.GATEWAY_PGLITE_MODULE);
assert.doesNotMatch(process.env.GATEWAY_PGLITE_MODULE, /^[a-z]+:\/\//i);
const { PGlite } = await import(pathToFileURL(resolve(process.env.GATEWAY_PGLITE_MODULE)).href);
const pg = await PGlite.create({ dataDir });
const ref = { requestId: 'restart-request', attemptIndex: 1, userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
  operation: 'images.generations', contextSha256: 'a'.repeat(64) };
const claim = '00000000-0000-0000-0000-000000000001';
const adapter = db => ({ unsafe: async (query, params = []) => (await db.query(query, params)).rows });
const client = { driver: 'postgres', raw: { ...adapter(pg), begin: run => pg.transaction(tx => run(adapter(tx))) } };
const repo = createDispatchIntentRepositoryPostgres(client);
try {
  if (mode === 'write') {
    await pg.exec('CREATE SCHEMA cinatoken_gateway');
    const dir = new URL('../../migrations-postgres/', import.meta.url);
    for (const file of readdirSync(dir).filter(x => x.endsWith('.sql') && x <= '0068_function_schema_resolution.sql').sort()) {
      await pg.transaction(tx => tx.exec(readFileSync(new URL(file, dir), 'utf8')));
    }
    await pg.transaction(tx => tx.exec(readFileSync(new URL('../../migrations-proposals/postgres/request-dispatch-intents.sql', import.meta.url), 'utf8')));
    await pg.exec(`INSERT INTO cinatoken_gateway.users(id,email) VALUES ('user','restart@example.invalid');
      INSERT INTO cinatoken_gateway.workspaces(id,scope_type,personal_owner_user_id,name,slug,status) VALUES ('workspace','personal','user','Fixture','fixture','active');
      INSERT INTO cinatoken_gateway.api_keys(id,key,user_id,workspace_id) VALUES ('key','','user','workspace');`);
    const expiry = Number((await pg.query('SELECT (floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint+600000)::text AS n')).rows[0].n);
    await repo.prepare(ref, expiry);
    const lostAck = createDispatchIntentRepositoryPostgres({ ...client, raw: { ...client.raw, async begin(run) {
      await client.raw.begin(run); throw new Error('synthetic committed ACK loss');
    } } });
    await assert.rejects(lostAck.claim(ref, 0, claim), PostgresDispatchClaimUncertainError);
    assert.equal((await repo.inspect(ref)).state, 'dispatch_claimed');
  } else {
    const row = await repo.inspect(ref); assert.equal(row.dispatch_claim_id, claim); assert.equal(row.revision, 1);
    assert.equal(await repo.claim(ref, 0, claim), 'not_granted');
    assert.equal(await repo.claim(ref, 1, claim), 'not_granted');
    assert.equal(await repo.classifyOverdue(ref, 1), false);
  }
} finally { await pg.close(); }
// Clean process shutdown/disk reopening, NOT abrupt kill/power-loss or native server WAL proof.
process.stdout.write(JSON.stringify({ mode }));
