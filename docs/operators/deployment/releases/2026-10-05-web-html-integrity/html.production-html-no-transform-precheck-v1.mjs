import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Prepared only: network starts exclusively with --execute plus a fresh Root
// release config. This is a companion; sealed v2 browser assertions are unchanged.
const temp = path.dirname(fileURLToPath(import.meta.url));
const browserTemp = 'C:/Users/cina/AppData/Local/Temp/cinatoken-independent-web-browser-696cc8df85ea423aa0d2545df155d197';
const browserInputs = [
  ['execute-web-browser-observe-v2.mjs', 3432, 'ffd074ec8b52d5ce7c9dbd8a9dace29ec29130b661e0290e72f1f2d2d0424ed8'],
  ['production-web-browser-observe-v2.mjs', 15695, '415d123bbc71cfdb5d8ed02bf91f01d9021031358667cd7aaf2f0fd6edcd55be'],
  ['web-route-matrix.mjs', 1770, 'c8a3211d07979c037022f689aa442bd95de9b7c11843fb52b9ae9fa93ac01e61'],
];
const pages = [
  { route: '/en', kind: 'public' },
  { route: '/en/models', kind: 'public' },
  { route: '/account', kind: 'private' },
  { route: '/admin', kind: 'private' },
];
const bodyMarkers = ['cloudflareinsights.com', 'data-cf-beacon', '/cdn-cgi/rum'];
const securityHeaders = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const privateCSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
  "media-src 'self' blob:", "font-src 'self' data:",
  "connect-src 'self' wss: https://api.cinatoken.com wss://api.cinatoken.com",
  "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
  "frame-ancestors 'none'", "frame-src 'none'", "form-action 'self'",
].join('; ');
const publicNormalizedCSP = privateCSP.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'nonce-<32hex>'");
function raw(file) {
  const b = fs.readFileSync(file);
  return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
}
function sameRaw(observed, expected) {
  assert.equal(observed.bytes, expected.bytes);
  assert.equal(observed.sha256, expected.sha256);
}
function checkBrowserInputs() {
  return browserInputs.map(([name, bytes, sha256]) => {
    const value = raw(path.join(browserTemp, name));
    sameRaw(value, { bytes, sha256 });
    return value;
  });
}
function evaluateHTML({ status, headers, html }, kind) {
  assert.equal(status, 200, 'representative real HTML status');
  assert.match(headers['content-type'] ?? '', /^text\/html(?:\s*;|$)/i);
  const cacheTokens = (headers['cache-control'] ?? '').split(',').map(v => v.trim().toLowerCase());
  assert.deepEqual([...cacheTokens].sort(), ['no-store', 'no-transform'], 'retain existing no-store and add only no-transform');
  for (const [name, expected] of Object.entries(securityHeaders)) assert.equal(headers[name], expected, name);
  const csp = headers['content-security-policy'];
  assert.equal(typeof csp, 'string', 'existing CSP remains present');
  let nonce = null;
  if (kind === 'public') {
    const nonces = [...csp.matchAll(/'nonce-([a-f0-9]{32})'/g)];
    assert.equal(nonces.length, 1, 'one existing 32hex public script nonce');
    nonce = nonces[0][1];
    assert.equal(csp.replace(`'nonce-${nonce}'`, "'nonce-<32hex>'"), publicNormalizedCSP, 'public CSP otherwise byte-exact');
  } else {
    assert.equal(csp, privateCSP, 'private CSP byte-exact');
  }
  assert.match(html, /<html\b/i, 'HTML document, not a placeholder');
  assert.match(html, /\/web-assets\//, 'actual independent Web assets');
  const lowerHTML = html.toLowerCase();
  const markerHits = bodyMarkers.filter(marker => lowerHTML.includes(marker));
  assert.deepEqual(markerHits, [], 'actual response contains no injected beacon/rum markers');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map(match => ({
    attributes: match[1],
    src: /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1] ?? null,
    nonce: /\bnonce\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1] ?? null,
  }));
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    if (script.src) assert.match(script.src, /^\/web-assets\//, 'script src remains Web asset');
    if (kind === 'public') assert.equal(script.nonce, nonce, 'actual scripts use the existing CSP nonce');
  }
  return { cacheTokens, unchangedCSPExceptPublicNonce: true, markerHits, scriptCount: scripts.length,
    scriptSources: scripts.filter(s => s.src).map(s => s.src), publicScriptNonceMatches: kind === 'public' ? true : null };
}
function localControls() {
  const nonce = '0123456789abcdef0123456789abcdef';
  const make = kind => ({ status: 200, headers: { ...securityHeaders,
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-transform',
    'content-security-policy': kind === 'public' ? publicNormalizedCSP.replace('<32hex>', nonce) : privateCSP },
    html: `<html><script src="/web-assets/test.js"${kind === 'public' ? ` nonce="${nonce}"` : ''}></script></html>` });
  const proof = { positives: [], negatives: [] };
  for (const kind of ['public', 'private']) { evaluateHTML(make(kind), kind); proof.positives.push(kind); }
  const controls = [
    ['missing-no-transform', s => { s.headers['cache-control'] = 'no-store'; }],
    ['missing-no-store', s => { s.headers['cache-control'] = 'no-transform'; }],
    ['public-cache-added', s => { s.headers['cache-control'] = 'public, no-store, no-transform'; }],
    ['max-age-added', s => { s.headers['cache-control'] += ', max-age=3600'; }],
    ['duplicate-directive', s => { s.headers['cache-control'] += ', no-transform'; }],
    ['missing-csp', s => { delete s.headers['content-security-policy']; }],
    ['broadened-csp', s => { s.headers['content-security-policy'] += '; script-src-elem https:'; }],
    ['external-beacon', s => { s.html += '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>'; }],
    ['beacon-data-marker', s => { s.html += '<div data-cf-beacon="{}"></div>'; }],
    ['inline-rum-marker', s => { s.html += '<script>fetch("/cdn-cgi/rum")</script>'; }],
    ['unexpected-external-script', s => { s.html = s.html.replace('/web-assets/test.js', 'https://example.com/test.js'); }],
    ['public-nonce-mismatch', s => { s.html = s.html.replace(nonce, 'badnonce'); }],
    ['bad-security-header', s => { s.headers['x-frame-options'] = 'SAMEORIGIN'; }],
    ['redirect-response', s => { s.status = 302; }],
  ];
  for (const [name, mutate] of controls) {
    const sample = make('public'); mutate(sample);
    let rejected = false;
    try { evaluateHTML(sample, 'public'); } catch (error) { rejected = true; proof.negatives.push({ name, rejected, message: error.message }); }
    assert.equal(rejected, true, name);
  }
  return proof;
}
async function limitedHTML(response) {
  assert.ok(response.body, 'real HTML body');
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; assert.ok(bytes <= 1024 * 1024, 'bounded HTML body'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
const [mode, labelOrOutput, configPath] = process.argv.slice(2);
if (mode === '--controls-only') {
  assert.ok(labelOrOutput && path.dirname(path.resolve(labelOrOutput)) === temp, 'controls output is new owner Temp');
  assert.equal(fs.existsSync(labelOrOutput), false);
  const proof = { schema: 'cinatoken-no-transform-local-predicate-controls-v1', actualExit: 0,
    at: new Date().toISOString(), processExecutable: process.execPath, node: process.version,
    scriptRaw: raw(fileURLToPath(import.meta.url)), browserInputs: checkBrowserInputs(),
    networkRequests: 0, browserRuns: 0, sourceWrites: 0, ...localControls() };
  fs.writeFileSync(labelOrOutput, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ actualExit: 0, positives: proof.positives.length, negativesRejected: proof.negatives.length, evidence: raw(labelOrOutput) }));
} else {
  assert.equal(mode, '--execute', 'network requires explicit execution and a newly authorized Root release config');
  const label = labelOrOutput;
  assert.match(label ?? '', /^[a-z0-9-]+$/);
  const output = path.join(temp, `${label}-html-precheck-closed.json`);
  assert.equal(fs.existsSync(output), false, 'fresh output only');
  const result = { schema: 'cinatoken-production-html-no-transform-real-precheck-v1', label,
    startedAt: new Date().toISOString(), actualExit: 1, node: process.version,
    scriptRaw: raw(fileURLToPath(import.meta.url)), requests: [], methods: ['GET'],
    sourceWrites: 0, gitWrites: 0, deployments: 0, routeWrites: 0, databaseWrites: 0, businessWrites: 0,
    browserRuns: 0, realLogin: false, claimLimit: 'Four actual HTML responses; strict unchanged v2 browser remains a separate mandatory gate.' };
  let config;
  try {
    result.browserInputs = checkBrowserInputs();
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const allowed = new Set(['gitSHA', 'workerVersionId', 'phase', 'targetOrigin', 'canonicalOrigin', 'operatorVerifiedLiveVersion', 'all29FlagsEnabled', 'liveProof']);
    assert.ok(Object.keys(config).every(key => allowed.has(key)));
    assert.match(config.gitSHA ?? '', /^[a-f0-9]{40}$/);
    assert.match(config.workerVersionId ?? '', /^[a-f0-9-]{36}$/);
    assert.equal(config.phase, 'cutover'); assert.equal(config.targetOrigin, 'https://cinatoken.com');
    assert.equal(config.canonicalOrigin, config.targetOrigin);
    assert.equal(config.operatorVerifiedLiveVersion, true); assert.equal(config.all29FlagsEnabled, true);
    assert.ok(config.liveProof?.path && config.liveProof.bytes > 0);
    assert.match(config.liveProof.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(raw(config.liveProof.path), config.liveProof);
    result.config = config; result.configRaw = raw(configPath);
    for (const item of pages) {
      const row = { ...item, method: 'GET', url: config.targetOrigin + item.route, startedAt: new Date().toISOString() };
      result.requests.push(row);
      const response = await fetch(row.url, { method: 'GET', redirect: 'manual',
        headers: { accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
      row.status = response.status; row.finalURL = response.url;
      row.headers = Object.fromEntries(['cache-control', 'content-security-policy', 'content-type',
        ...Object.keys(securityHeaders)].map(name => [name, response.headers.get(name)]));
      // Never record Set-Cookie, tokens, credentials or authorization headers.
      const body = await limitedHTML(response);
      const bodyPath = path.join(temp, `${label}-${item.route.slice(1).replaceAll('/', '-')}-response.html`);
      fs.writeFileSync(bodyPath, body, { flag: 'wx' }); row.bodyRaw = raw(bodyPath);
      row.checks = evaluateHTML({ status: row.status, headers: row.headers, html: body.toString('utf8') }, item.kind);
      row.finishedAt = new Date().toISOString(); row.passed = true;
      console.log(JSON.stringify({ route: item.route, status: row.status, passed: true, cacheControl: row.headers['cache-control'], bodyRaw: row.bodyRaw }));
    }
    assert.equal(result.requests.length, 4); result.actualExit = 0;
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    result.finishedAt = new Date().toISOString();
    if (config?.liveProof?.path) {
      try { assert.deepEqual(raw(config.liveProof.path), config.liveProof); result.liveProofRawStillSame = true; }
      catch (error) { result.actualExit = 1; result.liveProofRawStillSame = false; result.finalBindingFailure = error.message; }
    }
    try { result.browserInputsAfter = checkBrowserInputs(); } catch (error) { result.actualExit = 1; result.browserInputFailure = error.message; }
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ actualExit: result.actualExit, requests: result.requests.length, evidence: raw(output), failure: result.failure }));
    process.exitCode = result.actualExit;
  }
}
