# C04 v391: actual authentication and secretless quote manifest client

## Implemented component

`postgres-complete-text-secretless-plan-v391.ts` supplies a direct PostgreSQL client for the existing reviewed `plan_complete_flat_text_quote_v365(text,uuid)` function. It accepts an already committed v360 quote and the actual `FinalChatQuoteSnapshot`, reads as `cinatoken_gateway_complete_text_ingress_planner`, and returns a frozen projection containing request/quote/body/model identities, expiry and the full quoted route manifest.

It validates exact result fields, every model candidate, route uniqueness and coverage, source generation, source attestation hash, quote expiry and identity. It requires the real PostgreSQL `current_user` and `session_user` to equal the dedicated planner LOGIN at read committed isolation. Transaction-local lock and statement timeouts are installed before the function query. No result escapes before the real transaction and connection close acknowledgements. The incoming abort signal is captured once; cancellation waits for the in-flight query and actual cleanup rather than racing their promises.

`selectCompleteTextPlanRouteV391` accepts an explicit candidate index and route target ID, checks membership, and returns only the three identifier fields used by v363. It supplies no default ordering, priority or weighted selection and does not fabricate a credential-bearing `RouteResult`.

## Placement in the real Chat transition

The existing SQL requires a committed v360 quote, so its position is **final body snapshot → v360 quote → v391 manifest read → authorized selection → v361 admission → v363 envelope → private holder**. It cannot replace pre-quote planning by returning unissued quote data.

The root task introduced `FinalChatQuoteSnapshot` and `createFinalChatQuoteSnapshot` to capture the final body/model identities without inventing a legacy fallback plan. The original plan-bound `FinalChatQuoteInput` remains available for legacy callers. The v360 quote and v363 envelope clients accept the smaller snapshot while retaining their runtime body/hash/identity validation. This native fixture uses that path and does not create a fake `RouteResult` or fixture authentication identity.

The SQL manifest is a safe superset of current own-model routes. It is **not** the existing Chat surface/pool selection, priority, weights, routing strategy, sticky behavior or provider-preference policy. The native fixture explicitly selects its known single route ID. A complete public Chat switch still needs the separate routing projection and mutual exclusion with legacy owners/dispatch.

## Actual authentication and permission findings

The native fixture calls the existing `authenticateApiKey` with real PostgreSQL repositories and a real bearer. The returned key, user, personal workspace and budget epoch are passed to the actual capability/quote client. A nonexistent bearer returns null. The planner wrapper independently rechecks the committed capability, active hashed key, current user/workspace, epochs and route sources.

Two existing authentication write branches were executed against the actual runtime grants:

| Branch | Observed result |
| --- | --- |
| Legacy plaintext inference key lookup | The existing repository committed its `hashref:` / `key_hash` migration. Authentication therefore performs a write in this case. |
| Overdue user budget period | Existing lazy-reset code failed with PostgreSQL `42501` after the buyer split. The budget epoch remained 0 and spent amount remained 1; the failed transaction did not authorize inference. |

The second result is a concrete integration gap for the real Chat authentication path. A read-only planner LOGIN cannot replace the legacy authentication repository, and a fixture using only accounts without an overdue reset would conceal the failure. This change does not widen runtime financial privileges or pretend that lazy reset has been integrated with a dedicated writer.

The planner LOGIN has exactly one gateway function EXECUTE privilege, no role memberships, and cannot read raw API keys/users, provider ciphertext/endpoints or the quote-source table. Runtime cannot execute the planner wrapper. The current broader runtime authentication identity is separate from that narrowly scoped planner; this proof does not establish a new fully isolated Gateway read/auth LOGIN.

`ApiKeyContext` currently exposes key/user/workspace/budget epoch but not key-limit epoch. v360 derives and validates the latter in the real capability response when no expected epoch is supplied. The native fixture uses the bearer, not its lookup hash, and does not fill the missing epoch from fixture constants.

## Transport, failures and limits

The planner, capability issuer, quote issuer and admission client all run through the shared v390 trusted-binding transport adapter. Its role alias is only an in-memory client-validation key; the driver opens the original connection string. A negative case maps a runtime connection to the planner alias and is rejected by the real server role check. Local direct PostgreSQL URLs do not prove Cloudflare Hyperdrive origin-session behavior.

Native cases cover current manifest output, revoked key, inactive personal workspace and route-source generation drift. Each negative produces zero added HTTP POSTs. A cleartext PostgreSQL proxy forwards the original planner COMMIT, observes backend `CommandComplete(COMMIT)`, suppresses the response and closes the connection. The client rejects without returning a plan. This is an actual transaction-response loss, not a synthetic callback error.

The positive path uses default v360/v361 clients and the actual v390 Worker handler in Node. The only network override rewrites the quoted fixture HTTPS URL to owned HTTP loopback while preserving request bytes and authorization. It verifies one exact POST and matching grant/start/fetch-invoked digests. It does not prove quoted-URL socket transmission, deployed Service Binding behavior or public Chat middleware execution. Preset/Guardrail transformations and Guardrail budget declarations are owned fixture data; admission SQL still validates their sources.

The sent obligation remains unknown. No provider usage/bill, financial log, zero-charge result, buyer settlement or terminal closer is created. The existing SQL proposal remains default-off; no deployment, remote database or paid provider call occurred.

## Validation

Results and frozen source pins are in `C04-complete-text-secretless-plan-v391-report.json`.

- Client tests: **7/7 PASS**, including complete multi-model coverage, malformed source fields, real-role mismatches, COMMIT/close acknowledgement failures and cancellation while SQL remains in flight.
- Native test: **1/1 PASS**, **23/23 stages**, cleanup **PASS**. One owned POST succeeds; every negative adds zero POSTs.
- Planner response-loss evidence: exactly **1 connection, 1 extended-protocol COMMIT, 1 backend COMMIT completion and 1 dropped response**.
- The native fixture checks its own SHA-256 at entry and before declaring success.
- The owned PostgreSQL cluster is version **18.6** and applies all **73** formal migrations before reviewed prerequisites.
- All **51 file pins plus the PG73 migration aggregate** match the final report.

| Artifact | SHA-256 |
| --- | --- |
| Native fixture | `849eb920a8d6b33a2f0471df4fcbbd2dc9f839ea590e65dd0b2fcac44edafbb4` |
| Planner client | `85fc52570a6cc8265ca5fd5e1051aef608e248c146856de4cd7f51dfb3261cf3` |
| Native report | `d679623f872af5f7375e6c13eae3721e3e23b7f7f57aca4c6adba2ec647a418a` |

Reproduce from the repository root:

```powershell
node --import tsx --test packages/proxy/src/services/postgres-complete-text-secretless-plan-v391.test.mjs
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-complete-text-secretless-plan-v391.native.test.mjs
```
