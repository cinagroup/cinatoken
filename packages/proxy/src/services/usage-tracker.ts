/**
 * 用量与计费：按百万 token 单价计算 `metered_cost`（供应成本）、`standard_cost`（目录标准成本）、`charged_cost`（用户预算）。
 * - 已路由请求的基数始终来自 request-local verified Model Endpoint flat pricing；
 *   route-less gateway audit rows alone retain the legacy model profile path.
 * - `metered_cost` / `charged_cost` = endpoint tariff × effective route factor.
 * - `standard_cost` = endpoint list tariff（不乘路由倍率）。
 * - nested `price_override.metered` / `charged` tiers 忽略不计价。
 * 写入 `api_key_request_logs`（含 `pricing_audit` JSON，见 `PRICING_AUDIT_JSON_SCHEMA_VERSION`）并在非 error 且 charged>0 时累加 `users.budget_spent`。
 */
import type {
	GatewayRepositories,
	UpstreamProtocol,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import {
	getBusinessTimezone,
	getUserBudgetSnapshot,
	insertRequestUsageAndChargeTx,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	PRICING_AUDIT_JSON_SCHEMA_VERSION,
	resolveChargedBillingPrices,
	resolveDailyScheduleFactor,
	resolveEffectiveRouteFactor,
	resolveStandardBillingPrices,
	resolveSupplierBillingPrices,
	roundGatewayMoney,
	scaleBillingPrices,
	toScheduleAudit,
	applyUserChargedCostFactor,
	attachUserChargedFactorToPricingAudit,
	lookupUserChargedCostFactor,
	parseUserChargedCostFactors,
	type BillingPriceSnapshot,
	type PriceResolutionAuditSide,
	changedFieldsToJson,
	computeChangedFields,
	snapshotToJson,
	snapshotWithOverrides,
	userRowToSnapshot,
} from '@octafuse/core';
import type { UsageFromStream } from './proxy';
import { fireGatewayErrorWebhooks } from './alert-webhook';
import { settleSharedKeyEarning } from './shared-key-earnings';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import type { RequestTimingSnapshot } from './request-timing';
import {
	applyRequestBodyLoggingPolicy,
	type RequestBodyLoggingMode,
} from './request-body-log-policy';
import { verifiedUsdGenerationWriteSnapshot } from './generation-metadata-snapshot';
import type { ModelFallbackTrace } from './model-fallbacks';
import type { RouteResult } from './model-router';
import {
	resolveEndpointTextPricing,
	type EndpointPricingAuditIdentity,
} from './endpoint-billing-pricing';

const TOKENS_PER_MILLION = 1_000_000;

export type OrdinaryBudgetUsageSettlement = {
	requestId: string;
	/** Reservation period generation, used only to keep audit snapshots period-safe. */
	budgetEpoch: number;
	/** Request-scoped reservation ceiling used for an accurate audit snapshot. */
	reservedMicros: number;
	/** Preserve the reserved ceiling when dispatched usage cannot be proven. */
	unknownCost: boolean;
};

export function ordinaryBudgetAuditCharge(params: {
	settlement: OrdinaryBudgetUsageSettlement | null | undefined;
	currentBudgetEpoch: number | null;
	chargedCost: number;
	shouldChargeBudget: boolean;
}): number {
	const settlement = params.settlement;
	if (settlement && (
		!Number.isSafeInteger(settlement.budgetEpoch)
		|| settlement.budgetEpoch < 0
		|| !Number.isSafeInteger(settlement.reservedMicros)
		|| settlement.reservedMicros <= 0
	)) {
		throw new Error('Ordinary budget settlement audit metadata is invalid');
	}
	if (settlement && params.currentBudgetEpoch !== settlement.budgetEpoch) return 0;
	if (settlement?.unknownCost) return settlement.reservedMicros / TOKENS_PER_MILLION;
	return params.shouldChargeBudget ? params.chargedCost : 0;
}

export function ordinaryBudgetAuditSnapshotTransition(params: {
	settlement: OrdinaryBudgetUsageSettlement | null | undefined;
	currentBudgetEpoch: number | null;
	currentReservedMicros: number;
	chargedCost: number;
	shouldChargeBudget: boolean;
}): {
	auditCharge: number;
	afterReservedMicros: number;
	settlementEpochMatches: boolean;
} {
	if (!Number.isSafeInteger(params.currentReservedMicros) || params.currentReservedMicros < 0) {
		throw new Error('Ordinary budget audit snapshot reserved total is invalid');
	}
	const auditCharge = ordinaryBudgetAuditCharge(params);
	const settlementEpochMatches = params.settlement == null
		|| params.currentBudgetEpoch === params.settlement.budgetEpoch;
	return {
		auditCharge,
		afterReservedMicros: params.settlement && settlementEpochMatches
			? Math.max(0, params.currentReservedMicros - params.settlement.reservedMicros)
			: params.currentReservedMicros,
		settlementEpochMatches,
	};
}

export function ordinaryBudgetSettlementForCriticalWrite(
	settlement: OrdinaryBudgetUsageSettlement | null | undefined,
) {
	if (!settlement) return undefined;
	return {
		requestId: settlement.requestId,
		mode: settlement.unknownCost ? 'reserved' as const : 'actual' as const,
		reason: settlement.unknownCost
			? 'usage_unavailable_after_dispatch'
			: 'request_usage_settled',
	};
}

/**
 * 根据 token 数量与模型单价（每百万 token）计算原始成本；纯本地计算，不采用上游账单字段。
 */
export function computeMeteredCost(
	usage: UsageFromStream,
	input_price: number | null,
	output_price: number | null,
	cache_read_price: number | null,
	cache_write_price: number | null
): number {
	const inputPrice = input_price ?? 0;
	const outputPrice = output_price ?? 0;
	const cacheReadPrice = cache_read_price ?? inputPrice;
	const cacheWritePrice = cache_write_price ?? inputPrice;
	const regularInput = usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens;
	return (
		(regularInput * inputPrice +
			usage.cache_read_tokens * cacheReadPrice +
			usage.cache_write_tokens * cacheWritePrice +
			usage.output_tokens * outputPrice) /
		TOKENS_PER_MILLION
	);
}

function buildRequestPricingAuditJson(options: {
	usage: UsageFromStream;
	supplierAudit: PriceResolutionAuditSide;
	standardAudit: PriceResolutionAuditSide;
	chargedAudit: PriceResolutionAuditSide;
	endpointPricing?: EndpointPricingAuditIdentity & {
		cache_write_strategy: 'maximum_declared_rate';
	};
	requestCosts?: { supplier: number; standard: number; user_charge: number };
}): string {
	return JSON.stringify({
		v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
		basis_tokens: options.usage.input_tokens,
		...(options.endpointPricing ? { endpoint_pricing: options.endpointPricing } : {}),
		...(options.requestCosts ? { request_costs: options.requestCosts } : {}),
		snapshot: {
			supplier: options.supplierAudit,
			standard: options.standardAudit,
			user_charge: options.chargedAudit,
		},
	});
}

function applyRouteFactorsToSide(options: {
	catalog: { prices: BillingPriceSnapshot; audit: PriceResolutionAuditSide };
	baseFactor: number;
	scheduleFactor: ReturnType<typeof resolveDailyScheduleFactor>;
	mode: ReturnType<typeof parseRoutePricingSchedule>['mode'];
}): { prices: BillingPriceSnapshot; audit: PriceResolutionAuditSide } {
	const effective = resolveEffectiveRouteFactor(
		options.baseFactor,
		options.scheduleFactor,
		options.mode
	);
	const prices = scaleBillingPrices(options.catalog.prices, effective);
	const sch = options.scheduleFactor;
	return {
		prices,
		audit: {
			...options.catalog.audit,
			source: 'model_x_factor',
			base_factor: options.baseFactor,
			schedule: toScheduleAudit(sch),
			effective_factor: effective,
			prices,
		},
	};
}

/**
 * 写入 `api_key_request_logs` 并在合适条件下增加 `users.budget_spent`（与插入日志同一 batch）。
 */
export async function recordUsage(
	repos: GatewayRepositories,
	params: {
		api_key_id: string;
		workspace_id: string;
		request_log_id?: string;
		user_id: string;
		user_email: string | null;
		model_id: string;
		provider_id: string;
		provider_model_name?: string | null;
		model_name?: string | null;
		provider_name?: string | null;
		request_body?: string | null;
		upstream_request_body?: string | null;
		request_body_logging_mode?: RequestBodyLoggingMode;
		/** Canonical origin from the inbound request URL; never a Referer or full path. */
		request_origin?: string | null;
		response_streamed?: boolean | null;
		request_protocol: UpstreamProtocol;
		request_operation?: string | null;
		upstream_protocol: UpstreamProtocol;
		upstream_operation?: string | null;
		model_surface_id?: string | null;
		route_pool_id?: string | null;
		route_target_id?: string | null;
		adapter?: string | null;
		/** Gemini wire action from URL (`generateContent` / `streamGenerateContent`); stored in route_trace. */
		gemini_wire_action?: string | null;
		/** Provider sticky routing observation (merged into route_trace.sticky). */
		sticky_trace?: {
			lookup: string;
			attempted_target: string | null;
			result: string;
		} | null;
		/** Cross-model fallback audit extension; contains no prompts or provider secrets. */
		model_fallback_trace?: ModelFallbackTrace | null;
		/** Sanitized Provider Routing decision; contains no prompt or credentials. */
		provider_routing_trace?: RouteResult['providerRoutingTrace'] | null;
		usage: UsageFromStream;
		/** Verified request-local pricing/evidence snapshot selected for this route. */
		endpoint_pricing_snapshot?: VerifiedModelEndpointSnapshot | null;
		model_pricing_profile?: string | null;
		route_price_override_json?: string | null;
		/** `users.charged_cost_factors` JSON；按 `model_id` 精确匹配后再乘路由 charged */
		user_charged_cost_factors_json?: string | null;
		/** @deprecated Ignored; nested metered tiers are not used for billing. */
		route_metered_profile_json?: string | null;
		/** @deprecated Ignored; nested charged tiers are not used for billing. */
		route_charged_profile_json?: string | null;
		/** 请求进入 Gateway 的时间；分时时段倍率在该时刻锁定。 */
		request_started_at_ms?: number;
		route_group: string;
		status: 'success' | 'error' | 'incomplete' | 'cancelled';
		latency_ms?: number;
		timing?: RequestTimingSnapshot | null;
		error_message?: string;
		provider_key_id?: string | null;
		provider_key_label?: string | null;
		provider_key_fingerprint?: string | null;
		/** 上游响应头 request id（传输层追踪，见 `upstream-request-id.ts`） */
		upstream_request_id?: string | null;
		/** 上游响应 body message id（应用层生成结果 id：chatcmpl-* / msg_* / responseId） */
		upstream_message_id?: string | null;
		/** 本次错误关联的熔断事件（展示在 webhook 告警中） */
		circuit_events?: GatewayCircuitAlertEvent[];
		/** 已有熔断短路等场景：写日志但不发 webhook */
		suppress_error_alert?: boolean;
		/** Output guardrail may replace a successful upstream response with 403; still settle the incurred usage. */
		charge_on_error?: boolean;
		/** Atomic Guardrail lease to settle with the request log transaction. */
		guardrail_budget_settlement?: {
			requestId: string;
			/** Preserve the full reserved ceiling when upstream usage is unavailable. */
			unknownCost: boolean;
		};
		/** Atomic ordinary-user budget lease settled with this request log. */
		ordinary_budget_settlement?: OrdinaryBudgetUsageSettlement;
	}
): Promise<void> {
	const basis = params.usage.input_tokens;
	const requestStartedAtMs = params.request_started_at_ms;
	const requestedPricingAtUtc =
		typeof requestStartedAtMs === 'number' && Number.isFinite(requestStartedAtMs)
			? new Date(requestStartedAtMs)
			: new Date();
	const pricingAtUtc = Number.isNaN(requestedPricingAtUtc.getTime())
		? new Date()
		: requestedPricingAtUtc;
	const businessTimezone = await getBusinessTimezone(repos);
	const baseFactors = parseRouteBaseFactors(params.route_price_override_json ?? null);
	const schedule = parseRoutePricingSchedule(params.route_price_override_json ?? null);
	const chargedSch = resolveDailyScheduleFactor(schedule.charged, pricingAtUtc, businessTimezone);
	const meteredSch = resolveDailyScheduleFactor(schedule.metered, pricingAtUtc, businessTimezone);

	const endpointPricing = resolveEndpointTextPricing(params.endpoint_pricing_snapshot);
	const routedUsage = params.route_target_id != null;
	if (routedUsage) {
		if (!endpointPricing.ok) {
			throw new Error(`Verified endpoint pricing is required for routed usage: ${endpointPricing.message}`);
		}
		if (
			params.endpoint_pricing_snapshot?.modelId !== params.model_id
			|| params.endpoint_pricing_snapshot?.providerId !== params.provider_id
		) {
			throw new Error('Verified endpoint pricing identity does not match routed usage');
		}
	}
	const endpointResolved = endpointPricing.ok ? endpointPricing.value : null;
	const legacySupplier = endpointResolved ? null : resolveSupplierBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: params.model_pricing_profile ?? null,
	});
	const legacyStandard = endpointResolved ? null : resolveStandardBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: params.model_pricing_profile ?? null,
	});
	const legacyCharged = endpointResolved ? null : resolveChargedBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: params.model_pricing_profile ?? null,
	});
	const auditSide = (
		prices: BillingPriceSnapshot,
		source: 'model_x_factor' | 'model',
	): { prices: BillingPriceSnapshot; audit: PriceResolutionAuditSide } => ({
		prices,
		audit: {
			path: 'profile',
			source,
			basis_tokens: basis,
			prices,
		},
	});
	const catalogSupplier = endpointResolved
		? auditSide(endpointResolved.standardPrices, 'model_x_factor')
		: legacySupplier!;
	const standardResolved = endpointResolved
		? auditSide(endpointResolved.standardPrices, 'model')
		: legacyStandard!;
	const catalogCharged = endpointResolved
		? auditSide(endpointResolved.chargedPrices, 'model_x_factor')
		: legacyCharged!;

	const supplierResolved = applyRouteFactorsToSide({
		catalog: catalogSupplier,
		baseFactor: baseFactors.meteredFactor,
		scheduleFactor: meteredSch,
		mode: schedule.mode,
	});
	const chargedResolved = applyRouteFactorsToSide({
		catalog: catalogCharged,
		baseFactor: baseFactors.chargedFactor,
		scheduleFactor: chargedSch,
		mode: schedule.mode,
	});

	const supplierRequestCost = endpointResolved
		? endpointResolved.standardRequestCost * (supplierResolved.audit.effective_factor ?? 1)
		: 0;
	const standardRequestCost = endpointResolved?.standardRequestCost ?? 0;
	const chargedRequestCost = endpointResolved
		? endpointResolved.chargedRequestCost * (chargedResolved.audit.effective_factor ?? 1)
		: 0;
	const supplierCost = computeMeteredCost(
		params.usage,
		supplierResolved.prices.input_price,
		supplierResolved.prices.output_price,
		supplierResolved.prices.cache_read_price,
		supplierResolved.prices.cache_write_price
	) + supplierRequestCost;
	const standardCost = computeMeteredCost(
		params.usage,
		standardResolved.prices.input_price,
		standardResolved.prices.output_price,
		standardResolved.prices.cache_read_price,
		standardResolved.prices.cache_write_price
	) + standardRequestCost;
	const chargedRaw = computeMeteredCost(
		params.usage,
		chargedResolved.prices.input_price,
		chargedResolved.prices.output_price,
		chargedResolved.prices.cache_read_price,
		chargedResolved.prices.cache_write_price
	) + chargedRequestCost;
	const routeChargedCost = roundGatewayMoney(chargedRaw);
	const factorsJson = params.user_charged_cost_factors_json ?? null;
	if (factorsJson != null && factorsJson.trim() !== '' && parseUserChargedCostFactors(factorsJson) == null) {
		console.warn(
			`[Gateway Billing] invalid users.charged_cost_factors ignored model_id=${params.model_id}`
		);
	}
	const userChargedFactor = lookupUserChargedCostFactor(
		parseUserChargedCostFactors(factorsJson),
		params.model_id
	);
	const resolvedChargedCost = applyUserChargedCostFactor(routeChargedCost, userChargedFactor);
	const billingCommitted = params.status !== 'error' || params.charge_on_error === true;
	const chargedCost = billingCommitted ? resolvedChargedCost : 0;
	chargedResolved.audit.user_charged_factor = userChargedFactor;
	const supplierCostR = roundGatewayMoney(supplierCost);
	const standardCostR = roundGatewayMoney(standardCost);
	const generationSnapshot = verifiedUsdGenerationWriteSnapshot({
		verifiedUsdPricing: endpointResolved != null,
		requestOrigin: params.request_origin,
		responseStreamed: params.response_streamed,
		chargedCostUsd: chargedCost,
		upstreamInferenceCostUsd: billingCommitted ? supplierCostR : null,
	});
	const pricingAuditJson = attachUserChargedFactorToPricingAudit(
		buildRequestPricingAuditJson({
			usage: params.usage,
			supplierAudit: supplierResolved.audit,
			standardAudit: standardResolved.audit,
			chargedAudit: chargedResolved.audit,
			...(endpointResolved ? {
				endpointPricing: endpointResolved.audit,
				requestCosts: {
					supplier: roundGatewayMoney(supplierRequestCost),
					standard: roundGatewayMoney(standardRequestCost),
					user_charge: roundGatewayMoney(chargedRequestCost),
				},
			} : {}),
		}),
		userChargedFactor
	);
	console.log(
		`[Gateway Usage] recordUsage model_id=${params.model_id} request_protocol=${params.request_protocol} status=${params.status} route_group=${params.route_group} input_tokens=${params.usage.input_tokens} output_tokens=${params.usage.output_tokens} reasoning_tokens=${params.usage.reasoning_tokens} metered=${supplierCostR} standard=${standardCostR} charged=${chargedCost} charged_eff=${chargedResolved.audit.effective_factor} user_charged_factor=${userChargedFactor ?? 'none'} metered_eff=${supplierResolved.audit.effective_factor}`
	);
	const id = params.request_log_id ?? crypto.randomUUID();
	const shouldChargeBudget = billingCommitted && chargedCost > 0;
	const hasOrdinaryBudgetSettlement = params.ordinary_budget_settlement != null;
	const userSnapshot = shouldChargeBudget || hasOrdinaryBudgetSettlement
		? await getUserBudgetSnapshot(repos, params.user_id)
		: null;
	const beforeSpent = userSnapshot?.budgetSpent ?? 0;
	const userRow = shouldChargeBudget || hasOrdinaryBudgetSettlement
		? await repos.users.getById(params.user_id)
		: null;
	const ordinarySettlement = params.ordinary_budget_settlement;
	const ordinaryAuditTransition = ordinaryBudgetAuditSnapshotTransition({
		settlement: ordinarySettlement,
		currentBudgetEpoch: userRow == null ? null : Number(userRow.budget_epoch),
		currentReservedMicros: userRow == null ? 0 : Number(userRow.budget_reserved_micros),
		chargedCost,
		shouldChargeBudget,
	});
	const afterSpentVal = roundGatewayMoney(beforeSpent + ordinaryAuditTransition.auditCharge);
	let usageSnaps: { before: string; after: string; changed: string | null } | null = null;
	if (userRow) {
		const beforeS = userRowToSnapshot(userRow);
		const afterS = ordinarySettlement && !ordinaryAuditTransition.settlementEpochMatches
			? beforeS
			: snapshotWithOverrides(beforeS, {
					budget_spent: afterSpentVal,
					budget_reserved_micros: ordinaryAuditTransition.afterReservedMicros,
				});
		usageSnaps = {
			before: snapshotToJson(beforeS),
			after: snapshotToJson(afterS),
			changed: changedFieldsToJson(computeChangedFields(beforeS, afterS)),
		};
	}
	await insertRequestUsageAndChargeTx(repos, {
		userId: params.user_id,
		requestLog: {
			id,
			userId: params.user_id,
			apiKeyId: params.api_key_id,
			workspaceId: params.workspace_id,
			userEmail: params.user_email,
			modelId: params.model_id,
			providerId: params.provider_id,
			providerModelName: params.provider_model_name ?? null,
			modelName: params.model_name ?? null,
			providerName: params.provider_name ?? null,
			requestBody: applyRequestBodyLoggingPolicy(
				params.request_body,
				params.request_body_logging_mode
			),
			upstreamRequestBody: applyRequestBodyLoggingPolicy(
				params.upstream_request_body,
				params.request_body_logging_mode
			),
			requestProtocol: params.request_protocol,
			requestOperation: params.request_operation ?? null,
			upstreamProtocol: params.upstream_protocol,
			upstreamOperation: params.upstream_operation ?? null,
			modelSurfaceId: params.model_surface_id ?? null,
			routePoolId: params.route_pool_id ?? null,
			routeTargetId: params.route_target_id ?? null,
			adapter: params.adapter ?? null,
			routeTrace: JSON.stringify({
				surface: params.model_surface_id ?? null,
				pool: params.route_pool_id ?? null,
				target: params.route_target_id ?? null,
				...(params.gemini_wire_action
					? { gemini: { action: params.gemini_wire_action } }
					: {}),
				...(params.sticky_trace ? { sticky: params.sticky_trace } : {}),
				...(params.model_fallback_trace
					? { model_fallback: params.model_fallback_trace }
					: {}),
				...(params.provider_routing_trace
					? { provider_routing: params.provider_routing_trace }
					: {}),
			}),
			inputTokens: params.usage.input_tokens,
			outputTokens: params.usage.output_tokens,
			cacheReadTokens: params.usage.cache_read_tokens,
			cacheWriteTokens: params.usage.cache_write_tokens,
			reasoningTokens: params.usage.reasoning_tokens,
			totalTokens: params.usage.total_tokens,
			meteredCost: supplierCostR,
			standardCost: standardCostR,
			chargedCost: chargedCost,
			budgetAccountedAt: pricingAtUtc.toISOString(),
			routeGroup: params.route_group,
			status: params.status,
			latencyMs: params.latency_ms ?? null,
			gatewayOverheadMs: params.timing?.gatewayOverheadMs ?? null,
			upstreamResponseMs: params.timing?.upstreamResponseMs ?? null,
			finalUpstreamHeadersMs: params.timing?.finalUpstreamHeadersMs ?? null,
			firstReasoningTokenMs: params.timing?.firstReasoningTokenMs ?? null,
			firstTokenMs: params.timing?.firstTokenMs ?? null,
			streamDurationMs: params.timing?.streamDurationMs ?? null,
			upstreamAttemptCount: params.timing?.upstreamAttemptCount ?? null,
			upstreamFailoverCount: params.timing?.upstreamFailoverCount ?? null,
			timingMetadata: params.timing?.timingMetadata ?? null,
			errorMessage: params.error_message ?? null,
			rawUsage: params.usage.raw_usage ?? null,
			pricingAudit: pricingAuditJson,
			providerKeyId: params.provider_key_id ?? null,
			providerKeyLabel: params.provider_key_label ?? null,
			providerKeyFingerprint: params.provider_key_fingerprint ?? null,
			upstreamRequestId: params.upstream_request_id ?? null,
			upstreamMessageId: params.upstream_message_id ?? null,
			...generationSnapshot,
		},
		shouldChargeBudget,
		beforeSpent,
		chargedCost,
		guardrailBudgetSettlement: params.guardrail_budget_settlement
			? {
				requestId: params.guardrail_budget_settlement.requestId,
				mode: params.guardrail_budget_settlement.unknownCost ? 'reserved' : 'actual',
				reason: params.guardrail_budget_settlement.unknownCost
					? 'usage_unavailable_after_dispatch'
					: 'request_usage_settled',
			}
			: undefined,
		userBudgetSettlement: ordinaryBudgetSettlementForCriticalWrite(
			params.ordinary_budget_settlement,
		),
		audit: {
			apiKeyId: params.api_key_id,
			eventType: 'usage_charge',
			actorType: 'system',
			reasonCode: 'request_usage_charged_cost',
			reasonText: 'Usage charge',
			beforeSpent: beforeSpent,
			beforeBudgetMax: userSnapshot?.budgetMax ?? null,
			afterBudgetMax: userSnapshot?.budgetMax ?? null,
			beforeBudgetPeriod: userSnapshot?.budgetPeriod ?? null,
			afterBudgetPeriod: userSnapshot?.budgetPeriod ?? null,
			beforeBudgetResetAt: userSnapshot?.budgetResetAt ?? null,
			afterBudgetResetAt: userSnapshot?.budgetResetAt ?? null,
			requestLogId: id,
			beforeUserSnapshot: usageSnaps?.before ?? null,
			afterUserSnapshot: usageSnaps?.after ?? null,
			changedFields: usageSnaps?.changed ?? null,
			correlationId: id,
			source: 'gateway_usage',
		},
	});
	if (params.status === 'error' && !params.suppress_error_alert) {
		await fireGatewayErrorWebhooks(repos, {
			requestLogId: id,
			occurredAt: new Date().toISOString(),
			apiKeyId: params.api_key_id,
			userEmail: params.user_email,
			modelId: params.model_id,
			modelName: params.model_name ?? null,
			providerId: params.provider_id,
			providerName: params.provider_name ?? null,
			providerModelName: params.provider_model_name ?? null,
			routeGroup: params.route_group,
			requestProtocol: params.request_protocol,
			upstreamProtocol: params.upstream_protocol,
			errorMessage: params.error_message ?? null,
			latencyMs: params.latency_ms ?? null,
			providerKeyId: params.provider_key_id ?? null,
			providerKeyLabel: params.provider_key_label ?? null,
			providerKeyFingerprint: params.provider_key_fingerprint ?? null,
			upstreamRequestId: params.upstream_request_id ?? null,
			circuitEvents: params.circuit_events,
		}).catch((err: unknown) => {
			console.warn(
				'[Gateway Alert] webhook dispatch failed',
				err instanceof Error ? err.stack ?? err.message : err
			);
		});
	}

	// 共享密钥收益结算（`sharedkey:` 前缀识别；幂等于 request_log_id）
	await settleSharedKeyEarning(repos, {
		requestLogId: id,
		providerKeyId: params.provider_key_id ?? null,
		usage: {
			input_tokens: params.usage.input_tokens,
			output_tokens: params.usage.output_tokens,
			cache_read_tokens: params.usage.cache_read_tokens,
			cache_write_tokens: params.usage.cache_write_tokens,
		},
	});
}
