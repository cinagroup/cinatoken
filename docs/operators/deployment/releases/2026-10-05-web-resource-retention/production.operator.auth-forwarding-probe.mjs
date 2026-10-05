import fs from 'node:fs';
import assert from 'node:assert/strict';
const [label] = process.argv.slice(2); assert.match(label ?? '', /^[a-z0-9-]+$/);
const report = { at: new Date().toISOString(), origin: 'https://cinatoken.com', requests: [], actualExit: null, cookieValuesRecorded: false, oauthStateOrNonceRecorded: false, realLoginCompleted: false };
try {
  for (const [kind, path] of [['auth-check', '/api/auth/check'], ['portal-login', '/api/auth/cinaauth/login?intent=portal&callbackURL=%2Faccount'], ['admin-login', '/api/auth/cinaauth/login?intent=admin&callbackURL=%2Fadmin']]) {
    const response = await fetch(report.origin + path, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const location = response.headers.get('location');
    const url = location ? new URL(location, report.origin) : null;
    const cookies = response.headers.getSetCookie().map(value => ({ httpOnly: /;\s*httponly(?:;|$)/i.test(value), secure: /;\s*secure(?:;|$)/i.test(value), sameSite: value.match(/;\s*samesite=([^;]+)/i)?.[1]?.toLowerCase(), path: value.match(/;\s*path=([^;]+)/i)?.[1], maxAge: value.match(/;\s*max-age=([^;]+)/i)?.[1] }));
    const body = await response.text();
    const item = { kind, status: response.status, cacheControl: response.headers.get('cache-control'), location: url ? { origin: url.origin, pathname: url.pathname, parameterNames: [...url.searchParams.keys()].sort(), redirectUri: url.searchParams.get('redirect_uri'), authError: url.searchParams.get('auth_error') } : null, cookieAttributes: cookies, body: kind === 'auth-check' ? JSON.parse(body) : null };
    report.requests.push(item);
    if (kind === 'auth-check') { assert.equal(response.status, 200); assert.equal(item.body.authenticated, false); }
    else { assert.equal(response.status, 302); assert.ok(['https://auth.cinaseek.si', 'https://accounts.cinaseek.si'].includes(url.origin)); assert.equal(url.searchParams.get('redirect_uri'), 'https://cinatoken.com/api/auth/cinaauth/callback'); assert.equal(cookies.length, 1); assert(cookies.every(c => c.httpOnly && c.secure && c.sameSite === 'lax' && c.path === '/')); }
  }
  report.actualExit = 0;
} catch (error) { report.actualExit = 1; report.error = error.message; }
report.finishedAt = new Date().toISOString();
fs.writeFileSync(new URL(label + '.auth-forwarding.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report)); process.exitCode = report.actualExit;
