# C04 final Chat quote input and prepared egress bridge (v360 review)

2026-09-25. This is a default-off, local integration slice around the [v360 complete flat-text quote proposal](./C04-authenticated-complete-text-quote-v360.md). It is not a production reservation or dispatch authorization.

## Request facts

In the opt-in PostgreSQL Chat owner path, `chat.ts` hashes the bounded original ingress bytes before JSON parsing. It captures the final Chat body only after session routing, preset resolution, request Guardrails, candidate normalization and route planning. `chat-final-quote-input.ts` canonicalizes that final body with explicit ordered `model`/`models`, hashes its exact UTF-8 bytes, and locally rejects a changed body or plan before dispatch and settlement. The real Chat route test uses a preset system message, preset temperature and duplicate fallback IDs; the owner sees the transformed body, deduplicated order and the SHA-256 of the original whitespace-containing ingress bytes.

`postgres-complete-chat-quote-v360.ts` is an **unused review-only client** for this input. It first calls v356 with the actual bearer and original-body digest through the capability issuer's direct LOGIN, waits for its transaction and close acknowledgement, then calls v360 through a different quote issuer LOGIN with the final UTF-8 body. It compares the returned request ID, final digest, ordered models, platform credential class and exact `threeAttemptCeilingMicros = 3 × maxPerAttemptCeilingMicros`. It never accepts caller target IDs or a caller amount. An unconfirmed capability-client close prevents the second call. The SQL function accepts at most 1 MiB, so the adapter rejects a larger final body even though ingress permits 50 MiB. The client is not invoked by the production route because no manifest-backed budget admission or physical grant exists yet.

## Send boundary

The text drivers now prepare an immutable identity immediately before `fetch`: actual URL digest, `POST`, frozen JSON wire-body digest and length, and hashes of the credential values actually placed on the wire. The opt-in Chat owner path requires that identity before its existing budget callback in both per-model and global `partition=none` dispatch. Driver loopback tests compare those commitments to a real local HTTP request; failover tests reject missing/stale identities. The single-grant local gate also prevents a second pre-fetch callback or fetch after the first granted send. The raw URL and secrets are excluded from the callback object, since a Gemini query key may be present in the URL.

This identity is produced and checked inside the same Worker. It does not make that Worker an independently trusted credential holder. A future grant must compare it with a committed manifest row and a live route/credential revision, and the actual secret holder must enforce the grant. The v360 final-body digest and wire-body digest differ when a driver applies route defaults or replaces the public model with the provider model; the future grant needs a specified transformation binding, not an assumed equality.

## Local verification

| Command or fixture | Result |
| --- | --- |
| `npm run test:complete-chat-quote -w @octafuse/proxy` | 10/10 |
| Real Chat handler tests with a synthetic PostgreSQL facade and owner factory | 6/6 |
| `node --import tsx --test packages/proxy/src/services/model-fallback-global-dispatch.test.ts` | 6/6 |
| `npm run typecheck -w @octafuse/proxy` | PASS |
| Text prepared-attempt loopback and focused boundary tests | 72/72; see [driver evidence](./C04-text-prepared-attempt-identity-review.md) |
| v360 isolated PostgreSQL 18.6 fixture | 11/11 stages, cleanup PASS; see [SQL report](./C04-authenticated-complete-text-quote-v360-report.json) |

The suite is registered in `proxy-dispatch-safety.yml`; Linux CI was not run locally. No formal migration, deployed role/Hyperdrive connection, remote SQL, cloud request or production switch was changed.

## Remaining acceptance gate

The route still computes ordinary and Guardrail holds in the Worker and its opt-in owner uses the existing v350/v351 reservation APIs. It does **not** call v360, reserve exclusively from the committed v360 parent, or obtain a per-attempt committed grant from its manifest. It cannot assert that original-to-final transformation was legitimate in PostgreSQL, that a newly added route after quote commit is refused by the DB, or that an independently controlled holder physically used the quoted secret and endpoint. Shared Key, BYOK, tiered/multimodal and other excluded request classes have no complete quote. C04.1–8/G and the related physical-egress gate remain unchecked.
