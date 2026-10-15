import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedGatewayKeyRow } from '@octafuse/core';
import { expectedAdminKeyProfile, planAdminKeyPatch } from './admin-key-atomic';
import { gatewayKeyRevision } from './gateway-key-contract';
const row = { id: 'key-1', user_id: 'user-1', workspace_id: 'personal:user-1', name: 'Key', status: 'active', metadata: null, rate_limit: { rpm: 7 }, rate_limit_raw: '{ "rpm": 7 }' } as ResolvedGatewayKeyRow;
test('rate limits participate in exact raw CAS and profile revisions', async () => {
 assert.equal(expectedAdminKeyProfile(row).rateLimit, '{ "rpm": 7 }');
 const plan = planAdminKeyPatch(row, { rate_limit: { rpm: 11 } });
 assert.equal(plan.patch.rateLimit, '{"rpm":11}'); assert.equal(plan.after.rateLimit, '{"rpm":11}'); assert.equal(plan.rateLimitChanged, true);
 const revision = await gatewayKeyRevision(row);
 assert.notEqual(await gatewayKeyRevision({ ...row, rate_limit_raw: '{"rpm":7}' }), revision);
 assert.notEqual(await gatewayKeyRevision({ ...row, rate_limit: { rpm: 11 }, rate_limit_raw: '{"rpm":11}' }), revision);
 assert.equal(planAdminKeyPatch(row, { rate_limit: null }).patch.rateLimit, null);
 assert.equal(planAdminKeyPatch(row, { name: 'New' }).patch.rateLimit, undefined);
 assert.throws(() => planAdminKeyPatch(row, { rate_limit: { rpm: -1 } }));
});
