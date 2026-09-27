# C04.7 review-only durable repair claim — v338 (2026-09-24)

## Result and scope

The v337 per-key exception handler cannot catch PostgreSQL `query_canceled`
(`57014`). The negative control ran the same earliest key twice with a 200 ms
`statement_timeout`: both calls rolled back, its `attempt_count` stayed zero,
and the healthy key remained unprojected. The v338 successor uses a committed
claim before the expensive projection. It is a review-only proposal after the
73 formal PostgreSQL migrations, the history guard, v335 repair jobs, and v337
failure isolation. No remote database or deployment was touched.

The successor is
[`shared-key-usage-repair-durable-claim.sql`](../../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-durable-claim.sql).
Its direct-migrator activation is exactly `reviewed-v3`. It requires the v337
consumer LOGIN to be absent during installation. The dedicated LOGIN grant
builder pins all three repair proposal hashes and grants only
`claim_one_shared_key_usage_repair()` and
`finish_claimed_shared_key_usage_repair(text,uuid)`. It does not grant the old
`attempt_one_shared_key_usage_repair()` entrypoint. The Worker and generated
Wrangler configuration use `reviewed-v3`; `reviewed-v2` is rejected.

## Durable protocol

1. A short first transaction takes the shared-key lock before the job lock,
   records a random UUID claim, increases the admitted attempt count, and
   commits a retry time of 1, 2, 4, or 8 minutes. The claim lease is 35
   seconds. The fifth admission is dead-lettered pending success or direct
   migrator recovery. `PZL01` records that the outcome is unconfirmed.
2. A second transaction checks the dedicated LOGIN and server deadline
   settings, locks the same key then job, checks the exact claim UUID and
   lease, recomputes the projection from immutable earning rows, and deletes
   only that claimed job. Projection update and deletion commit atomically.
   This function never inserts an earning or replays its credit trigger.
3. Catchable SQL failures roll back the per-key projection and commit a
   deferred or dead-lettered result. PostgreSQL `57014` rolls back the entire
   second transaction. The previously committed claim keeps the poisoned key
   out of the next due-key selection. The Runner recognizes only the exact
   server statement-timeout message with SQLSTATE `57014` from the in-flight
   finish query, counts it, and continues to another claim in the same bounded
   Cron tick. External cancellation and errors during COMMIT still propagate.
   If a claim or finish COMMIT acknowledgement is lost, retry is driven by the
   database state, and an old UUID cannot update or delete the new job.
4. New earnings update the queued job's request-log identity and availability
   but do not clear retry, lease, or dead-letter state. Manual dead-letter
   recovery requires a direct migrator LOGIN, a full-precision failure token,
   explicit `reviewed-v3` activation, and an expired or absent lease.

## Native evidence

The owned loopback PostgreSQL 18.6 fixture
[`postgres-shared-key-usage-repair-durable-claim.native.test.mjs`](../../../../scripts/db/cutover/postgres-shared-key-usage-repair-durable-claim.native.test.mjs)
passed all 8 stages with cleanup PASS. Its report is
[`C04-postgres-native-shared-key-usage-repair-durable-claim-v338-report.json`](C04-postgres-native-shared-key-usage-repair-durable-claim-v338-report.json).
It proves the v337 repeated-cancellation counterexample, v338 exact activation
and disabled-credit / `WHEN(false)` enqueue-trigger rejection, cancellation
with a durable backoff, healthy-key progress on the next claim, concurrent
operators claiming distinct keys, stale
token denial, lost claim ACK recovery, fifth-cancelled-claim quarantine,
live-lease requeue denial, expired-lease manual recovery, and unchanged
historical earning count and seller credit after projection retries.

The owned loopback dedicated-LOGIN fixture
[`build-shared-key-usage-repair-direct-login-grant.native.test.mjs`](../../../../scripts/db/cutover/build-shared-key-usage-repair-direct-login-grant.native.test.mjs)
passed all 8 stages with cleanup PASS. Its report is
[`C04-postgres-native-shared-key-usage-repair-login-v338-report.json`](C04-postgres-native-shared-key-usage-repair-login-v338-report.json).
The role has exactly two executable gateway functions, no table/column/sequence
privileges, and cannot call the old attempt function. Repeated ordinary
runtime grants keep the new functions and job table inaccessible. With the
role's real 15-second database statement timeout, the `postgres.js` Runner
finished a healthy key **in the same tick** after the poison key's finish
statement timed out and rolled back. A `WHEN(false)` enqueue trigger made the
grant fail before granting either function.

The v337 failure-isolation native regression and the base runtime-grant native
regression each passed 1/1. All 23 targeted Node tests passed; they cover exact timeout
classification, external cancellation, and synthetic COMMIT `57014`
propagation. Proxy and
scripts TypeScript checks passed with direct local `tsc`. v337's source-hash
evidence for the runner and grant builder is historical after these changes;
the v338 path-keyed hashes are in
[`C04-shared-key-usage-repair-durable-claim-v338-results.json`](C04-shared-key-usage-repair-durable-claim-v338-results.json).
The copied native reports are hashed there, so review does not depend on the
temporary `.wrangler` files.

## Remaining gates

This does not activate C04.7/G. It lacks a formal migration, an upgrade path
from a database where the v337 dedicated consumer LOGIN already exists,
production lock-time/backlog sizing, actual Workers/Hyperdrive execution,
origin connection-budget reconciliation, operational alerting for deferred
and dead-lettered jobs, and full economic quote/outbox integration. A
statement timeout during the short **claim** transaction itself could still
repeatedly abort before a durable claim commits; this protocol specifically
isolates cancellation during the expensive second-phase projection. Same-tick
progress is bounded by the 25-second admission budget and 20-claim default;
many consecutive 15-second poison finishes can still leave later healthy jobs
for a future Cron tick. The
35-second lease assumes the dedicated role's 30-second database transaction
deadline; a separately authenticated caller changing its session settings is
outside the fixture's proof. The fifth claim is conservatively quarantined
even when cancellation makes the final outcome unknown.
