# C04 v366 legacy reaper fence: native proof and activation blocker

2026-09-25. The [review-only SQL successor](../../../../packages/core/migrations-proposals/postgres/complete-text-legacy-reaper-fence-v366.sql) replaces the four v353/v354 SECURITY DEFINER explicit-forfeit and expiry functions in one direct-migrator transaction. It is **not safe to activate** in a real fleet: the v349 buyer settlement role still has direct counter writes that bypass the reservation guards. No remote SQL, formal migration, deployment, production credential, or provider call was made.

## What the candidate proves

- v353 Guardrail explicit forfeit and the expiry scanner check the immutable v362 grant under `pg_advisory_xact_lock(348, hashtext(request_id))` before touching reservation rows. The scanner filters grant-linked requests before its bounded candidate `LIMIT`, rechecks after taking the advisory lock, and continues to legacy requests. It obtains its eventual `ROW EXCLUSIVE` reservation-table lock before window row locks, avoiding the table-lock/window cycle with v365's `SHARE` reservation-table lock.
- v354 ordinary explicit forfeit and expiry take the same request advisory lock before row locks. They read the candidate user, lock that user before the reservation, then recheck identity and state after row lock. This matches v362's user-before-hold order. Existing non-grant state, ceiling, epoch, and counter semantics remain in the successor.
- Insert/update/delete triggers on both reservation tables reject mutations for a request with a committed v362 grant. They also catch a pre-activation v353/v354 call that resumes after the activation table-lock barrier. v362 dispatches its new hold before inserting the grant, so a fresh v362 grant remains possible. These triggers intentionally freeze later grant-linked hold changes until a real renewal/closer replaces them **atomically**.
- The activation preflight requires the PG73 migration fingerprint, named direct `NOINHERIT` roles, SECURITY DEFINER functions with reviewed owners/configuration, private reservation writes, and absent v366 triggers. A missing activation setting, ACL drift, or deliberate transaction rollback leaves the old functions and trigger catalog unchanged.

## Native PostgreSQL 18.6 evidence

The [isolated native fixture](../../../../scripts/db/cutover/postgres-complete-text-legacy-reaper-fence-v366.native.test.mjs) installs formal PG73, reviewed buyer split, v350/v351/v353/v354, and v356/v359/v360/v361/v362/v365, then v366 in a newly owned loopback cluster. Its [machine report](./C04-complete-text-legacy-reaper-fence-v366-report.json) is **PASS, cleanup PASS, 17/17 stages**. The test uses direct LOGIN connections and verifies:

1. Forfeit before v365 send-start is denied for a granted request, after which send-start is still recorded; send-start before forfeit is likewise denied. Direct reservation mutation is rejected.
2. With expired grant-linked rows preceding a non-grant request, the Guardrail and ordinary scanners leave every grant hold dispatched and release the legacy request's three Guardrail and one ordinary holds.
3. A non-grant dispatched request can still be fully forfeited by the legacy roles. Deliberate forfeiture rollback restores the ordinary hold; terminal replay still returns success when the account row is busy; a later v362 grant for a terminalized legacy request does not record a grant.
4. Two cross-request races hold the v365 start or v353 forfeit transaction open in turn. `pg_stat_activity` observes the other direct LOGIN waiting on a PostgreSQL lock; releasing the first transaction lets both complete without a table-lock/window deadlock.

The expiry and pre-grant dispatch cases use privileged, temporary fixture fault injection; runtime roles never receive that authority. This test does not measure a large backlog or prove every possible interleaving.

SQL SHA-256: `1ff269a57bff76c3a54267a5c0ff78330335bf50bd5757ca011de04ae5ab60c0`. Fixture SHA-256: `238ea04f07db4f89fa500735ed232e08147d4bcab8a0ffddafb02e9bafbeaa76`.

## Precise activation blocker

The same native fixture queries effective ACLs and confirms `cinatoken_gateway_buyer_settlement` can update `users.budget_spent`, `users.budget_reserved_micros`, and `guardrail_budget_windows`. After two v362 grants exist, it **commits** a one-micro `budget_spent` change and a Guardrail-window `settled_micros` change through that direct LOGIN; both succeed without touching a reservation and are then restored in separate owned-cluster transactions. The v366 reservation triggers cannot detect these writes. A malicious or stale buyer writer could therefore desynchronize grant-linked financial counters despite all four reaper functions being fenced.

Revoking those direct buyer rights without replacing its legitimate non-grant settlement path would break existing traffic. Activation needs a coordinated buyer writer and counter-guard cutover, a grant-linked renewal and all-hold result closer, and replacement of the v366 freeze triggers in the same transaction. This v366 source remains local evidence for the reaper portion only; C04 acceptance stays open.
