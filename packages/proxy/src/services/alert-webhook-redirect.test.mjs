import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fireGatewayErrorWebhooks } from './alert-webhook.ts';

const alertContext = {
  requestLogId: 'synthetic-log', apiKeyId: 'synthetic-key', userEmail: 'synthetic@example.invalid',
  modelId: 'synthetic-model', providerId: 'synthetic-provider', providerModelName: 'synthetic-model',
  routeGroup: 'default', requestProtocol: 'openai', upstreamProtocol: 'openai',
  errorMessage: 'synthetic upstream error', latencyMs: 1,
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function configRepositories(webhookUrl, destination) {
  let reads = 0;
  const drizzle = {
    select() {
      const index = reads++;
      return {
        from() { return this; },
        where() { return this; },
        async limit() {
          return [{ value: destination === 'wecom' ? (index === 0 ? webhookUrl : null)
            : (index === 1 ? webhookUrl : null) }];
        },
      };
    },
  };
  return { client: { driver: 'postgres', drizzle } };
}

for (const destination of ['wecom', 'feishu']) for (const status of [307, 308]) {
  test(`alert ${destination} HTTP ${status} does not replay delivered POST at Location`, { timeout: 10_000 }, async t => {
    const hits = [];
    const target = createServer((request, response) => {
      const hit = { kind: 'target', method: request.method, bytes: 0 };
      hits.push(hit);
      request.on('data', chunk => { hit.bytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"errcode":0,"StatusCode":0}');
      });
    });
    const targetUrl = await listen(target);
    const origin = createServer((request, response) => {
      const hit = { kind: 'origin', method: request.method, bytes: 0 };
      hits.push(hit);
      request.on('data', chunk => { hit.bytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(status, { Location: `${targetUrl}/sink` });
        response.end();
      });
    });
    const originUrl = await listen(origin);
    t.after(async () => {
      for (const server of [origin, target]) {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
    });
    const outcome = await fireGatewayErrorWebhooks(
      configRepositories(`${originUrl}/hook`, destination), alertContext,
    ).then(() => null, error => error);
    t.diagnostic(JSON.stringify(hits));
    assert.ok(outcome instanceof Error && outcome.message.includes(`HTTP ${status}`));
    assert.equal(hits.filter(hit => hit.kind === 'origin').length, 1);
    assert.equal(hits.filter(hit => hit.kind === 'target').length, 0);
    assert.equal(hits[0].method, 'POST');
    assert.ok(hits[0].bytes > 0);
  });
}
