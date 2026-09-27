# C02 direct text response-reset matrix (v377)

Date: 2026-09-25. This is a local Node socket test using only synthetic provider credentials and an owned `127.0.0.1` HTTP server. It calls the current text drivers and Gateway proxy functions; it does not deploy a Worker or call a paid provider.

## Executed boundary

`packages/proxy/scripts/staging/text-dispatch-response-reset-v377.test.mjs` covers OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini `generateContent` / `streamGenerateContent`. For each protocol it tests non-stream and stream request modes at two levels: the driver itself and Gateway failover with 40 candidate routes. The local provider reads the **entire declared Content-Length and parseable JSON POST** before destroying the socket without response headers. The fixture records physical requests at the provider HTTP server, including path and synthetic credential. It does not mock `fetch`.

| Path | Direct driver after completed POST/reset | Gateway with 40 candidates |
| --- | --- | --- |
| OpenAI Chat, non-stream and stream | 1 physical POST, 1 permit, thrown unknown outcome | 1 physical POST, 1 permit, 502, unknown outcome and failover forbidden |
| OpenAI Responses, non-stream and stream | Same | Same |
| Anthropic Messages, non-stream and stream | Same | Same |
| Gemini generateContent / streamGenerateContent | Same | Same |

The current drivers use one `fetch` with `redirect: 'error'` and mark a rejected fetch as an unknown upstream outcome. The Gateway carries that classification through `failoverDispatch` and stops before another route. The provider's complete-body observation distinguishes this case from a pre-dispatch DNS or connection failure. In this local direct-transport case, **40 configured candidates still yield one provider POST** after response loss.

Command from repository root: `node --import tsx --test packages/proxy/scripts/staging/text-dispatch-response-reset-v377.test.mjs` — **16 pass, 0 fail, 0 skip** on Windows Node v24.14.1. `node --check packages/proxy/scripts/staging/text-dispatch-response-reset-v377.test.mjs` passes. Fixture SHA-256: `098cebcc03effdd3e60acc490c4e6055b32195a713a21e2e0a5202bdc5b072f7`.

## Scope remaining

This observation is limited to a direct local Node `fetch` → owned provider socket, with reset **before HTTP response headers**. It does not prove post-header stream-reset behavior, TTFT expiry, a deployed Cloudflare Worker, or the actual route endpoint/intermediary chain. The separate [v376 relay counterexample](./C02-relay-reset-physical-send-v376.md) demonstrates that a relay can perform two full provider POSTs behind one Gateway permit while returning a 200 response, so the direct result cannot serve as the C02.6 physical-send ceiling for an unknown deployed chain. The Linux native Worker matrix and deployed intermediary retry/redirect policy evidence remain necessary. C02.5, C02.6, and C02.G remain open.
