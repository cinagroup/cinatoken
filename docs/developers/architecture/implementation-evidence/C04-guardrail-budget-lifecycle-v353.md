# C04 v353: Guardrail dispatched forfeit and database-clock recovery

Status: **review only, default off**. This candidate changes no formal migration,
route, coordinator, Worker, Hyperdrive binding, production credential, or deployment.

## Existing request contract

`request-guardrails.ts` uses a two-minute initial reservation lease and a
15-minute dispatched lease. The existing coordinator reserves for a route,
requires a durable dispatch mark before upstream send, releases only on a
definitive pre-send outcome, and forfeits an unknown post-dispatch outcome.
The single-grant branch requires an acknowledged claim COMMIT before marking;
an unknown claim acknowledgement holds the lease and forbids provider send.
The ordinary-budget mark follows the Guardrail mark. If it fails, the
Guardrail hold must be conservatively forfeited.

Private BYOK can first reserve and dispatch only the Gateway-Key limit with
`settlement_basis=gateway_key_route`. A later paid fallback requires an atomic
dispatched extension that adds the charged intents while retaining the
original key-route row. That extension is **not** implemented here.

`reserveRequestGuardrailBudgets` currently catches and logs `expireBefore`
errors, then continues to reserve. Thus the [v353 adapter](../../../../packages/proxy/src/services/postgres-guardrail-budget-lifecycle-v353.ts)
is a separate narrow candidate, not a substitute for the full
`GuardrailBudgetsRepository` used by that coordinator. Its
`reserveAfterRecovery` calls the new database-clock function before v351
reserve; it fails if recovery errors or four full pages of 50 leave a possible
backlog. A concurrent locked expired row can be skipped, so a short return
does not prove a fully drained backlog. Such a row keeps capacity
conservatively blocked. The adapter exposes mark, pre-send release,
request-fixed forfeit, and bounded recovery; extension still rejects.

## Proposed DB boundary

The [v353 SQL proposal](../../../../packages/core/migrations-proposals/postgres/guardrail-budget-lifecycle-login-v353.sql)
requires direct migrator activation after PG73 and the reviewed v348/v349,
v350, and v351 proposals. The direct budget-admission LOGIN receives only
`EXECUTE` on two `SECURITY DEFINER` functions. Runtime, buyer settlement, and
admission LOGINs receive no new raw Guardrail table write grants.

- `forfeit_guardrail_budgets_v353(request_id, reason)` atomically moves each
  dispatched hold from window reserved to settled at its full ceiling, records
  `expired` and the terminal reason, and returns the transitioned row count.
  Repetition returns zero for already conservatively settled rows. Reserved,
  released, settled, and malformed mixed states fail closed. It uses the v348
  request advisory lock, ordered row/window locks, and checks that the window
  reserved counter equals active reservation rows. Reservation locks use
  `FOR UPDATE NOWAIT`: buyer settlement can lock a row before its v348 update
  trigger requests the same advisory lock. A busy buyer row returns SQLSTATE
  `55P03` immediately, rolling back any earlier intent work. The request owner
  must hold the full ceiling and retry from durable state; it must never
  interpret this failure as permission to release or resend.
- `expire_guardrail_budgets_v353(limit)` accepts no caller timestamp. It uses
  the database clock and a 1–50 row bound. Expired `reserved` rows become
  `released` with no settled charge; expired `dispatched` rows become `expired`
  and settle their full ceiling. A page may split a multi-intent request; v351
  mark then rejects the mixed state, and a later page completes recovery.
  It skips request advisory locks held by concurrent work and uses `FOR UPDATE
  SKIP LOCKED` for buyer-held reservation rows. A busy sibling can leave a
  request partially terminal; v351 mark rejects that mixed state, and later
  recovery can finish it. A zero count does not prove that all expired rows
  were processed while concurrent locks exist.

The expiry candidate query draws at most 200 rows from each of two ordered
`reserved` and `dispatched` branches, then groups those at most 400 rows by
request. The PG73 `(state, expires_at)` index is required by activation and
matches each branch. This caps the candidate **result**, while the optimizer's
physical scan and sort work remain unproven for production data sizes. A busy
or very large early prefix can defer later expired holds. A production query
plan and workload bound remain cutover blockers; this is an availability risk,
not evidence of releasing a possibly sent ceiling.

The v353 terminal shape matches the existing PostgreSQL critical writer's
`expired` accounting path: late actual usage can reconcile against the
reserved ceiling without charging it twice. This fixture did not execute a
late-usage settlement against v353 terminal rows, so that integration remains
an explicit review gate.

## Native evidence

The [owned PG18.6 fixture](../../../../scripts/db/cutover/postgres-guardrail-budget-lifecycle-v353.native.test.mjs)
installed PG73 and reviewed prerequisites in an owned loopback cluster.
The [machine report](C04-guardrail-budget-lifecycle-v353-results.json) records
**PASS**, **cleanup PASS**, and **8 passing stages**. It verifies default-off
activation; direct LOGIN function ACLs and raw DML rejection; two-intent
forfeit and idempotence; reserved expiry release; dispatched expiry full-ceiling
settlement; a partially recovered request refusing mark; an already committed
mark with a simulated lost acknowledgement refusing release; same-lease
mark replay succeeding while a longer unrecorded lease is rejected; and real adapter
`reserveAfterRecovery → mark → forfeit` calls. It also rejects forfeit before
dispatch and proves a corrupted second window rolls back an earlier window's
forfeit work atomically. A separate buyer LOGIN holds reservation row locks:
forfeit returns `55P03` without waiting or changing state, while expiry skips
the busy sibling and completes recovery after the buyer transaction ends. A
220-row synthetic expired backlog shows the 200-row candidate prefix and
proves that four full 50-row recovery pages reject a new reservation, leaving
20 holds for later recovery. This fixture does not prove physical I/O bounds.

Source SHA-256 in that report: proposal
`b0c97481d475b413fc2a2e77e6db018c680e667db10805f30605e3e78edf08ff`,
native fixture
`b159d67f61302e80e2aff018a079e36be8df4f98288cee4eda13563f1a81c07c`,
and adapter
`259bddb61bfcfc8486a462224d54ef5f7dfa7ef91cca58e0b0aa5ac972768e81`.
The [targeted adapter test](../../../../packages/proxy/src/services/postgres-guardrail-budget-lifecycle-v353.test.ts)
passed 5/5 checks for recovery failure before reserve, unknown forfeit COMMIT
without replay, direct-LOGIN mismatch cleanup, explicit failure when preflight
cleanup lacks an acknowledgement, and thenable close confirmation. Proxy TypeScript checking,
`node --check` on the fixture, and `git diff --check` passed.

The fixture forced expiry timestamps using its privileged migrator. It did not
wait for real leases to elapse. Its lost-ACK case injects an application error
after a confirmed mark COMMIT; it does not break a live TCP connection. No
remote SQL or deployment ran.

## Remaining cutover blockers

- The request owner fixes IDs in process but receives `requestId`, `userId`,
  `apiKeyId`, intents, amount, and `gateway_key_route` from its caller. They are
  not independently bound to authenticated request identity, authorized route,
  or a signed quote/cost ceiling. A caller able to open the admission owner
  can still choose another valid identity or an understated reservation.
- BYOK-to-paid `extendDispatched` is absent. Buyer-specific denial receipt and
  final settlement remain on separate contracts. The existing coordinator's
  swallowed expiry error and unsupported extension prevent v353 from being
  wired into real routing as a full repository.
- ACK-unknown handling still needs a persistent request owner protocol that
  forbids another provider send and never releases a possibly dispatched
  ceiling. The tested function transitions are idempotent, but the end-to-end
  owner/route protocol is not deployed or validated.
- Buyer settlement and admission use different lock orders. v353 avoids the
  demonstrated row/advisory deadlock by declining busy forfeit and skipping
  busy expiry rows. Buyer critical writer's multi-intent lock order is still
  unspecified, and a concurrent end-to-end settlement/forfeit run has not
  been validated. A durable owner retry policy and concurrency review remain
  cutover gates.
- No formal migration, production secret, real Worker/Hyperdrive execution,
  D1/MySQL parity, Linux CI, or real UTC period-boundary run is included.
