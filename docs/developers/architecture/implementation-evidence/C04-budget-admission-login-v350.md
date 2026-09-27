# C04 v350: ordinary-budget admission LOGIN boundary

Status: **review only; no production admission cutover**.

The current PostgreSQL ordinary-budget repository writes `users.budget_reserved_micros`
and `user_budget_reservations` directly. The Guardrail repository writes
`guardrail_budget_windows` and `guardrail_budget_reservations` directly. After
the v346/v347 buyer split, the ordinary runtime has no direct user-budget write
permission, while the buyer settlement LOGIN cannot insert an ordinary
reservation. The earlier Chat fixture had to add an unreviewed buyer INSERT grant.

[The v350 proposal](../../../../packages/core/migrations-proposals/postgres/budget-admission-login-v350.sql)
requires an independently provisioned `cinatoken_gateway_budget_admission`
direct LOGIN with no role memberships. It is default-off, requires PG73 and the
atomic v348 buyer split marker, and must run as the direct migrator with
`cinatoken.budget_admission_login_activation=reviewed-v1`. It grants the
admission LOGIN schema usage and EXECUTE on three `SECURITY DEFINER` functions:
ordinary reserve, mark dispatched, and release before dispatch. The LOGIN
receives no direct financial table writes. The reserve function locks the active
API key and user row; checks account epoch, capacity, lease length, and the
active reservation sum against the account hold counter; then updates the
counter and inserts the reservation in the same transaction. Mark and release
check the active ledger/counter invariant and allowed state transition. A
Guardrail-denial release reason is rejected because v348 records that proof
only when the buyer settlement LOGIN performs the release.

[The owned PG18 native fixture](../../../../scripts/db/cutover/postgres-budget-admission-login-v350.native.test.mjs)
ran against formal PG73, the existing economic prerequisites, and the atomic
v348 buyer split. The [machine report](C04-budget-admission-login-v350-results.json)
records **PASS**, **cleanup PASS**, and 10 passing stages. It verifies:

- Default-off rollback, ACL preflight drift refusal, direct write and
  cross-role denials, and retained buyer settlement versus ordinary runtime ACLs.
- The ordinary reservation obtains the existing v344 private buyer admission
  receipt with `hold_verified=true` after commit.
- Reserve/replay, over-limit rejection, API key ownership, epoch staleness,
  ledger/counter drift rejection, legal mark/release, and a concurrent
  reserve race that cannot overbook.
- The actual old ordinary and Guardrail repositories both fail with SQLSTATE
  `42501` under this function-only LOGIN.
- A temporary raw `guardrail_budget_windows.reserved_micros` grant allowed the
  LOGIN to create an unmatched 500,000-micro hold without a reservation.
  That test-only grant was revoked and the fixture restored the window.
- The legacy grant rerun refuses to reopen runtime finance permissions.

This is a safe database primitive, not a working Chat role switch. An
application adapter must call the new functions through an independently
authenticated connection; the current repositories cannot use them. Guardrail
multi-intent admission, window accounting, dispatched forfeiture, lease
recovery, and the buyer-only v348 denial receipt need separate DB-enforced
contracts. The LOGIN currently can call the ordinary functions for any
user/key pair that passes the database ownership check, so request identity
binding and credential isolation still need review. Production role
provisioning, formal migration, D1/MySQL, Linux CI, and deployment are not
covered by this local proof.
