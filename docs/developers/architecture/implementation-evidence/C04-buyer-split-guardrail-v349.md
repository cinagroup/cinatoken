# C04 v349: buyer split grant after the Guardrail successor

Status: **review only; production default off**. The [Guardrail v348 proposal](../../../../packages/core/migrations-proposals/postgres/shared-key-guardrail-post-reservation-denial-v348.sql) replaces the v347 economic producer and two buyer validators. The [v348 split grant reconciler](../../../../packages/core/migrations-proposals/postgres/buyer-split-runtime-grant-v348.sql) correctly rejects that new producer body, leaving no reconciler for the combined state. This candidate adds a versioned [v349 marker](../../../../packages/core/migrations-proposals/postgres/buyer-split-guardrail-grant-marker-v349.sql), [v349 grant SQL](../../../../packages/core/migrations-proposals/postgres/buyer-split-guardrail-runtime-grant-v349.sql), [atomic activation runner](../../../../scripts/db/cutover/activate-postgres-buyer-guardrail-split-v349.ts), and [grant runner](../../../../scripts/db/cutover/grant-postgres-buyer-guardrail-split-v349.ts). It changes no formal migration or production binding.

## Sequence and authority

1. Install the old grant runner's marker guard, then activate the v346/v347 buyer split and v348 marker in one direct-migrator transaction. The v348 split grant can reconcile this state.
2. The v349 activation runner executes Guardrail v348 and creates the v349 marker in **one transaction** under advisory lock `746923553`. If either preflight fails, the replacement functions, proof table, triggers and new marker roll back together. The v348 marker stays in place and continues to block the legacy broad grant.
3. The v349 grant reconciler requires the exact v348 and v349 marker bodies, Guardrail successor producer and validator bodies, private proof function bodies and ACLs, receipt table ownership/ACL, four trigger bindings, PG73 head, and the existing buyer/runtime privilege split. It checks all of these before issuing any `GRANT`, then reasserts only the same buyer rights as v348. Missing reviewed buyer column rights can be restored; unexpected direct or third-party rights fail closed.

The v348 grant reconciler remains valid for its original producer state and rejects the Guardrail successor. The old broad grant rejects both states as long as the v348 marker remains. Dropping either marker or rolling back to the broad grant requires a separately reviewed transition.

## Owned PostgreSQL evidence

The [native fixture](../../../../scripts/db/cutover/postgres-buyer-split-guardrail-v349.native.test.mjs) passed **1/1 test, 24/24 stages, cleanup PASS** on a fresh owned loopback PostgreSQL 18.6 cluster. The [machine report](./C04-buyer-split-guardrail-v349-results.json) pins the PG73 corpus, every proposal in the chain, runners, critical writer, and fixture SHA-256. The final Guardrail SQL SHA-256 is `d679aecdef28a66bbc82b1e2afebface4d140ec2c7b7b38380133d64d960affb`; v349 marker is `39c8e06c5601e31e1eacc42603cb39bdec0ae3448ed2d3b57760144e290653a9`; v349 grant SQL is `7e50bf86944976a166d5ae4c2c726718fe78fe1df2489763c231cfb068170039`.

The fixture ran the real legacy grant and old writer before the split, then the v348 activation and reconciler. It proved a missing v349 activation token rolls back the Guardrail successor. After atomic Guardrail/marker activation, the real legacy grant and v348 reconciler rejected while the v349 reconciler ran twice with the ordinary runtime financial ACL closed. Transactional probes rejected private receipt table or column read, disabled Guardrail trigger, replaced proof body, and altered v349 marker body. A missing reviewed buyer spend column grant was restored.

Run locally:

```powershell
$env:GATEWAY_NATIVE_PG_BIN = 'C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-buyer-split-guardrail-v349.native.test.mjs
```

## Remaining release gates

This is a grant compatibility proof, not a role routing or Guardrail delivery proof. The buyer LOGIN still lacks `INSERT` on ordinary budget reservations, so current admission cannot use it to create the hold; a separately reviewed admission authority is needed. Management, payout and recovery writers also need their own identities and grants. No Worker/Hyperdrive credential binding, production cutover, Linux CI, live rollback, D1/MySQL behavior, or shared-key earning release was exercised.
