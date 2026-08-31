/**
 * 图片计费：token 分项（text / image in / image out）或 per_image 按张 × 路由 factor。
 * 无有效目录价则不计费（legacy 仅 image 块须显式 `image_billing_mode: per_image`）。
 * 日志不落 prompt 原文 / 参考图 / Base64。
 */
import type {
	GatewayRepositories,
	UpstreamProtocol,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import {
	buildImagePrecheckUsage,
	changedFieldsToJson,
	computeChangedFields,
	computeImagePerImageMeteredCost,
	computeImageTokenMeteredCost,
	getBusinessTimezone,
	getUserBudgetSnapshot,
	guardrailBudgetUnits,
	insertRequestUsageAndChargeTx,
	parsePricingProfile,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	PRICING_AUDIT_JSON_SCHEMA_VERSION,
	profileHasImagePerImagePricing,
	profileHasImageTokenPricing,
	resolveChargedBillingPrices,
	resolveDailyScheduleFactor,
	resolveEffectiveRouteFactor,
	resolveImageBillingMode,
	resolveImageCatalogUnitPrice,
	resolveStandardBillingPrices,
	resolveSupplierBillingPrices,
	roundGatewayMoney,
	scaleBillingPrices,
	toScheduleAudit,
	applyUserChargedCostToBreakdown,
	snapshotToJson,
	snapshotWithOverrides,
	userRowToSnapshot,
	type ImageTokenUsage,
	type ParsedPricingProfile,
	type PriceResolutionAuditSide,
} from '@octafuse/core';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import { fireGatewayErrorWebhooks } from './alert-webhook';
import type { RequestTimingSnapshot } from './request-timing';
import {
	applyRequestBodyLoggingPolicy,
	type RequestBodyLoggingMode,
} from './request-body-log-policy';
import {
	ordinaryBudgetAuditSnapshotTransition,
	ordinaryBudgetSettlementForCriticalWrite,
	type OrdinaryBudgetUsageSettlement,
} from './usage-tracker';
import { resolveEndpointImagePricing } from './endpoint-image-billing-pricing';

export type ImageBillingParams = {
	/**
	 * Immutable verified Endpoint captured on the selected route. Routed image
	 * traffic uses this as the authoritative tariff; the legacy model profile is
	 * retained only for offline/backward-compatible helpers during cutover.
	 */
	endpoint?: VerifiedModelEndpointSnapshot | null;
	modelPricingProfileJson?: string | null;
	routePriceOverrideJson?: string | null;
	quality?: string | null;
	size?: string | null;
	imageCount: number;
	/** generations vs edits（token 预检是否加 image input 余量） */
	isEdit?: boolean;
	/** edits / generations 参考图张数 */
	referenceCount?: number;
	/** 请求进入 Gateway 的时间；分时时段倍率在该时刻锁定 */
	requestStartedAtMs?: number;
	/**
	 * Request-local pricing clock/config snapshot. Routed traffic must create it
	 * once and reuse it for every candidate precheck and chosen-route settlement.
	 */
	pricingContext?: ImagePricingContext;
	operation?: 'generations' | 'edits';
	/** 目录 `models.id`，用于查找用户 Charged 折扣 */
	catalogModelId?: string;
	/** `users.charged_cost_factors` JSON */
	userChargedCostFactorsJson?: string | null;
};

export type ImagePricingContext = Readonly<{
	pricingAtUtcMs: number;
	businessTimezone: string;
}>;

export type ImageCostBreakdown = {
	unitPrice: number;
	imageCount: number;
	meteredCost: number;
	standardCost: number;
	chargedCost: number;
	meteredFactor: number;
	chargedFactor: number;
	pricingAuditJson: string;
	/** token 路径写入日志的列；per_image 全 0 */
	logTokens: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
	};
	logImageCounts?: { inputImageCount: number; outputImageCount: number };
	billingKind: 'image_tokens' | 'image_per_image';
};

/** Convert the conservative image precheck into the integer ledger unit. */
export function imageGuardrailBudgetMicros(
	precheck: Pick<ImageCostBreakdown, 'chargedCost'>
): number {
	const micros = guardrailBudgetUnits(precheck.chargedCost, 'ceiling');
	return Number.isSafeInteger(micros) ? micros : Number.MAX_SAFE_INTEGER;
}

export function hasAuthoritativeImageTokenUsage(
	usage: ImageTokenUsage | null | undefined,
): usage is ImageTokenUsage {
	return usage != null && (
		usage.text_tokens > 0
		|| usage.cached_text_tokens > 0
		|| usage.image_input_tokens > 0
		|| usage.cached_image_input_tokens > 0
		|| usage.image_output_tokens > 0
		|| usage.total_tokens > 0
	);
}

export function imageGuardrailSettlementMode(params: {
	status: 'success' | 'error';
	tokenPriced: boolean;
	imageUsage: ImageTokenUsage | null | undefined;
	/** True when the provider returned a 2xx response, even if its output was unusable. */
	upstreamAccepted?: boolean;
	resultConfirmed?: boolean;
	/** Provider output exceeded the image count used for atomic admission. */
	outputCountExceededAdmission?: boolean;
	/** False only when transport/output evidence proves a non-billable terminal outcome. */
	clientOutcomeBillable?: boolean;
}): 'actual' | 'reserved' {
	if (params.status === 'error' && params.clientOutcomeBillable === false) return 'actual';
	if (params.outputCountExceededAdmission === true) return 'reserved';
	// A consumed 2xx response with unusable output cannot be classified as a
	// known-zero provider rejection. Preserve the admitted ceiling unless the
	// result was validated and the billing-mode metric is authoritative.
	if (params.upstreamAccepted === true && params.resultConfirmed === false) {
		return 'reserved';
	}
	if (
		params.status === 'success'
		&& params.tokenPriced
		&& !hasAuthoritativeImageTokenUsage(params.imageUsage)
	) {
		return 'reserved';
	}
	return 'actual';
}

export type MultipleImageBillingMode = 'per_image' | 'token';

/**
 * `n > 1` is admitted only when the catalog has an explicit settlement basis.
 * Token mode additionally requires authoritative aggregate usage after dispatch.
 */
export function multipleImageBillingMode(
	modelPricingProfileJson: string | null | undefined,
): MultipleImageBillingMode | null {
	const profile = parsePricingProfile(modelPricingProfileJson ?? null);
	const mode = resolveImageBillingMode(profile);
	if (mode === 'per_image' && profileHasImagePerImagePricing(profile)) return 'per_image';
	if (mode === 'token' && profileHasImageTokenPricing(profile)) return 'token';
	return null;
}

function withImageOutputAdmissionAudit(
	costs: ImageCostBreakdown,
	params: { admittedImageCount: number; observedImageCount: number },
): ImageCostBreakdown {
	let audit: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(costs.pricingAuditJson) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			audit = parsed as Record<string, unknown>;
		}
	} catch {
		/* retain a minimal audit object */
	}
	return {
		...costs,
		pricingAuditJson: JSON.stringify({
			...audit,
			admitted_output_image_count: params.admittedImageCount,
			observed_output_image_count: params.observedImageCount,
			output_count_clamped: true,
			settlement_basis: 'admission_ceiling',
		}),
	};
}

function withUserImageChargedFactor(
	breakdown: ImageCostBreakdown,
	params: ImageBillingParams
): ImageCostBreakdown {
	return applyUserChargedCostToBreakdown(
		breakdown,
		params.userChargedCostFactorsJson,
		params.catalogModelId ?? ''
	);
}

export type UncertainResultUsageSource =
	| 'client_abort_precheck'
	| 'gateway_timeout_precheck'
	| 'client_abort_no_charge'
	| 'gateway_timeout_no_charge'
	| 'uncertain_requested';

export type ImageAbortReason = 'client_abort' | 'gateway_timeout';

export type ShouldChargeUncertainImageResultParams = {
	status: 'success' | 'error';
	mode: ReturnType<typeof resolveImageBillingMode>;
	profile: ParsedPricingProfile | null;
	imageAbortReason?: ImageAbortReason | null;
	clientAbortPrecheck?: { chargedCost: number } | null;
};

/**
 * 未确认结果（客户端取消 / Gateway 超时）是否向用户扣费。
 * token / per_image 一律不扣（与上游 4xx/5xx 对齐）；`uncertain_result_policy` 不再作为 abort 扣费开关。
 */
export function shouldChargeUncertainImageResult(
	_params: ShouldChargeUncertainImageResultParams
): boolean {
	return false;
}

function pricingAtUtcFromParams(requestStartedAtMs?: number): Date {
	const requestedPricingAtUtc =
		typeof requestStartedAtMs === 'number' && Number.isFinite(requestStartedAtMs)
			? new Date(requestStartedAtMs)
			: new Date();
	return Number.isNaN(requestedPricingAtUtc.getTime()) ? new Date() : requestedPricingAtUtc;
}

/** Capture the only mutable schedule input once at the request boundary. */
export async function createImagePricingContext(
	repos: GatewayRepositories,
	requestStartedAtMs?: number,
): Promise<ImagePricingContext> {
	const pricingAtUtc = pricingAtUtcFromParams(requestStartedAtMs);
	const businessTimezone = await getBusinessTimezone(repos);
	return Object.freeze({
		pricingAtUtcMs: pricingAtUtc.getTime(),
		businessTimezone,
	});
}

async function resolveRouteFactors(
	repos: GatewayRepositories,
	routePriceOverrideJson: string | null | undefined,
	requestStartedAtMs?: number,
	pricingContext?: ImagePricingContext,
): Promise<{
	meteredFactor: number;
	chargedFactor: number;
	pricingAtUtc: string;
	businessTimezone: string;
	meteredAuditExtras: Pick<PriceResolutionAuditSide, 'base_factor' | 'schedule' | 'effective_factor'>;
	chargedAuditExtras: Pick<PriceResolutionAuditSide, 'base_factor' | 'schedule' | 'effective_factor'>;
}> {
	const pricingAtUtc = pricingContext
		? new Date(pricingContext.pricingAtUtcMs)
		: pricingAtUtcFromParams(requestStartedAtMs);
	const businessTimezone = pricingContext?.businessTimezone
		?? await getBusinessTimezone(repos);
	const baseFactors = parseRouteBaseFactors(routePriceOverrideJson ?? null);
	const schedule = parseRoutePricingSchedule(routePriceOverrideJson ?? null);
	const chargedSch = resolveDailyScheduleFactor(schedule.charged, pricingAtUtc, businessTimezone);
	const meteredSch = resolveDailyScheduleFactor(schedule.metered, pricingAtUtc, businessTimezone);
	const meteredFactor = resolveEffectiveRouteFactor(
		baseFactors.meteredFactor,
		meteredSch,
		schedule.mode
	);
	const chargedFactor = resolveEffectiveRouteFactor(
		baseFactors.chargedFactor,
		chargedSch,
		schedule.mode
	);
	const schSide = (sch: typeof chargedSch, base: number, effective: number) => ({
		base_factor: base,
		schedule: toScheduleAudit(sch),
		effective_factor: effective,
	});
	return {
		meteredFactor,
		chargedFactor,
		pricingAtUtc: pricingAtUtc.toISOString(),
		businessTimezone,
		meteredAuditExtras: schSide(meteredSch, baseFactors.meteredFactor, meteredFactor),
		chargedAuditExtras: schSide(chargedSch, baseFactors.chargedFactor, chargedFactor),
	};
}

function zeroImageCostBreakdown(
	params: ImageBillingParams,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	billingKind: ImageCostBreakdown['billingKind'],
	audit: Record<string, unknown>
): ImageCostBreakdown {
	return withUserImageChargedFactor(
		{
			unitPrice: 0,
			imageCount: Math.max(0, Math.floor(params.imageCount)),
			meteredCost: 0,
			standardCost: 0,
			chargedCost: 0,
			meteredFactor: factors.meteredFactor,
			chargedFactor: factors.chargedFactor,
			pricingAuditJson: JSON.stringify({
				v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
				kind: billingKind,
				...audit,
				metered_factor: factors.meteredFactor,
				charged_factor: factors.chargedFactor,
				pricing_at: factors.pricingAtUtc,
				business_timezone: factors.businessTimezone,
			}),
			logTokens: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
			},
			logImageCounts: { inputImageCount: 0, outputImageCount: 0 },
			billingKind,
		},
		params
	);
}

function endpointImageAuditIdentityFields(
	endpoint: VerifiedModelEndpointSnapshot | null | undefined,
): Record<string, unknown> {
	if (!endpoint) return {};
	return {
		source: 'verified_model_endpoint',
		endpoint_id: endpoint.id,
		model_id: endpoint.modelId,
		provider_id: endpoint.providerId,
		evidence_url: endpoint.evidenceUrl,
		verified_by: endpoint.verifiedBy,
		verified_at: endpoint.verifiedAt,
		expires_at: endpoint.expiresAt,
		currency: 'USD',
	};
}

function estimateImageTokenCosts(
	params: ImageBillingParams,
	usage: ImageTokenUsage,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	auditExtra?: Record<string, unknown>
): ImageCostBreakdown {
	// Image 目录价通常为单档 flat；仍复用 LLM 的 input-tokens 选档 API（basis 取 text+image_input）。
	const basis = usage.text_tokens + usage.image_input_tokens;
	const supplier = resolveSupplierBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: params.modelPricingProfileJson,
	});
	const standard = resolveStandardBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: params.modelPricingProfileJson,
	});
	const charged = resolveChargedBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: params.modelPricingProfileJson,
	});

	const supplierPrices = scaleBillingPrices(supplier.prices, factors.meteredFactor);
	const chargedPrices = scaleBillingPrices(charged.prices, factors.chargedFactor);

	const meteredCost = roundGatewayMoney(computeImageTokenMeteredCost(usage, supplierPrices));
	const standardCost = roundGatewayMoney(computeImageTokenMeteredCost(usage, standard.prices));
	const chargedCost = roundGatewayMoney(computeImageTokenMeteredCost(usage, chargedPrices));

	const pricingAuditJson = JSON.stringify({
		v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
		kind: 'image_tokens',
		quality: params.quality ?? null,
		size: params.size ?? null,
		...(auditExtra ?? {}),
		tokens: {
			text: usage.text_tokens,
			cached_text: usage.cached_text_tokens,
			image_input: usage.image_input_tokens,
			cached_image_input: usage.cached_image_input_tokens,
			image_output: usage.image_output_tokens,
			total: usage.total_tokens,
		},
		snapshot: {
			supplier: {
				...supplier.audit,
				source: 'model_x_factor',
				...factors.meteredAuditExtras,
				prices: supplierPrices,
			},
			standard: {
				...standard.audit,
				source: 'model',
				prices: standard.prices,
			},
			user_charge: {
				...charged.audit,
				source: 'model_x_factor',
				...factors.chargedAuditExtras,
				prices: chargedPrices,
			},
		},
	});

	return withUserImageChargedFactor(
		{
		unitPrice: 0,
		imageCount: Math.max(0, Math.floor(params.imageCount)),
		meteredCost,
		standardCost,
		chargedCost,
		meteredFactor: factors.meteredFactor,
		chargedFactor: factors.chargedFactor,
		pricingAuditJson,
		logTokens: {
			inputTokens: usage.text_tokens,
			outputTokens: usage.image_output_tokens,
			cacheReadTokens: usage.cached_text_tokens,
			cacheWriteTokens: 0,
			totalTokens: usage.total_tokens,
		},
		logImageCounts: { inputImageCount: 0, outputImageCount: 0 },
		billingKind: 'image_tokens',
		},
		params
	);
}

function estimateImagePerImageCosts(
	params: ImageBillingParams,
	profile: ParsedPricingProfile,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	options?: { outputCount?: number; referenceCount?: number; auditExtra?: Record<string, unknown> }
): ImageCostBreakdown {
	const imageCfg = profile.image!;
	const outputCount = Math.max(0, Math.floor(options?.outputCount ?? params.imageCount));
	const referenceCount = Math.max(
		0,
		Math.floor(options?.referenceCount ?? params.referenceCount ?? 0)
	);
	const outputUnitPrice = resolveImageCatalogUnitPrice(
		imageCfg,
		params.quality,
		params.size,
		'output'
	);
	const inputUnitPrice = resolveImageCatalogUnitPrice(
		imageCfg,
		params.quality,
		params.size,
		'input'
	);
	const baseCost = computeImagePerImageMeteredCost({
		outputCount,
		referenceCount,
		outputUnitPrice,
		inputUnitPrice,
	});
	const meteredCost = roundGatewayMoney(baseCost * factors.meteredFactor);
	const standardCost = roundGatewayMoney(baseCost);
	const chargedCost = roundGatewayMoney(baseCost * factors.chargedFactor);

	const pricingAuditJson = JSON.stringify({
		v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
		kind: 'image_per_image',
		quality: params.quality ?? null,
		size: params.size ?? null,
		output_unit_price: outputUnitPrice,
		input_unit_price: inputUnitPrice,
		input_image_count: referenceCount,
		output_image_count: outputCount,
		...(params.operation ? { operation: params.operation } : {}),
		metered_factor: factors.meteredFactor,
		charged_factor: factors.chargedFactor,
		pricing_at: factors.pricingAtUtc,
		business_timezone: factors.businessTimezone,
		...(options?.auditExtra ?? {}),
	});

	return withUserImageChargedFactor(
		{
			unitPrice: outputUnitPrice,
			imageCount: outputCount,
			meteredCost,
			standardCost,
			chargedCost,
			meteredFactor: factors.meteredFactor,
			chargedFactor: factors.chargedFactor,
			pricingAuditJson,
			logTokens: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
			},
			logImageCounts: { inputImageCount: referenceCount, outputImageCount: outputCount },
			billingKind: 'image_per_image',
		},
		params
	);
}

function endpointImageOperation(
	operation: ImageBillingParams['operation'],
): 'images.generations' | 'images.edits' {
	return operation === 'edits' ? 'images.edits' : 'images.generations';
}

/**
 * Price the currently provable subset of Image Endpoint tariffs. This branch
 * never reads models.pricing_profile: route selection, admission and chosen
 * route settlement all start from the same immutable endpoint evidence.
 */
function estimateEndpointImageCosts(
	params: ImageBillingParams,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	options?: {
		outputCount?: number;
		referenceCount?: number;
		auditExtra?: Record<string, unknown>;
	},
): ImageCostBreakdown {
	const outputCount = Math.max(0, Math.floor(options?.outputCount ?? params.imageCount));
	const referenceCount = Math.max(
		0,
		Math.floor(options?.referenceCount ?? params.referenceCount ?? 0),
	);
	const resolved = resolveEndpointImagePricing(params.endpoint, {
		operation: endpointImageOperation(params.operation),
		imageCount: outputCount,
		referenceCount,
	});
	if (!resolved.ok) {
		return zeroImageCostBreakdown(params, factors, 'image_per_image', {
			...endpointImageAuditIdentityFields(params.endpoint),
			error: resolved.reason,
			message: resolved.message,
		});
	}

	const standardCost = roundGatewayMoney(resolved.value.standardBaseCost);
	const meteredCost = roundGatewayMoney(
		resolved.value.standardBaseCost * factors.meteredFactor,
	);
	const chargedCost = roundGatewayMoney(
		resolved.value.standardBaseCost * factors.chargedFactor,
	);
	const pricingAuditJson = JSON.stringify({
		v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
		kind: 'image_per_image',
		...resolved.value.audit,
		operation: resolved.value.operation,
		quality: params.quality ?? null,
		size: params.size ?? null,
		input_image_count: referenceCount,
		output_image_count: outputCount,
		output_unit_price: resolved.value.standardOutputUnitCost,
		standard_base_cost: resolved.value.standardBaseCost,
		pricing_lines: resolved.value.selectedLines,
		metered_factor: factors.meteredFactor,
		charged_factor: factors.chargedFactor,
		pricing_at: factors.pricingAtUtc,
		business_timezone: factors.businessTimezone,
		...(options?.auditExtra ?? {}),
		snapshot: {
			supplier: {
				...resolved.value.audit,
				source: 'verified_model_endpoint_x_factor',
				...factors.meteredAuditExtras,
				cost: meteredCost,
			},
			standard: {
				...resolved.value.audit,
				source: 'verified_model_endpoint',
				cost: standardCost,
			},
			user_charge: {
				...resolved.value.audit,
				source: 'verified_model_endpoint_x_factor',
				...factors.chargedAuditExtras,
				cost: chargedCost,
			},
		},
	});

	return withUserImageChargedFactor(
		{
			unitPrice: resolved.value.standardOutputUnitCost,
			imageCount: outputCount,
			meteredCost,
			standardCost,
			chargedCost,
			meteredFactor: factors.meteredFactor,
			chargedFactor: factors.chargedFactor,
			pricingAuditJson,
			logTokens: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
			},
			logImageCounts: {
				inputImageCount: referenceCount,
				outputImageCount: outputCount,
			},
			billingKind: 'image_per_image',
		},
		params,
	);
}

/**
 * 估算用户应付（含路由倍率）；用于预检额度。
 * token：保守预检 usage；per_image：按请求张数 × 目录单价。
 */
export async function estimateImageCosts(
	repos: GatewayRepositories,
	params: ImageBillingParams,
	options?: { usage?: ImageTokenUsage | null; auditExtra?: Record<string, unknown> }
): Promise<ImageCostBreakdown> {
	const factors = await resolveRouteFactors(
		repos,
		params.routePriceOverrideJson,
		params.requestStartedAtMs,
		params.pricingContext,
	);
	if (params.endpoint) {
		return estimateEndpointImageCosts(params, factors, {
			outputCount: params.imageCount,
			referenceCount: params.referenceCount,
			auditExtra: options?.auditExtra,
		});
	}
	const profile = parsePricingProfile(params.modelPricingProfileJson ?? null);
	const mode = resolveImageBillingMode(profile);

	if (mode === 'per_image' && profile && profileHasImagePerImagePricing(profile)) {
		return estimateImagePerImageCosts(params, profile, factors, {
			outputCount: params.imageCount,
			referenceCount: params.referenceCount,
			auditExtra: options?.auditExtra,
		});
	}

	if (mode === 'token' && profile && profileHasImageTokenPricing(profile)) {
		const usage =
			options?.usage ??
			buildImagePrecheckUsage({
				quality: params.quality,
				size: params.size,
				isEdit: params.isEdit,
				imageCount: params.imageCount,
				referenceCount: params.referenceCount,
			});
		return estimateImageTokenCosts(params, usage, factors, options?.auditExtra);
	}

	return zeroImageCostBreakdown(params, factors, 'image_tokens', {
		error: 'missing_image_pricing',
	});
}

/**
 * 预算预检：对全部候选路由分别估算，取 **最高 charged_cost**。
 * 避免首路由失败后由更高 charged_factor 的 failover 路由成功导致预算越界。
 */
export async function estimateImageBudgetPrecheck(
	repos: GatewayRepositories,
	params: Omit<ImageBillingParams, 'routePriceOverrideJson'>,
	routePriceOverrideJsons: Array<string | null | undefined>
): Promise<ImageCostBreakdown> {
	const overrides =
		routePriceOverrideJsons.length > 0 ? routePriceOverrideJsons : [null];
	let best: ImageCostBreakdown | null = null;
	for (const override of overrides) {
		const costs = await estimateImageCosts(repos, {
			...params,
			routePriceOverrideJson: override ?? null,
		});
		if (!best || costs.chargedCost > best.chargedCost) {
			best = costs;
		}
	}
	return best!;
}

/** 将 breakdown 标为未确认结果扣费审计（client abort / gateway timeout / 按请求张数）。 */
export function withUncertainResultAudit(
	costs: ImageCostBreakdown,
	usageSource: UncertainResultUsageSource
): ImageCostBreakdown {
	let audit: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(costs.pricingAuditJson) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			audit = parsed as Record<string, unknown>;
		}
	} catch {
		/* keep empty */
	}
	return {
		...costs,
		pricingAuditJson: JSON.stringify({
			...audit,
			usage_source: usageSource,
		}),
	};
}

/** 将预算预检 breakdown 标为客户端取消扣费审计。 */
export function withClientAbortPrecheckAudit(costs: ImageCostBreakdown): ImageCostBreakdown {
	return withUncertainResultAudit(costs, 'client_abort_precheck');
}

function resolveUncertainUsageSource(
	imageAbortReason?: ImageAbortReason | null,
	options?: { charged?: boolean }
): UncertainResultUsageSource {
	const charged = options?.charged ?? true;
	if (imageAbortReason === 'client_abort') {
		return charged ? 'client_abort_precheck' : 'client_abort_no_charge';
	}
	if (imageAbortReason === 'gateway_timeout') {
		return charged ? 'gateway_timeout_precheck' : 'gateway_timeout_no_charge';
	}
	return 'uncertain_requested';
}

export type RecordImageUsageParams = {
	repos: GatewayRepositories;
	/** Stable request correlation id shared with the Guardrail reservation. */
	requestLogId?: string;
	/** Immutable request-start instant used to pin budget reconciliation windows. */
	budgetAccountedAt?: string | null;
	/** Reservation settled atomically with the request log and user debit. */
	guardrailBudgetSettlement?: {
		requestId: string;
		/** Independent transport/output evidence; must not depend on an ordinary lease existing. */
		mode?: 'actual' | 'reserved';
	};
	/** Ordinary user-budget reservation settled atomically with this usage write. */
	ordinaryBudgetSettlement?: OrdinaryBudgetUsageSettlement;
	apiKeyId: string;
	workspaceId: string;
	userId: string;
	userEmail: string | null;
	modelId: string;
	providerId: string;
	providerModelName?: string | null;
	modelName?: string | null;
	providerName?: string | null;
	requestBody?: string | null;
	upstreamRequestBody?: string | null;
	requestBodyLoggingMode?: RequestBodyLoggingMode;
	requestProtocol: 'openai';
	requestOperation?: string | null;
	upstreamProtocol: UpstreamProtocol;
	upstreamOperation?: string | null;
	modelSurfaceId?: string | null;
	routePoolId?: string | null;
	routeTargetId?: string | null;
	adapter?: string | null;
	/** Provider sticky routing observation (merged into route_trace.sticky). */
	stickyTrace?: {
		lookup: string;
		attempted_target: string | null;
		result: string;
	} | null;
	providerRoutingTrace?: import('./model-router').RouteResult['providerRoutingTrace'] | null;
	routeGroup: string;
	status: 'success' | 'error';
	latencyMs: number;
	errorMessage?: string | null;
	billing: ImageBillingParams;
	/** 成功时实际有效图片数（per_image 扣费权威；token 仅日志摘要） */
	effectiveImageCount?: number;
	/** 上游解析的 token usage；token 路径扣费权威 */
	imageUsage?: ImageTokenUsage | null;
	/**
	 * 客户端取消 / Gateway 超时：传入入口预算预检 breakdown，仅作审计对照，不再作为扣费权威。
	 */
	clientAbortPrecheck?: ImageCostBreakdown | null;
	imageAbortReason?: ImageAbortReason | null;
	resultConfirmed?: boolean;
	/** Provider returned a 2xx response before local output validation. */
	upstreamAccepted?: boolean;
	/** False only for a proven non-billable terminal outcome; unknown is omitted. */
	clientOutcomeBillable?: boolean;
	upstreamSupplierCostUsdTicks?: number | null;
	providerKeyId?: string | null;
	providerKeyLabel?: string | null;
	providerKeyFingerprint?: string | null;
	upstreamRequestId?: string | null;
	timing?: RequestTimingSnapshot | null;
	circuitEvents?: GatewayCircuitAlertEvent[];
	suppressErrorAlert?: boolean;
};

/**
 * 写入用量日志并在成功且 charged>0 时扣费。取消 / 超时 / 明确错误一律不扣。
 */
export async function recordImageUsage(params: RecordImageUsageParams): Promise<{
	requestLogId: string;
	chargedCost: number;
}> {
	const hasEndpointPricing = params.billing.endpoint != null;
	if (
		hasEndpointPricing
		&& (
			params.billing.endpoint!.modelId !== params.modelId
			|| params.billing.endpoint!.providerId !== params.providerId
		)
	) {
		throw new Error('Verified image endpoint pricing identity does not match routed usage');
	}
	const profile = hasEndpointPricing
		? null
		: parsePricingProfile(params.billing.modelPricingProfileJson ?? null);
	const mode = hasEndpointPricing ? 'per_image' : resolveImageBillingMode(profile);
	const admittedImageCount = Number.isFinite(params.billing.imageCount)
		? Math.max(0, Math.floor(params.billing.imageCount))
		: 0;
	const observedImageCount = params.status === 'success'
		&& Number.isFinite(params.effectiveImageCount)
		? Math.max(0, Math.floor(params.effectiveImageCount!))
		: admittedImageCount;
	const outputCountExceededAdmission =
		params.status === 'success' && observedImageCount > admittedImageCount;
	const outputImageCountForLog =
		params.status === 'success'
			? Math.min(observedImageCount, admittedImageCount)
			: 0;
	const derivedSettlementMode = imageGuardrailSettlementMode({
		status: params.status,
		tokenPriced:
			mode === 'token'
			&& profile != null
			&& profileHasImageTokenPricing(profile),
		imageUsage: params.imageUsage,
		upstreamAccepted: params.upstreamAccepted,
		resultConfirmed: params.resultConfirmed,
		outputCountExceededAdmission,
		clientOutcomeBillable: params.clientOutcomeBillable,
	});
	const sharedSettlementMode: 'actual' | 'reserved' =
		params.guardrailBudgetSettlement?.mode === 'reserved'
		|| params.ordinaryBudgetSettlement?.unknownCost === true
		|| derivedSettlementMode === 'reserved'
			? 'reserved'
			: 'actual';
	const ordinaryBudgetSettlement = params.ordinaryBudgetSettlement
		? {
				...params.ordinaryBudgetSettlement,
				unknownCost: sharedSettlementMode === 'reserved',
			}
		: undefined;
	const imageAbortReason = params.imageAbortReason ?? null;
	const isUncertainCharge =
		params.status === 'error' &&
		(imageAbortReason === 'client_abort' ||
			imageAbortReason === 'gateway_timeout' ||
			params.clientAbortPrecheck != null);

	const chargeUncertain = shouldChargeUncertainImageResult({
		status: params.status,
		mode,
		profile,
		imageAbortReason,
		clientAbortPrecheck: params.clientAbortPrecheck,
	});

	const effectiveOutputImageCountForLog =
		params.status === 'success'
			? outputImageCountForLog
			: chargeUncertain
				? admittedImageCount
				: 0;

	let costs: ImageCostBreakdown;
	if (isUncertainCharge) {
		const factors = await resolveRouteFactors(
			params.repos,
			params.billing.routePriceOverrideJson,
			params.billing.requestStartedAtMs,
			params.billing.pricingContext,
		);
		const billingKind =
			hasEndpointPricing
				? 'image_per_image'
				: mode === 'per_image' && profile && profileHasImagePerImagePricing(profile)
				? 'image_per_image'
				: 'image_tokens';
		costs = zeroImageCostBreakdown(params.billing, factors, billingKind, {
			...endpointImageAuditIdentityFields(params.billing.endpoint),
			error: 'request_failed',
			result_confirmed: false,
			usage_source: resolveUncertainUsageSource(imageAbortReason, { charged: false }),
		});
	} else if (params.status === 'error') {
		const factors = await resolveRouteFactors(
			params.repos,
			params.billing.routePriceOverrideJson,
			params.billing.requestStartedAtMs,
			params.billing.pricingContext,
		);
		costs = zeroImageCostBreakdown(
			params.billing,
			factors,
			hasEndpointPricing ? 'image_per_image' : 'image_tokens',
			{
			error: 'request_failed',
			...(hasEndpointPricing
				? endpointImageAuditIdentityFields(params.billing.endpoint)
				: {}),
			},
		);
	} else if (outputCountExceededAdmission) {
		// Never let provider overproduction raise an actual debit above the count
		// atomically admitted. Re-price from the admitted precheck basis and keep
		// both ledgers at their reserved ceilings.
		costs = await estimateImageCosts(
			params.repos,
			{ ...params.billing, imageCount: admittedImageCount },
			{
				auditExtra: {
					admitted_output_image_count: admittedImageCount,
					observed_output_image_count: observedImageCount,
					output_count_clamped: true,
					settlement_basis: 'admission_ceiling',
				},
			},
		);
	} else if (hasEndpointPricing) {
		const factors = await resolveRouteFactors(
			params.repos,
			params.billing.routePriceOverrideJson,
			params.billing.requestStartedAtMs,
			params.billing.pricingContext,
		);
		const auditExtra: Record<string, unknown> = {
			result_confirmed: params.resultConfirmed ?? true,
		};
		if (params.upstreamSupplierCostUsdTicks != null) {
			auditExtra.supplier_cost_usd_ticks = params.upstreamSupplierCostUsdTicks;
		}
		costs = estimateEndpointImageCosts(params.billing, factors, {
			outputCount: effectiveOutputImageCountForLog,
			referenceCount: params.billing.referenceCount,
			auditExtra,
		});
	} else if (mode === 'per_image' && profile && profileHasImagePerImagePricing(profile)) {
		const factors = await resolveRouteFactors(
			params.repos,
			params.billing.routePriceOverrideJson,
			params.billing.requestStartedAtMs,
			params.billing.pricingContext,
		);
		const auditExtra: Record<string, unknown> = { result_confirmed: params.resultConfirmed ?? true };
		if (params.upstreamSupplierCostUsdTicks != null) {
			auditExtra.supplier_cost_usd_ticks = params.upstreamSupplierCostUsdTicks;
		}
		costs = estimateImagePerImageCosts(params.billing, profile, factors, {
			outputCount: effectiveOutputImageCountForLog,
			referenceCount: params.billing.referenceCount,
			auditExtra,
		});
	} else if (mode === 'token' && profile && profileHasImageTokenPricing(profile)) {
		if (hasAuthoritativeImageTokenUsage(params.imageUsage)) {
			costs = await estimateImageCosts(
				params.repos,
				{ ...params.billing, imageCount: effectiveOutputImageCountForLog },
				{ usage: params.imageUsage }
			);
		} else {
			const fallbackUsage = buildImagePrecheckUsage({
				quality: params.billing.quality,
				size: params.billing.size,
				isEdit: params.billing.isEdit,
				imageCount: effectiveOutputImageCountForLog,
				referenceCount: params.billing.referenceCount,
			});
			costs = await estimateImageCosts(
				params.repos,
				{ ...params.billing, imageCount: effectiveOutputImageCountForLog },
				{
					usage: fallbackUsage,
					auditExtra: { usage_source: 'precheck_fallback', error: 'missing_upstream_usage' },
				}
			);
		}
	} else {
		costs = await estimateImageCosts(params.repos, {
			...params.billing,
			imageCount: effectiveOutputImageCountForLog,
		});
	}
	if (outputCountExceededAdmission) {
		costs = withImageOutputAdmissionAudit(costs, {
			admittedImageCount,
			observedImageCount,
		});
	}

	const errorWithoutCharge = params.status === 'error' && !chargeUncertain;
	const chargedCost = errorWithoutCharge ? 0 : costs.chargedCost;
	const meteredCost = errorWithoutCharge ? 0 : costs.meteredCost;
	const standardCost = errorWithoutCharge ? 0 : costs.standardCost;
	const shouldChargeBudget = !errorWithoutCharge && chargedCost > 0;
	const id = params.requestLogId ?? crypto.randomUUID();
	const hasOrdinaryBudgetSettlement = ordinaryBudgetSettlement != null;
	const userSnapshot = shouldChargeBudget || hasOrdinaryBudgetSettlement
		? await getUserBudgetSnapshot(params.repos, params.userId)
		: null;
	const beforeSpent = userSnapshot?.budgetSpent ?? 0;
	const userRow = shouldChargeBudget || hasOrdinaryBudgetSettlement
		? await params.repos.users.getById(params.userId)
		: null;
	const ordinaryAuditTransition = ordinaryBudgetAuditSnapshotTransition({
		settlement: ordinaryBudgetSettlement,
		currentBudgetEpoch: userRow == null ? null : Number(userRow.budget_epoch),
		currentReservedMicros: userRow == null ? 0 : Number(userRow.budget_reserved_micros),
		chargedCost,
		shouldChargeBudget,
	});
	const afterSpentVal = roundGatewayMoney(beforeSpent + ordinaryAuditTransition.auditCharge);
	let usageSnaps: { before: string; after: string; changed: string | null } | null = null;
	if (userRow) {
		const beforeS = userRowToSnapshot(userRow);
		const afterS = ordinaryBudgetSettlement && !ordinaryAuditTransition.settlementEpochMatches
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

	const logInputImages = costs.logImageCounts?.inputImageCount ?? 0;
	const logOutputImages =
		outputCountExceededAdmission
			? effectiveOutputImageCountForLog
			: costs.logImageCounts?.outputImageCount ?? effectiveOutputImageCountForLog;

	const rawUsage =
		params.imageUsage?.raw_usage ??
		(params.status === 'success'
			? JSON.stringify({
					image_count: logOutputImages,
					billing_kind: costs.billingKind,
					input_image_count: logInputImages,
					output_image_count: logOutputImages,
				})
			: isUncertainCharge
				? JSON.stringify({
						image_count: logOutputImages,
						billing_kind: costs.billingKind,
						input_image_count: logInputImages,
						output_image_count: logOutputImages,
						usage_source: resolveUncertainUsageSource(imageAbortReason, {
							charged: chargeUncertain,
						}),
					})
				: null);
	const guardrailSettlementMode = sharedSettlementMode;

	console.log(
		`[Gateway Usage] recordImageUsage model_id=${params.modelId} status=${params.status} kind=${costs.billingKind} images=${logOutputImages} input_images=${logInputImages} metered=${meteredCost} standard=${standardCost} charged=${chargedCost}${
			chargeUncertain ? ` uncertain_charge=1 reason=${imageAbortReason ?? 'precheck'}` : ''
		}`
	);

	await insertRequestUsageAndChargeTx(params.repos, {
		userId: params.userId,
		requestLog: {
			id,
			userId: params.userId,
			apiKeyId: params.apiKeyId,
			workspaceId: params.workspaceId,
			userEmail: params.userEmail,
			modelId: params.modelId,
			providerId: params.providerId,
			providerModelName: params.providerModelName ?? null,
			modelName: params.modelName ?? null,
			providerName: params.providerName ?? null,
			requestBody: applyRequestBodyLoggingPolicy(
				params.requestBody,
				params.requestBodyLoggingMode
			),
			upstreamRequestBody: applyRequestBodyLoggingPolicy(
				params.upstreamRequestBody,
				params.requestBodyLoggingMode
			),
			requestProtocol: params.requestProtocol,
			requestOperation: params.requestOperation ?? null,
			upstreamProtocol: params.upstreamProtocol,
			upstreamOperation: params.upstreamOperation ?? null,
			modelSurfaceId: params.modelSurfaceId ?? null,
			routePoolId: params.routePoolId ?? null,
			routeTargetId: params.routeTargetId ?? null,
			adapter: params.adapter ?? null,
			routeTrace: JSON.stringify({
				surface: params.modelSurfaceId ?? null,
				pool: params.routePoolId ?? null,
				target: params.routeTargetId ?? null,
				...(params.stickyTrace ? { sticky: params.stickyTrace } : {}),
				...(params.providerRoutingTrace ? { provider_routing: params.providerRoutingTrace } : {}),
			}),
			inputTokens: costs.logTokens.inputTokens,
			outputTokens: costs.logTokens.outputTokens,
			cacheReadTokens: costs.logTokens.cacheReadTokens,
			cacheWriteTokens: costs.logTokens.cacheWriteTokens,
			reasoningTokens: 0,
			totalTokens: costs.logTokens.totalTokens,
			meteredCost,
			standardCost,
			chargedCost,
			budgetAccountedAt:
				params.budgetAccountedAt
				?? pricingAtUtcFromParams(params.billing.requestStartedAtMs).toISOString(),
			routeGroup: params.routeGroup,
			status: params.status,
			latencyMs: params.latencyMs,
			gatewayOverheadMs: params.timing?.gatewayOverheadMs ?? null,
			upstreamResponseMs: params.timing?.upstreamResponseMs ?? null,
			finalUpstreamHeadersMs: params.timing?.finalUpstreamHeadersMs ?? null,
			firstReasoningTokenMs: params.timing?.firstReasoningTokenMs ?? null,
			firstTokenMs: params.timing?.firstTokenMs ?? null,
			streamDurationMs: params.timing?.streamDurationMs ?? null,
			upstreamAttemptCount: params.timing?.upstreamAttemptCount ?? null,
			upstreamFailoverCount: params.timing?.upstreamFailoverCount ?? null,
			timingMetadata: params.timing?.timingMetadata ?? null,
			errorMessage: params.errorMessage ?? null,
			rawUsage,
			pricingAudit: costs.pricingAuditJson,
			billingKind: costs.billingKind,
			inputImageCount: logInputImages,
			outputImageCount: logOutputImages,
			providerKeyId: params.providerKeyId ?? null,
			providerKeyLabel: params.providerKeyLabel ?? null,
			providerKeyFingerprint: params.providerKeyFingerprint ?? null,
			upstreamRequestId: params.upstreamRequestId ?? null,
			upstreamMessageId: null,
		},
		shouldChargeBudget,
		beforeSpent,
		chargedCost,
		guardrailBudgetSettlement: params.guardrailBudgetSettlement
			? {
				requestId: params.guardrailBudgetSettlement.requestId,
				mode: guardrailSettlementMode,
				reason: guardrailSettlementMode === 'reserved'
					? 'image_usage_unavailable_after_dispatch'
					: 'image_usage_settled',
			}
			: undefined,
		userBudgetSettlement: ordinaryBudgetSettlementForCriticalWrite(
			ordinaryBudgetSettlement,
		),
		audit: {
			apiKeyId: params.apiKeyId,
			eventType: 'usage_charge',
			actorType: 'system',
			reasonCode: 'image_usage_charged_cost',
			reasonText: `Image charge: ${params.modelId}`,
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
			source: 'gateway_usage',
		},
	});

	if (params.status === 'error' && !params.suppressErrorAlert) {
		await fireGatewayErrorWebhooks(params.repos, {
			requestLogId: id,
			occurredAt: new Date().toISOString(),
			apiKeyId: params.apiKeyId,
			userEmail: params.userEmail,
			modelId: params.modelId,
			modelName: params.modelName ?? null,
			providerId: params.providerId,
			providerName: params.providerName ?? null,
			providerModelName: params.providerModelName ?? null,
			routeGroup: params.routeGroup,
			requestProtocol: params.requestProtocol,
			upstreamProtocol: params.upstreamProtocol,
			errorMessage: params.errorMessage ?? null,
			latencyMs: params.latencyMs,
			providerKeyId: params.providerKeyId ?? null,
			providerKeyLabel: params.providerKeyLabel ?? null,
			providerKeyFingerprint: params.providerKeyFingerprint ?? null,
			upstreamRequestId: params.upstreamRequestId ?? null,
			circuitEvents: params.circuitEvents,
		}).catch((err: unknown) => {
			console.warn(
				'[Gateway Alert] webhook dispatch failed',
				err instanceof Error ? err.stack ?? err.message : err
			);
		});
	}

	return { requestLogId: id, chargedCost };
}
