# C04 v381 real buyer journal integration

2026-09-25. **Review only; default off.** The [owned PostgreSQL 18.6 fixture](../../../../scripts/db/cutover/postgres-legacy-buyer-journal-integration-v381.native.test.mjs) installed the real v372 legacy buyer writer, real [v375 terminal reader](../../../../packages/core/migrations-proposals/postgres/legacy-buyer-terminal-reader-v375.sql), and [v378 durable journal](../../../../packages/core/migrations-proposals/postgres/legacy-buyer-commit-journal-v378.sql) together under separate buyer, terminal-reader, and journal LOGINs. It ran all 73 formal PostgreSQL migrations, the v2 economic producer and budget receipt proposals, the exact v368 held writer body, v371/v372 successor and ACL proposals, v347/v348/v349 buyer split, and v350 ordinary admission. The ordinary hold uses dedicated v350 admission; the fixture migrator seeds Guardrail windows and holds. It uses a minimal v362 grant table and fixture app rights, so it does not prove the full Guardrail admission chain. No formal migration, remote SQL, production credential, Worker, Provider, or scheduler was changed.

The fixture passed **14/14 stages with cleanup PASS**; see the [machine report](./C04-legacy-buyer-journal-integration-v381-report.json). Every financial writer callback was counted, and each terminal probe used a fresh dedicated reader LOGIN. The reader function was the real v375 SQL body, called through the v378 journal completion function against the previously committed expectation. `financial_facts_confirmed` retains its v375 meaning only.

| Case | Writer calls | Journal and reader result | Committed economic evidence |
| --- | ---: | --- | --- |
| Normal COMMIT response | 1 | Preparation visible from a second journal backend; ACK remained pending until a fresh v375 reader returned `confirmed` | One buyer log, audit, v2 event/attempt, settled holds, one debit; event marker and budget receipt both xid8 `865` |
| Writer COMMIT response lost | 1 | Transparent proxy dropped one real PostgreSQL `CommandComplete(COMMIT)`; writer reported `CONNECTION_CLOSED`; journal recheck returned `confirmed` | Same single debit and one log/event/audit; event marker and budget receipt both xid8 `881` |
| Writer COMMIT delayed | 1 | Original COMMIT frames stayed at the intermediary while the writer backend transaction remained open; first fresh reader returned `unconfirmed`. After those exact frames reached PostgreSQL, another fresh reader returned `confirmed` | No buyer log/event/new receipt before release; afterward one debit and matching event/receipt xid8 `897` |
| Journal prepare COMMIT response lost | 0 | The [v381 proxy](../../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs) forwarded one extended-protocol journal COMMIT, observed backend `CommandComplete(COMMIT)`, suppressed that response, and closed the client. A separate journal backend saw the committed `prepared` row | Buyer account, holds, log, audit, and event stayed at their admission baseline; the financial writer never started |

The normal path recorded distinct journal preparation and verification backend PIDs (`10076`, `1476`) before the writer callback. The delayed path recorded distinct terminal-reader PIDs (`16700`, `7860`) on the two observations. The machine report includes all scenario snapshots, proxy counters, reader PIDs, writer-call counts, receipt amounts, and source hashes. The delayed proxy models an intermediary holding client COMMIT frames; it does not show PostgreSQL internally delaying a COMMIT it already received. The two ACK-loss proxies suppress PostgreSQL command responses; they do not manipulate TCP ACK packets.

## Scope of confirmation

The immutable journal row stores caller-supplied expected financial facts and a caller-supplied SHA-256 of a synthetic request manifest. There is still no writer-side same-transaction receipt proving the complete model, route, protocol, Provider request/response bytes, or authenticated Provider bill matches that digest. v375 compares the buyer log, economic event and attempts, producer transaction marker, budget receipt, ordinary hold, and narrow Guardrail terminal rows. It does not independently prove that Guardrail rows, unreserved windows, audit, and daily statistics were written by the same transaction. Receipt retention across the full automated and operator review period also remains uninstalled. The paths exercised here cover only the narrow non-grant, current-epoch, held `actual`/v2 buyer branch. No process crash was injected; stale-prepared recovery after a crash remains the separate v378 state-machine test, not a claim from this v381 run.

## Reproducibility pins

The report contains SHA-256 for the complete PG73 migration corpus and every proposal/support source loaded by this fixture. Key pins are:

| Source | SHA-256 |
| --- | --- |
| PG73 formal corpus | `23afef61a8a670e0af8c90e3a138f522e6b283b454e380a592bf85bca83108dc` |
| Real critical writer | `5eb87ae6c737f33488c5d03dc7fd797f3b1bf03504dad19c84166a9c9dfeff37` |
| v372 transaction helper | `880f94f1ba2acbbcf549727dd15ccaa058c79acc35c5b239ac4411ae39b6e07e` |
| v375 SQL reader | `4979a5404f768dc49b090125dcd71ef399f77a16fecef526610f37159aa451f0` |
| v378 SQL journal | `fa4f937f6ef876185d1c358029040677b419c25ac97c40c29d61cc7b57812f05` |
| v378 TypeScript caller/worker | `114a9d6d24ea433d0c5f69c5ffbd7d1f5e3e5e901943326ec4e43bd635f8100c` |
| v381 prepare ACK-loss proxy | `ab56fc79f90853c716694e8975f36f86cce756c79f901f0d4706d51122d12221` |
| v381 fixture | `86ffee2f569e3dae00c1a01a1d7836b7581201ae50d7250742057b53240eb821` |
