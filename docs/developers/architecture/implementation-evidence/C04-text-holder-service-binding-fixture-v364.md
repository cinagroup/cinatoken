# C04 v364 local two-Worker holder binding fixture

## Scope

This is a review-only staging fixture. `chat-holder-gateway-v364.ts` calls
`chat-holder-private-v364.ts` through a named `TEXT_HOLDER` HTTP Service
Binding. Both [Wrangler configs](../../../../packages/proxy/scripts/staging/wrangler.chat-holder-gateway-v364.jsonc)
and the [private config](../../../../packages/proxy/scripts/staging/wrangler.chat-holder-private-v364.jsonc)
set `workers_dev: false`, `preview_urls: false`, and `routes: []`.
The test's Miniflare configuration creates exactly two Workers, using the
names and binding target from those configs. No provider endpoint is called.

The request across the binding is the six-field v363 envelope: `requestId`,
`quoteId`, `attemptNonce`, `candidateIndex`, `routeTargetId`, and
`finalBodyUtf8`. The private Worker caps the entire serialized envelope at
6,299,648 bytes while reading it (six times the v363 body cap plus 8 KiB for
JSON escaping and other fields), accepts exactly these six fields, checks the
UUID and trusted synthetic quote/route/body digest, and emits a fixed error
without echoing rejected input. Its synthetic credential and provider URL are
compiled only into the private Worker bundle; a bundle assertion checks that
neither appears in the gateway bundle. The gateway relays only the response
body and two fixed headers. A local KV namespace observes the first accepted
request, the release of a second SSE chunk, and source cancellation. It is
test instrumentation, not an idempotency or grant store.

The fixture follows the existing private Images binding configuration pattern
and Cloudflare's [Service Binding HTTP](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
and [multiple Workers in Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/core/multiple-workers/)
documentation. Binding shape was checked against the installed Wrangler
4.127.1 schema and generated `Fetcher`/`KVNamespace` types. The generated
environment declarations are checked into the fixture.

## Local verification on Windows, 2026-09-25

| Check | Result |
| --- | --- |
| In-process contract test, `node --import tsx --test packages/proxy/scripts/staging/chat-holder-binding-v364.node.test.mjs` | 2/2 pass: byte cap, six-field rejection, header filtering, delayed stream, source cancel |
| Native two-Worker test, `node --import tsx --test packages/proxy/scripts/staging/chat-holder-binding-v364.test.mjs` | Config assertion passes; 3 native cases skipped on this host |
| `npm run typecheck:images:staging -w @octafuse/proxy` | Pass |
| `wrangler types ... --check` for both new configs | Both generated declarations current |

Forced native execution (`C04_RUN_NATIVE_WORKER=1`) failed before either
Worker executed: Miniflare reported `ERR_RUNTIME_FAILURE` and workerd exited
with Windows `0xc0000005` access violation. The repository's pre-existing
`asr-upload-workerd.test.mjs` fails with the same startup error. This was
reproduced both under the default sandbox and elevated execution, and with
installed workerd binaries dated 2026-08-28 and 2026-08-20. `wsl --list`
reported no available distribution. The native test skips this exact known
Windows startup case by default; on a capable host it runs all three cases.
Other runtime errors are not converted to skips.

## Evidence boundary

The two Worker source/config/test artifacts are ready for a native Service
Binding run, but this Windows host has **not verified** inter-Worker stream
delivery or cancellation propagation. The 2/2 Node tests exercise the same
handlers with an in-process binding stand-in and cannot substitute for native
workerd evidence. The source uses a fixed synthetic quote, route, credential,
and provider URL; it has no durable v362 grant, independent database lookup,
real provider fetch, billing settlement, live Chat wiring, remote deployment,
or production credential custody. C04 remains open.
