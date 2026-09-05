import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type {
	ByokRuntimeKeyRow,
	GatewayRepositories,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import {
	applyByokKeyToRoute,
	BYOK_KEY_ID_PREFIX,
	expandAttemptsWithPrivateByok,
	isPrivateByokRoute,
	parseByokKeyId,
} from './byok-key-pool';

function makeRoute(
	targetId: string,
	overrides: Partial<RouteResult> = {},
): RouteResult {
	return {
		targetId,
		modelSurfaceId: null,
		routePoolId: null,
		providerId: 'provider-1',
		providerName: 'Provider 1',
		providerModelName: 'private-model',
		endpoint: {
			id: `endpoint-${targetId}`,
			modelId: 'deepseek/deepseek-chat',
			providerId: 'provider-1',
			providerSlug: 'deepseek',
		} as NonNullable<RouteResult['endpoint']>,
		gatewayModelId: 'deepseek/deepseek-chat',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: {},
		providerApiKey: 'platform-secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routingMetadata: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: 'provider-1',
		providerKeyLabel: 'Provider 1',
		providerKeyFingerprint: '...form',
		...overrides,
	};
}

function makeKey(
	id: string,
	isFallback = false,
	alwaysUseForProvider = false,
	alwaysUseForMatchingModels = false,
): ByokRuntimeKeyRow {
	return {
		id,
		workspace_id: 'workspace-1',
		provider: 'deepseek',
		name: null,
		label: `...${id.slice(-4)}`,
		disabled: false,
		is_fallback: isFallback,
		always_use_for_provider: alwaysUseForProvider,
		always_use_for_matching_models: alwaysUseForMatchingModels,
		sort_order: 0,
		allowed_models: null,
		allowed_user_ids: null,
		allowed_api_key_hashes: null,
		created_by_management_key_id: null,
		created_at: '2026-09-03T00:00:00.000Z',
		updated_at: '2026-09-03T00:00:00.000Z',
		api_key: `secret-${id}`,
	};
}

const context = {
	workspaceId: 'workspace-1',
	userId: 'user-1',
	apiKeyHash: 'a'.repeat(64),
};

describe('private BYOK identity', () => {
	it('marks a credential clone without changing route target identity', () => {
		const route = applyByokKeyToRoute(makeRoute('route-1'), makeKey('key-1'));
		assert.equal(route.targetId, 'route-1');
		assert.equal(route.providerApiKey, 'secret-key-1');
		assert.equal(route.providerKeyId, `${BYOK_KEY_ID_PREFIX}key-1`);
		assert.equal(route.providerKeyLabel, '...ey-1');
		assert.equal(parseByokKeyId(route.providerKeyId), 'key-1');
		assert.equal(isPrivateByokRoute(route), true);
		assert.equal(parseByokKeyId('provider-1'), null);
	});
});

describe('expandAttemptsWithPrivateByok', () => {
	it('orders primary BYOK before shared/platform and fallback BYOK after them', async () => {
		const lookup = mock.fn(async () => [
			makeKey('primary-1'),
			makeKey('fallback-1', true),
		]);
		const repos = {
			byokKeys: { listActiveForRequest: lookup },
		} as unknown as GatewayRepositories;
		const base = makeRoute('route-1');
		const shared = makeRoute('route-1', {
			providerApiKey: 'shared-secret',
			providerKeyId: 'sharedkey:shared-1',
		});
		const result = await expandAttemptsWithPrivateByok(
			repos,
			[base],
			[shared, base],
			context,
		);
		assert.deepEqual(
			result.map((route) => route.providerKeyId),
			['byok:primary-1', 'sharedkey:shared-1', 'provider-1', 'byok:fallback-1'],
		);
		assert.deepEqual(lookup.mock.calls[0]?.arguments[0], {
			workspaceId: 'workspace-1',
			provider: 'deepseek',
			modelId: 'deepseek/deepseek-chat',
			userId: 'user-1',
			apiKeyHash: 'a'.repeat(64),
		});
	});

	it('caches one repository lookup per provider/model pair', async () => {
		const lookup = mock.fn(async () => [makeKey('primary-1')]);
		const repos = {
			byokKeys: { listActiveForRequest: lookup },
		} as unknown as GatewayRepositories;
		const first = makeRoute('route-1');
		const second = makeRoute('route-2');
		const result = await expandAttemptsWithPrivateByok(
			repos,
			[first, second],
			[first, second],
			context,
		);
		assert.equal(lookup.mock.callCount(), 1);
		assert.deepEqual(
			result.map((route) => `${route.targetId}:${route.providerKeyId}`),
			[
				'route-1:byok:primary-1',
				'route-2:byok:primary-1',
				'route-1:provider-1',
				'route-2:provider-1',
			],
		);
	});

	it('prioritizes all primary BYOK routes before any platform route and defers every fallback key', async () => {
		const lookup = mock.fn(async () => [
			makeKey('primary-1'),
			makeKey('fallback-1', true),
		]);
		const repos = {
			byokKeys: { listActiveForRequest: lookup },
		} as unknown as GatewayRepositories;
		const first = makeRoute('route-1');
		const second = makeRoute('route-2');

		const result = await expandAttemptsWithPrivateByok(
			repos,
			[first, second],
			[first, second],
			context,
		);

		assert.deepEqual(
			result.map((route) => `${route.targetId}:${route.providerKeyId}`),
			[
				'route-1:byok:primary-1',
				'route-2:byok:primary-1',
				'route-1:provider-1',
				'route-2:provider-1',
				'route-1:byok:fallback-1',
				'route-2:byok:fallback-1',
			],
		);
	});

	it('suppresses only same-provider shared/platform capacity for an eligible always-use key', async () => {
		const deepseek = makeRoute('deepseek-route');
		const openai = makeRoute('openai-route', {
			providerId: 'provider-openai',
			providerName: 'OpenAI',
			providerKeyId: 'provider-openai',
			endpoint: {
				id: 'endpoint-openai-route',
				modelId: 'openai/gpt-5-mini',
				providerId: 'provider-openai',
				providerSlug: 'openai',
			} as NonNullable<RouteResult['endpoint']>,
			gatewayModelId: 'openai/gpt-5-mini',
		});
		const lookup = mock.fn(async (params: { provider: string }) =>
			params.provider === 'deepseek' ? [makeKey('private-1', false, true)] : []
		);
		const result = await expandAttemptsWithPrivateByok(
			{ byokKeys: { listActiveForRequest: lookup } } as unknown as GatewayRepositories,
			[deepseek, openai],
			[deepseek, openai],
			context,
		);

		assert.deepEqual(
			result.map((route) => `${route.targetId}:${route.providerKeyId}`),
			['deepseek-route:byok:private-1', 'openai-route:provider-openai'],
		);
	});

	it('suppresses same-provider shared capacity for an eligible matching-model policy key', async () => {
		const route = makeRoute('deepseek-route');
		const result = await expandAttemptsWithPrivateByok(
			{
				byokKeys: {
					listActiveForRequest: async () => [makeKey('matching-1', false, false, true)],
				},
			} as unknown as GatewayRepositories,
			[route],
			[route],
			context,
		);

		assert.deepEqual(
			result.map((attempt) => attempt.providerKeyId),
			['byok:matching-1'],
		);
	});

	it('suppresses a provider outside the key model filter when provider-wide policy applies', async () => {
		const deepseek = makeRoute('deepseek-route');
		const openai = makeRoute('openai-route', {
			providerId: 'provider-openai',
			providerName: 'OpenAI',
			providerKeyId: 'provider-openai',
			endpoint: {
				id: 'endpoint-openai-route',
				modelId: 'openai/gpt-5-mini',
				providerId: 'provider-openai',
				providerSlug: 'openai',
			} as NonNullable<RouteResult['endpoint']>,
			gatewayModelId: 'openai/gpt-5-mini',
		});
		const policyLookup = mock.fn(async ({ provider }: { provider: string }) =>
			provider === 'deepseek'
		);
		const result = await expandAttemptsWithPrivateByok(
			{
				byokKeys: {
					listActiveForRequest: async () => [],
					shouldSuppressSharedCapacityForRequest: policyLookup,
				},
			} as unknown as GatewayRepositories,
			[deepseek, openai],
			[deepseek, openai],
			context,
		);

		assert.deepEqual(result.map((route) => route.providerKeyId), ['provider-openai']);
		assert.equal(policyLookup.mock.callCount(), 2);
	});

	it('evaluates matching-model shared-capacity policy separately per model', async () => {
		const modelA = makeRoute('model-a', {
			gatewayModelId: 'deepseek/model-a',
			endpoint: {
				...makeRoute('model-a').endpoint,
				modelId: 'deepseek/model-a',
			} as NonNullable<RouteResult['endpoint']>,
		});
		const modelB = makeRoute('model-b', {
			gatewayModelId: 'deepseek/model-b',
			endpoint: {
				...makeRoute('model-b').endpoint,
				modelId: 'deepseek/model-b',
			} as NonNullable<RouteResult['endpoint']>,
		});
		const policyLookup = mock.fn(async ({ modelId }: { modelId: string }) =>
			modelId === 'deepseek/model-a'
		);
		const result = await expandAttemptsWithPrivateByok(
			{
				byokKeys: {
					listActiveForRequest: async () => [],
					shouldSuppressSharedCapacityForRequest: policyLookup,
				},
			} as unknown as GatewayRepositories,
			[modelA, modelB],
			[modelA, modelB],
			context,
		);

		assert.deepEqual(result.map((route) => route.targetId), ['model-b']);
		assert.equal(policyLookup.mock.callCount(), 2);
	});

	it('fails closed only for the affected provider when policy lookup fails', async () => {
		const deepseek = makeRoute('deepseek-route');
		const openai = makeRoute('openai-route', {
			providerId: 'provider-openai',
			providerName: 'OpenAI',
			providerKeyId: 'provider-openai',
			endpoint: {
				id: 'endpoint-openai-route',
				modelId: 'openai/gpt-5-mini',
				providerId: 'provider-openai',
				providerSlug: 'openai',
			} as NonNullable<RouteResult['endpoint']>,
			gatewayModelId: 'openai/gpt-5-mini',
		});
		const result = await expandAttemptsWithPrivateByok(
			{
				byokKeys: {
					listActiveForRequest: async () => [],
					shouldSuppressSharedCapacityForRequest: async ({ provider }: { provider: string }) => {
						if (provider === 'deepseek') throw new Error('policy database unavailable');
						return false;
					},
				},
			} as unknown as GatewayRepositories,
			[deepseek, openai],
			[deepseek, openai],
			context,
		);

		assert.deepEqual(result.map((route) => route.providerKeyId), ['provider-openai']);
	});

	it('keeps same-provider shared/platform capacity when no eligible always-use key is returned', async () => {
		const base = makeRoute('route-1');
		const result = await expandAttemptsWithPrivateByok(
			{ byokKeys: { listActiveForRequest: async () => [] } } as unknown as GatewayRepositories,
			[base],
			[base],
			context,
		);

		assert.deepEqual(result.map((route) => route.providerKeyId), ['provider-1']);
	});

	it('drops blank platform credentials and keeps an eligible BYOK-only route', async () => {
		const base = makeRoute('route-1', { providerApiKey: '' });
		const repos = {
			byokKeys: { listActiveForRequest: async () => [makeKey('primary-1')] },
		} as unknown as GatewayRepositories;
		const result = await expandAttemptsWithPrivateByok(
			repos,
			[base],
			[base],
			context,
		);
		assert.deepEqual(result.map((route) => route.providerKeyId), ['byok:primary-1']);
	});

	it('fails closed for the affected provider when the BYOK store fails', async () => {
		const base = makeRoute('route-1');
		const repos = {
			byokKeys: {
				listActiveForRequest: async () => {
					throw new Error('database unavailable');
				},
			},
		} as unknown as GatewayRepositories;
		const result = await expandAttemptsWithPrivateByok(
			repos,
			[base],
			[base],
			context,
		);
		assert.deepEqual(result, []);
	});

	it('preserves other-provider platform attempts when one provider lookup fails', async () => {
		const deepseek = makeRoute('deepseek-route');
		const openai = makeRoute('openai-route', {
			providerId: 'provider-openai',
			providerName: 'OpenAI',
			providerKeyId: 'provider-openai',
			endpoint: {
				id: 'endpoint-openai-route',
				modelId: 'openai/gpt-5-mini',
				providerId: 'provider-openai',
				providerSlug: 'openai',
			} as NonNullable<RouteResult['endpoint']>,
			gatewayModelId: 'openai/gpt-5-mini',
		});
		const result = await expandAttemptsWithPrivateByok(
			{
				byokKeys: {
					listActiveForRequest: async ({ provider }: { provider: string }) => {
						if (provider === 'deepseek') throw new Error('database unavailable');
						return [];
					},
				},
			} as unknown as GatewayRepositories,
			[deepseek, openai],
			[deepseek, openai],
			context,
		);

		assert.deepEqual(result.map((route) => route.providerKeyId), ['provider-openai']);
	});

	it('does not reuse credential-bound ZDR or no-collection evidence for a private key', async () => {
		const lookup = mock.fn(async () => [makeKey('private-1')]);
		const strict = makeRoute('route-1', {
			gatewayPrivateByokDataPolicyAllowed: false,
		});
		const result = await expandAttemptsWithPrivateByok(
			{ byokKeys: { listActiveForRequest: lookup } } as unknown as GatewayRepositories,
			[strict],
			[strict],
			context,
		);

		assert.equal(lookup.mock.callCount(), 0);
		assert.deepEqual(result.map((route) => route.providerKeyId), ['provider-1']);
	});

	it('does not query BYOK and drops blank credentials without request context', async () => {
		const lookup = mock.fn(async () => [makeKey('primary-1')]);
		const blank = makeRoute('blank', { providerApiKey: '' });
		const platform = makeRoute('platform');
		const result = await expandAttemptsWithPrivateByok(
			{ byokKeys: { listActiveForRequest: lookup } } as unknown as GatewayRepositories,
			[blank, platform],
			[blank, platform],
			null,
		);
		assert.equal(lookup.mock.callCount(), 0);
		assert.deepEqual(result.map((route) => route.targetId), ['platform']);
	});
});
