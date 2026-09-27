import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSqliteD1 } from '../../src/test-support/sqlite-d1.ts';
import { createWorkerApp } from '../../src/runtime/workers.ts';
import { drainNodeBackgroundWork } from '../../src/runtime/schedule-background-work.ts';
import { imageSuccessFixture } from '../../../../scripts/deploy/staging-image-success-fixture.mjs';
import { MiB, referenceJsonWire, fullMultipartWire, expectedReferenceUpload, expectedMultipartUpload, parseUploadReceipt, expectedNormalizedResponse } from '../../../../scripts/deploy/staging-image-large-wire.mjs';
import upstream from './images-upstream.ts';

test('large synthetic wires traverse real SQL repositories and match independent upstream and response fingerprints', async t => {
  await new Promise(resolve => setImmediate(resolve));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Native network forbidden'); });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const db = createSqliteD1(), key = 'synthetic-large-client-only';
  const fixture = await imageSuccessFixture('c02-success-bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'sha256:' + createHash('sha256').update(key).digest('hex'), new Date(Date.now() + 3600000).toISOString(), { includeLimitEdits: true });
  const env = { DB: db.binding, DATABASE_DRIVER: 'd1', SHARED_KEY_ENCRYPTION_SECRET: 'synthetic-encryption-material-not-for-real-secrets', REQUEST_BODY_LOGGING: 'off', BATCH_API_ENABLED: 'false' };
  let sends = 0;
  const app = createWorkerApp({ imageFetch: async (input, init) => { sends++; return upstream.fetch(new Request(input, init)); } });
  try {
    assert.equal(fixture.seed.length, 31);
    for (const s of fixture.seed) db.sqlite.prepare(s.sql).run(...s.params);
    const catalog = await app.request('/v1/models?kind=image', { headers: { Authorization: 'Bearer ' + key } }, env);
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json()).data.map(m => m.id).sort(), [...fixture.ids.models].sort());
    for (const [caseKey, bytes] of [['small-generations', 4096], ['limit-generations', 50 * MiB], ['replacement-generations', 50 * MiB], ['limit-edits', 50 * MiB]]) {
      const model = fixture.cases[caseKey].model, mode = caseKey.split('-')[0], edits = caseKey.endsWith('-edits');
      const wire = edits ? fullMultipartWire(model, bytes) : referenceJsonWire(model, bytes);
      const response = await app.request('/v1/images/' + (edits ? 'edits' : 'generations'), {
        method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': wire.type },
        body: ReadableStream.from(wire.chunks()), duplex: 'half',
      }, env);
      assert.equal(response.status, 200, caseKey);
      const hash = createHash('sha256'); let received = 0;
      for await (const chunk of response.body) { received += chunk.length; assert.ok(received <= 97 * MiB); hash.update(chunk); }
      assert.deepEqual({ bytes: received, sha256: hash.digest('hex') }, expectedNormalizedResponse(mode), caseKey);
      await drainNodeBackgroundWork();
      const log = db.sqlite.prepare('SELECT * FROM api_key_request_logs WHERE id=? AND api_key_id=?').get(response.headers.get('X-Generation-Id'), fixture.ids.key);
      assert.ok(log, caseKey);
      const receipt = parseUploadReceipt(log.upstream_request_id);
      assert.equal(receipt.mode, mode);
      assert.ok(log.upstream_request_id.length <= 200);
      assert.deepEqual({ bytes: receipt.bytes, sha256: receipt.sha256 }, edits ? expectedMultipartUpload(wire, receipt.boundary) : expectedReferenceUpload(wire));
      for (const field of ['charged_cost', 'metered_cost', 'standard_cost', 'budget_charged_micros']) assert.equal(log[field], 0);
      assert.equal(log.status, 'success'); assert.equal(log.upstream_attempt_count, 1);
      assert.equal(log.input_image_count, edits ? 3 : 1); assert.equal(log.output_image_count, 1);
      assert.equal(log.request_body, null); assert.equal(log.upstream_request_body, null);
      assert.ok(log.raw_usage.length <= 128);
    }
    assert.equal(sends, 4); assert.deepEqual(errors, []);
  } finally {
    await drainNodeBackgroundWork();
    for (const s of fixture.cleanup) db.sqlite.prepare(s.sql).run(...s.params);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id=?').get(fixture.ids.key).n, 0);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    db.sqlite.close();
  }
});
