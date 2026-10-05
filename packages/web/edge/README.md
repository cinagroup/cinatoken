# Progressive same-origin entry

This is the infrastructure slice for E07 in
[the full migration checklist](../../../docs/developers/architecture/web-frontend-migration.md).
It does not deploy or transfer an existing public route.

The rollout flag `CINATOKEN_WEB_ACCOUNT_ENABLED` defaults to `false`. When it is
exactly `true`, only GET/HEAD for `/account` and its `keys`, `byok`, `activity`,
`earnings`, `nft`, `withdraw`, `presets`, `guardrails` and `settings` pages
(each with or without the trailing slash) receives the Web shell. These twenty
paths are an explicit routing
allowlist; the default-off switch and pending deployment acceptance still apply.
`CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED` independently defaults to `false`;
literal `true` captures only GET/HEAD for `/admin` and `/admin/`. Other Admin
pages, API paths, and legacy `/dashboard` remain with Admin.
`CINATOKEN_WEB_ADMIN_USERS_ENABLED` independently defaults to `false`;
literal `true` captures only GET/HEAD for `/admin/users` and `/admin/users/`.
The separate `CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED` also defaults to `false`.
Literal `true` captures only GET/HEAD for `/admin/users/:id` (with an optional
trailing slash or query) when `:id` is a UUID or the canonical single-encoded
simple `ext%3Asystem%2Fuser` form, with each component limited to letters,
digits, `.`, `_`, `~`, and `-`. Percent escapes inside either component
(including an encoded slash or percent), `%1F` separators, double encoding,
and malformed IDs remain with Admin. Set this flag back to `false` to return
all detail pages to Admin.
User API routes always remain with Admin.
The independent `CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED` also defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/providers` and its trailing-slash
form. Account rollout and Providers rollout do not enable one another.
The independent `CINATOKEN_WEB_ADMIN_MODELS_ENABLED` also defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/models` and its trailing-slash
form. Account, Providers and Models rollout do not enable one another.
The independent `CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED` also defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/endpoints` and its trailing-slash
form. It does not enable the other Admin or account pages.
The independent `CINATOKEN_WEB_ADMIN_ROUTES_ENABLED` also defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/routes` and its trailing-slash
form. It does not enable the other Admin or account pages.
The independent `CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED` also defaults to
`false`. Only literal `true` captures GET/HEAD for `/admin/data-policies` and its
trailing-slash form. It does not enable the other Admin or account pages.
The independent `CINATOKEN_WEB_ADMIN_PRESETS_ENABLED` also defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/presets` and its trailing-slash
form. The independent `CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED` and
`CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED` likewise default to `false` and
capture only GET/HEAD for `/admin/guardrails` and `/admin/config/timezone`,
respectively, with or without one trailing slash. None enables another domain.
`CINATOKEN_WEB_ADMIN_CONFIG_ENABLED` independently defaults to `false` and
captures only GET/HEAD for `/admin/config` and its trailing-slash form.
`CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED` independently defaults to `false` and
captures only GET/HEAD for `/admin/analytics/reliability` and its trailing-slash
form. Other analytics pages, API paths and write methods remain with Admin.
`CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED` independently defaults to `false`
and captures only GET/HEAD for `/admin/analytics/models` and its trailing-slash
form. Other analytics pages, API paths and write methods remain with Admin.
`CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED` independently defaults to
`false` and captures only GET/HEAD for `/admin/analytics/providers` and its
trailing-slash form. Other analytics pages, API paths and write methods remain
with Admin.
`CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED` independently defaults to `false`
and captures only GET/HEAD for `/admin/analytics/users` and its trailing-slash
form. Other analytics pages, API paths and write methods remain with Admin.
`CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED` independently defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/request-logs` and its
trailing-slash form, including query strings. Setting it back to `false`
immediately returns these page requests to Admin; API routes and write methods
always stay with Admin, and `/web-assets/*` remains available for open tabs.
`CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED` independently defaults to `false`.
Only literal `true` captures GET/HEAD for `/admin/audit-logs` and its
trailing-slash form, including query strings. Setting it back to `false`
returns the page to Admin. `/api/admin/budget-audit-logs` and its `/filters`
subpath, as well as write methods, always remain with Admin.
`CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED` independently defaults to
`false`. Only literal `true` captures GET/HEAD for `/admin/tools/invocations`
and its trailing-slash form, including query strings. Setting it back to
`false` returns the page to Admin. `/admin/tools`, `/api/admin/request-logs`,
unknown subpaths and write methods always remain with Admin.
All public SSR, unknown account subpaths, other admin pages, API, login,
registration, callback and unknown paths reach existing Admin.
The independent `CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED` and
`CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED` flags both default to `false`. Literal
`true` captures only GET/HEAD for `/admin/playground` or `/admin/simulator`,
respectively, with an optional single trailing slash and query. API, Proxy
protocols, adjacent paths and write methods always keep their existing entry.
The legacy `/gateway/playground` and `/gateway/simulator` pages use the same
browser screens through the Next bridge. Playground uses Console authorization
for a single diagnostic target; Simulator independently invokes the Proxy with
a verified original Gateway Key and its normal financial controls. These entry
flags do not authorize calls or change billing behavior.
`/web-assets/*` maps to the build directory by stripping `/web-assets`; the shell
is fetched explicitly as `/index.html`. There is no general SPA fallback.

Cloudflare forwards the original Request and returns the original Admin Response
through `CINATOKEN_ADMIN_SERVICE`. Public URL, Origin, cookies, redirects,
multiple `Set-Cookie` headers, streamed bodies and WebSocket responses retain
their existing semantics. The entry never supplies an admin credential or skips
the backend's browser mutation check.

The independent `CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED` and
`CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED` flags default to `false`. Literal
`true` captures only GET/HEAD for `/admin/withdrawals` or `/admin/nft-mints`
and their single trailing-slash forms. Each flag can be rolled back separately;
API, process/reject writes, encoded paths and neighboring routes remain with
Admin. The legacy `/gateway/*` pages use the same browser Screen through a
Console-verifying Next bridge. This is source integration, not production
activation or platform acceptance.

Chain operations retain independent `users.read`/`users.write` permissions.
A process response `{ queued }` acknowledges Queue delivery only; it does not
confirm a chain transaction. Each new Web or shared Next Screen write first
verifies the current Console subject and sends its canonical expected-subject
header. The backend checks every supplied header; legacy Console/Bearer clients
without it retain existing authorization and do not acquire this subject-change
protection. Unknown submission results require review and are never
retried automatically. Admin withdrawal rejection uses the dedicated atomic
repository method for an unclaimed `requested` row with no signed outbox.
D1 validates the actual formal refund-trigger definition on each rejection and
binds the same definition into its CAS write; missing, replaced or untrusted
trigger definitions fail closed. This does not certify all native schema or
chain economics. MySQL currently has no matching Portal journal table;
`processing` or submitted records require manual reconciliation. Apply and
verify the formal D1 `0077_withdrawal_balance_update_guards.sql` and MySQL
`0075_chain_job_transactions.sql` migrations, including native triggers and
permissions. The MySQL outbox schema supports the rejection predicate; it does
not add MySQL support to Chain Worker. Upgrade/drain older Admin writers,
and complete real database/chain/platform
acceptance before enabling these entries. Keep the corrected ledger guard and
compatible readers on rollback; do not revert financial state with an asset
rollback.

## Cloudflare configuration

From the repository root, load the same environment file used for the existing
Admin deployment, then generate production configuration from a verified artifact:

```powershell
node packages/web/scripts/gen-web-wrangler.mjs --release web-v2
```

For local preview or Wrangler dry-run against mutable `dist`, explicitly use
`node packages/web/scripts/gen-web-wrangler.mjs --development` (or
`npm run gen:wrangler:development -w @cinatoken/web`). Production requires
`--release`; omitted or mixed modes fail before writing configuration.

Generation reads `ADMIN_WORKER_NAME` with the same default as the root deployment
generator. `WEB_WORKER_NAME` names the entry; `WEB_CUSTOM_DOMAIN` is an optional
public hostname. No domain is assigned by default. The generated
`packages/web/wrangler.web.jsonc` is environment-specific and should be ignored.
Assets use Worker-first routing and disable implicit HTML/SPA handling.

Before a deployment, ensure the public hostname is assigned only to the intended
entry rather than competing Admin/entry routes; retain Admin as a Service Binding
target. Route transfer is an operational change that is not performed here.
Switching the flag back to `false` returns account pages to Admin while the asset
namespace remains available. Preserve the release assets when changing the flag.

## Frozen artifacts and resource retention

Build once, then freeze the artifact from the repository root:

```powershell
npm run build -w @cinatoken/web
node packages/web/scripts/package-release.mjs --id web-v1 --at 2026-09-27T00:00:00.000Z
node packages/web/scripts/package-release.mjs --verify web-v1
```

Use the actual release timestamp and a unique id. The script writes only
`.release/web/<id>/assets`, `manifest.json` and `manifest.sha256`; it never
overwrites an existing id or changes `dist`. Place the previous verified artifact
at `.release/web/web-v1`, then explicitly include it in the next release:

```powershell
node packages/web/scripts/package-release.mjs --id web-v2 --at 2026-09-28T00:00:00.000Z --previous web-v1 --retention-days 14
```

Current HTML and mutable images come only from the current build. Previous
artifacts contribute recognized content-hash resources in `static/`, including
lazy chunks, fonts and license files. Old HTML, routing control files, manifests
and mutable resources are never carried over. A shared hashed path with different
bytes is rejected, even if that previous resource has expired.

The configurable default retention is 14 days, with a 1–90 day bound. Cover the
operational rollback window and expected lifetime of open tabs. `lastCurrentAt`
records when each resource was last current; passing retained files through
subsequent releases does not renew their age. Pruning occurs when packaging the
next artifact at its explicit release timestamp; it is not a runtime expiry,
background deletion or client TTL. Redeploying an old artifact does not prune it.
Tabs older than the chosen window may need a refresh. Keep previous artifacts
and release pointers for the entire rollback window.

For an artifact rollback, create a new immutable release with the desired old
artifact as current and the currently published artifact as previous:

```powershell
node packages/web/scripts/package-release.mjs --id web-rollback --at 2026-09-29T00:00:00.000Z --current-release web-v1 --previous web-v2 --retention-days 14
```

`--current-release` requires `--previous`. It restores the old artifact's current
HTML/resources while retaining hashes needed by tabs opened under the newer
release. It does not promote retained files to current files. No database
rollback or data deletion is involved. Missing files remain 404s, never an old
HTML or backend fallback.

Verification checks the exact inventory, bytes, SHA-256, manifest checksum,
timestamps, retention bounds and identifier. Traversal, symbolic links, routing
control files, oversized inputs, changed or extra files fail. Release directory
creation is atomic; use a new id after any partially written failure. Limits are
10,000 files, 20 MiB per file and 256 MiB total. SHA-256 detects modification but
does not authenticate a publisher: record the expected manifest digest with the
trusted release/commit record.

Cloudflare and Docker consume the same verified artifact. Successful recognized
hash resources use `public, max-age=31536000, immutable`; other successful assets
use `no-cache`; HTML, redirects and errors use `no-store`. GET/HEAD apply the same
rule, including 206/304, while preserving ETag and range response headers.
Private/API response policies remain the backend's responsibility.

Existing [release governance](../../../docs/maintainers/release-versioning.md)
publishes proxy/admin/migrate with version tags and image digests. Web is not
added to that publishing workflow here. Before production, map the Web
commit/version, manifest digest, image digest or Worker version, previous artifact
and rollout flag in a trusted release record. The Web CI job packages a fresh
commit artifact without a previous artifact; operational publishing must supply
its actual previous release explicitly before deployment.

## Docker configuration

### Trusted Proxy origins for browser diagnostics

`CINATOKEN_WEB_PROXY_ORIGINS` optionally adds trusted browser Proxy origins to
`connect-src` on every Web shell, so navigation from another page into Simulator
uses the same policy. For example:

```text
CINATOKEN_WEB_PROXY_ORIGINS=https://proxy.example.com:9443,http://localhost:8787
```

Each HTTP(S) origin adds its matching WS/WSS source with the same host and port.
An empty value preserves the existing `'self' wss:` policy; the existing global
`wss:` source remains for compatibility. This setting is not a complete WSS
allowlist. It does not change Proxy authentication, CORS, billing, API forwarding,
the 28 rollout flags, or microphone permissions.

The list accepts at most 16 comma-separated origins and 4096 ASCII characters.
Spaces around entries are accepted and duplicates are removed. Use lowercase
HTTP(S) schemes and ASCII DNS names (punycode is supported), canonical dotted
IPv4, or `[::1]`; optional decimal ports are 1–65535 without leading zeroes.
External origins require HTTPS. HTTP is accepted only for exact `localhost`,
`127.0.0.1`, and `[::1]` local development origins. DNS labels are at most 63
characters, the hostname is at most 253, and its final label begins with a letter.
Other IPv6 forms, Unicode or uppercase names, trailing dots, and alternate IPv4
spellings are intentionally unsupported. Wildcards, userinfo, paths (including
a trailing slash), queries, fragments, control characters, and header/config
syntax are rejected.

Set the value before generating the Cloudflare Web config. Docker validates it
at container startup and substitutes only the derived, validated CSP sources.
Invalid configuration stops Docker startup or Wrangler generation; a manually
misconfigured Worker returns a generic 503 for an opted-in shell while forwarding
API requests as before. Legacy Next uses the same validator in
`packages/admin/next.config.mjs`: set the same value when building Admin, since
compiled Next headers retain build-time configuration. For `Dockerfile.admin`, pass
`--build-arg CINATOKEN_WEB_PROXY_ORIGINS=...`; a runtime environment variable cannot
replace those compiled headers. The Admin build includes the Web workspace and
shared diagnostic screens. Its existing Auth hosts,
`upgrade-insecure-requests`, diagnostic microphone policy, and other headers stay
in place. Local HTTP origins remain subject to the browser's mixed-content and
upgrade rules; use HTTPS for hosted diagnostics.

Build `Dockerfile.web` from the repository root with the artifact path:

```powershell
docker build --file Dockerfile.web --build-arg WEB_RELEASE_PATH=.release/web/web-v2 --tag cinatoken-web:local .
docker run --rm cinatoken-web:local --check
```

The Node 22 stage verifies the same manifest before Nginx receives its assets; it
does not rebuild `dist`. The `input` directory is an explicit artifact directory
alias, retaining the manifest's original identity. Manifests stay outside the
public root. Omitting the build argument fails safely. Connect the entry to the network of
the existing Admin container. The entry listens on port 8080. Configure:

- `CINATOKEN_ADMIN_UPSTREAM`: Admin origin, default `http://admin:8789` for a local
  Compose service. Accepts a host and optional port without path or credentials.
- `CINATOKEN_WEB_ACCOUNT_ENABLED`: exactly `true` to opt in, `false` to roll back.
- `CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED`: independently opt in to exact GET/HEAD
  `/admin` and `/admin/`; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_USERS_ENABLED`: independently opt in to exact GET/HEAD
  `/admin/users` and `/admin/users/`; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED`: independently opt in to GET/HEAD
  `/admin/users/:id` for UUID or canonical simple `ext%3Asystem%2Fuser` IDs;
  defaults to `false`, and `false` rolls detail pages back to Admin.
- `CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED`: independently opt in to the two exact
  Providers GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_MODELS_ENABLED`: independently opt in to the two exact
  Models GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED`: independently opt in to the two exact
  Endpoints GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_ROUTES_ENABLED`: independently opt in to the two exact
  Routes GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED`: independently opt in to the two
  exact Data Policies GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_PRESETS_ENABLED`: independently opt in to the two exact
  Presets GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED`: independently opt in to the two exact
  Guardrails GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED`: independently opt in to the two exact
  Reliability GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED`: independently opt in to the two
  exact Model Analytics GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED`: independently opt in to the
  two exact Provider Analytics GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED`: independently opt in to the two
  exact User Analytics GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED`: independently opt in to the two
  exact Request Logs GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED`: independently opt in to the two
  exact Budget Audit GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED`: independently opt in to the
  two exact Tool Invocations GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED`: independently opt in to the two
  exact config timezone GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_ADMIN_CONFIG_ENABLED`: independently opt in to the two exact
  full config GET/HEAD paths; defaults to `false`.
- `CINATOKEN_WEB_DNS_RESOLVER`: optional IPv4 resolver; otherwise reads the
  container's resolver configuration, allowing runtime upstream DNS resolution.

The proxy preserves `$http_host`, including a public port, and forwards a valid
incoming `X-Forwarded-Proto` with its own scheme as fallback. If an outer ingress
terminates TLS, it must set that header and prevent untrusted clients from
overriding it. Proxy buffering and request buffering are disabled, as is proxy
redirect rewriting. Cookies and Origin are not rewritten. The Nginx base image
can be overridden with `NGINX_IMAGE`; pin its verified digest for a release.

## Evidence status

```powershell
node --import tsx --test packages/web/edge/*.test.ts packages/web/scripts/gen-web-wrangler.test.mjs packages/web/scripts/package-release.test.mjs docker/web/config.test.mjs
```

These tests use mocked binding requests/responses and inspect Docker templates.
They verify routing policy, artifacts, old-tab lazy loads, resource retention,
expiry, artifact rollback, public origin/header/body preservation, multiple
cookies, streams and generated configuration. Cache tests compare the Nginx map
with Worker behavior. They do not
prove Cloudflare runtime behavior, Nginx syntax/runtime, image build, a real
CinaAuth callback, a deployment or a rollback exercise. E07 stays pending until
those platform checks are recorded. No deployment is run by these tests.

Local evidence recorded on 2026-09-27:

| Check                                               | Result    | Scope                                                                                                                              |
| --------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Entry, generator, release and Docker template tests | 28 passed | Mock/local files, old/new chunks, rollback and matching cache maps                                                                 |
| `tsc -p packages/web/edge/tsconfig.json`            | Passed    | Worker and entry tests                                                                                                             |
| `bash -n docker/web/entrypoint.sh`                  | Passed    | Shell syntax only                                                                                                                  |
| Wrangler 4.127.1 `deploy --dry-run`                 | Exit 0    | Updated Worker and verified release configuration bundled; no upload. Diagnostic log write failed with EPERM outside the workspace |
| Docker image build / Nginx runtime                  | Pending   | Docker/Nginx executable unavailable on this host                                                                                   |
| Cloudflare, real auth, rollout/rollback             | Pending   | No deployment attempted                                                                                                            |

The existing diagnostic executable
`C:/cinagroup/cinatoken/.wrangler/publish-20260927/node22-diagnostic/node-v22.23.2-win-x64/node.exe`
was verified as `v22.23.2`. It passed the same 28 tests, Edge TypeScript, and
`package-release.mjs --verify local-e07-20260927-085552` without rebuilding dist
or installing dependencies. This is Windows Node 22 evidence; it does not prove
Linux, the Docker verification stage, Nginx runtime or hosted CI.

The updated CI builds the release image, checks Nginx and runs
`node docker/web/smoke.mjs <release-id>` for container GET/HEAD, cache,
missing-resource and private-manifest checks. It starts/removes only its own new
test container. These checks have not run on this host or hosted CI; the workflow
definition is not a Linux Node 22/Docker runtime result. E07 remains pending.

The actual local artifact is
[local-e07-20260927-085552/manifest.json](../../../.release/web/local-e07-20260927-085552/manifest.json),
created at `2026-09-27T08:55:52.000Z`, with 37 files, 14-day retention and no
previous/rollback input. Its manifest SHA-256 is
`890f8de739901c33bf54d8d507255a0a8402045fa29435d6e91cc17d8df0bf1b`.
Verification succeeded, and a later byte/inventory comparison found exact equality
with the current `dist`: no changed, missing or additional files. This local
artifact proves packaging of that built snapshot, not that every later source
change has been built or released. A later build requires a new unique release
id, a repeated comparison/verification and newly generated configuration; never
overwrite this artifact.

The generated [configuration](../wrangler.web.jsonc) points to
`../../.release/web/local-e07-20260927-085552/assets`, has `routes: []`,
`workers_dev: false` and `CINATOKEN_WEB_ACCOUNT_ENABLED: "false"`. The actual
dry-run command was:

```powershell
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config packages/web/wrangler.web.jsonc --outdir .tmp/web-e07-dryrun
```

It exited 0, bundled 3.66 KiB (1.44 KiB gzip), and reported 42 asset entries.
The artifact inventory contains 37 regular files and five directories. Wrangler
reported an EPERM diagnostic while writing its log under the user configuration
directory; no deployment/upload was performed. The artifact and configuration
are ignored; the dry-run directory is local output. None is a published CI artifact.

The configuration follows the official [Worker-first static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/),
[HTTP Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
and [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
contracts, checked on 2026-09-27.

## Incremental account candidate

The historical P4 frozen candidate is
[local-p4-20260927100401](../../../.release/web/local-p4-20260927100401/manifest.json),
created at `2026-09-27T10:04:01.000Z`. Its 54 files contain 41 current files and
13 retained hash assets from the local `local-e07-20260927-085552` snapshot.
The manifest SHA-256 is
`c558932d4fb933942804605e4104004e2133134e1edc542a706134c3005a1fd8`.
Node 24 verification and the current-file byte/hash comparison passed; the shell
references `index.0a5007ef54.js`. The generated configuration now references this
candidate and keeps routes empty, workers_dev false and rollout disabled.

The previous artifact and its dry-run described above are historical evidence.
This local previous pointer is not an online release record or rollback exercise.
The prior diagnostic Node 22 executable was unavailable when rechecked; this
candidate has not been verified on Node 22/Linux, Docker or Cloudflare.
Shared 24 fixture interaction checks and NFT eight final locale/layout checks
passed on this build. Real identity, database, provider, chain and deployment
acceptance remain pending. See the [migration evidence](../../../docs/developers/architecture/web-frontend-migration.md#55-账户领域增量与最终构建证据).

## Providers checkpoint

The subsequent frozen local checkpoint is
[local-p5-20260927123823](../../../.release/web/local-p5-20260927123823/manifest.json).
Its entry is `index.7ff2962b93.js`; 52 current files and 34 retained hash assets
form an 86-file artifact with manifest SHA-256
`80ad1942192a1409f11519474b619fb0d2cd67f26257d7e5a67c215829b06fee`.
Verification and the 52 current-file byte/hash comparison passed on Windows
Node 24. Its previous pointer is the historical local P4 snapshot, not an online
release. The generated configuration references this artifact and disables both
rollouts, public routes and workers.dev.

On this exact production-preview build, all ten account suites passed 244 fixture
interaction checks, Providers passed 36 and Console entry passed 13. The local
development proxy bypasses the exact Providers page, allowing Web navigation
while other console pages still reach Next. Public Web pages under development
are local-preview entry points; the hosted Worker/Nginx continue serving public
Next SSR. These checks do not prove hosted CI, Node 22/Linux, Docker/Nginx,
Cloudflare, real identity/database/provider execution or a rollout/rollback.
Later source edits require a new build and unique artifact; this checkpoint is
immutable. See [5.7 evidence](../../../docs/developers/architecture/web-frontend-migration.md#57-providersconsole-与完整账户-fixture-检查点).
