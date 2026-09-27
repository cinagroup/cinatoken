# C04.6 bounded backlog observation candidate (v353)

This is a **review-only, default-off** PostgreSQL proposal for the v352 dedicated economic scanner Worker capacity gap. It adds one [SECURITY DEFINER summary function](../../../../packages/core/migrations-proposals/postgres/shared-key-delivery-backlog-observation.sql) after the v342 delivery proposal. Installation requires the direct migrator LOGIN and `SET LOCAL cinatoken.shared_key_delivery_backlog_observation_activation = 'reviewed-v1'`. The [v354 local Worker candidate](./C04-shared-earning-backlog-worker-v354.md) now calls the function before a claim. No formal migration, alert, dashboard, remote SQL, or production activation was added.

## Observation contract

Only the direct `cinatoken_gateway_shared_earning_delivery` LOGIN can execute `cinatoken_economic_delivery.observe_backlog(cap)`. The function checks the direct session role and READ COMMITTED isolation. It returns one row with the observation time, cap, capped counts and saturation flags for pending, claimable due, leased and dead-letter jobs, plus the oldest pending due age in seconds. `due` means pending jobs whose `next_attempt_at` has passed **plus** leased jobs whose `lease_until` has expired. Completed jobs are excluded. The function returns no event IDs, claim tokens, financial amounts or buyer/seller identity; the delivery role still has no direct `SELECT` on the jobs table.

The cap is an integer from 1 to 1000. Each ordered lane samples at most `cap+1` rows; a count equal to cap with `saturated=true` is a **lower bound**, not a complete backlog total. The pending, expired lease and dead-letter samples use the v342 partial indexes. The proposal takes the existing finance advisory transaction lock before a `SHARE UPDATE EXCLUSIVE` lock on the jobs table, then checks all three expected index definitions, owners and ready/valid/live state. The function sets `enable_seqscan=off` within its scope. These measures narrow the expected plan and bound rows returned to the aggregate, but SQL `LIMIT` and the planner setting do **not** prove a strict physical I/O ceiling. Production needs a measured plan on representative volumes and an execution budget.

`out_oldest_pending_due_age_seconds` measures lateness relative to the smallest pending `next_attempt_at`, clamped to zero for a future due time. It is exact from the pending due index even when the count saturates. It is **not** the age since the source event was recorded or the job first enqueued; v342 does not store an immutable enqueue timestamp in the job. The summary is diagnostic and does not calculate a safe scan frequency, alert threshold, or total arrival rate by itself.

## Local verification

- [Owned PostgreSQL 18.6 fixture](../../../../scripts/db/cutover/postgres-shared-earning-backlog-v353.native.test.mjs): **11/11 stages PASS, cleanup PASS**. It installs formal PG73 and the review-only quote, dispatch, outbox, consumer and delivery proposals; verifies default-off installation, a same-name index with the wrong key, direct role/ACL denials, cap and isolation bounds, empty read-only observation, saturated and unsaturated mixed-state counts, real delivery LOGIN invocation through the Worker observer, and replay without job mutation. [Machine summary](./C04-shared-earning-backlog-observation-v353-results.json) records source hashes, stages, actual index definitions, and cleanup.
- No general Worker, Hyperdrive origin or deployed PostgreSQL instance was used; the dedicated Worker path was called only in local tests.

Run the fixture with `GATEWAY_NATIVE_PG_BIN` pointing to a local PostgreSQL 18.6 `bin` directory:

```powershell
node --import tsx --test scripts/db/cutover/postgres-shared-earning-backlog-v353.native.test.mjs
```

## Remaining capacity and deployment gates

The v352 scanner still has an hourly Cron and at most 20 claimed events per invocation. The v354 local scheduled path now emits a bounded snapshot before scanning, but no live telemetry or alert has been observed. Production arrival rate, backlog SLO, p95/p99 query cost, origin pool budget, alert thresholds, dead-letter response and recovery throughput remain unmeasured. The v342 delivery and v340/v343 consumer contracts are still review-only; no production SQL or cloud resource changed.
