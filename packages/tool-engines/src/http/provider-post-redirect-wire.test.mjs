import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { searchBochaWeb } from '../web-search/bocha.ts';
import { searchCleverSeeWeb } from '../web-search/cleversee.ts';
import { searchTavilyWeb } from '../web-search/tavily.ts';
import { searchTencentWsaWeb } from '../web-search/tencent-wsa.ts';
import { fetchFirecrawlUrl } from '../web-fetch/firecrawl.ts';
import { fetchTavilyUrl } from '../web-fetch/tavily.ts';
import { fetchJinaUrl } from '../web-fetch/jina.ts';
import { deepSearchFirecrawl } from '../web-deep-search/firecrawl.ts';
import { deepSearchJina } from '../web-deep-search/jina.ts';
import { tencentTmsDriver } from '../ai-detection/drivers/tencent-tms.ts';

const fixtures = [
  { name: 'search.bocha', run: fetchImpl => searchBochaWeb({ apiKey: 'synthetic', query: 'synthetic', fetchImpl }) },
  { name: 'search.cleversee', run: fetchImpl => searchCleverSeeWeb({ apiKey: 'synthetic', query: 'synthetic', fetchImpl }) },
  { name: 'search.tavily', run: fetchImpl => searchTavilyWeb({ apiKey: 'synthetic', query: 'synthetic', fetchImpl }) },
  { name: 'search.tencent-wsa', run: fetchImpl => searchTencentWsaWeb({ apiKey: 'synthetic', query: 'synthetic', fetchImpl }) },
  { name: 'fetch.firecrawl', run: fetchImpl => fetchFirecrawlUrl({ apiKey: 'synthetic', url: 'https://example.invalid/', fetchImpl }) },
  { name: 'fetch.tavily', run: fetchImpl => fetchTavilyUrl({ apiKey: 'synthetic', url: 'https://example.invalid/', fetchImpl }) },
  { name: 'fetch.jina', run: fetchImpl => fetchJinaUrl({ apiKey: 'synthetic', url: 'https://example.invalid/', fetchImpl }) },
  { name: 'deep.firecrawl', run: fetchImpl => deepSearchFirecrawl({ apiKey: 'synthetic', query: 'synthetic', fetchImpl }) },
  { name: 'deep.jina', run: fetchImpl => deepSearchJina({ apiKey: 'synthetic', query: 'synthetic', fetchImpl }) },
  { name: 'detection.tencent-tms', run: fetchImpl => tencentTmsDriver.detectSegment('synthetic', {
    entry: { secretId: 'synthetic', secretKey: 'synthetic', region: 'ap-singapore' },
  }, { fetchImpl }) },
];

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const fixture of fixtures) for (const status of [307, 308]) {
  test(`${fixture.name} HTTP ${status} does not resend provider POST at Location`, { timeout: 10_000 }, async t => {
    const hits = [];
    const target = createServer((request, response) => {
      const hit = { kind: 'target', method: request.method, bytes: 0 };
      hits.push(hit);
      request.on('data', chunk => { hit.bytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    const targetUrl = await listen(target);
    const origin = createServer((request, response) => {
      const hit = { kind: 'origin', method: request.method, bytes: 0 };
      hits.push(hit);
      request.on('data', chunk => { hit.bytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(status, { 'Content-Type': 'application/json', Location: `${targetUrl}/sink` });
        response.end('{}');
      });
    });
    const originUrl = await listen(origin);
    t.after(async () => {
      for (const server of [origin, target]) {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
    });
    let directFetchCalls = 0;
    const nativeFetch = globalThis.fetch;
    const fetchImpl = (input, init) => {
      directFetchCalls++;
      const requested = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(requested.protocol, 'https:');
      assert.notEqual(requested.hostname, '127.0.0.1');
      const headers = new Headers(init?.headers);
      // Tencent signs its canonical Host; the loopback transport uses its own.
      headers.delete('Host');
      return nativeFetch(`${originUrl}/provider`, { ...init, headers });
    };
    const outcome = await fixture.run(fetchImpl).then(() => null, error => error);
    t.diagnostic(JSON.stringify({ directFetchCalls, hits }));
    assert.equal(directFetchCalls, 1);
    assert.equal(hits.filter(hit => hit.kind === 'origin').length, 1);
    assert.equal(hits.filter(hit => hit.kind === 'target').length, 0);
    assert.equal(hits[0].method, 'POST');
    assert.ok(hits[0].bytes > 0);
    assert.ok(outcome instanceof Error, 'redirect must remain an upstream error');
    assert.equal(outcome.upstreamOutcome, 'unknown');
  });
}
