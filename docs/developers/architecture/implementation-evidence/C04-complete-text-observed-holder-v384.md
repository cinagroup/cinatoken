# C04 v384 private holder invocation fact

This review-only bridge composes the existing private v365 holder with the
dedicated v367 holder-result client. It does not change the default v365 holder
or install a production route. The bridge is explicitly constructed only by
the [v384 native fixture](../../../../scripts/db/cutover/postgres-complete-text-observed-holder-v384.native.test.mjs).

## Verified behavior

The holder independently reads the v360 quote and route, reconstructs the
OpenAI Chat upload with its own credential, and calculates the upload SHA-256.
Separate direct PostgreSQL LOGINs acknowledge v362 grant, v365 custody, and
v365 send-start after COMMIT and connection close. The
[v384 bridge](../../../../packages/proxy/src/services/private-complete-text-observed-holder-v384.ts)
then calls `fetch` once. Only after that invocation does it submit a
`fetch_invoked` observation with the holder's upload SHA through the v367
result client. It waits for the fact COMMIT and close outcome before returning
the Response. It never records `provider_usage`, a zero-charge observation, or
`provider_bill`.

The isolated PostgreSQL 18.6 fixture returned **PASS, 27/27 stages, cleanup
PASS**. Its owned HTTP loopback received one POST. The committed v362 grant,
v365 send-start, and v366 fact shared `grant_id`, `holder_run_id`,
`send_start_id`, and the hash of the loopback's received upload bytes. A new
holder instance with the same envelope and attempt nonce made no second POST.
The [JSON report](C04-complete-text-observed-holder-v384-report.json) contains
all 25 source SHA-256 pins; the final fixture pin
`1676c3652e8cdb8064769525d10904897ffc45b02e27abfb61ce1f4a5a7d01fb`
matched the file after the final run. `npx tsc --noEmit -p
packages/proxy/tsconfig.json` passed.

The fixture also established these conservative outcomes:

- Replaying the same v366 fact nonce and evidence returned the original fact
  ID. Changing the evidence kind under that nonce was rejected.
- A `no_fetch_attestation` stored before send-start did not prevent a later
  send-start; replaying that nonce after start conflicted. It is not a durable
  no-send fence.
- A caller-visible error injected **after** the direct v367 client received
  COMMIT and close acknowledgement did not return the Response or cause another
  POST. This is not a physical PostgreSQL COMMIT/close ACK-drop test.
- An endless SSE Response was aborted and its unhanded body cancelled when
  the fact port rejected. A synchronous fetch throw left a committed
  possible-send start and no invocation fact. A disconnected POST and a
  partial SSE body produced no usage or zero-charge fact.

## Scope and next integration

`fetch_invoked` means the holder called `fetch`. It does not establish that a
Provider received the entire body, accepted the request, reported usage, or
billed it. A committed v365 send-start remains a possible send even when
`fetch` or fact recording fails. The v384 bridge waits for an in-flight fact
write before surfacing a transport error; a stalled database call can prolong
that error. This review-only code has no durable fact retry scheduler or
liveness guarantee. It never retries the physical POST.

Facts in this fixture bind initial custody and send-start **epoch 1**. The
v370 renewed-fact SQL source was reviewed and SHA-pinned but was not installed;
the fixture does not prove epoch 2+ facts, renewed stream survival, or
post-renewal Provider usage. The loopback is not a Provider, and no deployed
Worker, real Provider bill, atomic four-hold closer, buyer settlement, or
production activation was exercised. The next platform integration must wire
the real Chat v360/v361 path to the private holder and a separate terminal
closer that consumes typed holder and Provider facts without treating this
invocation observation as charging authority.
