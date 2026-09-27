# C04 v343: same-transaction v2 economic producer

Status: **review-only, default off**. Formal migration heads remain PostgreSQL 73 / D1 68 / MySQL 64. No remote database, Worker, Queue, or deployment was changed.

## Contract

The [v2 companion SQL](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-producer-v2.sql) adds an EXECUTE-only six-argument function for the dedicated runtime LOGIN after the v340 producer and v341 buyer-debit proposal. It leaves the five-argument v1 producer unchanged. Installation requires a direct migrator LOGIN, the exact PG73 migration ledger, pinned v1 producer and v2 settlement verifier bodies, enabled reservation and event triggers, an activation value local to the transaction, and private outbox ACLs. Unexpected default function grants roll the installation back.

The [critical writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts) now accepts explicit `eventVersion: 2` in its optional economic input. It computes `buyer_debit_micros` from the ordinary-user settlement **inside the buyer log transaction**. For a reserved ceiling, that value comes from the locked reservation and can differ from the log's Guardrail `budget_charged_micros`; for an actual charge it comes from the rounded ordinary-user charge. The SQL function validates exact quote references, complete attempt coverage, numeric/evidence shapes, buyer basis and debit, same-transaction buyer-log marker, and immutable replay. The v341 deferred verifier additionally requires the terminal reservation transition marker in the same transaction. Any failure rolls back the buyer log, ordinary budget change, audit and event together.

v1 remains the default for existing callers. A reserved v1 economic request still fails before database mutation. The new function does not infer per-attempt usage or provider cost from a quote or final aggregate; its caller must supply observed facts. The existing v1 consumer gate continues to reject v2 credits until the separate version-aware consumer companion is installed.

## Local verification

Run with `GATEWAY_NATIVE_PG_BIN=C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin`:

```powershell
node --import tsx --test scripts/db/cutover/postgres-shared-key-economic-producer-v2.native.test.mjs
```

PostgreSQL 18.6 result: **1/1 test, 11/11 stages PASS; owned-cluster cleanup PASS**. The [machine report](./C04-postgres-economic-producer-v2-v343-results.json) records source hashes and stages. It covers default-off activation, v1 producer catalog drift and hostile default ACL rollback, runtime EXECUTE-only rights, v2 actual and a 20,000-micros reserved debit against a 10,000-micros Guardrail charge, idempotent critical-writer replay, exact-debit verification, post-commit create rejection, v1 compatibility, and malformed quote rollback. The first run reached the last stage and failed only because the fixture asserted on Drizzle's outer error rather than PostgreSQL's nested error; the final run asserts SQLSTATE and constraint directly and passed. `npm run build:node-index -w @octafuse/core` and `npm run typecheck -w @octafuse/proxy` passed locally. Linux CI is separate.

Source SHA-256: v2 SQL `3871f01eed2a058c9df9e1ca7c2d6898e995e9fa007115ccb6d62082e57712f3`; native fixture `c128c23969d2367423eb4ef6543ffc1aa4bcf0f0c71989d48a88bd71e4fd3256`. The machine report also pins the tested Core critical writer and outbox input-type source hashes.

## Remaining gates

The v2 opt-in input is not connected to real `recordUsage`; that path still lacks authenticated per-attempt billable usage and provider cost. **A direct runtime SQL path remains a production blocker:** without a reservation, the runtime LOGIN can insert a buyer log and call the v2 producer with an `actual` amount without changing `users.budget_spent`; the v341 verifier only checks the amount against the log in that case. The local fixture proves the trusted critical-writer path, not an enforced boundary against all direct SQL. A database-verifiable ordinary-debit receipt or narrower role protocol and a direct-SQL negative test are required before v2 production activation. Install the version-aware seller consumer before enabling any v2 traffic, or the old v1-only gate will reject delivery. Workers/Hyperdrive transaction identity, statistics reader cutover, release/hold policy, production authorization, D1/MySQL protocols, and Linux CI remain independent gates. No formal migration or runtime flag was enabled.
