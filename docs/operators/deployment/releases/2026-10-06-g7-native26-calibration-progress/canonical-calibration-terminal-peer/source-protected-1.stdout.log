// Test-only HTTP cancellation comparison; getWorker.fetch already uses a special
// HTTP proxy bridge. This does not assume RPC loses cancellation, or that the
// direct HTTP entry fixes the unobserved asynchronous holder KV cancellation.
// Test-only input successor to the frozen date successor. The locked Miniflare
// Request brand differs from Node native Request; pass the same URL and init
// directly. No body, header, binding, cancellation or date contract changes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  SYNTHETIC_CREDENTIAL_V364,
  SYNTHETIC_PROVIDER_URL_V364,
  SYNTHETIC_PUBLIC_BODY_V364,
  SYNTHETIC_QUOTE_V364,
  SYNTHETIC_ROUTE_V364,
} from './chat-holder-synthetic-v364.ts';

// Test-only successor: locked workerd 1.20260828.1 rejected the frozen fixture
// date 2026-09-25 before Worker startup; its reported maximum is 2026-09-04.
// Only these local Miniflare instances use the supported date. Frozen JSONC
// identity, bindings, flags, routes and all contract assertions stay intact.
// This does not verify 2026-09-25 semantics or enable any production holder.
const fixtureRuntimeCompatibilityDate = '2026-09-04';
const base = new URL('./', import.meta.url);
const config = name => JSON.parse(readFileSync(new URL(name, base), 'utf8'));
const gatewayConfig = config('wrangler.chat-holder-gateway-v364.jsonc');
const privateConfig = config('wrangler.chat-holder-private-v364.jsonc');
let windowsWorkerdStartupFailure = null;

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

async function workerScript(main) {
  const entry = fileURLToPath(new URL(main, base));
  const built = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  assert.equal(built.outputFiles.length, 1);
  return built.outputFiles[0].text;
}

// A dedicated socket makes the transport cancellation explicit. In particular,
// this does not depend on cancelling Miniflare's wrapped Undici response body.
function postStreamingHttp(url, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST', agent: false,
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('fixture HTTP socket timed out')));
    request.once('response', response => {
      response.on('error', reject);
      const chunks = [];
      let size = 0;
      const onData = chunk => {
        chunks.push(chunk);
        size += chunk.byteLength;
        if (size > 128) {
          request.destroy(); response.destroy();
          reject(new Error('fixture first SSE frame exceeded its bound'));
          return;
        }
        const firstChunk = Buffer.concat(chunks);
        if (!firstChunk.includes('\n\n')) return;
        response.pause();
        response.removeListener('data', onData);
        resolve({
          status: response.statusCode, headers: response.headers, firstChunk,
          async cancel() {
            if (!response.closed) {
              const closed = new Promise(resolveClosed => response.once('close', resolveClosed));
              request.destroy(); response.destroy();
              await closed;
            }
            return { requestDestroyed: request.destroyed, responseDestroyed: response.destroyed,
              responseComplete: response.complete };
          },
        });
      };
      response.on('data', onData);
      response.once('end', () => reject(new Error('fixture response ended before its first SSE frame')));
    });
    request.end(body);
  });
}

async function fixture(t) {
  if (process.platform === 'win32' && process.env.C04_RUN_NATIVE_WORKER !== '1') {
    t.skip('Windows workerd 0xc0000005 startup reproduced; set C04_RUN_NATIVE_WORKER=1 to retry native execution');
    return null;
  }
  if (windowsWorkerdStartupFailure) { t.skip(windowsWorkerdStartupFailure); return null; }
  const gatewayScript = await workerScript(gatewayConfig.main);
  const privateScript = await workerScript(privateConfig.main);
  assert.equal(gatewayScript.includes(SYNTHETIC_CREDENTIAL_V364), false);
  assert.equal(gatewayScript.includes(SYNTHETIC_PROVIDER_URL_V364), false);
  assert.equal(privateScript.includes(SYNTHETIC_CREDENTIAL_V364), true);
  assert.equal(privateScript.includes(SYNTHETIC_PROVIDER_URL_V364), true);
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    host: '127.0.0.1',
    port: 0,
    workers: [
      {
        name: gatewayConfig.name,
        modules: true,
        script: gatewayScript,
        compatibilityDate: fixtureRuntimeCompatibilityDate,
        compatibilityFlags: gatewayConfig.compatibility_flags,
        serviceBindings: { TEXT_HOLDER: privateConfig.name },
      },
      {
        name: privateConfig.name,
        modules: true,
        script: privateScript,
        compatibilityDate: fixtureRuntimeCompatibilityDate,
        compatibilityFlags: privateConfig.compatibility_flags,
        kvNamespaces: { OBSERVATIONS: privateConfig.kv_namespaces[0].id },
      },
    ],
  }));
  t.after(() => mf.dispose());
  let gatewayBindings;
  try { gatewayBindings = await mf.getBindings(gatewayConfig.name); }
  catch (error) {
    if (process.platform === 'win32' && error?.code === 'ERR_RUNTIME_FAILURE'
      && /0xc0000005: access violation/u.test(String(error.message))) {
      windowsWorkerdStartupFailure = 'native workerd startup exited with Windows 0xc0000005 before Worker code ran';
      t.diagnostic(windowsWorkerdStartupFailure);
      t.skip(windowsWorkerdStartupFailure);
      return null;
    }
    throw error;
  }
  assert.deepEqual(Object.keys(gatewayBindings), ['TEXT_HOLDER']);
  const { OBSERVATIONS } = await mf.getBindings(privateConfig.name);
  assert.ok(OBSERVATIONS);
  const gateway = await mf.getWorker(gatewayConfig.name);
  async function post(body, contentType = 'application/json') {
    return gateway.fetch('https://gateway.fixture.invalid/fixture/complete-text', {
      method: 'POST', headers: { 'Content-Type': contentType }, body,
    });
  }
  async function postHttp(body, contentType = 'application/json') {
    const fixtureRuntimeUrl = await mf.ready;
    assert.equal(fixtureRuntimeUrl.hostname, '127.0.0.1');
    return postStreamingHttp(new URL('/fixture/complete-text', fixtureRuntimeUrl), body, contentType);
  }
  return { post, postHttp, observations: OBSERVATIONS };
}

test('v364 configs keep the synthetic holder private and bind only the named holder', () => {
  assert.equal(gatewayConfig.workers_dev, false);
  assert.equal(privateConfig.workers_dev, false);
  assert.equal(gatewayConfig.preview_urls, false);
  assert.equal(privateConfig.preview_urls, false);
  assert.deepEqual(gatewayConfig.routes, []);
  assert.deepEqual(privateConfig.routes, []);
  assert.deepEqual(gatewayConfig.services, [{ binding: 'TEXT_HOLDER', service: privateConfig.name, remote: false }]);
  assert.equal(privateConfig.services, undefined);
  assert.deepEqual(privateConfig.kv_namespaces.map(v => v.binding), ['OBSERVATIONS']);
  assert.deepEqual(gatewayConfig.triggers, { crons: [] });
  assert.deepEqual(privateConfig.triggers, { crons: [] });
  assert.equal(createHash('sha256').update(SYNTHETIC_PUBLIC_BODY_V364).digest('hex'), SYNTHETIC_QUOTE_V364.finalBodySha256);
});

test('HTTP fixture cancellation closes its dedicated TCP response before completion', { timeout: 10000 }, async t => {
  let requestCount = 0;
  let requestBody = '';
  let peerClosed;
  const closed = new Promise(resolve => { peerClosed = resolve; });
  const server = createServer((request, response) => {
    requestCount++;
    request.setEncoding('utf8');
    request.on('data', chunk => { requestBody += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': holder-ready\n\n');
    });
    response.once('close', peerClosed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const body = JSON.stringify(envelope());
  const response = await postStreamingHttp(new URL(`http://127.0.0.1:${server.address().port}/fixture/complete-text`), body);
  t.after(() => response.cancel());
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(response.firstChunk.toString(), ': holder-ready\n\n');
  assert.deepEqual(await response.cancel(), {
    requestDestroyed: true, responseDestroyed: true, responseComplete: false,
  });
  await closed;
  assert.equal(requestCount, 1);
  assert.equal(requestBody, body);
});

test('private Worker rejects oversized, foreign, and malformed six-field requests without disclosing holder data', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const valid = envelope();
  const cases = [
    ['unknown field', JSON.stringify({ ...valid, providerUrl: SYNTHETIC_PROVIDER_URL_V364 }), 400],
    ['credential field', JSON.stringify({ ...valid, credential: SYNTHETIC_CREDENTIAL_V364 }), 400],
    ['route target', JSON.stringify({ ...valid, routeTargetId: 'foreign' }), 400],
    ['candidate index', JSON.stringify({ ...valid, candidateIndex: 0 }), 400],
    ['quoted body', JSON.stringify({ ...valid, finalBodyUtf8: valid.finalBodyUtf8.replace('public request', 'changed request') }), 400],
    ['attempt nonce', JSON.stringify({ ...valid, attemptNonce: 'invalid' }), 400],
    ['invalid JSON', '{', 400],
    ['wire byte cap', JSON.stringify({ ...valid, overflow: 'x'.repeat(6 * 1_048_576 + 8_192) }), 413],
  ];
  for (const [label, body, expected] of cases) {
    const response = await f.post(body);
    assert.equal(response.status, expected, label);
    const text = await response.text();
    assert.equal(text, '{"error":"holder_request_rejected"}', label);
    assert.equal(text.includes(SYNTHETIC_CREDENTIAL_V364), false, label);
    assert.equal(text.includes(SYNTHETIC_PROVIDER_URL_V364), false, label);
  }
  assert.equal(await f.observations.get(`accepted:${valid.attemptNonce}`), null);
});

test('one holder Response streams through the Service Binding before its final chunk is released', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const e = envelope();
  const response = await f.post(JSON.stringify(e));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(response.headers.has('Location'), false);
  assert.equal(await f.observations.get(`accepted:${e.attemptNonce}`), 'one');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), ': holder-ready\n\n');
  const secondPromise = reader.read();
  const beforeRelease = await Promise.race([secondPromise.then(() => 'second'), new Promise(resolve => setTimeout(() => resolve('held'), 50))]);
  assert.equal(beforeRelease, 'held');
  await f.observations.put(`release:${e.attemptNonce}`, 'yes');
  const second = await secondPromise;
  const text = new TextDecoder().decode(second.value);
  assert.equal(text, 'data: {"text":"synthetic streamed answer"}\n\ndata: [DONE]\n\n');
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  assert.equal(text.includes(SYNTHETIC_CREDENTIAL_V364), false);
  assert.equal(text.includes(SYNTHETIC_PROVIDER_URL_V364), false);
  assert.equal(await f.observations.get(`cancel:${e.attemptNonce}`), null);
});

test('response-body cancellation is observed inside the private holder', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const e = envelope();
  const response = await f.postHttp(JSON.stringify(e));
  t.after(() => response.cancel());
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(await f.observations.get(`accepted:${e.attemptNonce}`), 'one');
  assert.equal(response.firstChunk.toString(), ': holder-ready\n\n');
  assert.deepEqual(await response.cancel(), {
    requestDestroyed: true, responseDestroyed: true, responseComplete: false,
  });
  let observed = null;
  for (let n = 0; n < 100 && observed === null; n++) {
    observed = await f.observations.get(`cancel:${e.attemptNonce}`);
    if (observed === null) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(observed, 'observed');
  assert.equal(await f.observations.get(`release:${e.attemptNonce}`), null);
  assert.equal(await f.observations.get(`accepted:${e.attemptNonce}`), 'one');
});
