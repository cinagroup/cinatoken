import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [origin, label, mode] = process.argv.slice(2);
assert.ok(['https://cinatoken-web.cinagroup.workers.dev', 'https://cinatoken.com'].includes(origin));
assert.match(label ?? '', /^[a-z0-9-]+$/);
const cases = mode === 'baseline' ? ['/', '/en', '/en/models', '/en/providers', '/robots.txt', '/sitemap.xml', '/api/public/catalog/models', '/api/user/me'] : ['/', '/en', '/en/models', '/en/providers', '/en/compare', '/en/chat', '/en/rankings', '/en/benchmarks', '/zh', '/ja', '/ko', '/robots.txt', '/sitemap.xml', '/account', '/account/keys', '/account/withdraw', '/admin', '/admin/models', '/admin/withdrawals', '/api/public/catalog/models', '/api/public/catalog/providers', '/api/user/me', '/api/admin/models'];
const report = { at: new Date().toISOString(), origin, mode, requests: [], actualExit: null };
for (const p of cases) {
  try {
    const response = await fetch(origin + p, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    report.requests.push({ path: p, method: 'GET', status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control'), location: response.headers.get('location'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), webAssets: text.includes('/web-assets/'), nextAssets: text.includes('/_next/'), title: text.match(/<title>([^<]*)<\/title>/)?.[1] ?? null, noIndex: response.headers.get('x-robots-tag'), canonical: text.match(/rel="canonical" href="([^"]+)"/)?.[1] ?? null, unauthorized: response.status === 401 && text.includes('Unauthorized') });
  } catch (error) { report.requests.push({ path: p, error: error.message }); }
}
if (mode === 'baseline') report.actualExit = 0;
else report.actualExit = report.requests.every(r => r.path === '/' ? r.status === 308 && r.location === '/en' : r.path.startsWith('/api/') ? (r.path.includes('/public/') ? r.status === 200 : r.status === 401) : r.status === 200 && (r.path === '/robots.txt' || r.path === '/sitemap.xml' || r.webAssets)) ? 0 : 1;
report.finishedAt = new Date().toISOString();
fs.writeFileSync(new URL(label + '.http.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
process.exitCode = report.actualExit;
