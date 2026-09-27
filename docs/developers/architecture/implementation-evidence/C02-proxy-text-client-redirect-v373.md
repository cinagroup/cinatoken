# C02 Proxy text client redirect audit (v373)

Date: 2026-09-25. This review traces an upstream HTTP redirect through the real Proxy text egress and public response paths. It adds a regression fixture; production code is unchanged.

## Boundary found in current code

OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini text dispatches set `redirect: 'error'` on the physical POST. Node's native fetch rejects upstream 3xx before those drivers receive response headers. The existing real-socket redirect fixture verifies one origin POST, zero redirect-target requests, one dispatch permit, and no later model/key attempt across these four protocols.

Embeddings and Rerank use `redirect: 'manual'`: their drivers can receive and return a raw 3xx with `Location` and mark the dispatched outcome unknown. The first step of `materializeNonOkResponse` may still hold those raw headers. The public route then calls `withUpstreamErrorCodeHeader`, which constructs a fresh error response and copies only a bounded `Retry-After` when applicable. An upstream `Location` does not reach the client. The trusted gateway-error path is selected from internal metadata, not an upstream header.

## New real Gateway loopback check

The new matrix in `packages/proxy/src/routes/v1/vector-request-lifecycle.test.ts` runs actual Hono authentication, model planning, vector dispatch, native Node fetch, error materialization, and public response over two local HTTP servers. A separate unguarded route is the negative control: a default-follow client repeats the exact POST body after 307 and 308. The actual Gateway endpoint receives a provider 307 or 308 pointing back at itself and returns 502 with no `Location`. Each case observes one Gateway POST, one provider POST, and one terminal log batch.

Matrix: Embeddings and Rerank, both `/v1/` and `/api/v1/` paths, 307 and 308: **8/8**. The complete vector lifecycle file passed **147/147**, Proxy typecheck passed, and the existing text redirect socket suite passed **112/112**. The vector file is already in the Proxy `test:dispatch-safety` script used by `proxy-dispatch-safety.yml`; the text socket suite is also in `text-redirect-safety.yml`. Linux CI was not run here.

The fixture extends its synthetic provider endpoint setting so route binding fingerprints still match the local HTTP URL. It does not alter route policy or production behavior.

## Next evidence

This establishes the Node loopback and current public text route behavior. C02.6 still needs native Workers and intermediary transport evidence that one claimed send cannot become several physical provider sends. C02.5 still needs complete unknown/success replay verification across all dispatch paths. C02.G remains open until the full route matrix and physical-send limit are verified.
