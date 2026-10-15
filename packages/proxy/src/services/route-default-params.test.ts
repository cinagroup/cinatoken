import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from './model-router';
import { buildRouteRequestBody } from './route-default-params';

describe('route default gateway controls', () => {
	it('removes session_id from both route defaults and the user body', () => {
		const route = {
			customParams: { session_id: 'route-secret', temperature: 0.5 },
			gatewaySessionIdControlled: true,
		} as RouteResult;
		assert.deepEqual(
			buildRouteRequestBody(route, { session_id: 'user-session', top_p: 0.9 }),
			{ temperature: 0.5, top_p: 0.9 },
		);
	});
});


function route(customParams: Record<string, unknown> | null): RouteResult {
	return {
		targetId: 't1',
		modelSurfaceId: 's1',
		routePoolId: 'p1',
		providerId: 'prov1',
		providerName: 'OpenAI',
		providerModelName: 'gpt-4o-mini',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://api.openai.com/v1' } },
		providerApiKey: 'sk-test',
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
	};
}

describe('buildRouteRequestBody', () => {
	it('strips custom_params.headers from the upstream JSON body', () => {
		const body = buildRouteRequestBody(
			route({
				temperature: 0.7,
				headers: { 'HTTP-Referer': 'https://example.com' },
			}),
			{ messages: [] },
		);
		assert.equal(body.temperature, 0.7);
		assert.equal(body.headers, undefined);
		assert.deepEqual(body.messages, []);
	});

	it('lets route fields win when force_override.body is on', () => {
		const body = buildRouteRequestBody(
			route({
				body: { max_tokens: 32000 },
				force_override: { body: true },
			}),
			{ messages: [], max_tokens: 8000 },
		);
		assert.equal(body.max_tokens, 32000);
		assert.deepEqual(body.messages, []);
	});
});
