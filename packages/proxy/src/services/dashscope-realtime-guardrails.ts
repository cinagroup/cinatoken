import {
	parsePricingProfile,
	resolveAudioBillingMode,
	type AudioTokenUsage,
	type GatewayRepositories,
	type GuardrailBudgetIntent,
	type ModelRow,
} from '@octafuse/core';
import {
	audioGuardrailBudgetMicros,
	audioGuardrailSettlementMode,
	estimateAudioBudgetPrecheck,
	estimateAudioSpeechBudgetPrecheck,
} from './audio-usage-charge';
import type {
	DashScopeRealtimeOperation,
	DashScopeRealtimeSessionLimits,
} from './egress/dashscope-realtime-driver';
import type { RouteResult } from './model-router';

export const DASHSCOPE_REALTIME_MAX_SESSION_MS = 10 * 60 * 1000;
export const DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS = 30 * 1000;
export const DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS = 10 * 60;
/** Upstream duration usage is commonly rounded; reserve one extra second. */
export const DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS =
	DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS + 1;
export const DASHSCOPE_REALTIME_MAX_TEXT_CHARACTERS = 200_000;
export const DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DASHSCOPE_REALTIME_MAX_CLIENT_BYTES = 32 * 1024 * 1024;
/** Five minutes longer than the hard session limit, leaving connect/write settlement margin. */
export const DASHSCOPE_REALTIME_GUARDRAIL_LEASE_MS = 15 * 60 * 1000;

export type DashScopeRealtimeBudgetPlan = {
	chargedCostCeiling: number;
	reservedMicros: number;
	sessionLimits: DashScopeRealtimeSessionLimits;
};

export type DashScopeRealtimeBudgetPlanResult =
	| { ok: true; value: DashScopeRealtimeBudgetPlan }
	| { ok: false; kind: 'guardrail' | 'ordinary_budget'; message: string };

export type DashScopeRealtimeSettlementMode =
	| 'actual'
	| 'known_zero'
	| 'forfeit';

export type DashScopeRealtimeCriticalSettlement = {
	guardrailMode: 'actual' | 'reserved';
	ordinaryUnknownCost: boolean;
};

/**
 * Distinguish a provider HTTP rejection from a transport-unknown dispatch and
 * require the same billing-mode evidence used by the audio Guardrail ledger.
 */
export function dashScopeRealtimeSettlementMode(params: {
	errorMessage: string | null;
	initialHandshakeError: boolean;
	upstreamOutcomeUnknown: boolean;
	pricingProfileJson: string | null;
	durationSeconds: number;
	durationSource?: 'upstream' | 'media' | 'client' | 'estimated' | 'precheck';
	characters: number | null | undefined;
	tokenUsage: AudioTokenUsage | null | undefined;
}): DashScopeRealtimeSettlementMode {
	if (params.upstreamOutcomeUnknown) return 'forfeit';
	if (params.errorMessage && params.initialHandshakeError) {
		return 'known_zero';
	}
	if (params.errorMessage || params.initialHandshakeError) return 'forfeit';
	const billingMode = resolveAudioBillingMode(parsePricingProfile(params.pricingProfileJson));
	// Realtime duration is authoritative only when the collector identifies its
	// upstream source or the driver maps a verified PCM limiter measurement to
	// the shared audio contract's local-media source.
	if (billingMode === 'per_second' && params.durationSource == null) return 'forfeit';
	return audioGuardrailSettlementMode({
		status: 'success',
		billingMode,
		durationSeconds: params.durationSeconds,
		durationSource: params.durationSource,
		characters: params.characters,
		tokenUsage: params.tokenUsage,
	}) === 'reserved'
		? 'forfeit'
		: 'actual';
}

/** Map transport and usage certainty to the two ledgers' atomic critical-write modes. */
export function dashScopeRealtimeCriticalSettlement(
	mode: DashScopeRealtimeSettlementMode,
): DashScopeRealtimeCriticalSettlement {
	const unknownCost = mode === 'forfeit';
	return {
		guardrailMode: unknownCost ? 'reserved' : 'actual',
		ordinaryUnknownCost: unknownCost,
	};
}

function isSpeechOperation(operation: DashScopeRealtimeOperation): boolean {
	return operation.startsWith('audio.speech.');
}

/**
 * A finite realtime budget requires an operation-matched, bounded billing
 * basis. ASR can be bounded by verified PCM seconds; TTS can be bounded by the
 * accepted text-character count. Missing/invalid, token, or cross-mode pricing
 * cannot be safely reserved and therefore fails closed. Explicit zero prices
 * remain valid because the pricing parser preserves them.
 */
export function realtimeGuardrailBudgetModeSupported(params: {
	pricingProfileJson: string | null;
	operation: DashScopeRealtimeOperation;
	hasBudgetIntents: boolean;
	ordinaryBudgetIsFinite?: boolean;
}): { ok: true } | {
	ok: false;
	kind: 'guardrail' | 'ordinary_budget';
	message: string;
} {
	if (!params.hasBudgetIntents && !params.ordinaryBudgetIsFinite) return { ok: true };
	const mode = resolveAudioBillingMode(parsePricingProfile(params.pricingProfileJson));
	const expectedMode = isSpeechOperation(params.operation)
		? 'per_character'
		: 'per_second';
	if (mode !== expectedMode) {
		return {
			ok: false,
			kind: params.hasBudgetIntents ? 'guardrail' : 'ordinary_budget',
			message:
				`Realtime ${isSpeechOperation(params.operation) ? 'TTS' : 'ASR'} requires valid ${expectedMode} pricing to enforce a finite session budget`,
		};
	}
	return { ok: true };
}

export async function buildDashScopeRealtimeBudgetPlan(
	repos: GatewayRepositories,
	params: {
		model: ModelRow;
		baseModelId: string;
		routes: RouteResult[];
		operation: DashScopeRealtimeOperation;
		budgetIntents: GuardrailBudgetIntent[];
		userChargedCostFactorsJson: string | null;
		requestStartedAtMs: number;
		ordinaryBudgetIsFinite: boolean;
		nowMs?: number;
	},
): Promise<DashScopeRealtimeBudgetPlanResult> {
	const supported = realtimeGuardrailBudgetModeSupported({
		pricingProfileJson: params.model.pricing_profile ?? null,
		operation: params.operation,
		hasBudgetIntents: params.budgetIntents.length > 0,
		ordinaryBudgetIsFinite: params.ordinaryBudgetIsFinite,
	});
	if (!supported.ok) return supported;

	const common = {
		modelPricingProfileJson: params.model.pricing_profile ?? null,
		catalogModelId: params.baseModelId,
		userChargedCostFactorsJson: params.userChargedCostFactorsJson,
		requestStartedAtMs: params.requestStartedAtMs,
	};
	const estimate = isSpeechOperation(params.operation)
		? await estimateAudioSpeechBudgetPrecheck(
			repos,
			{ ...common, inputCharacters: DASHSCOPE_REALTIME_MAX_TEXT_CHARACTERS },
			params.routes.map((route) => route.priceOverrideRaw),
		)
		: await estimateAudioBudgetPrecheck(
			repos,
			{
				...common,
				// 16 kHz mono 16-bit PCM; clientDurationSeconds is authoritative
				// for this precheck after passing the plausibility check.
				fileBytes:
					DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS * 16_000 * 2,
				clientDurationSeconds:
					DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
				// The PCM-only driver enforces this session-wide before forwarding
				// frames, so this is a server proof rather than a client hint.
				verifiedDurationCeilingSeconds:
					DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
				mimeType: 'audio/pcm',
			},
			params.routes.map((route) => route.priceOverrideRaw),
		);

	const nowMs = params.nowMs ?? Date.now();
	return {
		ok: true,
		value: {
			chargedCostCeiling: estimate.chargedCost,
			reservedMicros: audioGuardrailBudgetMicros(estimate.chargedCost),
			sessionLimits: {
				maxSessionMs: DASHSCOPE_REALTIME_MAX_SESSION_MS,
				connectDeadlineAtMs: nowMs + DASHSCOPE_REALTIME_CONNECT_TIMEOUT_MS,
				maxAudioDurationSeconds: DASHSCOPE_REALTIME_MAX_AUDIO_SECONDS,
				maxBillableAudioDurationSeconds:
					DASHSCOPE_REALTIME_BILLING_DURATION_CEILING_SECONDS,
				maxTextCharacters: DASHSCOPE_REALTIME_MAX_TEXT_CHARACTERS,
				maxClientMessageBytes: DASHSCOPE_REALTIME_MAX_CLIENT_MESSAGE_BYTES,
				maxClientBytes: DASHSCOPE_REALTIME_MAX_CLIENT_BYTES,
				// The session, supplier-cost, and local-usage ceilings are only
				// provable from mono 16-bit PCM. Compressed frames can represent an
				// unbounded amount of audio even for an unlimited customer budget.
				requirePcmAudio: !isSpeechOperation(params.operation),
			},
		},
	};
}
