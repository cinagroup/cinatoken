import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const repo = 'C:/cinagroup/cinatoken';
const sha = data => createHash('sha256').update(data).digest('hex');
const receipt = path => { const b = readFileSync(path); return { path, bytes: b.length, sha256: sha(b) }; };
const oldPath = 'C:/Users/cina/AppData/Local/Temp/cinatoken-g7-docker-topology-v77GHM/topology-review.json';
const plan = {
  schema: 'g7-owned-linux-tls-origin-plan-v1', executablePreparedOnly: true,
  command: 'timeout --signal=TERM --kill-after=5s 60s node /qa/future-tls-smoke.mjs --execute-owned-linux --ca /tls/qa-root-ca.crt --out /receipts/tls-origin-wire.json',
  firstScope: '9 real HTTPS app.test:443 wire cases only; no completed OIDC or business write is claimed by this probe',
  minimumPrerequisites: [
    'One reviewed SHA and existing dependency lock; prepull/build before isolated runtime. Actual PG/migrate/Admin/Proxy plus paired frozen Web/SSR images.',
    'New standalone owned Compose file, not an overlay that accidentally inherits examples ports. Each network internal:true; no published ports, host/default/external network attachment. QA joins edge only; Web8080/Admin8789/Proxy8787/PG5432 remain private.',
    'app.test DNS alias on ingress only, HTTPS443 with generated local CA/SAN certificate; no -k, rejectUnauthorized:false, ignoreHTTPSErrors or TLS environment bypass. Validate nginx -t against the actual pinned image before starting.',
    'Ingress requires app.test SNI and canonical app.test or app.test:443 Host, otherwise421; overwrites Host/XFH/XFP with fixed canonical app.test/https and clears Forwarded. Preserve browser Origin/Cookie and upstream multiple Set-Cookie/Location.',
    'Explicit Admin CINATOKEN_APP_ORIGIN=https://app.test, CINAAUTH_ISSUER=https://auth.test, CINAAUTH_ACCOUNT_ORIGIN=https://accounts.test, test-only client ID and three fresh >=32-char OIDC secrets. Require presence/equality before runtime; never allow public default fallbacks.',
    'Explicit internal Admin CINATOKEN_PUBLIC_API_ORIGIN=http://gateway-proxy:8787; Web public origin https://app.test; exact SSR manifest/upstream. Strong per-run key encryption and DB credentials are ephemeral and never logged.',
    'auth.test/accounts.test/provider.test/api.test, if used, resolve only to owned internal fixtures. All real external origins/providers/issuers prohibited. Audit only allowed origin values and secret presence, not raw inspect Env or private keys.',
  ],
  wireChecks: [
    'POST disabled password login with exact HTTPS Origin and no forwarded client headers returns410, proving guard passed without DB/session creation.',
    'Client XFP=http, XFH=attacker.test and Forwarded spoof, then ambiguous XFP=http,https both still410 through overwritten ingress metadata.',
    'Missing Origin, attacker Origin and Sec-Fetch-Site cross-site each403; forged Host with valid app SNI421.',
    'Register redirects302 to canonical HTTPS app login and preserves allowed transaction query; invalid callback302 to HTTPS app error and emits no identity/transaction cookie.',
    'Additional harness negatives: unknown/missing SNI/certificate mismatch must fail TLS/host validation; QA cannot reach raw Web/Admin ports; untrusted CA fails before the trusted-CA run. These are required topology checks, not yet implemented in the 9-case wire probe.',
  ],
  nextAuthenticatedStage: [
    'Implement owned HTTPS OIDC discovery/authorize/token/JWKS/userinfo/session/live-role fixture based on existing session-subject-boundary RSA-signed JWT and PKCE checks; enforce one-use authorization code, exact state/nonce/resource/redirect/client auth and negative signature/issuer/audience/PKCE cases.',
    'Use actual Admin callback and actual disposable PG repositories; obtain portal and console sessions through the signed authorization flow. DB seeded session and unsigned/mock token do not prove the OIDC path.',
    'Actual browser with verified CA trust stores Secure/HttpOnly/SameSite cookies; follows callback, returns session cookie over HTTPS, validates exact subject and live role, then persists an authorized mutation and verifies stored acknowledgement. Preserve separate Set-Cookie fields and logout revocation.',
    'Portal ordinary subject, authorized console subject, different subject/workspace, revoked/missing role and IdP outage boundaries must be tested. Synthetic fixture proves controlled integration only, never actual CinaAuth issuer registration/MFA/human authorization.',
    'Real Proxy pipeline uses internal provider fixture for timed SSE/abort/WS plus429/503 Retry-After; routing fixtures alone are not Proxy pipeline proof. Current+retained paired assets, old/new session reuse, gray switch and verified rollback with DB writes retained remain later fullG7 tasks.',
  ],
  executionEvidence: 'Unique labeled project, bounded command exits, SHA/image/manifest receipts, redacted logs. Finally down --volumes --remove-orphans, verify exact owned containers/networks/volumes absent. Unknown timeout or cleanup stays failure. No future run has occurred here.',
};
writeFileSync(join(here, 'future-linux-plan.json'), JSON.stringify(plan, null, 2) + '\n');
const sourcePaths = [
  'Dockerfile.admin', 'packages/admin/package.json', 'package-lock.json',
  'node_modules/next/dist/server/base-server.js', 'node_modules/next/dist/server/next-server.js',
  'node_modules/next/dist/server/web/spec-extension/adapters/next-request.js',
  'packages/admin/lib/public-request-url.ts', 'packages/admin/lib/public-request-url.test.ts',
  'packages/admin/lib/browser-mutation.ts', 'packages/admin/lib/browser-mutation.test.ts',
  'packages/admin/lib/workspace-cookie.ts', 'packages/admin/lib/workspace-cookie.test.ts',
  'packages/admin/lib/cinaauth/config.ts', 'packages/admin/lib/cinaauth/oidc-client.ts',
  'packages/admin/lib/cinaauth/public-url.test.ts', 'packages/admin/lib/cinaauth/session-subject-boundary.test.ts',
  'packages/admin/app/api/auth/cinaauth/login/route.ts', 'packages/admin/app/api/auth/cinaauth/callback/route.ts',
  'packages/admin/app/api/auth/login/route.ts', 'packages/admin/app/api/auth/logout/route.ts',
  'docker/web/nginx.conf.template', 'docker/web/admin-proxy.conf', 'docker/examples/gateway.compose.yml',
  'docker/examples/web-frontend.compose.yml', 'docs/operators/deployment/docker.md',
];
const sources = sourcePaths.map(path => ({ ...receipt(join(repo, path)), repositoryPath: path }));
const local = JSON.parse(readFileSync(join(here, 'local-adapter-result.json'))); assert.equal(local.actualExit, 0); assert.equal(local.rows.length, 7);
const syntax = execFileSync(process.execPath, ['--check', join(here, 'future-tls-smoke.mjs')], { encoding: 'utf8' });
const files = ['local-adapter-contract.mjs', 'local-adapter-result.json', 'trusted-ingress.example.conf', 'future-tls-smoke.mjs', 'future-linux-plan.json', 'seal-review.mjs'].map(path => receipt(join(here, path)));
const refs = [
  { path: 'node_modules/next/dist/server/base-server.js', line: 571, claim: 'Existing XFP is preserved with ??=; socket.encrypted used only when forwarded value is absent. No peer allowlist here.' },
  { path: 'node_modules/next/dist/server/next-server.js', line: 1264, claim: 'includes(https) chooses scheme for initURL/initProtocol; incoming Host is not the synthetic listen authority.' },
  { path: 'node_modules/next/dist/server/web/spec-extension/adapters/next-request.js', line: 89, claim: 'Node adapter creates NextRequest from initURL metadata and incoming headers.' },
  { path: 'packages/admin/lib/public-request-url.ts', line: 6, claim: 'Retains already-generated URL protocol and restores validated Host; does not add peer/proxy trust.' },
  { path: 'packages/admin/lib/browser-mutation.ts', line: 29, claim: 'Default mutation origin compares exact Origin against restored public URL origin; wrong scheme rejects.' },
  { path: 'packages/admin/lib/workspace-cookie.ts', line: 33, claim: 'Workspace Secure flag depends on request.url scheme; wrong scheme can omit Secure.' },
  { path: 'packages/admin/lib/cinaauth/config.ts', line: 37, claim: 'Canonical HTTPS origin required, with no nondefault port and exact normalized origin string. Defaults are real external issuer/account/app origins.' },
  { path: 'packages/admin/app/api/auth/cinaauth/login/route.ts', line: 122, claim: 'OIDC transaction cookie is always Secure; configured app origin controls redirect/resource, not incoming scheme repair.' },
  { path: 'packages/admin/app/api/auth/cinaauth/callback/route.ts', line: 189, claim: 'Restored callback URL is passed to oauth processing; fixed secure session cookie at156/278 and configured completion origin are distinct.' },
  { path: 'docker/web/nginx.conf.template', line: 169, claim: 'Web accepts exact inbound XFP=http/https into outbound scheme; server8080 defaultHost_ does not establish trusted peer.' },
  { path: 'docker/web/admin-proxy.conf', line: 4, claim: 'Web forwards raw Host and mapped XFP to HTTP Admin; preserves Origin/cookie and no buffering.' },
  { path: 'Dockerfile.admin', line: 105, claim: 'Runs generated Next standalone node server.js; existing image is HTTP and has no reviewed end-to-end TLS bootstrap.' },
  { path: 'docker/examples/web-frontend.compose.yml', line: 6, claim: 'Example publishes raw Web8080. Gateway example also publishes Admin/Proxy. Four-file config batch did not isolate protocol trust.' },
  { path: 'docs/operators/deployment/docker.md', line: 320, claim: '7.3 TLS reverse-proxy example is illustrative and does not prove complete Host/SNI/peer/header normalization or raw-port isolation.' },
];
const report = {
  schema: 'g7-TLS-origin-trust-readonly-review-closed-v1', endedAt: new Date().toISOString(), actualExit: 0,
  repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  conclusion: 'Feasible with controlled ingress normalization and raw-port isolation. Current four-file configuration is not URL trust proof; no full topology or real identity verified.',
  principalRisk: 'A helper ignoring forwarding headers can still inherit an already-tainted HTTPS scheme from the Node adapter. Public raw HTTP exposure permits forged scheme metadata. Conversely missing trusted HTTPS metadata rejects legitimate HTTPS mutations and mislabels conditional cookie/redirect paths.',
  causeProven: { staticPipelineContract: true, realTLSWire: false, productionExploit: false, allOIDCBlocked: false },
  conditionalBehavior: 'A properly trusted ingress overwrites canonical Host and literal HTTPS; Next synthesizes HTTPS and helper restores app host, so exact Origin and Secure cookie conditions can work. OIDC transaction/session cookies are already Secure=true and fixed appOrigin redirects may work even if adapter scheme is wrong; do not assert every OIDC path fails.',
  recommendedMinimalPath: 'Test-only static app.test TLS443 ingress and private internal HTTP chain; no helper relaxation, no public forwarding trust, preserve Origin. Require real9case wire evidence before claiming URL trust solved.',
  alternateOwnedImplementation: [
    'If raw adapter exposure cannot be eliminated, a new Node adapter/bootstrap must default to socket.encrypted and strip incoming Forwarded/XFP/XFH; only explicit trusted peer remoteAddress plus validated canonical Host and controlled public-origin config may override. A Fetch Request helper alone cannot recover trustworthy Node peer metadata.',
    'A new end-to-end HTTPS Next bootstrap is an alternative, with certificate verification on upstream hops and untrusted forwarding stripped before Next. Existing standalone image is HTTP; merely selecting HTTPS upstream or setting XFP is not this implementation. TLS alone does not neutralize already supplied XFP in the current Next branch.',
  ],
  exactSourceRefs: refs, checkedSources: sources, oldTopologyReview: receipt(oldPath),
  localAdapterEvidence: { ...receipt(join(here, 'local-adapter-result.json')), actualExit: 0, cases: 7, realSocketOrTLS: false, versions: local.versions },
  existingContracts: { publicRequestURL: '6 direct-Fetch cases, includes forged forwarding ignored locally and malformed Host rejection',
    browserMutation: '12 cases cover exact Host/scheme/port Origin, cross-site/no-Origin and bearer/console distinction',
    workspaceCookie: '2 cases preserve HTTPS Secure versus HTTP development behavior',
    cinaAuthPublicURL: '2 request-level redirect/error cases; does not invoke native socket adapter or TLS ingress',
    existing22NotRerunHere: true, signedOIDC: 'session-subject-boundary fixture uses RSA signed ID token/JWKS, S256 verifier/resource/redirect/Basic auth and negative state/PKCE/nonce/signature/bridge/issuer/code/role. DB/session repositories are fakes; it is not native PG or real issuer login.' },
  futurePlan: receipt(join(here, 'future-linux-plan.json')), sealedTempFiles: files,
  meaningfulChecks: { localAdapterActualExit: 0, localAdapterCases: 7, futureWireScriptSyntaxActualExit: 0, nginxRuntimeValidation: 'pending owned Linux nginx -t', runtimeTopology: 'not executed' },
  boundaries: { syntheticOIDCIdentity: 'Controlled signed fixture would prove configured integration and real disposable PG business session only after completed actual callback; never real authorized CinaAuth identity',
    realIdentity: 'Actual client registration, allowed URLs, real issuer role/subject/workspace, MFA/human authorization and outages remain pending', fullG7: false, fullG8: false },
  primarySources: ['https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header', 'https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_server_name', 'https://docs.docker.com/reference/compose-file/networks/#internal'],
  repositoryWrites: 0, checklistMDCreated: false, CIReads: 0, CIInvocations: 0, productionRequests: 0, DBRequests: 0,
  actualTLSRequests: 0, realIdentityActions: 0, deployments: 0,
};
const body = JSON.stringify(report, null, 2) + '\n'; writeFileSync(join(here, 'FINAL-g7-TLS-origin-review.json'), body); writeFileSync(join(here, 'FINAL-g7-TLS-origin-review.sha256'), sha(body) + '\n');
console.log(JSON.stringify({ actualExit: 0, report: join(here, 'FINAL-g7-TLS-origin-review.json'), bytes: Buffer.byteLength(body), sha256: sha(body), repositoryWrites: 0, actualTLSRequests: 0 }));
