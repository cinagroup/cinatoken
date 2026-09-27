# Public upload fixture redirect expectation successor

2026-09-27 · predecessor `f6586260e6e0274902cb7569135d3550c89fdabd`

## Failure and change

The f658 Linux full unit step9 failed 72 of 4346 tests (4274 passed). All failures were the public upload resource matrix in `request-dispatch-limit.test.ts`: the fetch mock still required `redirect:'error'` while the four ordinary text drivers used `manual`. The mock assertion threw, the driver returned an unknown502, and the success assertion expected200. Workerd step10 was skipped by that failed prerequisite.

This successor changes only line108 to expect `manual`. Inverting that literal restores the f658 file byte for byte, including line endings. All 378 assertions remain; all other 453 Proxy TS/TSX files and all six manual/304 runtime sources are byte identical to f658. The ordinary text error-expectation scan found no other stale mock; default-off holder and independent BYOK/relay controls remain unchanged.

## Actual local evidence

- Official portable Node22.23.2, isolated locked-dependency checkout.
- Before the patch: the old `/v1/chat/completions/json/full` case failed with actual502 versus expected200 ([preserved log](./2026-09-27-request-dispatch-manual-fixture-first-local-failed.txt)).
- After the patch: all 72 cases passed, zero failures/skips ([test log](./2026-09-27-request-dispatch-manual-fixture-local-tests.txt)). These cover nine public aliases × JSON/SSE × four upload modes with the original body, request-count, admission, usage and cleanup assertions.
- Independent read-only review confirmed the single literal, 378 retained assertions and 453 unchanged Proxy sources.

Core327 remains `477233bf3c31f1ef3ca847ba3e36179fef50f85e1ba3c909a847706bff2800b0`. Proxy454 is the explicit successor `13f9a76eaa24c3b34f143ac6921c2769c7b68d1d7f80ff3c332068b27b383f04` (previous `1c0e8004ed308eeae2209ed03dede60b458eb1e0b14991d0fa7bdd65c6fb645f`), changed only by this test path.

The [machine report](./2026-09-27-request-dispatch-manual-fixture-local-report.json) records source/log hashes, commands and the Linux failure. The previous [282-case manual/304 report](./2026-09-27-text-workerd-manual-redirect-local-report.json) is unchanged.

## Scope

This is a tests-only correction. No runtime, SQL/ACL, production guards, default-off features, dependencies or workflow changed. This report does not claim a full local suite, financial/native or Worker acceptance. Fresh full Linux CI is pending. All owned local test processes ended; no owned PostgreSQL or build process remains.
