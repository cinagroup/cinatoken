This package is prepared only. No workerd instance, owned Linux run, CI dispatch, production request, database connection or identity action has occurred during preparation.

The next action is one separate, owned Ubuntu Linux diagnostic job after Root reviews these sealed files. Copy this package without changing its bytes into a test-only diagnostic directory or supply it as an immutable job artifact. Do not replace or rerun the existing native job, and do not alter its release gate. Use an exact reviewed checkout whose source-inputs.json hashes match, actions/setup-node with node-version-file .nvmrc (22), and npm ci using the existing lock. Provide no Cloudflare, database or identity secrets. Leave MINIFLARE_WORKERD_PATH unset. The executor independently rejects other runtime versions and a changed source/config/lock/workflow hash.

Run from the checkout using a new unique output directory that does not exist yet:

```sh
python3 /path/to/sealed/execute-owned-linux.py --repo "$GITHUB_WORKSPACE" --out "$RUNNER_TEMP/v364-owned-once-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" --execute-linux
```

The job should have a 7 minute diagnostic step budget after dependencies are installed. Its executor has a 320 second outer limit, a 10 second TERM grace, process-group cleanup, a separate executor.closed.json, and no automatic retry. Upload the whole output directory with an always() artifact step. Keep the real exit status; do not use continue-on-error to claim the original gate passed. No new CI workflow has been written to this repository by this preparation task.

The unchanged original two-file command runs once first and retains its TAP stdout, stderr, exit code, signal and timeout. Its 30 second test deadlines, original 100 KV polls with 10ms null sleeps, exact expected observed marker and all rejection/assertion checks remain intact. A poll window includes KV read latency; it is not a fixed one second wall-clock deadline.

The differential matrix follows sequentially, with fresh Miniflare instances, loopback HTTP only, the original gateway-to-Service-Binding-to-holder topology, the same original body/response/stream source, date successor 2026-09-04, and frozen source config date 2026-09-25. No body is wrapped, duplicated or cancelled by the observation wrappers, and no new waitUntil or KV observation write is added:

| Case | Change from original | Interpretation limit |
|---|---|---|
| Three Node HTTP calibrations | destroy, explicit socket.resetAndDestroy(), native reader.cancel() against a held Node SSE response | Verifies incomplete response and server peer close. RST mode invokes Node's explicit RST API; ordinary destroy does not prove RST. |
| Uninstrumented original destroy | None to worker bundle or transport | Repeats exact cancellation expectation in an isolated fixture and preserves failure. |
| Observed original destroy | Temp metadata-only signal/KV/waitUntil wrappers | A companion comparison detects observer perturbation. Original source and returned body/promise remain unchanged. |
| Observed explicit RST | Only client TCP reset method | A pass would identify a transport difference, not validate ordinary destroy. |
| Observed response reader cancel | Only native Node fetch/reader transport | A pass would identify a client-layer difference, not validate original transport. |
| Observed destroy + signal passthrough | Only the new instance's gateway options add request_signal_passthrough | Distinct diagnostic variant; baselineEligible=false. Frozen JSONC and all original runtime cases stay unchanged. It cannot retroactively validate baseline. |

Each cancellation case requires HTTP200, exact SSE type and first frame, accepted=one, no release, and cancel=observed during the ORIGINAL poll sequence. Destroy/RST additionally require requestDestroyed=true, responseDestroyed=true, responseComplete=false. Native reader mode has a separate transport result and must never be reported as the same TCP assertion. A later 4 second observer tail is recorded separately with usedForPass=false; later visibility never turns originalWindow.actualExit=1 into pass. All cases have an independent 30 second bound; each HTTP read/cancel has a 10 second bound. The executor preserves unknown/timeout outcomes.

Capture client request/response/socket events, calibrated server peer events, wrapper signal initial/abort, original KV invoke/fulfilled/rejected/throw, waitUntil registration/fulfilled/rejected, Miniflare logs and workerd structured stdout/stderr. Worker wallMs and host receive monotonic times are separate clock domains. Only key categories and operation counters are logged, never request JSON, UUID values, credential/provider literals, Cookies, Auth headers or real secrets. Release polling is sampled to reduce interference; observer polling timings are retained in full. Logs and Promise settlement observers can perturb timing, so uninstrumented comparison is mandatory. Absence of a log alone does not prove that no callback occurred if request context/log delivery was lost.

Decision rules:

- A server close failure in Node calibration localizes a client/fixture transport failure before workerd is considered.
- An original cancel-category KV invocation is positive evidence that the original source cancel callback reached its first operation. waitUntil-register and the same task's fulfillment/rejection separate scheduling from persistence. No diagnostic code writes a cancel marker itself.
- A cancel put fulfilling before the measured original window ends while original KV reads remain null localizes a visibility or bridge discrepancy. A later invocation/fulfillment or later visible marker supports timing/lifetime contribution, while the original failure stays failed.
- Gateway abort with no holder abort supports the signal boundary issue; it says nothing by itself about whether the stream source should be cancelled. If only the passthrough variant changes signal/cancel outcomes, record a distinct flag-sensitive result rather than enabling that flag in production.
- No cancel KV invocation across transports after confirmed client close supports source cancellation not reaching the first observable operation within the bounded observation period. It does not independently prove a particular C++ pump drop defect.
- Instrumented success with uninstrumented failure is an observer effect, not a release fix. RST or reader success with ordinary destroy failure is transport-specific, not baseline success.
- A particular upstream runtime defect requires a further reviewed locked-versus-corrected-runtime comparison using the exact unchanged original test, or direct runtime-level traces proving the failing path. This package neither installs nor applies upstream patches. Improving observability alone can localize or falsify causes, but cannot establish that a matching issue/PR caused this repository's failure or that it is fixed.

Primary contracts reviewed:

- [Cloudflare compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-request-signal) distinguishes incoming request.signal from request_signal_passthrough. Locked source [worker-entrypoint.c++](https://github.com/cloudflare/workerd/blob/8ea63498c7aa107995f9b2ffee7789631707e09f/src/workerd/io/worker-entrypoint.c%2B%2B) uses IGNORE_FOR_SUBREQUESTS without passthrough. The locked compatibility schema comment is internally contradictory, so the executable branch and official docs carry the conclusion.
- [Node22 socket.resetAndDestroy](https://nodejs.org/docs/latest-v22.x/api/net.html#socketresetanddestroy) specifies a TCP RST. [Node22 IncomingMessage.complete](https://nodejs.org/download/release/v22.15.0/docs/api/http.html#messagecomplete) reports complete HTTP parsing, not source cancel callback execution.
- [WHATWG reader cancellation](https://streams.spec.whatwg.org/#generic-reader-cancel) concerns cancellation of the reader's associated stream. It does not prove an HTTP disconnect automatically invokes a remote source callback.
- [workerd issue6832](https://github.com/cloudflare/workerd/issues/6832), [PR6833](https://github.com/cloudflare/workerd/pull/6833), and the previously sealed [PR7600](https://github.com/cloudflare/workerd/pull/7600) are candidate path evidence, not this project's cause proof. PR7600 web fetch failed in this preparation; its historical sealed pinned patch is retained and no current status is claimed.

Historical Linux37390678189 dispatch step27 remains 8 tests, 7 passed, 1 failed, cancellation actual=null, as supplied by Root. This preparation does not poll or rewrite that run. P8, real identity, production holder enablement and full G8 are outside this package.
