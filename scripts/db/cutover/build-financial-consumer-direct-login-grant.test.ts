import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  assertStrongFinancialScramVerifier, buildFinancialConsumerDirectLoginGrant,
  FINANCIAL_CONSUMER_GRANT_ACTIVATION, FINANCIAL_CONSUMER_ROLE,
} from './build-financial-consumer-direct-login-grant';
import { RECOVERY_FUNCTION_GRANTS, RECOVERY_TABLE_GRANTS } from './postgres-recovery-role-policy';
import { REPLAY_PARENT_GATE_TRIGGERS, REPLAY_RESERVATION_TRIGGERS } from './postgres-recovery-role-policy';

function verifier(iterations = 32768): string {
  return `SCRAM-SHA-256$${iterations}:${randomBytes(20).toString('base64')}` +
    `$${randomBytes(32).toString('base64')}:${randomBytes(32).toString('base64')}`;
}
function input(overrides: Record<string, unknown> = {}) {
  return {
    activation: FINANCIAL_CONSUMER_GRANT_ACTIVATION,
    role: FINANCIAL_CONSUMER_ROLE, database: 'gateway_review',
    roleConnectionLimit: 2, scramVerifier: verifier(), ...overrides,
  } as Parameters<typeof buildFinancialConsumerDirectLoginGrant>[0];
}

test('disabled by default and rejects an unreviewed identity, database or capacity', async () => {
  for (const replacement of [
    { activation: undefined }, { activation: 'reviewed-v1' },
    { role: 'cinatoken_gateway_recovery' }, { role: undefined },
    { database: 'gateway_review;DROP DATABASE postgres' }, { database: '' },
    { roleConnectionLimit: 0 }, { roleConnectionLimit: 11 },
    { replayReservationPhase: 'expanded' },
  ]) {
    await assert.rejects(buildFinancialConsumerDirectLoginGrant(input(replacement)));
  }
});

test('accepts only a canonical high-work-factor SCRAM verifier and never accepts plaintext', () => {
  const good = verifier();
  assert.equal(assertStrongFinancialScramVerifier(good), good);
  for (const bad of [
    'passw0rd', `SCRAM-SHA-256$4096:${randomBytes(20).toString('base64')}` +
      `$${randomBytes(32).toString('base64')}:${randomBytes(32).toString('base64')}`,
    verifier(1_000_001), verifier().replace('SCRAM-SHA-256', 'SCRAM-SHA-1'),
    `SCRAM-SHA-256$32768:${randomBytes(8).toString('base64')}` +
      `$${randomBytes(32).toString('base64')}:${randomBytes(32).toString('base64')}`,
    verifier() + '\nDROP ROLE x;',
  ]) assert.throws(() => assertStrongFinancialScramVerifier(bad));
});

test('emits two controlled transactional phases, fixed least grants and catalog audits', async () => {
  const request = input();
  const plan = await buildFinancialConsumerDirectLoginGrant(request);
  assert.equal(plan.role, FINANCIAL_CONSUMER_ROLE);
  assert.equal(plan.runtimeCompatible, false);
  assert.equal(plan.replayReservationPhase, 'none');
  assert.equal(plan.verifierSha256, createHash('sha256').update(request.scramVerifier).digest('hex'));
  assert.equal((plan.adminSql.match(/\bBEGIN;/g) ?? []).length, 1);
  assert.equal((plan.migratorSql.match(/\bBEGIN;/g) ?? []).length, 1);
  assert.match(plan.adminSql, /CREATE ROLE cinatoken_gateway_financial_recovery_consumer LOGIN NOINHERIT/);
  assert.match(plan.adminSql, /pg_catalog\.pg_authid/);
  assert.match(plan.adminSql, /pg_catalog\.pg_auth_members/);
  assert.match(plan.adminSql, /SET transaction_timeout TO 30000/);
  assert.match(plan.adminSql, /SET statement_timeout TO 15000/);
  assert.match(plan.adminSql, /SET lock_timeout TO 5000/);
  assert.match(plan.adminSql, /SET idle_in_transaction_session_timeout TO 10000/);
  assert.ok(plan.adminSql.includes(request.scramVerifier));
  assert.ok(!plan.migratorSql.includes(request.scramVerifier));
  assert.match(plan.migratorSql, /pg_catalog\.has_column_privilege/);
  assert.match(plan.migratorSql, /pg_catalog\.has_function_privilege/);
  assert.match(plan.migratorSql, /request_usage_commit_transaction_check/);
  for (const grant of RECOVERY_TABLE_GRANTS) {
    for (const verb of grant.privileges) {
      assert.ok(plan.migratorSql.includes(`GRANT ${grant.privileges.join(', ')} ON TABLE cinatoken_gateway.${grant.table} TO ${FINANCIAL_CONSUMER_ROLE};`), verb);
    }
    if ('selectColumns' in grant && grant.selectColumns.length) {
      assert.ok(plan.migratorSql.includes(`GRANT SELECT (${grant.selectColumns.join(', ')}) ON TABLE cinatoken_gateway.${grant.table} TO ${FINANCIAL_CONSUMER_ROLE};`));
    }
    if (grant.updateColumns.length) {
      assert.ok(plan.migratorSql.includes(`GRANT UPDATE (${grant.updateColumns.join(', ')}) ON TABLE cinatoken_gateway.${grant.table} TO ${FINANCIAL_CONSUMER_ROLE};`));
    }
  }
  for (const signature of RECOVERY_FUNCTION_GRANTS) {
    assert.ok(plan.migratorSql.includes(`GRANT EXECUTE ON FUNCTION cinatoken_gateway.${signature} TO ${FINANCIAL_CONSUMER_ROLE};`));
  }
  assert.doesNotMatch(plan.migratorSql, /GRANT (?:ALL|DELETE|TRUNCATE|CREATE)|ON ALL (?:TABLES|FUNCTIONS|SEQUENCES)|ALTER DEFAULT PRIVILEGES/);
  assert.doesNotMatch(plan.migratorSql, /GRANT (?:SELECT|INSERT|UPDATE) ON TABLE cinatoken_gateway\.api_keys/);
  assert.match(plan.migratorSql, /requires explicit parent-gated replay phase/);
});

test('explicit gated replay plan audits exact optional triggers and pinned functions without granting them', async () => {
  const plan = await buildFinancialConsumerDirectLoginGrant(input({ replayReservationPhase: 'parent-gated' }));
  assert.equal(plan.replayReservationPhase, 'parent-gated');
  for (const [, name] of [...REPLAY_RESERVATION_TRIGGERS, ...REPLAY_PARENT_GATE_TRIGGERS]) {
    assert.ok(plan.migratorSql.includes(name), name);
  }
  for (const name of [
    'guard_request_dispatch_replay_insert', 'reject_request_dispatch_replay_mutation',
    'reserve_request_dispatch_intent_id', 'reserve_request_log_replay_id',
    'guard_request_log_replay_id_update',
    'reserve_request_dispatch_parent_id',
  ]) {
    assert.ok(plan.migratorSql.includes(`cinatoken_gateway.${name}()`), name);
    assert.ok(!plan.migratorSql.includes(`GRANT EXECUTE ON FUNCTION cinatoken_gateway.${name}()`), name);
  }
  assert.match(plan.migratorSql, /pg_catalog\.md5\(pg_catalog\.replace\(p\.prosrc/);
  assert.match(plan.migratorSql, /replay tombstone relation or ACL differs/);
  assert.match(plan.migratorSql, /replay trigger function ACL differs/);
  assert.doesNotMatch(plan.migratorSql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE) ON TABLE cinatoken_gateway\.request_dispatch_replay_tombstones/);
});
