# C04 v397 — response observation and no-fetch recovery on one database

## Status and installation branch

Review-only, default-off [proposal](../../../../packages/core/migrations-proposals/postgres/complete-text-response-no-fetch-coinstall-v397.sql). The owned PostgreSQL **18.6** [native fixture](../../../../scripts/db/cutover/postgres-complete-text-response-no-fetch-coinstall-v397.native.test.mjs) passes **54/54 stages, cleanup PASS** in the [report](C04-complete-text-response-no-fetch-coinstall-v397-report.json). This proves a specific combined local installation and runtime branch. It does not establish a deployed cutover or public Chat implementation.

After the frozen PG73, v360/v361/v362/v365/v366/v367 prerequisites, the supported order is:

1. v370 renewed holder facts.
2. v392 response observation.
3. v370 no-fetch fence.
4. v368 held writer and counter grant policy, v371 window accountant, v372 window ACL, v380 admission fence, v386 platform close fence.
5. v388 no-fetch platform close, then v389 durable recovery.
6. v397 joint catalog attestation and three insert fences.

Every historical preflight is executed unchanged. A transaction that first installs the no-fetch / terminal / recovery branch and then attempts the **first** v392 installation is rejected by the frozen v392 dependency contract; all that reverse branch's DDL is rolled back. Reinstalling v392 after the combined branch is also refused. Arbitrary installation orders remain unsupported. v397 requires the actual migrator LOGIN and `cinatoken.complete_text_coinstall_v397_activation=reviewed-v1`; omission rejects the whole transaction.

Formal migration counts remain PG **73**, D1 **68**, MySQL **64**. The proposal is not added to the formal corpus.

## Exact joint authority

The final reviewed baseline contains **20 tables, 57 existing triggers and 54 function body pins**. v397 adds three insert triggers, bringing that inventory to 60. The table set includes the private observation and recovery tables, grant/start/fact/renewal/resolution/terminal/event tables, the admission ledger, buyer log, ordinary and Guardrail holds, and the `users` and Guardrail window counters that close and renewal actually update.

The preflight checks table/schema ownership, relation type, absence of RLS and rewrite rules, raw table and column ACLs, exact function owner/body/return type/volatility/language/security configuration, and exact trigger names, target functions, enabled state, timing, events, qualifiers, columns, arguments and deferred status. The financial tables preserve their exact frozen legacy SELECT / INSERT ACLs; new writes, column grants and grant options are refused. The legacy runtime EXECUTE grants for its workspace and Guardrail-window trigger functions are pinned precisely.

Ten dedicated LOGIN contracts have no role membership, inheritance, privileged role attributes, schema creation, raw table/column/sequence access, extra executable wrapper or grant option:

| LOGIN | Allowed executable wrappers |
|---|---|
| Attempt granter | v362 grant only |
| Send holder | v365 custody and start, v366 holder fact, v392 observation append |
| Response observer | v392 independent observation read only |
| Provider bill source | v366 provider bill append only |
| Hold renewer | v367 all-hold renewal only |
| No-fetch resolver | v370 no-fetch resolution only |
| Platform closer | v388 no-fetch close only |
| Recovery worker | v389 scan, claim and fail |
| Recovery observer | v389 observe and finish |
| Recovery operator | v389 bounded manual requeue only |

The proposal also checks default function ACLs before creating its new private trigger function, revokes its PUBLIC/runtime EXECUTE, and verifies its owner, configuration, ACL and three insert trigger shapes after creation. No send, debit, supplier-bill or settlement authority is added.

## Symmetric request fences

The new trigger function derives the immutable grant's request ID, checks `NEW.request_id`, acquires the same **`pg_advisory_xact_lock(348, hashtext(request_id))`** used by the observation, resolver, renewer and closer wrappers, and rereads the grant identity under that lock.

- A holder observation insert rejects an existing no-fetch resolution or platform terminal.
- A resolver resolution insert rejects an observation or physical send start.
- A closer terminal insert rejects an observation or physical send start.
- Each target also requires its exact holder / resolver / closer session LOGIN.

These are guards on all three insert directions. They protect future or privileged insertion paths in addition to the existing wrappers' stricter invocation and identity checks. A complete response does not permit no-fetch close; a no-fetch resolution does not permit a later response observation. A failed or uncertain acknowledgement leaves the caller without a new send or financial transition right.

## Actual combined runtime evidence

The actual **v394 Worker**, v385 dispatch seam, default PostgreSQL role clients, and actual **v389 no-fetch runner** execute on the same owned database. The prepared HTTPS target is rewritten solely by the fixture's injected physical fetch to owned HTTP loopback. There are **13 physical POSTs**, all from the private holder; the recovery path has no fetch port.

The fixture covers complete JSON and SSE, independent observation read, exact raw-byte hashes and nullable usage details, same-nonce replay, conflict refusal, truncation, repeated usage, cancellation and response after a real renewal. Whole JSON bodies and SSE `[DONE]` remain gated on complete upstream EOF, observation COMMIT and connection-close acknowledgements.

The actual observation and resolver transactions execute in both commit orders. The losing LOGIN is observed waiting on the common request advisory lock; after both transactions finish the sent grant remains unknown, its four holds remain dispatched, and no no-fetch resolution or terminal appears. Actual observation and renewal transactions also execute in both commit orders, retaining physical start epoch 1 and one valid renewal. A valid no-fetch closer commits before a blocked renewer; the never-started request has no renewal authority after close.

Temporary owned-cluster privileged wrappers deliberately bypass old wrapper validation to test the new insert fences independently. One malformed cross-grant observation is committed first; the real resolver and a terminal insert are refused by the v397 constraint. After removing that forged row, a real no-fetch resolution commits first and a holder insert is refused in the reverse direction. A preexisting terminal also refuses a holder insert. The forged row and temporary executable wrappers are removed before normal recovery. These probes are negative fence evidence, not valid supplier-response observations.

The same real runner then claims **18** durable jobs, completes **5** independently verified never-started requests, and quarantines **13** sent requests. Completed no-fetch requests have one terminal/log/event set, zero buyer charge, ordinary and Guardrail holds in `settled` state with `settled_micros=0`, and `supplierCostStatus=not_asserted`. Sent requests retain their unknown obligations and holds. No response observation overlaps a resolution/terminal, no physical-start request is closed by no-fetch recovery, and no supplier bill or zero-charge supplier observation is created.

## COMMIT and source verification

- A deferred observation COMMIT failure rolls back both the response observation and its usage fact before any JSON bytes are delivered.
- A deferred no-fetch COMMIT failure rolls back the terminal, event, buyer log and all financial hold/counter changes together. The prior no-fetch resolution remains available for a fresh runner.
- An actual suppressed observation COMMIT response withholds `[DONE]`. The independent reader sees the committed observation and stable-nonce replay returns the same fact without a second POST.
- An actual suppressed resolver COMMIT response leaves exactly one durable resolution and four holds. A fresh real runner observes it and completes legal no-fetch close.

Each response-loss proxy records one connection, one extended COMMIT command, one backend `CommandComplete(COMMIT)` and one dropped acknowledgement. This is physical local PostgreSQL protocol evidence; it does not prove remote pooler or close-ACK behavior.

The final native run verifies unchanged fixture/runtime/proposal sources and the formal PG73 corpus before emitting PASS. An independent post-run recomputation matched **75 pins: 74 distinct files plus the PG73 aggregate**.

| Artifact | SHA-256 |
|---|---|
| v397 SQL | `a8ae8c1e7cecc05922b907558da34ce3ffe271a8aad79c2490a5631cf0901590` |
| v397 native fixture | `1bec73e1b1ba5590506f3747f58b125bc3b7780a369ebc9d58745027b4bde47a` |
| v397 native report | `f997536c9bb5cef5d3ad94d4a724ec123de71041614186d795a6b476121aece4` |

The fixture uses scoped administrator time shortening in its own cluster; it keeps `send_expires_at` later than `granted_at`. Production role clients do not have those raw writes. No remote SQL, deployment, Hyperdrive, actual Cloudflare Binding or paid Provider was used. There is still no durable raw-response spool, supplier signature, sent-request settlement, event delivery or complete public authentication/selection/cutover proof in this fixture. C04 acceptance remains open.
