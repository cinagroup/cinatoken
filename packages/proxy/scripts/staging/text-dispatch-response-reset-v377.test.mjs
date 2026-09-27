// Real Node fetch/socket matrix: the provider receives the entire paid POST,
// then closes the response connection before sending headers. No external egress.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  proxyAnthropicMessages, proxyChatCompletions, proxyGeminiContent, proxyResponses,
} from '../../src/services/proxy.ts';
import { createRequestDispatchBudget } from '../../src/services/request-dispatch-budget.ts';
import { resetProviderCircuitStateForTests } from '../../src/services/provider-circuit-breaker.ts';
import { dispatchAnthropicRoute } from '../../src/services/egress/anthropic-driver.ts';
import { dispatchGeminiRoute } from '../../src/services/egress/gemini-driver.ts';
import { dispatchOpenAiRoute } from '../../src/services/egress/openai-driver.ts';
import { dispatchOpenAiResponsesRoute } from '../../src/services/egress/openai-responses-driver.ts';

const profiles = [
  {
    name: 'OpenAI Chat', protocol: 'openai', operation: 'chat',
    body: { messages: [{ role: 'user', content: 'synthetic reset' }] },
    direct: (route, body, beforeFetch) => dispatchOpenAiRoute(route, body, undefined, undefined, undefined, beforeFetch),
    gateway: proxyChatCompletions,
    path: /^\/v1\/chat\/completions$/,
  },
  {
    name: 'OpenAI Responses', protocol: 'openai', operation: 'responses',
    body: { input: 'synthetic reset' },
    direct: (route, body, beforeFetch) => dispatchOpenAiResponsesRoute(route, body, undefined, undefined, undefined, beforeFetch),
    gateway: proxyResponses,
    path: /^\/v1\/responses$/,
  },
  {
    name: 'Anthropic Messages', protocol: 'anthropic', operation: 'messages',
    body: { messages: [{ role: 'user', content: 'synthetic reset' }], max_tokens: 16 },
    direct: (route, body, beforeFetch) => dispatchAnthropicRoute(route, body, undefined, undefined, undefined, beforeFetch),
    gateway: proxyAnthropicMessages,
    path: /^\/v1\/messages$/,
  },
  {
    name: 'Gemini', protocol: 'gemini', operation: 'models.generate',
    body: { contents: [{ role: 'user', parts: [{ text: 'synthetic reset' }] }] },
    direct: (route, body, beforeFetch, stream) => dispatchGeminiRoute(route, body, stream ? 'streamGenerateContent' : 'generateContent', '', undefined, undefined, undefined, beforeFetch),
    gateway: (repos, routes, body, signal, options, stream) => proxyGeminiContent(repos, routes, stream ? 'streamGenerateContent' : 'generateContent', body, '', signal, options),
  },
];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function completePostThenReset(t) {
  const hits = [];
  const server = createServer(async request => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      hits.push({
        method: request.method,
        url: request.url,
        body: body.toString('utf8'),
        bytes: body.length,
        expectedBytes: Number(request.headers['content-length']),
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'],
      });
      // The full POST is already in the provider application before its
      // response socket disappears. The Gateway sees no HTTP status line.
      request.socket.destroy();
    } catch {
      request.socket.destroy();
    }
  });
  const origin = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { origin, hits };
}

function route(profile, origin, index) {
  const base = profile.protocol === 'openai' ? `${origin}/v1`
    : profile.protocol === 'gemini' ? `${origin}/v1/models` : origin;
  return {
    targetId: `reset-target-${index}`, modelSurfaceId: null,
    routePoolId: 'reset-pool', providerId: `reset-provider-${index}`,
    providerName: 'synthetic', providerModelName: 'synthetic-model',
    gatewayModelId: 'public/synthetic', upstreamProtocol: profile.protocol,
    upstreamOperation: profile.operation, adapter: 'passthrough',
    providerEndpoints: { [profile.protocol]: { base } },
    providerApiKey: 'synthetic-reset-secret',
    providerSharedChannelType: null, priceOverrideRaw: null,
    routeMeteredProfileJson: null, routeChargedProfileJson: null,
    customParams: null, routeGroup: 'default', routePriority: index,
    routeWeight: 1, providerKeyId: `reset-key-${index}`,
    providerKeyLabel: null, providerKeyFingerprint: null,
  };
}

function assertCompleteSinglePost(profile, hits, stream) {
  assert.equal(hits.length, 1, 'exactly one physical POST reaches the provider');
  const [hit] = hits;
  assert.equal(hit.method, 'POST');
  if (profile.protocol === 'gemini') {
    const url = new URL(hit.url, 'http://localhost');
    assert.equal(url.pathname,
      `/v1/models/synthetic-model:${stream ? 'streamGenerateContent' : 'generateContent'}`);
    assert.equal(url.searchParams.get('key'), 'synthetic-reset-secret');
    assert.equal(url.searchParams.get('alt'), stream ? 'sse' : null);
  } else {
    assert.ok(profile.path.test(hit.url), `unexpected ${profile.name} path: ${hit.url}`);
  }
  assert.ok(hit.bytes > 0);
  assert.equal(hit.bytes, hit.expectedBytes, 'provider received the complete declared body');
  assert.ok(JSON.parse(hit.body));
  if (profile.protocol === 'openai') {
    assert.equal(hit.authorization, 'Bearer synthetic-reset-secret');
  } else if (profile.protocol === 'anthropic') {
    assert.equal(hit.apiKey, 'synthetic-reset-secret');
  }
}

for (const profile of profiles) for (const stream of [false, true]) {
  const body = profile.protocol === 'gemini' ? profile.body : { ...profile.body, stream };
  test(`${profile.name} stream=${stream} driver marks a completed POST plus response reset as unknown`,
    { timeout: 10_000 }, async t => {
      const { origin, hits } = await completePostThenReset(t);
      const budget = createRequestDispatchBudget();
      await assert.rejects(
        profile.direct(route(profile, origin, 0), body, async () => budget.consume(), stream),
        error => error instanceof Error && error.upstreamOutcomeUnknown === true,
      );
      assertCompleteSinglePost(profile, hits, stream);
      assert.equal(budget.snapshot().permitsConsumed, 1);
    });

  test(`${profile.name} stream=${stream} Gateway stops 40 candidate routes after completed POST plus response reset`,
    { timeout: 10_000 }, async t => {
      resetProviderCircuitStateForTests();
      const { origin, hits } = await completePostThenReset(t);
      const budget = createRequestDispatchBudget();
      for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
      const result = await profile.gateway({},
        Array.from({ length: 40 }, (_, index) => route(profile, origin, index)),
        body, undefined,
        { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget }, stream);
      await result.response.body?.cancel();
      await result.usagePromise;
      assertCompleteSinglePost(profile, hits, stream);
      assert.equal(budget.snapshot().permitsConsumed, 1);
      assert.equal(result.response.status, 502);
      assert.equal(result.meta?.upstreamOutcomeUnknown, true);
      assert.equal(result.meta?.failoverForbidden, true);
    });
}
