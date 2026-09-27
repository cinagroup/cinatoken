import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {inspectSseAccessResponse as inspect} from './staging-sse-access-response.mjs';
const id = randomUUID();
const value = {profile: 'c02-sse-ownership-v1', instanceId: id, maxRequests: 1, maxReservedBytes: 1024, requests: 0, reservedBytes: 0};
const headers = {'content-type': 'application/json', 'cache-control': 'no-store', 'x-c02-capacity-instance': id};
const options = {target: 'gateway', auth: 'valid'};
const jsonResponse = (v = value, patch = {}) => new Response(JSON.stringify(v), {headers: {...headers, ...patch}});

for (const auth of ['none', 'invalid', 'valid']) for (const status of [302, 401, 403, 404, 503])
  test(`does not read error/redirect body: ${auth} ${status}`, async () => {
    let pulls = 0, cancels = 0;
    const body = new ReadableStream({pull() { pulls++; throw Error('PRIVATE_ERROR'); }, cancel() { cancels++; return new Promise(() => {}); }}, {highWaterMark: 0});
    const r = new Response(body, {status, headers: {'content-type': 'text/html', 'content-length': '999999999', location: 'https://unsafe.invalid/PRIVATE_ERROR'}});
    const result = await inspect(r, {target: 'gateway', auth});
    const expected = auth !== 'valid' && [401, 403].includes(status) ? 'PASS' : [302, 403, 404].includes(status) ? 'RETRY' : 'FAIL';
    assert.equal(result.verdict, expected); assert.equal(result.bodyDisposition, 'discarded');
    assert.equal(pulls, 0); assert.equal(cancels, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR|unsafe/);
  });

test('valid gateway response retains only bounded verified counters', async () => {
  const r = await inspect(jsonResponse(), options); assert.equal(r.verdict, 'PASS'); assert.deepEqual(r.capacity, value);
  assert.equal(r.bodyDisposition, 'validated-json'); assert.ok(r.bytes <= 2048);
});
test('valid controller check rejects the command without running it', async () => {
  const r = await inspect(new Response(JSON.stringify({status: 'invalid_command', reason: 'command_header'}), {status: 400, headers}), {target: 'controller', auth: 'valid'});
  assert.equal(r.verdict, 'PASS'); assert.equal(r.commandRejected, true); assert.equal(r.capacity, undefined);
});
for (const [name, make] of [
  ['HTML 200', () => jsonResponse(value, {'content-type': 'text/html'})],
  ['cacheable', () => jsonResponse(value, {'cache-control': 'public'})],
  ['identity mismatch', () => jsonResponse(value, {'x-c02-capacity-instance': randomUUID()})],
  ['missing identity', () => { const r = jsonResponse(); r.headers.delete('x-c02-capacity-instance'); return r; }],
  ['extra field', () => jsonResponse({...value, private: 'PRIVATE_ERROR'})],
  ['counter mismatch', () => jsonResponse({...value, requests: 1})],
  ['declared oversized', () => jsonResponse(value, {'content-length': '2049'})],
  ['actual oversized', () => new Response(JSON.stringify(value).padEnd(2049), {headers})],
  ['bad JSON', () => new Response('{PRIVATE_ERROR', {headers})],
  ['invalid UTF8', () => new Response(new Uint8Array([255]), {headers})],
]) test('rejects authenticated ' + name, async () => {
  const r = await inspect(make(), options); assert.equal(r.verdict, 'FAIL'); assert.equal(r.capacity, undefined);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_ERROR/);
});
for (const auth of ['none', 'invalid']) test('bypass success is rejected without parsing: ' + auth, async () => {
  const r = await inspect(jsonResponse(), {...options, auth}); assert.equal(r.verdict, 'FAIL'); assert.equal(r.capacity, undefined);
});
test('JSON denial cannot masquerade as Access HTML denial', async () => {
  const r = await inspect(new Response('{}', {status: 403, headers: {'content-type': 'application/problem+json'}}), {...options, auth: 'none'});
  assert.notEqual(r.verdict, 'PASS');
});
test('unexpected controller JSON is not persisted or accepted', async () => {
  const r = await inspect(new Response(JSON.stringify({status: 'finished', reason: 'command_header', secret: 'PRIVATE_ERROR'}), {status: 400, headers}), {target: 'controller', auth: 'valid'});
  assert.equal(r.verdict, 'FAIL'); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_ERROR|finished/);
});
test('body abort returns without waiting for non-cooperative cancel', async () => {
  const ac = new AbortController(); let cancels = 0;
  const body = new ReadableStream({pull() { ac.abort(); return new Promise(() => {}); }, cancel() { cancels++; return new Promise(() => {}); }}, {highWaterMark: 0});
  const result = await inspect(new Response(body, {headers}), {...options, signal: ac.signal});
  assert.equal(result.verdict, 'FAIL'); assert.equal(cancels, 1);
});
test('five-second bound rejects stalled expected JSON', {timeout: 10000}, async () => {
  let cancels = 0;
  const body = new ReadableStream({pull: () => new Promise(() => {}), cancel() { cancels++; }}, {highWaterMark: 0});
  const result = await inspect(new Response(body, {headers}), options);
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.error, 'interrupted'); assert.equal(cancels, 1);
});
test('already aborted response does not read', async () => {
  const result = await inspect(jsonResponse(), {...options, signal: AbortSignal.abort()});
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.error, 'cancelled');
});
