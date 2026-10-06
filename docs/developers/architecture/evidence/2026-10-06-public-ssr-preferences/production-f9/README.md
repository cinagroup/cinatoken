# f9 production verification evidence

Source commit: f9b9140f7fdc35b4bddcd27e13df14cb2e444a34.

`index.json` records each original file path, byte length, SHA256, timestamp and ZIP member. `raw-evidence.zip` stores every original byte; identical payloads share a content-addressed member. The archive is reopened and every mapped original file is compared against its decoded member, with CRC and exact bytes/SHA checks. No raw failures are rewritten. Selected authoritative reports are also copied as plain JSON for review.

The production V4 browser matrix is independent of real authentication. The original HTTP V1/V2 matrices remain actual exit 1 with 167/177 and 175/177 passing. A separate five-download run remains actual exit 1 with 3/5 passing and two 60-second timeouts; partial bodies and cleanup are saved. A read-only union of V1/V2 fully successful bodies covers all158 assets with154 overlapping buffers compared. This proves complete artifact representation bytes, not that any original request matrix or 30/60-second performance gate passed. Read the asset coverage report and independent review for exact per-request provenance.

Raw commands, logs, failed harness runs, local/Linux fixture lifecycle, Chrome cleanup, same-SHA CI, exact Git source archive proof, release manifests and Cloudflare read-back are all mapped in the index. OAuth/workspace/Key, BFCache, original natural cancellation, full business/database/performance/rollback gates remain outside the proved scope.
