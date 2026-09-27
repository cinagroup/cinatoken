# Worker wire fixture successor — local evidence

2026-09-27. Tests only. No production runtime, SQL, grants, default activation or Core build changed. The frozen [v374 fixture](../../../../packages/proxy/scripts/staging/text-dispatch-workerd-wire-v374.test.mjs) remains byte exact, SHA-256 `9b6a96ba25259f0cdca27dad9ed9baeed0b779091639032de93c459f397a1aa2`; its earlier evidence is unchanged.

## Two independent failures

Linux a8029350 dispatch step 10 failed Worker startup with `MySqlVarCharBuilder is not a constructor`. The old fixture used esbuild `platform: 'node'`, which activates the Core package's `node` export and rebundles `packages/core/dist/index.js`. Wrangler defaults to browser platform and `['workerd', 'worker', 'browser']` conditions. The independently captured actual Worker sourcemap contains 632 sources, `core/src/index.ts`, and zero Core dist sources. Its bundle SHA-256 is `69e1b01f9c00ba1198226588092a4502e69b7973e715508c6b990a78e480fef8`; map SHA-256 is `3ec16e5dcf3c671c4a9d0085b5ebaaae3284ab9d3baaa3a6b534418ba69ce7ae`. This establishes a fixture resolution mismatch; complete native Worker startup under the successor still requires Linux CI.

The separate relay 502 was reproduced using official Node **22.23.2**, matching the Linux job's version. After the first complete provider POST and its 307, Node's built-in fetch failed in `httpRedirectFetch → safelyExtractBody → extractBody` with `Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer`. The [failed diagnostic report](./2026-09-27-workerd-wire-detached-buffer-first-local-failed-report.json) retains the real response, nested cause and single provider POST. This is independent of the Worker constructor failure.

## Successor and executed checks

The [new fixture](../../../../packages/proxy/scripts/staging/text-dispatch-workerd-wire-worker-conditions-successor.test.mjs), SHA-256 `2d28943c53954d32c987b5721ca49cf13b1e3018b56dfde4ee886151e36970da`, uses browser platform and Wrangler's default Worker conditions. Its metafile requires Core source and rejects Core dist. Native `node:crypto` remains supplied by workerd's existing `nodejs_compat` flag.

Only the local relay's synthetic JSON body changes: it converts the fully received bytes to a replayable UTF-8 string **after asserting the string encodes to exactly the original bytes**. The default-follow fetch remains. The original 1 Gateway permit, 1 relay POST, 2 provider POSTs, POST paths, equal bodies and equal Bearer assertions remain. No production upload or vendor implementation changes.

The final run used locked dependencies in `C:/Users/cina/.codex/worktrees/checklist-release/cinatoken`:

```text
node-v22.23.2-win-x64/node.exe --import tsx --test --test-name-pattern="bundles into|retrying HTTP intermediary" packages/proxy/scripts/staging/text-dispatch-workerd-wire-worker-conditions-successor.test.mjs
```

**2 selected cases PASS; overall machine report PARTIAL.** The [raw report](./2026-09-27-workerd-wire-worker-conditions-local-report.json), SHA-256 `ba3d80f080b5498bbb0480cca63eeb23798d50a533a9f8d15bb0a0be2d7fbcd1`, records 639 bundle inputs, Core source with zero Core dist, the 1/1/2 send counts and three closed local servers. All 646 source fingerprints were independently rechecked against the execution checkout. The native matrix was not selected and has zero completed modes.

The official portable zip was downloaded only from `https://nodejs.org/dist/v22.23.2/` and verified against that version's `SHASUMS256.txt`: zip SHA-256 `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`; executable SHA-256 `0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4`. No global installation or dependency mutation occurred.

The execution checkout's lock SHA-256 is `f9f477d173c8553fe2c10ee1f7217ca7a36db8d11afd056402afe98d71f940ff`. Comparing report pins with the primary checkout finds only its foreign lockfile differs (`0d2f390fdf0297762a88891beb3d675c63a949e039073492699c9bb274f1ac04`); every other pinned source and dependency file matches. The primary lockfile was not changed.

## Native result and CI boundary

An earlier successor run explicitly set `C02_RUN_NATIVE_WORKER=1` on Windows. It actually attempted native workerd and failed during startup with **`0xc0000005`**, not a skip. The [failure log](./2026-09-27-workerd-wire-windows-native-optin-failed.txt) is preserved. It produced no native send-count proof. The final Node 22 run did not repeat that known Windows failure.

Workflow dispatch step 10 now selects the successor. Linux must execute all three cases and all four native modes: 307/308/reset each one physical provider POST, explicit 429 three POSTs, matching permits, correct unknown classification, no redirect destination and no successor after the terminal outcome. The report marks missing cases/modes or skips as PARTIAL, and test or local cleanup errors as FAIL. This local evidence does not establish deployed intermediary policy, production Worker resource ownership, Hyperdrive behaviour or C02 completion. No remote SQL, paid Provider request or local PostgreSQL cluster was used.
