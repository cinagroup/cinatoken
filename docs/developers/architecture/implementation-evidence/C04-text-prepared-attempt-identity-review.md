# C04 text prepared-attempt identity (local review evidence)

The OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini content drivers now construct a frozen `PreparedTextAttempt` beside their actual `fetch` call. The optional delegated `beforeFetch` callback receives:

- the selected route identity and a digest of its source endpoint/key configuration captured before asynchronous preparation;
- `POST` and SHA-256 of the **exact URL string** passed to `fetch` (including a Gemini query key); the URL itself is omitted because it can contain a credential;
- SHA-256 and byte length of the frozen JSON projection that the upload stream encodes; and
- location-specific SHA-256 fingerprints of the credentials actually sent in Authorization, `x-api-key`, Gemini `key` query parameters, or URL userinfo. A pre-existing Gemini query key fingerprints that effective value rather than the unused provider key.

The JSON digest replays the same private, frozen projection through the same paged encoder. It does not consume the transport stream or materialize a second whole JSON string. The prepared object retains no raw URL, header, body, or secret. The driver retains its prepared URL, headers, and upload stream across the admission await, so mutating the source request or route then cannot change the wire attempt already described.

`failoverDispatch` offers `requirePreparedTextAttemptIdentity`, default off. When enabled with the delegated boundary, a missing, mutable, structurally invalid, or route-stale identity produces a local 403 before quote capture, admission callback, budget consumption, or `fetch`. A trusted driver must still supply the identity; the structural check is not an independent attestation of an arbitrary custom dispatch function.

## Verification

- `node --import tsx --test packages/proxy/src/services/egress/prepared-text-attempt-wire.test.ts packages/proxy/src/services/egress/text-dispatch-boundary.test.ts packages/proxy/src/services/failover-dispatch.test.ts` — 72/72 passed.
- The new wire test is registered in the Proxy text-stream, dispatch-safety, and unit test scripts. `npm run test:text-stream -w @octafuse/proxy` — 190/190 passed.
- `node --import tsx --test packages/proxy/src/services/egress/vertex-service-account.test.ts` — 64/64 passed, including cancellation during OAuth before the inference boundary.
- The loopback server compared URL/method/body and actual wire credentials for Chat, Responses, Anthropic, Gemini query key, Gemini pre-existing query key, and Gemini bearer. It also checked the prepared object does not serialize the raw credential.
- Mutation of caller JSON and route key after preparation left wire bytes and Authorization unchanged; the route-stale matcher rejected the changed source.
- Missing and stale identities were denied before the grant callback and fetch; the real Chat driver crossed the enabled failover identity gate and sent once.
- `npm run typecheck -w @octafuse/proxy` and `git diff --check` passed.

## Remaining durable gate

This is a local, default-off wire identity boundary. C04 still needs a complete DB-derived quote covering every eligible route/key/model and service tier, a transactionally reserved request budget, and a one-use PostgreSQL dispatch grant that binds this prepared identity to the fresh route generation and exact request owner. The grant must be checked immediately before each physical send, with expiry and uncertain-acknowledgement handling, then reconciled with settlement. No claim here proves a deployed grant or closes C04.
