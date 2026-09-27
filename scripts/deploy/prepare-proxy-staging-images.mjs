/** Explicit test composition over the existing isolated staging; never deploys. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStagingIsolation, assertStagingDatabase, readJsonc, STAGING_ACCOUNT, STAGING_WORKER, STAGING_DATABASE } from './prepare-proxy-staging.mjs';
export const IMAGE_UPSTREAM_WORKER = 'cinatoken-staging-images-upstream';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function imagesStagingConfig(staging, production) {
  assertStagingIsolation(staging, production);
  return { ...structuredClone(staging),
    // Full Worker application/storage/maintenance and event handlers, composed with a private Images transport.
    main: 'scripts/staging/images-gateway.ts',
    services: [{ binding: 'IMAGE_UPSTREAM', service: IMAGE_UPSTREAM_WORKER }],
  };
}
export function imagesRecoveryStagingConfig(staging, production) {
  return { ...imagesStagingConfig(staging, production), main: 'scripts/staging/images-recovery-gateway.ts' };
}
export function imagesFencingStagingConfig(staging, production) {
  return { ...imagesStagingConfig(staging, production), main: 'scripts/staging/images-fencing-gateway.ts' };
}
async function main() {
  assert.equal(process.argv.length, 2, 'No arbitrary config or deploy arguments accepted');
  const config = imagesStagingConfig(readJsonc(resolve(root, 'packages/proxy/wrangler.staging.base.jsonc')), readJsonc(resolve(root, 'packages/proxy/wrangler.base.jsonc')));
  const id = process.env.STAGING_D1_DATABASE_ID;
  if (id) {
    assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT}/d1/database/${id}`, {
      headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    const data = await r.json(); assert.ok(r.ok && data.success, 'Staging D1 check failed');
    assertStagingDatabase(data.result, id); config.d1_databases[0].database_id = id;
  }
  config.account_id = STAGING_ACCOUNT;
  config.main = resolve(root, 'packages/proxy', config.main);
  config.$schema = resolve(root, 'node_modules/wrangler/config-schema.json');
  config.d1_databases[0].migrations_dir = resolve(root, 'packages/core/migrations-d1');
  const output = resolve(root, '.wrangler/staging/images-proxy/wrangler.jsonc');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
  console.log(JSON.stringify({ config: output, worker: STAGING_WORKER, database: STAGING_DATABASE, databaseVerified: Boolean(id), upstream: IMAGE_UPSTREAM_WORKER, ingress: 'closed', deployed: false }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
