# C04 v347: dedicated buyer LOGIN for the v2 economic producer

Status: **review only; default off**. This companion follows the v346 buyer critical writer privilege split in an owned PostgreSQL 18.6 test cluster. Formal migration heads remain PostgreSQL 73 / D1 68 / MySQL 64. No remote database, Worker, credential, grant routine, Queue, or deployment changed.

## Contract and order

The [v347 SQL](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-producer-buyer-login-v347.sql) applies only after the v340 producer, v341 debit verifier, [v343 six-argument v2 producer](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-producer-v2.sql), [v344 buyer budget receipt](../../../../packages/core/migrations-proposals/postgres/shared-key-buyer-budget-receipt-v2.sql), and [v346 buyer privilege split](../../../../packages/core/migrations-proposals/postgres/buyer-critical-writer-privilege-split-v346.sql). It requires a direct migrator LOGIN, exact PG73 ledger, an explicit transaction-local activation value, pinned v1/v2 producer bodies, private outbox tables, the v344 receipt triggers, and the financial revokes from v346. It shares the current grant routine's advisory lock. Failed preflight rolls back without modifying the producer.

The SQL preserves the six-argument v2 function name used by the real Core critical writer. Its replacement body differs from v343 **only** in the `SESSION_USER` check and its matching error text: the required caller becomes the independent `cinatoken_gateway_buyer_settlement` LOGIN. The v347 native fixture compares the complete function bodies after those two substitutions. The migrator-owned `SECURITY DEFINER` function still validates all quote outcomes, buyer basis and debit, and same-transaction log marker. The v344 migrator-owned triggers still create a private receipt from the real `users` change and verify its same-transaction net debit. The buyer LOGIN gets schema `USAGE` and v2 function `EXECUTE`; it does not gain private table writes or seller/management/payout rights. The former ordinary runtime loses `EXECUTE` on **both v1 and v2 producers**, so v1 callers must be migrated or stopped before a cutover.

## Owned native proof

Run with `GATEWAY_NATIVE_PG_BIN=C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin`:

```powershell
node --import tsx --test scripts/db/cutover/postgres-shared-key-economic-buyer-login-v347.native.test.mjs
```

The [native fixture](../../../../scripts/db/cutover/postgres-shared-key-economic-buyer-login-v347.native.test.mjs) passed **1/1 test, 13/13 stages, owned-cluster cleanup PASS**. The [machine report](./C04-economic-buyer-login-v347-results.json) pins all proposal, grant routine, critical writer and fixture SHA-256 values. It covers default-off installation and source drift rollback; exact v2 body comparison; postflight ACLs; runtime `SET ROLE`, seller write, direct buyer spend, and v1/v2 function denial; buyer direct private receipt and seller account denial; a real buyer LOGIN critical writer transaction committing a 10,000-micro ordinary debit, private v344 receipt, v2 event and one attempt; idempotent replay; a 20,000-micro reserved ceiling debit distinct from 10,000-micro Guardrail usage; invalid quote rollback; a runtime forged buyer log rejected by the claimed-attempt event requirement; and current grant routine rerun behavior.

## Remaining gates

This is an identity contract in a local database. The buyer LOGIN itself can directly update the buyer financial columns granted by v346; its credential is a trusted financial capability, so a separate Worker/Hyperdrive binding and secret isolation are required. The current [`grantPostgresRuntime`](../../../../scripts/db/cutover/grant-postgres-runtime.ts) rerun restores ordinary runtime direct gateway financial writes. The native proof confirms it **does not** restore private outbox v1/v2 producer `EXECUTE`, but the reopened direct writes still block production cutover. The grant routine and rollback order must be changed atomically with any real split. The v1 revoke is intentionally disruptive to old economic callers; no application wiring or traffic migration was made here. A shipped `recordUsage` path must use the buyer database identity; no production activation was performed.

The fixture uses synthetic quote and provider usage facts. It does not prove source authenticity, seller consumer/credit, release or adjustment policy, admission authority, management/payout/C03 recovery compatibility, Worker/Hyperdrive transaction identity, D1/MySQL, Linux CI, or production lock/capacity behavior.
