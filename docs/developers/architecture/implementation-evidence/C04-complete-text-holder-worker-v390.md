# C04 v390: independent private complete-text holder Worker

## Scope

This is a default-off, review-only private Worker entry. It composes the existing complete-text authority chain without importing the public Worker entry, public Chat route, or public storage runtime. It has not been deployed, and production Chat does not call it.

The dedicated configuration disables `workers_dev`, preview URLs and routes, has no cron trigger, and supplies four placeholder Hyperdrive bindings plus the holder-only provider KEK. Activation requires the exact `reviewed-v1` value; the checked-in value is `disabled`. The intended ingress is an HTTP Service Binding to a separately configured Worker, consistent with the [Cloudflare Service Binding API](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/). This local proof does not execute the Cloudflare Service Binding transport.

## Composition and request boundary

`packages/proxy/src/runtime/complete-text-holder-worker-v390.ts` accepts only `POST https://holder.service.invalid/complete-text-attempt`, exact JSON content type and the six v363 fields. It bounds the UTF-8 envelope and final body, rejects extra fields, and supplies no request-controlled provider URL, role or secret. Every fetch request constructs a fresh v384 observed holder and its one-use v365 holder.

The binding roles are:

| Binding | Origin LOGIN | Responsibility |
| --- | --- | --- |
| `COMPLETE_TEXT_READER` | `cinatoken_gateway_complete_text_private_reader` | v366 quote, route and ciphertext reads |
| `COMPLETE_TEXT_GRANTER` | `cinatoken_gateway_complete_text_attempt_granter` | v362 grant |
| `COMPLETE_TEXT_HOLDER` | `cinatoken_gateway_complete_text_send_holder` | v365 custody/start and v367 fetch-invoked fact |
| `COMPLETE_TEXT_RENEWER` | `cinatoken_gateway_complete_text_hold_renewer` | v369 all-hold renewal |

All four use the shared v390 dedicated-role transport adapter. Hyperdrive credentials may differ from origin database credentials ([official PostgreSQL example](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)). The adapter gives legacy client validation an in-memory role alias, then opens the original binding connection string without rewriting its wire username. Existing SQL checks still require the actual `current_user` and `session_user` to be the dedicated origin LOGIN. The alias is not evidence of that identity. This fixture uses direct local role URLs and does not verify a Cloudflare Hyperdrive origin session.

The exported entry uses actual `fetch` and default database clients. A code-only factory permits local tests to replace only the network transport and shorten bounds; there are no quote/grant/custody/start/fact/renewal business-port overrides.

## Lifetime and response boundary

The entry owns a 300-second deadline starting at **private ingress**, together with the incoming request abort signal. This cannot account for public Gateway preprocessing time. It checks liveness between operations, awaits real SQL transaction/connection cleanup promises, and never races a financial write against a timeout and proceeds as though it had stopped.

The deadline remains active through response consumption. EOF, error and cancellation finish the owner, release reader locks, stop renewal timers and track actual cancellation completion through `waitUntil`. A rejected cleanup promise emits only the fixed `private_holder_cleanup_unconfirmed` event; it is not converted to confirmed cleanup. The local fixture observes owned HTTP response close and drains captured completion promises. It does not prove remote Binding cancellation propagation or Worker survival beyond the platform's lifetime limits.

Only status 200 with a body and JSON or SSE content type is handed over. The outgoing header allowlist contains canonical content type and `Cache-Control: no-store`; provider cookies and private headers are removed. Rejected or undelivered bodies are cancelled. Body bytes remain raw: there is no response schema parser, public model/id normalization, usage extraction or `ProxyResult` conversion.

The default v365 lease guard is 14 minutes; the entry's five-minute limit normally ends before the initial renewal timer. Native tests shorten the local guard to three seconds to exercise real v369 renewal. Only an acknowledged renewal can extend stream authority. A committed renewal whose response is lost remains financially unknown and causes the stream to stop.

## Cancellation defect found and fixed

The real HTTP native case found that v365's renewable response wrapper aborted the fetch signal before calling `reader.cancel()`. The source had already become errored, so direct response cancellation rejected with `AbortError`. The narrow fix marks the response terminal before cancelling, checks terminal state after an outstanding read, awaits the actual source cancellation, then releases the reader and aborts the lease guard. EOF/error release their reader once. Grant, custody, send-start and renewal receipt validation are unchanged.

The new regression tests both immediate body cancellation and cancellation while a read is pending, verifies real HTTP close, and verifies no later renewal or extra POST. Earlier v365-related evidence reports retain their original execution hashes; v390 pins the repaired source and its regression test.

## Validation

Validation results and frozen native source pins are recorded in `C04-complete-text-holder-worker-v390-report.json`.

- v390 Node/config/bundle contract: **8/8 PASS**, including an actual oversized streamed envelope whose source is cancelled exactly once.
- v365 lifecycle regression: **14/14 PASS**; combined targeted run **22/22 PASS**.
- PostgreSQL 18.6 native fixture: **1/1 PASS**, **22/22 stages**, cleanup **PASS**, **10** owned physical POSTs. The final run emitted no cleanup-unconfirmed event.
- Wrangler **4.127.1** generated `complete-text-holder-v390-env.d.ts`; `wrangler types --check` passes.
- Local `wrangler deploy --dry-run` passes: **251.40 KiB**, gzip **55.28 KiB**. This is bundle validation, not deployed or workerd execution.
- The local Workers types are **5.20260829.1**. Current published types **5.20260925.2** were inspected from the official npm tarball without replacing installed dependencies. Its published SHA-1 is `5f8e1e49844039dc7b1627969dcedf4b6f793be5`.

The generated binding types and request-owned resource pattern follow [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/). The isolated configuration contains no real Hyperdrive IDs. No deployment or paid provider call was performed.

The report pins 45 source files and the aggregate of all 73 formal migrations. The fixture hashes itself before execution and asserts the same hash before declaring success. Principal SHA-256 pins are:

| Artifact | SHA-256 |
| --- | --- |
| Native fixture | `3a13542df568c4c801ea657d21475dcd1ed39abfb86ec9a8f1a218760bb3e624` |
| Worker entry | `bf6640f799bf9a3302132b5b7c54fd2f3f4dca34bfbe31dbe0bd7c96a13ff110` |
| Repaired v365 holder | `ed6c6d7c509712998a958cf78b658fd41ba3eb24eea446fb8b45740d560fd4db` |
| Native report | `7a067c995d476f821db205797db953598c04228f5d977d292215f860cbad5ec6` |

## Native proof and limits

The new native fixture installs the existing reviewed proposals over 73 formal migrations in one owned PostgreSQL 18.6 cluster. v385 uses its default v360/v361 quote and admission clients, then an in-process Binding stand-in invokes the actual v390 fetch handler with real dedicated database clients.

The physical POST is directed to an owned HTTP loopback server by a code-only transport override. It rewrites the prepared `https://v367-local.invalid/v1/chat/completions` URL, retaining upload bytes and authorization. Thus body/authentication and database grant/start/fact identities are observed, while actual transmission to the quoted HTTPS URL is not proved. `FinalChatQuoteInput` is created from owned fixture transformations; production preset and Guardrail middleware are not executed.

The fixture checks one exact POST, fresh per-request holder state, a retained-envelope replay with zero added POST, JSON completion, SSE EOF/error/cancel/caller abort/deadline, rejected response cleanup, actual all-hold renewal, and loss of the real renewal COMMIT response. The proxy forwards the original COMMIT, observes backend `CommandComplete(COMMIT)`, suppresses that response and closes the client socket. No synthetic callback substitutes for this SQL failure.

With the final adapter's `prepare: false` setting, the renewal-loss run observed exactly **one connection, one executed COMMIT (extended protocol), one backend COMMIT completion and one dropped response**; one renewal was durably committed. Stream authority stopped without that client acknowledgement, and the owned response closed while captured completion promises drained.

Across outcomes, sent grants remain `unknown` and all four holds remain dispatched. Only `fetch_invoked` is appended. There are no provider usage/bill records, financial logs, zero-charge evidence, buyer settlement or terminal closer. `fetch_invoked` does not prove provider receipt or billing. D1/MySQL parity, Linux CI, deployed Worker operation and Hyperdrive origin identity remain outside this local proof.

## Reproduction

From the repository root, with the owned PostgreSQL binary directory supplied:

```powershell
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-complete-text-holder-worker-v390.native.test.mjs
node --import tsx --test packages/proxy/src/services/private-complete-text-holder-v365.test.ts packages/proxy/src/runtime/complete-text-holder-worker-v390.test.mjs
```

From `packages/proxy`:

```powershell
npx wrangler types src/runtime/complete-text-holder-v390-env.d.ts --config wrangler.complete-text-holder-v390.jsonc --env-interface CompleteTextHolderV390Env --include-runtime false --strict-vars false --check
npx wrangler deploy --dry-run --config wrangler.complete-text-holder-v390.jsonc --outdir ../../.wrangler/staging/complete-text-holder-v390-bundle
```
