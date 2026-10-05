// In-process contract check. The separate Miniflare test is the native binding check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import gatewayWorker from './chat-holder-gateway-v364.ts';
import privateWorker from './chat-holder-private-v364.ts';
import {
  SYNTHETIC_CREDENTIAL_V364,
  SYNTHETIC_PROVIDER_URL_V364,
  SYNTHETIC_PUBLIC_BODY_V364,
  SYNTHETIC_QUOTE_V364,
  SYNTHETIC_ROUTE_V364,
} from './chat-holder-synthetic-v364.ts';

function fixture({ holdCancellationObservation = false } = {}) {
  const rows = new Map();
  const lifetimePromises = [];
  let releaseCancellationObservation;
  const cancellationObservationGate = new Promise(resolve => {
    releaseCancellationObservation = resolve;
  });
  const observations = {
    async get(key) { return rows.get(key) ?? null; },
    async put(key, value) {
      if (holdCancellationObservation && key.startsWith('cancel:')) {
        await cancellationObservationGate;
      }
      rows.set(key, value);
    },
  };
  let bindingCalls = 0;
  const bindingHeaders = [];
  const env = { TEXT_HOLDER: { async fetch(request) {
    bindingCalls++;
    bindingHeaders.push([...request.headers.entries()]);
    return privateWorker.fetch(request, { OBSERVATIONS: observations }, {
      waitUntil(promise) { lifetimePromises.push(promise); },
    });
  } } };
  function envelope(attemptNonce = randomUUID()) {
    return {
      requestId: SYNTHETIC_QUOTE_V364.requestId,
      quoteId: SYNTHETIC_QUOTE_V364.quoteId,
      attemptNonce,
      candidateIndex: SYNTHETIC_ROUTE_V364.candidateIndex,
      routeTargetId: SYNTHETIC_ROUTE_V364.targetId,
      finalBodyUtf8: SYNTHETIC_PUBLIC_BODY_V364,
    };
  }
  async function post(body) {
    return gatewayWorker.fetch(new Request('https://gateway.fixture.invalid/fixture/complete-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gateway-only-sentinel' }, body,
    }), env);
  }
  return { observations, envelope, post, bindingHeaders, lifetimePromises,
    releaseCancellationObservation, get bindingCalls() { return bindingCalls; } };
}

test('v364 in-process contract: private holder bounds and validates six fields; gateway forwards no auth or provider data', async () => {
  const f = fixture();
  const valid = f.envelope();
  for (const bad of [
    { ...valid, routeTargetId: 'untrusted' },
    { ...valid, finalBodyUtf8: valid.finalBodyUtf8 + ' ' },
    { ...valid, providerUrl: SYNTHETIC_PROVIDER_URL_V364 },
    { ...valid, credential: SYNTHETIC_CREDENTIAL_V364 },
  ]) {
    const response = await f.post(JSON.stringify(bad));
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.equal(body, '{"error":"holder_request_rejected"}');
    assert.equal(body.includes(SYNTHETIC_CREDENTIAL_V364), false);
    assert.equal(body.includes(SYNTHETIC_PROVIDER_URL_V364), false);
  }
  const oversized = await f.post(JSON.stringify({ ...valid, extra: 'x'.repeat(6 * 1_048_576 + 8_192) }));
  assert.equal(oversized.status, 413);
  assert.equal(await f.observations.get(`accepted:${valid.attemptNonce}`), null);
  assert.equal(f.bindingCalls, 5);
  for (const headers of f.bindingHeaders) assert.deepEqual(headers, [['content-type', 'application/json']]);
});

test('v364 in-process contract: one Response yields a first chunk before holder release and cancellation reaches source', async () => {
  const f = fixture();
  const e = f.envelope();
  const response = await f.post(JSON.stringify(e));
  assert.equal(response.status, 200);
  assert.equal(f.bindingCalls, 1);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.deepEqual([...response.headers.keys()].sort(), ['cache-control', 'content-type']);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': holder-ready\n\n');
  const second = reader.read();
  assert.equal(await Promise.race([second.then(() => 'ready'), new Promise(resolve => setTimeout(() => resolve('held'), 50))]), 'held');
  await f.observations.put(`release:${e.attemptNonce}`, 'yes');
  const text = new TextDecoder().decode((await second).value);
  assert.equal(text, 'data: {"text":"synthetic streamed answer"}\n\ndata: [DONE]\n\n');
  assert.equal(text.includes(SYNTHETIC_CREDENTIAL_V364), false);
  assert.equal(text.includes(SYNTHETIC_PROVIDER_URL_V364), false);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  const cancelEnvelope = f.envelope();
  const cancelledResponse = await f.post(JSON.stringify(cancelEnvelope));
  const cancelReader = cancelledResponse.body.getReader();
  assert.equal(new TextDecoder().decode((await cancelReader.read()).value), ': holder-ready\n\n');
  await cancelReader.cancel('client cancelled');
  assert.equal(await f.observations.get(`cancel:${cancelEnvelope.attemptNonce}`), 'observed');
  assert.equal(f.bindingCalls, 2);
});

test('v364 in-process cancellation retains the asynchronous holder observation in its request lifetime', async t => {
  const f = fixture({ holdCancellationObservation: true });
  t.after(() => f.releaseCancellationObservation());
  const e = f.envelope();
  const response = await f.post(JSON.stringify(e));
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': holder-ready\n\n');
  const cancelling = reader.cancel('client cancelled');
  assert.equal(f.lifetimePromises.length, 1);
  assert.equal(await f.observations.get(`cancel:${e.attemptNonce}`), null);
  f.releaseCancellationObservation();
  await Promise.all([cancelling, ...f.lifetimePromises]);
  assert.equal(await f.observations.get(`cancel:${e.attemptNonce}`), 'observed');
  assert.equal(await f.observations.get(`release:${e.attemptNonce}`), null);
  assert.equal(f.bindingCalls, 1);
});
