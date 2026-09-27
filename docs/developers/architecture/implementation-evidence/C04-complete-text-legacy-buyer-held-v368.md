# C04 v368 request-scoped legacy buyer settlement prototype

2026-09-25. **Review only; non-activatable.** The [owned PostgreSQL 18.6 fixture](../../../../scripts/db/cutover/postgres-complete-text-legacy-buyer-held-v368.native.test.mjs) reports [PASS, cleanup PASS, 32/32 stages](./C04-complete-text-legacy-buyer-held-v368-report.json). It uses the real PG73 schema and v348/v349, v350/v351, v353/v354, v361/v362/v365, and v366 proposals in a private loopback cluster. This work did not run a formal migration, change a deployed Worker or a remote database, use a production credential, or contact a Provider. The later [v369 coverage matrix](./C04-postgres-buyer-critical-write-coverage-v369.md) maps the existing writer's remaining variants.

## Narrow writer and coordinated ACL proposal

The [v368 SQL writer](../../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-held-writer-v368.sql) accepts a request ID, ordinary and Guardrail settlement amounts, and a terminal reason. Its `SECURITY DEFINER` function admits only the isolated direct buyer LOGIN under `READ COMMITTED`. It takes the v362 request advisory lock, rejects a v362 grant linked to that request, checks the API key, account epoch, ordinary hold, charged-basis Guardrail holds and their aggregate reserved counters, then changes the user counter, ordinary hold, Guardrail holds and windows in one transaction. It bounds each caller-supplied amount by the corresponding reserved micros. It covers only a current-epoch, charged-basis held request with an ordinary hold and one to 32 Guardrail holds.

The [companion v368 grant policy](../../../../packages/core/migrations-proposals/postgres/buyer-split-counter-grant-policy-v368.sql) revokes the direct buyer's user, ordinary-hold, Guardrail-hold and window `UPDATE` rights. Its preflight pins the exact v368 writer body hash, owner, `SECURITY DEFINER` attribute and search path before revocation. It supersedes both v348 and v349 positive grant markers, so rerunning either old grant script fails before restoring direct rights. The v366 grant-hold freeze triggers stay enabled. Both SQL files require explicit local activation settings and are proposals, not formal migrations.

The [dedicated buyer client](../../../../packages/proxy/src/services/postgres-legacy-buyer-held-v368.ts) requires the exact buyer LOGIN in its URL before opening a connection, checks `current_user` and `session_user`, calls the function in a transaction, and returns `commitAcknowledged` only after transaction and dedicated connection-close acknowledgement. The existing application does **not** call this client.

## Native evidence

The fixture repeats the v367 shared-account counterexample, then exercises a non-grant request alongside enrolled v362 grants on the same user and Guardrail windows. It verifies:

| Test | Observed result |
| --- | --- |
| Deliberately replaced writer body | v368 policy preflight rejects it before revocation. |
| Default-off or deliberate transaction rollback | No wrapper or new marker remains; v349 direct rights remain intact. |
| Coordinated fixture transaction | Direct buyer counter and hold `UPDATE` rights disappear; only the buyer can call the new wrapper; both v366 triggers remain enabled. |
| Raw buyer counter or hold DML after policy | PostgreSQL denies it. |
| Grant-linked request or amount above a hold | The wrapper rejects it without settlement. |
| Buyer transaction rollback | User, reservation and window changes all roll back. |
| Dedicated buyer client on an ungranted, shared-account request | The ordinary and three Guardrail holds settle; the transaction and connection close acknowledge. A migrator URL is rejected before connecting. |
| v348 and v349 old grant runner reruns | Both fail before any direct buyer counter privilege returns. |
| v369 existing-transaction seam | An ordinary and three Guardrail holds, request log, audit row and real v2 economic event roll back together, then commit together with the same transaction ID and matching buyer receipt. |

The wrapper follows request advisory lock, API-key share lock, account update lock, reservation-table lock, reservation rows, then window rows. This aligns its account/table/window segment with v362/v365; a full concurrent buyer-versus-renewer/closer lock-order proof remains open. The local fixture proves the isolated SQL mechanics and ACL behavior only.

## Exact activation blocker

The [current PostgreSQL critical writer](../../../../packages/core/src/db/postgres/critical-writes.impl.ts) performs several budget variants inside **one** Drizzle transaction with the request log, user audit, provider-attempt records and shared-key economic event. It currently writes the user counter before terminalizing an ordinary reservation, terminalizes Guardrail reservations before updating windows, and has unreserved, BYOK, expired/late-actual and old-epoch paths. The v368 client opens its **own** transaction and accepts caller-supplied amounts. Those amounts are bounded by holds but are **not bound to a verified Provider bill, immutable buyer charge, request log or economic event**. Calling the client next to the current writer would split an accounting operation across transactions; installing the ACL policy without replacing every affected buyer path would interrupt legitimate traffic.

Activation needs a reviewed interface that supplies request-bound verified amounts and invokes all counter, hold, request-log, audit and economic-event changes in the **same transaction**. That can be a wrapper callable on the existing `tx` with defined commit and connection-close semantics, or one reviewed definer operation for the full critical write. It must cover every existing buyer variant, replay and late adjustment, and be paired with an application switch and old buyer-connection drain before the direct grants are removed. Grant result closure and renewal need an atomic successor to the v366 freeze trigger. Until those interfaces and the coordinated cutover are implemented and tested, **v368 does not establish C04 settlement progress or authorize activation**.

Verification: native PostgreSQL 18.6 32/32 stages and cleanup PASS; `npm run typecheck -w @octafuse/proxy` PASS for the v368 client; a targeted TypeScript check PASS for the v369 helper. The fixture, SQL and client hashes are recorded in the JSON report. Linux CI, D1/MySQL parity, production Worker/Hyperdrive acknowledgement and fleet cutover remain unverified.
