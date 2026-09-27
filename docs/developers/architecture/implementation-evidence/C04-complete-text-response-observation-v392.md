# C04 v392 — complete response observation

## Status and scope

Review-only PostgreSQL proposal and bounded response observer, consumed by the separate [v394 private Worker](../../../../packages/proxy/src/runtime/complete-text-response-holder-worker-v394.ts). Default deployment remains disabled. This step records a complete upstream response observation; it does not settle a buyer, assert a supplier bill, release reserves, or create a monetary terminal.

Installation is a specific reviewed branch: PG73 and the existing v360/v361/v362/v365/v366/v367 prerequisites, followed by **v370 renewed holder facts, then v392**. Its exact dependency trigger inventory expects the baseline before v388/v389 add terminal and recovery triggers. The native fixture does **not** establish a combined v388/v389/v392 installation or cutover. No frozen historical SQL is changed.

## Implemented path

1. v365 commits the physical send start. v384 invokes exactly one fetch and commits its `fetch_invoked` fact.
2. [The v392 holder](../../../../packages/proxy/src/services/private-complete-text-response-holder-v392.ts) wraps that same response reader. The start identity remains the immutable initial epoch 1, including after a valid hold renewal.
3. [The observer](../../../../packages/proxy/src/services/complete-text-response-observation-v392.ts) accepts complete bounded OpenAI chat JSON, or one-choice SSE ending in exactly one final usage-only event, `[DONE]`, and EOF. Invalid UTF-8, duplicate decoded JSON keys, inconsistent IDs/models, conflicting explicitly reported service tiers, repeated usage, truncated streams and cancellation before complete upstream EOF never produce a complete observation.
4. [The holder SQL client](../../../../packages/proxy/src/services/postgres-complete-text-response-observation-v392.ts) supplies no amount. It checks the real session/current LOGIN, sets 2-second lock and 15-second statement bounds, validates the exact receipt inside the transaction, and returns only after COMMIT and connection close acknowledge.
5. [The new SQL](../../../../packages/core/migrations-proposals/postgres/complete-text-response-observation-v392.sql) atomically appends the v366 `provider_usage` fact and immutable v392 observation, using the same request advisory lock. A deferred COMMIT failure rolls back both.

`append_complete_text_response_observation_v392(grant,run,start,epoch,nonce,observation)` is executable only by the existing isolated holder LOGIN. PostgreSQL independently derives the nonce from the immutable grant/run/start identity and derives the v366 usage JSON and its digest. One observation per grant, immutable rows, exact replay digest and identity checks prevent a replay from choosing another response. A preexisting generic usage fact without its v392 companion cannot be adopted as a complete response observation.

`read_complete_text_response_observation_v392(grant)` is executable only by the new dedicated `cinatoken_gateway_complete_text_response_observer` LOGIN. It reads the observation and linked fact and verifies the immutable grant, send start and custody identity. It returns `supplierCostStatus: not_asserted`. It has no raw table, credential, funding or write access. After an uncertain append ACK, this independent reader can confirm the durable record; same-nonce append may replay it. Neither action authorizes another POST.

## Evidence and delivery boundaries

The persisted record contains full response SHA-256, byte count, JSON/SSE format, explicit completed end marker, completion body ID, optional `x-request-id`, reported model, optional reported service tier, totals and nullable standard usage detail counters. The SHA covers **fetch-readable bytes after HTTP decoding**; it is not a signature or a hash of TLS/compressed wire bytes. Prompt/output content and full raw response text are not stored. PostgreSQL trusts the isolated holder to report what it read; database ACLs do not independently authenticate a supplier response.

Prompt cache read/write, audio, image and text counters and completion reasoning, prediction, audio and text counters remain separate. Absent details remain null rather than invented zeros. The compatible `cache_creation_tokens` alias must agree with `cache_write_tokens` when both occur. Unknown usage detail fields reject completion instead of disappearing silently. No cached or reasoning units are added to totals or converted to money.

Selected counters and choice indexes require unsigned ordinary integer JSON literals. Exponents, fractions and `-0` are rejected even when their mathematical value is integral. This preserves the original numeric meaning before JavaScript rounding or underflow can invent an integer fact. Unselected metadata, including decimal log probabilities, remains valid and is delivered as its original bytes.

The parser follows the documented [Chat Completions usage shape and final streaming usage event](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). Optional service tier omissions preserve earlier reported values; two explicit different values conflict. This is an OpenAI chat protocol subset for the already restricted flat-text request path, not a generic multi-provider usage parser.

| Bound | Limit |
|---|---:|
| JSON body | 1 MiB, one fixed byte buffer |
| SSE total body | 16 MiB |
| SSE event / retained terminal tail | 64 KiB each |
| SSE data events | 16,384 |
| JSON depth / nodes per JSON object or SSE event | 32 / 16,384 |

The observer never tees or refetches. SSE normal events retain their exact bytes and ordering. The complete `[DONE]` event and following bounded tail are held until EOF, observation COMMIT and connection close confirm. A client that cancels as soon as it receives `[DONE]` therefore sees an already durable observation. JSON similarly holds all bounded raw bytes until the same ACK boundary. The source reader is cancelled or released on all terminal paths. The actual v394 Worker retains in-flight SQL in its resource owner and `waitUntil`, including cancellation during an append. An upstream complete observation is not proof that downstream delivery finished.

If cancellation arrives after complete upstream EOF while the append is in flight, the database may still commit a durable observation. Cancellation stops delivery; it cannot undo an already started database write. The Worker continues tracking that SQL operation through cleanup.

## Verification

- Focused observer and direct-client tests: **14/14 PASS**. Includes tiny byte chunks, standard nullable usage details, optional service tier, JSON zero-byte delivery before ACK, `[DONE]` cancellation, ACK failure, exact receipt and role rejection, and no retry.
- Native evidence: **31/31 PASS, cleanup PASS**, PostgreSQL **18.6** — [report](C04-complete-text-response-observation-v392-report.json), [fixture](../../../../scripts/db/cutover/postgres-complete-text-response-observation-v392.native.test.mjs). The final run verifies unchanged runtime and proposal source pins. It covers the actual v394 Worker, local HTTP and dedicated PostgreSQL LOGINs, nine preflight drift rejections, whole-transaction rollback at failed COMMIT, and a real suppressed PostgreSQL COMMIT response.
- Proxy typecheck passed locally. Root's combined entry/dispatch/observer/client suite passed **50/50**; the final v394 Wrangler dry run produced **275.17 KiB / 60.43 KiB gzip**. This was a local bundle build, not deployment or Hyperdrive validation. Root owns CI registration.

## Remaining requirements for a sent-request closer

The complete response observation closes the durable holder-evidence gap. It does **not** close C04 financial settlement:

- A platform pricing decision must select this typed observation, correlate the frozen quote/model/route and response service tier, define cache/reasoning/prediction units and rounding, bound the debit by authorized reserves, and address contradictory or late observations. The v366 generic `provider_usage` record alone lacks this contract.
- A sent terminal needs an atomic financial writer, all four exact holds, buyer request log, typed economic outbox, replay identity, immutable/deferred companion verification and an independent historical reader. v388 only closes proven no-fetch and cannot accept a sent response.
- Supplier cost needs a separate authenticated supplier billing or contract source and event correlation. This holder observation cannot substitute for that source, including when reported tokens are zero.
- A durable response spool/recovery policy is still needed when the process dies before observation COMMIT. A hash of bytes that were never persisted cannot reconstruct them. Already committed observations are recoverable without another fetch; missing observations retain the prior possible-send state and reserves.
- Combined installation with no-fetch recovery, production role provision, deployment, real Service Binding/Hyperdrive behavior and other database backends remain unproved.
