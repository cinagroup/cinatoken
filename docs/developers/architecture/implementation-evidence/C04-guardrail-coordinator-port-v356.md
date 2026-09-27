# C04 Guardrail request owner to coordinator bridge (v356)

2026-09-25. **Local review only, default off.** The real Chat route and Worker configuration do not open this bridge or provision its database credentials.

The [request port](../../../../packages/proxy/src/services/postgres-guardrail-budget-request-port-v356.ts) composes the v355 extension owner and its v353 lifecycle owner. It routes Key-only BYOK reserve through strict, bounded database-clock recovery before the v351 admission function; paid fallback extension through v355; dispatch mark and pre-send release through v351; and post-dispatch full-ceiling forfeit through v353. It fixes request, user and Key identity before the asynchronous owner open and uses one admission timestamp for the requested lease windows. Failed or unconfirmed function/COMMIT results are not replayed by the port.

The [route-aware coordinator](../../../../packages/proxy/src/services/request-budget-admission.ts) now has an explicit `guardrailBudgetRequestPort` option. It snapshots request identity, amounts, intents, admission time and the selected port before its first await, then rejects a mismatched request/user/Key or missing fixed admission time before ordinary admission. With the option present, it never calls the runtime Guardrail repository: a recovery failure rejects paid admission, releases the still-pre-send ordinary reservation, and the cached rejected admission stops another attempt. Private BYOK's Key hold is marked before its first send; paid fallback uses the v355 extension before the ordinary dispatch mark. The authenticated Chat budget proof forwards this option. The legacy path is unchanged when no port is supplied.

## Verification

- `node --import tsx --test packages/proxy/src/services/request-budget-admission.test.ts packages/proxy/src/services/postgres-guardrail-budget-request-port-v356.test.ts`: **22/22 PASS**, including wrong identity before writes, mutation of request parameters and port selection across awaits, BYOK→paid ordering without runtime Guardrail DML, strict recovery failure without replay, and direct owner method mapping.
- `npm run typecheck -w @octafuse/proxy`: **PASS**.
- v355 function semantics were independently exercised against owned PostgreSQL 18.6 in the [v355 evidence](C04-guardrail-budget-dispatched-extension-v355.md). This new request port has mock-owner/coordinator tests, not a native end-to-end run.

## Remaining gate

No Chat request opens or closes the ordinary and Guardrail owners together. Future wiring must retain the port and await its close in a `finally` that covers admission-open failure; closing a client does not settle an existing reservation. The v350/v351 functions still accept caller-provided held amounts and do not independently verify the authenticated bearer or complete route quote. The v355 Key-only result now proves the requested lease is covered at extension COMMIT, but a future fetch-boundary check must also reject a paid send if that lease expires before physical egress. The v351 dispatch mark's pre-lock clock and multi-owner buyer settlement races need native review. Production credentials, formal migration, Worker/Hyperdrive lifetime, and D1/MySQL parity remain open.
