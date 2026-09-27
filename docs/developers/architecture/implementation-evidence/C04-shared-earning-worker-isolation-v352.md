# C04.6 dedicated economic scanner Worker candidate (v352)

This is a **local, review-only, default-off** replacement for the v350 proposal that composed the earning scanner into the general proxy Worker. No Worker was deployed, no Cloudflare API was called, and no remote SQL was run. The activated `wrangler.shared-earning-scanner.jsonc` file was not written.

## Isolation contract

- The [dedicated entry](../../../../packages/proxy/src/runtime/shared-earning-scanner-worker.ts) has its own scheduled handler. Its `fetch` handler returns only `404` with `Cache-Control: no-store`. The [base configuration](../../../../packages/proxy/wrangler.shared-earning-scanner.base.jsonc) has `workers_dev: false`, no route, no general runtime `HYPERDRIVE`, no D1, service, Queue, R2 or secret binding, and no activation variable.
- The [dedicated wrapper](../../../../packages/proxy/src/runtime/postgres-shared-earning-scanner.ts) accepts only `SHARED_EARNING_SCANNER_ENABLED`, `EARNING_DELIVERY_HYPERDRIVE` and `EARNING_CONSUMER_HYPERDRIVE`; activation must equal `dedicated-v1`. The two PostgreSQL connection URLs and binding objects must differ. It opens one-connection, invocation-private clients and calls the existing `runSharedEarningScannerClient` lease/consume/marker-gated ACK loop. An uncertain response stops the loop so a later lease/reconciliation pass can recover.
- The general [HTTP Worker handler](../../../../packages/proxy/src/runtime/worker-handler.ts) no longer imports or schedules the scanner. The old proxy scanner wrapper and its three fields in the HTTP `GatewayBindings` type were removed. The ordinary [Wrangler generator](../../../../scripts/deploy/gen-wrangler.mjs) rejects any scanner activation or earning Hyperdrive ID before writing HTTP Worker configs.
- The [separate generator](../../../../scripts/deploy/gen-shared-earning-scanner-wrangler.mjs) requires explicit `dedicated-v1` activation and two distinct canonical Hyperdrive IDs. It checks the currently generated proxy, admin and chain Worker configs for financial bindings and reused IDs. Its default invocation writes nothing; `--print` validates without writing; `--write` writes only the separate local scanner config. It has no deploy or Cloudflare call.

The dedicated generator's activation and ID variables must be scoped to its own invocation. Supplying them to the general HTTP generator is deliberately rejected before any config write.

The local bundle graph test finds `postgres-shared-earning-scanner.ts` in the dedicated entry bundle and absent from the general `src/index.ts` bundle. The dedicated entry bundle does not include `worker-handler.ts`. Type removal and bundle separation narrow the code boundary; the two financial Hyperdrive origins must still be provisioned with their distinct delivery and consumer PostgreSQL LOGINs.

## Local verification

- [Scanner tests](../../../../packages/proxy/src/runtime/postgres-shared-earning-scanner.test.mjs): **10/10 PASS**. These cover default-off behavior, HTTP `404`, the two-origin composition, lease/ACK order, lost commit responses, wrong LOGIN, and bounded admission/housekeeping.
- [Dedicated config and bundle tests](../../../../scripts/deploy/gen-shared-earning-scanner-wrangler.test.mjs): **6/6 PASS**. They cover no write by default or `--print`, known HTTP binding/ID conflicts, hostile base config, and the two entry-point bundle graphs.
- [General Wrangler generator tests](../../../../scripts/deploy/gen-wrangler.test.mjs): **15/15 PASS**, including refusal of scanner credentials before a generated HTTP config write.
- `npm run typecheck -w @octafuse/proxy`: **PASS**. `git diff --check` on edited tracked files: **PASS**.
- [Machine summary](./C04-shared-earning-worker-isolation-v352-results.json) pins the checked local source hashes and test outcomes. The prior v350 native PostgreSQL fixture was not rerun because it writes its historical pinned report; the lease/consume/ACK core was not changed by this candidate.

## Remaining deployment gates

The existing Cron is `17 * * * *` and the scanner admits at most 20 events per invocation, so this candidate can process **at most 20 events per hour**, and other limits can lower that rate. There is no demonstrated production event arrival rate, backlog SLO, origin connection budget or alert/recovery capacity. Separate Worker packaging resolves the local HTTP/financial credential co-location design, but does not close the C04.6 capacity gate.

Before production use, provision a separate Worker and two distinct Hyperdrive origins with the intended direct PostgreSQL LOGINs; audit live proxy, admin and chain Workers for stale earning bindings and remove any old proxy earning credentials. The local generators cannot inspect Cloudflare dashboard secrets, existing deployed bindings, service routes or actual Hyperdrive origin users. Deploy and validate the separate Worker, scheduling and rollback under operational approval. The v342 durable delivery proposal and v343 consumer must be migrated and accepted, and financial reconciliation, dead-letter operations and C04.G remain open. Existing v350 evidence describes a superseded proxy-composed review candidate, not the configuration proposed here.
