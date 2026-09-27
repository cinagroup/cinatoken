# C04 v346: v2 buyer debit through durable seller delivery

Status: **review only, default off**. This is one owned PostgreSQL 18.6 integration fixture for the existing proposal chain. It does not add a formal migration, Worker, Queue handler, production grant, or runtime activation.

The [native fixture](../../../../scripts/db/cutover/postgres-shared-key-buyer-budget-receipt-v2.native.test.mjs) installs PG73, immutable quote and dispatch proposals, the v1 economic producer and consumer, the v2 buyer debit and producer, the [v344 buyer receipt](./C04-buyer-budget-receipt-v344.md), and [v345 receipt maintenance](./C04-buyer-budget-receipt-maintenance-v345.md). It then installs [durable delivery](./C04-postgres-economic-delivery-v342.md) while the v1 consumer is still present, followed by the [version-aware v2 consumer](./C04-postgres-snapshot-earning-consumer-v2-v343.md). This order retains the delivery installer's exact v1 dependency and allows its event-ID job to use the v2 consumer wrapper afterward.

The owned-cluster [machine report](./C04-postgres-v2-economic-delivery-integration-v346-results.json) passes **1/1 test, 47/47 stages, cleanup PASS**. The final seven stages prove:

1. Delivery installation backfills an already committed, buyer-receipted v2 event without a timestamp watermark.
2. The v2 consumer installs after delivery while preserving its private event marker contract.
3. The real PostgreSQL critical writer commits an ordinary-buyer debit, receipt, v2 event and delivery job together; an invalid attempt rolls back buyer log, debit, event and job.
4. ACK before the consumer marker is rejected. The dedicated consumer then credits one seller attempt, balance and ledger entry, writes one immutable marker, and permits ACK.
5. Replaying consumption does not add a second credit. A reservation-ceiling v2 event is delivered as `pending_manual` with a marker and ACK, without seller credit.

This proves the combined local database transaction and delivery protocol for synthetic attempt facts. The test does not run a real Chat/Completions request, supplier bill, Queue/Workers/Hyperdrive connection, or crash recovery across hosts. The v2 producer still authorizes the broad ordinary runtime LOGIN; [the privilege transition review](./C04-runtime-privilege-transition-v345.md) shows why a dedicated buyer settlement identity and a successor producer grant are required. `pending_manual` has no reviewed adjustment or C12 release policy. Delivery's local runtime candidate still reports `queueAckSafe: false` for every outcome.

The later [v347 dedicated buyer LOGIN candidate](./C04-economic-buyer-login-v347.md) tests that identity with the v2 producer in a separate owned cluster; this integration fixture retains its original runtime-role scope.

The report pins fixture SHA-256 `934b996e899f904530076913dfadd897e659943e67aba36c9a4e4679cad8ac3a`, receipt SQL `56ebaecd1425206df81c9dc7981c34e5e246047f188355f5d14103e2dee3270c`, delivery SQL `79e53d2ef830dc2641732d24ef0230befac344c9d1a30469487b44074f78ece8`, and v2 consumer SQL `272158acbed2ab52965d154f342ef6452d626d1e4393c40cae32d5f519f4b984`.

```powershell
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-shared-key-buyer-budget-receipt-v2.native.test.mjs
```
