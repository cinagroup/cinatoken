// Successor to the frozen v374 fixture: Wrangler Worker package conditions and error evidence.
// Native Worker fetch -> owned loopback HTTP provider. No cloud origin or credential.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { builtinModules } from 'node:module';
import { test as nativeTest, after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { proxyChatCompletions } from '../../src/services/proxy.ts';
import { createRequestDispatchBudget } from '../../src/services/request-dispatch-budget.ts';

function errorDetails(error, depth = 0) {
  if (depth > 4) return { message: 'cause depth exceeded' };
  return { name: error?.name ?? null, message: error?.message ?? String(error),
    code: error?.code ?? null, stack: error?.stack ?? null,
    cause: error?.cause ? errorDetails(error.cause, depth + 1) : null };
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const report = { schemaVersion: 1, fixture: 'text-dispatch-workerd-wire-worker-conditions-successor',
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  nativeWorkerOptIn: process.env.C02_RUN_NATIVE_WORKER === '1',
  network: 'owned 127.0.0.1 HTTP servers; no remote SQL, cloud origin or paid Provider',
  cases: [], bundles: [], nativeModes: [], relay: null, cleanup: [], cleanupErrors: [], sourcePins: [] };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePins = new Map();
async function pin(path) {
  const absolute = resolve(repoRoot, path);
  const value = { path, sha256: sha256(await readFile(absolute)) };
  const previous = sourcePins.get(path);
  if (previous) assert.deepEqual(value, previous, 'source drift during bundle creation');
  sourcePins.set(path, value);
}
function test(name, optionsOrBody, body) {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  const run = typeof optionsOrBody === 'function' ? optionsOrBody : body;
  return nativeTest(name, options, async t => {
    const entry = { name, status: 'RUNNING' };
    report.cases.push(entry);
    const start = performance.now();
    try { await run(t); if (entry.status === 'RUNNING') entry.status = 'PASS'; }
    catch (error) { entry.status = 'FAIL'; entry.error = errorDetails(error); throw error; }
    finally { entry.elapsedMs = performance.now() - start; }
  });
}
async function cleanup(name, operation) {
  try { await operation(); report.cleanup.push({ resource: name, closed: true }); }
  catch (error) { report.cleanupErrors.push({ resource: name, error: errorDetails(error) }); throw error; }
}
after(async () => {
  for (const path of [
    'packages/proxy/scripts/staging/text-dispatch-workerd-wire-v374.test.mjs',
    'packages/proxy/scripts/staging/text-dispatch-workerd-wire-worker-conditions-successor.test.mjs',
    'packages/core/package.json', 'package-lock.json',
    'packages/core/dist/index.js',
    'packages/proxy/src/services/proxy.ts',
    'packages/proxy/src/services/request-dispatch-budget.ts',
    'node_modules/esbuild/package.json', 'node_modules/miniflare/package.json',
    'node_modules/workerd/package.json',
  ]) await pin(path);
  report.sourcePins = [...sourcePins.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const value of report.sourcePins) {
    assert.equal(sha256(await readFile(resolve(repoRoot, value.path))), value.sha256, value.path);
  }
  report.endedAt = new Date().toISOString();
  report.nodeExecutableSha256 = sha256(await readFile(process.execPath));
  report.executionScope = { expectedCases: 3, executedCases: report.cases.length,
    expectedNativeModes: 4, executedNativeModes: report.nativeModes.length,
    nativeMatrixComplete: report.nativeModes.length === 4 };
  report.status = report.cases.some(item => item.status === 'FAIL') || report.cleanupErrors.length ? 'FAIL'
    : report.cases.length !== 3 || report.nativeModes.length !== 4
      || report.cases.some(item => item.status === 'SKIP') ? 'PARTIAL' : 'PASS';
  report.limitations = [
    'Browser package resolution matches Wrangler defaults; this dispatch-only esbuild fixture is not the deployed full Worker bundle.',
    'Windows native runtime failure is retained as FAIL when opted in; no native transport result can be inferred from it.',
    'The unsafe local relay counterexample does not establish actual deployed intermediary retry or redirect policy.',
  ];
  const dir = resolve(repoRoot, '.wrangler/publish-20260927/workerd-wire-successor');
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `report-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Worker wire successor report: ${path}`);
});

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
  t.after(() => cleanup('worker-provider', async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }));
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
    sourcefile: 'text-dispatch-workerd-wire-worker-conditions-successor-fixture.js' }, bundle: true,
    // Wrangler's default Worker package conditions select Core/src, rather than Core/node dist.
    // Native node:* imports are supplied by workerd's nodejs_compat.
    format: 'esm', platform: 'browser', target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    external: [...builtinModules, ...builtinModules.map(name => 'node:' + name)],
    metafile: true, write: false });
  assert.equal(bundle.outputFiles.length, 1);
  const inputs = Object.keys(bundle.metafile.inputs).map(path => path.replaceAll('\\', '/'));
  assert.ok(inputs.includes('packages/core/src/index.ts'), 'Worker must resolve Core source entry');
  assert.equal(inputs.some(path => path.startsWith('packages/core/dist/')), false, 'Worker must not rebundle Core Node dist');
  for (const path of inputs.filter(path => path !== 'text-dispatch-workerd-wire-worker-conditions-successor-fixture.js')) await pin(path);
  report.bundles.push({ platform: 'browser', conditions: ['workerd', 'worker', 'browser'],
    coreSource: true, coreDist: false, inputs, scriptSha256: sha256(bundle.outputFiles[0].contents),
    externalImports: bundle.metafile.outputs[Object.keys(bundle.metafile.outputs)[0]].imports });
  t.diagnostic(JSON.stringify({ platform: 'browser', conditions: ['workerd', 'worker', 'browser'],
    coreSource: true, coreDist: false, inputCount: inputs.length }));
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
      report.cases.at(-1).status = 'SKIP';
      return;
    }
    const fixture = await makeFixture(t);
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: fixture.script, compatibilityDate: '2026-08-24',
      compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], cf: false,
      host: '127.0.0.1', port: 0,
    }));
    t.after(() => cleanup('worker-runtime', () => mf.dispose()));
    for (const [mode, expectedSends, expectedUnknown] of [
      ['redirect307', 1, true], ['redirect308', 1, true],
      ['reset', 1, true], ['reject429', 3, false],
    ]) {
      fixture.hits.length = 0;
      const response = await mf.dispatchFetch(`http://worker-fixture.invalid/${mode}`);
      assert.equal(response.status, 200, mode);
      const responseBody = await response.text();
      const result = JSON.parse(responseBody);
      t.diagnostic(JSON.stringify({ mode, result, hits: fixture.hits }));
      assert.equal(fixture.hits.length, expectedSends, `${mode}: physical provider requests`);
      assert.equal(result.permits, expectedSends, `${mode}: logical permits`);
      assert.equal(result.unknown, expectedUnknown, `${mode}: unknown classification`);
      assert.equal(result.failoverForbidden, true, `${mode}: no successor after terminal outcome`);
      assert.ok(fixture.hits.every(hit => hit.path.includes(`/${mode}/`) && hit.method === 'POST'
        && hit.bytes > 0 && hit.credential === 'Bearer synthetic-worker-secret'), mode);
      assert.equal(fixture.hits.some(hit => hit.path === '/sink'), false, `${mode}: redirect destination`);
      report.nativeModes.push({ mode, result, providerPosts: fixture.hits.length, redirectTargetPosts: 0 });
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
    t.after(() => cleanup('relay-provider', async () => {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    }));
    providerOrigin = await listen(provider);

    const relayHits = [];
    const relayErrors = [];
    const relay = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        relayHits.push(request.url);
        const receivedBytes = Buffer.concat(chunks);
        const replayBody = receivedBytes.toString('utf8');
        assert.deepEqual(Buffer.from(replayBody, 'utf8'), receivedBytes,
          'synthetic JSON must retain every byte when converted to a replayable body');
        // Deliberately use a default-follow transport to show the unobservable
        // inner hop. The Gateway's own fetch has redirect: 'error'.
        // Node 22's fetch transfers a Buffer backing store on its first send, so
        // its 307 replay fails on a detached ArrayBuffer. This local JSON fixture
        // uses a byte-checked string; production upload handling is unchanged.
        const upstream = await fetch(`${providerOrigin}${request.url}`, {
          method: request.method,
          headers: { Authorization: request.headers.authorization,
            'Content-Type': request.headers['content-type'] },
          body: replayBody,
        });
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain' });
        response.end(await upstream.text());
      } catch (error) {
        response.writeHead(502);
        relayErrors.push(errorDetails(error));
        t.diagnostic(JSON.stringify({ relayFailure: relayErrors.at(-1), providerHits, relayHits }));
        response.end(JSON.stringify({ relayFailure: relayErrors.at(-1) }));
      }
    });
    t.after(() => cleanup('relay', async () => {
      relay.closeAllConnections();
      await new Promise(resolve => relay.close(resolve));
    }));
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
    report.relay = { gatewayPermits: budget.snapshot().permitsConsumed,
      relayPosts: relayHits.length, providerPosts: providerHits.length, providerHits, relayErrors,
      responseStatus: result.response.status };
    assert.equal(result.response.status, 200, JSON.stringify({
      responseBody: result.response.status === 200 ? null : await result.response.text(),
      relayErrors, relayHits, providerHits }));
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
    report.relay = { gatewayPermits: budget.snapshot().permitsConsumed,
      relayPosts: relayHits.length, providerPosts: providerHits.length,
      repeatedBodyAndCredential: true, providerHits, relayErrors };
    t.diagnostic(JSON.stringify({ gatewayPermits: budget.snapshot().permitsConsumed,
      relayPosts: relayHits.length, providerPosts: providerHits.length,
      repeatedBodyAndCredential: true }));
  });
