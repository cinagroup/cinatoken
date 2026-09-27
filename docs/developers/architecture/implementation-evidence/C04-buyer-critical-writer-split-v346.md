# C04 / C03.5 v346: buyer critical writer identity probe

Status: **review only; production default off**. The [SQL policy](../../../../packages/core/migrations-proposals/postgres/buyer-critical-writer-privilege-split-v346.sql) is deliberately outside formal migrations. It was applied only to a fresh owned loopback PostgreSQL 18.6 cluster after PG73 and the current runtime grant. No deployed role, credential, Worker binding, grant routine, or production database changed.

## Tested boundary

The fixture creates an independent `cinatoken_gateway_buyer_settlement` LOGIN with `NOINHERIT` and no membership in migrator or ordinary runtime. The policy requires direct migrator activation, exact PG73 ledger, expected table ownership and no row security, and locks the affected tables under the current grant routine's advisory lock. It revokes ordinary runtime direct writes to `users`, `user_earnings`, `withdrawals`, `user_budget_reservations`, legacy `shared_key_earnings`, and `portal_ledger_entries`. It grants the buyer LOGIN only the tables and columns needed by the **non-economic PG73** `insertRequestUsageAndChargeTxPg` path. In particular, the buyer LOGIN can update `users.budget_spent`, `budget_reserved_micros`, and `updated_at`, but cannot update `budget_max`, API-key Workspace identity, or seller financial columns. Its API-key `updated_at` column grant permits the existing `SELECT FOR UPDATE` row lock without granting Workspace identity mutation.

The [native fixture](../../../../scripts/db/cutover/postgres-buyer-critical-writer-split-v346.native.test.mjs) passed **1/1 test, 9/9 stages, cleanup PASS**. The [machine report](./C04-buyer-critical-writer-split-v346-results.json) pins the PG73 corpus, current grant routine, SQL policy, critical writer, producer source, and fixture hashes. It verified:

- default-off SQL activation and effective ACLs; ordinary runtime cannot `SET ROLE` to buyer or directly update buyer spend/seller balance, and cannot insert a legacy earning;
- the real critical writer under the buyer LOGIN commits an unreserved charge with one request log and one audit row;
- current-epoch reserved actual settlement atomically releases the hold, charges the buyer, settles the reservation, writes the log/audit, and replays without a second charge;
- reserved ceiling settlement charges the 20,000-micro hold while the Guardrail charge is 10,000 micros;
- buyer LOGIN cannot change budget policy, API-key Workspace identity, seller balance, or legacy earning; and
- rerunning the current `grantPostgresRuntime` restores ordinary runtime financial writes, so this policy alone cannot be an operational cutover.

The fixture seeded reservations with the migrator. It **does not** prove an admission identity, v344 buyer receipt, economic outbox producer, C03 recovery writer, seller consumer, or management/payout compatibility. The buyer LOGIN itself can directly mutate the buyer columns it owns; its credential is a trusted financial capability, not a database proof that every mutation came from the critical writer.

## Existing producer authorization conflict

The TypeScript critical writer has no `SESSION_USER` gate and completed the above PG73 branches under the new LOGIN. Its v1 and v2 optional economic paths call the review-only `SECURITY DEFINER` producers, however. Both [v1](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-outbox-producer.sql) and [v2](../../../../packages/core/migrations-proposals/postgres/shared-key-economic-producer-v2.sql) functions require `SESSION_USER = 'cinatoken_gateway_runtime'`; their `EXECUTE` grants and installation/postflight ACL checks also name that role. Giving the new buyer LOGIN only gateway-table privileges cannot make the economic path work, and granting it `EXECUTE` alone cannot bypass the source-level identity check. The source pin in the native report confirms this conflict; the fixture did not install or invoke the economic proposal under the new LOGIN. The v344 receipt triggers themselves track database transaction changes and do not authorize a caller LOGIN.

A successor economic producer needs an explicit reviewed principal handoff: pin the replacement function body and private ACLs, grant only the buyer settlement identity, reject the former ordinary runtime, and run native direct-SQL negatives and real critical-writer positives for v1/v2 create/verify, reservation branches, rollback and replay. The ordinary runtime grant routine must be changed in the same reviewed cutover so reruns remain closed. Separate admission, management, payout and C03 recovery authorities need their own route and connection-budget proofs; the existing C03 recovery role is `NOLOGIN` and is not exercised here. A production identity split requires a separate secret/Worker binding so the ordinary runtime cannot simply open a buyer-settlement connection. D1/MySQL, Workers/Hyperdrive, Linux CI, rollback and production lock window remain open.

The later [v347 buyer producer LOGIN candidate](./C04-economic-buyer-login-v347.md) verifies the local v2 producer handoff under this identity; its review-only grant does not close the current grant-rerun or application-binding gates.

Run the local fixture with the owned PostgreSQL binary directory:

```powershell
$env:GATEWAY_NATIVE_PG_BIN = 'C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-buyer-critical-writer-split-v346.native.test.mjs
```
