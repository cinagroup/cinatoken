import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { RouteResult } from './model-router';
import { markProviderFailure, resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { applyDefaultProviderLoadBalancing } from './provider-default-load-balancing';

function route(id: string): RouteResult {
	return {
		targetId: id,
		modelSurfaceId: null,
		routePoolId: 'pool',
		providerId: id,
		providerName: id,
		providerModelName: 'model',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: {},
		providerApiKey: 'secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 100,
		routeWeight: 1,
	};
}

beforeEach(() => resetProviderCircuitStateForTests());

describe('OpenRouter default provider load balancing', () => {
	it('uses inverse-square price weights without replacement and preserves a complete fallback order', () => {
		const prices = new Map([['a', 1], ['b', 2], ['c', 3]]);
		const random = [0.7, 0.8, 0][Symbol.iterator]();
		const result = applyDefaultProviderLoadBalancing({
			routes: [route('a'), route('b'), route('c')],
			priceScore: (item) => prices.get(item.targetId) ?? null,
			randomUnit: () => random.next().value ?? 0,
			now: 1_000,
		});

		assert.equal(result.applied, true);
		assert.deepEqual(result.routes.map((item) => item.targetId), ['a', 'c', 'b']);
		assert.deepEqual(result.routes.map((item) => item.routePriority), [3, 2, 1]);
		assert.deepEqual(result.routes.map((item) => item.gatewayDefaultLoadBalanceRank), [1, 2, 3]);
	});

	it('places a recently degraded cheap provider after healthy providers for 30 seconds', () => {
		const t0 = 1_000_000;
		markProviderFailure('cheap', 'server', null, t0);
		const candidates = [route('cheap'), route('healthy')];
		const priceScore = (item: RouteResult) => item.targetId === 'cheap' ? 1 : 100;

		const degraded = applyDefaultProviderLoadBalancing({
			routes: candidates,
			priceScore,
			randomUnit: () => 0,
			now: t0 + 1,
		});
		assert.deepEqual(degraded.routes.map((item) => item.targetId), ['healthy', 'cheap']);
		assert.deepEqual(
			degraded.routes.map((item) => item.gatewayProviderRecentlyDegraded),
			[false, true],
		);

		const recovered = applyDefaultProviderLoadBalancing({
			routes: candidates,
			priceScore,
			randomUnit: () => 0,
			now: t0 + 30_000,
		});
		assert.deepEqual(recovered.routes.map((item) => item.targetId), ['cheap', 'healthy']);
	});

	it('prefers proven free routes and leaves unpriced routes as stable fallbacks', () => {
		const result = applyDefaultProviderLoadBalancing({
			routes: [route('unpriced'), route('paid'), route('free')],
			priceScore: (item) => item.targetId === 'unpriced' ? null : item.targetId === 'free' ? 0 : 2,
			randomUnit: () => 0,
			now: 1_000,
		});
		assert.deepEqual(result.routes.map((item) => item.targetId), ['free', 'paid', 'unpriced']);
	});

	it('preserves the configured policy when no finite inverse-square distribution exists', () => {
		const routes = [route('a'), route('b')];
		for (const priceScore of [
			() => null,
			() => 0,
		]) {
			const result = applyDefaultProviderLoadBalancing({ routes, priceScore, now: 1_000 });
			assert.equal(result.applied, false);
			assert.equal(result.routes, routes);
		}
	});
});
