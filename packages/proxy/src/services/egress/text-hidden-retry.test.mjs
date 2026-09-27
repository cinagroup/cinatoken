import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { proxyChatCompletions, proxyResponses, proxyAnthropicMessages, proxyGeminiContent } from '../proxy.ts';
import { createRequestDispatchBudget } from '../request-dispatch-budget.ts';
import { resetProviderCircuitStateForTests } from '../provider-circuit-breaker.ts';

const profiles = [
  { name: 'chat', protocol: 'openai', operation: 'chat', proxy: proxyChatCompletions },
  { name: 'responses', protocol: 'openai', operation: 'responses', proxy: proxyResponses },
  { name: 'messages', protocol: 'anthropic', operation: 'messages', proxy: proxyAnthropicMessages },
  {
    name: 'gemini', protocol: 'gemini', operation: 'models.generate',
    proxy: (repos, routes, body, signal, options) => proxyGeminiContent(repos, routes, 'generateContent', body, '', signal, options),
  },
];

function route(profile, base, index) {
  return {
    targetId: `text-target-${index}`, modelSurfaceId: null, routePoolId: 'text-pool',
    providerId: `text-provider-${index}`, providerName: 'synthetic',
    providerModelName: 'synthetic-model', gatewayModelId: 'public/synthetic',
    upstreamProtocol: profile.protocol, upstreamOperation: profile.operation, adapter: 'passthrough',
    providerEndpoints: { [profile.protocol]: { base } }, providerApiKey: 'synthetic-wire-secret',
    providerSharedChannelType: null, priceOverrideRaw: null, routeMeteredProfileJson: null,
    routeChargedProfileJson: null, customParams: null, routeGroup: 'default',
    routePriority: index, routeWeight: 1, providerKeyId: `text-key-${index}`,
    providerKeyLabel: null, providerKeyFingerprint: null,
  };
}

async function wire(t, status) {
  const hits = [];
  const server = createServer((request, response) => {
    const hit = { method: request.method, bytes: 0 };
    hits.push(hit);
    request.on('data', chunk => { hit.bytes += chunk.length; });
    request.on('end', () => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end('{"error":{"message":"synthetic rejection"}}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, hits };
}

for (const profile of profiles) for (const status of [408, 499, 503]) {
  test(`sent text POST ${profile.name} HTTP ${status} cannot switch candidates`, { timeout: 10_000 }, async t => {
    resetProviderCircuitStateForTests();
    const { base, hits } = await wire(t, status);
    const budget = createRequestDispatchBudget();
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
    const result = await profile.proxy({}, [route(profile, base, 0), route(profile, base, 1)],
      { messages: [], input: 'synthetic' }, undefined,
      { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget });
    await result.response.body?.cancel();
    await result.usagePromise;
    assert.equal(hits.length, 1);
    assert.deepEqual(hits.map(hit => hit.method), ['POST']);
    assert.ok(hits[0].bytes > 0);
    assert.equal(budget.snapshot().permitsConsumed, 1);
    assert.equal(result.meta?.upstreamOutcomeUnknown, true);
    assert.equal(result.meta?.failoverForbidden, true);
  });
}

for (const profile of profiles) for (const status of [400, 429]) {
  test(`clear text POST ${profile.name} HTTP ${status} retains bounded candidate switch`, { timeout: 10_000 }, async t => {
    resetProviderCircuitStateForTests();
    const { base, hits } = await wire(t, status);
    const budget = createRequestDispatchBudget();
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
    const result = await profile.proxy({}, [route(profile, base, 0), route(profile, base, 1)],
      { messages: [], input: 'synthetic' }, undefined,
      { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget });
    await result.response.body?.cancel();
    await result.usagePromise;
    const expectedSends = status === 429 ? 2 : 1;
    assert.equal(hits.length, expectedSends);
    assert.ok(hits.every(hit => hit.method === 'POST' && hit.bytes > 0));
    assert.equal(budget.snapshot().permitsConsumed, expectedSends);
    assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
  });
}
