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
				model: 'private/provider-model',
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchOpenAiRoute(route('openai'), { model: 'ignored', messages: [] });
				const payload = await result.response.json() as { model?: string };
				assert.equal(payload.model, 'public/model-a');
				assert.equal((await result.usagePromise).total_tokens, 3);
			},
		);

		await withMockFetch(
			() => new Response(
				`data:${JSON.stringify({ id: 'chatcmpl-2', model: 'private/provider-model', choices: [{ delta: { content: 'hi' } }] })}\n` +
				`data: ${JSON.stringify({ model: 'private/provider-model', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
				'data: [DONE]\n\n',
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			async () => {
				const result = await dispatchOpenAiRoute(route('openai'), { model: 'ignored', stream: true });
				const text = await result.response.text();
				assert.equal(text.includes('private/provider-model'), false);
				assert.equal(text.includes('public/model-a'), true);
				assert.equal((await result.usagePromise).total_tokens, 2);
			},
		);
	});

	it('rewrites provider model identity in no-space Anthropic and Responses SSE data fields', async () => {
		await withMockFetch(
			() => new Response(
				`data:${JSON.stringify({ type: 'message_start', message: { model: 'private/provider-model', usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			async () => {
				const result = await dispatchAnthropicRoute(route('anthropic'), { model: 'ignored', messages: [], stream: true });
				const text = await result.response.text();
				assert.equal(text.includes('private/provider-model'), false);
				assert.equal(text.includes('public/model-a'), true);
			},
		);

		await withMockFetch(
			() => new Response(
				`data:${JSON.stringify({ type: 'response.completed', response: { model: 'private/provider-model', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			async () => {
				const result = await dispatchOpenAiResponsesRoute(route('openai'), { model: 'ignored', input: 'hi', stream: true });
				const text = await result.response.text();
				assert.equal(text.includes('private/provider-model'), false);
				assert.equal(text.includes('public/model-a'), true);
			},
		);
	});

	it('rewrites Responses and Anthropic JSON model fields', async () => {
		await withMockFetch(
			() => new Response(JSON.stringify({
				id: 'resp-1',
				model: 'private/provider-model',
				usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchOpenAiResponsesRoute(route('openai'), { model: 'ignored', input: 'hi' });
				assert.equal(((await result.response.json()) as { model?: string }).model, 'public/model-a');
				assert.equal((await result.usagePromise).total_tokens, 5);
			},
		);

		await withMockFetch(
			() => new Response(JSON.stringify({
				id: 'msg-1',
				model: 'private/provider-model',
				content: [],
				usage: { input_tokens: 2, output_tokens: 4 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchAnthropicRoute(route('anthropic'), { model: 'ignored', messages: [] });
				assert.equal(((await result.response.json()) as { model?: string }).model, 'public/model-a');
				assert.equal((await result.usagePromise).total_tokens, 6);
			},
		);
	});
});
