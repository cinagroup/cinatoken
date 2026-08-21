import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SharedKeyRow } from '@octafuse/core';
import type { RouteResult } from './model-router';
import {
	applySharedKeyToRoute,
	circuitKeyForRoute,
	expandAttemptsWithSharedKeys,
	getSharedKeyCooldownRemainingMs,
	markSharedKeyCooldown,
	parseSharedKeyId,
	SHARED_KEY_ID_PREFIX,
	resetSharedKeyPoolStateForTests,
} from './shared-key-pool';

function makeKey(overrides: Partial<SharedKeyRow> & { id: string }): SharedKeyRow {
	return {
		sellerUserId: 'seller-1',
		channelType: 'openai',
		apiKey: `sk-pool-${overrides.id}`,
		keyFingerprint: `…${overrides.id.slice(-4)}`,
		label: null,
		status: 'active',
		sellerPriority: 0,
		weight: 1,
		inputPrice: 1,
		outputPrice: 2,
		cacheReadPrice: null,
		cacheWritePrice: null,
		validatedAt: null,
		lastUsedAt: null,
		lastFailureAt: null,
		failureReason: null,
		servedInputTokens: 0,
		servedOutputTokens: 0,
		earnedTotal: 0,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeRoute(providerId: string, overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: `route-${providerId}`,
		modelSurfaceId: null,
		routePoolId: null,
		providerId,
		providerName: providerId,
		providerModelName: 'model-x',
		upstreamProtocol: 'openai',
		upstreamOperation: '*',
		adapter: 'passthrough',
		providerEndpoints: {},
		providerApiKey: `sk-own-${providerId}`,
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: providerId,
		providerKeyLabel: providerId,
		providerKeyFingerprint: null,
		...overrides,
	} as RouteResult;
}

function makeRepos(pool: SharedKeyRow[]) {
	return {
		sharedKeys: {
			async listActiveSharedKeysByChannel(channelType: string) {
				return pool.filter((key) => key.channelType === channelType);
			},
		},
	} as unknown as Parameters<typeof expandAttemptsWithSharedKeys>[0];
}

beforeEach(() => {
	resetSharedKeyPoolStateForTests();
});

describe('parseSharedKeyId / circuitKeyForRoute', () => {
	it('parses the sharedkey: prefix', () => {
		assert.equal(parseSharedKeyId(`${SHARED_KEY_ID_PREFIX}abc`), 'abc');
		assert.equal(parseSharedKeyId('provider-1'), null);
		assert.equal(parseSharedKeyId(null), null);
	});

	it('scopes the circuit key per shared key attempt', () => {
		const shared = makeRoute('p1', { providerKeyId: `${SHARED_KEY_ID_PREFIX}k1` });
		const own = makeRoute('p1', { providerKeyId: 'p1' });
		assert.equal(circuitKeyForRoute(shared), 'p1#sharedkey:k1');
		assert.equal(circuitKeyForRoute(own), 'p1');
	});
});

describe('applySharedKeyToRoute', () => {
	it('replaces upstream credentials and marks identity', () => {
		const key = makeKey({ id: 'key-a', label: 'my key', keyFingerprint: '…x9Ab' });
		const route = applySharedKeyToRoute(makeRoute('p1'), key);
		assert.equal(route.providerApiKey, 'sk-pool-key-a');
		assert.equal(route.providerKeyId, 'sharedkey:key-a');
		assert.equal(route.providerKeyLabel, 'my key');
		assert.equal(route.providerKeyFingerprint, '…x9Ab');
		// target 身份保持不变（trace/日志仍指向原 route）
		assert.equal(route.targetId, 'route-p1');
	});
});

describe('expandAttemptsWithSharedKeys', () => {
	it('expands shared routes into the fixed key order with provider key fallback', async () => {
		// 仓储保证顺序：seller_priority DESC → weight DESC → id ASC（与 weight_priority 策略语义一致）
		const pool = [
			makeKey({ id: 'k-p5-w50', sellerPriority: 5, weight: 50 }),
			makeKey({ id: 'k-p5-w10', sellerPriority: 5, weight: 10 }),
			makeKey({ id: 'k-p0-w99', sellerPriority: 0, weight: 99 }),
		];
		const sharedRoute = makeRoute('shared', { providerSharedChannelType: 'openai' });
		const plainRoute = makeRoute('plain');
		const expanded = await expandAttemptsWithSharedKeys(makeRepos(pool), [sharedRoute, plainRoute]);
		assert.deepEqual(
			expanded.map((route) => route.providerKeyId),
			['sharedkey:k-p5-w50', 'sharedkey:k-p5-w10', 'sharedkey:k-p0-w99', 'shared', 'plain']
		);
	});

	it('skips keys in cooldown but keeps the rest of the pool', async () => {
		const pool = [
			makeKey({ id: 'k-1' }),
			makeKey({ id: 'k-2' }),
			makeKey({ id: 'k-3' }),
		];
		markSharedKeyCooldown('k-2', 60_000);
		assert.ok(getSharedKeyCooldownRemainingMs('k-2') > 0);
		const expanded = await expandAttemptsWithSharedKeys(
			makeRepos(pool),
			[makeRoute('shared', { providerSharedChannelType: 'openai' })]
		);
		assert.deepEqual(
			expanded.map((route) => route.providerKeyId),
			['sharedkey:k-1', 'sharedkey:k-3', 'shared']
		);
	});

	it('pool-only provider without own key drops the fallback attempt', async () => {
		const pool = [makeKey({ id: 'k-1' })];
		const expanded = await expandAttemptsWithSharedKeys(
			makeRepos(pool),
			[makeRoute('poolonly', { providerSharedChannelType: 'openai', providerApiKey: '' })]
		);
		assert.deepEqual(
			expanded.map((route) => route.providerKeyId),
			['sharedkey:k-1']
		);
	});

	it('empty pool and no own key yields no attempts for that route', async () => {
		const expanded = await expandAttemptsWithSharedKeys(
			makeRepos([]),
			[makeRoute('poolonly', { providerSharedChannelType: 'openai', providerApiKey: '' })]
		);
		assert.equal(expanded.length, 0);
	});

	it('returns attempts untouched when no shared routes exist', async () => {
		const routes = [makeRoute('a'), makeRoute('b')];
		const expanded = await expandAttemptsWithSharedKeys(makeRepos([]), routes);
		assert.equal(expanded, routes);
	});
});
