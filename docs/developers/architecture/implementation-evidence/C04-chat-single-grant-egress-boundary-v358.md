# C04 Chat single-grant egress boundary audit (v358, 2026-09-25)

This is a **default-off local dispatch guard**, not a PostgreSQL dispatch grant or completed C04 acceptance. No production migration, remote SQL, or deployment was run.

## Checked call path

| Stage | Current source | Finding |
| --- | --- | --- |
| Authenticated Chat budget owner | `routes/v1/chat.ts` `beforeUpstreamDispatch` | Chat calls `RouteAwareBudgetAdmission.beforeUpstreamDispatch(route)` beside dispatch. The quoted path also checks for a finite ordinary hold. This marks budget ledgers; it does not validate the final wire URL, selected credential, or a fresh dispatch claim. |
| Route and credential failover | `services/failover-dispatch.ts` delegated `beforeFetch` | Each text attempt claims its shared-key quote reference, awaits budget admission, consumes a local permit, then lets the driver continue. The existing `stopAfterFirstGrantedDispatch` prevents provider and model failover after the first granted result, including a known non-2xx response or thrown driver failure. The new request-local one-shot guard also rejects a second entry to that delegated boundary before another quote/admission/send can start. |
| Physical text fetch | `services/egress/openai-driver.ts`, `openai-responses-driver.ts`, `anthropic-driver.ts`, `gemini-driver.ts` | Each driver resolves the URL, serializes the request body, resolves the upstream secret, calls `beforeFetch?.()`, then calls `fetch`. None passes a prepared-attempt identity to the callback, although `failoverDispatch` accepts an opaque optional argument. The callback cannot compare its authorization with the URL, credential, and body actually handed to `fetch`. |
| Existing budget leases | `services/request-budget-admission.ts`, `ordinary-budget-lifecycle.ts` | Guardrail dispatch mark is memoized in the request owner; an ordinary lease in `dispatched` state returns immediately. A later failover attempt therefore does not itself obtain a fresh authoritative permission from either ledger. |
| Quote and bearer proof | `services/shared-key-quote-attempt.ts`, review-only PostgreSQL v356/v357 proposals | The shared-key reference has a claim time and quote version but no send deadline. The v356 request capability expires within 60 seconds; the v357 route ceiling is explicitly one route's quote fragment, not a dispatch grant. The text request deadline can last 300 seconds. Neither proposal is checked at the physical text fetch boundary today. |

## Local check

`node --import tsx --test packages/proxy/src/services/failover-dispatch.test.ts`: **61/61 PASS**. The new re-entry test confirms one admission invocation and zero simulated sends after a driver calls `beforeFetch` twice under `stopAfterFirstGrantedDispatch`. The new loopback HTTP test drives the real OpenAI Chat text driver through a 503 and observes exactly **one HTTP request** and one admission callback. Existing tests retain ordinary two-attempt failover when the opt-in flag is absent and allow a second candidate after the first fails in local preparation before admission. `npm run typecheck -w @octafuse/proxy` and `git diff --check` pass.

The tests use a local callback that returns success. They prove dispatch control flow, not a durable, authorized PostgreSQL claim. The opt-in Chat wiring and global model forwarding must be verified separately because one dispatcher instance cannot constrain a later outer model invocation on its own.

## Required physical egress contract

1. Text drivers must create an immutable prepared attempt from the **same** URL, credential identity, method, and outbound body used by `fetch`, after local preparation and before the callback. The grant check must reject missing or changed prepared facts. An upstream secret must not be copied into logs or an untrusted caller argument. The existing image `PreparedImageAttempt` and `beforeImageRecoveryDispatch` path is a useful pattern, with text-specific canonicalization and wire tests still required.
2. A separately authorized PostgreSQL broker must bind the authenticated request capability, complete route and credential quote, ordinary/Guardrail reservation identities and ceilings, prepared-attempt digest, revocation ordering, and server-clock expiry into a **single consumed dispatch claim** before send. A quote fragment or an in-memory `stopAfterFirstGrantedDispatch` flag cannot stand in for this transaction. A committed or uncertain claim forbids a second network send; definite pre-claim denial may release reservations.
3. The Chat owner should use the existing `prepareSingleGrant` budget ticket, claim before budget dispatch marks, and apply `stopAfterFirstGrantedDispatch` through both per-model and global fallback. Keep pending claim and budget mutations owned through cancellation/deadline; fail closed on mismatch, expiry, lost commit acknowledgement, or a post-claim budget-mark failure.
4. Verify real text-driver negative cases for a wrong route, endpoint, credential, body, expired quote after lock wait, revoked key, second `beforeFetch`, known 503, transport ambiguity, and cancellation. Run the broker's lock/revocation races and crash windows against disposable PostgreSQL with separate LOGINs, then rerun the actual Chat path. Existing local dispatch tests alone do not prove these database or physical-binding requirements.

C04.1–8/G and the C08 physical dispatch claim gates remain open.
