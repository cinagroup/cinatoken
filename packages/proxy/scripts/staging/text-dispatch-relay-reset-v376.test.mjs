// Real Node sockets: a synthetic relay retries after a provider has received
// the complete POST but destroys the response connection. No external egress.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { proxyChatCompletions } from '../../src/services/proxy.ts';
import { createRequestDispatchBudget } from '../../src/services/request-dispatch-budget.ts';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function route(base, index) {
  return {
    targetId: `reset-relay-target-${index}`, modelSurfaceId: null,
    routePoolId: 'reset-relay-pool', providerId: `reset-relay-provider-${index}`,
    providerName: 'synthetic', providerModelName: 'synthetic-model',
    gatewayModelId: 'public/synthetic', upstreamProtocol: 'openai',
    upstreamOperation: 'chat', adapter: 'passthrough',
    providerEndpoints: { openai: { base: `${base}/v1` } },
    providerApiKey: 'synthetic-reset-relay-secret',
    providerSharedChannelType: null, priceOverrideRaw: null,
    routeMeteredProfileJson: null, routeChargedProfileJson: null,
    customParams: null, routeGroup: 'default', routePriority: index,
    routeWeight: 1, providerKeyId: `reset-relay-key-${index}`,
    providerKeyLabel: null, providerKeyFingerprint: null,
  };
}

test('relay retry after a complete provider POST and lost response escapes Gateway permit count',
  { timeout: 10000 }, async t => {
    const providerHits = [];
    const provider = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      providerHits.push({ path: request.url, method: request.method,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization });
      if (providerHits.length === 1) {
        // The first request is fully received; only its response is lost.
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'chatcmpl-reset-relay', object: 'chat.completion',
        created: 1, model: 'synthetic-model', choices: [{ index: 0,
          message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    });
    const providerOrigin = await listen(provider);

    const relayHits = [];
    const relay = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      relayHits.push({ path: request.url, method: request.method,
        body: body.toString('utf8'), authorization: request.headers.authorization });
      for (let innerAttempt = 0; innerAttempt < 2; innerAttempt += 1) {
        try {
          const upstream = await fetch(`${providerOrigin}${request.url}`, {
            method: request.method,
            headers: { Authorization: request.headers.authorization,
              'Content-Type': request.headers['content-type'] },
            body,
            redirect: 'error',
          });
          response.writeHead(upstream.status,
            { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain' });
          response.end(await upstream.text());
          return;
        } catch (error) {
          if (innerAttempt === 1) {
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

    const budget = createRequestDispatchBudget();
    const result = await proxyChatCompletions({},
      Array.from({ length: 40 }, (_, index) => route(relayOrigin, index)),
      { messages: [{ role: 'user', content: 'synthetic reset relay' }] },
      undefined, { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority',
        dispatchBudget: budget });
    assert.equal(result.response.status, 200);
    assert.notEqual(result.meta?.upstreamOutcomeUnknown, true);
    await result.response.body?.cancel();
    await result.usagePromise;

    assert.equal(budget.snapshot().permitsConsumed, 1);
    assert.equal(relayHits.length, 1);
    assert.equal(relayHits[0].method, 'POST');
    assert.equal(relayHits[0].authorization, 'Bearer synthetic-reset-relay-secret');
    assert.equal(providerHits.length, 2);
    assert.deepEqual(providerHits.map(hit => hit.method), ['POST', 'POST']);
    assert.deepEqual(providerHits.map(hit => hit.path),
      ['/v1/chat/completions', '/v1/chat/completions']);
    assert.equal(providerHits[0].body, providerHits[1].body);
    assert.equal(providerHits[0].body, relayHits[0].body);
    assert.deepEqual(providerHits.map(hit => hit.authorization),
      ['Bearer synthetic-reset-relay-secret', 'Bearer synthetic-reset-relay-secret']);
    t.diagnostic(JSON.stringify({ gatewayPermits: budget.snapshot().permitsConsumed,
      relayPosts: relayHits.length, providerPosts: providerHits.length,
      firstProviderPostFullyReceived: true, repeatedBodyAndCredential: true }));
  });
