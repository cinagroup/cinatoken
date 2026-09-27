# C04 v343: version-aware PostgreSQL snapshot seller consumer

Status: **review-only, production default off**. Formal migration heads remain PostgreSQL 73 / D1 68 / MySQL 64. No remote database was changed.

## Contract and installation order

[The v2 consumer companion](../../../../packages/core/migrations-proposals/postgres/shared-key-snapshot-earning-consumer-v2.sql) installs after PG73, quote versions, dispatch quote attempts, economic outbox, v340 producer, v340 snapshot consumer, and [buyer debit v2](../../../../packages/core/migrations-proposals/postgres/shared-key-buyer-debit-v2.sql). It requires a direct migrator LOGIN and the transaction-local `cinatoken.shared_key_consumer_v2_activation='reviewed-v1'` value. Its preflight pins the exact PG73 ledger, v340 core body, v341 buyer debit verifier and v2 reject guard bodies, definer/search path/function properties, trigger binding, private source ownership, and default ACLs. It locks source tables and function catalog tuples during the change. Installation fails atomically if those contracts differ.

The old v340 consumer body is renamed to an owner-only private core. The old v2-reject trigger is removed. A new `consume_shared_key_economic_event(text)` wrapper, callable only by the dedicated consumer LOGIN, locks the committed immutable event, rejects unsupported versions and malformed v2 actual debit **before invoking the core**, then uses the unchanged per-attempt quote calculation and atomic seller detail, balance, ledger and event-marker transaction. The v341 deferred debit verifier and reservation mutation guard establish the ordinary-user debit at event commit; this companion pins those functions and their trigger. The v1 event path still reaches the same core. The private core cannot be called directly by the consumer or runtime role.

For a v2 `actual` buyer basis, `buyer_debit_micros` must be safe, non-null and exactly match `buyer_charged_cost` in micros; the core credits only attempts with confirmed usage and provider cost from their immutable dispatch quote. `reserved` and `none` buyer bases enter `pending_manual` per attempt, regardless of confirmed upstream facts, and create no seller balance or ledger credit. Pending decisions are immutable; later actual reconciliation requires a separately reviewed adjustment event.

## Native verification

With `GATEWAY_NATIVE_PG_BIN=C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin`, run:

```powershell
npx tsx --test scripts/db/cutover/postgres-shared-key-snapshot-earning-consumer-v2.native.test.mjs
```

Result: **1/1 test PASS, 31/31 stages PASS, owned-cluster cleanup PASS** on PostgreSQL 18.6. The [machine report](./C04-postgres-snapshot-earning-consumer-v2-v343-results.json) contains the source hashes and stage names. Native checks cover default-off and dependency drift rollback, hostile default ACL, direct private-core denial, fresh v1 compatibility, v2 actual quote/fee/net and ledger posting, v1/v2 ACK-loss replay, a two-attempt reserved v2 event with both attempts independently confirmed but both pending, no seller balance movement for reserved or no-charge events, ledger-conflict transaction rollback, and two separate consumer connections racing on one event with exactly one credit.

Source SHA-256: companion SQL `272158acbed2ab52965d154f342ef6452d626d1e4393c40cae32d5f519f4b984`; native fixture `e68ecec3e731ac593d69476657bdb0745b2c96807aa82b3ab4389d1ce8c40579`.

## Remaining gates

This fixture's buyer account update is synthetic. It does not prove a real `recordUsage` caller, production v2 producer, Workers/Hyperdrive transaction identity, queue delivery, Linux CI, D1/MySQL, or production deployment. The v340 core still credits the withdrawable seller balance immediately; C12 release/hold policy and financial approval remain open. No formal migration or runtime flag was enabled by this work.
