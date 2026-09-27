import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  buildSharedKeyUsageRepairDirectLoginGrant,
  SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION,
  SHARED_KEY_USAGE_REPAIR_ROLE,
  type SharedKeyUsageRepairLoginGrantInput,
} from './build-shared-key-usage-repair-direct-login-grant';

function verifier(iterations = 32768): string {
  return `SCRAM-SHA-256$${iterations}:${randomBytes(20).toString('base64')}` +
    `$${randomBytes(32).toString('base64')}:${randomBytes(32).toString('base64')}`;
}
function input(overrides: Record<string, unknown> = {}): SharedKeyUsageRepairLoginGrantInput {
  return { activation: SHARED_KEY_USAGE_REPAIR_LOGIN_ACTIVATION,
    role: SHARED_KEY_USAGE_REPAIR_ROLE, database: 'postgres',
    scramVerifier: verifier(), roleConnectionLimit: 2, ...overrides } as SharedKeyUsageRepairLoginGrantInput;
}

test('repair LOGIN SQL is pinned, two-phase, fixed identity and exact-function grant', async () => {
  const request = input();
  const plan = await buildSharedKeyUsageRepairDirectLoginGrant(request);
  assert.equal(plan.role, SHARED_KEY_USAGE_REPAIR_ROLE);
  assert.equal(plan.runtimeCompatible, false);
  assert.equal(plan.verifierSha256,
    createHash('sha256').update(request.scramVerifier).digest('hex'));
  assert.match(plan.proposalSha256, /^[a-f0-9]{64}$/u);
  assert.match(plan.isolationProposalSha256, /^[a-f0-9]{64}$/u);
  assert.match(plan.claimProposalSha256, /^[a-f0-9]{64}$/u);
  assert.match(plan.adminSql, /LOGIN NOINHERIT NOSUPERUSER/u);
  assert.match(plan.adminSql, /transaction_timeout TO 30000/u);
  assert.match(plan.migratorSql,
    /GRANT EXECUTE ON FUNCTION cinatoken_gateway\.claim_one_shared_key_usage_repair\(\)/u);
  assert.match(plan.migratorSql,
    /GRANT EXECUTE ON FUNCTION cinatoken_gateway\.finish_claimed_shared_key_usage_repair\(text,uuid\)/u);
  assert.doesNotMatch(plan.migratorSql,
    /GRANT EXECUTE ON FUNCTION cinatoken_gateway\.attempt_one_shared_key_usage_repair\(\)/u);
  assert.doesNotMatch(plan.migratorSql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE) ON TABLE/u);
  assert.doesNotMatch(plan.migratorSql, /GRANT EXECUTE ON FUNCTION cinatoken_gateway\.enqueue_shared_key_usage_repair/u);
  assert.doesNotMatch(plan.migratorSql, /GRANT EXECUTE ON FUNCTION cinatoken_gateway\.repair_one_shared_key_usage/u);
  assert.doesNotMatch(plan.migratorSql, /GRANT EXECUTE ON FUNCTION cinatoken_gateway\.requeue_shared_key_usage_repair_dead_letter/u);
  assert.ok(plan.adminSql.includes(request.scramVerifier));
  assert.ok(!plan.migratorSql.includes(request.scramVerifier));
});

test('repair LOGIN input rejects arbitrary identities, unbounded connections and weak verifier', async () => {
  for (const override of [
    { activation: 'on' }, { role: 'cinatoken_gateway_runtime' },
    { database: 'postgres; DROP DATABASE postgres' },
    { roleConnectionLimit: 0 }, { roleConnectionLimit: 11 },
    { scramVerifier: 'password' }, { scramVerifier: verifier(4096) },
    { scramVerifier: verifier().replace('SCRAM-SHA-256', 'SCRAM-SHA-1') },
  ]) await assert.rejects(buildSharedKeyUsageRepairDirectLoginGrant(input(override) as never),
    /Explicit reviewed repair LOGIN contract required|Strong SCRAM verifier required/u);
});
