# C04 v369: private holder local stream renewal

2026-09-25. **Review only; not production activation.** This change adds an optional renewal port to the private v365 holder and keeps the existing path when the port is absent. It does not wire the port into a Worker or Gateway route, install the v367 SQL, create durable recovery, or settle a buyer/provider obligation.

## Boundary and behavior

- The optional `renewHolds(grantId, holderRunId, sendStartId, expectedEpoch)` port is called only after one committed v365 send-start receipt. Its identity comes from the accepted grant, unique holder run, and recorded send-start, never from the public six-field envelope. It can be bound to the separate [v369 PostgreSQL renewal client](../../../../packages/proxy/src/services/postgres-complete-text-hold-renewal-v369.ts), which uses a direct renewal LOGIN and waits for COMMIT and connection-close acknowledgements.
- Only an exact `renewal_recorded` receipt with `commitAcknowledged: true`, `closeAcknowledged: true`, the same grant/run/start IDs, the next epoch, and a strictly later live lease may extend reading. A thrown unknown ACK, `already_recorded`, stale status/epoch, mismatched identity, or missed call aborts the upstream fetch. The holder never retries an uncertain renewal and never creates another physical POST.
- A monotonic local deadline starts before the grant. Initial custody can shorten it; an acknowledged renewal can replace it with at most another `maxUnrenewedStreamMs` from that ACK, also capped by the returned lease timestamp. The old deadline remains active while renewal is pending. Every wrapped response pull checks it before and after the upstream read, so bytes buffered across event-loop suspension cannot pass after expiry. The timer and caller abort signal cancel the physical fetch independently of downstream reads.
- The no-renewal path still returns the raw upstream `Response` and retains the original fixed local timeout. The renewable path wraps the response body to release timers at natural EOF or cancellation and to check the deadline at every read. The caller must propagate cancellation when its client disconnects.

The [v367 SQL proposal](../../../../packages/core/migrations-proposals/postgres/complete-text-all-hold-renewal-v367.sql) extends every exact hold and appends epochs but does not move v365 custody epoch 1 or authorize another send. A local timer and receipt cannot prove real provider billing or finish C04 result resolution.

## Local verification

Commands run from the repository root:

```text
npx tsx --test packages/proxy/src/services/private-complete-text-holder-v365.test.ts
  13 tests, 13 passed, 0 failed
npm run typecheck -w @octafuse/proxy
  passed
```

The loopback tests exercise one POST and a stream continuing past an initial short local deadline after successive acknowledged epochs; unknown COMMIT/close ACK, replay/stale/wrong-run receipts, a never-resolving renewal, caller cancellation, and simulated event-loop suspension all stop reading. Existing no-renewal, upload completion, and redirect tests still pass. These are local Node tests, not a real Cloudflare Worker, Hyperdrive transaction, fleet suspension/restart, or durable recovery test.

Source SHA-256:

| File | SHA-256 |
| --- | --- |
| [private holder](../../../../packages/proxy/src/services/private-complete-text-holder-v365.ts) | `323d2cbe3a9179dbc49b200f8cc634aace9c3359df16fe44c6da1114b4263565` |
| [loopback tests](../../../../packages/proxy/src/services/private-complete-text-holder-v365.test.ts) | `fc4525e294c2dbe9c4736704c4cdc33f323d31460471fa1795fb3544b8a2c7bd` |

C04.1–8 and C04.G remain open. Production acceptance still requires private runtime wiring, a deployed database gate and direct-role tests, real Worker cancellation and suspension proof, and the separate result/financial closure protocol.
