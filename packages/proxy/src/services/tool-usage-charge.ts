/**
 * 固定单价工具调用记账：写入 request log（三账本）并原子增加 budget_spent（仅 charged）。
 */
import {
	buildFixedToolCostPricingAudit,
	changedFieldsToJson,
	computeChangedFields,
	getUserBudgetSnapshot,
	insertRequestUsageAndChargeTx,
	roundGatewayMoney,
	snapshotToJson,
	snapshotWithOverrides,
	userRowToSnapshot,
	type GatewayRepositories,
	type GuardrailBudgetSettlement,
	type ToolUnitPrices,
	type UserBudgetSettlement,
} from '@octafuse/core';
import {
	ordinaryBudgetReservationMicros,
	reserveOrdinaryUserBudget,
	type OrdinaryBudgetAdmissionResult,
	type OrdinaryBudgetLease,
} from './ordinary-budget-lifecycle';
import { ordinaryBudgetAuditSnapshotTransition } from './usage-tracker';
import {
	applyRequestBodyLoggingPolicy,
	type RequestBodyLoggingMode,
} from './request-body-log-policy';

export type ToolUserBudgetSettlement = UserBudgetSettlement & {
	/** Audit-only reservation generation; Core revalidates its own stored epoch. */
	budgetEpoch: number;
	/** Audit-only exact reservation ceiling in micro-units. */
	reservedMicros: number;
};

export type ToolFailureSettlement = {
	mode: UserBudgetSettlement['mode'];
	reason: 'tool_upstream_error_settled' | 'tool_upstream_result_unknown';
};

/**
 * A provider-shaped error is not proof of zero usage: it can be raised after
 * a 2xx response was consumed but failed parsing, output bounds, or a later
 * segment.  Only an explicit engine evidence flag may release the ceiling.
 */
export function toolFailureSettlement(
	error: unknown,
	options: { knownLocalFailure?: boolean } = {},
): ToolFailureSettlement {
	const outcome = typeof error === 'object' && error !== null && 'upstreamOutcome' in error
		? (error as { upstreamOutcome?: unknown }).upstreamOutcome
		: undefined;
	const knownZero = options.knownLocalFailure === true || outcome === 'known_zero';
	return knownZero
		? { mode: 'actual', reason: 'tool_upstream_error_settled' }
		: { mode: 'reserved', reason: 'tool_upstream_result_unknown' };
}

export type ChargeToolUsageParams = {
	repos: GatewayRepositories;
	/** Stable request id shared with the Guardrail reservation. */
	requestLogId?: string;
	/** Immutable request-start instant used to pin Guardrail accounting windows. */
	budgetAccountedAt?: string | null;
	/** Reservation settled atomically with the request log and user debit. */
	guardrailBudgetSettlement?: GuardrailBudgetSettlement;
	/** Ordinary-user reservation settled atomically with the same request log. */
	userBudgetSettlement?: ToolUserBudgetSettlement;
	apiKeyId: string;
	workspaceId: string;
	userId: string;
	userEmail: string | null;
	/** 记入 model_id，如 tool:web-search */
	toolId: string;
	/**
	 * Active 引擎 id（如 `bocha`、`tencent_tms`）。
	 * 写入 `provider_model_name`，并进入 `pricing_audit.provider`。
	 */
	toolProvider: string;
	/** 供应成本（写入 metered_cost） */
	meteredCost: number;
	/** 目录标准价（写入 standard_cost） */
	standardCost: number;
	/** 用户扣费（写入 charged_cost；唯一累加 budget_spent） */
	chargedCost: number;
	latencyMs: number;
	/** 工具入参 JSON（如 query） */
	requestBody?: string | null;
	requestBodyLoggingMode?: RequestBodyLoggingMode;
	/**
	 * 工具出参摘要 JSON（如搜索结果 title/url）。
	 * 复用 `api_key_request_logs.raw_usage`；工具无 token usage。
	 */
	responseBody?: string | null;
	errorMessage?: string | null;
	status: 'success' | 'error';
	/** Output Guardrail failures still charge a successfully completed upstream call. */
	chargeOnError?: boolean;
	/** pricing_audit 计费单位；默认 request */
	pricingUnit?: 'request' | 'chars';
	/** 计费单元数；默认 1 */
	billingUnits?: number;
	/**
	 * 单价（缩放前）。缺省时按 totals / billingUnits 反推。
	 */
	unitPrices?: ToolUnitPrices;
	/** 合并进 `pricing_audit`（勿覆盖 `provider`；以 {@link toolProvider} 为准） */
	pricingAuditExtra?: Record<string, unknown>;
};

export async function reserveToolOrdinaryBudget(
	repos: GatewayRepositories,
	params: {
		requestId: string;
		userId: string;
		apiKeyId: string;
		budgetMax: number | null;
		budgetEpoch: number;
		chargedCost: number;
		now: Date;
	},
): Promise<OrdinaryBudgetAdmissionResult> {
	// Validate even unlimited accounts; invalid catalog prices must never turn
	// into an implicit free tool call.
	const validated = ordinaryBudgetReservationMicros(params.chargedCost);
	if (!validated.ok) return { ok: false, error: validated.error };
	const exactChargedCost = roundGatewayMoney(params.chargedCost);
	return reserveOrdinaryUserBudget(repos, {
		requestId: params.requestId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		budgetMax: params.budgetMax,
		expectedBudgetEpoch: params.budgetEpoch,
		estimatedChargedCost: exactChargedCost,
		now: params.now,
	});
}

export function toolUserBudgetSettlement(
	lease: OrdinaryBudgetLease,
	mode: UserBudgetSettlement['mode'],
	reason: string,
): ToolUserBudgetSettlement | undefined {
	if (!lease.reserved) return undefined;
	if (lease.budgetEpoch == null || lease.reservedMicros <= 0) {
		throw new Error('Reserved ordinary tool budget lease is missing accounting metadata');
	}
	return {
		requestId: lease.requestId,
		mode,
		reason,
		budgetEpoch: lease.budgetEpoch,
		reservedMicros: lease.reservedMicros,
	};
}

/** Best-effort cleanup: releases before dispatch or forfeits after dispatch. */
export async function terminateToolOrdinaryBudgetSafely(
	lease: OrdinaryBudgetLease,
	reason: string,
): Promise<void> {
	try {
		await lease.terminateUnknown(reason);
	} catch (error) {
		console.error(
			`[Gateway Tools] ordinary budget cleanup failed requestId=${lease.requestId} state=${lease.state} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * 成功路径应调用；`status=error` 默认只写零成本日志。只有已完成上游、
 * 但输出被 Guardrail 拦截时才设置 `chargeOnError` 保留实际固定费用。
 */
export async function chargeToolUsage(params: ChargeToolUsageParams): Promise<{ requestLogId: string; chargedCost: number }> {
	const zeroCostError = params.status === 'error' && params.chargeOnError !== true;
	const meteredCost = roundGatewayMoney(zeroCostError ? 0 : params.meteredCost);
	const standardCost = roundGatewayMoney(zeroCostError ? 0 : params.standardCost);
	const chargedCost = roundGatewayMoney(zeroCostError ? 0 : params.chargedCost);
	const shouldChargeBudget = !zeroCostError && chargedCost > 0;
	const billingUnits =
		params.billingUnits != null && Number.isFinite(params.billingUnits) && params.billingUnits > 0
			? params.billingUnits
			: 1;
	const pricingUnit = params.pricingUnit ?? 'request';
	const unitPrices: ToolUnitPrices = params.unitPrices
		? {
				metered: roundGatewayMoney(params.unitPrices.metered),
				standard: roundGatewayMoney(params.unitPrices.standard),
				charged: roundGatewayMoney(params.unitPrices.charged),
			}
		: {
				metered: roundGatewayMoney(meteredCost / billingUnits),
				standard: roundGatewayMoney(standardCost / billingUnits),
				charged: roundGatewayMoney(chargedCost / billingUnits),
			};

	const toolProvider = params.toolProvider.trim();
	const pricingAudit = buildFixedToolCostPricingAudit({
		toolId: params.toolId,
		unit: pricingUnit,
		billingUnits,
		unitPrices,
		totals: { metered: meteredCost, standard: standardCost, charged: chargedCost },
		extra: {
			...(params.pricingAuditExtra ?? {}),
			...(toolProvider ? { provider: toolProvider } : {}),
		},
	});

	const id = params.requestLogId ?? crypto.randomUUID();
	const hasUserBudgetSettlement = params.userBudgetSettlement != null;
	const userSnapshot = shouldChargeBudget || hasUserBudgetSettlement
		? await getUserBudgetSnapshot(params.repos, params.userId)
		: null;
	const beforeSpent = userSnapshot?.budgetSpent ?? 0;
	const userRow = shouldChargeBudget || hasUserBudgetSettlement
		? await params.repos.users.getById(params.userId)
		: null;
	const ordinaryAuditTransition = ordinaryBudgetAuditSnapshotTransition({
		settlement: params.userBudgetSettlement
			? {
				requestId: params.userBudgetSettlement.requestId,
				budgetEpoch: params.userBudgetSettlement.budgetEpoch,
				reservedMicros: params.userBudgetSettlement.reservedMicros,
				unknownCost: params.userBudgetSettlement.mode === 'reserved',
			}
			: undefined,
		currentBudgetEpoch: userRow == null ? null : Number(userRow.budget_epoch),
		currentReservedMicros: userRow == null ? 0 : Number(userRow.budget_reserved_micros),
		chargedCost,
		shouldChargeBudget,
	});
	const afterSpentVal = roundGatewayMoney(beforeSpent + ordinaryAuditTransition.auditCharge);
	let usageSnaps: { before: string; after: string; changed: string | null } | null = null;
	if (userRow) {
		const beforeS = userRowToSnapshot(userRow);
		const afterS = params.userBudgetSettlement && !ordinaryAuditTransition.settlementEpochMatches
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

	await insertRequestUsageAndChargeTx(params.repos, {
		userId: params.userId,
		requestLog: {
			id,
			userId: params.userId,
			apiKeyId: params.apiKeyId,
			workspaceId: params.workspaceId,
			userEmail: params.userEmail,
			modelId: params.toolId,
			providerId: 'octafuse-tools',
			/** 引擎 id；Request Logs ROUTE 列第二行展示（不再重复写 tool id） */
			providerModelName: toolProvider || params.toolId,
			modelName: params.toolId,
			providerName: 'cinatoken Tools',
			requestBody: applyRequestBodyLoggingPolicy(
				params.requestBody,
				params.requestBodyLoggingMode
			),
			upstreamRequestBody: null,
			requestProtocol: 'openai',
			/**
			 * 列类型仅允许 openai|anthropic|gemini；Tools 无真正 upstream protocol。
			 * Admin Request Logs 对 `provider_id=octafuse-tools` 会隐藏该徽章，避免误读为模型上游。
			 */
			upstreamProtocol: 'openai',
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			meteredCost,
			standardCost,
			chargedCost,
			budgetAccountedAt: params.budgetAccountedAt ?? null,
			routeGroup: 'default',
			status: params.status,
			latencyMs: params.latencyMs,
			errorMessage: params.errorMessage ?? null,
			rawUsage: params.responseBody ?? null,
			pricingAudit: JSON.stringify(pricingAudit),
		},
		shouldChargeBudget,
		beforeSpent,
		chargedCost,
		guardrailBudgetSettlement: params.guardrailBudgetSettlement,
		userBudgetSettlement: params.userBudgetSettlement
			? {
				requestId: params.userBudgetSettlement.requestId,
				mode: params.userBudgetSettlement.mode,
				reason: params.userBudgetSettlement.reason,
			}
			: undefined,
		audit: {
			apiKeyId: params.apiKeyId,
			eventType: 'usage_charge',
			actorType: 'system',
			reasonCode: 'tool_usage_charged_cost',
			reasonText: `Tool charge: ${params.toolId}`,
			beforeSpent,
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
			/** 与 chat 用量扣费同属 `gateway_usage`；用 `reason_code=tool_usage_charged_cost` 区分 */
			source: 'gateway_usage',
		},
	});

	return { requestLogId: id, chargedCost };
}

/** 预检：当前额度是否够支付固定费用（budget_max 为 null 表示不限）。仅看 charged。 */
export function canAffordToolCost(
	budgetMax: number | null,
	budgetSpent: number,
	toolCost: number
): boolean {
	if (budgetMax == null) {
		return Number.isFinite(budgetSpent) && budgetSpent >= 0
			&& Number.isFinite(toolCost) && toolCost >= 0;
	}
	if (
		!Number.isFinite(budgetMax)
		|| budgetMax < 0
		|| !Number.isFinite(budgetSpent)
		|| budgetSpent < 0
		|| !Number.isFinite(toolCost)
		|| toolCost < 0
	) {
		return false;
	}
	const cost = roundGatewayMoney(toolCost);
	const total = budgetSpent + cost;
	if (!Number.isFinite(total)) return false;
	return roundGatewayMoney(total) <= roundGatewayMoney(budgetMax);
}
