# C04.7 seller statistics application binding (v350, review only)

The seller `GET /api/user/shared-keys`, update, and revalidation responses now
have a separate exact `SIGNED_SELLER_STATS_READER=reviewed-v1` branch. It
keeps the v344 response projection but obtains a signed claim through an
`STATS_CLAIM_ISSUER` service binding and calls the v349 bound SQL function
through `STATS_READER_HYPERDRIVE`. The client checks the direct
`cinatoken_gateway_stats_reader` LOGIN before the query; v349 independently
checks `SESSION_USER`, signature, nonce, source readiness, key scope, and current
seller ownership. The ordinary repository client is used for the shared key
list and does not execute the private usage function. Both bindings are absent
from the generated Admin Worker configuration. The branch stays off unless
explicitly selected, and absence of either binding fails the whole response.
The separate `/api/admin/shared-keys` console route keeps its existing
default-off legacy behavior; this seller-only switch does not silently alter
its statistics.

The seller route forwards only an opaque
`__Host-cinatoken_stats_session` cookie to the issuer, with sorted requested
key IDs. It never forwards `cinatoken_session`, `user_session`, a seller ID,
or an unsigned portal principal. It accepts a response only when the seller ID
equals the currently authenticated portal principal, the key scope matches
exactly, the expiry is within five minutes, and the signature encoding is
canonical. A duplicate or missing independent cookie, reused runtime
connection string, or wrong Postgres LOGIN fails closed. The issuer remains
**unimplemented**; a test double exercises only the wire contract.

This distinction is essential. The actual PG73 runtime grant gives
`cinatoken_gateway_runtime` `INSERT` on `portal_sessions` and `UPDATE` on
`users`. The owned native fixture proves it can create a forged portal session
and alter `users.external_user_id` under a transaction. Existing portal
authentication therefore cannot authorize claim issuance. The current OIDC
callback validates an IdP token but retains only the ordinary database
session. A production issuer must be a separate Worker with its own secret and
private, non-runtime-writable session/subject-to-seller authority. It must
derive identity from independently verified CinaAuth evidence, verify exact
key ownership before signing, and never trust an Admin-submitted seller ID or
mutable portal session. Its opaque browser credential must be set as an
`HttpOnly; Secure; Path=/` host-only cookie with no `Domain`, and logout must
revoke it. Provisioning, revocation, rotation, and deployment of
that authority remain open. The new Admin branch cannot be activated safely
until that issuer and distinct Hyperdrive credentials are reviewed and tested.

Local evidence:

- Admin `tsc --noEmit` passed.
- The old projection and new issuer/binding unit tests passed 6/6. They cover
  cookie isolation, canonical scope, wrong seller/scope/expiry, absent or
  duplicate independent cookie, missing bindings, reused runtime connection,
  and no ordinary SQL fallback. The previous Admin projection tests remain
  passing.
- The current [PG18.6 native fixture](../../../../scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs)
  passed 19/19 stages with cleanup PASS. Its new stage calls the actual Admin
  reader code through the direct stats-reader LOGIN and rejects the ordinary
  runtime LOGIN; another new stage proves ordinary portal identity can be
  forged. The [current machine report](./C04-stats-claim-reader-v349-results.json)
  records the current source SHA-256 values for SQL, native fixture, Admin
  reader, seller route, and runtime grants. Earlier v349 results were a
  historical snapshot of the fixture before these two stages and do not
  describe the current source.

This is a local binding contract, not a production issuer or end-to-end
authorization proof. No formal migration, remote SQL, secret provisioning,
Cloudflare service binding, deployment, or Linux CI run occurred. C04.7 stays
open.

```powershell
cd C:\cinagroup\cinatoken\packages\admin
node --import tsx --test lib/shared-key-credited-usage-reader.test.ts lib/shared-key-signed-stats-reader.test.ts
cd C:\cinagroup\cinatoken
npm run typecheck -w @octafuse/admin
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs
```
