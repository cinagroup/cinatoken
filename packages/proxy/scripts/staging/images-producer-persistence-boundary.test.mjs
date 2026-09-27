import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { producerFixture, boundaryProfiles, exactAuditPlan, assertSettled, assertUnconfirmed } from './images-producer-boundary-fixture.mjs';

const modes = ['before-insert', 'insert-ack-lost', 'readback-only-unavailable', 'insert-ack-and-readback-unavailable', 'job-readback-unavailable'];
const plain = value => JSON.parse(JSON.stringify(value));
async function planFor(t, operation, profile) {
  const base = await producerFixture(t);
  try {
    assert.equal((await base.request(operation, 'a')).status, 200);
    const snapshot = await base.snapshot(); assertSettled(base, snapshot);
    return exactAuditPlan(snapshot.value.params.requestLog.pricingAudit, profile);
  } finally { await base.close(); }
}

for (const operation of ['generations', 'edits']) for (const profile of Object.keys(boundaryProfiles)) for (const mode of modes) {
  test(`${operation}/${profile}: 65536-byte pricing audit persistence ${mode}`, async t => {
    const plan = await planFor(t, operation, profile);
    let armed = true, inserted = false, writesAttempted = 0, faults = 0, captured;
    const f = await producerFixture(t, { ...plan, hooks: {
      beforeStatement(sql, values) {
        if (sql.startsWith('INSERT INTO request_usage_settlements')) {
          writesAttempted++;
          assert.equal(values.length, 12);
          assert.equal(typeof values[9], 'string'); assert.equal(typeof values[10], 'string');
          captured = { payload_json: values[9], payload_sha256: values[10] };
          if (armed && mode === 'before-insert') { faults++; throw Error('Synthetic pre-insert failure'); }
        }
        if (!armed || !inserted) return;
        if ((mode === 'readback-only-unavailable' || mode === 'insert-ack-and-readback-unavailable')
          && sql.startsWith('SELECT * FROM request_usage_settlements')) {
          faults++; throw Error('Synthetic snapshot readback unavailable');
        }
        if (mode === 'job-readback-unavailable' && sql.startsWith('SELECT * FROM request_usage_recovery_jobs')) {
          faults++; throw Error('Synthetic enqueue readback unavailable');
        }
      },
      afterStatement(sql) {
        if (sql.startsWith('INSERT INTO request_usage_settlements')) {
          inserted = true;
          if (armed && (mode === 'insert-ack-lost' || mode === 'insert-ack-and-readback-unavailable')) {
            faults++; throw Error('Synthetic persisted snapshot ACK loss');
          }
        }
      },
    } });
    const response = await f.request(operation, plan.quality);
    assert.equal(writesAttempted, 1); assert.ok(faults > 0); assert.equal(f.sends, 1);
    const capturedValue = await decodeUsageSettlement(captured.payload_json, captured.payload_sha256);
    assert.equal(Buffer.byteLength(capturedValue.params.requestLog.pricingAudit), 65536);
    assert.equal(capturedValue.params.requestLog.requestOperation, 'images.' + operation);
    assert.ok(Buffer.byteLength(captured.payload_json) <= 262144);
    if (profile === 'escaped') assert.ok(Buffer.byteLength(captured.payload_json) > 130000);
    const absent = mode === 'before-insert', reconciled = mode === 'insert-ack-lost';
    assert.equal(inserted, !absent);
    assert.equal(response.status, reconciled ? 200 : 503);
    if (reconciled) assert.equal(response.body.data[0].b64_json, 'AQID');
    else {
      assert.equal(response.body.code, 'gateway.image_settlement_unconfirmed');
      assert.equal(response.body.error.metadata.retry_safe, false);
      assert.equal(response.body.error.metadata.outcome_unknown, true);
    }
    assert.equal(f.row('SELECT state FROM request_dispatch_intents').state, 'dispatch_claimed');
    const beforeCounts = f.counts();
    for (const [table, n] of Object.entries(beforeCounts)) {
      const expected = table === 'request_dispatch_intents' ? 1
        : ['request_usage_settlements', 'request_usage_recovery_jobs'].includes(table) ? Number(!absent) : Number(reconciled);
      assert.equal(n, expected, table);
    }
    assert.deepEqual(f.account(), { budget_spent_micros: reconciled ? 100000 : 0, budget_reserved_micros: reconciled ? 0 : 100000 });
    assert.deepEqual(plain(f.row('SELECT state,reserved_micros,settled_micros FROM user_budget_reservations')),
      { state: reconciled ? 'settled' : 'dispatched', reserved_micros: 100000, settled_micros: reconciled ? 100000 : 0 });
    const stored = absent ? null : await f.snapshot();
    if (stored) {
      assert.equal(stored.payload_json, captured.payload_json); assert.equal(stored.payload_sha256, captured.payload_sha256);
      assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state, reconciled ? 'committed' : 'pending');
    }
    // Change only the isolated fixture after dispatch. Recovery must use immutable facts,
    // never current tariff, an invented fallback snapshot, or another provider request.
    for (const endpoint of f.fixture.ids.endpoints) f.db.sqlite.prepare("UPDATE model_endpoints SET image_capabilities='{}' WHERE id=?").run(endpoint);
    armed = false;
    const recovery = await f.recover();
    assert.equal(recovery.committed, !absent && !reconciled ? 1 : 0);
    if (absent) {
      assertUnconfirmed(f, response);
      assert.ok(Object.values(recovery).every(v => v === 0 || v === false));
    } else {
      assert.deepEqual(await f.snapshot(), stored); assertSettled(f, stored);
      assert.deepEqual(plain(f.row('SELECT state,reserved_micros,settled_micros FROM user_budget_reservations')),
        { state: 'settled', reserved_micros: 100000, settled_micros: 100000 });
    }
    const final = { counts: f.counts(), account: f.account() };
    assert.ok(Object.values(await f.recover()).every(v => v === 0 || v === false));
    assert.deepEqual({ counts: f.counts(), account: f.account() }, final);
    assert.equal(f.sends, 1); assert.equal(writesAttempted, 1);
    t.diagnostic(JSON.stringify({ operation, profile, mode, status: response.status, faults, writesAttempted,
      auditBytes: 65536, snapshotBytes: Buffer.byteLength(captured.payload_json), persisted: !absent,
      recovered: recovery.committed, sendsIncludingBaseline: 2 }));
  });
}
