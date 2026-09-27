# C04 v340: PostgreSQL buyer transaction and typed economic producer

Status: **review-only, production default off**. Formal migration heads remain PostgreSQL 73 / D1 68 / MySQL 64. The companion proposal is not in the formal migration directory and has not been deployed.

## Change

- `shared-key-economic-outbox-producer.sql` adds a private xid8 buyer-log transaction marker and a narrow `SECURITY DEFINER` function. The runtime LOGIN receives schema `USAGE` and function `EXECUTE`; it receives no private event, outcome or marker table privilege. `create` requires a marker from the current buyer-log transaction. `verify` compares immutable event and every outcome on replay and writes nothing.
- Installation pins seven reviewed quote-attempt/outbox guard function bodies and properties, and eleven exact trigger bindings. This includes both directions of the legacy earning/event exclusion, deferred event coverage, and append-only quote, event and outcome facts. The activation transaction takes `pg_proc` tuple locks with unchanged `ALTER FUNCTION ... COST 100` statements before checking bodies; the native two-session probe verifies a concurrent function replacement times out on PostgreSQL 18.6.
- The existing PostgreSQL critical writer accepts an optional `economicOutbox` value with explicit buyer basis and per-attempt quote reference, usage certainty, provider cost certainty and evidence. It inserts the buyer log, calls the producer, updates buyer budget and writes existing audit/statistics in one Drizzle transaction. It does not infer usage or a physical send from pre-send quote admission.
- D1 and MySQL reject the optional input before touching their clients. The default call path is unchanged. No production caller supplies the option yet.

The v339 event schema copies `api_key_request_logs.budget_charged_micros`, which the current writer derives from the ordinary charge for Guardrail accounting. An ordinary-user **reserved ceiling** may differ from that value. Both TypeScript and the SQL producer reject every reserved-basis economic event, including a coincidentally equal amount. SQL also rejects an `expired` ordinary-user reservation passed off as `actual`. This path stays open until the event schema stores the true ordinary buyer debit separately.

## Local verification

- Native PostgreSQL 18.6: `npx tsx --test scripts/db/cutover/postgres-shared-key-economic-outbox-producer.native.test.mjs` with `GATEWAY_NATIVE_PG_BIN` set to the owned local binaries: **1/1 test, 20/20 stages PASS, owned-cluster cleanup PASS**. The [machine report](C04-shared-key-economic-producer-v340-results.json) records exact stage names and proposal hashes. Both unreserved actual charge and an actual ordinary-user reservation settlement commit and replay once.
- `npx tsx --test packages/core/src/storage/shared-key-economic-unsupported-backends.test.mjs`: **1/1 PASS** (D1 and MySQL no client access).
- `npm run typecheck:dispatch-safety -w @octafuse/proxy`: **PASS**.
- `git diff --check` on edited tracked Core files: **PASS**.

The local CI workflow now registers the native producer fixture and D1/MySQL rejection test; its YAML parses, but Linux CI has not run.

Native negatives include wrong/missing activation, exact-ledger middle-version drift, third-role default grants, disabled legacy double-pay trigger, rebound event-insert trigger, no-op quote-attempt immutability function, disabled outcome immutability trigger, runtime direct private table access, reserved/none buyer basis, post-commit create, conflicting replay, wrong quote, missing event, invalid mode/JSON shape/oversized JSON, stale isolation and direct SQL `expired` reservation masquerading as actual. Every dependency-drift activation rolls back without leaving a marker table or producer function. A producer error rolls back the buyer log and budget change. The successful case uses the actual PostgreSQL critical-writer API under the runtime LOGIN.

## Source pins and limits

SHA-256: companion SQL `ea9ccc7138cbd641d386e14d1bb95b8cabee942501a49d6b0763e8e1b3eb0920`; native fixture `ccaa36f723115cdf92035ccb180f727edee8f34e7d09ed5a9f955ac95c9082f6`; PostgreSQL critical writer `ab087197929da3cd20f9f7da8722442c0a3d36ca20ba43a61b1b47f8e1059f7c`; typed input `8bf79450edee1bc8eb13db855f7705ccfa152b4508c5df65e33fd17bb088ee35`; shared dispatcher `cbcb3eebc1e7a7372b0d3134bcf8af55ede657ee17a40475e2e6cd1501837a54`. The machine report pins all prerequisite proposal and formal-migration corpus hashes.

This fixture does not prove a `recordUsage` caller, Workers/Hyperdrive transaction identity, a consumer, withdrawal policy, seller credit, unknown-send recovery, or production deployment. C04.3 and downstream gates remain open.
The definer derives buyer amounts from the immutable request log; it does not independently prove an ordinary-user balance debit against arbitrary SQL executed by a compromised runtime LOGIN. The current critical writer remains the trusted application entry point for that debit.
The guard attestation and function tuple locks cover the installation transaction on native PostgreSQL 18.6; they do not prevent a later authorized migrator change after commit.
