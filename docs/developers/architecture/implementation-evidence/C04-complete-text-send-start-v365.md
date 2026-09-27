# C04 v365 review-only holder custody and one-shot send start

2026-09-25. [The SQL proposal](../../../../packages/core/migrations-proposals/postgres/complete-text-send-start-v365.sql) succeeds the v362 immutable `unknown` grant in an isolated PG73 PostgreSQL 18.6 fixture. It creates no formal migration, deployed Worker, production role, provider request, or billing result. C04 remains open.

## Contract

The separately provisioned direct `NOINHERIT` LOGIN `cinatoken_gateway_complete_text_send_holder` can execute two `SECURITY DEFINER` functions and cannot read or write the grant, custody, or send-start tables directly. Activation is default off and rejects pre-provisioned table access or economic-schema access. Both functions check `SESSION_USER`, `READ COMMITTED`, server time, v362 grant identity, v361 admitted holds, and the active request/key/capability basis.

1. `claim_complete_text_send_custody_v365(grant_id, holder_run_id)` records immutable active custody with `lease_epoch = 1` and `lease_until = v362.hold_recovery_expires_at`. Its first result is `custody_claim_recorded`; the same run replay returns `already_claimed_unknown`, and a different run returns `holder_run_conflict`. A claim has no physical send right.
2. `record_complete_text_send_start_v365(grant_id, holder_run_id, expected_epoch, upload_sha256)` requires that committed custody, exact holder run and epoch, a fresh v362 send deadline with a one-second margin, and an independently frozen raw upload SHA-256 matching the immutable grant. It locks and checks the selected route source and all admitted physical holds, then inserts one immutable possible-send marker. Its first result is `start_recorded`; every replay returns `already_possible_send`, never a new send right. The v362 grant remains `unknown`.

The [dedicated postgres.js client](../../../../packages/proxy/src/services/postgres-complete-text-send-start-v365.ts) uses a fresh `max:1` direct LOGIN connection for each step. It exposes `commitAcknowledged: true` only after the transaction resolves and that connection's `end()` promise resolves; it then rejects a deadline that has expired while closing. An uncertain COMMIT or close ACK fails closed. `end()` is the library's close acknowledgement, not independent server-side proof of socket closure. The holder must possess the fresh acknowledged custody receipt before asking for send start and the fresh acknowledged start receipt before invoking one physical `fetch`.

## Native evidence

The [native fixture](../../../../scripts/db/cutover/postgres-complete-text-send-start-v365.native.test.mjs) installs formal PG73, the existing buyer split proposals, v356/v359/v360/v361/v362, and v365 in a temporary owned PostgreSQL 18.6 cluster. Its [machine report](./C04-complete-text-send-start-v365-report.json) records source hashes, stages, and cleanup. It checks default-off and role-drift preflight, direct holder ACL, unclaimed grant denial, committed custody, epoch/run/upload mismatch, same-count Guardrail identity and amount drift, ordinary amount and window-counter drift, replay after lost ACK, transaction rollback, competing holder connections, source/key drift, and expiry. It also exercises both dedicated client functions against the native server; local unit ACK mocks alone would not cover that path.

The Guardrail amount and assignment negative tests use ordinary migrator updates in the owned cluster. Existing buyer-admission guards reject direct mutation of the ordinary reserved amount; the fixture also uses transaction-local superuser trigger bypass solely to inject an inconsistent ordinary hold, key epoch, or Guardrail window and check v365's independent read fence. This is fault injection, not a privilege available to the holder.

## Activation blockers

- The selected source is rechecked, but full v360 manifest parity and live Guardrail/workspace-budget source parity are not. A source change in another candidate or an economic policy change after grant may remain undetected by this bounded v365 step.
- The old v353/v354 explicit forfeit writers can terminalize dispatched holds immediately after start, and their independent expiry paths can split ordinary and Guardrail outcomes. They need grant-aware guards and a common all-hold recovery/terminal writer in the same activation transaction. The v353 window-first writer also has a potential lock cycle against this proposal's reservation-table-before-window check; lock order and concurrency must be resolved before deployment.
- Custody has one fixed epoch and no renewal, result writer, provider bill reconciler, buyer settlement, economic outbox, or retry unlock. A committed marker is possible send, not proof that a provider saw bytes. A crash after grant, custody, or start leaves an unresolved unknown obligation.
- The upload digest is computed by the holder and compared to v362; the database cannot inspect actual outbound bytes, URL, bearer, or physical fetch. No real two-Worker/provider path, Hyperdrive behavior, Linux CI result, D1/MySQL parity, or fleet drain/cutover is proven here.

This is a local safety increment toward the [v364 grant-result protocol](./C04-v364-grant-result-protocol.md), not approval to activate that protocol or mark C04 accepted.
