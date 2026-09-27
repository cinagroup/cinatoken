import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildRequestLegacyParentActivation } from './build-request-legacy-parent-activation.mjs';

const variant = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-legacy-parent-backfill.sql', import.meta.url);

test('legacy-aware parent SQL matches its pinned generator and preserves private function gates', async () => {
  const generated = await buildRequestLegacyParentActivation();
  assert.equal(generated.sourceSha256,
    '2e8c20088f72271ecf89bc4f43583ec3b2247893a11b84cc6a220563a72de8de');
  assert.equal(await readFile(variant, 'utf8'), generated.sql);
  assert.match(generated.sql, /Legacy request replay reservation backfill is incomplete/);
  assert.match(generated.sql, /Direct dispatch intent writer privilege remains/);
  assert.match(generated.sql, /Direct dispatch intent column writer privilege remains/);
  assert.match(generated.sql, /Legacy active dispatch intents must drain before parent switch/);
  assert.match(generated.sql, /CREATE FUNCTION cinatoken_gateway\.prepare_request_dispatch_intent_v1/);
  assert.match(generated.sql, /REVOKE ALL ON FUNCTION cinatoken_gateway\.prepare_request_dispatch_intent_v1/);
  assert.match(generated.sql, /FROM cinatoken_gateway_runtime/);
  assert.doesNotMatch(generated.sql, /Existing dispatch intents need separately reviewed request backfill/);
});
