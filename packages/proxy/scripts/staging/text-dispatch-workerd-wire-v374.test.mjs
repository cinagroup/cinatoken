// Native Worker fetch -> owned loopback HTTP provider. No cloud origin or credential.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { proxyChatCompletions } from '../../src/services/proxy.ts';
import { createRequestDispatchBudget } from '../../src/services/request-dispatch-budget.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function makeFixture(t) {
  const hits = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://loopback.invalid').pathname;
    const hit = { path, method: request.method, bytes: 0, credential: request.headers.authorization };
    hits.push(hit);
    request.on('data', chunk => { hit.bytes += chunk.length; });
    request.on('end', () => {
      if (path === '/sink') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"error":"unexpected redirect follow"}');
      } else if (path.includes('/redirect307/') || path.includes('/redirect308/')) {
        response.writeHead(path.includes('/redirect307/') ? 307 : 308, { Location: `${origin}/sink` });
        response.end();
      } else if (path.includes('/reject429/')) {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end('{"error":{"message":"synthetic explicit rejection"}}');
      } else if (path.includes('/reset/')) {
        request.socket.destroy();
      } else {
        response.writeHead(500);
        response.end('invalid fixture mode');
      }
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = await listen(server);
  const source = `
    import { proxyChatCompletions } from './packages/proxy/src/services/proxy.ts';
    import { createRequestDispatchBudget } from './packages/proxy/src/services/request-dispatch-budget.ts';
    const origin = ${JSON.stringify(origin)};
    function route(mode, index) {
      return {
        targetId: 'worker-target-' + index, modelSurfaceId: null, routePoolId: 'worker-pool',
        providerId: 'worker-provider-' + index, providerName: 'synthetic',
        providerModelName: 'synthetic-model', gatewayModelId: 'public/synthetic',
        upstreamProtocol: 'openai', upstreamOperation: 'chat', adapter: 'passthrough',
        providerEndpoints: { openai: { base: origin + '/v1/' + mode } },
        providerApiKey: 'synthetic-worker-secret', providerSharedChannelType: null,
        priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
        customParams: null, routeGroup: 'default', routePriority: index, routeWeight: 1,
        providerKeyId: 'worker-key-' + index, providerKeyLabel: null, providerKeyFingerprint: null,
      };
    }
    export default {
      async fetch(request) {
        const mode = new URL(request.url).pathname.slice(1);
        if (!['redirect307','redirect308','reject429','reset'].includes(mode))
          return new Response('invalid fixture mode', { status: 400 });
        const budget = createRequestDispatchBudget();
        try {
          const result = await proxyChatCompletions(
            {}, Array.from({ length: 40 }, (_, index) => route(mode, index)),
            { messages: [{ role: 'user', content: 'synthetic Worker request' }] },
            undefined,
            { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget },
          );
          const status = result.response.status;
          await result.response.body?.cancel();
          await result.usagePromise;
          return Response.json({ status, permits: budget.snapshot().permitsConsumed,
            unknown: result.meta?.upstreamOutcomeUnknown === true,
            failoverForbidden: result.meta?.failoverForbidden === true });
        } catch (error) {
          return Response.json({ thrown: String(error?.name ?? error),
            permits: budget.snapshot().permitsConsumed,
            unknown: error?.upstreamOutcomeUnknown === true });
        }
      },
    };
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: repoRoot,
    sourcefile: 'text-dispatch-workerd-wire-v374-fixture.js' }, bundle: true,
    format: 'esm', platform: 'node', target: 'es2022', conditions: ['workerd'], write: false });
  assert.equal(bundle.outputFiles.length, 1);
  return { hits, origin, script: bundle.outputFiles[0].text };
}

test('production Chat dispatch bundles into a native Worker with fixed loopback provider', async t => {
  const fixture = await makeFixture(t);
  assert.ok(fixture.script.includes(fixture.origin));
  assert.ok(fixture.script.includes('synthetic-worker-secret'));
});

test('native Worker fetch never follows 307/308 or retries an unknown send; explicit 429 uses three permits',
  { timeout: 45000 }, async t => {
    if (process.platform === 'win32' && process.env.C02_RUN_NATIVE_WORKER !== '1') {
      t.skip('Windows workerd startup exits 0xc0000005 before Worker code; run this case on Linux CI');
      return;
    }
    const fixture = await makeFixture(t);
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: fixture.script, compatibilityDate: '2026-08-24',
      compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], cf: false,
      host: '127.0.0.1', port: 0,
    }));
    t.after(() => mf.dispose());
    for (const [mode, expectedSends, expectedUnknown] of [
      ['redirect307', 1, true], ['redirect308', 1, true],
      ['reset', 1, true], ['reject429', 3, false],
    ]) {
      fixture.hits.length = 0;
      const response = await mf.dispatchFetch(`http://worker-fixture.invalid/${mode}`);
      assert.equal(response.status, 200, mode);
      const result = await response.json();
      assert.equal(fixture.hits.length, expectedSends, `${mode}: physical provider requests`);
      assert.equal(result.permits, expectedSends, `${mode}: logical permits`);
      assert.equal(result.unknown, expectedUnknown, `${mode}: unknown classification`);
      assert.equal(result.failoverForbidden, true, `${mode}: no successor after terminal outcome`);
      assert.ok(fixture.hits.every(hit => hit.path.includes(`/${mode}/`) && hit.method === 'POST'
        && hit.bytes > 0 && hit.credential === 'Bearer synthetic-worker-secret'), mode);
      assert.equal(fixture.hits.some(hit => hit.path === '/sink'), false, `${mode}: redirect destination`);
      t.diagnostic(JSON.stringify({ mode, workerPermits: result.permits,
        providerPosts: fixture.hits.length, redirectTargetPosts: 0 }));
    }
  });

test('a retrying HTTP intermediary can turn one admitted Gateway fetch into two physical provider POSTs',
  { timeout: 10000 }, async t => {
    const providerHits = [];
    let providerOrigin;
    const provider = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      providerHits.push({ path: request.url, method: request.method,
        body: Buffer.concat(chunks).toString('utf8'), credential: request.headers.authorization });
      if (request.url === '/sink') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion',
          created: 1, model: 'synthetic-model', choices: [{ index: 0,
            message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } else {
        response.writeHead(307, { Location: `${providerOrigin}/sink` });
        response.end();
      }
    });
    t.after(async () => {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    });
    providerOrigin = await listen(provider);

    const relayHits = [];
    const relay = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        relayHits.push(request.url);
        // Deliberately use a default-follow transport to show the unobservable
        // inner hop. The Gateway's own fetch has redirect: 'error'.
        const upstream = await fetch(`${providerOrigin}${request.url}`, {
          method: request.method,
          headers: { Authorization: request.headers.authorization,
            'Content-Type': request.headers['content-type'] },
          body: Buffer.concat(chunks),
        });
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain' });
        response.end(await upstream.text());
      } catch (error) {
        response.writeHead(502);
        response.end(String(error));
      }
    });
    t.after(async () => {
      relay.closeAllConnections();
      await new Promise(resolve => relay.close(resolve));
    });
    const relayOrigin = await listen(relay);
    const routes = Array.from({ length: 40 }, (_, index) => ({
      targetId: `relay-target-${index}`, modelSurfaceId: null, routePoolId: 'relay-pool',
      providerId: `relay-provider-${index}`, providerName: 'synthetic',
      providerModelName: 'synthetic-model', gatewayModelId: 'public/synthetic',
      upstreamProtocol: 'openai', upstreamOperation: 'chat', adapter: 'passthrough',
      providerEndpoints: { openai: { base: `${relayOrigin}/v1` } },
      providerApiKey: 'synthetic-relay-secret', providerSharedChannelType: null,
      priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
      customParams: null, routeGroup: 'default', routePriority: index, routeWeight: 1,
      providerKeyId: `relay-key-${index}`, providerKeyLabel: null, providerKeyFingerprint: null,
    }));
    const budget = createRequestDispatchBudget();
    const result = await proxyChatCompletions({}, routes, { messages: [{ role: 'user', content: 'fixture' }] },
      undefined, { affinityKey: '', tierKeyPrefix: '', strategy: 'weight_priority', dispatchBudget: budget });
    assert.equal(result.response.status, 200);
    await result.response.body?.cancel();
    await result.usagePromise;
    assert.equal(budget.snapshot().permitsConsumed, 1);
    assert.equal(relayHits.length, 1);
    assert.equal(providerHits.length, 2);
    assert.deepEqual(providerHits.map(hit => hit.method), ['POST', 'POST']);
    assert.deepEqual(providerHits.map(hit => hit.path), ['/v1/chat/completions', '/sink']);
    assert.equal(providerHits[0].body, providerHits[1].body);
    assert.deepEqual(providerHits.map(hit => hit.credential),
      ['Bearer synthetic-relay-secret', 'Bearer synthetic-relay-secret']);
    t.diagnostic(JSON.stringify({ gatewayPermits: budget.snapshot().permitsConsumed,
      relayPosts: relayHits.length, providerPosts: providerHits.length,
      repeatedBodyAndCredential: true }));
  });
