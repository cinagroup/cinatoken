import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../model-router';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchOpenAiRoute } from './openai-driver';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver';

function route(protocol: 'openai' | 'anthropic'): RouteResult {
	return {
		targetId: 'target-a',
		modelSurfaceId: 'surface-a',
		routePoolId: 'pool-a',
		providerId: 'provider-a',
		providerName: 'Provider A',
		providerModelName: 'private/provider-model',
		gatewayModelId: 'public/model-a',
		upstreamProtocol: protocol,
		upstreamOperation: protocol === 'anthropic' ? 'messages' : 'chat',
		adapter: 'passthrough',
		providerEndpoints: { [protocol]: { base: 'https://provider.test/v1' } },
		providerApiKey: 'provider-secret',
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

async function withMockFetch(
	response: () => Response,
	run: (requests: Array<RequestInfo | URL>) => Promise<void>,
): Promise<void> {
	const originalFetch = globalThis.fetch;
	const requests: Array<RequestInfo | URL> = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requests.push(input);
		return response();
	}) as typeof fetch;
	try {
		await run(requests);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe('public model response identity', () => {
	it('rewrites OpenAI Chat JSON and SSE model fields without changing upstream selection', async () => {
		await withMockFetch(
			() => new Response(JSON.stringify({
				id: 'chatcmpl-1',
				object: 'chat.completion',
				created: 1_700_000_000,
				model: 'private/provider-model',
				service_tier: 'standard',
				choices: [{
					index: 0,
					message: { role: 'assistant', content: 'ok' },
					finish_reason: 'stop',
				}],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, speed: 'fast' },
			}), { headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchOpenAiRoute(route('openai'), { model: 'ignored', messages: [] });
				const payload = await result.response.json() as {
					model?: string;
					service_tier?: unknown;
					usage?: { speed?: unknown };
				};
				assert.equal(payload.model, 'public/model-a');
				assert.equal(payload.service_tier, 'default');
				assert.equal(payload.usage?.speed, 'fast');
				const usage = await result.usagePromise;
				assert.equal(usage.total_tokens, 3);
				assert.equal(usage.service_tier, 'default');
				assert.equal(usage.speed, 'fast');
			},
		);

		await withMockFetch(
			() => new Response(
				`data:${JSON.stringify({ id: 'chatcmpl-2', model: 'private/provider-model', service_tier: 'fast', choices: [{ delta: { content: 'hi' } }] })}\n\n` +
				`data: ${JSON.stringify({ model: 'private/provider-model', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, speed: 'fast' } })}\n\n` +
				'data: [DONE]\n\n',
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			async () => {
				const result = await dispatchOpenAiRoute(route('openai'), { model: 'ignored', stream: true });
				const text = await result.response.text();
				assert.equal(text.includes('private/provider-model'), false);
				assert.equal(text.includes('public/model-a'), true);
				assert.equal((text.match(/"service_tier":"priority"/gu) ?? []).length, 2);
				assert.match(text, /"speed":"fast"/u);
				const usage = await result.usagePromise;
				assert.equal(usage.total_tokens, 2);
				assert.equal(usage.service_tier, 'priority');
				assert.equal(usage.speed, 'fast');
			},
		);
	});

	it('rewrites provider model identity in no-space Anthropic and Responses SSE data fields', async () => {
		await withMockFetch(
			() => new Response(
				`data:${JSON.stringify({ type: 'message_start', message: { model: 'private/provider-model', usage: { input_tokens: 1, output_tokens: 0, service_tier: 'default', speed: 'fast' } } })}\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			async () => {
				const result = await dispatchAnthropicRoute(route('anthropic'), { model: 'ignored', messages: [], stream: true });
				const text = await result.response.text();
				assert.equal(text.includes('private/provider-model'), false);
				assert.equal(text.includes('public/model-a'), true);
				assert.match(text, /"service_tier":"standard"/u);
				assert.match(text, /"speed":"fast"/u);
				const usage = await result.usagePromise;
				assert.equal(usage.service_tier, 'default');
				assert.equal(usage.speed, 'fast');
			},
		);

		await withMockFetch(
			() => new Response(
				`data:${JSON.stringify({ type: 'response.completed', response: { model: 'private/provider-model', service_tier: 'fast', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, speed: 'fast' } } })}\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			async () => {
				const result = await dispatchOpenAiResponsesRoute(route('openai'), { model: 'ignored', input: 'hi', stream: true });
				const text = await result.response.text();
				assert.equal(text.includes('private/provider-model'), false);
				assert.equal(text.includes('public/model-a'), true);
				assert.match(text, /"service_tier":"priority"/u);
				assert.match(text, /"speed":"fast"/u);
				const usage = await result.usagePromise;
				assert.equal(usage.service_tier, 'priority');
				assert.equal(usage.speed, 'fast');
			},
		);
	});

	it('rewrites Responses and Anthropic JSON model fields', async () => {
		await withMockFetch(
			() => new Response(JSON.stringify({
				id: 'resp-1',
				object: 'response',
				created_at: 1_700_000_000,
				completed_at: 1_700_000_001,
				error: null,
				model: 'private/provider-model',
				status: 'completed',
				service_tier: 'standard',
				output: [],
				usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, speed: 'fast' },
			}), { headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchOpenAiResponsesRoute(route('openai'), { model: 'ignored', input: 'hi' });
				const payload = await result.response.json() as {
					model?: string;
					service_tier?: unknown;
					usage?: { speed?: unknown };
				};
				assert.equal(payload.model, 'public/model-a');
				assert.equal(payload.service_tier, 'default');
				assert.equal(payload.usage?.speed, 'fast');
				const usage = await result.usagePromise;
				assert.equal(usage.total_tokens, 5);
				assert.equal(usage.service_tier, 'default');
				assert.equal(usage.speed, 'fast');
			},
		);

		await withMockFetch(
			() => new Response(JSON.stringify({
				id: 'msg-1',
				type: 'message',
				role: 'assistant',
				model: 'private/provider-model',
				content: [],
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 2, output_tokens: 4, service_tier: 'default', speed: 'fast' },
			}), { headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchAnthropicRoute(route('anthropic'), { model: 'ignored', messages: [] });
				const payload = await result.response.json() as {
					model?: string;
					usage?: { service_tier?: unknown; speed?: unknown };
				};
				assert.equal(payload.model, 'public/model-a');
				assert.equal(payload.usage?.service_tier, 'standard');
				assert.equal(payload.usage?.speed, 'fast');
				const usage = await result.usagePromise;
				assert.equal(usage.total_tokens, 6);
				assert.equal(usage.service_tier, 'default');
				assert.equal(usage.speed, 'fast');
			},
		);
	});
});
