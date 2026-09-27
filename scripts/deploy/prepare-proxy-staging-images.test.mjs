import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonc } from './prepare-proxy-staging.mjs';
import { imagesStagingConfig, imagesRecoveryStagingConfig, imagesFencingStagingConfig, IMAGE_UPSTREAM_WORKER } from './prepare-proxy-staging-images.mjs';
import { fileURLToPath } from 'node:url';
const source = readJsonc(fileURLToPath(new URL('../../packages/proxy/wrangler.staging.base.jsonc', import.meta.url)));
const production = readJsonc(fileURLToPath(new URL('../../packages/proxy/wrangler.base.jsonc', import.meta.url)));
test('private Images composition changes only the explicit main and service binding', () => {
  const before = structuredClone(source), result = imagesStagingConfig(source, production);
  const { main, services, ...unchanged } = result;
  assert.deepEqual(source, before);
  assert.equal(main, 'scripts/staging/images-gateway.ts');
  assert.deepEqual(services, [{ binding: 'IMAGE_UPSTREAM', service: IMAGE_UPSTREAM_WORKER }]);
  assert.deepEqual(unchanged, Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'main')));
  assert.throws(() => imagesStagingConfig({ ...source, workers_dev: true }, production));
  assert.throws(() => imagesStagingConfig({ ...source, services: [{ binding: 'IMAGE_UPSTREAM', service: 'production' }] }, production));
});
test('recovery composition changes only the explicit entry, retains isolation and no consumer capability', () => {
  const before = structuredClone(source), legacy = imagesStagingConfig(source, production);
  const result = imagesRecoveryStagingConfig(source, production);
  assert.deepEqual(source, before);
  assert.deepEqual(result, { ...legacy, main: 'scripts/staging/images-recovery-gateway.ts' });
  assert.equal(imagesStagingConfig(source, production).main, 'scripts/staging/images-gateway.ts');
  for (const patch of [{ workers_dev: true }, { preview_urls: true }, { services: [{ binding: 'USAGE_RECOVERY', service: 'production' }] }]) {
    assert.throws(() => imagesRecoveryStagingConfig({ ...source, ...patch }, production));
  }
});
test('short-lease fencing candidate changes only its explicit entry and cannot expand staging capabilities',()=>{
  const before=structuredClone(source),normal=imagesRecoveryStagingConfig(source,production),result=imagesFencingStagingConfig(source,production);
  assert.deepEqual(result,{...normal,main:'scripts/staging/images-fencing-gateway.ts'});assert.deepEqual(source,before);
  for(const patch of [{workers_dev:true},{preview_urls:true},{services:[{binding:'USAGE_RECOVERY',service:'production'}]}])assert.throws(()=>imagesFencingStagingConfig({...source,...patch},production));
});
