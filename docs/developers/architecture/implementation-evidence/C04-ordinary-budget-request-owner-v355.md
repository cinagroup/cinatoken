# C04 ordinary budget request owner composition (v355, 2026-09-25)

Status: **local review only, default off**. No Chat route, Worker configuration,
remote SQL, formal migration, or deployment opens this owner.

## Request boundary

[The request owner](../../../../packages/proxy/src/services/postgres-ordinary-budget-request-owner.ts)
composes the existing [v350 admission LOGIN](C04-budget-admission-login-v350.md)
and [v354 recovery LOGIN](C04-ordinary-budget-recovery-v354.md) with separate
direct connections. It copies and fixes the request ID, user ID, API key ID,
and budget epoch before opening either client. Its port sends reserve,
mark-dispatched, and pre-dispatch release only to the admission LOGIN; expiry
and post-dispatch forfeit only to the recovery LOGIN. The underlying owners
check both CURRENT_USER and SESSION_USER inside each transaction. A shared
connection string or physical client, wrong LOGIN, or changed request identity
rejects before a budget write. Partial-open failure closes the already opened
owner, and request close waits for in-flight transactions and both close
acknowledgements.

`createAdmission` passes this port to `createRouteAwareBudgetAdmission` with
the new opt-in `ordinaryRecoveryFailureMode: 'fail_closed'`. On an expiry
exception, including unknown COMMIT outcome, paid admission rejects with
`recovery_persistence_failed` **before reserve, Guardrail admission, dispatch
mark, or an upstream send**. The coordinator retains the rejected paid
admission promise, so another attempt on the same request does not replay the
uncertain expiry transaction. Existing routes still use their previous
best-effort expiry behavior; the strict mode only applies when explicitly
selected. The caller must close the composite owner in its request `finally`
block and treat unconfirmed cleanup as an error.

## Local validation

- `npx tsx --test` on the new composite test plus admission, recovery,
  coordinator, and ordinary lifecycle suites: **58/58 PASS**. The new
  composite suite contributes 6/6: separate LOGIN routing, identity
  rejection, unknown recovery COMMIT before reserve/fetch with no replay,
  partial-open cleanup, both-client close failure handling, and in-flight
  COMMIT close ordering.
- `npm run typecheck -w @octafuse/proxy`: **PASS**.
- Targeted `git diff --check`: **PASS**.
- The underlying real PostgreSQL 18.6 fixtures for v350 and v354 are recorded
  in their linked evidence notes. This composition itself has mock-client
  tests; it has not been exercised end to end against native PostgreSQL.

Source SHA-256 at review:

| Source | SHA-256 |
| --- | --- |
| `ordinary-budget-lifecycle.ts` | `64fa79750ed1cf2f7fa342380b61e74544162d606a4cfac32abc8ed18d5a7f1d` |
| `request-budget-admission.ts` | `41362852abe1acc9de06711cdb6bb5d54c2233dd9a15b3151e8330d3ebcb4e60` |
| `postgres-ordinary-budget-request-owner.ts` | `836c6579f502c3d0885b2d4a3c07659acebc555f585e833d95d70276245d926e` |
| `postgres-ordinary-budget-request-owner.test.ts` | `2fbddf5ff5bb6178350705fb2edf541e2a3953b5844bdf3a0c264856e32e0d19` |

## Remaining gate

The real Chat request path does not open or close this owner. That integration
still needs the authenticated quote proof, runtime/admission/recovery secret
provisioning, the Guardrail owner, and a request `finally` that confirms both
client closes. The v350 SQL checks key ownership and epoch, but does not
independently verify bearer possession or the route-price quote. The v354
recovery LOGIN has global expiry and dispatched-forfeit authority, so
credential isolation and production configuration need review. Late actual
usage reconciliation after conservative full-ceiling forfeit remains unsolved.
