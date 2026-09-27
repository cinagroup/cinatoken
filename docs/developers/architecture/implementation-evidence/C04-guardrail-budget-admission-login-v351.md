# C04 v351: Guardrail budget admission LOGIN boundary

Status: **review only; no production cutover**.

After the v349 buyer Guardrail split, ordinary runtime still has raw `INSERT` and
`UPDATE` on `guardrail_budget_windows` and `guardrail_budget_reservations`; the
v350 admission LOGIN has neither. The current PostgreSQL Guardrail repository
therefore cannot execute under the admission LOGIN. Adding raw grants would let
it create holds without matching reservations or bypass window capacity.

[The v351 proposal](../../../../packages/core/migrations-proposals/postgres/guardrail-budget-admission-login-v351.sql)
requires the direct migrator, formal PG73, atomic buyer Guardrail split v349,
ordinary admission v350, a direct `cinatoken_gateway_budget_admission` LOGIN,
and an explicit `reviewed-v1` activation setting. In one transaction it revokes
the ordinary runtime's raw Guardrail DML and grants the admission LOGIN only
`EXECUTE` on three `SECURITY DEFINER` functions: multi-intent reserve, mark
dispatched, and pre-send release. It does not grant admission raw window or
reservation writes. The functions check active key ownership and Workspace,
configured Guardrail policies, Workspace budgets, Gateway Key limit, supplied
intent completeness, scope, version, limit, period, ledger/counter balance, and
allowed state transitions. The reserve function sorts and locks every window,
checks all capacities before increasing any hold, and uses the v348 request
advisory lock shared with the private denial receipt. The database clock, not
the caller's timestamp, determines period bounds and key expiry. The dispatch
mark checks the database clock again after acquiring the request, reservation,
and window locks; a lease that expires during lock wait cannot authorize
dispatch. An idempotent replay must also be covered by the stored lease when
it requests a later expiry.

[The owned PG18.6 fixture](../../../../scripts/db/cutover/postgres-guardrail-budget-admission-login-v351.native.test.mjs)
ran with formal PG73 and the local v348/v349/v350 proposals. Its
[machine report](C04-guardrail-budget-admission-login-v351-results.json) records
**PASS**, **cleanup PASS**, and **13 passing stages**. Proposal SHA-256:
`d20e754b9c523597a6cc1e76d434aac90618045d543a431e3ae269836cf47a8d`;
fixture SHA-256:
`bbcbb33aa07d33530692d64d7ab5d24844bbfd44777f9ab8170533d2af0a60af`.
The report hashes formal migrations and the local prerequisite proposals.

The fixture verifies default-off rollback, raw-grant drift refusal, runtime
and admission ACLs, three simultaneous budget intents and idempotent replay,
missing/forged/stale intents, capacity rejection without an added hold, a
counter/ledger mismatch, concurrent calls that cannot overbook, pre-send
release, dispatch mark and no release after dispatch. It also verifies that
the admission LOGIN cannot use the special
`guardrail_budget_admission_rejected` reason: the v348 private denial receipt
still requires the buyer settlement `SESSION_USER`. A lagged caller timestamp
cannot re-admit a key already expired by database time.
The fixture also holds the request advisory lock while a short reservation
lease expires, observes the blocked mark call with `pg_blocking_pids`, and
verifies that the call returns false without dispatching any reservation. A
replay requesting a longer unrecorded dispatched lease fails as well.

The current JS validator and v351 API reject two legitimate assignments that
share the same Workspace/scope/period/window. A Workspace default budget and a
direct user assignment can create such a configuration; the native fixture
shows it fails closed. Resolving that configuration requires a separate
policy/ledger design, not silently merging or double counting reservations.

Open cutover gates:

- Separate review-only v352/v356 application adapters exist, but authenticated
  Chat has not wired the dedicated admission owner or checked a live lease at
  physical inference egress.
- The LOGIN may call the functions for any valid user/key pair and choose the
  request ID, held micro amount, and `gateway_key_route` basis. The database
  does not bind those arguments to an authenticated request or signed cost
  ceiling; an arbitrary small hold could under-reserve. Independent request,
  quote, and route binding are not established.
- Dispatched fallback extension, forfeiture, expired lease recovery, and buyer
  settlement remain outside these three functions. The buyer settlement LOGIN
  retains trusted raw Guardrail writes.
- Configuration changes concurrent with admission, concurrent buyer request-log
  settlement outside the window lock, and the overlapping assignment policy
  need further review. The native test validates a clock-lagged expired key
  and asserts the database-clock period implementation; it did not run at an
  actual UTC day/week/month boundary.
- The mark function's fresh clock check occurs immediately before its `UPDATE`
  under the acquired locks, not at transaction commit. The caller still needs
  to verify a live persisted lease immediately before physical inference
  egress, including after a delayed or uncertain commit acknowledgement.
- No formal migration, production role/credential, Worker/Hyperdrive binding,
  remote SQL, deployment, D1/MySQL parity, or Linux CI run was performed.
