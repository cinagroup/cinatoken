# C04 terminal shared-key quote reference propagation (v357)

2026-09-25. **Review-only local evidence.** This change carries a committed quote-attempt reference through terminal text dispatch results so the selected route and selected reference identify the same shared-key attempt. It does not enable production economic settlement.

`failoverDispatch` now returns the route's exact quote reference for terminal non-2xx responses, transport errors, first-granted stops, dispatch and auxiliary-auth limits, and deadline or cancellation responses. A deadline waits for an in-flight durable quote claim before taking its terminal snapshot. If the next eligible route has entered preparation but has neither claimed a quote nor begun dispatch, the snapshot selects the immediately preceding claimed route and preserves its send/outcome facts. Once the new route claims a quote or begins dispatch, its own route and facts are selected. The fallback is cleared when an intervening route has no quote, so an old reference cannot attach to a later unquoted route.

The tests cover exact final references after HTTP 400/429, first-granted rejection, limit stops, socket loss, invalid response bodies, a sent attempt deadline, a deadline during durable claim, and deadlines on either side of a second route's quote claim. They also check that a final non-shared route does not inherit an earlier shared reference. A returned reference is a durable pre-send claim, not proof of network delivery or actual usage; unknown transport and usage remain unknown.

Verification from `packages/proxy`:

- `npx tsx --test src/services/shared-key-quote-attempt.test.ts src/services/request-deadline-dispatch.test.ts`: 49/49 passed.
- `npx tsx --test src/services/failover-dispatch.test.ts`: 59/59 passed.
- `npm run typecheck`: passed.
- `npm run typecheck:dispatch-safety`: passed.

If the database commit acknowledgement for a quote claim is lost, the caller cannot obtain a validated reference and must stop before dispatch. Recovery of such a durable but unacknowledged claim remains the separate orphan-claim path. The selected reference and request-local handoff do not independently prove physical send, supplier cost, or complete provider usage.
