import type { InsertRequestLogParams } from '@octafuse/core';

export type GenerationWriteSnapshot = Pick<
	InsertRequestLogParams,
	| 'requestOrigin'
	| 'responseStreamed'
	| 'dataRegion'
	| 'isByok'
	| 'chargedCostUsd'
	| 'upstreamInferenceCostUsd'
>;

const EMPTY_SNAPSHOT: GenerationWriteSnapshot = {
	requestOrigin: null,
	responseStreamed: null,
	dataRegion: null,
	isByok: null,
	chargedCostUsd: null,
	upstreamInferenceCostUsd: null,
};

/**
 * Builds one complete request-time snapshot only when endpoint evidence proves
 * that both catalog prices and calculated charges are USD-denominated.
 */
export function verifiedUsdGenerationWriteSnapshot(params: {
	verifiedUsdPricing: boolean;
	requestOrigin?: string | null;
	responseStreamed?: boolean | null;
	chargedCostUsd: number;
	upstreamInferenceCostUsd: number | null;
}): GenerationWriteSnapshot {
	if (!params.verifiedUsdPricing || params.requestOrigin == null) return EMPTY_SNAPSHOT;
	return {
		requestOrigin: params.requestOrigin,
		responseStreamed: params.responseStreamed ?? null,
		// CinaToken currently exposes one unrestricted global routing tier.
		dataRegion: 'global',
		// Shared/platform provider credentials are not private customer BYOK.
		isByok: false,
		chargedCostUsd: params.chargedCostUsd,
		upstreamInferenceCostUsd: params.upstreamInferenceCostUsd,
	};
}
