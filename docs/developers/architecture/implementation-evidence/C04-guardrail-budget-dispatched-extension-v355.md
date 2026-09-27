# C04 v355: dispatched private BYOK to paid Guardrail extension

Status: **review only, default off**. No formal migration, route, coordinator,
Worker, Hyperdrive binding, production credential, remote SQL, or deployment
changed.

## Boundary and invariants

The [v355 SQL proposal](../../../../packages/core/migrations-proposals/postgres/guardrail-budget-dispatched-extension-login-v355.sql)
adds `extend_guardrail_budgets_dispatched_v355` after PG73 and reviewed
v348/v349/v350/v351/v353 proposals. Installation requires a direct migrator
LOGIN and a transaction-local `reviewed-v1` activation value. Only the direct
budget-admission LOGIN receives `EXECUTE`. The runtime LOGIN receives no raw
Guardrail table DML; preflight and postflight reject table or column level
runtime write-grant drift. v355 does not add raw DML for any role. Buyer
settlement retains its preexisting v349 table update grant.

The function takes a fixed request, user, and Key ID; validates that the Key
belongs to the user, is active, has an enabled BYOK limit, and belongs to an
active workspace. It accepts only a request whose existing rows are fully
dispatched and whose unique route-selective row is the authenticated Key limit.
That original row keeps its `gateway_key_route` basis, reserved amount, and
dispatch mark. A paid extension cannot reserve more per charged intent than
the original route Key ceiling. When the complete intent set creates charged
rows, the Key lease is extended to cover their expiry in the same transaction.

The function validates the supplied Key, workspace budget, and configured
Guardrail intents against current DB configuration and requires the complete
set. It rejects stale windows, changed limits or versions, missing intents,
mixed terminal states, and pre-dispatch rows. A replay must match every row's
immutable intent and charged amount before returning `idempotent`. Existing
charged rows plus missing charged rows reject as a mixed state. The request
advisory lock, ordered reservation/window locks, live counter check, and a
single SQL transaction make the charged rows and window holds atomic. A
capacity block rolls back even newly seeded windows using a PL/pgSQL
subtransaction. The database clock bounds the call and active lease. A
buyer-held reservation row produces immediate `55P03`; the caller must keep
the original hold and must not send a paid fallback on an unknown outcome.
The function rereads the database clock after acquiring the request advisory
lock and again before changing counters. A lease expiring during a lock wait
returns `stale`, leaving the original hold unchanged.

The Key-only `n=1` shape inserts no charged row and never extends the route
Key lease. Its `idempotent` result is now allowed only when the DB-held Key
lease covers the **requested** paid-dispatch expiry. An expiry even one
millisecond later returns `stale`. The same shortest-lease check applies to
replays after charged rows already exist; a replay cannot request a longer
authorization than the committed rows. Both successful statuses return the
database-attested `leaseExpiresAt`, and the adapter refuses a success without
that proof or with a lease shorter than the submitted expiry. A retry asking
for a later lease fails closed; the caller must preserve the original hold
and must not infer paid-send permission.

The [v355 request owner](../../../../packages/proxy/src/services/postgres-guardrail-budget-extension-v355.ts)
composes the v353 lifecycle candidate with a dedicated direct admission
connection. It fixes request/user/Key IDs, snapshots intent values before a
queued transaction, checks the direct LOGIN each time, validates the function
response including its attested lease, does not retry an unknown COMMIT, and
confirms connection cleanup.
Preflight cleanup failure is surfaced, including a client `end()` that does
not return a thenable. Targeted adapter tests passed **3/3** cases for an
unknown COMMIT, unconfirmed preflight cleanup, and short or exact Key-only
lease proof. No coordinator opens this owner by default.

## Native evidence

The [owned PG18.6 fixture](../../../../scripts/db/cutover/postgres-guardrail-budget-dispatched-extension-v355.native.test.mjs)
installed PG73 and the reviewed prerequisites in a temporary loopback
cluster. The [machine report](C04-guardrail-budget-dispatched-extension-v355-results.json)
records **PASS**, **cleanup PASS**, and **15 passing stages**. It verifies
activation and ACLs, including refusal of an injected runtime column-level
write grant; identity, amount, and complete-intent rejection; atomic
paid extension preserving the Key hold; exact replay; a simulated lost
extension acknowledgement; capacity rejection; stale or mixed state
rejection; counter corruption rollback; buyer-held row refusal; the real
request-fixed adapter; v353 full-ceiling forfeit of both the route and paid
rows; replay rejection after a configuration change; and a held request
advisory lock that outlives the route lease. New Key-only stages verify an
exact-lease replay without a write, a one-millisecond overrun refusal, and
an expiry crossed while waiting for the request advisory lock. A multi-intent
replay requesting one millisecond beyond its held lease also returns `stale`
without changing rows.

Source SHA-256 in the report: v355 SQL
`32060dd95d62de0689eb986bf3dea5ec7a42bc31bb41de9b5420bcfdea1f46ce`,
adapter `58fee73afe520a04a5a93e9893a37dadb2efce73858ae422cf31c881ec165c77`,
fixture `167bc0ec2cf7087e9fe5031f931260d1075ca50e073799f81ca752b76ee2be16`.
Proxy TypeScript checking, fixture `node --check`, and targeted
`git diff --check` also passed.

## Remaining cutover gates

- The SQL validates the relationship among caller-supplied user, Key,
  request rows, intent configuration, and amounts. It cannot independently
  prove that the admission LOGIN received a bearer-authenticated request or
  that the charged amount covers every billable fallback route. The Chat
  request-local quote proof remains a separate candidate, and an end-to-end
  binding review is still required.
- The v355 owner is not wired into the real route coordinator. That owner
  must preserve ACK-unknown no-send behavior, handle pre-dispatch release
  versus post-dispatch forfeit, and not treat an extension conflict as paid
  send authorization.
- The Key-only branch proves the requested expiry at the SQL boundary. The
  future coordinator still needs to enforce that the actual paid fetch occurs
  before that lease expires; this owner returns the existing repository
  status type without carrying the expiry to the dispatch boundary.
- Buyer settlement and late actual usage were not executed after extension
  in this fixture. The buyer writer's multi-intent lock order, the route
  Key's route-selective settlement amount, and concurrent settlement versus
  extension require an end-to-end native run.
- Configured Guardrail assignment coverage follows the v351 DB logic. A
  concurrent configuration change during extension and real UTC period
  rollover need explicit validation. The function's request-log aggregate
  does not establish a production physical I/O bound.
- The fixture simulates a lost COMMIT acknowledgement after commit; it does
  not break a TCP connection. D1/MySQL parity, Linux CI, and production
  Worker/Hyperdrive behavior remain open.
