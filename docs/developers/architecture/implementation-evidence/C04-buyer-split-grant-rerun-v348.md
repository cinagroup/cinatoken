# C04 / C03.5 v348: buyer split grant rerun boundary

Status: **review only; production default off**. This candidate gives the v346 buyer critical writer split and v347 economic producer LOGIN handoff a durable grant-mode switch. It changes the local [legacy grant runner](../../../../scripts/db/cutover/grant-postgres-runtime.ts) only by adding a fail-closed marker check after the existing advisory lock and before any broad `GRANT`. It adds an [atomic activation runner](../../../../scripts/db/cutover/activate-postgres-buyer-split-v348.ts), [migrator-owned marker SQL](../../../../packages/core/migrations-proposals/postgres/buyer-split-grant-marker-v348.sql), and a separate [split-mode grant runner](../../../../scripts/db/cutover/grant-postgres-buyer-split-v348.ts) backed by the [split grant SQL](../../../../packages/core/migrations-proposals/postgres/buyer-split-runtime-grant-v348.sql). None is a formal migration or a production rollout. Formal heads remain PostgreSQL 73 / D1 68 / MySQL 64.

## Cutover contract

1. Ship and verify the legacy runner's marker guard **before** applying any split ACL. In legacy mode the marker is absent, so the current grant routine and old critical writer retain their existing behavior.
2. After the v340–v344 economic prerequisites and distinct buyer LOGIN exist, stop or migrate old writer traffic. The activation runner executes v346 revokes, v347 v2 producer handoff, and creation of `cinatoken_gateway.buyer_split_grant_policy_v348()` in **one direct-migrator transaction**. All three SQL files use advisory lock `746923553`; transaction rollback removes both the split and marker. The marker is a pinned, migrator-owned SQL function with a constant body. Ordinary runtime has no schema `CREATE` or marker `EXECUTE` right.
3. Once the marker commits, the old runner acquires the same lock, sees the marker, and fails before its broad grant SQL. The split runner reasserts only the approved buyer table/column grants and private v2 producer `EXECUTE`. It grants no new ordinary-runtime table writes. Its preflight rejects unexpected runtime financial table or column rights, buyer policy/seller rights, role membership, private outbox table/function ACL, producer body, marker body, and ownership/RLS drift. A missing reviewed buyer column grant can be restored.
4. Keep the marker on rollback until a separately reviewed old-mode reversal has stopped new buyer traffic, handled v1/v2 callers and receipts, and removed the split. Dropping the marker alone would let the broad legacy grant run again.

The guard checks marker **existence**, even if its body is malformed, so a damaged marker also blocks the old runner. The split reconciler checks the exact marker and v347 producer catalog properties before granting. This protects local grant reruns against reopening direct buyer spend or seller account writes; it does not prove that a separately deployed older binary or another privileged grant path has been retired.

## Owned PostgreSQL evidence

The [native fixture](../../../../scripts/db/cutover/postgres-buyer-split-grant-rerun-v348.native.test.mjs) passed **1/1 test, 14/14 stages, cleanup PASS** on a fresh owned loopback PostgreSQL 18.6 cluster. The [machine report](./C04-buyer-split-grant-rerun-v348-results.json) pins the PG73 corpus, proposal chain, old/new runners, activation runner, critical writer and fixture SHA-256 values. In particular, the marker SQL is `265837061d960b55b3b721990b88a922340a79e1d51946b59df4007c0483c475`, split grant SQL is `f875f81cc3577efd649ca9ecc41afe49f374ac2bf08e0646ee6d5f3e98939242`, and the guarded legacy runner is `9725d93d94beaf85fd144017f87760efdfe4f18099fbcde4ad9bbad5dc848081`.

The fixture ran the **real** legacy grant twice before activation and a real PG73 critical writer charge through that runtime LOGIN. It then proved a partial activation rolls back, activated v346/v347/marker through the new runner in one transaction, called the **real** legacy grant and observed rejection with closed ACLs, ran the split grant runner twice, and observed the old critical writer roll back while the buyer LOGIN writer committed. Transactional negative probes rejected table-level runtime finance write, column-only seller balance write, buyer budget policy column write, third-party private producer `EXECUTE`, and altered marker source. A missing approved buyer spend column grant was restored. The PostgreSQL migration contract verifier passed, and `git diff --check` passed for the touched grant runner.

Run locally with the owned PostgreSQL binary directory:

```powershell
$env:GATEWAY_NATIVE_PG_BIN = 'C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-buyer-split-grant-rerun-v348.native.test.mjs
```

## Remaining release gates

The v346 ACL still breaks existing management, admission, payout, and reservation writers using the ordinary runtime role. They need separate reviewed identities or routes and their own grants before any production cutover. The buyer LOGIN can directly update the buyer columns granted to it, so the credential remains a trusted financial capability that requires separate Worker/Hyperdrive binding and secret isolation. The v347 handoff disables ordinary runtime v1 producer calls; existing callers need a migration gate. C03 recovery has its own NOLOGIN authority and was not exercised here. Production binary rollout order, old-version host retirement, lock window, connection budget, live rollback, D1/MySQL, and Linux CI remain unverified. This local evidence does not authorize production SQL or a shared-key earning release.
