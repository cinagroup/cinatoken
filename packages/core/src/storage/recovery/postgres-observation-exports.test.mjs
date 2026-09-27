import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('PostgreSQL recovery observation is a type-only package export', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  const entry = packageJson.exports['./storage/recovery/postgres-observation-types'];
  assert.deepEqual(entry, { types: './src/storage/recovery/postgres-observation-types.ts' });
  assert.equal(Object.hasOwn(packageJson.exports, './storage/recovery/postgres-recovery-operation-owner'), false);
  assert.equal(Object.hasOwn(packageJson.exports, './storage/recovery/run-usage-recovery-postgres'), false);
  await assert.rejects(import('@octafuse/core/storage/recovery/postgres-observation-types'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
});
