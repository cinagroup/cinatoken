import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Env } from '../app';
import type { RouteResult } from '../services/model-router';
import type { UsageFromStream } from '../services/proxy';
import { dispatchAnthropicRoute } from '../services/egress/anthropic-driver';
import { dispatchOpenAiEmbeddingsRoute } from '../services/egress/openai-embeddings-driver';
import { dispatchOpenAiRoute } from '../services/egress/openai-driver';
import { dispatchOpenAiResponsesRoute } from '../services/egress/openai-responses-driver';
import { parseSseEventData } from '../services/egress/sse-data-line';
import {
	assignGenerationId,
	createGenerationId,
	GENERATION_ID_HEADER,
} from './generation-id';

type TextDispatchResult = {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
};

function route(protocol: 'openai' | 'anthropic', operation: string): RouteResult {
	return {
		targetId: 'target-a',
		modelSurfaceId: 'surface-a',
		routePoolId: 'pool-a',
		providerId: 'provider-a',
		providerName: 'Provider A',
		providerModelName: 'private/provider-model',
		gatewayModelId: 'public/model-a',
		upstreamProtocol: protocol,
		upstreamOperation: operation,
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

async function throughGenerationMiddleware(
	providerResponse: () => Response,
	dispatch: (generationId: string) => Promise<TextDispatchResult>,
): Promise<{ response: Response; usagePromise: Promise<UsageFromStream> }> {
	const originalFetch = globalThis.fetch;
	let usagePromise: Promise<UsageFromStream> | undefined;
	globalThis.fetch = (async () => providerResponse()) as typeof fetch;
	try {
		const app = new Hono<Env>();
		app.use('*', assignGenerationId);
		app.post('/', async (c) => {
			const result = await dispatch(c.get('generationId') ?? '');
			usagePromise = result.usagePromise;
			return result.response;
		});
		const response = await app.request('/', { method: 'POST' });
		if (!usagePromise) throw new Error('dispatch did not expose a usage promise');
		return { response, usagePromise };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function jsonSseEvents(text: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const event of text.split(/\r\n\r\n|\n\n|\r\r/)) {
		const data = parseSseEventData(event)?.trim();
		if (!data || data === '[DONE]') continue;
		const parsed = JSON.parse(data) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			events.push(parsed as Record<string, unknown>);
		}
	}
	return events;
}

describe('generation id middleware', () => {
	it('uses an OpenRouter-shaped cryptographically random identifier', () => {
		const first = createGenerationId();
		const second = createGenerationId();
		assert.match(first, /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		assert.notEqual(first, second);
	});

	it('reuses the route generation id in the response header without buffering a stream', async () => {
		const app = new Hono<Env>();
		app.use('*', assignGenerationId);
		app.get('/stream', (c) => {
			const expected = c.get('generationId');
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(expected));
					controller.close();
				},
			});
			return new Response(stream, { headers: { 'Content-Type': 'text/plain' } });
		});

		const response = await app.request('/stream');
		const header = response.headers.get(GENERATION_ID_HEADER);
		assert.ok(header);
		assert.equal(await response.text(), header);
	});

	it('uses the public generation id for Chat JSON while retaining the upstream id for audit', async () => {
		const result = await throughGenerationMiddleware(
			() => new Response(JSON.stringify({
				id: 'chatcmpl-private-json',
				object: 'chat.completion',
				created: 1_700_000_000,
				model: 'private/provider-model',
				choices: [{
					index: 0,
					message: { role: 'assistant', content: 'ok' },
					finish_reason: 'stop',
				}],
				usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			(generationId) => dispatchOpenAiRoute(
				route('openai', 'chat'),
				{ messages: [] },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const generationId = result.response.headers.get(GENERATION_ID_HEADER);
		assert.match(generationId ?? '', /^gen-/);
		const body = await result.response.json() as { id?: string; model?: string };
		assert.equal(body.id, generationId);
		assert.equal(body.model, 'public/model-a');
		assert.equal((await result.usagePromise).upstreamMessageId, 'chatcmpl-private-json');
	});

	it('uses one public generation id across the Chat header and every stream chunk', async () => {
		const result = await throughGenerationMiddleware(
			() => new Response(
				`data: ${JSON.stringify({ id: 'chatcmpl-private-stream', model: 'private/provider-model', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`
				+ `data: ${JSON.stringify({ model: 'private/provider-model', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
				+ 'data: [DONE]\n\n',
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			(generationId) => dispatchOpenAiRoute(
				route('openai', 'chat'),
				{ messages: [], stream: true },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const generationId = result.response.headers.get(GENERATION_ID_HEADER);
		assert.match(generationId ?? '', /^gen-/);
		const events = jsonSseEvents(await result.response.text());
		assert.equal(events.length, 2);
		assert.equal(events.every((event) => event.id === generationId), true);
		assert.equal((await result.usagePromise).upstreamMessageId, 'chatcmpl-private-stream');
	});

	it('keeps Responses protocol ids while exposing the gateway generation id separately', async () => {
		const jsonResult = await throughGenerationMiddleware(
			() => new Response(JSON.stringify({
				id: 'resp_private_json',
				object: 'response',
				created_at: 1_700_000_000,
				completed_at: 1_700_000_001,
				error: null,
				model: 'private/provider-model',
				status: 'completed',
				output: [],
				usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			(generationId) => dispatchOpenAiResponsesRoute(
				route('openai', 'responses'),
				{ input: 'hi' },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const jsonGenerationId = jsonResult.response.headers.get(GENERATION_ID_HEADER);
		const jsonBody = await jsonResult.response.json() as { id?: string };
		assert.match(jsonGenerationId ?? '', /^gen-/);
		assert.equal(jsonBody.id, 'resp_private_json');
		assert.notEqual(jsonBody.id, jsonGenerationId);
		assert.equal((await jsonResult.usagePromise).upstreamMessageId, 'resp_private_json');

		const streamResult = await throughGenerationMiddleware(
			() => new Response(
				`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_private_stream', model: 'private/provider-model', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })}\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			(generationId) => dispatchOpenAiResponsesRoute(
				route('openai', 'responses'),
				{ input: 'hi', stream: true },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const streamGenerationId = streamResult.response.headers.get(GENERATION_ID_HEADER);
		const responseEvent = jsonSseEvents(await streamResult.response.text())[0]!;
		assert.match(streamGenerationId ?? '', /^gen-/);
		assert.equal((responseEvent.response as { id?: string }).id, 'resp_private_stream');
		assert.equal((await streamResult.usagePromise).upstreamMessageId, 'resp_private_stream');
	});

	it('keeps Anthropic message ids while exposing the gateway generation id separately', async () => {
		const jsonResult = await throughGenerationMiddleware(
			() => new Response(JSON.stringify({
				id: 'msg_private_json',
				type: 'message',
				role: 'assistant',
				model: 'private/provider-model',
				content: [],
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: { input_tokens: 3, output_tokens: 5 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			(generationId) => dispatchAnthropicRoute(
				route('anthropic', 'messages'),
				{ messages: [] },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const jsonGenerationId = jsonResult.response.headers.get(GENERATION_ID_HEADER);
		const jsonBody = await jsonResult.response.json() as { id?: string };
		assert.match(jsonGenerationId ?? '', /^gen-/);
		assert.equal(jsonBody.id, 'msg_private_json');
		assert.notEqual(jsonBody.id, jsonGenerationId);
		assert.equal((await jsonResult.usagePromise).upstreamMessageId, 'msg_private_json');

		const streamResult = await throughGenerationMiddleware(
			() => new Response(
				`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_private_stream', model: 'private/provider-model', usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`
				+ `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
				{ headers: { 'Content-Type': 'text/event-stream' } },
			),
			(generationId) => dispatchAnthropicRoute(
				route('anthropic', 'messages'),
				{ messages: [], stream: true },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const streamGenerationId = streamResult.response.headers.get(GENERATION_ID_HEADER);
		const messageEvent = jsonSseEvents(await streamResult.response.text())[0]!;
		assert.match(streamGenerationId ?? '', /^gen-/);
		assert.equal((messageEvent.message as { id?: string }).id, 'msg_private_stream');
		assert.equal((await streamResult.usagePromise).upstreamMessageId, 'msg_private_stream');
	});

	it('keeps the Embeddings response id while exposing the gateway generation id separately', async () => {
		const result = await throughGenerationMiddleware(
			() => new Response(JSON.stringify({
				id: 'embd_private_json',
				object: 'list',
				model: 'private/provider-model',
				data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2] }],
				usage: { prompt_tokens: 2, total_tokens: 2 },
			}), { headers: { 'Content-Type': 'application/json' } }),
			(generationId) => dispatchOpenAiEmbeddingsRoute(
				route('openai', 'embeddings'),
				{ input: 'hi' },
				undefined,
				undefined,
				undefined,
				undefined,
				generationId,
			),
		);
		const generationId = result.response.headers.get(GENERATION_ID_HEADER);
		const body = await result.response.json() as { id?: string; model?: string };
		assert.match(generationId ?? '', /^gen-/);
		assert.equal(body.id, 'embd_private_json');
		assert.notEqual(body.id, generationId);
		assert.equal(body.model, 'public/model-a');
		assert.equal((await result.usagePromise).upstreamMessageId, 'embd_private_json');
	});
});
