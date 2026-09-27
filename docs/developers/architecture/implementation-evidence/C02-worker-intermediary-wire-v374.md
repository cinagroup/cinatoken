# C02 Worker and intermediary physical-send wire (v374)

Date: 2026-09-25. Synthetic credentials and an owned `127.0.0.1` HTTP provider only. This evidence does not call a paid provider or deploy a Worker.

## Production path under test

`packages/proxy/scripts/staging/text-dispatch-workerd-wire-v374.test.mjs` bundles the current `proxyChatCompletions` and `createRequestDispatchBudget` into a real Worker entry. It gives that entry 40 distinct synthetic routes and a provider endpoint fixed to the owned loopback port. The native test uses Miniflare/workerd fetch, not a replaced `globalThis.fetch`. The provider records each HTTP request after receiving its full body. Cases are 307, 308, socket reset after the complete POST, and explicit 429. The assertions require respectively 1, 1, 1, and 3 physical provider POSTs; one permit per POST; no redirect-target hit; and no successor after an unknown outcome. The explicit 429 case tests the allowed three-attempt ceiling.

On this Windows host, an existing Miniflare OAuth fixture independently exits with workerd `0xc0000005` before executing Worker code. The native case therefore skips by default on Windows and runs on the `ubuntu-latest` dispatch-safety job. Set `C02_RUN_NATIVE_WORKER=1` to attempt it on Windows. The production bundle check does run locally. **There is no local native Worker send-count result yet.** A green Linux CI run is required before treating the native matrix as evidence.

## Executed intermediary counterexample

The same test file has an executable Node socket counterexample using the production Chat proxy and request budget. The Gateway sends once with `redirect: 'error'` to a local relay. That relay uses an HTTP client's default redirect following. Its provider returns 307 to a same-origin sink. The relay forwards the original POST body and Bearer again, then returns a valid completion to the Gateway. The assertions observe **1 Gateway permit, 1 relay request, 2 complete provider POSTs with equal body and credential**. Thus an application's one-fetch counter cannot prove C02.6 if an intermediary can follow redirects or retry after an uncertain send. This intentionally demonstrates an unsafe relay configuration; it does not assert that Cloudflare or a deployed intermediary uses that configuration.

## Verification and remaining gate

`node --import tsx --test packages/proxy/scripts/staging/text-dispatch-workerd-wire-v374.test.mjs`: **2 pass, 1 native Worker skip, 0 fail** on Windows. `node --check` passes. Test SHA-256: `9b6a96ba25259f0cdca27dad9ed9baeed0b779091639032de93c459f397a1aa2`.

The Linux CI job must run the native case. The physical C02.6 gate also needs an inventory and independent proof of every actual deployed HTTP/SDK/Cloudflare intermediary's retry and redirect policy, plus provider-side duplicate/acceptance observations for unknown and success outcomes. No application-only change can certify an unobserved intermediary or a supplier's internal retry. C02.5, C02.6, and C02.G remain open.
