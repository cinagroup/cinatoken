import assert from 'node:assert/strict';
import { request, Agent } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.equal(process.platform, 'linux');
assert.ok(process.argv.includes('--execute-owned-linux'), 'future owned Linux execution only');
assert.ok(arg('--ca') && arg('--out'), 'explicit CA and output receipt required');
const ca = readFileSync(arg('--ca')); const authority = new X509Certificate(ca); assert.equal(authority.ca, true);
assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, 'TLS bypass forbidden');
const agent = new Agent({ ca, rejectUnauthorized: true, keepAlive: false });
const rows = []; const started = Date.now();
async function call(label, path, method, headers = {}) {
  // Fixed app.test:443 only; caller cannot substitute a public issuer/provider/API URL.
  const r = await new Promise((resolve, reject) => {
    const req = request({ hostname: 'app.test', port: 443, servername: 'app.test', path, method, headers,
      agent, timeout: 5000 }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { req.destroy(new Error('wire response bound exceeded')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location,
        setCookieCount: response.headers['set-cookie']?.length ?? 0, noStore: /no-store/i.test(response.headers['cache-control'] ?? ''),
        TLSAuthorized: response.socket?.authorized === true || req.socket.authorized === true, bytes }));
    });
    req.on('timeout', () => req.destroy(new Error('wire timeout'))); req.on('error', reject); req.end();
  });
  assert.equal(r.TLSAuthorized, true); rows.push({ label, ...r }); return r;
}
let failure;
try {
  for (const [label, headers, expected] of [
    ['same HTTPS origin with no client forwarding metadata', { origin: 'https://app.test', 'sec-fetch-site': 'same-origin' }, 410],
    ['spoofed forwarded metadata overwritten', { origin: 'https://app.test', 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'attacker.test', forwarded: 'proto=http;host=attacker.test' }, 410],
    ['ambiguous forwarding metadata overwritten', { origin: 'https://app.test', 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'http,https' }, 410],
    ['missing Origin', {}, 403],
    ['cross Origin preserved', { origin: 'https://attacker.test' }, 403],
    ['explicit cross-site', { origin: 'https://app.test', 'sec-fetch-site': 'cross-site' }, 403],
    ['unknown Host rejected at ingress', { host: 'attacker.test', origin: 'https://app.test' }, 421],
  ]) { const r = await call(label, '/api/auth/login', 'POST', headers); assert.equal(r.status, expected, label); assert.equal(r.setCookieCount, 0); }
  const register = await call('public registration redirect', '/api/auth/cinaauth/register?intent=portal&callbackURL=%2Faccount%2Fkeys', 'GET');
  assert.equal(register.status, 302); const url = new URL(register.location); assert.equal(url.origin, 'https://app.test'); assert.equal(url.pathname, '/api/auth/cinaauth/login'); assert.equal(register.noStore, true);
  const invalid = await call('invalid callback restores HTTPS origin', '/api/auth/cinaauth/callback?state=invalid', 'GET');
  assert.equal(invalid.status, 302); const fallback = new URL(invalid.location); assert.equal(fallback.origin, 'https://app.test');
  assert.equal(fallback.searchParams.get('auth_error'), 'invalid_transaction'); assert.equal(invalid.setCookieCount, 0);
} catch (error) { failure = { name: error.name, message: error.message }; }
finally { agent.destroy(); }
const body = JSON.stringify({ schema: 'g7-owned-TLS-origin-wire-only-v1', actualExit: failure ? 1 : 0, elapsedMs: Date.now() - started,
  caFingerprint: authority.fingerprint256, rows, failure, OIDCSessionVerified: false, realIdentityVerified: false,
  fullG7Verified: false, productionRequests: 0 }, null, 2) + '\n';
writeFileSync(arg('--out'), body); console.log(JSON.stringify({ actualExit: failure ? 1 : 0, cases: rows.length, out: arg('--out') })); process.exitCode = failure ? 1 : 0;
