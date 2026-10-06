import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createCatalogFixtureServer } from 'file:///C:/cinagroup/cinatoken/docker/web/fixtures/catalog-server.mjs';
import { publicCatalogHttpFixture } from 'file:///C:/cinagroup/cinatoken/packages/web/src/cinatoken/public-server/public-http.fixture.ts';
import { catalogModelsSchema, catalogDetailSchema, catalogProvidersSchema, catalogStatsSchema } from 'file:///C:/cinagroup/cinatoken/packages/web/src/cinatoken/public/catalog-contracts.ts';

const fixture = createCatalogFixtureServer();
fixture.server.listen(0, '127.0.0.1');
await once(fixture.server, 'listening');
const origin = `http://127.0.0.1:${fixture.server.address().port}`;
async function read(path, options = {}) { return fetch(origin + path, { signal: AbortSignal.timeout(2000), ...options }); }
try {
 await test('Nonempty GET catalog HTTP bytes match existing authority fixture and production schemas', async () => {
  for (const [path, schema] of [
   ['/api/public/catalog/models', catalogModelsSchema],
   ['/api/public/catalog/model/Vendor/http-fixture', catalogDetailSchema],
   ['/api/public/catalog/providers', catalogProvidersSchema],
   ...['7d', '30d', '90d'].map(range => [`/api/public/catalog/stats/models?range=${range}`, catalogStatsSchema]),
  ]) {
   const response = await read(path, { headers: { accept: 'application/json' } });
   assert.equal(response.status, 200);
   const value = await response.json();
   assert.deepEqual(value, publicCatalogHttpFixture(path));
   const parsed = schema.parse(value);
   assert.equal(Array.isArray(parsed.data) ? parsed.data.length : 1, 1);
  }
  assert.equal(fixture.requests.length, 6);
  assert.deepEqual(fixture.violations, []);
 });
 await test('HEAD is bodyless; specific model absence and outage preserve status/Retry-After', async () => {
  const response = await read('/api/public/catalog/models', { method: 'HEAD' });
  assert.equal(response.status, 200); assert.equal(await response.text(), '');
  assert.equal((await read('/api/public/catalog/model/Vendor/missing')).status, 404);
  const unavailable = await read('/api/public/catalog/model/Vendor/unavailable');
  assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('retry-after'), '17');
  assert.equal((await read('/api/public/catalog/stats/models?range=1d')).status, 400);
 });
 await test('Read-only allowlist rejects body/write/identity headers without logging secret values', async () => {
  const marker = 'SECRET-MUST-NOT-APPEAR';
  for (const options of [
   { method: 'POST', body: marker },
   { headers: { cookie: marker } },
   { headers: { authorization: marker } },
   { headers: { 'X-CinaToken-Workspace': marker } },
  ]) {
   const response = await read('/api/public/catalog/models?secret=' + marker, options);
   assert.equal(response.status, 400); assert.equal((await response.json()).error, 'fixture-rejected-request');
  }
  assert.equal((await read('/api/user/me?secret=' + marker)).status, 404);
  const response = await read('/__fixture/observations');
  const observations = await response.json();
  assert.equal(observations.violations.length, 5);
  assert.equal(JSON.stringify(observations).includes(marker), false);
  assert.equal(observations.violations.at(-1).path, '<rejected>');
 });
} finally {
 fixture.server.close(); fixture.server.closeAllConnections();
 await once(fixture.server, 'close');
}