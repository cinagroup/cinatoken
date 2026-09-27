# C04 v341: local PostgreSQL earning consumer runner

Status: **review only, default off**. This runner invokes the v340 PostgreSQL snapshot consumer with an event ID. It does not activate a Worker, Queue, scanner, payout, or formal migration.

The [one-shot runner](../../../../packages/proxy/src/runtime/postgres-shared-earning-consumer.ts) opens an invocation-private PostgreSQL client. In the same transaction and session as the `consume_shared_key_economic_event($1)` call, it verifies `current_user` and `session_user` are the dedicated `cinatoken_gateway_shared_earning_consumer` LOGIN and checks database-user-sourced transaction, statement, lock, and idle-in-transaction deadlines. The caller must enumerate the request and producer clients so reusing their raw authority is rejected before SQL. Input is one bounded event ID; returned decision and counts are checked before COMMIT.

The runner is one-shot. A lost SQL/COMMIT response, invalid result, or failed retirement remains `outcome_unknown` with the private client locally retained. Even a confirmed `processed` result reports `queueAckSafe: false`, since durable delivery ownership and physical socket closure have not been established. `pending_manual` is a committed consumer decision, not a seller credit or an automatic reconciliation.

Verification: [unit tests](../../../../packages/proxy/src/runtime/postgres-shared-earning-consumer.test.mjs) **8/8 PASS**; Proxy full typecheck **PASS**. The [owned PG18.6 fixture](../../../../scripts/db/cutover/postgres-shared-earning-consumer-runner.native.test.mjs) installed PG73 and the review-only quote, dispatch, outbox, and consumer proposals, then passed **5/5 stages with cleanup PASS**. It verified runtime LOGIN rejection, absent-event failure, a committed synthetic quote and outcome, and event-ID replay from another dedicated-login session yielding exactly one seller credit/ledger/consumption marker. The [machine result](./C04-postgres-shared-earning-runner-v341-results.json) pins the formal migration corpus and all proposal/runner/fixture hashes. The local CI workflow registers both tests; Linux CI has not run.

Run the native fixture with `GATEWAY_NATIVE_PG_BIN` set to a PostgreSQL 18.6 `bin` directory:

```powershell
node --import tsx --test scripts/db/cutover/postgres-shared-earning-consumer-runner.native.test.mjs
```

Source SHA-256: runner `a7de932d8086a922a77a9c8b3cba8f9057733d2c1bfd2ab2fe655c3943508af2`; unit test `1e8b8cd97cae9e33b4aa4066727dc014edb81a7893341635c768ff6238f6d254`; native fixture `c544175080f4339ed4ade9eafaab9a977dd4869034736c65ede1a5b2c938e518`.

Limits: The caller-supplied authority list and retirement callback are local composition contracts, not independently verified production credential custody or physical connection disposal. There is no Queue event-ID handler, durable scan/lease/backoff/DLQ/manual recovery, or ACK policy. The synthetic fixture does not prove a real buyer producer, Workers/Hyperdrive operation, D1/MySQL parity, late adjustment, or C12 release/hold policy. C04.4–6 and C04.G remain open.
