# C04 native complete Chat quote, admission and private holder composition (v387)

2026-09-26. **Review only; production Chat remains unwired.** The [v387 native fixture](../../../../scripts/db/cutover/postgres-complete-chat-holder-dispatch-v387.native.test.mjs) closes the SQL-double gap in the [v385 local composition](./C04-real-chat-holder-dispatch-seam-v385.md). It calls `createCompleteChatHolderDispatchV385` with its default v360 quote and v361 admission clients, then uses the real v366 private reader, v362 grant, v365 custody/send-start and v367 result-fact client through the v384 observed holder. All database operations use separate direct LOGINs against one owned PostgreSQL 18.6 cluster. Neither quote/admission receipts nor `pending_unknown` are fabricated.

## Scope and observations

The fixture hashes owned ingress bytes, applies fixture transformations to the flat-text body, runs the actual model parser and `createFinalChatQuoteInput`, and supplies its current body/plan to the v385 seam. The plan is fixture data. Production preset and Guardrail middleware are not executed. The committed quote is independently read again by the private v366 client before the holder prepares the outbound body.

One positive request produces one complete POST at an owned `127.0.0.1` HTTP server. The test checks method, path, privately decrypted Bearer, exact parsed body, removal of public `models`, upstream model selection and response header filtering. The committed quote, admission, grant, custody/send-start and `fetch_invoked` fact share the expected identities. The received upload SHA-256 equals the grant, send-start, fact and fact evidence SHA-256. Admission reserves the database quote's full three-attempt ceiling across one ordinary and three Guardrail holds.

The fixture explicitly rewrites the prepared `https://v367-local.invalid/v1/chat/completions` URL to its owned HTTP loopback in `fetchUpstream`, preserving the method, body and authorization. The persisted URL digest still covers the prepared HTTPS fixture URL. This proves the composed SQL identities, body/auth construction and one complete local POST; it does not prove a socket transmission to the quoted HTTPS endpoint, Provider receipt or billing.

## Failure boundaries

| Boundary | Executed evidence | Durable state and egress |
| --- | --- | --- |
| Binding response loss | The Binding stand-in invokes the real holder, waits for its committed fact, cancels the unreturned response and throws. | One complete POST, one unknown grant, one send-start, one invocation fact; all four holds remain dispatched. This is an injected caller exception, not a dropped Service Binding packet. |
| Second full Gateway instance | Re-enters default v385 using the same request identity and original final input. | Real v356 capability issuer returns `conflict` before quote/admission replay or Binding. No additional POST. |
| Second private holder instance | Uses the retained six-field envelope with a fresh nonce and performs another real v366 read and v362 grant call. | Real v362 returns `pending_unknown`; no new send-start, fact or POST. This is a distinct retry boundary from the full Gateway instance. |
| Admission COMMIT response loss | The [v381 wire proxy](../../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs) forwards the admission client's original COMMIT. It observes PostgreSQL `CommandComplete(COMMIT)`, suppresses that frame and closes the client socket. | An independent direct SQL read sees one admission and four reserved holds. The default v361 client rejects, v385 never calls Binding, and grant/start/fact/POST counts remain zero. This is local PostgreSQL protocol response loss, not TCP ACK loss or remote pooler evidence. |
| Authenticated identity mismatch | Real v356 result disagrees with the caller's API-key identity; the v360 direct client rejects within the issuer transaction. | No quote, admission, grant, hold or Binding/POST. |
| Unknown bearer | Real capability issuer returns `unauthorized`. | No quote or Binding/POST. |
| Missing Guardrail intents | Quote succeeds; real no-amount v361 admission returns `missing_guardrail_intents`. | One committed quote, no admission or holds, no grant/start/fact or Binding/POST. |

## Verification and remaining gates

Run from the repository root with `GATEWAY_NATIVE_PG_BIN` pointing to the owned PostgreSQL 18.6 binaries:

```powershell
node --import tsx --test scripts/db/cutover/postgres-complete-chat-holder-dispatch-v387.native.test.mjs
```

The final local run passed **1/1 native test, 19/19 stages, cleanup PASS**, using PostgreSQL **18.6**. The [machine report](./C04-complete-chat-holder-dispatch-v387-report.json) records native version, stage results, cleanup outcome, wire-proxy observations and source SHA-256 pins. It observed exactly one extended-protocol admission COMMIT, one backend completion and one dropped completion response. `node --check` also passed. The Windows sandbox could not create PostgreSQL's restricted token on the first startup; an independent `pg_ctl status` confirmed that owned failed cluster had no server running, and the fixture was rerun with approved local process execution.

The installed formal PostgreSQL corpus remains **73 migrations**; all new behavior is exercised using review-only proposals and runtime clients. This fixture adds no production migration, route switch, remote database action, deployed Worker or paid Provider call. It observes two local POSTs: one positive and one whose Binding response is lost. It records only `fetch_invoked` facts, with no provider usage, zero-charge proof, provider bill, buyer settlement or financial terminal.

The production Chat handler, Worker Service Binding transport, Hyperdrive, D1/MySQL parity, long streaming renewal, real deployed intermediary behavior and atomic financial close are still outside this proof. The v385 source is still not called by production Chat. A committed `fetch_invoked` fact says the holder called fetch; it provides no authoritative cost or complete zero-charge evidence. C04 acceptance gates remain open.
