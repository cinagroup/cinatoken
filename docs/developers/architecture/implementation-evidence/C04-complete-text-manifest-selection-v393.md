# C04 v393: quoted manifest versus actual Chat routing

## Scope

This local PostgreSQL counterexample determines a concrete requirement for the future secretless Chat Gateway. v360 quotes all active own-model routes as a conservative budget/source superset. v365 returns that committed manifest in candidate/route-ID order. Neither contract promises that the first manifest member is eligible for the current Chat surface.

The fixture uses two fallback models, real v356/v360/v365 SQL and separate LOGIN roles. Its comparison uses the existing PostgreSQL repositories, `resolveRoutesForSurface`, and `buildModelFallbackPlan`. It does not fabricate a credential-bearing `RouteResult`, mock a SQL outcome, or send to a provider.

Final local execution: PostgreSQL 18.6, native **1/1 PASS**, **11/11 stages PASS**, cleanup **PASS**. Independent post-run verification matched all **30 file pins**, the **327-file core TypeScript corpus**, and the **73-file formal migration corpus**. The related existing repository suite passed **4/4**.

- [Native fixture](../../../../scripts/db/cutover/postgres-complete-text-manifest-selection-v393.native.test.mjs)
- [Source-loading configuration](../../../../scripts/db/cutover/postgres-complete-text-manifest-selection-v393.tsconfig.json)
- [Execution report](C04-complete-text-manifest-selection-v393-report.json)

## Reproduction

The fixture creates an owned loopback PostgreSQL 18.6 cluster, installs the 73 formal migrations and reviewed v356/v357/v359/v360/v365 proposals, and cleans up only that cluster. Use an existing PostgreSQL binary directory:

```powershell
$env:GATEWAY_NATIVE_PG_BIN = '<existing PostgreSQL 18.6 bin directory>'
$env:TSX_TSCONFIG_PATH = 'scripts/db/cutover/postgres-complete-text-manifest-selection-v393.tsconfig.json'
node --import tsx --test scripts/db/cutover/postgres-complete-text-manifest-selection-v393.native.test.mjs
```

The separate tsx configuration resolves `@octafuse/core` to current source. The report pins the fixture, relevant Proxy sources and SQL proposals, a complete core TypeScript source corpus, and the formal migration corpus. The fixture verifies the loaded fixture hash and source pins again before success.

## Real repository defect repaired during reproduction

The first real selector execution exposed a separate PostgreSQL adapter defect. Drizzle 0.45.2 changes the shared postgres-js client's JSON/JSONB serializers to pass values through. The three endpoint batch readers supplied `pg.json(ids)`, so a JavaScript array reached the wire encoder and raised `ERR_INVALID_ARG_TYPE` before PostgreSQL could execute the query.

The authorized repair changes only those three JSONB array read parameters in `packages/core/src/db/postgres/model-endpoints.impl.ts` to `JSON.stringify(ids)`. Their SQL already explicitly casts `$1::jsonb`. JSON field writers and the global driver serializers remain unchanged. The existing SQL repository tests were updated for the serialized parameter contract and passed 4/4. The native fixture exercises all three repaired readers through the real Drizzle-initialized storage client before running both existing selectors; it does not substitute an adapter or repair serializers in test code.

The report also pins the installed Drizzle driver source/package and postgres-js JSON serializer source/package, read without modification. Historical evidence reports retain the source hashes used at their own execution time.

## Topology and expected counterexample

All routes use default-group, platform-credential, flat-text OpenAI Chat passthrough. They have active providers/pools and genuinely verified v359 source attestations. Endpoint capability evidence and output capacity satisfy the existing Chat planner. No route/source mutation is needed between quote and comparison.

| Candidate | Surface | Pool | Active route | Actual Chat eligibility |
| --- | --- | --- | --- | --- |
| `v393-alpha` | exact `openai/chat` | A | `v393-route-z` | Selected |
| `v393-alpha` | fallback `openai/*` | B | `v393-route-a` | Excluded while exact surface exists |
| `v393-beta` | exact `openai/chat` | beta | `v393-route-beta` | Selected for fallback candidate 2 |

The same request body has `model: v393-alpha`, `models: [v393-alpha, v393-beta]`, ordinary text messages, and an explicit completion limit. The real Chat fallback plan must accept it and expose only `z` for alpha and `beta` for beta. A separate real row-to-route resolution confirms that `a` is otherwise valid.

v360 must issue a three-route quote and v365 must return:

```text
candidate 0: route-a, route-z
candidate 1: route-beta
```

Therefore a caller choosing `manifest.routes[0]` would select `route-a`, even though the existing Chat surface selects only `route-z`. The manifest remains useful as an authority membership check and conservative quote set. Its lexicographic order must not become routing policy.

## Minimum design required by this evidence

The preparation adapter can capture the final normalized body and ordered models before any credential-bearing plan exists. After the committed quote, a trusted, credential-free routing projection must provide enough information to preserve actual selection:

| Layer | Necessary safe fields/behavior |
| --- | --- |
| Binding | Request ID, quote ID, final-body hash, candidate index/model, freshness and v359 route-source binding |
| Eligibility | Actual exact/wildcard/legacy surface resolution; selected surface/pool; complete eligible route set intersected with the quote manifest |
| Existing strategy | Route priority/weight; stable provider identity; model policy, pool strategy, priority-tier overrides and effective global default |
| Ordinary Chat defaults | Verified output capacity and comparable endpoint prices; provider health identity for the current default price load balancer |
| Request metadata | Preserved session/sticky controls and pool configuration; normalized candidate order and existing bounds |

The four current route strategies need only a narrow routing DTO, but currently type it as `RouteResult`. They can be generalized without providing credentials, upstream URLs, private model names, ciphertext hashes or fabricated placeholder fields. Preserve their current identity semantics: hash affinity and weighted round robin use `providerId`, so replacing it with a route ID would change behavior.

The surface/policy read also needs a defined coherent snapshot and freshness check. v359 invalidates route, provider, pool, endpoint and link changes; its generation alone does not attest `model_surfaces`, model route policy or global strategy configuration. A future projection must explicitly include those sources. This observation is a design obligation, not a claim that the existing quote violates its safe-superset contract.

The quoted subset remains the explicit SQL capability boundary. This proof adds no single-model restriction and does not imply support for request shapes that v360 rejects.

## Remaining boundary

This artifact proves one concrete integration blocker. It does not wire a public Gateway, remove its KEK, validate full sticky/provider-control/fallback equivalence, establish Worker/Hyperdrive behavior, or implement result settlement. The comparison runtime retains its legacy credential-aware role solely to execute the existing planner as an oracle; that role is not suitable as the new secretless Gateway identity.
