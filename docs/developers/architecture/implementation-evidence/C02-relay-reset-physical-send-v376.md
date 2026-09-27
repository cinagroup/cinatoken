# C02 relay reset physical-send counterexample (v376)

Date: 2026-09-25. This uses synthetic credentials, a local Node Gateway process, an owned `127.0.0.1` relay, and an owned `127.0.0.1` provider. It neither deploys a Worker nor calls a paid provider.

## Executed boundary

`packages/proxy/scripts/staging/text-dispatch-relay-reset-v376.test.mjs` calls the current production `proxyChatCompletions` with 40 candidate routes and the current `createRequestDispatchBudget`. The OpenAI Chat driver sends its real POST through Node fetch to a local relay. The relay copies the request to a local provider with `redirect: 'error'`. The provider reads the entire first POST and then destroys only that response connection. The relay retries the same body and Bearer token on a second provider connection and returns a valid Chat completion. There is no HTTP redirect in this case.

Observed and asserted: **1 Gateway permit, 1 relay POST, 2 complete provider POSTs**, equal path/body/Bearer on both provider hits, and a 200 completion visible to the Gateway. The Gateway therefore has no unknown-outcome signal even though the first provider request was fully delivered. This is an intentionally unsafe relay policy, not evidence that a currently deployed intermediary has that policy. It complements the v374 redirect-follow counterexample by showing that a response reset can hide an additional POST even when every application-level redirect is blocked.

Command: `node --import tsx --test packages/proxy/scripts/staging/text-dispatch-relay-reset-v376.test.mjs` — **1 pass, 0 fail, 0 skip** on Windows; `node --check` passes. Test SHA-256: `03813d96adf2190c4abc0e813710a1378dd9afa0275c69673df0ffc2f00f79b5`.

## Current text path and unobserved hops

The four text route implementations (`chat.ts`, `responses.ts`, `messages.ts`, `gemini.ts`) call the corresponding proxy functions in `packages/proxy/src/services/proxy.ts`. Those functions dispatch through the protocol drivers in `packages/proxy/src/services/egress/`. OpenAI Chat, OpenAI Responses, Anthropic, and Gemini each call the platform `fetch` directly with `redirect: 'error'`; those four driver paths do not call an upstream model SDK. The endpoint is resolved from the selected route's `providerEndpoints`, which comes from provider configuration through `model-router.ts` and `@octafuse/core` endpoint resolution. Thus the application controls one fetch invocation and its redirect policy, while the selected endpoint may itself be a relay or aggregator. The repository's `wrangler.base.jsonc` has no explicit outbound HTTP service binding, but that file does not attest to deployed egress topology or Cloudflare's inner transport behavior.

The v374 native Worker fixture would observe requests received by an owned provider after workerd's fetch. A forced current-state run with `C02_RUN_NATIVE_WORKER=1` and `--test-name-pattern='native Worker fetch'` fails before Worker code: Miniflare reports `ERR_RUNTIME_FAILURE` and workerd exits with Windows structured exception `0xc0000005`. The runtime suggests a possible Visual C++ Redistributable issue but this is not a confirmed diagnosis. `wsl --list --verbose` (also retried outside the filesystem sandbox) reports no installed Linux distribution, and Docker/Podman are absent from PATH. The `ubuntu-latest` step is present in `.github/workflows/proxy-dispatch-safety.yml`, but the current GitHub CLI credential is invalid and the Actions/API pages were not readable, so no Linux result is claimed.

## Remaining C02.6 evidence

Run the v374 native matrix on Linux and retain its 307/308/reset/429 physical counts. Separately, identify the exact deployed endpoint and intermediary chain for each admitted paid text route, including any provider aggregator, and obtain independent retry/redirect policy evidence or provider-side accepted-request observations for that chain. A local platform-fetch invocation count or a relay configured in a test cannot establish the deployed chain's physical send ceiling. C02.5, C02.6, and C02.G remain open.
