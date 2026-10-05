import fs from 'node:fs';
import assert from 'node:assert/strict';
const [origin, label] = process.argv.slice(2); assert.ok(['https://cinatoken-web.cinagroup.workers.dev', 'https://cinatoken.com'].includes(origin)); assert.match(label ?? '', /^[a-z0-9-]+$/);
const report = { at: new Date().toISOString(), origin, requests: [], actualExit: null };
for (const path of ['/en', '/en/models', '/account/keys', '/admin/models', '/web-assets/logo.png', '/web-assets/static/absent-cutover-smoke.js']) {
  try {
    const response = await fetch(origin + path, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const body = await response.arrayBuffer();
    report.requests.push({ path, method: 'HEAD', status: response.status, bytes: body.byteLength, cacheControl: response.headers.get('cache-control'), contentType: response.headers.get('content-type') });
  } catch (error) { report.requests.push({ path, error: error.message }); }
}
report.actualExit = report.requests.every(r => r.bytes === 0 && r.status === (r.path.includes('absent-') ? 404 : 200)) ? 0 : 1;
report.finishedAt = new Date().toISOString(); fs.writeFileSync(new URL(label + '.heads-proof.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report)); process.exitCode = report.actualExit;
