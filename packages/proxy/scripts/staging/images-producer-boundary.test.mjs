import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeUsageSettlement } from '../../../core/src/storage/recovery/usage-settlement-codec.ts';
import { producerFixture, boundaryProfiles, exactAuditPlan, assertSettled, assertUnconfirmed } from './images-producer-boundary-fixture.mjs';

async function baseline(t, operation) {
  const f = await producerFixture(t);
  try {
    assert.equal((await f.request(operation, 'a')).status, 200);
    const snapshot = await f.snapshot(); assertSettled(f, snapshot);
    return snapshot.value.params.requestLog.pricingAudit;
  } finally { await f.close(); }
}
async function unchangedRecovery(f) {
  const before = { counts: f.counts(), account: f.account() };
  assert.ok(Object.values(await f.recover()).every(value => value === 0 || value === false));
  assert.deepEqual({ counts: f.counts(), account: f.account() }, before);
  assert.equal(f.sends, 1);
}

for (const operation of ['generations', 'edits']) {
  for (const profile of Object.keys(boundaryProfiles)) {
    test(`${operation}/${profile}: exact pricingAudit 65536 accepted, 65537 rejected`, async t => {
      const plan = exactAuditPlan(await baseline(t, operation), profile);
      const accepted = await producerFixture(t, plan);
      assert.equal((await accepted.request(operation, plan.quality)).status, 200);
      const snapshot = await accepted.snapshot();
      assert.equal(Buffer.byteLength(snapshot.value.params.requestLog.pricingAudit), 65536);
      assertSettled(accepted, snapshot); await unchangedRecovery(accepted);
      const mutated = structuredClone(snapshot.value);
      const audit = JSON.parse(mutated.params.requestLog.pricingAudit); audit.quality += 'a';
      mutated.params.requestLog.pricingAudit = JSON.stringify(audit);
      assert.equal(Buffer.byteLength(mutated.params.requestLog.pricingAudit), 65537);
      // Direct codec oracle; the rejected route DTO is not observable in durable storage.
      await assert.rejects(encodeUsageSettlement(mutated), TypeError);
      const rejected = await producerFixture(t, plan);
      assertUnconfirmed(rejected, await rejected.request(operation, plan.quality + 'a'));
      await unchangedRecovery(rejected);
      t.diagnostic(JSON.stringify({ operation, profile, auditBytes: 65536, snapshotBytes: Buffer.byteLength(snapshot.payload_json),
        rejectedAuditBytes: 65537, rejectedRouteSizeBasis: 'accepted producer + single quality byte; direct codec oracle', sends: 3 }));
    });
  }

  for (const profile of Object.keys(boundaryProfiles)) {
    test(`${operation}/${profile}: retained providerName UTF-8 512 accepted, 513 rejected`, async t => {
      const unit = boundaryProfiles[profile];
      const unitBytes = Buffer.byteLength(unit);
      const name = unit.repeat(Math.floor(512 / unitBytes)) + 'a'.repeat(512 % unitBytes);
      assert.equal(Buffer.byteLength(name), 512);
      const accepted = await producerFixture(t, { providerName: name });
      assert.equal((await accepted.request(operation)).status, 200);
      const snapshot = await accepted.snapshot();
      assert.equal(snapshot.value.params.requestLog.providerName, name);
      assertSettled(accepted, snapshot); await unchangedRecovery(accepted);
      const rejected = await producerFixture(t, { providerName: name + 'a' });
      assertUnconfirmed(rejected, await rejected.request(operation)); await unchangedRecovery(rejected);
      t.diagnostic(JSON.stringify({ operation, profile, retainedField: 'providerName', acceptedBytes: 512, rejectedBytes: 513, sends: 2 }));
    });
  }

  for (const mode of ['before-ledger', 'ledger-ack-lost', 'lease-ack-lost']) {
    test(`${operation}/escaped: 65536-byte audit survives ${mode} without repricing or duplicate charge`, async t => {
      const plan = exactAuditPlan(await baseline(t, operation), 'escaped');
      let fault = true;
      const f = await producerFixture(t, { ...plan, hooks: {
        beforeStatement(sql) { if (fault && mode === 'before-ledger' && sql.startsWith('INSERT INTO api_key_request_logs')) throw Error('Synthetic accounting unavailable'); },
        afterStatement(sql) { if (fault && mode === 'lease-ack-lost' && sql.startsWith('UPDATE request_usage_recovery_jobs SET') && sql.includes('attempts=MIN')) throw Error('Synthetic claim ACK loss'); },
        afterBatch(sql) { if (fault && mode === 'ledger-ack-lost' && sql.some(s => s.startsWith('INSERT INTO api_key_request_logs'))) throw Error('Synthetic committed batch ACK loss'); },
      } });
      assert.equal((await f.request(operation, plan.quality)).status, 200);
      const before = await f.snapshot();
      assert.equal(Buffer.byteLength(before.value.params.requestLog.pricingAudit), 65536);
      assert.ok(Buffer.byteLength(before.payload_json) > 130000);
      const already = mode === 'ledger-ack-lost';
      assert.equal(f.row('SELECT state FROM request_usage_recovery_jobs').state, already ? 'committed' : mode === 'lease-ack-lost' ? 'leased' : 'pending');
      assert.equal(f.counts().request_usage_commit_receipts, already ? 1 : 0);
      assert.deepEqual(f.account(), { budget_spent_micros: already ? 100000 : 0, budget_reserved_micros: already ? 0 : 100000 });
      // Change only this isolated fixture's tariff after durable acceptance.
      for (const endpoint of f.fixture.ids.endpoints) f.db.sqlite.prepare("UPDATE model_endpoints SET image_capabilities='{}' WHERE id=?").run(endpoint);
      fault = false; f.advance(11);
      assert.equal((await f.recover()).committed, already ? 0 : 1);
      assert.deepEqual(await f.snapshot(), before); assertSettled(f, before); await unchangedRecovery(f);
      t.diagnostic(JSON.stringify({ operation, mode, auditBytes: 65536, snapshotBytes: Buffer.byteLength(before.payload_json), sends: 2 }));
    });
  }
}
