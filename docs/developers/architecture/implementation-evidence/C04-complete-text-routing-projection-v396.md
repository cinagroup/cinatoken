# C04 v396: committed credential-free routing projection

This review-only successor provides the full configured route set for every model in a committed v360 flat-text quote. It resolves the v393 counterexample by preserving actual exact surface, wildcard surface and legacy model/group eligibility. A quoted manifest remains a conservative authority superset; its first member is not a selection rule.

- [SQL proposal](../../../../packages/core/migrations-proposals/postgres/complete-text-routing-projection-v396.sql)
- [Direct projector client](../../../../packages/proxy/src/services/postgres-complete-text-routing-projection-v396.ts)
- [Trusted verifier publisher](../../../../scripts/db/cutover/attest-complete-text-routing-v396.ts)
- [Native fixture](../../../../scripts/db/cutover/postgres-complete-text-routing-projection-v396.native.test.mjs)
- [Actual repository oracle scenarios](../../../../scripts/db/cutover/exercise-complete-text-routing-v396.mjs)
- [Native report](C04-complete-text-routing-projection-v396-report.json)

## Authority and data

The existing `cinatoken_gateway_route_source_verifier` is the trusted maintenance identity. Its bounded helper reads a coherent source and policy snapshot, calls the actual endpoint parser, operation/adapter/provider checks, legacy metadata comparison and route subject fingerprint implementation, and publishes safe facts. It also calls the existing model policy, pool tier and sticky configuration parsers. It preserves valid additional image/audio capability evidence on an otherwise callable Chat endpoint.

The helper uses a narrow definer to acquire table SHARE locks without receiving UPDATE privileges. New v396 source reads, fact publication and projection use `LOCK ... NOWAIT` and a shared policy advisory try-lock. A competing writer causes a conservative `55P03` rejection. This avoids waiting after partial source locks while a writer needs those relations. Facts bind the current epoch, each route generation, v359 attested source hash, endpoint identity and verified expiry. They expire within 60 seconds. Global strategy uses the current database configuration; it does not inherit the legacy process's 30-second global strategy cache.

The distinct `cinatoken_gateway_complete_text_routing_projector` LOGIN executes one projection wrapper. It cannot read providers, ciphertext, URLs, endpoint rows, raw route policy or safe fact tables, and cannot publish facts or invoke the internal freshness waiver. The direct client validates exact field sets, route/source identities, every ordered model, bounded numeric facts, canonical strategies and timestamps. It snapshots caller input before awaiting and returns a deeply frozen DTO only after COMMIT and close acknowledge.

Each candidate contains its selected surface/pool, normalized sticky configuration, canonical base strategy and per-priority overrides. Each safe route contains target/provider/pool identity, priority/weight, source binding, endpoint class/output capacity, comparable price score, default endpoint eligibility and beneficial cache-read pricing. Private model names, endpoint slugs, evidence URLs, raw policy and secrets are absent. Fractional positive weights remain supported by the DTO.

The projection and its member rows are immutable and tied to quote/request/final body hash. Repeated reads recover the same committed projection. A changed epoch cannot refresh an already bound quote into a different routing policy.

## Freshness through send start

BEFORE STATEMENT triggers on models, model surfaces, global configuration, route rows, providers, pools, endpoints and endpoint links obtain the exclusive policy advisory lock and advance the epoch. No-op updates and ABA changes invalidate prior facts/projections. Existing v359 source generations remain a separate fence.

BEFORE INSERT checks on attempt grants, custody and send starts use a shared epoch try-lock and verify quote identity, membership and current source binding. A busy policy writer fails closed with `55P03`; it cannot make the new fence wait while the existing send wrapper holds relation SHARE locks. Existing v365 relation locking retains its original timeout and PostgreSQL rules; this does not establish absence of every possible database deadlock. The grant fence independently requires a default endpoint with adequate capacity for the trusted `requestedOutputTokens` persisted in the v360 source snapshot. Every candidate must retain at least one such eligible member. Requested output zero records no positive capacity requirement; request shape validation remains the Gateway preparer's responsibility.

The shared lock is retained through each SQL transaction's COMMIT. Configuration can still change after send-start COMMIT and before the physical POST. This artifact does not claim to close that interval. Unknown grants and all financial holds remain governed by their existing result/recovery contracts.

The internal four-argument freshness helper permits an expired projection only for a trusted wrapper that first proves a completed response or committed invocation. Epoch, candidate and source checks still apply. It is not executable by any application LOGIN. v398 uses that interface for post-response sticky writes; ordinary reads use the strict unexpired form.

## Verification and remaining scope

The complete owned PostgreSQL 18.6 run passed **106 stages**, with cleanup **PASS**, **87 source/proposal pins** unchanged, and an unchanged **327-file actual core source aggregate**. It executed 9 owned loopback POSTs; the new routing, preparation, sticky and rejection cases added none. The [joint unit report](C04-credential-free-route-attempts-sticky-v398-unit-report.json) records **64/64 PASS**. These results accept the reviewed v392 → v396 → v398 component branch described here.

The direct-client suite has 5 cases covering exact safe fields, numbers/source identity, caller mutation, real role/isolation checks, and missing COMMIT/close acknowledgements. The native report is authoritative for its final run status, stage count, source hashes and cleanup.

The native fixture installs PG73 plus reviewed proposals in an owned PostgreSQL 18.6 cluster. It passed dependency rejection cases for source RLS, forced RLS, rewrite rules, extra source triggers and altered function/ACL contracts. Existing v394 response cases exercise actual dedicated LOGINs and owned loopback POSTs after v396 projection. Additional scenarios compare the actual repositories, full Chat planner and v398 preparer for two models, four canonical strategies, tier overrides, exact/wildcard/legacy selection, capacity/default endpoint filtering, price ordering, circuit Retry-After and real sticky hits. Real private-kernel cases verified policy drift rejection at grant/custody/start and SQL rejection of insufficient capacity, non-default endpoints or a second empty candidate without an added POST. A deterministic two-transaction source SHARE/exclusive policy writer case verified `55P03`, zero POST and subsequent writer COMMIT. A physical PostgreSQL protocol proxy verified projection COMMIT response loss and recovery of its durable row. Sticky cases verified real observation proof, CAS, database-derived TTL, cache-read proof rejection, physical COMMIT acknowledgement loss, and post-response bind/touch/clear after the original projection actually expired; an independent fresh quote read recovered the committed binding.

The successful response fixture retains its older v385 request-local plan construction; the separate multi-model oracle uses actual repository results. This is component evidence for the secretless successor, not a claim that the public Chat handler already uses it. Native Worker execution is in Node and rewrites the quoted HTTPS fixture URL to owned HTTP loopback. Cloudflare Service Binding/Hyperdrive behavior, complete public Gateway cutover, supplier billing, buyer settlement, terminal closure and combined no-fetch closer coexistence remain unproved. Formal migrations and remote databases are unchanged.
