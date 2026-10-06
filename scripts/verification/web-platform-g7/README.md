# Isolated Web platform G7 acceptance

The manual `Web platform G7 isolated TLS and PostgreSQL` workflow builds the
existing Admin, Proxy, migrator, frozen Web and paired SSR images from its exact
Git SHA. It runs those actual services with a disposable PostgreSQL 16 database
and a dedicated HTTPS ingress. It does not change or deploy production.

The first executable stage checks the original nine TLS/Origin/Host wire cases,
certificate and SNI rejection, raw-port isolation, API priority, nonempty real
PostgreSQL catalog through Proxy and Admin, four locales across eight public SSR
routes with GET and HEAD, and the exact frozen resource bytes. Model endpoint
fixtures use the actual core parser, operation admission, credential encryption
and route subject fingerprint. Fixture endpoint verification is controlled test
data and does not attest to a real provider contract.

The runner uses a fixed local Unix Docker socket, unique ownership labels, three
internal networks and no published ports. QA joins only the client network; the
ingress is its only application peer. The ingress forces canonical `Host` and
`X-Forwarded-Host` to `app.test`, forces `X-Forwarded-Proto` to literal `https`,
clears `Forwarded`, and preserves browser `Origin`, cookies and separate
`Set-Cookie` fields. TLS uses a fresh local CA and an `app.test` SAN certificate;
there is no certificate bypass. Admin's public API and issuer/account/app origins
are explicit internal test origins, so absent configuration cannot select a
production fallback.

Migrations run twice against the actual disposable database. The ledger is
compared with every SQL migration contained in the image. Admin and Proxy each
observe database identity, server version, schema fingerprint and session counts
through a read-only transaction after the HTTPS checks. Seed mode loads Core for
its actual encryption, repositories and fixture admission. Observe mode uses the
application image's existing postgres driver, with the same connection options,
startup search path and explicit session initialization; it requires no standalone
Core or Drizzle dependency. The local dependency control copies only postgres into
an isolated application tree and makes Core's Drizzle import unavailable. It runs
the observation contracts and failure cases through the real driver against a
bounded loopback protocol peer. That peer does not execute SQL; path, transport and
Windows platform mapping remain test controls, not Linux or PostgreSQL acceptance.
All processes currently
use the same `postgres` superuser in the owned database. This stage **does not
prove restricted runtime ACLs or native PostgreSQL 18**; those remain separate
requirements.

Each child command has bounded execution and an explicit closed exit receipt.
The runtime has a shared 12-minute budget and cleanup has its own two-minute
budget. Cleanup checks ownership before removal and verifies every owned
container, network and volume is absent. Timeout, unknown exit, failed assertion
or failed cleanup stays a failure. An independent always-step uses the persisted
ownership registry to recover and verify cleanup after an outer interruption; its
cleanup result never overrides the original runtime result. Available failed logs
are retained. Ephemeral
database, encryption and OIDC secrets are never printed; any matching secret in
captured logs is explicitly redacted. Private keys and credential files stay
outside the uploaded receipt directory.

The output reports the first stage separately and always keeps `fullG7Verified`
and `fullG8Verified` false. The remaining full G7 layers are signed controlled
OIDC login, authenticated PostgreSQL writes, subject/workspace and revocation
isolation, real Proxy SSE/abort/WebSocket and retry behavior, current plus retained
resources during gray switching, and verified rollback while retaining writes.
Controlled OIDC will prove only a synthetic issuer integration. Actual CinaAuth
client registration, human identity, MFA and real role/workspace authorization
remain unverified until a real authorized identity completes those checks.

Local source checks can run without Docker:

```sh
node --import tsx --test scripts/verification/web-platform-g7/*.test.mjs
node --check scripts/verification/web-platform-g7/run-owned-linux.mjs
node --check scripts/verification/web-platform-g7/database.mjs
node --check scripts/verification/web-platform-g7/wire.mjs
```

They do not count as Linux Docker, TLS or database acceptance. Dispatch the manual
workflow at the reviewed source SHA to obtain the first real runtime result.
