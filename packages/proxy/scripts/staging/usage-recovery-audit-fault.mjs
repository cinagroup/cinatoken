// Operator-side fault artifact, never imported by a Worker or a production migration.
import assert from 'node:assert/strict';

export function recoveryAuditFault(fixture) {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  assert.match(fixture.id, new RegExp('^staging-recovery-' + uuid + '$'));
  assert.equal(fixture.userId, fixture.id + '-user');
  assert.equal(fixture.keyId, fixture.id + '-key');
  assert.equal(fixture.cases.length, 3);
  const target = fixture.cases[1];
  assert.match(target.requestId, new RegExp('^gen-' + uuid + '$'));
  assert.equal(target.cost, 0.1);
  // SQLite does not accept bound parameters in CREATE TRIGGER. These values have
  // exact UUID-only grammars above; no caller SQL/name/body can enter this DDL.
  const name = 'staging_recovery_audit_fault_' + fixture.id.slice('staging-recovery-'.length).replaceAll('-', '');
  const create = `CREATE TRIGGER ${name} BEFORE INSERT ON user_audit_logs
WHEN NEW.request_log_id='${target.requestId}' AND NEW.user_id='${fixture.userId}' AND NEW.api_key_id='${fixture.keyId}'
BEGIN SELECT RAISE(ABORT,'staging_recovery_audit_fault'); END`;
  return Object.freeze({ name, targetRequestId: target.requestId, create, drop: `DROP TRIGGER ${name}` });
}

// A whole-schema readback is used only by the operator, outside the consumer's
// four-table recovery contract. Keep the baseline and compare every definition.
export const RECOVERY_FAULT_SCHEMA_QUERY = "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY LIMIT 513";
export function assertRecoveryFaultSchema(before, after, fault, installed) {
  assert.ok(before.length > 24 && before.length < 512);
  assert.ok(before.every(row => row.name !== fault.name));
  const expected = installed ? [...before, { type:'trigger', name:fault.name, tbl_name:'user_audit_logs', sql:fault.create }] : before;
  const order = (a,b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  assert.deepEqual(after, [...expected].sort(order));
}
