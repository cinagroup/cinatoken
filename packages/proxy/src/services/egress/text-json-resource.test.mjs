import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { dispatchOpenAiRoute } from './openai-driver.ts';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver.ts';
import { dispatchAnthropicRoute } from './anthropic-driver.ts';
import { dispatchGeminiRoute } from './gemini-driver.ts';
import { TEXT_JSON_RESPONSE_MAX_BYTES } from './text-json-response.ts';

const encode = value => new TextEncoder().encode(value);
const profiles = [
  { name: 'chat', protocol: 'openai', operation: 'chat', call: dispatchOpenAiRoute,
    value: { id: 'synthetic', object: 'chat.completion', created: 1, model: 'private-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } },
  { name: 'responses', protocol: 'openai', operation: 'responses', call: dispatchOpenAiResponsesRoute,
    value: { id: 'synthetic', object: 'response', created_at: 1, completed_at: 2, status: 'completed', model: 'private-model', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
  { name: 'messages', protocol: 'anthropic', operation: 'messages', call: dispatchAnthropicRoute,
    value: { id: 'synthetic', type: 'message', role: 'assistant', model: 'private-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } } },
  { name: 'gemini', protocol: 'gemini', operation: 'models.generate', call: (r,b,s) => dispatchGeminiRoute(r,b,'generateContent','',s),
    value: { responseId: 'synthetic', candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } } },
];
function route(p) {
  return { targetId: 'json-resource', providerId: 'json-resource', providerName: 'synthetic', providerModelName: 'private-model', gatewayModelId: 'public-model',
    upstreamProtocol: p.protocol, upstreamOperation: p.operation, adapter: 'passthrough', providerEndpoints: { [p.protocol]: { base: 'https://synthetic.invalid/v1' } },
    providerApiKey: 'synthetic-only', customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1 };
}

for (const p of profiles) for (const mode of ['declared', 'observed', 'abort-read', 'non-ok-cancel', 'late-ok', 'late-non-ok']) for (const ack of ['resolve', 'reject']) {
  test(`text JSON resource ${p.name}/${mode}/${ack}`, { timeout: 3000 }, async t => {
    const cleanup = Promise.withResolvers(), entered = Promise.withResolvers(), headers = Promise.withResolvers(), parent = new AbortController();
    let cancels = 0, sends = 0;
    const source = new ReadableStream({
      pull(c) { entered.resolve(); if (mode === 'observed') c.enqueue(new Uint8Array(TEXT_JSON_RESPONSE_MAX_BYTES + 1)); },
      cancel() { cancels++; return cleanup.promise; },
    }, { highWaterMark: 0 });
    const status = mode.includes('non-ok') ? 400 : 200;
    const response = new Response(source, { status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'synthetic-upstream',
      ...(mode === 'declared' ? { 'Content-Length': String(TEXT_JSON_RESPONSE_MAX_BYTES + 1) } : {}) } });
    t.mock.method(globalThis, 'fetch', async () => { sends++; if (mode.startsWith('late-')) { entered.resolve(); return headers.promise; } return response; });
    t.after(() => { cleanup.resolve(); headers.resolve(response); parent.abort(); });
    const pending = p.call(route(p), {}, parent.signal);
    if (mode === 'abort-read' || mode.startsWith('late-')) { await entered.promise; parent.abort(); headers.resolve(response); }
    const result = await pending;
    assert.ok(result.resourceCompletion instanceof Promise, 'every non-SSE fetched body has an owner');
    let released = false; void result.resourceCompletion.then(() => { released = true; });
    if (mode === 'non-ok-cancel') await result.response.body.cancel();
    else if (mode === 'late-non-ok') await assert.rejects(result.response.text(), /Upstream response body stopped/);
    else { assert.equal(result.response.status, 502); assert.equal(result.meta.upstreamOutcomeUnknown, true); assert.equal(result.meta.failoverForbidden, true); await result.response.text(); }
    assert.equal((await result.usagePromise).total_tokens, 0);
    assert.equal(result.upstreamRequestId, 'synthetic-upstream');
    await nextTurn(); assert.equal(released, false, 'usage and HTTP completion are not a cancellation ACK');
    assert.equal(cancels, 1); assert.equal(sends, 1); assert.equal(source.locked, false, 'unlock alone does not confirm cleanup');
    if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_CLEANUP_DETAIL'));
    assert.equal(await result.resourceCompletion, ack === 'resolve' ? 'confirmed' : 'unconfirmed');
    assert.equal(cancels, 1); assert.equal(sends, 1);
  });
}

for (const p of profiles.slice(0, 3)) for (const mode of ['mime', 'json-for-stream']) for (const ack of ['resolve', 'reject']) {
  test(`text JSON resource invalid format ${p.name}/${mode}/${ack}`, { timeout: 3000 }, async t => {
    const cleanup = Promise.withResolvers(); let cancels = 0, pulls = 0;
    const source = new ReadableStream({ pull() { pulls++; }, cancel() { cancels++; return cleanup.promise; } }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async () => new Response(source, { headers: { 'Content-Type': mode === 'mime' ? 'text/html' : 'application/json' } }));
    t.after(() => { cleanup.resolve(); });
    const result = await p.call(route(p), { stream: mode === 'json-for-stream' });
    assert.ok(result.resourceCompletion instanceof Promise);
    let released = false; void result.resourceCompletion.then(() => { released = true; });
    assert.equal(result.response.status, 502); assert.equal((await result.usagePromise).total_tokens, 0);
    await result.response.text(); await nextTurn(); assert.equal(released, false); assert.equal(pulls, 0); assert.equal(cancels, 1);
    if (ack === 'resolve') cleanup.resolve(); else cleanup.reject(Error('PRIVATE_CLEANUP_DETAIL'));
    assert.equal(await result.resourceCompletion, ack === 'resolve' ? 'confirmed' : 'unconfirmed');
  });
}

for (const p of profiles) for (const mode of ['success', 'invalid-json', 'non-ok-eof', 'no-body', ...(p.name === 'gemini' ? [] : ['invalid-schema'])]) {
  test(`text JSON resource EOF ${p.name}/${mode}`, { timeout: 3000 }, async t => {
    let cancels = 0;
    const wire = mode === 'invalid-json' ? '{' : JSON.stringify(mode === 'invalid-schema' ? {} : p.value);
    const source = new ReadableStream({ start(c) { c.enqueue(encode(wire)); c.close(); }, cancel() { cancels++; } });
    t.mock.method(globalThis, 'fetch', async () => new Response(mode === 'no-body' ? null : source, { status: mode === 'no-body' ? 204 : mode === 'non-ok-eof' ? 400 : 200,
      headers: { 'Content-Type': 'application/json' } }));
    const result = await p.call(route(p), {});
    assert.ok(result.resourceCompletion instanceof Promise);
    const text = await result.response.text(), usage = await result.usagePromise;
    assert.equal(await result.resourceCompletion, 'confirmed'); assert.equal(cancels, 0); assert.equal(source.locked, false);
    if (mode === 'success') { assert.equal(result.response.status, 200, text); assert.equal(usage.total_tokens, 5); if (p.name !== 'gemini') assert.equal(JSON.parse(text).model, 'public-model'); }
    else { assert.equal(usage.total_tokens, 0); assert.equal(result.response.status, mode === 'non-ok-eof' ? 400 : mode === 'no-body' && p.name === 'gemini' ? 204 : 502); }
  });
}
