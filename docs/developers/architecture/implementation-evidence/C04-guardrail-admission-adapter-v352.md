# C04 v352: request-scoped Guardrail admission adapter candidate

Status: **review only; not wired to routes, the current budget coordinator, or
a Worker**.

[The candidate owner](../../../../packages/proxy/src/services/postgres-guardrail-budget-admission.ts)
opens a separate direct `cinatoken_gateway_budget_admission` connection for
one request. It verifies `CURRENT_USER` and `SESSION_USER` on every transaction,
checks that its runtime and admission clients are distinct, and fixes the
request/user/Gateway-Key identifiers for its lifetime. It exposes only
`reserveMany`, `markDispatched`, and pre-send `releaseMany` through the v351
`SECURITY DEFINER` functions. It sends the intents as a typed JSON parameter,
copies the policy and amount at method entry so a queued LOGIN check cannot
observe later caller mutations, requires an acknowledged transaction result,
waits for in-flight operations
on close, and reports unconfirmed cleanup. It issues no raw budget table DML.

The returned port is deliberately narrower than `GuardrailBudgetsRepository`.
Its separate `unsupported` calls for `extendDispatched`, `forfeitMany`, and
`expireBefore` reject explicitly. The current
`reserveRequestGuardrailBudgets` coordinator catches an `expireBefore` error
and proceeds, so passing a fake complete repository there would silently skip
required recovery. No coordinator or route is changed by this candidate.

[The owned PG18.6 fixture](../../../../scripts/db/cutover/postgres-guardrail-admission-adapter-v352.native.test.mjs)
installed formal PG73 and the local v348/v349/v350/v351 proposals. Its
[machine report](C04-guardrail-admission-adapter-v352-results.json) records
**PASS**, **cleanup PASS**, and **7 passing stages**. Adapter SHA-256:
`613aaa98c6acda518eb597527814e3cb8f9052b262f50fca07f312ddefcee748`;
fixture SHA-256:
`c9a628f01292f91023f83ce3c722acbbd45c9b0b2f1d2c4c3aa135444a885a7a`.
It verifies real two-intent reserve/replay, request identity mismatch before
SQL, pre-send release of both holds, mark and refusal to release after
dispatch, unsupported transition rejection, and the lack of runtime or
admission table or column-level raw Guardrail write grants. Actual runtime
and admission LOGINs also received SQLSTATE `42501` for direct UPDATE attempts.
The separate
[targeted test](../../../../packages/proxy/src/services/postgres-guardrail-budget-admission.test.ts)
passed 4/4 checks for unknown reserve COMMIT acknowledgement without an
automatic replay, call-time parameter snapshotting, role mismatch cleanup,
and unconfirmed close. Proxy
TypeScript checking and `git diff --check` passed.

Open cutover gates:

- The owner identity is supplied by its caller. It is not independently bound
  to an authenticated request, and the reserved micro amount is not bound to
  a signed quote or trusted cost ceiling. The `gateway_key_route` choice also
  remains caller supplied.
- The existing request coordinator requires expiry handling and can require
  dispatched fallback extension or conservative forfeiture. v351 does not
  implement those transitions; no application call path may use this owner as
  its full Guardrail repository until the lifecycle is designed and verified.
- The v348 pre-send denial receipt remains buyer-LOGIN-only. The admission
  owner rejects that special reason; pairing a buyer ordinary-budget release
  with Guardrail rejection still requires a separate reviewed contract.
- No formal migration, production secret, Worker/Hyperdrive binding, remote
  SQL, deployment, D1/MySQL parity, or Linux CI run was performed.
