# C02 post-headers physical send boundary (v385)

Date: 2026-09-26. Status: **LOCAL_PASS / C02.5, C02.6, C02.G still open**.

## Executed cases

`packages/proxy/scripts/staging/text-dispatch-post-headers-v385.test.mjs` uses the current production Gateway text dispatchers and request budget, 40 candidates per case, and owned `127.0.0.1` Node HTTP servers. Four protocols (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini) each exercise three post-send outcomes:

1. The provider receives the entire POST, flushes HTTP 200 JSON headers, sends a partial body, then breaks the socket. Gateway returns a redacted 502 with `upstreamOutcomeUnknown` and `failoverForbidden`; one budget permit and one complete provider POST are observed.
2. The provider flushes HTTP 200 SSE headers but sends no first token. After a 50 ms synthetic wait, the test client aborts. Gateway records cancellation without dispatching any successor; one permit and one complete POST are observed. The test does **not** claim that a production first-token deadline fired.
3. The provider flushes HTTP 200 SSE headers, sends initial SSE bytes, then breaks the socket. Gateway exposes a stream error and sends no successor; one permit and one complete POST are observed. The HTTP response had already succeeded, so the stream error is not a zero-cost bill.

The final case places an intentionally retrying, buffering relay between Gateway and the owned provider. The provider receives a complete POST and sends HTTP 200 headers, but its response body breaks. The relay observes 200, fails while reading the body, and sends the *same complete POST with the same Bearer credential* a second time. Gateway receives a valid 200 completion and sees **one permit / one relay POST / two complete provider POSTs**. This is an executable counterexample to inferring physical sends from Gateway permits, even after an inner 200 response. It does not describe a deployed relay's actual policy.

## Verification

- `node --import tsx --test packages/proxy/scripts/staging/text-dispatch-post-headers-v385.test.mjs`: **13 pass, 0 fail, 0 skip** on local Windows Node v24.14.1.
- `node --check packages/proxy/scripts/staging/text-dispatch-post-headers-v385.test.mjs`: exit 0.
- Test SHA-256: `0dca06f9c8d73aa850d77fa92d22f6ac92d5ec961ab9695fde24d95f277275c5`.
- No production source, formal migration, remote SQL, deployment, or paid Provider call changed or ran.

## Remaining boundary

This validates the **local Gateway → owned endpoint** behavior. A full C02.6/C02.G acceptance needs the exact deployed paid-route endpoint chain and independent evidence that each intermediary and client layer neither follows a replaying redirect nor retries a possibly accepted request, or that every such physical send is included in the same hard budget. The v374 native Worker matrix remains unobserved on Linux. Provider billing and accepted-request facts remain independent of local usage or dispatch permits. The test does not confer request-wide replay protection across separate inbound HTTP requests.
