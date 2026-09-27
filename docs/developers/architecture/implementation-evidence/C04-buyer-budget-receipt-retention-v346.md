# C04 v346: buyer receipt post-commit retention boundary

Status: **review only, default off**. This candidate extends the [v345 receipt maintenance proposal](./C04-buyer-budget-receipt-maintenance-v345.md). It does not select a retention duration, install a formal migration, schedule a job, grant runtime access, or prune production rows.

## Why v345 alone cannot express a post-commit period

`first_seen_at` is recorded when a receipt is inserted, or when an old row is backfilled. A transaction can insert a receipt before a cutoff and commit long after it. The v345 `xact_id < pg_snapshot_xmin(pg_current_snapshot())` test prevents deletion **while** that transaction is open, but its old `first_seen_at` can make the receipt eligible immediately after commit. PostgreSQL defines snapshot `xmin` as the oldest still-active transaction ID; smaller IDs have completed or rolled back ([PostgreSQL 18 snapshot functions](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-TXID-SNAPSHOT)).

The [v346 companion](../../../../packages/core/migrations-proposals/postgres/shared-key-buyer-budget-receipt-retention-v346.sql) adds nullable `finalized_observed_at` without a default. A direct migrator page first stamps visible rows with the current time **only after** their `xid8` is below snapshot `xmin`. This is a conservative observation after finalization, **not** the exact commit timestamp. It covers old receipts as well as new ones. The replacement pruning function requires both `finalized_observed_at < explicit_cutoff` and `xact_id < current_snapshot_xmin`, with at most 1,000 rows per page. A reviewed policy must choose the cutoff as an interval before now; the SQL accepts any nonfuture cutoff, so the caller can otherwise shorten retention.

Both functions require a direct migrator LOGIN, READ COMMITTED, and the exact v345 run marker. A `SET LOCAL` marker is the intended operator procedure; PostgreSQL does not let the function distinguish it from a session-level `SET`, so the marker is not independent authorization. Runtime cannot execute the functions or read the private table.

## Install and scale contract

The v346 installation holds `ACCESS EXCLUSIVE` on the receipt table and uses a 2-second lock wait and 15-second statement deadline. The new nullable column is a metadata expansion, but the lock can still block writers and queue traffic. A held writer made installation time out and roll back in the native fixture. The lock window, backfill traffic, write amplification, and production row count still need a measured rollout plan.

After installation, build the [unobserved-row index](../../../../packages/core/migrations-proposals/postgres/shared-key-buyer-budget-receipt-unobserved-index-v346.sql) and [due-row index](../../../../packages/core/migrations-proposals/postgres/shared-key-buyer-budget-receipt-due-index-v346.sql) as **separate top-level** `CREATE INDEX CONCURRENTLY` commands. PostgreSQL does not allow a concurrent index build inside a transaction block, and a failed build can leave an invalid index ([PostgreSQL 18 CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html)). Each maintenance page checks both indexes are valid and ready and have their exact PostgreSQL 18.6 definition. A same-name, wrong-column replacement fails closed; a changed server version or catalog rendering requires review. Local `EXPLAIN` after 20,000 synthetic rows chose both partial indexes, including an indexed due-time range. This is a planner shape check, not a production latency or storage estimate.

Keep the v345 prune runner disabled throughout the transition. Installation replaces that function in one transaction; until the replacement commits, v345's insertion-time rule remains available to a direct migrator with its run marker. Build and validate both indexes before permitting a v346 maintenance page.

`SKIP LOCKED` can return zero while eligible rows are locked. A zero page is only “no work claimed now”. After each drain, independently query for visible eligible unobserved rows and due rows, retain the observed snapshot horizon, and retry locked work. An open transaction can later commit a currently invisible receipt, so one census cannot certify global completion. Long-running transactions can also hold the snapshot horizon back and delay otherwise finalized receipts.

The following read-only shape gives a same-statement horizon and two visible-backlog signals after a page commits. Bind `$1` to the reviewed cutoff; an `EXISTS` result of false means no *currently visible* eligible row in that category.

```sql
WITH horizon AS (
  SELECT pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot()) AS xmin
)
SELECT horizon.xmin,
  EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
    WHERE r.finalized_observed_at IS NULL AND r.xact_id < horizon.xmin)
      AS observable_pending,
  EXISTS (SELECT 1 FROM cinatoken_economic_outbox.shared_key_buyer_budget_tx_receipts r
    WHERE r.finalized_observed_at < $1::timestamptz AND r.xact_id < horizon.xmin)
      AS due_pending
FROM horizon;
```

Existing v345 rows with `first_seen_at IS NULL` still need the v345 bounded backfill for complete insertion/backfill-time diagnostics. The v346 finalization observer does **not** rely on that field for pruning: old rows receive a fresh post-finalization observation and start a full policy period from there.

## Evidence lifecycle

| Row family | Current evidence role | v346 action |
| --- | --- | --- |
| `shared_key_buyer_budget_tx_receipts` | Same-transaction account-change witness; no historical FK from an event | Only family eligible for proposed bounded, policy-gated pruning after finalization observation |
| `shared_key_buyer_reservation_admissions` | Verified reservation capacity and epoch; verified rows guard the parent reservation against deletion | Retained; no v346 prune path |
| `shared_key_economic_events` and attempts | Immutable buyer, attempt, quote, and provider certainty facts | Retained; no v346 prune path |
| Producer and settlement markers, request logs, quote attempts and versions | Same-transaction and historical links used by replay, payout, or audit | Retained; no v346 prune path |

Retention of admission, event, attempt, log, and quote evidence needs a separate finance/audit policy and consumer/replay proof. Their foreign keys and immutability guards are not a substitute for a lifecycle decision. [The existing outbox schema](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox.sql) keeps event and attempt rows immutable.

## Native verification and remaining gates

The [owned PostgreSQL 18.6 fixture](../../../../scripts/db/cutover/postgres-shared-key-buyer-receipt-retention-v346.native.test.mjs) passed **1/1 test, 12/12 stages, cleanup PASS**. It installed the 73 formal migrations and v344/v345 proposals in a disposable cluster, then exercised default-off install, lock timeout rollback, runtime denial, missing/wrong index refusal, two separate concurrent index builds, a receipt inserted before a cutoff but committed after it, bounded observation and pruning, locked-row zero-page census and retry, and an older open XID fence. The [machine report](./C04-buyer-budget-receipt-retention-v346-results.json) contains each stage, the local index plans and source pins.

Source SHA-256: v346 SQL `f1f745cff5724ee048c7d7272fa57546b61b6d3a4ed1711e1a97b1db80fa4767`; unobserved index `8c64d73a0bf7c3a6b09b3672353c54b346ed762123fccd6dd0440be0cb772465`; due index `84cef19f61c0cac8532ed31e954583e084906654f939d323d490a85e3d0fd826`; fixture `3ae485aaaf9e49924a24b725493dde4fbd97d28ad78a60aba224dec27acfb5e7`.

Production policy duration and owner, a durable scheduled identity, completion monitoring, invalid-index recovery, large-table and long-transaction measurements, lock-window approval, old-row diagnostic backfill, and the admission/event evidence lifecycle remain open. C04.3 and C04.G remain unchecked.
