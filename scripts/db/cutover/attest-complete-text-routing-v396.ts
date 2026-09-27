/** Trusted maintenance process only. Never import this source-reader into a public Gateway bundle. */
import postgres from 'postgres';
import {
 computeRouteDataPolicySubjectFingerprintFromRows, parseVerifiedModelEndpointSnapshot,
 modelEndpointSupportsOperation, modelEndpointSubjectFingerprintIsValid, verifiedEndpointMatchesLegacyRoutingMetadata,
 providerSupportsUpstreamProtocol, isPendingProviderImportApiKey, normalizeUpstreamProtocol, isRouteAdapterCompatible,
 resolveModelRoutePolicyStrategy, parseRoutePoolTierStrategies, isRouteStrategyName, DEFAULT_ROUTE_STRATEGY,
 comparableRoutePriceSortScore, resolveComparableRoutePrice,
 type ModelRouteRow, type ProviderRow, type ModelEndpointRow,
} from '../../../packages/core/src/index';
import { isDefaultEndpointRouteEligible } from '../../../packages/proxy/src/services/provider-routing-preferences';
import { parseRoutePoolStickyConfig } from '../../../packages/core/src/db/route-pool-sticky-types';

const LOGIN = 'cinatoken_gateway_route_source_verifier';
/** Reads a coherent source/policy snapshot with the existing trusted verifier LOGIN and publishes only safe facts. */
export async function attestCompleteTextRoutingV396(params: { verifierConnectionString: string; modelIds: readonly string[] }) {
 const modelIds = [...params.modelIds];
 if (!modelIds.length || modelIds.length > 8 || new Set(modelIds).size !== modelIds.length
  || modelIds.some(id => typeof id !== 'string' || id.trim() !== id || !id || new TextEncoder().encode(id).length > 240)) throw new TypeError('Invalid v396 models');
 const sql = postgres(params.verifierConnectionString, { max: 1, prepare: false, fetch_types: false,
  connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false, onnotice() {} });
 try {
  return await sql.begin(async tx => {
   const [identity] = await tx.unsafe('SELECT current_user,session_user,current_setting(\'transaction_isolation\') AS isolation');
   if (identity?.current_user !== LOGIN || identity.session_user !== LOGIN || identity.isolation !== 'read committed') throw new Error('Verifier LOGIN required');
   await tx.unsafe("SET LOCAL lock_timeout='2s'"); await tx.unsafe("SET LOCAL statement_timeout='15s'");
   // Table locks precede advisory acquisition: source writers already hold RowExclusive before their BEFORE STATEMENT trigger.
   await tx.unsafe('SELECT cinatoken_gateway.lock_complete_text_routing_sources_v396()');
   const [clock] = await tx.unsafe(`SELECT epoch::text AS epoch,clock_timestamp() AS now FROM cinatoken_gateway.routing_policy_epoch_v396 WHERE singleton`);
   const now = new Date(clock!.now);
   const [global] = await tx.unsafe("SELECT value FROM cinatoken_gateway.system_config WHERE key='ROUTE_STRATEGY'");
   const globalValue = String(global?.value ?? '').trim().toLowerCase();
   const globalStrategy = isRouteStrategyName(globalValue) ? globalValue : DEFAULT_ROUTE_STRATEGY;
   const facts = [];
   for (const modelId of modelIds) {
    const [model] = await tx.unsafe('SELECT id,route_policy FROM cinatoken_gateway.models WHERE id=$1', [modelId]);
    if (!model) throw new Error('v396 model missing');
    const [surface] = await tx.unsafe(`SELECT ms.id,ms.route_pool_id,ms.request_operation,rp.strategy,rp.tier_strategies,
     rp.sticky_enabled,rp.sticky_idle_ttl_seconds,rp.sticky_epoch
     FROM cinatoken_gateway.model_surfaces ms JOIN cinatoken_gateway.route_pools rp ON rp.id=ms.route_pool_id
     WHERE ms.model_id=$1 AND lower(ms.route_group)='default' AND lower(ms.request_protocol)='openai'
      AND ms.request_operation IN ('chat','*') AND ms.status='active' AND rp.status='active'
     ORDER BY CASE WHEN ms.request_operation='chat' THEN 0 ELSE 1 END LIMIT 1`, [modelId]);
    const rows = await tx.unsafe(`SELECT r.* FROM cinatoken_gateway.model_routes r WHERE r.status='active'
     AND ${surface ? 'r.route_pool_id=$1' : "r.model_id=$1 AND lower(coalesce(nullif(btrim(r.route_group),''),'default'))='default'"}
     ORDER BY r.priority DESC`, [surface ? surface.route_pool_id : modelId]);
    if (rows.length > 100) throw new RangeError('v396 routes exceed safety bound');
    const routes = [];
    let expiresAt = now.getTime() + 60_000;
    for (const rawRoute of rows) {
     const route = rawRoute as unknown as ModelRouteRow;
     const [rawProvider] = await tx.unsafe('SELECT * FROM cinatoken_gateway.providers WHERE id=$1', [route.provider_id]);
     const bindings = await tx.unsafe(`SELECT e.*,er.subject_fingerprint,er.route_target_id FROM cinatoken_gateway.model_endpoint_routes er
      JOIN cinatoken_gateway.model_endpoints e ON e.id=er.endpoint_id WHERE er.route_target_id=$1`, [route.id]);
     const [fence] = await tx.unsafe(`SELECT generation::text AS generation,verified_generation::text AS verified_generation,
      attested_source_sha256,verified_subject_fingerprint FROM cinatoken_gateway.route_source_generations_v359 WHERE route_target_id=$1`, [route.id]);
     if (!rawProvider || bindings.length !== 1 || !fence || fence.generation !== fence.verified_generation || !fence.attested_source_sha256) continue;
     const provider = rawProvider as unknown as ProviderRow;
     const binding = bindings[0]!;
     if (provider.status !== 'active' || isPendingProviderImportApiKey(provider.api_key?.trim() ?? '')) continue;
     try { if (!providerSupportsUpstreamProtocol(normalizeUpstreamProtocol(route.upstream_protocol), provider)) continue; } catch { continue; }
     const endpoint = parseVerifiedModelEndpointSnapshot(binding as unknown as ModelEndpointRow, now);
     if (!endpoint || binding.model_id !== route.model_id || binding.provider_id !== route.provider_id
      || endpoint.modelId !== route.model_id || endpoint.providerId !== provider.id
      || !verifiedEndpointMatchesLegacyRoutingMetadata(endpoint, route.routing_metadata)
      || !modelEndpointSubjectFingerprintIsValid(binding.subject_fingerprint)
      || binding.subject_fingerprint !== await computeRouteDataPolicySubjectFingerprintFromRows(route, provider)
      || binding.subject_fingerprint !== fence.verified_subject_fingerprint
      || !modelEndpointSupportsOperation(endpoint, 'chat') || !isRouteAdapterCompatible({ adapter: route.adapter ?? 'passthrough',
       requestProtocol: 'openai', requestOperation: 'chat', upstreamProtocol: normalizeUpstreamProtocol(route.upstream_protocol), upstreamOperation: route.upstream_operation ?? '*' })) continue;
     const score = comparableRoutePriceSortScore(resolveComparableRoutePrice({ pricing: endpoint.pricing,
      priceOverrideRaw: route.price_override, pricingAt: now, businessTimezone: 'UTC' }));
     // v360 currently excludes price_override; no schedule/timezone value is projected.
     const read = Number(endpoint.pricing?.input_cache_read), prompt = Number(endpoint.pricing?.prompt);
     expiresAt = Math.min(expiresAt, Date.parse(endpoint.expiresAt));
     routes.push({ targetId: route.id, providerId: provider.id, routePoolId: route.route_pool_id ?? null, routePriority: route.priority,
      routeWeight: typeof route.weight === 'number' && route.weight > 0 ? route.weight : 1,
      sourceGeneration: fence.generation, attestedSourceSha256: fence.attested_source_sha256,
      endpointId: endpoint.id, endpointClass: endpoint.endpointClass, maxCompletionTokens: endpoint.maxCompletionTokens,
      priceScore: Number.isFinite(score) && score >= 0 ? score : null,
      beneficialCacheReadPricing: endpoint.pricing?.input_cache_read !== undefined && Number.isFinite(read) && Number.isFinite(prompt) && read < prompt,
      defaultEndpointEligible: isDefaultEndpointRouteEligible({ endpoint }) });
    }
    const base = surface?.strategy && isRouteStrategyName(surface.strategy) ? surface.strategy
     : resolveModelRoutePolicyStrategy(model.route_policy, 'openai', 'chat', 'default') ?? globalStrategy;
    facts.push({ modelId, routingEpoch: clock!.epoch, expiresAt: new Date(expiresAt).toISOString(),
     surface: surface ? { id: surface.id, poolId: surface.route_pool_id, match: surface.request_operation === 'chat' ? 'exact' : 'wildcard',
      sticky: parseRoutePoolStickyConfig({stickyEnabled:surface.sticky_enabled,stickyIdleTtlSeconds:surface.sticky_idle_ttl_seconds,stickyEpoch:surface.sticky_epoch}) } : null,
     strategy: { base, tierOverrides: [...parseRoutePoolTierStrategies(surface?.tier_strategies)].map(([priority, strategy]) => ({ priority, strategy })) }, routes });
   }
   const [receipt] = await tx.unsafe('SELECT cinatoken_gateway.attest_complete_text_routing_v396($1::bigint,$2::text::jsonb) AS value', [clock!.epoch, JSON.stringify(facts)]);
   if (receipt?.value.status !== 'routing_attested') throw new Error('v396 routing attestation failed');
   return receipt.value;
  });
 } finally { await sql.end({ timeout: 1 }); }
}
