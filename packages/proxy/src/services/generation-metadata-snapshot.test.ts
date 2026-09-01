import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifiedUsdGenerationWriteSnapshot } from './generation-metadata-snapshot';

describe('Generation request-log snapshots', () => {
	it('records one complete global non-BYOK USD snapshot', () => {
		assert.deepEqual(verifiedUsdGenerationWriteSnapshot({
			verifiedUsdPricing: true,
			requestOrigin: 'https://cinatoken.com',
			responseStreamed: true,
			chargedCostUsd: 0.0015,
			upstreamInferenceCostUsd: 0.0012,
		}), {
			requestOrigin: 'https://cinatoken.com',
			responseStreamed: true,
			dataRegion: 'global',
			isByok: false,
			chargedCostUsd: 0.0015,
			upstreamInferenceCostUsd: 0.0012,
		});
	});

	it('does not create partial snapshots without verified USD pricing and origin', () => {
		for (const input of [
			{ verifiedUsdPricing: false, requestOrigin: 'https://cinatoken.com' },
			{ verifiedUsdPricing: true, requestOrigin: null },
		]) {
			assert.deepEqual(verifiedUsdGenerationWriteSnapshot({
				...input,
				responseStreamed: false,
				chargedCostUsd: 1,
				upstreamInferenceCostUsd: 0.5,
			}), {
				requestOrigin: null,
				responseStreamed: null,
				dataRegion: null,
				isByok: null,
				chargedCostUsd: null,
				upstreamInferenceCostUsd: null,
			});
		}
	});
});
