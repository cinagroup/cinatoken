import type { InsertRequestLogParams } from '@octafuse/core';

export type GenerationWriteSnapshot = Pick<
	InsertRequestLogParams,
	| 'sessionId'
	| 'requestOrigin'
	| 'httpReferer'
	| 'userAgent'
	| 'responseStreamed'
	| 'dataRegion'
	| 'isByok'
	| 'chargedCostUsd'
	| 'upstreamInferenceCostUsd'
	| 'serviceTier'
	| 'finishReason'
	| 'nativeFinishReason'
>;

const EMPTY_SNAPSHOT: GenerationWriteSnapshot = {
	sessionId: null,
	requestOrigin: null,
	httpReferer: null,
	userAgent: null,
	responseStreamed: null,
	dataRegion: null,
	isByok: null,
	chargedCostUsd: null,
	upstreamInferenceCostUsd: null,
	serviceTier: null,
	finishReason: null,
	nativeFinishReason: null,
};

/**
 * Builds one complete request-time snapshot only when endpoint evidence proves
 * that both catalog prices and calculated charges are USD-denominated.
 */
export function verifiedUsdGenerationWriteSnapshot(params: {
	verifiedUsdPricing: boolean;
	sessionId?: string | null;
	requestOrigin?: string | null;
	httpReferer?: string | null;
	userAgent?: string | null;
	responseStreamed?: boolean | null;
	chargedCostUsd: number;
	upstreamInferenceCostUsd: number | null;
	isByok?: boolean | null;
	serviceTier?: 'default' | 'flex' | 'priority' | null;
	finishReason?: 'tool_calls' | 'stop' | 'length' | 'content_filter' | 'error' | null;
	nativeFinishReason?: string | null;
}): GenerationWriteSnapshot {
	if (!params.verifiedUsdPricing || params.requestOrigin == null) {
		return {
			...EMPTY_SNAPSHOT,
			// Request-context fields are not pricing assertions. Keep them even when
			// the USD-denominated fields must remain fail-closed.
			sessionId: params.sessionId ?? null,
			httpReferer: params.httpReferer ?? null,
			userAgent: params.userAgent ?? null,
			serviceTier: params.serviceTier ?? null,
			finishReason: params.finishReason ?? null,
			nativeFinishReason: params.nativeFinishReason ?? null,
		};
	}
	return {
		sessionId: params.sessionId ?? null,
		requestOrigin: params.requestOrigin,
		httpReferer: params.httpReferer ?? null,
		userAgent: params.userAgent ?? null,
		responseStreamed: params.responseStreamed ?? null,
		// CinaToken currently exposes one unrestricted global routing tier.
		dataRegion: 'global',
		isByok: params.isByok ?? false,
		chargedCostUsd: params.chargedCostUsd,
		upstreamInferenceCostUsd: params.upstreamInferenceCostUsd,
		serviceTier: params.serviceTier ?? null,
		finishReason: params.finishReason ?? null,
		nativeFinishReason: params.nativeFinishReason ?? null,
	};
}
