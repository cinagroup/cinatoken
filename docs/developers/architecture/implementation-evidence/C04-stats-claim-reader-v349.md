# C04.7 signed credited-usage reader binding (v349, review only)

The [v350 local application binding](./C04-stats-app-binding-v350.md) subsequently
extended this native fixture and refreshed its machine report to the current
source hashes and 19 passing stages. The v349 narrative below describes the
original SQL-only proposal; its original 17-stage result is historical.

The [v348 verifier](../../../../packages/core/migrations-proposals/postgres/shared-key-stats-signed-claim-v348.sql) checks a separately signed `stats.read` claim but does not itself read usage. The [v344 credited-usage reader](../../../../packages/core/migrations-proposals/postgres/shared-key-credited-usage-reader.sql) audits legacy and economic sources and exposes current-owner summaries, but its read function is migrator-only. The [v349 proposal](../../../../packages/core/migrations-proposals/postgres/shared-key-stats-claim-reader-v349.sql) adds one `SECURITY DEFINER` endpoint for the separate direct `cinatoken_gateway_stats_reader` LOGIN. It calls the v348 verifier and projects v344 summaries in the same transaction. Only keys currently owned by the signed seller are returned; historical credit for a former owner remains private. The ownership rows are locked `FOR SHARE` during the read. The proposal revokes the reader's direct permission to call the verifier, leaving the bound reader as its only claim-consuming entry point.

Installation is default off. The direct migrator must set `cinatoken.shared_key_stats_claim_reader_install='reviewed-v1'` locally while applying the SQL after exact formal PG73 and the v344/v348 proposals. The v344 full-history audit and both backfill cursors must independently activate the ready row before any read succeeds. Each read rechecks that row, both cursor completions, and the seven source/history triggers. Ordinary runtime, economic consumer, and the stats-reader's direct table and older reader access remain denied. The existing broad runtime grant can be rerun without exposing this endpoint.

The [owned PG18.6 native fixture](../../../../scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs) installs formal PG73 and the full review-only proposal chain. It seeds legacy and economic credit plus a pending event, signs claims in Node with a key independent of the SQL reader session, and tests: default-off installation; unready and cursor/trigger drift closure; credited totals; seller, key and audience tampering; valid claims for unowned keys; committed nonce replay; direct ACL denial; current-owner transfer with old credit hidden; new-owner credit; and real runtime-grant rerun. The [machine result](./C04-stats-claim-reader-v349-results.json) records stage outcomes, source SHA-256 values, and local cluster cleanup.

Nonce uniqueness is guaranteed only for committed transactions. The fixture deliberately reads rows in an explicit transaction, rolls it back, then shows that the same claim can be used again until its short expiry. This is a read-only endpoint; it does not promise strict one-time disclosure. No independent production issuer, signing-secret provisioning or rotation, HTTP route binding, formal migration, production grant, remote SQL, or deployment is supplied. The full-history readiness audit was exercised on a small fixture and still needs target-scale review. C04.7 remains open.

```powershell
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-shared-key-stats-claim-reader-v349.native.test.mjs
```
