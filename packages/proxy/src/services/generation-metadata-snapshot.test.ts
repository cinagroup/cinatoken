import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifiedUsdGenerationWriteSnapshot } from './generation-metadata-snapshot';

describe('Generation request-log snapshots', () => {
	it('records one complete global non-BYOK USD snapshot', () => {
		assert.deepEqual(verifiedUsdGenerationWriteSnapshot({
			verifiedUsdPricing: true,
			sessionId: 'session-1',
			requestOrigin: 'https://cinatoken.com',
			httpReferer: 'https://app.example',
			userAgent: 'CinaSDK/1.0',
			responseStreamed: true,
			chargedCostUsd: 0.0015,
			upstreamInferenceCostUsd: 0.0012,
			serviceTier: 'priority',
			finishReason: 'stop',
			nativeFinishReason: 'end_turn',
		}), {
			sessionId: 'session-1',
			requestOrigin: 'https://cinatoken.com',
			httpReferer: 'https://app.example',
			userAgent: 'CinaSDK/1.0',
			responseStreamed: true,
			dataRegion: 'global',
			isByok: false,
			chargedCostUsd: 0.0015,
			upstreamInferenceCostUsd: 0.0012,
			serviceTier: 'priority',
			finishReason: 'stop',
			nativeFinishReason: 'end_turn',
		});
	});

	it('records a verified private BYOK snapshot without exposing credential identity', () => {
		const snapshot = verifiedUsdGenerationWriteSnapshot({
			verifiedUsdPricing: true,
			requestOrigin: 'https://cinatoken.com',
			responseStreamed: false,
			chargedCostUsd: 0.0001,
			upstreamInferenceCostUsd: 0,
			isByok: true,
		});
		assert.equal(snapshot.isByok, true);
		assert.equal(snapshot.dataRegion, 'global');
		assert.equal(JSON.stringify(snapshot).includes('byok:'), false);
	});

	it('does not create partial snapshots without verified USD pricing and origin', () => {
		for (const input of [
			{ verifiedUsdPricing: false, requestOrigin: 'https://cinatoken.com' },
			{ verifiedUsdPricing: true, requestOrigin: null },
		]) {
			assert.deepEqual(verifiedUsdGenerationWriteSnapshot({
				...input,
				isByok: true,
				responseStreamed: false,
				chargedCostUsd: 1,
				upstreamInferenceCostUsd: 0.5,
			}), {
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
			});
		}
	});

	it('preserves session grouping independently from USD pricing evidence', () => {
		assert.deepEqual(verifiedUsdGenerationWriteSnapshot({
			verifiedUsdPricing: false,
			sessionId: 'session-with-legacy-pricing',
			requestOrigin: 'https://cinatoken.com',
			httpReferer: 'https://app.example',
			userAgent: 'CinaSDK/1.0',
			responseStreamed: false,
			chargedCostUsd: 1,
			upstreamInferenceCostUsd: 0.5,
			serviceTier: 'flex',
			finishReason: 'tool_calls',
			nativeFinishReason: 'tool_use',
		}), {
			sessionId: 'session-with-legacy-pricing',
			requestOrigin: null,
			httpReferer: 'https://app.example',
			userAgent: 'CinaSDK/1.0',
			responseStreamed: null,
			dataRegion: null,
			isByok: null,
			chargedCostUsd: null,
			upstreamInferenceCostUsd: null,
			serviceTier: 'flex',
			finishReason: 'tool_calls',
			nativeFinishReason: 'tool_use',
		});
	});
});
