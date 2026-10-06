# v364 direct Workerd socket diagnostic

This manual, synthetic Linux diagnostic isolates Miniflare's core entry-worker hop. It does not change the original strict v364 tests, flags, dependency versions, production holder, or any deployment. Production requests and real identity access are out of scope.

Use Node 22 from `.nvmrc`, `npm ci`, and the pinned Workerd `1.20260828.1`, Miniflare `5.20260828.0-alpha`, Wrangler `4.127.1`. The runtime uses compatibility date `2026-09-04` and the original `nodejs_compat`, `enable_request_signal` flags. The frozen JSONC date `2026-09-25` remains unchanged. No signal-passthrough flag or runtime override is used.

The unchanged original two test files execute first and retain their real exit and raw TAP output. Their cancellation test still uses `mf.ready`, the original client destroy operation, and exactly 100 polls with a 10 ms sleep. An original failure keeps the aggregate diagnostic failed, even if every new comparison passes.

The four comparison cases use `unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }]` on the entry user worker and `unsafeGetDirectURL()` for the actual request URL. The pinned Miniflare implementation maps that socket directly to the user-worker service. The runner requires a different origin from `mf.ready`, so these requests bypass the core entry worker. Each case gets a fresh runtime.

| Comparison                      | Source and request path                                                                       | Client operation                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Direct bare, destroy            | Frozen original boundary async KV/timer source and unchanged holder observer                  | Original request/response destroy                           |
| Direct bare, RST                | Same source and observer                                                                      | Node socket `resetAndDestroy` then request/response destroy |
| Direct binding gateway, destroy | Original gateway and private holder through the original service binding; unchanged observers | Original request/response destroy                           |
| Direct binding gateway, RST     | Same gateway, binding, holder and observers                                                   | Node socket `resetAndDestroy` then request/response destroy |

Each comparison retains the first-frame, accepted, release and cancel observations, the original 100 × 10 ms observation window, and a separate four-second diagnostic tail. Tail observations never upgrade a failed original window. Incoming, forwarded-request and holder signals are observations of those particular boundaries. Missing logs do not prove a callback can never run.

A fifth case calls the original private holder inside a real Workerd worker, reads its first frame, starts a pending second read, then explicitly awaits `reader.cancel()`. It verifies the original cancellation KV write, unchanged original `ctx.waitUntil` call, and pending read completion. It adds no lifetime task or abort handler. This calibrates native JavaScript source cancellation while a fetch request remains active. It cannot prove HTTP disconnect cancellation, completion of the source's already-pending pull, or success of the original strict baseline.

Preparation bundles and checks exact source/config/lock/previous closed failure bytes without starting Miniflare. Run it with a fresh directory outside the checkout:

```sh
node scripts/diagnostics/v364-direct-socket/run-direct-socket.mjs --repo "$PWD" --out /tmp/v364-direct-prepare-UNIQUE --prepare-only
```

Actual execution is owned by the Linux Python supervisor:

```sh
python3 scripts/diagnostics/v364-direct-socket/execute-owned-linux.py --repo "$PWD" --out /tmp/v364-direct-once-UNIQUE --execute-linux
```

The supervisor admits the sealed package and checkout SHA, sanitizes inherited environment variables, owns a new process group, enables the Linux subreaper, and waits at most 360 seconds. It records actual process exit separately from timeout or interruption outcomes. Its final cleanup distinguishes live processes, zombies and unknown `/proc` observations, retains every signal attempt and actual wait status, and verifies group absence. Unknown exit, timeout, incomplete case evidence, source mutation or cleanup uncertainty remain failure. The workflow retains raw files on both success and failure.

`closed-result.json` is the Node report. `executor.closed.json` is the outer closure authority and includes SHA/bytes for all pre-existing output files. Fulfillment of `mf.dispose()` is only API completion; Miniflare may kill Workerd internally. Neither fulfilled disposal nor an unforced outer process-group close proves graceful Workerd teardown. These results do not complete G7/G8 or validate real CinaAuth identity, production cancel behavior, PG18, or restricted database ACLs.
