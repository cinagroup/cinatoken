import postgres from 'postgres';
import type { PostgresDatabaseClient, RouteStrategyName } from '@octafuse/core';
import type { FinalChatQuoteSnapshot } from './chat-final-quote-input';
import type { CompleteFlatTextQuoteV360 } from './postgres-complete-chat-quote-v360';

type Sql = PostgresDatabaseClient['raw'];
type Factory = (url: string, options: { max: 1 }) => Sql;
const LOGIN = 'cinatoken_gateway_complete_text_routing_projector';
const SHA = /^[0-9a-f]{64}$/u;
const STRATEGIES = new Set(['hash_affinity', 'weighted_random', 'weight_priority', 'weighted_round_robin']);
export type CredentialFreeRoutingRouteV396 = Readonly<{
 targetId: string; providerId: string; routePoolId: string | null; routePriority: number; routeWeight: number;
 sourceGeneration: string; attestedSourceSha256: string; endpointId: string;
 endpointClass: 'standard' | 'service_tier' | null; maxCompletionTokens: number | null;
 priceScore: number | null; beneficialCacheReadPricing: boolean; defaultEndpointEligible: boolean;
}>;
export type CredentialFreeRoutingCandidateV396 = Readonly<{
 candidateIndex: number; modelId: string; routeGroup: 'default'; requestProtocol: 'openai'; requestOperation: 'chat';
 surface: null | Readonly<{ id: string; poolId: string; match: 'exact' | 'wildcard';
  sticky: Readonly<{ enabled: boolean; idleTtlSeconds: number; epoch: number }> }>;
 strategy: Readonly<{ base: RouteStrategyName; tierOverrides: readonly Readonly<{ priority: number; strategy: RouteStrategyName }>[] }>;
 routes: readonly CredentialFreeRoutingRouteV396[];
}>;
export type CredentialFreeRoutingProjectionV396 = Readonly<{
 requestId: string; quoteId: string; finalBodySha256: string; modelIds: readonly string[];
 expiresAt: string; routingEpoch: string; candidates: readonly CredentialFreeRoutingCandidateV396[];
}>;
export class PostgresRoutingProjectionRejectedV396 extends Error {
 constructor(readonly status: string) { super(`PostgreSQL complete text routing projection ${status}`); this.name = 'PostgresRoutingProjectionRejectedV396'; }
}
export class PostgresRoutingProjectionCleanupUnconfirmedV396 extends Error {
 constructor(cause: unknown) { super('PostgreSQL routing projector cleanup unconfirmed', { cause }); this.name = 'PostgresRoutingProjectionCleanupUnconfirmedV396'; }
}
function invalid(): never { throw new TypeError('Invalid credential-free routing projection v396'); }
function object(value: unknown, names: string): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names) invalid();
 return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
 if (typeof value !== 'string' || value.trim() !== value || !value || new TextEncoder().encode(value).length > max) invalid();
 return value;
}
function integer(value: unknown, min: number): number {
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid(); return value;
}
function bigint(value: unknown): string {
 if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9223372036854775806n) invalid(); return value;
}
function strategy(value: unknown): RouteStrategyName {
 if (typeof value !== 'string' || !STRATEGIES.has(value)) invalid(); return value as RouteStrategyName;
}
/** Exact allowlist validation is shared with native verification; unknown JSON never crosses this boundary. */
export function parseCredentialFreeRoutingProjectionV396(value: unknown, quote: {
 requestId: string; quoteId: string; finalBodySha256: string; modelIds: readonly string[]; expiresAt: string;
}, now = Date.now()): CredentialFreeRoutingProjectionV396 {
 const row = object(value, 'candidates,expiresAt,finalBodySha256,modelIds,quoteId,requestId,routingEpoch,status');
 if (row.status !== 'routing_projected' || row.requestId !== quote.requestId || row.quoteId !== quote.quoteId
  || row.finalBodySha256 !== quote.finalBodySha256 || !SHA.test(String(row.finalBodySha256))
  || !Array.isArray(row.modelIds) || row.modelIds.length !== quote.modelIds.length
  || row.modelIds.some((id, index) => id !== quote.modelIds[index]) || !Array.isArray(row.candidates)
  || row.candidates.length !== quote.modelIds.length || typeof row.expiresAt !== 'string'
  || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now
  || Date.parse(row.expiresAt) > Date.parse(quote.expiresAt)) invalid();
 let routeCount = 0;
 const targets = new Set<string>();
 const candidates = row.candidates.map((raw, index): CredentialFreeRoutingCandidateV396 => {
  const c = object(raw, 'candidateIndex,modelId,requestOperation,requestProtocol,routeGroup,routes,strategy,surface');
  if (c.candidateIndex !== index || c.modelId !== quote.modelIds[index] || c.requestOperation !== 'chat'
   || c.requestProtocol !== 'openai' || c.routeGroup !== 'default' || !Array.isArray(c.routes)) invalid();
  const plan = object(c.strategy, 'base,tierOverrides');
  if (!Array.isArray(plan.tierOverrides) || plan.tierOverrides.length > 100) invalid();
  const priorities = new Set<number>();
  const tierOverrides = plan.tierOverrides.map(rawTier => {
   const tier = object(rawTier, 'priority,strategy'); const priority = integer(tier.priority, -Number.MAX_SAFE_INTEGER);
   if (priorities.has(priority)) invalid(); priorities.add(priority);
   return Object.freeze({ priority, strategy: strategy(tier.strategy) });
  });
  let surface: CredentialFreeRoutingCandidateV396['surface'] = null;
  if (c.surface !== null) {
   const s = object(c.surface, 'id,match,poolId,sticky'); const sticky = object(s.sticky, 'enabled,epoch,idleTtlSeconds');
   if (!['exact', 'wildcard'].includes(String(s.match)) || typeof sticky.enabled !== 'boolean') invalid();
   surface = Object.freeze({ id: text(s.id), poolId: text(s.poolId), match: s.match as 'exact' | 'wildcard',
    sticky: Object.freeze({ enabled: sticky.enabled, idleTtlSeconds: integer(sticky.idleTtlSeconds, 60), epoch: integer(sticky.epoch, -Number.MAX_SAFE_INTEGER) }) });
   if (surface.sticky.idleTtlSeconds > 86400) invalid();
  }
  const routes = c.routes.map((rawRoute): CredentialFreeRoutingRouteV396 => {
   const r = object(rawRoute, 'attestedSourceSha256,beneficialCacheReadPricing,defaultEndpointEligible,endpointClass,endpointId,maxCompletionTokens,priceScore,providerId,routePoolId,routePriority,routeWeight,sourceGeneration,targetId');
   const targetId = text(r.targetId);
   if (targets.has(targetId) || !SHA.test(String(r.attestedSourceSha256)) || ![null, 'standard', 'service_tier'].includes(r.endpointClass as string | null)
    || typeof r.routeWeight !== 'number' || !Number.isFinite(r.routeWeight) || r.routeWeight <= 0
    || (r.priceScore !== null && (typeof r.priceScore !== 'number' || !Number.isFinite(r.priceScore) || r.priceScore < 0))
    || typeof r.beneficialCacheReadPricing !== 'boolean' || typeof r.defaultEndpointEligible !== 'boolean') invalid();
   targets.add(targetId); routeCount++;
   return Object.freeze({ targetId, providerId: text(r.providerId), routePoolId: r.routePoolId === null ? null : text(r.routePoolId), routePriority: integer(r.routePriority, -Number.MAX_SAFE_INTEGER),
    routeWeight: r.routeWeight, sourceGeneration: bigint(r.sourceGeneration), attestedSourceSha256: r.attestedSourceSha256 as string,
    endpointId: text(r.endpointId), endpointClass: r.endpointClass as CredentialFreeRoutingRouteV396['endpointClass'],
    maxCompletionTokens: r.maxCompletionTokens === null ? null : integer(r.maxCompletionTokens, 1),
    priceScore: r.priceScore as number | null, beneficialCacheReadPricing: r.beneficialCacheReadPricing, defaultEndpointEligible: r.defaultEndpointEligible });
  });
  return Object.freeze({ candidateIndex: index, modelId: c.modelId as string, routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat',
   surface, strategy: Object.freeze({ base: strategy(plan.base), tierOverrides: Object.freeze(tierOverrides) }), routes: Object.freeze(routes) });
 });
 if (routeCount > 100) invalid();
 return Object.freeze({ requestId: quote.requestId, quoteId: quote.quoteId, finalBodySha256: quote.finalBodySha256,
  modelIds: Object.freeze([...quote.modelIds]), expiresAt: row.expiresAt, routingEpoch: bigint(row.routingEpoch), candidates: Object.freeze(candidates) });
}
const open: Factory = url => postgres(url, { max: 1, prepare: false, fetch_types: false,
 connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });
export async function readPostgresCompleteTextRoutingProjectionV396(params: {
 projectorConnectionString: string; quote: CompleteFlatTextQuoteV360; finalQuoteInput: FinalChatQuoteSnapshot; signal?: AbortSignal;
}, factory: Factory = open): Promise<CredentialFreeRoutingProjectionV396> {
 const signal = params.signal; signal?.throwIfAborted();
 if (typeof params.projectorConnectionString !== 'string' || params.projectorConnectionString.trim() !== params.projectorConnectionString
  || params.projectorConnectionString.length > 4096) invalid();
 const url = new URL(params.projectorConnectionString);
 if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || !url.hostname || url.hash
  || !url.pathname || url.pathname === '/' || [...url.searchParams].length > 1
  || [...url.searchParams].some(([key, value]) => key !== 'sslmode' || !['disable', 'require'].includes(value))) invalid();
 const q = params.quote, input = params.finalQuoteInput;
 if (!Object.isFrozen(input) || !Object.isFrozen(input.modelIds) || q.requestId !== input.requestId || q.finalBodySha256 !== input.finalBodySha256
  || !Array.isArray(q.modelIds) || q.modelIds.length < 1 || q.modelIds.length > 8 || q.modelIds.length !== input.modelIds.length
  || q.modelIds.some((id, index) => id !== input.modelIds[index]) || new Set(q.modelIds).size !== q.modelIds.length || q.credentialClass !== 'platform'
  || !SHA.test(q.finalBodySha256) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(q.quoteId)
  || typeof q.expiresAt !== 'string' || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= Date.now()) invalid();
 q.modelIds.forEach(id => text(id, 240));
 const quote = Object.freeze({ requestId: text(q.requestId, 128), quoteId: q.quoteId, finalBodySha256: q.finalBodySha256,
  modelIds: Object.freeze([...q.modelIds]), expiresAt: q.expiresAt });
 const sql = factory(params.projectorConnectionString, { max: 1 }); let result: CredentialFreeRoutingProjectionV396 | undefined; let failure: unknown;
 try {
  result = await sql.begin(async tx => {
   signal?.throwIfAborted();
   const roles = await tx.unsafe('SELECT current_user AS current_role,session_user AS session_role,current_setting(\'transaction_isolation\') AS isolation');
   if (roles.length !== 1 || roles[0]?.current_role !== LOGIN || roles[0]?.session_role !== LOGIN || roles[0]?.isolation !== 'read committed') invalid();
   await tx.unsafe("SET LOCAL lock_timeout='2s'"); await tx.unsafe("SET LOCAL statement_timeout='15s'"); signal?.throwIfAborted();
   const rows = await tx.unsafe('SELECT cinatoken_gateway.project_complete_text_routing_v396($1::text,$2::uuid) AS value', [quote.requestId, quote.quoteId]);
   signal?.throwIfAborted();
   if (rows.length !== 1 || !rows[0]?.value || typeof rows[0].value.status !== 'string') invalid();
   if (rows[0].value.status !== 'routing_projected') {
    object(rows[0].value, 'status');
    if (!['not_found', 'stale', 'invalid_manifest', 'stale_manifest', 'stale_projection', 'unverified_routing'].includes(rows[0].value.status)) invalid();
    throw new PostgresRoutingProjectionRejectedV396(rows[0].value.status);
   }
   return parseCredentialFreeRoutingProjectionV396(rows[0].value, quote);
  }) as unknown as CredentialFreeRoutingProjectionV396;
 } catch (error) { failure = error; }
 try { const acknowledgement = sql.end({ timeout: 1 }); if (!acknowledgement || typeof acknowledgement.then !== 'function') invalid(); await acknowledgement; }
 catch (error) { throw new PostgresRoutingProjectionCleanupUnconfirmedV396(failure === undefined ? error : new AggregateError([failure, error])); }
 if (failure !== undefined) throw failure;
 signal?.throwIfAborted(); if (Date.parse(result!.expiresAt) <= Date.now()) invalid(); return result!;
}
