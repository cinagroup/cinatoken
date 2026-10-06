import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = 'C:/cinagroup/cinatoken';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(repo, 'package.json'));
const NextNodeServer = require('next/dist/server/next-server.js').default;
const { NextRequestAdapter } = require('next/dist/server/web/spec-extension/adapters/next-request.js');
const { build } = require('esbuild');
const entries = ['public-request-url', 'browser-mutation', 'workspace-cookie'];
const built = await build({ stdin: { contents: entries.map(name => `export * from ${JSON.stringify(join(repo, 'packages/admin/lib', name + '.ts').replaceAll('\\', '/'))};`).join('\n'), resolveDir: repo, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
const { getPublicRequestUrl, checkBrowserMutationOrigin, workspaceCookieHeader } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const rows = [];
for (const [name, proto, origin, fetchSite, expectedProtocol, expectedAllowed] of [
  ['internal HTTP missing TLS metadata', 'http', 'https://app.test', 'same-origin', 'http:', false],
  ['controlled ingress overwrites literal HTTPS', 'https', 'https://app.test', 'same-origin', 'https:', true],
  ['raw HTTP supplied XFP spoof also synthesizes HTTPS', 'https', 'https://app.test', 'same-origin', 'https:', true],
  ['raw Admin permissive includes matching substring', 'nothttps', 'https://app.test', 'same-origin', 'https:', true],
  ['trusted ingress preserves attacker Origin rejection', 'https', 'https://attacker.test', 'same-origin', 'https:', false],
  ['trusted ingress preserves cross-site rejection', 'https', 'https://app.test', 'cross-site', 'https:', false],
  ['trusted ingress preserves missing-Origin rejection', 'https', null, 'same-origin', 'https:', false],
]) {
  const headers = { host: 'app.test', 'x-forwarded-proto': proto, 'sec-fetch-site': fetchSite };
  if (origin) headers.origin = origin;
  const request = { method: 'POST', url: '/api/auth/login', headers, body: undefined };
  NextNodeServer.prototype.attachRequestMeta.call({ fetchHostname: 'localhost', port: 8789, nextConfig: { experimental: {} } }, request, { query: {} }, true);
  const adapted = NextRequestAdapter.fromNodeNextRequest(request, new AbortController().signal);
  const publicUrl = getPublicRequestUrl(adapted);
  const decision = checkBrowserMutationOrigin(adapted);
  const cookie = workspaceCookieHeader('fixture-workspace', adapted);
  assert.equal(publicUrl.protocol, expectedProtocol); assert.equal(decision.allowed, expectedAllowed);
  assert.equal(/; Secure$/.test(cookie), expectedProtocol === 'https:');
  rows.push({ name, injectedXFP: proto, publicOrigin: publicUrl.origin, allowed: decision.allowed,
    rejection: decision.reason ?? null, workspaceSecure: /; Secure$/.test(cookie), actualExit: 0 });
}
const report = { schema: 'g7-local-next-adapter-contract-v1', actualExit: 0,
  scope: 'actual installed Next attachRequestMeta and fromNodeNextRequest with inert request metadata; no server/socket/TLS/OIDC/DB execution',
  versions: { next: require('next/package.json').version, oauth4webapi: require('oauth4webapi/package.json').version, jose: require('jose/package.json').version }, rows,
  localHTTPRequests: 0, productionRequests: 0, TLSVerified: false, OIDCVerified: false, realIdentityVerified: false,
  limitation: 'Does not execute full base-server or network ingress; does not prove origin metadata came from a trusted peer' };
const body = JSON.stringify(report, null, 2) + '\n'; writeFileSync(join(here, 'local-adapter-result.json'), body);
console.log(JSON.stringify({ actualExit: 0, cases: rows.length, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }));
