# Frozen v364 native cancellation gap

Commit `f4601a47fa188ae5faa8b49a241c4302068bb38e`, [Proxy dispatch run](https://github.com/cinagroup/cinatoken/actions/runs/36313277272/job/108603152618).

## Actual results

Full unit passed 4346/4346. The ordinary Worker fixture passed 3 cases and all 4 modes; its uploaded report has 646 source pins, with all 309 tracked pins matching the immutable commit. All six manual/304 runtime pins match. The owned Worker/provider/relay cleanup recorded five closed resources and zero errors. This is local Linux workerd transport evidence rather than production HTTP or financial closure.

Step 27 passed five of six v364 tests: configuration identity, two in-process cases, and the two native request-bounds/streaming cases. The remaining native cancellation case used mf.dispatchFetch through the real default gateway HTTP entry. Its owned 127.0.0.1 origin check, private holder accepted nonce, first SSE chunk and reader.cancel all completed. The original 100 × 10 ms observation loop then left the cancellation KV marker null, failing the unchanged observed-marker assertion at line 199. Steps 28–65 were skipped. The full dispatch job is failed.

The [CI report](./2026-09-27-f4601a47-linux-proxy-ci-report.json), [original ordinary Worker machine report](./2026-09-27-f4601a47-linux-worker-machine-report.json) and [failed cancellation log](./2026-09-27-f4601a47-v364-http-cancel-failed.txt) preserve the exact scope, source pins and actual failure.

## Unresolved boundary

The preceding special-HTTP proxy fetch comparison also failed to observe the KV marker. Neither path proves native cancellation reached the holder and completed its asynchronous KV write. The missing marker does not distinguish propagation failure from KV execution-context lifetime; an upstream workerd regression is also an unconfirmed lead. No exact upstream issue/code match has been established for this binary. The getWorker.fetch adapter is already a special HTTP bridge, so generic RPC stream serialization loss is not a demonstrated cause.

The test-only runtime date remains 2026-09-04. Neither the two native passing cases nor this failure certifies the frozen JSONC date of 2026-09-25. Node 24 local constructor/configuration checks remain separate from the actual Linux Node 22 native run.

## Frozen outcome

The review cancellation gate remains unproven. No new timeout, fixture or runtime change follows this failure; no assertion was removed, no exception swallowed, no skip added and no vendor/runtime/private holder source changed. This evidence activates no review-only feature and does not support enabling the default-off holder paths or claiming complete C04 acceptance.
