# C04 Chat dispatch and earlier unknown attempt audit (v355)

2026-09-25. Local source and loopback audit only. The opt-in economic producer and authenticated Chat budget proof remain default off; this is not a production supplier-billing observation.

## Physical inference-send boundary

- `routes/v1/chat.ts` creates or inherits one request-local `dispatchBudget`, passes it to the global dispatcher and every ordinary model candidate, and stops the outer loop when `failoverForbidden` is set.
- `services/proxy.ts` forces `delegateBeforeUpstreamDispatchToDriver: true` for text calls and passes the pre-fetch callback to the OpenAI Chat driver. `services/failover-dispatch.ts` checks availability before key expansion, then after awaited quote capture and durable admission performs synchronous `dispatchBudget.consume()` immediately before the driver fetch. A concurrent branch cannot exceed the limit of three in `services/request-dispatch-budget.ts`.
- `services/egress/openai-driver.ts` prepares URL, body, upload stream, credentials, and headers, awaits that callback, and makes one `fetch` with `redirect: 'error'`. The Responses, Anthropic, and Gemini text drivers follow the same single-fetch pattern. `services/shared-key-pool.ts` and `services/byok-key-pool.ts` expand ordered credential clones from repository reads; neither sends inference HTTP in its expansion function. A cold GCP service-account OAuth exchange is auxiliary authentication, separately claimed through the same request's three-exchange budget, and uses `redirect: 'manual'` (`packages/core/src/gcp-service-account-token.ts`).
- The global `partition=none` path forwards the caller's budget to its one proxy invocation (`services/model-fallback-global-dispatch.ts`). Explicit 429 may advance to another candidate, but the next send must claim another permit. Sent 408/499/503, redirect, and transport ambiguity forbid candidate replay.

These sources and loopback tests support a **code-level ceiling of three text-driver inference `fetch` calls per request** on the inspected path. They do not prove that a provider or intermediary cannot internally duplicate or bill a received POST, nor do they prove production Workers/Hyperdrive wiring.

## Pre-fix economic case: earlier sent attempt remains unknown

1. Shared key A is quoted and sends POST. Its provider returns HTTP 429. The dispatcher is allowed to try B, but A's quote transport records `upstream_headers_observed/429`; A's usage and provider cost remain `unknown`. The real loopback case is in `services/shared-key-quote-attempt.test.ts` under `real Chat loopback binds only the selected provider usage`. `services/shared-key-quote-attempt.ts` makes an economic outcome for every captured attempt, and only observed 2xx provider usage can become `actual`.
2. Shared key B sends POST and returns 200 with provider usage. Chat records only B's selected provider usage against B's reference (`routes/v1/chat.ts`, `observeProviderUsage`). A is retained in the handoff, but its cost remains unknown. This is correct evidence handling; a 429 is not proof of a supplier zero bill.
3. Before the local guard below, B's complete usage made `textUsageCostIsUnknown` return `false` based on the terminal response (`services/text-usage-settlement.ts`). It did not inspect A's unknown economic outcome. `prepareSharedKeyEconomicUsageHandoff` chose `buyerChargeBasis: 'actual'` from `ordinarySettlement.unknownCost === false` while allowing earlier attempts to remain unknown (`services/usage-tracker.ts`). The pre-fix contract tests exercised that combination.
4. `ordinaryBudgetSettlementForCriticalWrite` mapped that flag to mode `actual` (`services/usage-tracker.ts`). The PostgreSQL critical writer sets ordinary settlement to the selected actual charge, removes the **entire** reservation from `budget_reserved_micros`, adds only that charge to `budget_spent`, and marks the reservation `settled` (`packages/core/src/db/postgres/critical-writes.impl.ts`, ordinary reservation branch). A later different replay conflicts with the settled receipt. The v2 buyer-debit native fixture explicitly records late actual adjustment as unimplemented (`scripts/db/cutover/postgres-shared-key-buyer-debit-v2.native.test.mjs`).

For example, if the aggregate hold is 300 micro-units and B's selected usage charges 20, settlement releases 280. If A's later provider bill is 40 and policy requires the buyer to bear that attempt, the existing receipt has no reviewed adjustment path to consume the released 40. If buyer policy instead charges only B, the ordinary buyer budget may be correct, but the supplier cost/margin still requires per-attempt C05 reconciliation. A provider bill for A was **not** observed in this audit; the gap is that the current evidence cannot rule it out or reconcile it.

This was a C04.2/C05 readiness blocker, not evidence of an uncounted fourth network send. The current outbox preserves unknown attempt identities, which is a starting point but does not itself close later accounting.

## Local guard added after the audit

`hasPotentiallyBillableUnknownSharedKeyAttempt` in `services/usage-tracker.ts` now validates the quote/transport/outcome alignment and returns true for any quoted attempt past `claimed_only` whose usage remains `unknown`. A mere committed claim with no fetch permit remains outside the exposure set. Chat snapshots the handoff after selected usage observation, ORs this predicate into both ordinary and Guardrail `unknownCost` settlement flags, and passes the same snapshot to the typed economic producer. `recordUsage` independently forces ordinary `unknownCost` to true for an economic handoff with that exposure, so a caller-supplied actual flag cannot release a finite hold. `prepareSharedKeyEconomicUsageHandoff` rejects `buyerChargeBasis: 'actual'` or `'none'` while the exposure exists. Quote activation now requires the aggregate authenticated Chat budget proof to be enabled as well. At `beforeUpstreamDispatch`, a quoted shared-key candidate prechecks the authenticated finite/positive aggregate budget and postchecks a finite ordinary lease already marked dispatched; either failure raises a typed 402 admission error before the dispatch permit and inference `fetch`. These are local review-only guards; they do not change the default-off production posture.

The finite-hold A=429→B=200 case now selects the reserved ceiling for ordinary and Guardrail settlement, while leaving A's supplier cost unknown for C05. The conservative full ceiling may exceed the final buyer charge; a versioned, idempotent adjustment is still required. The same guard applies when B is a private BYOK or platform credential after an earlier shared quote. Terminal sent 429 with unknown usage is also classified as exposure, though the current failed-result path may already reach conservative cleanup because it lacks a selected quote reference.

Two remaining boundaries prevent a C04.2/C04.3 or C05 signoff:

- An unlimited or zero-cost buyer policy now cannot physically send a *quoted shared-key* attempt: the typed guard rejects before `dispatchBudget.consume()`/`fetch`. Quote capture currently precedes that guard, so a durable `claimed_only` row may remain. The updated [selected-event buyer composition fixture](C04-selected-event-buyer-composition-v351.md) runs the real Chat handler against an owned PostgreSQL 18.6 cluster with synthetic authenticated Key/repositories: exhausted finite, unlimited, and zero aggregate quote each return typed 402 with zero inference sends, one persisted claim-only row, and a v2 `none`/zero-debit event; the full fixture passes 23/23 stages with cleanup PASS. This is not a complete auth-middleware, Workers/Hyperdrive, or crash-recovery proof. If a database change between authentication and admission returns an unexpected unlimited lease, the postcheck still blocks fetch; Guardrail may already be marked dispatched and conservatively settled.
- Non-shared BYOK/platform attempts have no per-attempt quote capture in this opt-in handoff. The three-send ceiling still applies, but their independent supplier costs and any later billable failures need an explicit C04.2/C05 policy and reconciliation evidence. No supplier bill, late adjustment, or production Worker/Hyperdrive receipt was exercised here.

Before enabling the opt-in path, a reviewed contract must define buyer liability for each sent attempt, keep an appropriate reserve or durable disputed exposure while its billability is unknown, and accept idempotent late per-attempt facts/adjustments without overwriting the original event.

## Verification

Executed from the repository root:

```text
node --import tsx --test packages/proxy/src/services/request-dispatch-budget.test.ts packages/proxy/src/services/model-fallback-global-dispatch.test.ts packages/proxy/src/services/egress/text-hidden-retry.test.mjs packages/proxy/src/services/egress/text-redirect-wire.test.mjs packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts packages/proxy/src/services/shared-key-quote-attempt.test.ts packages/proxy/src/services/text-usage-settlement.test.ts
```

Pre-fix baseline result: 178 tests passed, 0 failed, 0 skipped. After the guard and updated error-order assertions, the following targeted command passed **733/733** tests (0 failed, 0 skipped):

```text
node --import tsx --test packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts packages/proxy/src/services/shared-key-quote-attempt.test.ts packages/proxy/src/services/text-usage-settlement.test.ts packages/proxy/src/routes/v1/request-dispatch-limit.test.ts
```

After the typed precheck revision, the focused economic handoff, quote capture, and ordinary request-owner suite passed **31/31**:

```text
node --import tsx --test packages/proxy/src/services/shared-key-economic-usage-handoff.test.ts packages/proxy/src/services/shared-key-quote-attempt.test.ts packages/proxy/src/services/postgres-ordinary-budget-request-owner.test.ts
```

Proxy typecheck passed, and the two existing real Chat aggregate-proof cases passed (unaffordable three-hop plan: zero sends; priced two-attempt failover: two sends). Loopback tests use synthetic credentials and local HTTP only. The later PostgreSQL Chat-handler fixture now exercises the no-finite-hold quoted-route guard; no test here settles the unknown supplier-billing assumption.
