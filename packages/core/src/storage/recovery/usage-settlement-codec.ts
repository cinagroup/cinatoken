import type { InsertRequestUsageAndChargeD1Params } from '../../db/d1/critical-writes.impl';
import { assertGenerationSnapshotIsValid, type InsertRequestLogParams, type GenerationProviderResponseSnapshot } from '../../db/request-logs-types';
import { assertProviderAttemptAvailabilityFacts, type InsertProviderAttemptAvailability } from '../../db/provider-attempt-availability';
import type { DispatchIntentIdentity } from './dispatch-intent-d1';
import { guardrailBudgetUnits } from '../../db/guardrail-budget-types';
import { roundGatewayMoney } from '../../lib/money-precision';

/** Technical limits for the disabled recovery prototype, NOT new public API limits. */
export const MAX_SETTLEMENT_BYTES = 256 * 1024;
export type UsageSettlement = {
	version: 1;
	intent: DispatchIntentIdentity;
	dispatchClaimId: string;
	recordedAtIso: string;
	params: InsertRequestUsageAndChargeD1Params;
};
type Check = (value: unknown) => boolean;
type Shape<T> = { [K in keyof T]-?: Check };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const encoder = new TextEncoder();
const nil: Check = value => value === null;
const bool: Check = value => typeof value === 'boolean';
const amount: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1_000_000;
const integer: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optional = (check: Check): Check => value => value === undefined || check(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const maybe = (check: Check): Check => optional(nullable(check));
const str = (max: number): Check => value => typeof value === 'string' && value.length <= max && encoder.encode(value).byteLength <= max;
const jsonText = (max: number): Check => value => {
	if (typeof value !== 'string' || !str(max)(value)) return false;
	try { JSON.parse(value); return true; } catch { return false; }
};
const text = str(512), auditText = jsonText(32 * 1024), usageText = jsonText(64 * 1024);
const oneOf = (...values: readonly (string | number)[]): Check => value => values.some(candidate => candidate === value);
export const settlementId: Check = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const digest: Check = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid: Check = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const iso: Check = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const protocol = oneOf('openai', 'anthropic', 'gemini', 'dashscope');
function shape(value: unknown, fields: Record<string, Check>): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	return Object.keys(value).every(key => Object.hasOwn(fields, key))
		&& Object.entries(fields).every(([key, check]) => check(Object.getOwnPropertyDescriptor(value, key)?.value));
}
const array = (max: number, check: Check): Check => value => Array.isArray(value) && value.length <= max && value.every(check);
const attemptFields = {
	attemptIndex: value => integer(value) && Number(value) > 0,
	routeTargetId: text, providerId: text, outcome: oneOf('available', 'unavailable', 'excluded'),
	reason: oneOf('accepted', 'provider_http_error', 'rate_limited', 'network_error', 'invalid_response', 'client_error', 'client_cancelled', 'unknown'),
	httpStatus: nullable(integer), observedAtIso: iso,
} satisfies Shape<InsertProviderAttemptAvailability>;
const responseFields = {
	status: nullable(integer), endpoint_id: optional(text), id: optional(text), is_byok: optional(bool),
	latency: optional(integer), model_permaslug: optional(text), provider_name: optional(text), routed_service_tier: optional(oneOf('flex', 'priority')),
} satisfies Shape<GenerationProviderResponseSnapshot>;
// All fields must be explicitly handled when the critical-write DTO grows.
const logFields = {
	id: settlementId, userId: settlementId, apiKeyId: settlementId, workspaceId: settlementId,
	userEmail: nullable(text), modelId: text, providerId: text, providerModelName: nullable(text),
	modelName: nullable(text), providerName: nullable(text), requestBody: nil, upstreamRequestBody: nil,
	requestProtocol: protocol, upstreamProtocol: protocol, requestOperation: oneOf('images.generations', 'images.edits'),
	upstreamOperation: maybe(text), modelSurfaceId: maybe(text), routePoolId: maybe(text), routeTargetId: maybe(text),
	adapter: maybe(text), routeTrace: maybe(auditText),
	inputTokens: integer, outputTokens: integer, cacheReadTokens: integer, cacheWriteTokens: integer, reasoningTokens: integer, totalTokens: integer,
	nativeTokensPrompt: maybe(integer), nativeTokensCompletion: maybe(integer), nativeTokensCached: maybe(integer),
	nativeTokensReasoning: maybe(integer), nativeTokensCompletionImages: maybe(integer),
	meteredCost: amount, standardCost: amount, chargedCost: amount, budgetChargedMicros: maybe(integer), budgetAccountedAt: maybe(iso),
	routeGroup: text, status: oneOf('success', 'error', 'incomplete', 'cancelled'), latencyMs: nullable(integer),
	gatewayOverheadMs: maybe(integer), upstreamResponseMs: maybe(integer), finalUpstreamHeadersMs: maybe(integer),
	firstReasoningTokenMs: maybe(integer), firstTokenMs: maybe(integer), streamDurationMs: maybe(integer),
	upstreamAttemptCount: maybe(integer), upstreamFailoverCount: maybe(integer), timingMetadata: maybe(auditText),
	errorMessage: nullable(text), rawUsage: nullable(usageText), pricingAudit: maybe(usageText),
	providerKeyId: maybe(text), providerKeyLabel: maybe(text), providerKeyFingerprint: maybe(text),
	upstreamRequestId: maybe(text), upstreamMessageId: maybe(text), billingKind: maybe(text),
	inputImageCount: optional(integer), outputImageCount: optional(integer), audioDurationSeconds: maybe(amount), audioCharacters: maybe(integer),
	sessionId: maybe(str(1024)), requestOrigin: maybe(text), httpReferer: maybe(text), userAgent: maybe(text),
	responseStreamed: maybe(bool), dataRegion: maybe(oneOf('global', 'europe', 'us')), isByok: maybe(bool),
	chargedCostUsd: maybe(amount), upstreamInferenceCostUsd: maybe(amount), serviceTier: maybe(oneOf('default', 'flex', 'priority')),
	finishReason: maybe(oneOf('tool_calls', 'stop', 'length', 'content_filter', 'error')), nativeFinishReason: maybe(text),
	providerResponses: maybe(array(32, value => shape(value, responseFields))),
	providerAttempts: optional(array(128, value => shape(value, attemptFields))),
} satisfies Shape<InsertRequestLogParams>;
const auditFields = {
	apiKeyId: settlementId, eventType: oneOf('usage_charge'), actorType: oneOf('system', 'service', 'user', 'admin'),
	actorId: maybe(text), reasonCode: maybe(text), reasonText: maybe(text), beforeSpent: amount,
	beforeBudgetMax: maybe(amount), afterBudgetMax: maybe(amount), beforeBudgetBase: maybe(amount), afterBudgetBase: maybe(amount),
	beforeBudgetPeriod: maybe(text), afterBudgetPeriod: maybe(text), beforeBudgetResetAt: maybe(iso), afterBudgetResetAt: maybe(iso),
	requestLogId: settlementId, changePayloadMerge: maybe(auditText), beforeUserSnapshot: maybe(auditText), afterUserSnapshot: maybe(auditText),
	changedFields: maybe(auditText), correlationId: maybe(text), source: maybe(text),
} satisfies Shape<InsertRequestUsageAndChargeD1Params['audit']>;
const budgetFields = { requestId: settlementId, mode: oneOf('actual', 'reserved'), reason: str(128) } satisfies Shape<NonNullable<InsertRequestUsageAndChargeD1Params['userBudgetSettlement']>>;
const paramFields = {
	requestLog: value => shape(value, logFields), shouldChargeBudget: bool, userId: settlementId,
	beforeSpent: amount, chargedCost: amount, audit: value => shape(value, auditFields),
	userBudgetSettlement: optional(value => shape(value, budgetFields)),
	guardrailBudgetSettlement: optional(value => shape(value, budgetFields)),
} satisfies Shape<InsertRequestUsageAndChargeD1Params>;
const intentFields = {
	requestId: settlementId, attemptIndex: value => integer(value) && Number(value) >= 1 && Number(value) <= 32,
	userId: settlementId, apiKeyId: settlementId, workspaceId: settlementId,
	operation: oneOf('images.generations', 'images.edits'), contextSha256: digest,
} satisfies Shape<DispatchIntentIdentity>;
const envelopeFields = {
	version: oneOf(1), intent: value => shape(value, intentFields), dispatchClaimId: uuid, recordedAtIso: iso,
	params: value => shape(value, paramFields),
} satisfies Shape<UsageSettlement>;

/** Own a bounded plain-JSON tree before the first await; reject accessors and toJSON hooks. */
function canonicalCopy(value: unknown): Json {
	let nodes = 0, stringBytes = 0;
	function copy(item: unknown, depth: number): Json {
		if (++nodes > 4096 || depth > 8) throw new TypeError('Settlement structure limit exceeded');
		if (item === null || typeof item === 'boolean') return item;
		if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
		if (typeof item === 'string') {
			if (item.length > 65536 || (stringBytes += encoder.encode(item).byteLength) > MAX_SETTLEMENT_BYTES) throw new TypeError('Settlement string limit exceeded');
			return item;
		}
		if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Settlement requires plain JSON');
		const keys = Reflect.ownKeys(item);
		if (keys.length > 129 || keys.some(key => typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype')) throw new TypeError('Settlement field limit exceeded');
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Object.values(descriptors).some(field => !('value' in field))) throw new TypeError('Settlement accessors are forbidden');
		if (Array.isArray(item)) {
			if (item.length > 128 || keys.length !== item.length + 1) throw new TypeError('Settlement array shape invalid');
			return Array.from({ length: item.length }, (_, i) => copy(descriptors[String(i)]?.value, depth + 1));
		}
		const out: { [key: string]: Json } = {};
		for (const key of Object.keys(descriptors).sort()) {
			if (descriptors[key].value !== undefined) out[key] = copy(descriptors[key].value, depth + 1);
		}
		return out;
	}
	return copy(value, 0);
}
function assertSettlement(value: unknown): asserts value is UsageSettlement {
	if (!shape(value, envelopeFields)) throw new TypeError('Invalid settlement snapshot shape');
	// The complete field-by-field schema above establishes the type, not a JSON cast.
}
function validate(value: UsageSettlement): void {
	const { params, intent } = value, log = params.requestLog;
	assertGenerationSnapshotIsValid(log);
	assertProviderAttemptAvailabilityFacts(log.providerAttempts);
	if (log.id !== intent.requestId || log.userId !== intent.userId || params.userId !== intent.userId
		|| log.apiKeyId !== intent.apiKeyId || log.workspaceId !== intent.workspaceId || log.requestOperation !== intent.operation
		|| params.audit.apiKeyId !== intent.apiKeyId || params.audit.requestLogId !== intent.requestId
		|| params.audit.beforeSpent !== params.beforeSpent || params.chargedCost !== log.chargedCost
		|| (log.budgetChargedMicros != null && log.budgetChargedMicros !== (params.shouldChargeBudget ? guardrailBudgetUnits(roundGatewayMoney(params.chargedCost)) : 0))
		|| (params.userBudgetSettlement && params.userBudgetSettlement.requestId !== intent.requestId)
		|| (params.guardrailBudgetSettlement && params.guardrailBudgetSettlement.requestId !== intent.requestId)
		|| !log.providerAttempts?.some(attempt => attempt.attemptIndex === intent.attemptIndex && attempt.providerId === log.providerId
			&& (log.routeTargetId == null || attempt.routeTargetId === log.routeTargetId))
		|| log.providerAttempts.some(attempt => attempt.attemptIndex > intent.attemptIndex)) throw new TypeError('Settlement identity or accounting conflict');
	for (const settlement of [params.userBudgetSettlement, params.guardrailBudgetSettlement]) {
		if (settlement && !settlement.reason.trim()) throw new TypeError('Settlement reason is required');
	}
}
export async function settlementDigest(json: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(json))), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** SHA-256 binds content identity; it is NOT an authentication mechanism. */
export async function encodeUsageSettlement(input: UsageSettlement) {
	const value = canonicalCopy(input);
	assertSettlement(value); validate(value);
	const json = JSON.stringify(value);
	if (encoder.encode(json).byteLength > MAX_SETTLEMENT_BYTES) throw new TypeError('Settlement payload limit exceeded');
	return { json, sha256: await settlementDigest(json) };
}
export async function decodeUsageSettlement(json: string, sha256: string): Promise<UsageSettlement> {
	if (typeof json !== 'string' || json.length > MAX_SETTLEMENT_BYTES || encoder.encode(json).byteLength > MAX_SETTLEMENT_BYTES || !digest(sha256)) throw new TypeError('Invalid stored settlement bounds');
	const value = canonicalCopy(JSON.parse(json));
	assertSettlement(value); validate(value);
	if (JSON.stringify(value) !== json || await settlementDigest(json) !== sha256) throw new TypeError('Stored settlement content mismatch');
	return value;
}
