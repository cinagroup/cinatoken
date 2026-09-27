import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import worker from './complete-text-response-holder-worker-v394.ts';

test('response evidence entry bundles independently with disabled private bindings', async () => {
  const config = JSON.parse(await readFile(new URL('../../wrangler.complete-text-response-holder-v394.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.COMPLETE_TEXT_HOLDER_ENABLED, 'disabled');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.triggers, { crons: [] });
  assert.deepEqual(config.secrets, { required: ['PROVIDER_KEY_ENCRYPTION_SECRET'] });
  assert.deepEqual(config.hyperdrive.map(binding => binding.binding), [
    'COMPLETE_TEXT_READER', 'COMPLETE_TEXT_GRANTER', 'COMPLETE_TEXT_HOLDER', 'COMPLETE_TEXT_RENEWER',
  ]);
  for (const key of ['services', 'queues', 'd1_databases', 'r2_buckets', 'assets']) assert.equal(config[key], undefined);
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./complete-text-response-holder-worker-v394.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', metafile: true,
    conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*', ...builtinModules] });
  assert.ok(!Object.keys(bundle.metafile.inputs).some(file => /proxy\/src\/(app\.ts|runtime\/workers\.ts|routes\/)/u.test(file)));
  assert.match(bundle.outputFiles[0].text, /append_complete_text_response_observation_v392/u);
});

test('disabled response evidence entry cancels the upload without reading credentials or opening SQL', async () => {
  let cancelled = 0;
  const tasks = [];
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const env = { COMPLETE_TEXT_HOLDER_ENABLED: 'disabled',
    get COMPLETE_TEXT_READER() { throw new Error('unexpected database access'); },
    get PROVIDER_KEY_ENCRYPTION_SECRET() { throw new Error('unexpected credential access'); } };
  const response = await worker.fetch(new Request('https://holder.service.invalid/complete-text-attempt', {
    method: 'POST', body, duplex: 'half',
  }), env, { waitUntil(task) { tasks.push(task); } });
  assert.equal(response.status, 503);
  await Promise.all(tasks);
  assert.equal(cancelled, 1);
  assert.deepEqual(await response.json(), { error: 'holder_request_unavailable' });
});
