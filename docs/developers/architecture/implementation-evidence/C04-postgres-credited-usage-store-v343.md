# C04.7 immutable credited-usage store (v343, review only)

The [proposal](../../../../packages/core/migrations-proposals/postgres/shared-key-credited-usage-store.sql) adds a private canonical contribution store and summary keyed by `(shared_key_id, seller_user_id)`. It is separate from the mutable `shared_keys` fields. Legacy `shared_key_earnings.id` and economic `attempt_id` are distinct immutable source identities; a `request_log_id` enrollment table rejects a legacy and economic credit for the same buyer request. `pending_manual` attempts create no contribution. Exact `numeric` micros and token totals have explicit bounds.

Source `AFTER INSERT` triggers append a contribution and increment the summary in the same transaction as the legacy earning or v340 seller consumption and account credit. A duplicate source identity is a no-op only if every copied field still matches; a changed replay fails. The source-table write locks precede trigger installation, so no writer can pass between the installation snapshot and activation commit. Neither the ordinary runtime nor the dedicated seller consumer receives direct access to the private schema. The new definer functions use fixed `pg_catalog,pg_temp` search paths and have no direct nonowner `EXECUTE` grant.

The migrator-only `backfill_credited_usage(kind, limit)` processes at most 500 credited sources per transaction using a durable source cursor and row lock. Each page commits its cursor, contributions, and summary increments together. New source inserts are already captured by triggers, including IDs below a completed cursor; a page that later sees a concurrently captured row verifies its immutable fields and does not increment again. A production-sized history still needs measured index plans, batch duration, and retry/observability limits. In particular, a pending-heavy economic table can make a `decision='credited'` page examine more index entries than its row limit; a reviewed partial index or equivalent plan is required before production backfill.

## Native evidence

The [native PG18.6 fixture](../../../../scripts/db/cutover/postgres-shared-key-credited-usage-store.native.test.mjs) installed exact formal PG73 plus the pinned quote, dispatch, outbox, v340 consumer, legacy history guard, and v343 proposal. Its [result](./C04-postgres-credited-usage-store-v343-results.json) records **17/17 stages PASS and cleanup PASS**. It showed:

- A legacy credit of `2.000000`, economic credit of `5.625000`, and pending attempt before installation. Bounded one-row pages backfilled only the two credited sources once, while an additional seller credit waited for a summary row lock and then committed without loss or duplicate count. Null, zero, and over-cap page limits failed closed.
- Exact source replay left the summary unchanged; changed replay failed. A legacy earning with the same request log as an economic credit failed even when the older outbox guard was transactionally disabled for the adversarial fixture.
- Two more concurrent economic credits and a later legacy source ID below the completed cursor were all captured. The former seller retained `25.500000` in its historical summary after ownership transferred. A query joining the current `shared_keys.seller_user_id` returned only the new seller's scoped summary.
- A forced summary constraint failure rolled back the new seller's attempted consumption and account credit. After removing the fixture constraint, the same event replay credited exactly once. Direct runtime/consumer reads and mutation of immutable contributions failed.

The proposal SHA-256 is `72dc6bfdcfd1b369e8465374168995f7680ee8593a037496487a7fdd7afd1d4e`; the fixture SHA-256 is `16a297a4d26e603e8dce2981ba40d63dc29a7e9b0315cbdb00c12f4428c99a89`. The result JSON pins the formal migration corpus and all other source files.

Run with `GATEWAY_NATIVE_PG_BIN` pointing to the owned PostgreSQL 18.6 `bin` directory:

```powershell
node --test scripts/db/cutover/postgres-shared-key-credited-usage-store.native.test.mjs
```

On Windows, `pg_ctl` required execution outside the filesystem sandbox to create its restricted token. The fixture starts only a fresh loopback cluster, confirms its data-directory identity, and cleans it up after the run.

## Reader cutover boundary

The private summary is not exposed to application runtime in this proposal. A later PostgreSQL reader must first authorize the seller in the application and bind that seller ID, then join the current Key owner for current-key statistics:

```sql
SELECT s.input_tokens,s.output_tokens,s.net_micros,s.last_credited_at
FROM cinatoken_shared_stats.summaries AS s
JOIN cinatoken_gateway.shared_keys AS k ON k.id=s.shared_key_id
WHERE k.id=$1 AND k.seller_user_id=$2 AND s.seller_user_id=$2;
```

Historical seller earnings must instead use the immutable source seller snapshot; an owner transfer must not reattribute prior credit. Buyer workspace or tenant reporting needs its own buyer-scoped source and must not reuse this seller summary. A production reader and `rebuildSharedKeyUsageFromEarnings`/`updateSharedKeyUsage` must be switched together: the current legacy-only rebuild still overwrites the four `shared_keys` fields. This fixture tested the scoped SQL under the migrator role, not a real route's application authorization. C04.7 and C04.G remain open pending those integrations, a large-history plan, direct migration review, and deployed-path validation.
