# C04 v341: separate ordinary buyer debit in versioned economic events

Status: **review-only, production default off**. Formal migration heads remain PostgreSQL 73 / D1 68 / MySQL 64. The companion is outside the formal migration directory and was not applied to a remote database.

## Why this is needed

The v339 event copies `api_key_request_logs.budget_charged_micros`, which is the Guardrail budget charge derived from `charged_cost`. In the PostgreSQL critical writer, a `userBudgetSettlement.mode='reserved'` instead settles the ordinary buyer at `user_budget_reservations.reserved_micros`. A ceiling debit can therefore differ from the Guardrail amount. The v340 producer correctly rejects reserved-basis events until the separate debit exists.

## Review-only contract

[The v2 companion](../../../../packages/core/migrations-proposals/postgres/shared-key-buyer-debit-v2.sql) installs after PG73, quote, dispatch, outbox, producer and v1 consumer proposals. Installation requires a direct migrator LOGIN, an explicit transaction-local activation value, the exact PG73 ledger, reviewed function properties and bodies, and owner-only private table/function ACLs. It holds protected function catalog tuples during activation.

The event gains nullable `buyer_debit_micros`: v1 requires NULL; v2 requires a safe integer. `buyer_budget_charged_micros` retains its Guardrail meaning. A v2 reserved event must match an expired ordinary-user reservation with `reserved_micros=settled_micros=buyer_debit_micros` and matching buyer/API key. An actual event must match charged cost in micros and, where a reservation exists, its terminal settled amount. A no-charge event requires zero debit and no reservation.

A private xid8 marker records only an enrolled reservation's original `reserved|dispatched` → `settled|expired` transition. The v2 event checks that this transition occurred in its own transaction. Terminal INSERT, a precommitted settlement, or later mutation of an already-terminal reservation cannot refresh the marker. Once a v2 event exists, settlement-changing updates and later reservation inserts for that request are rejected pending a versioned adjustment protocol. The existing v1 consumer's first detail INSERT rejects v2 before any seller balance or ledger write. Existing v1 events and their consumer remain usable.

## Native verification

`GATEWAY_NATIVE_PG_BIN=C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin` with `npx tsx --test scripts/db/cutover/postgres-shared-key-buyer-debit-v2.native.test.mjs`: **1/1 PASS, 19/19 stages PASS, owned-cluster cleanup PASS** on PostgreSQL 18.6. The [machine report](./C04-buyer-debit-v2-v341-results.json) records source hashes and stages.

The synthetic reserved case committed `buyer_debit_micros=30,000,000` while the independent Guardrail value remained `10,000,000`. Wrong debit, wrong terminal state, actual mismatch and version/NULL violations rejected. A wrong reserved debit rolled back the buyer log, reservation row and synthetic buyer budget update together. Native negatives also cover precommitted reservation adoption, terminal INSERT, a prior terminal row altered in the event transaction, late reconciliation after enrollment, hostile default grants, migration-ledger drift, v1 consumer catalog drift, private table/function access, append-only facts and the old producer's reserved-basis rejection.

Source SHA-256: SQL `fc327b411e8ae6a417a156ab4ba3b633a47a2e615d249b8861503fc4cbf68593`; native fixture `0407c0520d8fcf9dc5b14d2e2190433a1ae89ab4ddd2e42f3b98a667d9f84ff4`.

This proposal **does not** install a v2 runtime producer, connect `recordUsage`, prove the real ordinary-user balance debit from arbitrary SQL, or enable a version-aware seller consumer. The xid marker proves a reservation state transition in the event transaction; it is not an independent proof that the caller updated the user's budget account correctly. The existing critical writer remains the trusted account mutation path. Late actual reconciliation for a reserved v2 event needs a separate reviewed adjustment event. Linux CI and production deployment have not run; C04.3 and downstream gates remain open.

Activation also requires `READ COMMITTED` for every ordinary reservation INSERT and settlement-changing UPDATE. Marked reservation rows are retained by the private marker foreign key. Both effects require a writer and retention audit before any production rollout.
