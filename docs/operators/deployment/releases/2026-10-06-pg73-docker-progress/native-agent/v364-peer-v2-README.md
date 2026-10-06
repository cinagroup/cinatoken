# v364 owned Linux cancellation diagnostic

This independent, manual synthetic diagnostic changes no production Worker, holder flag, database, identity, original fixture, assertion, existing workflow or dependency lock. The known baseline remains 8 tests, 7 passed, 1 failed with cancellation `null`; no diagnostic comparison can retroactively pass that run.

Use `.nvmrc` Node22 and `npm ci`. Locked dependencies are workerd `1.20260828.1`, Miniflare `5.20260828.0-alpha` and Wrangler `4.127.1`. The successor uses compatibility date `2026-09-04` because this binary rejects frozen date `2026-09-25`; frozen JSONC stays unchanged. Package and source seals validate original source/config/lock/Proxy-workflow bytes before runtime startup. Provide no Cloudflare, database or identity secrets; do not use runtime/debugger overrides.

The workflow is `workflow_dispatch` only, with independent concurrency and no retry. Root commits and dispatches after review. Runtime entry is the Python executor; output must be a new unique directory outside the checkout that does not exist yet:

```sh
python3 scripts/diagnostics/v364-owned-linux/execute-owned-linux.py \
  --repo "$PWD" --out "$RUNNER_TEMP/v364-owned-once-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --execute-linux
```

Validate and bundle without starting workerd using a fresh output path:

```sh
node --check scripts/diagnostics/v364-owned-linux/run-v364-owned-diagnostic.mjs
node scripts/diagnostics/v364-owned-linux/run-v364-owned-diagnostic.mjs \
  --repo "$PWD" --out "$RUNNER_TEMP/v364-prepare-unique" --prepare-only
```

The unchanged original two-file test runs once first with raw TAP and real exit retained. Eight cases follow sequentially, using fresh local Miniflare instances and the original gateway → Service Binding → private holder topology:

| Case | Difference | Interpretation limit |
| --- | --- | --- |
| Three Node SSE calibrations | Ordinary destroy, explicit TCP RST, native reader cancellation | Confirms incomplete response/server close; ordinary destroy does not prove RST. |
| Uninstrumented destroy | Original workers and transport | Preserves cancellation expectation without observers. |
| Observed destroy | Metadata-only signal/KV/waitUntil wrappers | Uninstrumented comparison checks observer perturbation. |
| Observed RST | Client `socket.resetAndDestroy()` | Transport-specific; cannot pass original destroy. |
| Observed reader cancellation | Native Node fetch/reader | Separate transport result, not the original TCP assertion. |
| Observed destroy with passthrough | Only this gateway instance adds `request_signal_passthrough` | `baselineEligible=false`; frozen and all original flags remain unchanged. |

Every cancellation case retains HTTP200, exact SSE type/first frame, accepted=`one`, release=`null`, and cancel=`observed` within the original **100 KV polls with 10ms null sleeps**. Destroy/RST require request/response destroyed and `response.complete=false`. KV latency contributes to measured duration. A separate four second tail has `usedForPass=false`; later visibility and a flag variant cannot wash baseline failure into pass. Original assertions and 30 second test deadlines stay intact.

Observers forward the original Request, stream body, response, KV arguments/return promise and waitUntil task. They do not tee/cancel the stream, write an extra marker or register new lifetime work. Logs contain signal state, key categories/operation counters and settlements/errors; no payload, UUID, credential/provider literal, Cookie or Auth value. Release reads are sampled; host observation timings are complete. Observers can perturb timing. A missing log alone cannot prove a callback never ran.

Node `Promise.race` bounds **do not cancel** underlying tasks. Python is the closure authority: 320 second outer deadline, ten second TERM grace, then KILL and bounded reap/drain. A Linux child subreaper adopts orphaned descendants. Node, original tests and workerd share one isolated process group. Every fixture registers for final cleanup immediately after creation, including readiness/binding failures. Timeout, forced cleanup, leftovers, missing/invalid reports or preflight errors remain failure/unknown. `executor.closed.json` records direct/adopted wait statuses and group absence. Forced termination is never reported as a cooperative native finally close.

Always retain executor start/close, stdout/stderr, original TAP, events, Node closed result, seals and workflow. Receipts bind checkout SHA and workflow SHA/run/attempt. A strict failure naturally fails the step/job; no `continue-on-error` or gate bypass is used. Package/preparation errors are captured in executor stderr and closure receipts once fresh output has been safely created.

`runnerOutcomeCode` records executor timeout/interruption codes such as 124/130; `actualProcessExit` records the child's actual return code (negative for a terminating signal), or null when no child started.

An original cancel-category KV call proves the source callback reached its first operation. Original waitUntil and KV settlements then separate invocation, lifetime and persistence. Improving observability can localize or falsify hypotheses, but proving an upstream defect requires a reviewed locked-versus-corrected-runtime comparison with the unchanged strict suite, or direct traces establishing that runtime path. This tool neither applies an upstream patch nor enables production holders.

Primary contracts: [Cloudflare signal flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-request-signal), [locked workerd signal branch](https://github.com/cloudflare/workerd/blob/8ea63498c7aa107995f9b2ffee7789631707e09f/src/workerd/io/worker-entrypoint.c%2B%2B), [Node22 RST](https://nodejs.org/docs/latest-v22.x/api/net.html#socketresetanddestroy), [Node22 HTTP completeness](https://nodejs.org/download/release/v22.15.0/docs/api/http.html#messagecomplete), [WHATWG reader cancel](https://streams.spec.whatwg.org/#generic-reader-cancel), [Linux subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html). [Issue6832](https://github.com/cloudflare/workerd/issues/6832), [PR6833](https://github.com/cloudflare/workerd/pull/6833) and historically sealed [PR7600](https://github.com/cloudflare/workerd/pull/7600) remain candidates, not project cause proof.
