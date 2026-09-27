# Ordinary text transport: workerd-compatible manual redirects

2026-09-27. Local repair and verification; complete Linux native Worker acceptance and release remain pending. The predecessor is `94c12c1e37e7346330486cf9a3a3246af00d95c5`.

## Runtime failure and bounded repair

Linux dispatch step 10 started the successor Worker successfully with Core source resolution, then its first OpenAI request failed **before network dispatch**:

```text
Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).
```

The owned provider recorded **zero POSTs**, while the Gateway had consumed one permit and returned 502/unknown/failover-forbidden. The full log is retained at `.wrangler/publish-20260927/github-dispatch-94c12c1e-full.log`. This is a production transport incompatibility: the same RequestInit value appears in the four ordinary OpenAI Chat, OpenAI Responses, Anthropic and Gemini text drivers. It affects ordinary nonredirect URLs as well.

Those four drivers now use `redirect: 'manual'`. Each changes exactly one literal; reversing it reconstructs its saved predecessor bytes. No automatic Location follow is added. Existing `ambiguousDispatchedStatusMeta` marks returned 3xx as unknown and forbids another model, key or provider attempt. The failover layer preserves the consumed permit and usage promise. Success JSON/SSE parsing, admission, SQL and grants are unchanged. The [current redirect policy](../../../developers/reference/upstream-redirect-policy.md) records this behaviour. [Cloudflare's Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/) supports the manual/no-follow semantics; it still lists `error`, so this repair relies on the actual workerd error rather than claiming the documentation excludes that value.

Manual responses also make **304 with a null body** reachable. `failover-dispatch.ts` previously rebuilt it using `new Response('', {status:304})`, which throws. That constructor and both normal/trusted intermediate constructors in `request-log-record-status.ts` now select `null` only for 304. Raw status, headers and dispatch metadata remain intact. The normal public error renderer retains its existing 502 normalization and removes provider Location/ETag. All other status/body branches remain byte exact. No caller or serializer is bypassed.

## Final local evidence

The [machine report](./2026-09-27-text-workerd-manual-redirect-local-report.json), SHA-256 `5f02328c354f9cebdec49baa44b9479a9e9fff52c1a79e1cb0c004a61f979289`, and [raw TAP](./2026-09-27-text-workerd-manual-redirect-local-tests.txt) record **282/282 PASS, zero failures/skips**, using official Node **22.23.2** and locked dependencies in `C:/Users/cina/.codex/worktrees/checklist-release/cinatoken`:

```text
node --import tsx --test packages/proxy/src/services/egress/text-upload-resource.test.mjs packages/proxy/src/services/egress/text-redirect-wire.test.mjs packages/proxy/src/services/egress/text-hidden-retry.test.mjs packages/proxy/scripts/staging/text-dispatch-response-reset-v377.test.mjs packages/proxy/src/services/request-log-record-status.test.ts
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/proxy/tsconfig.dispatch-safety.json --noEmit
```

Both typechecks exited **0**, with no diagnostics. No Core build occurred.

The tests comprise 137 redirect wire checks, 104 upload/resource checks, 20 hidden-retry checks, 16 completed-POST/reset checks and five existing request-log materialization tests. The 25 new 304 checks include four actual protocols, stream and same/cross-origin combinations, 4/40-candidate Gateway requests, plus the trusted materializer. Gateway 304 cases use a real `Date.now()+5000` deadline to execute the affected constructor; they require one complete provider POST, zero redirect destination requests, one permit, original 304/null body, retained raw headers, unknown and forbidden failover, then actual public error normalization without a constructor exception or Location leak. Existing 429 sends remain bounded; 503 remains unknown after one send.

All six runtime source changes passed byte-exact inverse comparisons. The updated upload assertion requires every ordinary driver's RequestInit to use manual; static verification also rejects error/follow options in those four drivers. Core's 327-file TypeScript corpus remains `477233bf3c31f1ef3ca847ba3e36179fef50f85e1ba3c909a847706bff2800b0`; the 454-file Proxy successor corpus is `1c0e8004ed308eeae2209ed03dede60b458eb1e0b14991d0fa7bdd65c6fb645f`.

The frozen v374 fixture and historical reports are unchanged. The current Worker successor changes only its stale comment from error to manual; every native physical-send/permit/unknown assertion remains. The earlier [Windows native failure](./2026-09-27-workerd-wire-windows-native-optin-failed.txt) remains evidence of `0xc0000005`, and was not rerun or relabelled PASS. Linux must execute the full four-mode Worker matrix after this repair. Local Node sockets/types do not establish native workerd execution, financial closure, deployed intermediary policy or supplier-internal retries.

## Disabled review-only transport risks retained

This repair does **not** modify or enable the three historical holder transports:

- `private-complete-text-holder-v365.ts` retains `redirect: 'error'` on its physical upstream fetch, reached through v384→v390 or v392→v394. It uses the same option rejected by the actual Linux runtime. Holder activation remains a required compatibility/one-send/financial gate; this round does not independently execute or certify those holder paths. `COMPLETE_TEXT_HOLDER_ENABLED` must equal `reviewed-v1`; both separate v390/v394 Wrangler configs remain `disabled`, `routes: []`, `workers_dev: false`.
- `complete-chat-credential-free-dispatch-v400.ts` retains error on its private Service Binding request. v401 middleware skips when `CREDENTIAL_FREE_CHAT_INGRESS_V401_ENABLED` is undefined; neither production base config defines that flag. This is a strong static risk before activation, not an independently executed Worker result.
- `complete-chat-holder-dispatch-v385.ts` retains error on its private request. Its review-only factory has no non-test production caller. Its compatibility risk was identified statically and was not separately exercised in workerd.

These frozen sources/configs were verified unchanged against the predecessor. No new activation, role binding, SQL/grant, remote SQL, paid Provider, separate holder deployment or local PostgreSQL cluster is part of this task. Supplier financial acceptance and full checklist completion remain outside this local verification.
