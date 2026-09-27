import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createSseCapacitySampler, SSE_CAPACITY_SAMPLE_URL} from './staging-sse-capacity-sampler.mjs';
import {createSseOperatorClock} from './staging-sse-operator-clock.mjs';

const id = randomUUID();
const accessHeaders = {'CF-Access-Client-ID': 'test-id', 'CF-Access-Client-Secret': 'private-test-secret'};
const value = (requests = 0, instanceId = id) => ({profile: 'c02-sse-ownership-v1', instanceId, maxRequests: 1, maxReservedBytes: 1024, requests, reservedBytes: requests * 1024});
const response = (v = value(), patch = {}) => new Response(JSON.stringify(v), {
  headers: {'content-type': 'application/json', 'cache-control': 'no-store', 'x-c02-capacity-instance': v.instanceId, ...patch},
});
function setup(options = {}) {
  const journal = [], calls = [];
  let reservations = 0;
  const sampler = createSseCapacitySampler({
    clock: createSseOperatorClock(), reserve: () => { reservations++; },
    persist: async entry => { journal.push(structuredClone(entry)); },
    fetchImpl: async (url, init) => { calls.push({url, init}); return response(); }, ...options,
  });
  const sample = (stage = 'baseline', requestInstanceId = stage === 'baseline' ? undefined : id) => sampler.sample({stage, requestInstanceId, accessHeaders});
  return {sampler, sample, journal, calls, reservations: () => reservations};
}

test('fixed authenticated GET is journaled and debited before transport; secrets excluded', async () => {
  let reserved = 0;
  const journal = [];
  const s = setup({reserve: () => { reserved++; }, persist: async e => { journal.push(e); }, fetchImpl: async (url, init) => {
    assert.equal(reserved, 1); assert.equal(journal.length, 1); assert.equal(journal[0].result, 'PENDING');
    assert.equal(url, SSE_CAPACITY_SAMPLE_URL); assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store'); assert.equal(init.body, undefined);
    assert.equal(init.headers.get('CF-Access-Client-Secret'), 'private-test-secret');
    return response();
  }});
  const result = await s.sample();
  assert.equal(result.result, 'PASS'); assert.equal(result.observation.state, 'baseline');
  assert.equal(journal.length, 2); assert.equal(result.started.clockId, result.finished.clockId);
  assert.doesNotMatch(JSON.stringify(journal), /private-test-secret|test-id|CF-Access/i);
});

test('exact six-attempt window distinguishes held, idle and other pools without retries', async () => {
  const values = [value(), value(1), value(0, randomUUID()), value(1), value(), value()];
  const s = setup({fetchImpl: async () => response(values.shift())});
  assert.equal((await s.sample()).result, 'PASS');
  assert.equal((await s.sample('held')).observation.state, 'occupied');
  assert.equal((await s.sample('post-cancel')).observation.state, 'different-instance');
  assert.equal((await s.sample('post-cancel')).observation.state, 'occupied');
  assert.equal((await s.sample('post-cancel')).observation.state, 'idle');
  await assert.rejects(s.sample('post-cancel'), /budget/);
  assert.equal((await s.sample('post-recovery')).observation.state, 'idle');
  await assert.rejects(s.sample('post-recovery'), /budget/);
  await assert.rejects(s.sample('held'), /order/);
  assert.equal(s.reservations(), 6); assert.equal(s.journal.length, 12);
});

for (const [label, make] of [
  ['redirect', () => new Response(null, {status: 302, headers: {location: 'https://example.com'}})],
  ['denial', () => new Response('private-error', {status: 403})],
  ['HTML', () => response(value(), {'content-type': 'text/html'})],
  ['cacheable', () => response(value(), {'cache-control': 'public'})],
  ['missing identity', () => { const r = response(); r.headers.delete('x-c02-capacity-instance'); return r; }],
  ['identity mismatch', () => response(value(), {'x-c02-capacity-instance': randomUUID()})],
  ['declared oversized', () => response(value(), {'content-length': '2049'})],
  ['invalid declared length', () => response(value(), {'content-length': '-1'})],
  ['actual oversized', () => response({...value(), extra: 'x'.repeat(2048)})],
  ['extra field', () => response({...value(), secret: 'private-error'})],
  ['invalid counters', () => response({...value(), reservedBytes: 1024})],
  ['bad JSON', () => { const r = response(); return new Response('{private-error', {headers: r.headers}); }],
  ['invalid UTF8', () => new Response(new Uint8Array([255]), {headers: response().headers})],
  ['transport rejection', () => { throw Error('private-test-secret private-error'); }],
]) test('fails closed without raw data or retry: ' + label, async () => {
  let calls = 0;
  const s = setup({fetchImpl: async () => { calls++; return make(); }});
  const result = await s.sample();
  assert.equal(result.result, 'FAIL'); assert.equal(result.observation, undefined);
  assert.doesNotMatch(JSON.stringify(s.journal), /private-test-secret|private-error/);
  await assert.rejects(s.sample(), /budget/);
  assert.equal(calls, 1); assert.equal(s.reservations(), 1);
});

test('invalid stage/identity/auth never consumes budget or reaches transport', async () => {
  const s = setup();
  for (const args of [
    {stage: 'post-cancel', requestInstanceId: id, accessHeaders},
    {stage: 'held', requestInstanceId: id, accessHeaders},
    {stage: 'baseline', requestInstanceId: id, accessHeaders},
    {stage: 'baseline', accessHeaders: {...accessHeaders, Authorization: 'not-allowed'}},
    {stage: 'baseline', accessHeaders: {}},
    {stage: 'baseline', accessHeaders: {...accessHeaders, 'CF-Access-Client-Secret': ''}},
  ]) await assert.rejects(s.sampler.sample(args));
  assert.equal(s.reservations(), 0); assert.equal(s.calls.length, 0);
});

test('post-cancel identity cannot be replaced with a different idle pool', async () => {
  const s = setup(); await s.sample(); await s.sample('held');
  await assert.rejects(s.sample('post-cancel', randomUUID()), /identity changed/);
  assert.equal(s.reservations(), 2);
  assert.equal((await s.sample('post-cancel')).result, 'PASS');
});

for (const when of ['reserve', 'initial', 'final']) test('journal/budget failure poisons sampler: ' + when, async () => {
  let persisted = 0, calls = 0;
  const s = setup({reserve: () => { if (when === 'reserve') throw Error('private-test-secret'); },
    persist: async () => { persisted++; if (persisted === (when === 'initial' ? 1 : 2)) throw Error('private-test-secret'); },
    fetchImpl: async () => { calls++; return response(); },
  });
  await assert.rejects(s.sample(), /journal|budget/);
  await assert.rejects(s.sample('held'), /failed/);
  assert.equal(calls, when === 'final' ? 1 : 0);
});

test('concurrent caller cannot overtake a pending journal', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const s = setup({persist: async e => { if (e.result === 'PENDING') await pending; }});
  const first = s.sample();
  await assert.rejects(s.sample('held'), /busy/);
  release(); assert.equal((await first).result, 'PASS');
  assert.equal(s.reservations(), 1);
});

for (const phase of ['headers', 'body']) test('five-second deadline bounds non-cooperative ' + phase, {timeout: 10000}, async () => {
  let finish, cancelled = 0, signal;
  const pending = new Promise(resolve => { finish = resolve; });
  const s = setup({fetchImpl: async (_, init) => {
    signal = init.signal;
    if (phase === 'headers') return pending;
    return new Response(new ReadableStream({pull: () => pending, cancel: () => { cancelled++; }}, {highWaterMark: 0}), {headers: response().headers});
  }});
  const result = await s.sample();
  assert.equal(result.result, 'FAIL'); assert.equal(result.error, 'timeout'); assert.equal(signal.aborted, true);
  if (phase === 'headers') finish(new Response(new ReadableStream({cancel: () => { cancelled++; }}, {highWaterMark: 0})));
  else finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(s.reservations(), 1);
  assert.equal(s.journal.at(-1).result, 'FAIL');
});

test('exact byte bound accepts chunked JSON padded to 2048 bytes', async () => {
  const data = Buffer.from(JSON.stringify(value()).padEnd(2048));
  let offset = 0;
  const s = setup({fetchImpl: async () => new Response(new ReadableStream({pull(controller) {
    if (offset === data.length) controller.close();
    else { controller.enqueue(data.subarray(offset, offset + 16)); offset += 16; }
  }}), {headers: response().headers})});
  const result = await s.sample(); assert.equal(result.result, 'PASS'); assert.equal(result.bytes, 2048);
});
