# C02 Admin Playground browser redirect fence (v372)

Date: 2026-09-25. Scope: the authenticated Admin Playground HTTP POST route, including its direct provider and tool responses. This is a local execution boundary; it does not establish the C02.G production send cap.

## Finding

The direct provider fetch already used `redirect: 'manual'`, but the Admin route copied the upstream status and `Location` header to the browser. The Playground page and tools panel both issue POST fetches without a redirect override. A 307 or 308 pointing at the same Admin route makes a browser-style default fetch preserve the POST body and invoke the route again. The route then sends another provider POST. The first run of the regression test against the unmodified route ended in Node fetch's `redirect count exceeded` error with an upstream that kept returning the redirect. This is a real replay path after the server's single-fetch check.

## Change

`packages/admin/lib/routes/admin/playground.ts` now rejects every upstream 3xx before constructing the browser response, starts cancellation of its body, and returns a 502 JSON response without `Location`. The check covers both route and tool branches. It leaves normal success and non-redirect failure responses on their existing path.

## Verification

`packages/admin/lib/services/admin/playground-upstream-redirect.test.ts` drives the real Hono route over a Node loopback HTTP server. For both 307 and 308, its separate unguarded route proves a default client fetch replays the identical POST body twice. The Admin route uses a synthetic provider response with a same-route `Location`: the final browser response is 502 with no `Location`, and the synthetic provider receives exactly one POST. The focused test passed **1/1** after the change. The complete Playground suite passed **50/50**, and Admin TypeScript checking passed.

The existing `test:playground` wildcard includes this test, and `proxy-dispatch-safety.yml` already runs that script. Linux CI has not run in this workspace.

## Remaining boundary

The test uses Node loopback and a synthetic provider. It does not measure Cloudflare Workers transport, an intermediate proxy, or all SDK and non-Playground clients. C02.5, C02.6 and C02.G remain open.
