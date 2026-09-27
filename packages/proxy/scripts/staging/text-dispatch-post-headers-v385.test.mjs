// Real sockets: a complete paid POST receives HTTP 200 before the response
// body fails or before the first SSE token arrives. No external egress.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  proxyAnthropicMessages, proxyChatCompletions, proxyGeminiContent, proxyResponses,
} from '../../src/services/proxy.ts';
import { createRequestDispatchBudget } from '../../src/services/request-dispatch-budget.ts';
import { resetProviderCircuitStateForTests } from '../../src/services/provider-circuit-breaker.ts';

const profiles = [
  {
    name: 'OpenAI Chat', protocol: 'openai', operation: 'chat',
    body: { messages: [{ role: 'user', content: 'synthetic post-headers' }] },
    gateway: proxyChatCompletions,
  },
  {
    name: 'OpenAI Responses', protocol: 'openai', operation: 'responses',
    body: { input: 'synthetic post-headers' },
    gateway: proxyResponses,
  },
  {
    name: 'Anthropic Messages', protocol: 'anthropic', operation: 'messages',
    body: { messages: [{ role: 'user', content: 'synthetic post-headers' }], max_tokens: 16 },
    gateway: proxyAnthropicMessages,
  },
  {
    name: 'Gemini', protocol: 'gemini', operation: 'models.generate',
    body: { contents: [{ role: 'user', parts: [{ text: 'synthetic post-headers' }] }] },
    gateway: (repos, routes, body, signal, options, stream) =>
      proxyGeminiContent(repos, routes, stream ? 'streamGenerateContent' : 'generateContent',
        body, '', signal, options),
  },
];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function route(profile, origin, index) {
  const base = profile.protocol === 'openai' ? `${origin}/v1`
    : profile.protocol === 'gemini' ? `${origin}/v1/models` : origin;
  return {
    targetId: `post-headers-target-${index}`, modelSurfaceId: null,
    routePoolId: 'post-headers-pool', providerId: `post-headers-provider-${index}`,
    providerName: 'synthetic', providerModelName: 'synthetic-model',
    gatewayModelId: 'public/synthetic', upstreamProtocol: profile.protocol,
    upstreamOperation: profile.operation, adapter: 'passthrough',
    providerEndpoints: { [profile.protocol]: { base } },
    providerApiKey: 'synthetic-post-headers-secret', providerSharedChannelType: null,
    priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
    customParams: null, routeGroup: 'default', routePriority: index, routeWeight: 1,
    providerKeyId: `post-headers-key-${index}`, providerKeyLabel: null,
    providerKeyFingerprint: null,
  };
}

async function fixture(t, mode) {
  const hits = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    try {
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      hits.push({ method: request.method, path: request.url,
        bytes: body.length, declared: Number(request.headers['content-length']),
        bearer: request.headers.authorization, apiKey: request.headers['x-api-key'],
        headersFlushed: false });
      if (mode === 'json-reset') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        hits.at(-1).headersFlushed = response.headersSent;
        response.write('{"private_partial":"not a terminal usage fact"');
        await new Promise(resolve => setTimeout(resolve, 30));
        response.socket.destroy();
      } else if (mode === 'sse-reset') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        hits.at(-1).headersFlushed = response.headersSent;
        response.write(': synthetic stream opened\n\n');
        await new Promise(resolve => setTimeout(resolve, 30));
        response.socket.destroy();
      } else {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        hits.at(-1).headersFlushed = response.headersSent;
        // A 200 status line does not prove that the first token will arrive.
        // The client aborts below; leave this socket otherwise silent.
      }
    } catch {
      request.socket.destroy();
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { origin: await listen(server), hits };
}

function assertSingleCompletePost(profile, hits, budget) {
  assert.equal(budget.snapshot().permitsConsumed, 1);
  assert.equal(hits.length, 1, 'the owned provider received one complete POST');
  assert.equal(hits[0].method, 'POST');
  assert.ok(hits[0].bytes > 0);
  assert.equal(hits[0].bytes, hits[0].declared);
  assert.equal(hits[0].headersFlushed, true);
  if (profile.protocol === 'openai')
    assert.equal(hits[0].bearer, 'Bearer synthetic-post-headers-secret');
  if (profile.protocol === 'anthropic')
    assert.equal(hits[0].apiKey, 'synthetic-post-headers-secret');
  if (profile.protocol === 'gemini')
    assert.equal(new URL(hits[0].path, 'http://localhost').searchParams.get('key'),
      'synthetic-post-headers-secret');
}

for (const profile of profiles) {
  test(`${profile.name}: 200 JSON body reset after full POST cannot dispatch any of 39 successors`,
    { timeout: 10000 }, async t => {
      resetProviderCircuitStateForTests();
      const { origin, hits } = await fixture(t, 'json-reset');
      const budget = createRequestDispatchBudget();
      for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
      const result = await profile.gateway({},
        Array.from({ length: 40 }, (_, index) => route(profile, origin, index)),
        profile.body, undefined,
        { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget },
        false);
      assertSingleCompletePost(profile, hits, budget);
      assert.equal(result.response.status, 502);
      assert.equal(result.meta?.upstreamOutcomeUnknown, true);
      assert.equal(result.meta?.failoverForbidden, true);
      assert.doesNotMatch(await result.response.text(), /private_partial/);
      await result.usagePromise;
      t.diagnostic(JSON.stringify({ protocol: profile.name, mode: 'json-reset',
        gatewayPermits: 1, physicalProviderPosts: hits.length, outcomeUnknown: true }));
    });

  test(`${profile.name}: 200 SSE with no first token, then client abort, cannot dispatch a successor`,
    { timeout: 10000 }, async t => {
      resetProviderCircuitStateForTests();
      const { origin, hits } = await fixture(t, 'silent-sse');
      const budget = createRequestDispatchBudget();
      const controller = new AbortController();
      for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
      const result = await profile.gateway({},
        Array.from({ length: 40 }, (_, index) => route(profile, origin, index)),
        { ...profile.body, stream: true }, controller.signal,
        { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget },
        true);
      assert.equal(result.response.status, 200);
      assertSingleCompletePost(profile, hits, budget);
      await new Promise(resolve => setTimeout(resolve, 50));
      assertSingleCompletePost(profile, hits, budget);
      controller.abort(new Error('synthetic first-token wait exceeded'));
      await result.response.body?.cancel('synthetic client disconnected').catch(() => undefined);
      const usage = await result.usagePromise;
      assert.equal(usage.cancelled, true);
      assertSingleCompletePost(profile, hits, budget);
      t.diagnostic(JSON.stringify({ protocol: profile.name, mode: 'silent-sse-abort',
        gatewayPermits: 1, physicalProviderPosts: hits.length, cancelled: true }));
    });

  test(`${profile.name}: 200 SSE body reset after first bytes cannot dispatch a successor`,
    { timeout: 10000 }, async t => {
      resetProviderCircuitStateForTests();
      const { origin, hits } = await fixture(t, 'sse-reset');
      const budget = createRequestDispatchBudget();
      for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
      const result = await profile.gateway({},
        Array.from({ length: 40 }, (_, index) => route(profile, origin, index)),
        { ...profile.body, stream: true }, undefined,
        { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget },
        true);
      assert.equal(result.response.status, 200);
      const publicBody = await result.response.text();
      const usage = await result.usagePromise;
      assertSingleCompletePost(profile, hits, budget);
      assert.ok(typeof usage.stream_error === 'string' && usage.stream_error.length > 0);
      assert.doesNotMatch(publicBody, /private_partial/);
      t.diagnostic(JSON.stringify({ protocol: profile.name, mode: 'sse-reset',
        gatewayPermits: 1, physicalProviderPosts: hits.length,
        streamError: true }));
    });
}

test('a buffering relay can retry after provider 200 headers and a broken body, invisible to Gateway',
  { timeout: 10000 }, async t => {
    const providerHits = [];
    const provider = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      providerHits.push({ method: request.method, path: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
        declared: Number(request.headers['content-length']),
        bearer: request.headers.authorization });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      if (providerHits.length === 1) {
        response.write('{"private_partial":"not terminal"');
        await new Promise(resolve => setTimeout(resolve, 30));
        response.socket.destroy();
      } else {
        response.end(JSON.stringify({ id: 'chatcmpl-post-headers', object: 'chat.completion',
          created: 1, model: 'synthetic-model', choices: [{ index: 0,
            message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    });
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    });
    const providerOrigin = await listen(provider);

    const relayHits = [];
    const relayObservedStatuses = [];
    const relay = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      relayHits.push({ method: request.method, path: request.url,
        body: body.toString('utf8'), bearer: request.headers.authorization });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const upstream = await fetch(`${providerOrigin}${request.url}`, {
            method: request.method, redirect: 'error', body,
            headers: { Authorization: request.headers.authorization,
              'Content-Type': request.headers['content-type'] },
          });
          relayObservedStatuses.push(upstream.status);
          // A relay that buffers a successful response may still retry its POST
          // when reading the body fails after it has observed HTTP 200.
          const responseBody = await upstream.text();
          response.writeHead(upstream.status,
            { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
          response.end(responseBody);
          return;
        } catch (error) {
          if (attempt === 1) {
            response.writeHead(502);
            response.end(String(error));
          }
        }
      }
    });
    t.after(async () => {
      relay.closeAllConnections();
      await new Promise(resolve => relay.close(resolve));
    });
    const relayOrigin = await listen(relay);

    resetProviderCircuitStateForTests();
    const budget = createRequestDispatchBudget();
    const profile = profiles[0];
    const result = await profile.gateway({},
      Array.from({ length: 40 }, (_, index) => route(profile, relayOrigin, index)),
      profile.body, undefined,
      { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget });
    assert.equal(result.response.status, 200);
    assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
    assert.equal((await result.usagePromise).total_tokens, 2);
    await result.response.body?.cancel();
    assert.equal(budget.snapshot().permitsConsumed, 1);
    assert.equal(relayHits.length, 1);
    assert.equal(providerHits.length, 2);
    assert.deepEqual(relayObservedStatuses, [200, 200]);
    assert.deepEqual(providerHits.map(hit => hit.path),
      ['/v1/chat/completions', '/v1/chat/completions']);
    assert.deepEqual(providerHits.map(hit => hit.method), ['POST', 'POST']);
    assert.equal(providerHits[0].body, relayHits[0].body);
    assert.equal(providerHits[1].body, relayHits[0].body);
    assert.ok(providerHits.every(hit => Buffer.byteLength(hit.body) === hit.declared));
    assert.deepEqual(providerHits.map(hit => hit.bearer),
      ['Bearer synthetic-post-headers-secret', 'Bearer synthetic-post-headers-secret']);
    t.diagnostic(JSON.stringify({ gatewayPermits: 1, relayPosts: relayHits.length,
      physicalProviderPosts: providerHits.length, relayObservedStatuses,
      firstProviderResponse: '200 then body reset' }));
  });
