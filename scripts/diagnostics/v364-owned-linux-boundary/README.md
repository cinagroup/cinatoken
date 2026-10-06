# v364 owned Linux cancellation boundary comparison

This manual synthetic diagnostic compares the same locked runtime at three response boundaries. It changes no production code, holder default, frozen fixture or assertion, compatibility flag, existing workflow, dependency lock, database or identity. It does not retry or reinterpret the earlier failed run `37396338452`: its actual Node/process/runner exit remains 1, five cancellation observations remain null, and its original outer `leftoverGroupKilled=true` is retained in pinned evidence. The cause remains unproven.

Use repository `.nvmrc` Node22 and `npm ci`: workerd `1.20260828.1`, Miniflare `5.20260828.0-alpha`, Wrangler `4.127.1`. The owned runtime uses supported compatibility date `2026-09-04` and the exact original flags `nodejs_compat`, `enable_request_signal`; frozen JSONC date `2026-09-25` stays unchanged. There is no signal-passthrough variant or runtime override. No credentials are needed or inherited.

After review, Root commits and dispatches `.github/workflows/v364-owned-linux-boundary.yml` once. It has only a manual trigger, contents read permission, independent concurrency, ten minute job/seven minute diagnostic limits and always uploads raw output. A strict failure naturally fails the step; no `continue-on-error` or alternative pass gate exists.

```sh
python3 scripts/diagnostics/v364-owned-linux-boundary/execute-owned-linux.py \
  --repo "$PWD" --out "$RUNNER_TEMP/v364-boundary-once-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --execute-linux
```

The output directory must not exist and must be outside the checkout. Python verifies the package/workflow seals, isolates one Node process group/session, becomes a Linux subreaper and owns the 360 second deadline plus bounded TERM/KILL/reap closure. It records real `child.returncode` separately from `runnerOutcomeCode` 124/130. Runtime receipts bind the actual checkout to `GITHUB_SHA`, run and attempt. `source-inputs.json.reviewBaseHEAD` records the original read-only review base; it is not a future execution SHA. Every pinned source is checked against both working bytes and the running checkout's Git blob.

Preparation is local bundling and syntax validation only; it never starts workerd:

```sh
node scripts/diagnostics/v364-owned-linux-boundary/run-boundary.mjs \
  --repo "$PWD" --out "$RUNNER_TEMP/v364-boundary-prepare-unique" --prepare-only
```

The exact unchanged original two-file strict suite runs once first with raw TAP/actual exit retained. Eight new cases then run sequentially on fresh owned fixtures:

| Cases | Boundary | Limit |
| --- | --- | --- |
| Node HTTP destroy / RST | Local Node SSE server | Await both response and socket close at client and peer; destroy is not evidence of a wire RST. |
| Bare asynchronous source destroy / RST | Single Worker, KV, no Service Binding or holder import | Matches frozen first frame, HWM0, 300 KV/timer pull loop and async cancel/put/same waitUntil task; envelope validation is deliberately simpler. |
| Direct frozen holder destroy / RST | Original gateway-created Request → local JS call of original holder → original gateway Response(body) wrap | Removes only Service Binding transport. Shares the incoming execution context and includes synthetic private literals only in this owned diagnostic bundle. |
| Original Service Binding destroy / RST | Original gateway → original binding → original holder | Metadata observers are the pinned prior observers, forwarding original objects/promises and adding no cancel marker or lifetime work. |

All eight comparisons have `baselineEligible=false`. A passing direct arm cannot pass the original binding suite. Each stream case requires exact HTTP200/SSE/first frame, accepted=`one`, release=null and cancel=`observed` within the original 100 KV polls/10ms null sleep. A separate four second tail and final pre-dispose KV snapshot have `usedForPass=false`; neither can upgrade a failed original window. Incoming signal abort is metadata and cannot satisfy source cancel. No abort handler writes KV or cancels the source.

Host logs label startup, client cancellation, original poll, tail, final KV snapshot, dispose start and dispose fulfillment/error. Worker log timestamps remain raw alongside host receive phase; log arrival phase is not exact worker event ordering. Events are persisted incrementally. `/proc` samples record only PID/parent/group/session/start identity/state/comm, avoiding command lines and environment.

Python first polls/reaps its direct Node through Popen, then individually verifies and reaps already adopted zombie descendants. It never uses `waitpid(-pgrp)`, which could consume Popen's direct child status. A census is taken before and after that reap; zombie-only members get a bounded adoption/reap drain rather than a meaningless kill. Live or unknown remaining membership permits necessary TERM/KILL, records the exact signal attempt and keeps forced cleanup as failure. Missing, incomplete or invalid closure data stays failure/unknown.

The locked Miniflare implementation itself destroys stdio, sends workerd SIGKILL and awaits the process `exit` event during `dispose()`. Therefore API disposal fulfillment and an unforced Python group close **do not prove graceful workerd exit**, flushed final worker logs or entirely cooperative runtime cancellation. The receipt explicitly keeps `gracefulWorkerdExitProven=false` and separates Miniflare disposal from Python's additional forced signals. A bounded Promise cannot cancel its task; Python is the process closure authority.

The source seal includes the prior real executor/Node/TAP artifacts and independent analysis, the original ten inputs, the old diagnostic package and old workflow. A direct/bare failure weakens a binding-only explanation; a direct pass with binding failure narrows the next boundary comparison. Neither outcome proves an upstream defect without a pinned corrected-runtime comparison or direct causal trace. No production, Cloudflare, real issuer, secret or database request belongs to this tool.
