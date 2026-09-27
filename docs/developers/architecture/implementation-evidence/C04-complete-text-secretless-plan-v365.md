# C04 strict ingress route projection v365 (review only)

2026-09-25. This proposal adds a database-backed route plan for an **already committed v360 flat-text, platform-credential quote**. It is a planning projection. It does not issue a budget reservation, attempt grant, credential, URL, or permission to fetch.

## Artifact and authority

- [`complete-text-secretless-plan-v365.sql`](../../../../packages/core/migrations-proposals/postgres/complete-text-secretless-plan-v365.sql) is deliberately outside formal PG73. Install only in a migrator transaction after v356, v359 and v360, with `cinatoken.complete_text_secretless_plan_activation=reviewed-v1`, after provisioning a separate direct `NOINHERIT LOGIN cinatoken_gateway_complete_text_ingress_planner` without role memberships or base-table privileges.
- The only granted operation is `plan_complete_flat_text_quote_v365(request_id text, quote_id uuid)`. It checks `SESSION_USER`, read-committed isolation, quote/capability/key/user/workspace state, quote expiry, active BYOK exclusion, the complete candidate manifest, live route/Provider/endpoint/link state, attested v359 generation, ciphertext *equality inside the definer*, and all active route coverage. Broad table locks make its route predicate coherent until the read transaction ends.
- The success result has exactly `status`, `requestId`, `quoteId`, `finalBodySha256`, `orderedModelIds`, `candidateCount`, `routeCount`, `expiresAt`, and `routes`. Each route contains exactly `candidateIndex`, `modelId`, `routeTargetId`, `sourceGeneration` (decimal string), and `attestedSourceSha256`. `routes` has at most 100 rows and candidates at most eight; each model ID is at most 240 UTF-8 bytes and each route target ID at most 256 UTF-8 bytes. No Provider key, `providers.endpoints`, raw URL, Provider ciphertext/hash, endpoint evidence URL, source snapshot, or Provider/endpoint ID is projected.
- Missing/mismatched request and quote IDs return `not_found`; expired or invalidated identity/source eligibility returns `stale`; manifest shape mismatch returns `invalid_manifest`; source drift or an incomplete route set returns `stale_manifest`. Failure results contain no route data.

## Native evidence

[`postgres-complete-text-secretless-plan-v365.native.test.mjs`](../../../../scripts/db/cutover/postgres-complete-text-secretless-plan-v365.native.test.mjs) starts an owned PostgreSQL 18.6 instance, installs the 73 formal migrations and current runtime grant reconciler, then installs v356/v357/v359/v360 and this review proposal. Its synthetic Provider contains distinct ciphertext, endpoint query secret and evidence URL sentinels. A genuine v360 issuer commits a two-candidate quote before the planner reads it.

Run locally with the repository-owned PostgreSQL binaries:

```powershell
$env:GATEWAY_NATIVE_PG_BIN='C:\cinagroup\cinatoken\.wrangler\staging\pg-native-v292-binaries\extracted\pgsql\bin'
node --import tsx --test scripts/db/cutover/postgres-complete-text-secretless-plan-v365.native.test.mjs
```

[`C04-complete-text-secretless-plan-v365-report.json`](./C04-complete-text-secretless-plan-v365-report.json) records **PASS, 11/11 stages, cleanup PASS**, including default-off and privilege-drift rollback; effective `SELECT *`, Provider `api_key`, `endpoints`, manifest ciphertext column and `SET ROLE` denials under the actual planner LOGIN; successful bounded output with no secret sentinel; wrong quote/request denial; candidate corruption rejection; newly active BYOK rejection; Provider change and ABA source invalidation; quote expiry; and a rejected broad runtime-grant rerun with the planner ACL unchanged. The report records SHA-256 for the formal corpus, SQL proposals, fixture, and reconciler.

## Cutover gap

This function is not wired into Chat or the current Worker. The ordinary Proxy runtime still reads Provider rows, decrypts `enc:v2:` with the shared KEK, and owns the current fetch driver. A dedicated ingress Worker/database identity, separate Admin and holder identities, a Provider-specific unwrap domain, a credential-aware independent verifier, holder source/credential reader, v362 grant ACK and physical send protocol, result/lease/settlement ownership, and coordinated drain remain required. The planner output can become stale as soon as its read transaction ends; the holder/granter must recheck all authority at send time. The PostgreSQL table locks also require a narrower production generation protocol before live traffic. There is no remote deployment or C04 acceptance claim.
