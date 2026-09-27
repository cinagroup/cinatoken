# C04 v367 buyer counter cutover: shared-account counterexample

2026-09-25. This is a **review-only cutover contract and native counterexample**, not an activation script. The [owned PostgreSQL 18.6 fixture](../../../../scripts/db/cutover/postgres-complete-text-buyer-counter-cutover-v367.native.test.mjs) reports [PASS, cleanup PASS, 22/22 stages](./C04-complete-text-buyer-counter-cutover-v367-report.json). It installs the actual PG73 schema, v349 buyer grant policy, v350/v351, v353/v354, v361/v362/v365 and v366 before testing direct LOGINs. No remote database, formal migration, deployed Worker, production credential, or Provider call changed.

## Current authority and reproducible bypass

The [v349 grant runner](../../../../packages/core/migrations-proposals/postgres/buyer-split-guardrail-runtime-grant-v349.sql) gives `cinatoken_gateway_buyer_settlement` direct `UPDATE` on `users.budget_spent`, `users.budget_reserved_micros`, and the whole `guardrail_budget_windows` table. It also grants `UPDATE` on Guardrail reservations. Its postflight requires the user counter rights. The [real PostgreSQL buyer writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts) changes an ordinary user's counter **before** terminalizing the ordinary reservation, then terminalizes Guardrail reservations **before** changing their windows; it can also add an unreserved window charge after writing the request log. An ACL revoke or new counter trigger must account for each of these ordered writes and the no-reservation/late-adjustment variants.

The native fixture reconfirms the [v366 counterexample](./C04-complete-text-legacy-reaper-fence-v366.md): while v362 grants and v366 hold-freeze triggers exist, the direct buyer LOGIN commits an arbitrary one-micro `users.budget_spent` increment and a Guardrail `settled_micros` increment without changing a hold. The fixture restores those deliberately injected values in its owned cluster. Reservation-row triggers cannot see those standalone counter writes.

## Why a blanket row guard or bare revoke is insufficient

The v367 fixture admits a **separate, ungranted** quote under the same user and all three Guardrail windows as enrolled v362 requests. It installs two temporary, grant-aware `BEFORE UPDATE` guards that reject buyer changes to any user or window shared with a grant. Those guards reject the ungranted request's ordinary and Guardrail counter deltas. After removing the temporary guards, the counter/hold portion of the current v349 buyer sequence commits for that legacy request; the enrolled holds remain `dispatched`. A row's user or window identity therefore cannot identify the request being settled.

The fixture then revokes the buyer's direct user and window counter rights. Direct LOGIN writes are denied, including the operations the current legacy writer needs. Re-running the existing v349 grant runner restores both rights. An isolated `REVOKE` would interrupt traffic and is not durable against the reviewed grant reconciliation path.

## Required coordinated successor

1. Move **all** PostgreSQL buyer counter changes to a reviewed, request-scoped writer. It must verify the request identity and frozen source, exact ordinary/Guardrail/unreserved deltas, terminal reservation transition, request log and economic-event relation, replay identity, and the absence or separately authorized closure of a v362 grant. Cover shared-key v1/v2, BYOK, no-reservation charges, late actual adjustments, and other existing buyer paths before removing the old direct rights. A caller-set GUC or buyer-writable receipt is not sufficient authority.
2. Replace the v349 positive grant policy with a successor that **does not regrant** direct user/window counter writes. Make the Proxy writer switch, old-connection drain, function installation, v366 trigger replacement for a grant-aware closer, and ACL change a coordinated cutover. Keep v366's frozen grant-hold triggers until that closer is available.
3. Prove in native PostgreSQL with direct `NOINHERIT` LOGINs that a non-grant request sharing the same user/windows still settles, arbitrary user and window counter writes fail, grant-linked holds cannot be terminalized by the legacy buyer, rollback leaves the old path intact, and re-running the active grant policy does not reopen direct writes. Exercise both buyer/closer and renewal/send-start lock orders.

**Activation blocker:** there is no reviewed replacement buyer writer or successor v349 grant policy in this worktree. v366 remains non-activatable as a financial boundary. The v367 fixture supplies the concrete compatibility counterexample and does not grant a production cutover.

Fixture SHA-256: `60fa3d63d55a64fdb2d25ea1423310654454cde747f44ea72ef2a7da34273e1c`. Native binary: PostgreSQL 18.6. Linux CI, real Worker/Hyperdrive behavior, D1/MySQL parity, and fleet drain remain unverified.
