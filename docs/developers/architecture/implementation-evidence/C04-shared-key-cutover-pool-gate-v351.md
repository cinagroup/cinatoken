# C04 shared-key cutover pool gate (v351, review only)

The PostgreSQL shared-key dispatch pool now returns active seller keys only when
the **actual session LOGIN** can insert legacy `shared_key_earnings`. This is a
single predicate in `listActiveSharedKeysByChannel`, which is the common pool
read used by `expandAttemptsWithSharedKeys` before the failover dispatcher
sends an upstream request. The v346/v348 buyer privilege split removes that
INSERT right from `cinatoken_gateway_runtime`, so the ordinary proxy receives
an empty shared pool while provider-owned key fallback remains available.
Administration reads of seller keys are unchanged. The economic-only dispatch
path still needs a separately reviewed activation contract before shared-key
traffic can resume after the split.

## Local evidence

- Owned loopback PostgreSQL 18.6, formal PG73 plus v346 split: native fixture
  `postgres-buyer-critical-writer-split-v346.native.test.mjs` passed **11/11
  stages**, cleanup PASS. The runtime saw one active synthetic key before the
  split, none after the legacy earning INSERT revoke, and the key reappeared
  after the deliberately unsafe old grant rerun. This demonstrates why the
  durable v348 marker is required.
- Owned loopback PostgreSQL 18.6, formal PG73 plus the review-only economic
  prerequisite chain and v348 marker: native fixture
  `postgres-buyer-split-grant-rerun-v348.native.test.mjs` passed **14/14
  stages**, cleanup PASS. The same pool became empty after the atomic split;
  the old broad grant rerun was rejected and the reviewed split grant rerun
  preserved the empty pool.
- `npm run typecheck:shared-key-summary -w @octafuse/core` and
  `npm run build:node-index -w @octafuse/core` passed. The shared-key pool
  expansion tests passed **8/8**, including provider-owned fallback when the
  pool is empty. `git diff --check` passed for the tracked source; the two
  currently untracked native fixtures executed successfully. The full core `tsconfig.json` check has
  pre-existing unrelated test typing errors, so it is not a passing gate.

The native reports were written under `.wrangler/staging/pg-native-dispatch-tests`
as `report-buyer-critical-writer-split-v346-277b1aa0-abbd-4629-ba0b-3592969a5ebd.json`
and `report-buyer-split-grant-v348-3da7832a-1aac-4b24-9ba4-53cc4b73be14.json`.
The checked-in [result summary](./C04-shared-key-cutover-pool-gate-v351-results.json)
records the gate observations. Neither fixture used an ambient `DATABASE_URL`
or a remote database.

## Remaining cutover work

This gate does not make C04.5 complete. A key already selected before a revoke
can still be in flight; the cutover must drain old requests and retain an
explicit reconciliation path. The v339 outbox constraint requires an event for
enrolled quote attempts, but ordinary non-Chat shared-key attempts still have
no typed event producer. No post-split economic-only pool release, supplier
bill reconciliation, D1/MySQL equivalent, production Worker/Hyperdrive proof,
or formal migration is included. Linux CI has not run. Shared-key traffic must
remain paused after the privilege split until those gates close.
