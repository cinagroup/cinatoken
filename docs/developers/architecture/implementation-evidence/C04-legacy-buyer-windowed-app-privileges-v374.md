# C04 v374 buyer application LOGIN privileges

2026-09-25. **Review only, default off, non-activatable.** The [v374 SQL proposal](../../../../packages/core/migrations-proposals/postgres/legacy-buyer-windowed-app-privileges-v374.sql) provides an exact application ACL for the optional [v372 critical writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts) and [database-derived audit helper](../../../../packages/core/src/db/postgres/legacy-buyer-windowed-transaction-v372.ts). It does not bind the caller's charge to an immutable result or Provider bill.

## Role transition and installation order

The local sequence is PG73 and the v2 economic proposals, v347/v348 buyer split, v349 Guardrail successor, v350 ordinary admission, v366 hold fence, v368 counter policy, v371 window accountant, v372 wrapper ACL, then v374. This order matters: v368's preflight requires buyer EXECUTE on the old held writer, while v371 revokes it. The v374 preflight pins the v368 superseding markers, v366 fence body and trigger tables, v368/v371 function bodies, the v348 Guardrail replacement v2 economic producer, owner/security settings, direct LOGIN identity, PG73 digest, v350 admission, and the lack of buyer raw financial mutations. The proposal refuses an unexpected broad API-key UPDATE. Its explicit activation setting is `cinatoken.legacy_buyer_windowed_app_privileges_v374_activation='reviewed-v1'` in a direct migrator transaction.

The v348/v349 grant policies left the ordinary runtime with direct Guardrail window DML. The v374 transaction revokes runtime `INSERT/UPDATE/DELETE` on both Guardrail reservations and windows, then proves those rights are absent. This breaks the legacy runtime Guardrail admission path until the dedicated v351 admission path and production role routing are installed and verified. The v368 marker makes legacy runtime, v348 and v349 grant-script reruns fail before they can reopen this boundary.

The buyer LOGIN receives only these direct application rights:

| Object | Direct right and reason |
| --- | --- |
| `api_keys` | `SELECT(id,workspace_id)` for workspace check; `UPDATE(updated_at)` for `SELECT … FOR UPDATE` row lock. `key` and `key_hash` remain unreadable. |
| `users` | `SELECT` on the 14 fields read by the database-derived audit snapshot; no direct DML. These include `email`, `metadata` and external identity fields because the current audit snapshot serializes them. |
| `user_budget_reservations` | `SELECT` on the 6 identity/epoch/hold fields read by the audit helper; no direct DML. |
| `api_key_request_logs` | `INSERT`, plus `SELECT(id)` required by the writer's `ON CONFLICT (id) DO NOTHING RETURNING id`; no other log-column read or mutation. |
| `user_audit_logs`, `provider_attempt_availability` | `INSERT` only. |
| `public_model_daily_stats` | `SELECT/INSERT/UPDATE` for the existing upsert. |
| Functions | Buyer `EXECUTE` on v371 window settlement and the v348 replacement v2 economic producer; runtime cannot execute either. |

The buyer has no direct `workspaces` or Guardrail-table SELECT after v374. The v371 and v2 functions read their own dependencies as pinned migrator-owned `SECURITY DEFINER` functions. Any current buyer path needing a different table or column must get a separately reviewed contract before activation.

## Native proof

The independent [PostgreSQL 18.6 fixture](../../../../scripts/db/cutover/postgres-legacy-buyer-windowed-app-privileges-v374.native.test.mjs) generated a [PASS report with 23/23 stages and cleanup PASS](./C04-legacy-buyer-windowed-app-privileges-v374-report.json). It uses direct buyer, runtime, admission and migrator LOGIN connections. It installs the full v368 counter-policy SQL and exact v368 function body; the fixture creates that body before the counter policy, so it does not prove a production atomic cutover of both. For v368's v366 prerequisite, it extracts the exact hold-fence function and two trigger declarations from the v366 source and uses a minimal v362 grant table. It does not install every v351–v368 proposal.

The fixture verifies default-off rejection, broad API-key UPDATE drift rejection, rerun repair of a missing audit INSERT grant, idempotent rerun, and rejection of the old grant scripts. Direct buyer reads of `api_keys.key` and `workspaces`, direct buyer financial updates, runtime Guardrail updates, runtime v371 execution and buyer v368 execution are denied by PostgreSQL `42501`. The same buyer LOGIN executes the current optional application writer and commits its held debit, applicable unreserved windows, request log, audit, stats, v2 event and receipt in one transaction. Two same-user requests with distinct API keys commit with ordered database-derived audit snapshots; caller-supplied before values and snapshots cannot set the audit money. Replay, unsupported modes, wrong facts, clamped account inversion and late audit failure remain denied or roll back the whole transaction.

The report records SHA-256 values for the installed SQL, writer, helper and fixture. Run locally with the explicit owned binary path: `GATEWAY_NATIVE_PG_BIN=<local PostgreSQL 18.6 bin> node --import tsx --test scripts/db/cutover/postgres-legacy-buyer-windowed-app-privileges-v374.native.test.mjs`. No remote SQL or credentials are used.

## Remaining activation gates

The v374 preflight intentionally pins the original v366 fence body. The full v367 hold-renewal proposal replaces that body; v367 plus v374 plus the application writer has **not** been installed and exercised in one native database. That complete-text coexistence needs a reviewed successor and direct test. The fixture also lacks the production v351 Guardrail admission switch, real Worker/Hyperdrive credential routing, an independently authenticated final Provider cost, unknown-COMMIT terminal read, complete grant-linked/recovery branches, and production contention evidence. The v371 whole-window-table lock remains an availability risk. This proposal is not a production role migration or a C04 closure claim.
