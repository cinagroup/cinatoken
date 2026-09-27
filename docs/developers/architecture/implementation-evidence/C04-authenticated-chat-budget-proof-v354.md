# C04 authenticated Chat budget proof (v354, local review candidate)

## Scope

`AUTHENTICATED_CHAT_BUDGET_PROOF_ENABLED='reviewed-v1'` enables a request-local proof after `requireApiKey`, Guardrail evaluation, and full Chat fallback-plan resolution. The binding is absent from shipped Worker/Node configuration; all current production paths remain on the existing coordinator.

The proof has no held-amount argument. It copies the authenticated Gateway Key identity, budget epoch and limit, charged-cost factors, Guardrail intents, and route quote. It derives Ordinary, charged Guardrail, and list-price Gateway Key BYOK holds from the complete priced fallback plan. For each ledger it reserves the largest possible single-attempt amount times `MAX_REQUEST_DISPATCHES=3`, allowing three independently billable attempts, including repeated credentials on the same route. Unsafe integer conversion, missing endpoint price evidence, and a changed authenticated key, priced route, or candidate body reject before network fetch. The route check includes candidate index/model, endpoint price snapshot, charged/metered profile, tier, speed, and route override. The selected route and billing route are checked again immediately before usage recording; Chat passes the captured charged-cost factors and identity into that recording. Plan strategy/order is not in the quote binding because the hold covers any order of the same quoted routes.

This is Worker-side request composition, **not** a database-independent proof. v350/v351 SECURITY DEFINER functions still accept an amount chosen by whichever caller holds the admission LOGIN. The candidate currently invokes the existing route-aware coordinator and does not open the v350/v351 LOGIN owners. It also does not bind bearer possession or actual provider billing inside PostgreSQL. It must not be used to mark C04 production admission complete.

## Verification

| Check | Result |
| --- | --- |
| `npm exec -- tsx --test packages/proxy/src/services/authenticated-chat-budget-proof.test.ts` | 5/5 pass. Includes a two-send failover across paid routes with a three-permit hold, authenticated key mutation, route price/profile/model mutation, post-dispatch settlement mutation, and unpriced-route rejection. |
| `npm exec -- tsx --test --test-name-pattern="opt-in authenticated Chat budget proof" packages/proxy/src/routes/v1/request-dispatch-limit.test.ts` | 2/2 pass. Real HTTP Chat pipeline rejects one-hop affordable/three-hop unaffordable capacity with 402 and zero upstream `fetch`; a separate positive opt-in case exercises two HTTP failover attempts. |
| `npm run typecheck -w @octafuse/proxy` | Pass. |
| `git diff --check` for edited tracked source | Pass. |

The first test uses repository stubs; the second uses a D1 synthetic storage fixture. Neither proves PostgreSQL LOGIN isolation, real provider invoice coverage, or production deployment. The aggregate assumes each network dispatch permit can produce at most one billable provider attempt and no hidden driver or provider retry creates another charge outside the shared three-permit budget. The existing request usage ledger still settles the selected terminal result; this proof does not create separate buyer charges or provider invoice facts for earlier failed attempts. That assumption and all non-Chat surfaces need separate verification before activation.
