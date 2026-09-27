# C04 committed private read to grant bridge (v367)

This is a review-only local proof across the v366 private reader, the v362/v365 grant and send-start path, and one loopback physical POST. It does not activate a public or private Worker.

The [native fixture](../../../../scripts/db/cutover/postgres-complete-text-read-grant-bridge-v367.native.test.mjs) creates an owned PostgreSQL 18.6 cluster, installs formal PG73 plus the required review proposals, and uses separate direct LOGINs for private read, admission, grant, and custody/start. The [machine report](./C04-complete-text-read-grant-bridge-v367-report.json) records source SHA-256 values, stages, and cleanup.

For each of three cases, the reader commits and closes its private selected-route read. A later transaction changes the route model name, Provider ciphertext, or route attestation. A real v362 grant call then returns `stale_manifest`; the old in-memory read is also passed to the local holder, whose own v362 call returns `stale_manifest`. Each case records zero grant, custody, and send-start rows, leaves the ordinary hold reserved, and calls the injected fetch transport zero times.

After restoring and reattesting the source, one positive control commits a fresh quote, read, grant, custody, and send-start without sending. A second fresh request passes the committed private snapshot through the local holder and the actual direct grant, custody, and send-start clients. Only after their COMMIT and connection-close acknowledgements does an injected transport map the synthetic HTTPS endpoint to an owned HTTP loopback server. The server receives **one** complete POST with the expected Bearer; its body SHA-256 and the original HTTPS URL SHA-256 match the durable v362 grant. The owned PostgreSQL 18.6 report records **17/17 stages and cleanup PASS**, with the fixture hash matching its current source.

Run locally with:

```powershell
$env:GATEWAY_NATIVE_PG_BIN=(Resolve-Path '.wrangler/staging/pg-native-v292-binaries/extracted/pgsql/bin').Path
node --import tsx --test scripts/db/cutover/postgres-complete-text-read-grant-bridge-v367.native.test.mjs
```

This test uses a synthetic encrypted Provider credential and a non-routable endpoint mapped to loopback. The negative fetch spy observes only this holder path, and the positive server proves one local socket POST, not an actual Provider send or production transport. Live Worker binding, private KEK deployment, Linux CI, D1/MySQL parity, long SSE renewal, result settlement, and coordination with legacy reapers remain open. Keep the path review-only until those gates have separate evidence.
