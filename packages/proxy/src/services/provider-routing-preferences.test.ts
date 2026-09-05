import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from './model-router';
import { applyProviderRoutingPreferences, prepareProviderRoutingPreferences } from './provider-routing-preferences';

type EndpointOverrides = Partial<{
	supported_parameters: string[];
	quantization: NonNullable<RouteResult['endpoint']>['quantization'];
	endpoint_slug: string | null;
	endpoint_class: NonNullable<RouteResult['endpoint']>['endpointClass'];
	region: string | null;
	context_length: number | null;
	max_prompt_tokens: number | null;
	max_completion_tokens: number | null;
}>;

function route(
	providerId: string,
	providerName: string,
	priority: number,
	endpointOverrides: EndpointOverrides | null = null,
): RouteResult {
	const endpoint = {
		supported_parameters: [],
		quantization: null,
		endpoint_slug: providerId,
		endpoint_class: null,
		region: null,
		context_length: null,
		max_prompt_tokens: null,
		max_completion_tokens: null,
		...(endpointOverrides ?? {}),
	};
	return {
		targetId: `${providerId}-${endpoint.endpoint_slug ?? 'target'}`, modelSurfaceId: null, routePoolId: 'pool',
		providerId, providerName, providerModelName: 'model', upstreamProtocol: 'openai',
		upstreamOperation: 'chat', adapter: 'passthrough', providerEndpoints: {},
		providerApiKey: 'secret', providerSharedChannelType: null, priceOverrideRaw: null,
		routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null,
		routeGroup: 'default', routePriority: priority, routeWeight: 1,
		endpoint: {
			id: `${providerId}-endpoint`, modelId: 'model', providerId,
			providerSlug: endpoint.endpoint_slug?.split('/')[0] ?? providerId,
			selectorSlug: endpoint.endpoint_slug ?? providerId,
			endpointClass: endpoint.endpoint_class,
			region: endpoint.region,
			contextLength: endpoint.context_length,
			maxPromptTokens: endpoint.max_prompt_tokens,
			maxCompletionTokens: endpoint.max_completion_tokens,
			quantization: endpoint.quantization,
			supportedParameters: endpoint.supported_parameters,
			pricing: { currency: 'USD', prompt: '0', completion: '0' },
			capabilities: {
				implicit_caching: false,
				voice_cloning: false,
				tool_choice: { auto: false, function: false, none: false, required: false },
			},
			imageCapabilities: null,
			evidenceUrl: 'https://provider.test/evidence', verifiedBy: 'test',
			verifiedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
		},
		routingMetadata: null,
	};
}

const routes = [route('anthropic-main', 'Anthropic', 100), route('openai-main', 'OpenAI', 50), route('google-main', 'Google', 10)];

describe('provider routing preferences', () => {
	it('keeps the original request untouched when no preference is present', () => {
		const body = { model: 'test', messages: [] };
		const result = applyProviderRoutingPreferences(body, routes);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.body, body);
		assert.equal(result.routes, routes);
		assert.equal(result.hasPreferences, false);
	});

	it('orders matching providers first and strips the control object upstream', () => {
		const result = applyProviderRoutingPreferences({ model: 'test', provider: { order: ['OpenAI', 'Anthropic'] } }, routes);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal('provider' in result.body, false);
		assert.deepEqual([...result.routes].sort((a, b) => b.routePriority - a.routePriority).map((item) => item.providerId), [
			'openai-main', 'anthropic-main', 'google-main',
		]);
	});

	it('supports allowlists, denylists, and disabling fallback', () => {
		const filtered = applyProviderRoutingPreferences({ provider: { only: ['OpenAI', 'Google'], ignore: ['Google'] } }, routes);
		assert.equal(filtered.ok, true);
		if (filtered.ok) assert.deepEqual(filtered.routes.map((item) => item.providerId), ['openai-main']);

		const orderedOnly = applyProviderRoutingPreferences({ provider: { order: ['Google', 'OpenAI'], allow_fallbacks: false } }, routes);
		assert.equal(orderedOnly.ok, true);
		if (orderedOnly.ok) {
			assert.deepEqual(
				[...orderedOnly.routes].sort((a, b) => b.routePriority - a.routePriority).map((item) => item.providerId),
				['google-main', 'openai-main'],
			);
		}

		const orderReplacesSort = applyProviderRoutingPreferences({
			provider: { order: ['Google', 'OpenAI'], sort: 'price' },
		}, routes);
		assert.equal(orderReplacesSort.ok, true);
		if (orderReplacesSort.ok) assert.equal(orderReplacesSort.preferences?.sort, null);
	});

	it('supports ZDR as a validated gateway control and fails closed for unknown fields', () => {
		const zdr = prepareProviderRoutingPreferences({ provider: { zdr: true } });
		assert.equal(zdr.ok, true);
		if (zdr.ok) {
			assert.equal(zdr.value.requireZdr, true);
			assert.equal('provider' in zdr.value.body, false);
		}
		assert.deepEqual(applyProviderRoutingPreferences({ provider: { unknown: true } }, routes), {
			ok: false,
			message: 'Unsupported provider preference: unknown. Supported fields: order, only, ignore, allow_fallbacks, zdr, require_parameters, data_collection, enforce_distillable_text, quantizations, sort, preferred_min_throughput, preferred_max_latency, max_price',
		});
		assert.deepEqual(applyProviderRoutingPreferences({ provider: { zdr: 'yes' } }, routes), {
			ok: false,
			message: 'provider.zdr must be a boolean',
		});
		const missing = applyProviderRoutingPreferences({ provider: { only: ['Missing'] } }, routes);
		assert.equal(missing.ok, false);
	});

	it('filters route quantization and strictly enforces requested parameter capabilities', () => {
		const capableRoutes = [
			route('fp8', 'FP8', 10, { supported_parameters: ['tools', 'temperature'], quantization: 'fp8', endpoint_slug: 'fast/fp8', endpoint_class: 'standard', region: 'us' }),
			route('fp16', 'FP16', 9, { supported_parameters: ['temperature'], quantization: 'fp16', endpoint_slug: 'steady/fp16', endpoint_class: 'standard', region: 'eu' }),
		];
		const result = applyProviderRoutingPreferences({
			messages: [],
			tools: [{ type: 'function' }],
			provider: { quantizations: ['fp8'], require_parameters: true },
		}, capableRoutes);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.routes.map((item) => item.providerId), ['fp8']);

		const rerank = applyProviderRoutingPreferences({
			model: 'cohere/rerank-v3.5',
			query: 'query',
			documents: ['a', 'b'],
			top_n: 1,
			provider: { require_parameters: true },
		}, [
			route('rerank', 'Rerank', 1, {
				supported_parameters: ['top_n'], quantization: null,
				endpoint_slug: 'cohere/default', endpoint_class: 'standard', region: 'us',
			}),
		]);
		assert.equal(rerank.ok, true, 'query/documents are structural; only top_n requires capability evidence');

		const softToolChoice = applyProviderRoutingPreferences({
			messages: [],
			tool_choice: 'auto',
			provider: {},
		}, [
			route('tools', 'Tools', 1, { supported_parameters: ['tool_choice'], quantization: null, endpoint_slug: null, endpoint_class: null, region: null }),
			route('cheap', 'Cheap', 100, { supported_parameters: [], quantization: null, endpoint_slug: null, endpoint_class: null, region: null }),
		]);
		assert.equal(softToolChoice.ok, true);
		if (softToolChoice.ok) {
			assert.deepEqual(softToolChoice.routes.map((item) => item.providerId), ['tools']);
		}
	});

	it('matches exact endpoint slugs and their base slug without treating region as a variant', () => {
		const variants = [
			route('acme', 'Acme', 100, {
				supported_parameters: ['speed'], quantization: null, endpoint_slug: 'acme/standard', endpoint_class: 'standard', region: 'eu',
			}),
			route('acme', 'Acme', 10, {
				supported_parameters: [], quantization: null, endpoint_slug: 'acme/turbo', endpoint_class: 'standard', region: 'us',
			}),
			route('other-provider', 'Other', 50, {
				supported_parameters: [], quantization: null, endpoint_slug: 'other/default', endpoint_class: 'standard', region: 'us',
			}),
			route('acme', 'Acme', 5, {
				supported_parameters: [], quantization: null, endpoint_slug: 'acme/flex', endpoint_class: 'service_tier', region: 'us',
			}),
			route('acme', 'Acme', 3, {
				supported_parameters: ['speed'], quantization: null, endpoint_slug: 'acme/fast', endpoint_class: 'service_tier', region: 'us',
			}),
			route('acme', 'Acme', 4, {
				supported_parameters: [], quantization: null, endpoint_slug: 'acme/mystery', endpoint_class: 'service_tier', region: 'us',
			}),
		];

		const ordered = applyProviderRoutingPreferences({
			provider: { order: ['acme/turbo', 'acme'] },
		}, variants);
		assert.equal(ordered.ok, true);
		if (ordered.ok) {
			assert.deepEqual(
				[...ordered.routes]
					.sort((a, b) => b.routePriority - a.routePriority)
			.map((item) => item.endpoint?.selectorSlug),
				['acme/turbo', 'acme/standard', 'other/default'],
			);
		}

		const noProviderPreference = applyProviderRoutingPreferences({ model: 'test' }, variants);
		assert.equal(noProviderPreference.ok, true);
		if (noProviderPreference.ok) {
			assert.deepEqual(
				noProviderPreference.routes.map((item) => item.endpoint?.selectorSlug),
				['acme/standard', 'acme/turbo', 'other/default'],
			);
		}

		const exactOnly = applyProviderRoutingPreferences({ provider: { only: ['acme/turbo'] } }, variants);
		assert.equal(exactOnly.ok, true);
		if (exactOnly.ok) assert.deepEqual(exactOnly.routes.map((item) => item.endpoint?.selectorSlug), ['acme/turbo']);

		const baseOnly = applyProviderRoutingPreferences({ provider: { only: ['acme'] } }, variants);
		assert.equal(baseOnly.ok, true);
		if (baseOnly.ok) {
			assert.deepEqual(baseOnly.routes.map((item) => item.endpoint?.selectorSlug), ['acme/standard', 'acme/turbo']);
		}

		const exactTier = applyProviderRoutingPreferences({ provider: { only: ['acme/flex'] } }, variants);
		assert.equal(exactTier.ok, true);
		if (exactTier.ok) assert.deepEqual(exactTier.routes.map((item) => item.endpoint?.selectorSlug), ['acme/flex']);

		const orderedTier = applyProviderRoutingPreferences({ provider: { order: ['acme/flex'] } }, variants);
		assert.equal(orderedTier.ok, true);
		if (orderedTier.ok) {
			assert.equal(
				[...orderedTier.routes].sort((a, b) => b.routePriority - a.routePriority)[0]?.endpoint?.selectorSlug,
				'acme/flex',
			);
			assert.equal(orderedTier.routes.some((item) => item.endpoint?.selectorSlug === 'acme/mystery'), false);
		}

		const exactSecondTier = applyProviderRoutingPreferences({ provider: { only: ['acme/mystery'] } }, variants);
		assert.equal(exactSecondTier.ok, true);
		if (exactSecondTier.ok) {
			assert.deepEqual(exactSecondTier.routes.map((item) => item.endpoint?.selectorSlug), ['acme/mystery']);
		}

		const ignoredVariant = applyProviderRoutingPreferences({ provider: { ignore: ['acme/turbo'] } }, variants);
		assert.equal(ignoredVariant.ok, true);
		if (ignoredVariant.ok) {
			assert.deepEqual(ignoredVariant.routes.map((item) => item.endpoint?.selectorSlug), ['acme/standard', 'other/default']);
		}

		const ignoredBase = applyProviderRoutingPreferences({ provider: { ignore: ['acme'] } }, variants);
		assert.equal(ignoredBase.ok, true);
		if (ignoredBase.ok) {
			assert.deepEqual(ignoredBase.routes.map((item) => item.endpoint?.selectorSlug), ['other/default']);
		}

		const regionIsNotAnEndpointSelector = applyProviderRoutingPreferences({ provider: { only: ['acme/eu'] } }, variants);
		assert.equal(regionIsNotAnEndpointSelector.ok, false);

		const flexTier = applyProviderRoutingPreferences({ service_tier: 'flex' }, variants);
		assert.equal(flexTier.ok, true);
		if (flexTier.ok) {
			assert.equal('service_tier' in flexTier.body, false);
			assert.deepEqual(flexTier.routes.map((item) => item.endpoint?.selectorSlug), ['acme/flex']);
			assert.equal(flexTier.routes[0]?.gatewayServiceTier, 'flex');
			assert.equal(flexTier.preferences?.sort?.by, 'price');
		}

		const priorityTier = applyProviderRoutingPreferences({ service_tier: 'fast' }, variants);
		assert.equal(priorityTier.ok, true);
		if (priorityTier.ok) {
			assert.deepEqual(priorityTier.routes.map((item) => item.endpoint?.selectorSlug), [
				'acme/standard', 'acme/turbo', 'other/default', 'acme/fast',
			]);
			assert.deepEqual(priorityTier.routes.map((item) => item.gatewayServiceTier), [
				'default', 'default', 'default', 'priority',
			]);
			assert.equal(priorityTier.preferences?.serviceTier, 'priority');
			assert.equal(priorityTier.preferences?.sort?.by, 'throughput');
		}

		const priorityAlias = applyProviderRoutingPreferences({ provider: { only: ['acme/priority'] } }, variants);
		assert.equal(priorityAlias.ok, true);
		if (priorityAlias.ok) {
			assert.deepEqual(priorityAlias.routes.map((item) => item.endpoint?.selectorSlug), ['acme/fast']);
			assert.equal(priorityAlias.routes[0]?.gatewayServiceTier, 'priority');
		}

		const speedFast = applyProviderRoutingPreferences({ speed: 'fast' }, variants);
		assert.equal(speedFast.ok, true);
		if (speedFast.ok) {
			assert.equal('speed' in speedFast.body, false);
			assert.equal(speedFast.preferences?.serviceTier, 'priority');
			assert.equal(speedFast.preferences?.explicitServiceTier, null);
			assert.equal(speedFast.preferences?.requestedSpeed, 'fast');
			assert.deepEqual(speedFast.routes.map((item) => item.endpoint?.selectorSlug), [
				'acme/standard', 'acme/turbo', 'other/default', 'acme/fast',
			]);
			assert.deepEqual(speedFast.routes.map((item) => item.gatewayTextSpeed), [
				'fast', undefined, undefined, 'fast',
			]);
			assert.deepEqual(speedFast.routes.map((item) => item.gatewayRequestedServiceTier), [
				'priority', 'default', 'default', 'priority',
			]);
			assert.equal(speedFast.routes.every((item) => item.gatewayTextSpeedControlled), true);
		}

		const conflictingPriority = applyProviderRoutingPreferences({
			speed: 'standard',
			service_tier: 'priority',
		}, variants);
		assert.equal(conflictingPriority.ok, true);
		if (conflictingPriority.ok) {
			assert.equal(conflictingPriority.preferences?.serviceTier, 'priority');
			assert.equal(conflictingPriority.preferences?.explicitServiceTier, 'priority');
			assert.equal(conflictingPriority.preferences?.requestedSpeed, 'standard');
			assert.equal(conflictingPriority.routes[0]?.gatewayTextSpeed, 'standard');
			assert.equal(conflictingPriority.routes.at(-1)?.gatewayTextSpeed, 'standard');
		}

		const explicitDefaultFast = applyProviderRoutingPreferences({
			speed: 'fast',
			service_tier: 'default',
		}, variants);
		assert.equal(explicitDefaultFast.ok, true);
		if (explicitDefaultFast.ok) {
			assert.deepEqual(explicitDefaultFast.routes.map((item) => item.endpoint?.selectorSlug), [
				'acme/standard', 'acme/turbo', 'other/default',
			]);
			assert.equal(explicitDefaultFast.routes[0]?.gatewayRequestedServiceTier, 'default');
			assert.equal(explicitDefaultFast.routes[0]?.gatewayTextSpeed, 'fast');
		}

		const explicitNullSpeed = applyProviderRoutingPreferences({ speed: null }, variants);
		assert.equal(explicitNullSpeed.ok, true);
		if (explicitNullSpeed.ok) {
			assert.equal('speed' in explicitNullSpeed.body, false);
			assert.equal(explicitNullSpeed.routes.every((item) => item.gatewayTextSpeedControlled), true);
		}
		assert.deepEqual(applyProviderRoutingPreferences({ speed: 2 }, variants), {
			ok: false,
			message: 'speed must be one of: fast, standard, or null',
		});

		const nitro = applyProviderRoutingPreferences({}, variants, 'nitro');
		assert.equal(nitro.ok, true);
		if (nitro.ok) {
			assert.deepEqual(nitro.routes.map((item) => item.endpoint?.selectorSlug), [
				'acme/standard', 'acme/turbo', 'other/default', 'acme/fast',
			]);
			assert.equal(nitro.preferences?.sort?.by, 'throughput');
		}
		const floor = applyProviderRoutingPreferences({}, variants, 'floor');
		assert.equal(floor.ok, true);
		if (floor.ok) {
			assert.deepEqual(floor.routes.map((item) => item.endpoint?.selectorSlug), [
				'acme/standard', 'acme/turbo', 'other/default', 'acme/flex',
			]);
			assert.equal(floor.preferences?.sort?.by, 'price');
		}

		const explicitDefault = applyProviderRoutingPreferences({ service_tier: 'default' }, variants, 'nitro');
		assert.equal(explicitDefault.ok, true);
		if (explicitDefault.ok) {
			assert.deepEqual(explicitDefault.routes.map((item) => item.endpoint?.selectorSlug), [
				'acme/standard', 'acme/turbo', 'other/default',
			]);
		}

		const orderedVariant = applyProviderRoutingPreferences({ provider: { order: ['acme'] } }, variants, 'nitro');
		assert.equal(orderedVariant.ok, true);
		if (orderedVariant.ok) {
			assert.equal(orderedVariant.routes.some((item) => item.endpoint?.endpointClass === 'service_tier'), false);
		}

		assert.deepEqual(applyProviderRoutingPreferences({ service_tier: 'scale' }, variants), {
			ok: false,
			message: 'service_tier must be one of: auto, default, fast, flex, priority, or null',
		});
		const tierOnlyByDefault = applyProviderRoutingPreferences({ model: 'test' }, variants.slice(-2));
		assert.equal(tierOnlyByDefault.ok, false);

		const flexFallback = applyProviderRoutingPreferences({ service_tier: 'flex' }, variants.slice(0, 3));
		assert.equal(flexFallback.ok, true);
		if (flexFallback.ok) assert.equal(flexFallback.preferences?.sort, null);

		const flexFallbackWithConfiguredSort = applyProviderRoutingPreferences({
			service_tier: 'flex',
			provider: { sort: 'latency' },
		}, variants.slice(0, 3));
		assert.equal(flexFallbackWithConfiguredSort.ok, true);
		if (flexFallbackWithConfiguredSort.ok) {
			assert.deepEqual(flexFallbackWithConfiguredSort.preferences?.sort, {
				by: 'latency',
				partition: 'model',
			});
		}
	});

	it('validates price, multi-percentile performance, data and cross-model sorting controls', () => {
		const prepared = prepareProviderRoutingPreferences({
			provider: {
				data_collection: 'deny',
				enforce_distillable_text: true,
				sort: { by: 'latency', partition: 'model' },
				preferred_max_latency: { p50: 1, p90: 2.5 },
				preferred_min_throughput: 30,
				max_price: { prompt: 1, completion: 3 },
			},
		});
		assert.equal(prepared.ok, true);
		if (prepared.ok) {
			assert.equal(prepared.value.preferences?.dataCollection, 'deny');
			assert.deepEqual(prepared.value.preferences?.sort, { by: 'latency', partition: 'model' });
			assert.deepEqual(prepared.value.preferences?.preferredMaxLatency, { p50: 1, p90: 2.5 });
		}
		const crossModel = prepareProviderRoutingPreferences({ provider: { sort: { by: 'price', partition: 'none' } } });
		assert.equal(crossModel.ok, true);
		if (crossModel.ok) {
			assert.deepEqual(crossModel.value.preferences?.sort, { by: 'price', partition: 'none' });
		}
		const legacyShape = prepareProviderRoutingPreferences({
			provider: { preferred_max_latency: { percentile: 'p90', value: 2.5 } },
		});
		assert.equal(legacyShape.ok, false);
		const requestPrice = prepareProviderRoutingPreferences({ provider: { max_price: { request: 0.01 } } });
		assert.equal(requestPrice.ok, true);
		if (requestPrice.ok) assert.equal(requestPrice.value.preferences?.maxPrice?.request, 0.01);
	});

	it('prepares one validated applicator for multiple model route sets', () => {
		const prepared = prepareProviderRoutingPreferences({
			model: 'test',
			provider: { only: ['OpenAI'] },
		});
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;
		assert.equal('provider' in prepared.value.body, false);
		const result = prepared.value.apply(routes);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.routes.map((item) => item.providerId), ['openai-main']);
	});

	it('leaves numeric speed untouched when text-speed parsing is not enabled', () => {
		const body = { model: 'tts-model', speed: 1.25 };
		const prepared = prepareProviderRoutingPreferences(body);
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;
		assert.equal(prepared.value.body, body);
		assert.equal(prepared.value.body.speed, 1.25);
		assert.equal(prepared.value.requestedSpeed, null);
	});
});
