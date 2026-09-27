# C04 v383 review-only buyer request-log projection receipt

**Result:** The owned PostgreSQL 18.6 fixture verifies a narrow, database-generated request-log projection receipt in the real v372 buyer transaction. It does **not** establish complete HTTP/Provider request identity or request-level success. The corresponding [machine report](C04-legacy-buyer-request-projection-v383-report.json) records the source hashes, backend PIDs, xid8 values, stages, and cleanup result.

## Transaction contract

1. The v378 journal commits immutable financial expectations and a caller-reported `full_request_sha256`. The v383 wrapper then commits a separate, exact 19-column JSONB log projection through the journal LOGIN. PostgreSQL computes `projection_sha256` from its own JSONB representation. A different backend verifies that committed row and closes the connection before the buyer writer is called.
2. `prepare_v383` and every request-log `INSERT` take the same transaction advisory lock for `request_id`. A log committed first makes later preparation fail. A prewrite committed first is visible to the buyer trigger. Verification follows the same advisory-lock-then-row-lock order as the trigger.
3. Once the proposal is installed, every `cinatoken_gateway_buyer_settlement` LOGIN request-log `INSERT` must match a verified, unexpired prewrite for that exact ID while its v378 intent is still `prepared`. A callback prepared for A that writes B, an altered model/route/protocol projection, and an expired prewrite all roll back the complete v372 transaction. A different LOGIN cannot consume an existing prewrite.
4. The `AFTER INSERT` trigger alone inserts `receipts_v383` with PostgreSQL's `pg_current_xact_id()`. Application LOGINs have no direct receipt DML. A deferred constraint requires the existing event marker and budget receipt for the same xid8 before commit. The fresh reader recomputes the actual log projection, checks the prewrite, receipt, event and budget xid8, and invokes the real v375 reader using the immutable v378 financial expectations. Its strongest result is **`db_log_projection_confirmed`**.

The receipt proves this selected DB-visible log projection and the v375 financial subset coexisted in one committed buyer transaction. Its application-role unforgeability assumes the migrator/superuser and migration DDL remain trusted. It does not make the caller's `full_request_sha256` authoritative.

## Native evidence

The fixture installed the 73 formal PostgreSQL migrations, the real v368/v371/v372 buyer path, v2 economic producer and budget receipt, the real v375 terminal reader, v378 journal, and this v383 proposal under dedicated buyer, journal, reader, runtime, admission and producer LOGINs. The fixture uses a minimal v362 grant table and manual buyer application grants, as detailed in the report.

The final native run passed **23/23 stages; cluster cleanup PASS**. In the acknowledged case, the writer callback ran once; the v383 receipt, economic event marker, and budget receipt carried the same xid8. The fixture also exercised:

- A historical real financial log followed by a v378 intent: v383 rejects the late prewrite.
- A concurrent committed log: `pg_blocking_pids` observed the journal backend waiting on the request lock, then the late prewrite was rejected.
- A replay with a new intent ID and different full-request digest for an existing request ID: v378's unique request constraint rejected it.
- A mismatched log projection, an A-intent/B-writer callback, a non-buyer LOGIN attempting to consume a verified prewrite, and a 31-second-old verified prewrite: each failed without a new debit or receipt. The expiry test uses a migrator-only metadata time warp.
- PostgreSQL writer `CommandComplete(COMMIT)` loss after real commit: writer callback once; an independent reader later returned `db_log_projection_confirmed` and found matching receipt/event/budget xid8.
- A delayed original COMMIT: the independent reader first returned `unconfirmed` with no visible receipt or debit, then `db_log_projection_confirmed` after release and commit.
- PostgreSQL v383 prewrite `CommandComplete(COMMIT)` loss: the durable prewrite was independently visible, but verification had not occurred and the financial writer callback count was zero.

The proxies manipulate PostgreSQL protocol messages, not TCP acknowledgements. The delayed proxy holds original client COMMIT frames at an intermediary; it does not simulate PostgreSQL internally delaying an already received COMMIT. No process crash, production pool or scheduler was exercised.

Run locally with an owned PostgreSQL 18.6 binary installation:

```powershell
$env:GATEWAY_NATIVE_PG_BIN = 'C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-legacy-buyer-request-projection-v383.native.test.mjs
```

`node --check` passed. The full core TypeScript check remains red on pre-existing test/type errors (including missing `vitest`); it reported no diagnostic in the new v383 TS file.

## Complete-request identity blocker

The v378 `full_request_sha256` is caller supplied. v383 intentionally does not copy that value into an authoritative receipt. The fixture supplied an all-zero full-request digest, then completed a real v372 transaction and obtained only `db_log_projection_confirmed`. This is a direct negative for promoting the v378 digest to full-request proof.

The proxy's request-body logging policy defaults to `off`, mapping two different actual request/upstream wire bodies to the same persisted `NULL`. The fixture asserts that collision with distinct SHA-256 hashes. A redacted log body and bounded Provider-response snapshot also omit information needed to reconstruct the actual complete outbound request, response, and Provider bill. Two distinct real-world exchanges can therefore have the same DB-visible projection and financial facts. No SQL reader can distinguish those exchanges from current committed rows.

To close full request identity, a later reviewed change must hash the **actual sent and received bytes at a trusted network boundary**, establish a durable request/attempt nonce and exact canonicalization contract, independently bind Provider result or bill evidence, and carry those authenticated digests into the same buyer transaction. The reader must compare those trusted attestations, rather than a caller assertion, while preserving privacy by storing digests instead of raw prompts/credentials where possible. The current v372 path has no such trusted pre-egress/response attestation seam. The complete-request requirement remains blocked.

Guardrail reservation rows, unreserved windows, audit, and daily statistics do not gain request-scoped immutable xid8 markers from v383. Their apparent values after commit are not proof of their individual transaction origin. The v375 financial subset also does not independently authenticate a final Provider invoice.

## Enablement boundary

This is a **default-off, review-only proposal**. Installing the v383 trigger is an immediate buyer LOGIN cutover barrier: every existing v372 buyer request-log insert would fail until all buyer callers are routed through the v383 prewrite/verification wrapper. It is not safe to incrementally enable the trigger for a subset of buyer requests. No formal migration, production deployment or retention policy is supplied by these files. The wrapper calls the financial writer at most once and never retries it after an uncertain COMMIT.

The fixture's full 27-entry source-hash inventory is in `sourceSha256` in the linked report. Selected SHA-256 pins:

| Source | SHA-256 |
| --- | --- |
| v383 SQL | `0ae99953388a2db3fe4c172fd4be8c1b6500532fd7915aeda9620cdd85bb8672` |
| v383 TS | `c759b26ab4ce71f5e1deca2190492dd1f41bbab73a03a57c739666e60abf42ac` |
| v383 native fixture | `4a74d000750b905d1194d5e0c27605d286794c7809be1e931fddc97c197a7f3d` |
| real v372 writer TS | `880f94f1ba2acbbcf549727dd15ccaa058c79acc35c5b239ac4411ae39b6e07e` |
| real v375 reader SQL | `4979a5404f768dc49b090125dcd71ef399f77a16fecef526610f37159aa451f0` |
| v378 journal SQL | `fa4f937f6ef876185d1c358029040677b419c25ac97c40c29d61cc7b57812f05` |
| request-body logging policy | `26102bf0a4bf1809dd05f9f2b7619086c0b52cac1efae87d173b6821dd1ec6bf` |
| 73 formal migration corpus | `23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc` |
