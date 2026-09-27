import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertStagingDatabase, assertStagingIsolation, readJsonc,
} from './prepare-proxy-staging.mjs';

const staging = readJsonc(fileURLToPath(new URL('../../packages/proxy/wrangler.staging.base.jsonc', import.meta.url)));
const production = readJsonc(fileURLToPath(new URL('../../packages/proxy/wrangler.base.jsonc', import.meta.url)));

test('staging uses the real Worker and preserves production compatibility without resource inheritance', () => {
  assertStagingIsolation(staging, production);
});

test('unsafe routes, bindings, secrets, consumers, rate namespaces and runtime drift fail closed', () => {
  const mutations = [
    (c) => { c.name = production.name; },
    (c) => { c.main = 'src/test-only.ts'; },
    (c) => { c.compatibility_date = '2020-01-01'; },
    (c) => { c.compatibility_flags = []; },
    (c) => { c.workers_dev = true; },
    (c) => { c.preview_urls = true; },
    (c) => { c.routes = production.routes; },
    (c) => { c.triggers = production.triggers; },
    (c) => { c.vars.BATCH_API_ENABLED = 'true'; },
    (c) => { c.vars.SHARED_KEY_ENCRYPTION_SECRET = 'not-a-real-secret'; },
    (c) => { c.secrets.required.push('DEEPSEEK_API_KEY'); },
    (c) => { c.d1_databases[0].database_name = 'cinatoken'; },
    (c) => { c.d1_databases[0].database_id = 'unverified'; },
    (c) => { c.ratelimits[0].namespace_id = production.ratelimits[0].namespace_id; },
    (c) => { c.ratelimits[1].namespace_id = c.ratelimits[0].namespace_id; },
    (c) => { c.ratelimits[1].name = c.ratelimits[0].name; c.ratelimits[1].simple = c.ratelimits[0].simple; },
    (c) => { c.ratelimits[0].simple.limit += 1; },
    ...['queues', 'r2_buckets', 'hyperdrive', 'services', 'env', 'build', 'assets', 'kv_namespaces', 'secrets_store_secrets', 'route', 'account_id']
      .map((key) => (c) => { c[key] = {}; }),
  ];
  for (const mutate of mutations) {
    const config = structuredClone(staging);
    mutate(config);
    assert.throws(() => assertStagingIsolation(config, production));
  }
});

test('database identity must match both the exact staging name and requested UUID', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assertStagingDatabase({ name: 'cinatoken-staging', uuid: id }, id);
  for (const database of [undefined, { name: 'cinatoken', uuid: id }, { name: 'cinatoken-staging', uuid: 'different' }]) {
    assert.throws(() => assertStagingDatabase(database, id));
  }
  assert.throws(() => assertStagingDatabase({ name: 'cinatoken-staging', uuid: '../production' }, '../production'));
});
