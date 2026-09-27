# C04 v374 same-user buyer audit baseline

2026-09-25. **Review only, default off, non-activatable.** This is a successor to the [v372 application composition](./C04-legacy-buyer-windowed-app-v372.md) for its single non-grant, current-epoch, charged-basis held `actual`/`actual` v2 path. It changes the opt-in application writer, not the v371 SQL, ordinary default path, formal migrations, remote database or Provider.

## Transaction invariant

The v371 accountant locks the buyer's `users` row and changes only `budget_spent`, `budget_reserved_micros` and `updated_at` on that row. After the v371 staged settlement, the [application helper](../../../../packages/core/src/db/postgres/legacy-buyer-windowed-transaction-v372.ts) reads that locked account and the now-settled ordinary reservation in the **same Drizzle transaction**. It requires the reservation user and epoch to match, the settled micro amount to equal the amount v371 returned from the inserted log, and the held amount to cover that settlement. It computes the prior `budget_spent` by subtracting the settled micros and the prior reserved counter by adding the hold back. Amounts must be exact decimal micros, in the safe range, and representable in the standard audit snapshot without precision loss. A clamped negative prior spent balance is rejected and the whole transaction rolls back.

The [opt-in critical writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts) uses these database-derived full `before_user_snapshot` and `after_user_snapshot` values for `user_audit_logs`, with `changed_fields` derived from the pair. The caller's `beforeSpent`, `audit.beforeSpent`, and supplied user snapshots cannot set the audit money or veto another admitted request merely because their pre-call value is old. The v2 economic event, receipt, request log, audit and stats still commit in the same outer transaction. A unique-key replay still fails closed until a committed terminal-read protocol exists.

The charge itself remains the amount the caller put in the append-only request log. v371 checks it against that log and the actual/charged-basis hold, **not** against an independently authenticated final Provider bill. This patch must not be treated as Provider amount authorization.

## Native evidence

The [native fixture](../../../../scripts/db/cutover/postgres-legacy-buyer-windowed-app-v372.native.test.mjs) and [source-pinned report](./C04-legacy-buyer-windowed-app-v372-report.json) passed **20/20 stages with cleanup PASS** on local PostgreSQL 18.6. Two already admitted requests for one user, using distinct API keys and distinct buyer connections, started with the same stale `beforeSpent = 0`. Both committed. Their audit pairs were ordered `0→0.000001→0.000002` spent and `20→10→0` reserved micros; each request had one log, one audit, one v2 event and one event attempt, and the events had two distinct matching transaction receipts. The fixture also supplied forged caller pre-state and user snapshots; the committed audit still recorded database-derived `0→0.000001`. A negative balance that would make v368 clamp the delta caused full rollback. A late audit failure also rolled back holds, windows, log, event and stats.

`npx tsc --noEmit --project packages/core/tsconfig.json` remains red on existing unrelated test type errors and missing `vitest`; it reported no diagnostic in the two edited Core TypeScript files. `git diff --check` passed for the edited writer, helper and fixture. Linux CI has not run here.

## Remaining gates

This is still one default-off route with fixture-only buyer application grants. The request-log amount and usage have no immutable final Provider authority. An unknown outer COMMIT result needs a read-only terminal receipt and retry protocol before the caller can safely acknowledge or retry. The v371 global window-table lock needs production-scale contention evidence. Grant-linked, reserved, old-epoch, late actual, BYOK, recovery, no-hold and mixed-version paths remain outside this composition. None of C04.1–8/G is closed by this audit fix alone.
