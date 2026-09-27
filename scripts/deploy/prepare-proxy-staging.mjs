#!/usr/bin/env node
/** Prepare a closed-ingress, isolated proxy config. Never deploys or provisions. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const STAGING_WORKER = 'cinatoken-proxy-staging';
export const STAGING_DATABASE = 'cinatoken-staging';
export const STAGING_ACCOUNT = '7ea8e46d8210bad342fa7595f7935fea';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROXY = join(ROOT, 'packages/proxy');
const OUTPUT = join(ROOT, '.wrangler/staging/proxy/wrangler.jsonc');

export function readJsonc(path) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error) throw new Error(`Invalid JSONC: ${path}`);
  return parsed.config;
}

export function assertStagingIsolation(config, production) {
  assert.equal(config.name, STAGING_WORKER, 'Unexpected staging Worker');
  assert.equal(config.main, production.main, 'Must use the real proxy entrypoint');
  assert.equal(config.compatibility_date, production.compatibility_date, 'Compatibility date drift');
  assert.deepEqual(config.compatibility_flags, production.compatibility_flags, 'Compatibility flag drift');
  assert.equal(config.workers_dev, false, 'Public ingress requires a separate Access gate');
  assert.equal(config.preview_urls, false, 'Preview URLs must remain closed');
  assert.deepEqual(config.routes, [], 'No production/custom-domain routes permitted');
  assert.deepEqual(config.triggers, { crons: [] }, 'No background triggers permitted');
  assert.deepEqual(config.vars, {
    DATABASE_DRIVER: 'd1', REQUEST_BODY_LOGGING: 'off', BATCH_API_ENABLED: 'false',
  }, 'Do not inherit production variables or secrets');
  assert.deepEqual(config.secrets, { required: ['SHARED_KEY_ENCRYPTION_SECRET'] });
  assert.deepEqual(config.d1_databases, [{
    binding: 'DB', database_name: STAGING_DATABASE, migrations_dir: '../core/migrations-d1',
  }], 'Database IDs are injected only after remote name verification');
  assert.notEqual(config.name, production.name);
  assert.ok(!(production.d1_databases ?? []).some((db) => db.database_name === STAGING_DATABASE));
  const productionNamespaces = new Set((production.ratelimits ?? []).map((item) => item.namespace_id));
  const namespaces = new Set();
  const rateNames = new Set();
  assert.equal(config.ratelimits.length, production.ratelimits.length);
  for (const rate of config.ratelimits) {
    const equivalent = production.ratelimits.find((item) => item.name === rate.name);
    assert.ok(equivalent, 'Unexpected rate-limit binding');
    assert.ok(!rateNames.has(rate.name), 'Duplicate staging rate-limit binding name');
    assert.deepEqual(rate.simple, equivalent.simple, 'Rate-limit behavior drift');
    assert.match(rate.namespace_id, /^\d+$/);
    assert.ok(!productionNamespaces.has(rate.namespace_id), 'Shared production rate-limit namespace');
    assert.ok(!namespaces.has(rate.namespace_id), 'Duplicate staging rate-limit namespace');
    namespaces.add(rate.namespace_id);
    rateNames.add(rate.name);
  }
  const allowed = new Set([
    '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'send_metrics',
    'workers_dev', 'preview_urls', 'routes', 'triggers', 'vars', 'd1_databases',
    'ratelimits', 'observability', 'secrets',
  ]);
  for (const key of Object.keys(config)) assert.ok(allowed.has(key), `Unapproved staging field: ${key}`);
  assert.equal(config.send_metrics, false);
  assert.deepEqual(config.observability, { enabled: true, head_sampling_rate: 1 });
}

export function assertStagingDatabase(database, requestedId) {
  assert.match(requestedId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, 'Invalid staging D1 ID');
  assert.equal(database?.uuid, requestedId, 'Cloudflare D1 ID mismatch');
  assert.equal(database?.name, STAGING_DATABASE, 'Refusing a non-staging database');
}

async function main() {
  // Only one local preparation operation exists; no deploy/migrate passthrough.
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/deploy/prepare-proxy-staging.mjs');
  const config = readJsonc(join(PROXY, 'wrangler.staging.base.jsonc'));
  const production = readJsonc(join(PROXY, 'wrangler.base.jsonc'));
  assertStagingIsolation(config, production);
  const id = process.env.STAGING_D1_DATABASE_ID?.trim();
  if (id) {
    assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, 'Invalid staging D1 ID');
    const token = process.env.CLOUDFLARE_API_TOKEN;
    assert.ok(token, 'CLOUDFLARE_API_TOKEN is required for read-only D1 identity verification');
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT}/d1/database/${id}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
    );
    const result = await response.json();
    assert.ok(response.ok && result.success, `Staging D1 identity check failed (HTTP ${response.status})`);
    assertStagingDatabase(result.result, id);
    config.d1_databases[0].database_id = id;
  }
  // Absolute paths keep output independent of cwd and the production generator.
  config.account_id = STAGING_ACCOUNT;
  config.$schema = join(ROOT, 'node_modules/wrangler/config-schema.json');
  config.main = resolve(PROXY, config.main);
  config.d1_databases[0].migrations_dir = resolve(PROXY, config.d1_databases[0].migrations_dir);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify({
    status: id ? 'CONFIG_PREPARED_DATABASE_ID_VERIFIED' : 'OFFLINE_CONFIG_ONLY_DATABASE_NOT_PROVISIONED',
    config: OUTPUT, worker: STAGING_WORKER, database: STAGING_DATABASE,
    ingress: 'closed', deployed: false, productionConfigChanged: false,
    next: 'Dry-run only until resources, secrets, budget and Access gates are satisfied. Disable automatic provisioning.',
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
