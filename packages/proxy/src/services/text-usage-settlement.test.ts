import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_USAGE } from './proxy';
import type { RouteResult } from './model-router';
import { resolveServiceTierBillingRoute } from './service-tier-billing';
import {
	hasAuthoritativeTextUsage,
	textUsageCostIsUnknown,
	textUsageWithSafetyTimeout,
} from './text-usage-settlement';

test('explicit zero usage object is authoritative', () => {
	assert.equal(hasAuthoritativeTextUsage({ ...EMPTY_USAGE, raw_usage: '{}' }), true);
	assert.equal(hasAuthoritativeTextUsage({ ...EMPTY_USAGE }), false);
	assert.equal(hasAuthoritativeTextUsage({ ...EMPTY_USAGE, raw_usage: '' }), false);
});

test('HTTP certainty is shared and conservative only after an unknown/2xx outcome', () => {
	assert.equal(textUsageCostIsUnknown({ upstreamResponseOk: false, usageAvailable: false }), false);
	assert.equal(textUsageCostIsUnknown({
		upstreamResponseOk: false,
		usageAvailable: false,
		upstreamOutcomeUnknown: true,
	}), true);
	assert.equal(textUsageCostIsUnknown({ upstreamResponseOk: true, usageAvailable: false }), true);
	assert.equal(textUsageCostIsUnknown({ upstreamResponseOk: true, usageAvailable: true }), false);
	assert.equal(textUsageCostIsUnknown({
		upstreamResponseOk: true,
		usageAvailable: true,
		serviceTierPricingUnknown: true,
	}), true);
	assert.equal(textUsageCostIsUnknown({
		upstreamResponseOk: true,
		usageAvailable: true,
		streamError: true,
	}), true);
});

function tierRoute(id: string, tier?: RouteResult['gatewayServiceTier']): RouteResult {
	return {
		targetId: id,
		modelSurfaceId: 'surface',
		routePoolId: 'pool',
		providerId: 'provider',
		providerName: 'Provider',
		providerModelName: 'private-model',
		gatewayModelId: 'public/model',
		gatewayServiceTier: tier,
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
		routePriority: 1,
		routeWeight: 1,
	};
}

test('service-tier settlement uses the verified endpoint matching the actual upstream tier', () => {
	const priority = tierRoute('priority', 'priority');
	const standard = tierRoute('standard', 'default');
	assert.deepEqual(
		resolveServiceTierBillingRoute(priority, [priority, standard], 'default'),
		{ pricingRoute: standard, exact: true },
	);
	assert.deepEqual(
		resolveServiceTierBillingRoute(priority, [priority, standard], 'priority'),
		{ pricingRoute: priority, exact: true },
	);
	assert.deepEqual(
		resolveServiceTierBillingRoute(priority, [priority], 'default'),
		{ pricingRoute: priority, exact: false },
	);
	assert.deepEqual(
		resolveServiceTierBillingRoute(priority, [priority, standard], null),
		{ pricingRoute: priority, exact: false },
	);
	const ordinary = tierRoute('ordinary');
	assert.deepEqual(
		resolveServiceTierBillingRoute(ordinary, [ordinary], null),
		{ pricingRoute: ordinary, exact: true },
	);
	assert.deepEqual(
		resolveServiceTierBillingRoute(ordinary, [ordinary], 'default'),
		{ pricingRoute: ordinary, exact: true },
	);
	assert.deepEqual(
		resolveServiceTierBillingRoute(ordinary, [ordinary], 'priority'),
		{ pricingRoute: ordinary, exact: false },
	);
});

test('usage safety race clears the timeout when usage wins', async () => {
	let cleared: unknown;
	const handle = { id: 1 };
	const result = await textUsageWithSafetyTimeout(
		Promise.resolve({ ...EMPTY_USAGE, raw_usage: '{}' }),
		300_000,
		EMPTY_USAGE,
		{
			set: () => handle,
			clear: (value) => {
				cleared = value;
			},
		},
	);
	assert.equal(result.timedOut, false);
	assert.equal(result.incomplete, false);
	assert.equal(cleared, handle);
});

test('usage safety race clears the fired timeout too', async () => {
	let cleared = false;
	const result = await textUsageWithSafetyTimeout(
		new Promise(() => undefined),
		1,
		EMPTY_USAGE,
		{
			set: (callback) => {
				queueMicrotask(callback);
				return 'timer';
			},
			clear: () => {
				cleared = true;
			},
		},
	);
	assert.equal(result.timedOut, true);
	assert.equal(cleared, true);
});
