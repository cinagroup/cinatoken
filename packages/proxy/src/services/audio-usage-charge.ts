/**
 * 音频转写计费：
 * - `per_second`：duration × price_per_second × 路由 factor（whisper）
 * - `token`：上游 usage tokens × $/1M × 路由 factor（gpt-4o-*transcribe）
 * 最终扣费禁止用字节估算冒充 token；缺上游 token usage 时计 0 并审计。
 */
import type {
	AudioEndpointPricingOperation,
	GatewayRepositories,
	UpstreamProtocol,
	VerifiedModelEndpointSnapshot,
} from '@octafuse/core';
import {
	AUDIO_ENDPOINT_PRICING_OPERATIONS,
	buildAudioTokenPrecheckUsage,
	changedFieldsToJson,
	computeAudioPerSecondMeteredCost,
	computeAudioPerCharacterMeteredCost,
	computeAudioTokenMeteredCost,
	computeChangedFields,
	EMPTY_AUDIO_TOKEN_USAGE,
	getBusinessTimezone,
	getUserBudgetSnapshot,
	guardrailBudgetUnits,
	insertRequestUsageAndChargeTx,
	parsePricingProfile,
	parseRouteBaseFactors,
	parseRoutePricingSchedule,
	PRICING_AUDIT_JSON_SCHEMA_VERSION,
	profileHasAudioPerSecondPricing,
	profileHasAudioPerCharacterPricing,
	profileHasAudioTokenPricing,
	resolveAudioBillingMode,
	resolveBillableAudioSeconds,
	resolveBillableAudioCharacters,
	resolveChargedBillingPrices,
	resolveDailyScheduleFactor,
	resolveEffectiveRouteFactor,
	resolveStandardBillingPrices,
	resolveSupplierBillingPrices,
	roundGatewayMoney,
	scaleBillingPrices,
	toScheduleAudit,
	applyUserChargedCostToBreakdown,
	snapshotToJson,
	snapshotWithOverrides,
	userRowToSnapshot,
	type AudioTokenUsage,
	type AudioPerSecondPricingConfig,
	type AudioPerCharacterPricingConfig,
	type ParsedPricingProfile,
	type PriceResolutionAuditSide,
} from '@octafuse/core';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import { fireGatewayErrorWebhooks } from './alert-webhook';
import type { RequestTimingSnapshot } from './request-timing';
import {
	MAX_AUDIO_DURATION_SECONDS,
	resolveAudioBillingDuration,
} from './egress/audio-duration';
import {
	applyRequestBodyLoggingPolicy,
	type RequestBodyLoggingMode,
} from './request-body-log-policy';
import { verifiedUsdGenerationWriteSnapshot } from './generation-metadata-snapshot';
import {
	ordinaryBudgetAuditSnapshotTransition,
	ordinaryBudgetSettlementForCriticalWrite,
	type OrdinaryBudgetUsageSettlement,
} from './usage-tracker';
import { resolveEndpointAudioPricing } from './endpoint-audio-billing-pricing';

export type AudioBillingParams = {
	/** Immutable verified Endpoint captured on the selected route. */
	endpoint?: VerifiedModelEndpointSnapshot | null;
	/** Exact selected upstream operation used to select Endpoint pricing evidence. */
	operation?: AudioEndpointPricingOperation | null;
	modelPricingProfileJson?: string | null;
	routePriceOverrideJson?: string | null;
	/** per_second 计费时长；token 模式仅作预检/日志参考 */
	durationSeconds: number;
	durationSource?: 'upstream' | 'media' | 'client' | 'estimated' | 'precheck';
	fileBytes?: number;
	requestStartedAtMs?: number;
	/** Request-local snapshot; prevents a timezone change from drifting settlement. */
	businessTimezone?: string;
	/** token 模式最终扣费：上游真实 usage；缺省则不计费 */
	tokenUsage?: AudioTokenUsage | null;
	/** TTS 最终扣费：已验证的计费字符数（按字符 TTS 使用请求输入）；缺省则不可证明。 */
	characters?: number | null;
	/** 目录 `models.id`，用于查找用户 Charged 折扣 */
	catalogModelId?: string;
	/** `users.charged_cost_factors` JSON */
	userChargedCostFactorsJson?: string | null;
};

/**
 * Resolve a route operation to the exact Endpoint audio pricing operation.
 * This intentionally performs no trimming or aliasing: pricing evidence must
 * match the canonical operation selected by the route.
 */
export function resolveCanonicalAudioEndpointPricingOperation(
	operation: string | null | undefined,
): AudioEndpointPricingOperation | null {
	return AUDIO_ENDPOINT_PRICING_OPERATIONS.find(
		(candidate) => candidate === operation,
	) ?? null;
}

export type AudioCostBreakdown = {
	durationSeconds: number;
	billableSeconds: number;
	pricePerSecond: number;
	characters: number;
	billableCharacters: number;
	pricePerCharacter: number;
	meteredCost: number;
	standardCost: number;
	chargedCost: number;
	meteredFactor: number;
	chargedFactor: number;
	pricingAuditJson: string;
	billingKind: 'audio_per_second' | 'audio_tokens' | 'audio_per_character';
	logTokens: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
};

function withUserAudioChargedFactor(
	breakdown: AudioCostBreakdown,
	billing: AudioBillingParams
): AudioCostBreakdown {
	return applyUserChargedCostToBreakdown(
		breakdown,
		billing.userChargedCostFactorsJson,
		billing.catalogModelId ?? ''
	);
}

function pricingAtUtcFromParams(requestStartedAtMs?: number): Date {
	const requestedPricingAtUtc =
		typeof requestStartedAtMs === 'number' && Number.isFinite(requestStartedAtMs)
			? new Date(requestStartedAtMs)
			: new Date();
	return Number.isNaN(requestedPricingAtUtc.getTime()) ? new Date() : requestedPricingAtUtc;
}

async function resolveRouteFactors(
	repos: GatewayRepositories,
	routePriceOverrideJson: string | null | undefined,
	requestStartedAtMs?: number,
	businessTimezoneSnapshot?: string,
): Promise<{
	meteredFactor: number;
	chargedFactor: number;
	pricingAtUtc: string;
	businessTimezone: string;
	meteredAuditExtras: Pick<PriceResolutionAuditSide, 'base_factor' | 'schedule' | 'effective_factor'>;
	chargedAuditExtras: Pick<PriceResolutionAuditSide, 'base_factor' | 'schedule' | 'effective_factor'>;
}> {
	const pricingAtUtc = pricingAtUtcFromParams(requestStartedAtMs);
	const businessTimezone = businessTimezoneSnapshot?.trim()
		? businessTimezoneSnapshot
		: await getBusinessTimezone(repos);
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

function buildAudioPerSecondCosts(
	billing: AudioBillingParams,
	profile: ParsedPricingProfile & {
		audio_billing_mode: 'per_second';
		audio: AudioPerSecondPricingConfig;
	},
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>
): AudioCostBreakdown {
	const audioCfg = profile.audio;
	const pricePerSecond = audioCfg.price_per_second;
	const billableSeconds = resolveBillableAudioSeconds(billing.durationSeconds, audioCfg);
	const baseCost = computeAudioPerSecondMeteredCost({
		durationSeconds: billing.durationSeconds,
		pricePerSecond,
		minimumSeconds: audioCfg.minimum_seconds,
	});
	const meteredCost = roundGatewayMoney(baseCost * factors.meteredFactor);
	const standardCost = roundGatewayMoney(baseCost);
	const chargedCost = roundGatewayMoney(baseCost * factors.chargedFactor);
	const pricingAuditJson = JSON.stringify({
		v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
		kind: 'audio_per_second',
		snapshot: {
			kind: 'audio_per_second',
			duration_seconds: billing.durationSeconds,
			billable_seconds: billableSeconds,
			price_per_second: pricePerSecond,
			minimum_seconds: audioCfg.minimum_seconds ?? 1,
			duration_source: billing.durationSource ?? 'upstream',
			file_bytes: billing.fileBytes ?? null,
			supplier: {
				path: 'profile',
				source: 'model_x_factor',
				...factors.meteredAuditExtras,
			},
			standard: {
				path: 'profile',
				source: 'model',
			},
			user_charge: {
				path: 'profile',
				source: 'model_x_factor',
				...factors.chargedAuditExtras,
			},
		},
	});
	return withUserAudioChargedFactor(
		{
		durationSeconds: billing.durationSeconds,
		billableSeconds,
		pricePerSecond,
		characters: 0,
		billableCharacters: 0,
		pricePerCharacter: 0,
		meteredCost,
		standardCost,
		chargedCost,
		meteredFactor: factors.meteredFactor,
		chargedFactor: factors.chargedFactor,
		pricingAuditJson,
		billingKind: 'audio_per_second',
		logTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		},
		billing
	);
}

function buildAudioPerCharacterCosts(
	billing: AudioBillingParams,
	profile: ParsedPricingProfile & {
		audio_billing_mode: 'per_character';
		audio: AudioPerCharacterPricingConfig;
	},
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>
): AudioCostBreakdown {
	const characters = billing.characters ?? 0;
	const pricePerCharacter = profile.audio.price_per_character;
	const billableCharacters = resolveBillableAudioCharacters(characters, profile.audio);
	const baseCost = computeAudioPerCharacterMeteredCost({
		characters,
		pricePerCharacter,
		minimumCharacters: profile.audio.minimum_characters,
	});
	const meteredCost = roundGatewayMoney(baseCost * factors.meteredFactor);
	const standardCost = roundGatewayMoney(baseCost);
	const chargedCost = roundGatewayMoney(baseCost * factors.chargedFactor);
	return withUserAudioChargedFactor(
		{
		durationSeconds: 0,
		billableSeconds: 0,
		pricePerSecond: 0,
		characters,
		billableCharacters,
		pricePerCharacter,
		meteredCost,
		standardCost,
		chargedCost,
		meteredFactor: factors.meteredFactor,
		chargedFactor: factors.chargedFactor,
		pricingAuditJson: JSON.stringify({
			v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
			kind: 'audio_per_character',
			snapshot: {
				kind: 'audio_per_character',
				characters,
				billable_characters: billableCharacters,
				price_per_character: pricePerCharacter,
				minimum_characters: profile.audio.minimum_characters ?? 0,
				usage_source: 'validated_request_input',
				supplier: {
					path: 'profile',
					source: 'model_x_factor',
					...factors.meteredAuditExtras,
				},
				standard: { path: 'profile', source: 'model' },
				user_charge: {
					path: 'profile',
					source: 'model_x_factor',
					...factors.chargedAuditExtras,
				},
			},
		}),
		billingKind: 'audio_per_character',
		logTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		},
		billing
	);
}

function buildAudioTokenCosts(
	billing: AudioBillingParams,
	usage: AudioTokenUsage,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	auditExtra?: Record<string, unknown>
): AudioCostBreakdown {
	const basis = usage.input_tokens;
	const supplier = resolveSupplierBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: billing.modelPricingProfileJson,
	});
	const standard = resolveStandardBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: billing.modelPricingProfileJson,
	});
	const charged = resolveChargedBillingPrices({
		basisInputTokens: basis,
		modelPricingProfileJson: billing.modelPricingProfileJson,
	});

	const supplierPrices = scaleBillingPrices(supplier.prices, factors.meteredFactor);
	const chargedPrices = scaleBillingPrices(charged.prices, factors.chargedFactor);

	const meteredCost = roundGatewayMoney(computeAudioTokenMeteredCost(usage, supplierPrices));
	const standardCost = roundGatewayMoney(computeAudioTokenMeteredCost(usage, standard.prices));
	const chargedCost = roundGatewayMoney(computeAudioTokenMeteredCost(usage, chargedPrices));

	const pricingAuditJson = JSON.stringify({
		v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
		kind: 'audio_tokens',
		...(auditExtra ?? {}),
		tokens: {
			input: usage.input_tokens,
			output: usage.output_tokens,
			audio: usage.audio_tokens,
			text: usage.text_tokens,
			total: usage.total_tokens,
		},
		duration_seconds: billing.durationSeconds,
		duration_source: billing.durationSource ?? null,
		file_bytes: billing.fileBytes ?? null,
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

	return withUserAudioChargedFactor(
		{
		durationSeconds: billing.durationSeconds,
		billableSeconds: 0,
		pricePerSecond: 0,
		characters: 0,
		billableCharacters: 0,
		pricePerCharacter: 0,
		meteredCost,
		standardCost,
		chargedCost,
		meteredFactor: factors.meteredFactor,
		chargedFactor: factors.chargedFactor,
		pricingAuditJson,
		billingKind: 'audio_tokens',
		logTokens: {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			totalTokens: usage.total_tokens,
		},
		},
		billing
	);
}

function zeroAudioCostBreakdown(
	billing: AudioBillingParams,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	billingKind: AudioCostBreakdown['billingKind'],
	auditExtra?: Record<string, unknown>
): AudioCostBreakdown {
	return withUserAudioChargedFactor(
		{
			durationSeconds: billing.durationSeconds,
			billableSeconds: 0,
			pricePerSecond: 0,
			characters: billing.characters ?? 0,
			billableCharacters: 0,
			pricePerCharacter: 0,
			meteredCost: 0,
			standardCost: 0,
			chargedCost: 0,
			meteredFactor: factors.meteredFactor,
			chargedFactor: factors.chargedFactor,
			pricingAuditJson: JSON.stringify({
				v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
				kind: billingKind,
				duration_seconds: billing.durationSeconds,
				duration_source: billing.durationSource ?? null,
				file_bytes: billing.fileBytes ?? null,
				...auditExtra,
			}),
			billingKind,
			logTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		},
		billing
	);
}

function endpointAudioBillingKind(
	billing: AudioBillingParams,
): AudioCostBreakdown['billingKind'] {
	const operation = billing.operation ?? undefined;
	const meter = operation
		? billing.endpoint?.audioCapabilities?.pricing_by_operation[operation]?.meter
		: undefined;
	return meter?.kind === 'tokens'
		? 'audio_tokens'
		: meter?.kind === 'characters'
			? 'audio_per_character'
			: 'audio_per_second';
}

function resolveAudioCostsForEndpoint(
	billing: AudioBillingParams,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
): AudioCostBreakdown {
	const operation = billing.operation ?? undefined;
	const facts = operation?.startsWith('audio.speech')
		? { unicodeCodePoints: billing.characters ?? undefined }
		: { durationSeconds: billing.durationSeconds };
	const resolved = resolveEndpointAudioPricing(billing.endpoint, operation, facts);
	const billingKind = endpointAudioBillingKind(billing);
	if (!resolved.ok) {
		return zeroAudioCostBreakdown(billing, factors, billingKind, {
			source: 'verified_model_endpoint',
			endpoint_id: billing.endpoint?.id ?? null,
			operation: operation ?? null,
			error: resolved.reason,
			message: resolved.message,
		});
	}

	const value = resolved.value;
	const meteredCost = roundGatewayMoney(
		value.standardBaseCost * factors.meteredFactor,
	);
	const standardCost = roundGatewayMoney(value.standardBaseCost);
	const chargedCost = roundGatewayMoney(
		value.chargedBaseCost * factors.chargedFactor,
	);
	return withUserAudioChargedFactor(
		{
			durationSeconds: value.meterKind === 'duration' ? value.actualUnits : 0,
			billableSeconds: value.meterKind === 'duration' ? value.billableUnits : 0,
			pricePerSecond: value.meterKind === 'duration' ? value.standardUnitPrice : 0,
			characters: value.meterKind === 'characters' ? value.actualUnits : 0,
			billableCharacters: value.meterKind === 'characters' ? value.billableUnits : 0,
			pricePerCharacter: value.meterKind === 'characters' ? value.standardUnitPrice : 0,
			meteredCost,
			standardCost,
			chargedCost,
			meteredFactor: factors.meteredFactor,
			chargedFactor: factors.chargedFactor,
			pricingAuditJson: JSON.stringify({
				v: PRICING_AUDIT_JSON_SCHEMA_VERSION,
				kind: billingKind,
				...value.audit,
				actual_units: value.actualUnits,
				billable_units: value.billableUnits,
				minimum_units: value.minimumUnits,
				increment_units: value.incrementUnits,
				standard_meter_cost: value.standardMeterCost,
				standard_request_fee: value.standardRequestFee,
				standard_base_cost: value.standardBaseCost,
				charged_meter_cost: value.chargedMeterCost,
				charged_request_fee: value.chargedRequestFee,
				charged_base_cost: value.chargedBaseCost,
				pricing_at: factors.pricingAtUtc,
				business_timezone: factors.businessTimezone,
				duration_source: value.meterKind === 'duration'
					? billing.durationSource ?? null
					: null,
				file_bytes: billing.fileBytes ?? null,
				snapshot: {
					supplier: {
						...value.audit,
						source: 'verified_model_endpoint_x_factor',
						...factors.meteredAuditExtras,
						cost: meteredCost,
					},
					standard: {
						...value.audit,
						source: 'verified_model_endpoint',
						cost: standardCost,
					},
					user_charge: {
						...value.audit,
						source: 'verified_model_endpoint_discount_x_factor',
						...factors.chargedAuditExtras,
						cost: chargedCost,
					},
				},
			}),
			billingKind,
			logTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		},
		billing,
	);
}

function resolveAudioCostsForProfile(
	billing: AudioBillingParams,
	profile: ParsedPricingProfile | null,
	factors: Awaited<ReturnType<typeof resolveRouteFactors>>,
	options?: { allowTokenPrecheckEstimate?: boolean }
): AudioCostBreakdown {
	const mode = resolveAudioBillingMode(profile);

	if (mode === 'per_second' && profile && profileHasAudioPerSecondPricing(profile)) {
		return buildAudioPerSecondCosts(billing, profile, factors);
	}

	if (mode === 'token' && profile && profileHasAudioTokenPricing(profile)) {
		const usage =
			billing.tokenUsage ??
			(options?.allowTokenPrecheckEstimate
				? buildAudioTokenPrecheckUsage(billing.durationSeconds)
				: null);
		if (!hasAuthoritativeAudioTokenUsage(usage)) {
			return zeroAudioCostBreakdown(billing, factors, 'audio_tokens', {
				error: 'missing_upstream_token_usage',
			});
		}
		return buildAudioTokenCosts(billing, usage, factors, {
			usage_source: billing.tokenUsage
				? 'upstream'
				: options?.allowTokenPrecheckEstimate
					? 'precheck_estimate'
					: 'upstream',
		});
	}

	if (mode === 'per_character' && profile && profileHasAudioPerCharacterPricing(profile)) {
		if (
			billing.characters == null
			|| !Number.isFinite(billing.characters)
			|| billing.characters <= 0
		) {
			return zeroAudioCostBreakdown(billing, factors, 'audio_per_character', {
				error: 'missing_authoritative_character_count',
			});
		}
		return buildAudioPerCharacterCosts(billing, profile, factors);
	}

	return zeroAudioCostBreakdown(billing, factors, 'audio_per_second', {
		error: 'missing_audio_pricing',
	});
}

/** 单条 TTS 路由的按字符成本；characters 必须来自已验证的计费输入，null 会明确审计为缺失。 */
export async function estimateAudioSpeechCosts(
	repos: GatewayRepositories,
	billing: Pick<
		AudioBillingParams,
		| 'endpoint'
		| 'operation'
		| 'modelPricingProfileJson'
		| 'requestStartedAtMs'
		| 'businessTimezone'
		| 'characters'
		| 'catalogModelId'
		| 'userChargedCostFactorsJson'
	> & {
		routePriceOverrideJson?: string | null;
	}
): Promise<AudioCostBreakdown> {
	const params: AudioBillingParams = {
		...billing,
		durationSeconds: 0,
	};
	const factors = await resolveRouteFactors(
		repos,
		billing.routePriceOverrideJson,
		billing.requestStartedAtMs,
		billing.businessTimezone,
	);
	return billing.endpoint
		? resolveAudioCostsForEndpoint(params, factors)
		: resolveAudioCostsForProfile(
				params,
				parsePricingProfile(billing.modelPricingProfileJson ?? null),
				factors,
			);
}

/** TTS 预算预检与按字符最终扣费都使用同一份已验证请求输入字符数。 */
export async function estimateAudioSpeechBudgetPrecheck(
	repos: GatewayRepositories,
	billing: Pick<
		AudioBillingParams,
		| 'endpoint'
		| 'operation'
		| 'modelPricingProfileJson'
		| 'requestStartedAtMs'
		| 'businessTimezone'
		| 'catalogModelId'
		| 'userChargedCostFactorsJson'
	> & {
		inputCharacters: number;
	},
	routePriceOverrides: Array<string | null | undefined>
): Promise<AudioCostBreakdown> {
	const params: AudioBillingParams = {
		...billing,
		durationSeconds: 0,
		durationSource: 'precheck',
		characters: billing.inputCharacters,
	};
	const profile = billing.endpoint
		? null
		: parsePricingProfile(billing.modelPricingProfileJson ?? null);
	let best: AudioCostBreakdown | null = null;
	for (const override of routePriceOverrides.length > 0 ? routePriceOverrides : [null]) {
		const factors = await resolveRouteFactors(
			repos,
			override,
			billing.requestStartedAtMs,
			billing.businessTimezone,
		);
		const routeParams = { ...params, routePriceOverrideJson: override };
		const costs = billing.endpoint
			? resolveAudioCostsForEndpoint(routeParams, factors)
			: resolveAudioCostsForProfile(routeParams, profile, factors);
		if (!best || costs.chargedCost >= best.chargedCost) best = costs;
	}
	return best ?? zeroAudioCostBreakdown(
		params,
		await resolveRouteFactors(
			repos,
			null,
			billing.requestStartedAtMs,
			billing.businessTimezone,
		),
		'audio_per_character',
		{ error: 'missing_audio_pricing' }
	);
}

/** 预算预检：per_second 用时长；token 用保守 token 上界（不用于最终扣费）。 */
export async function estimateAudioBudgetPrecheck(
	repos: GatewayRepositories,
	billing: Omit<AudioBillingParams, 'durationSeconds' | 'durationSource' | 'tokenUsage'> & {
		fileBytes: number;
		mimeType?: string;
		fileBytesForParse?: Uint8Array;
		clientDurationSeconds?: number;
		/** Internal, server-enforced upper bound; never populate from client input. */
		verifiedDurationCeilingSeconds?: number;
	},
	routePriceOverrides: Array<string | null | undefined>
): Promise<AudioCostBreakdown> {
	const resolved = resolveAudioBillingDuration({
		upstreamSeconds: null,
		fileBytes: billing.fileBytes,
		mimeType: billing.mimeType ?? 'application/octet-stream',
		fileBytesForParse: billing.fileBytesForParse,
		clientSeconds: billing.clientDurationSeconds,
	});
	// Client duration and compressed-byte heuristics are not server-verifiable
	// admission bounds: a low-bitrate file can be much longer than either hint.
	// Media-container duration is deterministic. A server-enforced transport
	// limiter may provide its own verified ceiling (for example realtime PCM);
	// every other pre-dispatch source reserves the same 25-minute ceiling used
	// by final billing.
	const verifiedDurationCeiling = billing.verifiedDurationCeilingSeconds;
	const hasVerifiedDurationCeiling = Number.isFinite(verifiedDurationCeiling)
		&& Number(verifiedDurationCeiling) >= 0
		&& Number(verifiedDurationCeiling) <= MAX_AUDIO_DURATION_SECONDS;
	const durationSeconds = resolved.source === 'media'
		? resolved.seconds
		: hasVerifiedDurationCeiling
			? Number(verifiedDurationCeiling)
			: MAX_AUDIO_DURATION_SECONDS;
	const params: AudioBillingParams = {
		...billing,
		durationSeconds,
		durationSource: resolved.source === 'media' ? 'media' : 'precheck',
	};
	const profile = billing.endpoint
		? null
		: parsePricingProfile(billing.modelPricingProfileJson ?? null);
	let maxCharged = 0;
	let best: AudioCostBreakdown | null = null;
	const overrides =
		routePriceOverrides.length > 0 ? routePriceOverrides : [billing.routePriceOverrideJson];
	for (const override of overrides) {
		const factors = await resolveRouteFactors(
			repos,
			override,
			billing.requestStartedAtMs,
			billing.businessTimezone,
		);
		const routeParams = { ...params, routePriceOverrideJson: override };
		const costs = billing.endpoint
			? resolveAudioCostsForEndpoint(routeParams, factors)
			: resolveAudioCostsForProfile(
					routeParams,
					profile,
					factors,
					{ allowTokenPrecheckEstimate: true },
				);
		if (costs.chargedCost >= maxCharged) {
			maxCharged = costs.chargedCost;
			best = costs;
		}
	}
	return best ?? zeroAudioCostBreakdown(params, await resolveRouteFactors(
		repos,
		null,
		billing.requestStartedAtMs,
		billing.businessTimezone,
	), 'audio_per_second', {
		error: 'missing_audio_pricing',
	});
}

function hasAuthoritativeAudioTokenUsage(
	usage: AudioTokenUsage | null | undefined,
): usage is AudioTokenUsage {
	return usage != null
		&& (usage.input_tokens > 0 || usage.output_tokens > 0 || usage.total_tokens > 0);
}

/** Convert the conservative audio charged-cost precheck into an integer lease ceiling. */
export function audioGuardrailBudgetMicros(chargedCost: number): number {
	if (chargedCost === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	return guardrailBudgetUnits(chargedCost, 'ceiling');
}

export function audioGuardrailSettlementMode(params: {
	status: 'success' | 'error';
	/** A consumed 2xx response may be logged as an error after output validation. */
	chargeOnError?: boolean;
	billingMode: 'per_second' | 'token' | 'per_character' | null;
	durationSeconds: number;
	durationSource?: AudioBillingParams['durationSource'];
	tokenUsage: AudioTokenUsage | null | undefined;
	characters: number | null | undefined;
	usageUnavailable?: boolean;
}): 'actual' | 'reserved' {
	// A known terminal provider rejection is a known zero debit. An output-
	// blocked or otherwise consumed response still needs the metric required by
	// its billing mode before either budget ledger can settle an actual amount.
	const billingCommitted = params.status === 'success' || params.chargeOnError === true;
	if (!billingCommitted) return 'actual';
	if (params.billingMode === 'per_character') {
		return params.characters == null || !Number.isFinite(params.characters) || params.characters < 0
			? 'reserved'
			: 'actual';
	}
	if (params.usageUnavailable) return 'reserved';
	if (params.billingMode === 'token') {
		return hasAuthoritativeAudioTokenUsage(params.tokenUsage) ? 'actual' : 'reserved';
	}
	if (params.billingMode === 'per_second') {
		if (params.durationSeconds < 0 || !Number.isFinite(params.durationSeconds)) return 'reserved';
		if (
			params.durationSeconds === 0
			&& params.durationSource !== 'upstream'
			&& params.durationSource !== 'media'
		) {
			return 'reserved';
		}
		if (
			params.durationSource != null
			&& params.durationSource !== 'upstream'
			&& params.durationSource !== 'media'
		) {
			return 'reserved';
		}
		return 'actual';
	}
	return 'actual';
}

export function resolveAudioUsageWriteIdentity(params: {
	requestLogId?: string;
	requestStartedAtMs?: number;
}): { requestLogId: string; budgetAccountedAt: string } {
	const requestedAccountedAt =
		typeof params.requestStartedAtMs === 'number' && Number.isFinite(params.requestStartedAtMs)
			? new Date(params.requestStartedAtMs)
			: new Date();
	return {
		requestLogId: params.requestLogId ?? crypto.randomUUID(),
		budgetAccountedAt: Number.isNaN(requestedAccountedAt.getTime())
			? new Date().toISOString()
			: requestedAccountedAt.toISOString(),
	};
}

export type RecordAudioUsageParams = {
	repos: GatewayRepositories;
	/** Stable request correlation id shared with the Guardrail reservation. */
	requestLogId?: string;
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
	requestOrigin?: string | null;
	responseStreamed?: boolean | null;
	requestProtocol: UpstreamProtocol;
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
	/** Log an error response while still charging a known, consumed upstream result. */
	chargeOnError?: boolean;
	latencyMs: number;
	errorMessage?: string | null;
	billing: AudioBillingParams;
	providerKeyId?: string | null;
	providerKeyLabel?: string | null;
	providerKeyFingerprint?: string | null;
	upstreamRequestId?: string | null;
	timing?: RequestTimingSnapshot | null;
	circuitEvents?: GatewayCircuitAlertEvent[];
	suppressErrorAlert?: boolean;
	guardrailBudgetSettlement?: {
		requestId: string;
		/** Set when the usage promise itself failed or was otherwise unavailable. */
		usageUnavailable?: boolean;
		/** Explicit conservative settlement for a consumed response whose usage body was bounded away. */
		mode?: 'actual' | 'reserved';
	};
	/** Ordinary user-budget reservation settled atomically with this usage write. */
	ordinaryBudgetSettlement?: OrdinaryBudgetUsageSettlement;
};

export async function recordAudioUsage(params: RecordAudioUsageParams): Promise<{
	requestLogId: string;
	chargedCost: number;
}> {
	const hasEndpointPricing = params.billing.endpoint != null;
	const routedPricingOperation = resolveCanonicalAudioEndpointPricingOperation(
		params.upstreamOperation,
	);
	if (
		hasEndpointPricing
		&& (
			params.billing.endpoint!.modelId !== params.modelId
			|| params.billing.endpoint!.providerId !== params.providerId
			|| params.billing.operation == null
			|| routedPricingOperation == null
			|| params.billing.operation !== routedPricingOperation
		)
	) {
		throw new Error(
			'Verified audio endpoint pricing identity or operation does not match routed usage',
		);
	}
	const profile = hasEndpointPricing
		? null
		: parsePricingProfile(params.billing.modelPricingProfileJson ?? null);
	const factors = await resolveRouteFactors(
		params.repos,
		params.billing.routePriceOverrideJson,
		params.billing.requestStartedAtMs,
		params.billing.businessTimezone,
	);

	const endpointKind = endpointAudioBillingKind(params.billing);
	const billingMode = hasEndpointPricing
		? endpointKind === 'audio_tokens'
			? 'token'
			: endpointKind === 'audio_per_character'
				? 'per_character'
				: 'per_second'
		: resolveAudioBillingMode(profile);
	const billingCommitted = params.status === 'success' || params.chargeOnError === true;
	const derivedSettlementMode = audioGuardrailSettlementMode({
		status: params.status,
		chargeOnError: params.chargeOnError,
		billingMode,
		durationSeconds: params.billing.durationSeconds,
		durationSource: params.billing.durationSource,
		tokenUsage: params.billing.tokenUsage,
		characters: params.billing.characters,
		usageUnavailable: params.guardrailBudgetSettlement?.usageUnavailable,
	});
	// Guardrail and ordinary budgets describe the same committed debit. Either
	// caller-observed uncertainty or a missing billing-mode metric keeps both at
	// the admitted ceiling; an explicit "actual" must never weaken that result.
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
	let costs: AudioCostBreakdown;
	if (!billingCommitted) {
		costs = zeroAudioCostBreakdown(
			params.billing,
			factors,
			billingMode === 'token'
				? 'audio_tokens'
				: billingMode === 'per_character'
					? 'audio_per_character'
					: 'audio_per_second',
			{ error: 'request_failed' }
		);
	} else {
		// Endpoint token meters remain fail-closed until authoritative component
		// usage exists. Legacy token mode likewise never uses the precheck estimate.
		costs = hasEndpointPricing
			? resolveAudioCostsForEndpoint(params.billing, factors)
			: resolveAudioCostsForProfile(params.billing, profile, factors, {
					allowTokenPrecheckEstimate: false,
				});
	}

	const chargedCost = billingCommitted ? costs.chargedCost : 0;
	const meteredCost = billingCommitted ? costs.meteredCost : 0;
	const standardCost = billingCommitted ? costs.standardCost : 0;
	const shouldChargeBudget = billingCommitted && chargedCost > 0;
	const generationSnapshot = verifiedUsdGenerationWriteSnapshot({
		verifiedUsdPricing: hasEndpointPricing,
		requestOrigin: params.requestOrigin,
		responseStreamed: params.responseStreamed,
		chargedCostUsd: chargedCost,
		upstreamInferenceCostUsd: billingCommitted ? meteredCost : null,
	});
	const writeIdentity = resolveAudioUsageWriteIdentity({
		requestLogId: params.requestLogId,
		requestStartedAtMs: params.billing.requestStartedAtMs,
	});
	const id = writeIdentity.requestLogId;
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

	const usage = params.billing.tokenUsage ?? EMPTY_AUDIO_TOKEN_USAGE;
	const budgetAccountedAt = writeIdentity.budgetAccountedAt;
	const guardrailSettlementMode = params.guardrailBudgetSettlement
		? sharedSettlementMode
		: null;
	const rawUsage =
		billingCommitted
			? JSON.stringify({
					billing_kind: costs.billingKind,
					duration_seconds: costs.durationSeconds,
					billable_seconds: costs.billableSeconds,
					characters: costs.characters,
					billable_characters: costs.billableCharacters,
					duration_source: params.billing.durationSource ?? null,
					file_bytes: params.billing.fileBytes ?? null,
					...(costs.billingKind === 'audio_tokens'
						? {
								input_tokens: usage.input_tokens,
								output_tokens: usage.output_tokens,
								audio_tokens: usage.audio_tokens,
								text_tokens: usage.text_tokens,
								total_tokens: usage.total_tokens,
								upstream_usage: usage.raw_usage,
							}
						: {}),
				})
			: null;

	console.log(
		`[Gateway Usage] recordAudioUsage model_id=${params.modelId} status=${params.status} kind=${costs.billingKind} duration=${costs.durationSeconds} billable=${costs.billableSeconds} characters=${costs.characters} billableCharacters=${costs.billableCharacters} in=${costs.logTokens.inputTokens} out=${costs.logTokens.outputTokens} metered=${meteredCost} standard=${standardCost} charged=${chargedCost}`
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
			inputTokens: billingCommitted ? costs.logTokens.inputTokens : 0,
			outputTokens: billingCommitted ? costs.logTokens.outputTokens : 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: billingCommitted ? costs.logTokens.totalTokens : 0,
			meteredCost,
			standardCost,
			chargedCost,
			budgetAccountedAt,
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
			inputImageCount: 0,
			outputImageCount: 0,
			audioDurationSeconds:
				billingCommitted && costs.billingKind !== 'audio_per_character'
					? costs.durationSeconds
					: null,
			audioCharacters:
				billingCommitted && costs.billingKind === 'audio_per_character'
					? costs.characters
					: null,
			providerKeyId: params.providerKeyId ?? null,
			providerKeyLabel: params.providerKeyLabel ?? null,
			providerKeyFingerprint: params.providerKeyFingerprint ?? null,
			upstreamRequestId: params.upstreamRequestId ?? null,
			upstreamMessageId: null,
			...generationSnapshot,
		},
		shouldChargeBudget,
		beforeSpent,
		chargedCost,
		guardrailBudgetSettlement: params.guardrailBudgetSettlement
			? {
					requestId: params.guardrailBudgetSettlement.requestId,
					mode: guardrailSettlementMode!,
					reason: guardrailSettlementMode === 'reserved'
						? 'audio_usage_unavailable_after_dispatch'
						: 'audio_request_usage_settled',
				}
			: undefined,
		userBudgetSettlement: ordinaryBudgetSettlementForCriticalWrite(
			ordinaryBudgetSettlement,
		),
		audit: {
			apiKeyId: params.apiKeyId,
			eventType: 'usage_charge',
			actorType: 'system',
			reasonCode: 'audio_usage_charged_cost',
			reasonText: `Audio charge: ${params.modelId}`,
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
