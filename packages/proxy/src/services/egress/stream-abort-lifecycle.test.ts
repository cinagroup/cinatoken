import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../model-router';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchOpenAiRoute } from './openai-driver';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver';
import {
	dispatchGeminiRoute,
	GEMINI_POST_DISCONNECT_DRAIN_MS,
	GEMINI_SSE_MAX_LINE_CHARS,
} from './gemini-driver';

type StreamDispatchResult = {
	response: Response;
	usagePromise: Promise<{ cancelled?: boolean; stream_error?: string; total_tokens: number }>;
};

function route(protocol: 'openai' | 'anthropic' | 'gemini'): RouteResult {
	return {
		targetId: 'target-a',
		modelSurfaceId: 'surface-a',
		routePoolId: 'pool-a',
		providerId: 'provider-a',
		providerName: 'Provider A',
		providerModelName: protocol === 'gemini' ? 'gemini-2.5-flash' : 'private/provider-model',
		gatewayModelId: 'public/model-a',
		upstreamProtocol: protocol,
		upstreamOperation: protocol === 'anthropic' ? 'messages' : protocol === 'gemini' ? 'models.generate' : 'chat',
		adapter: 'passthrough',
		providerEndpoints: protocol === 'gemini'
			? { gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/models' } }
			: { [protocol]: { base: 'https://provider.test/v1' } },
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

async function withMockFetch<T>(
	response: (input: RequestInfo | URL, init?: RequestInit) => Response,
	run: () => Promise<T>,
): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => response(input, init)) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error('usage promise did not settle')), timeoutMs);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function assertPreAbortedSignalSettles(
	responseBody: string,
	dispatch: (signal: AbortSignal) => Promise<StreamDispatchResult>,
	expectedTotalTokens: number,
): Promise<void> {
	await withMockFetch(
		() => new Response(responseBody, { headers: { 'Content-Type': 'text/event-stream' } }),
		async () => {
			const controller = new AbortController();
			controller.abort();
			const result = await dispatch(controller.signal);
			const usage = await within(result.usagePromise);
			assert.equal(usage.cancelled, true);
			assert.equal(usage.total_tokens, expectedTotalTokens);
			await result.response.body?.cancel();
		},
	);
}

describe('stream driver client-abort lifecycle', () => {
	it('cancels a Gemini stream whose unterminated SSE line exceeds the parser ceiling', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(GEMINI_SSE_MAX_LINE_CHARS + 1)}`));
			},
			cancel() { cancelled = true; },
		});
		await withMockFetch(
			() => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
			async () => {
				const result = await dispatchGeminiRoute(route('gemini'), {}, 'streamGenerateContent', '');
				await result.response.text();
				const usage = await within(result.usagePromise);
				assert.match(usage.stream_error ?? '', /SSE line exceeds/i);
				assert.equal(cancelled, true);
			},
		);
	});

	it('keeps the legacy unsupported-provider Gemini drain within the Workers grace window', () => {
		assert.ok(GEMINI_POST_DISCONNECT_DRAIN_MS > 0);
		assert.ok(GEMINI_POST_DISCONNECT_DRAIN_MS <= 25_000);
	});

	it('passes the client signal to fetch and immediately cancels silent text upstreams', async () => {
		const cases: Array<{
			dispatch: (signal: AbortSignal) => Promise<StreamDispatchResult>;
		}> = [
			{
				dispatch: (signal) => dispatchOpenAiRoute(route('openai'), { stream: true }, signal),
			},
			{
				dispatch: (signal) => dispatchAnthropicRoute(route('anthropic'), { stream: true }, signal),
			},
			{
				dispatch: (signal) => dispatchOpenAiResponsesRoute(route('openai'), { stream: true }, signal),
			},
		];

		for (const testCase of cases) {
			let upstreamCancelled = false;
			let fetchSignal: AbortSignal | null = null;
			const upstream = new ReadableStream<Uint8Array>({
				cancel() {
					upstreamCancelled = true;
				},
			});
			await withMockFetch(
				(_input, init) => {
					fetchSignal = init?.signal ?? null;
					return new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } });
				},
				async () => {
					const controller = new AbortController();
					const result = await testCase.dispatch(controller.signal);
					assert.equal(fetchSignal, controller.signal);
					controller.abort('client disconnected');
					const usage = await within(result.usagePromise);
					assert.equal(usage.cancelled, true);
					assert.equal(upstreamCancelled, true);
					await result.response.body?.cancel();
				},
			);
		}
	});

	it('handles an already-aborted signal before pumping OpenAI Chat SSE', async () => {
		await assertPreAbortedSignalSettles(
			`data: ${JSON.stringify({
				id: 'chatcmpl-aborted',
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
			})}\n\n`,
			(signal) => dispatchOpenAiRoute(route('openai'), { stream: true }, signal),
			0,
		);
	});

	it('handles an already-aborted signal before pumping Anthropic Messages SSE', async () => {
		await assertPreAbortedSignalSettles(
			`data: ${JSON.stringify({
				type: 'message_delta',
				usage: { input_tokens: 2, output_tokens: 3 },
			})}\n\n`,
			(signal) => dispatchAnthropicRoute(route('anthropic'), { stream: true }, signal),
			0,
		);
	});

	it('handles an already-aborted signal before pumping OpenAI Responses SSE', async () => {
		await assertPreAbortedSignalSettles(
			`data: ${JSON.stringify({
				type: 'response.completed',
				response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
			})}\n\n`,
			(signal) => dispatchOpenAiResponsesRoute(route('openai'), { stream: true }, signal),
			0,
		);
	});

	it('handles an already-aborted signal before pumping Gemini SSE', async () => {
		await assertPreAbortedSignalSettles(
			`data:${JSON.stringify({
				responseId: 'gemini-aborted',
				usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
			})}\n\n`,
			(signal) => dispatchGeminiRoute(
				route('gemini'),
				{},
				'streamGenerateContent',
				'',
				signal,
			),
			5,
		);
	});

	it('marks 2xx upstream stream failures unknown through stream_error metadata', async () => {
		const cases: Array<{
			kind: 'chat' | 'responses' | 'anthropic' | 'gemini';
			dispatch: () => Promise<StreamDispatchResult>;
		}> = [
			{ kind: 'chat', dispatch: () => dispatchOpenAiRoute(route('openai'), { stream: true }) },
			{ kind: 'responses', dispatch: () => dispatchOpenAiResponsesRoute(route('openai'), { stream: true }) },
			{ kind: 'anthropic', dispatch: () => dispatchAnthropicRoute(route('anthropic'), { stream: true }) },
			{ kind: 'gemini', dispatch: () => dispatchGeminiRoute(route('gemini'), {}, 'streamGenerateContent', '') },
		];

		for (const testCase of cases) {
			await withMockFetch(
				() => new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new Error('upstream stream interrupted'));
						},
					}),
					{ status: 200, headers: { 'Content-Type': 'text/event-stream' } },
				),
				async () => {
					const result = await testCase.dispatch();
					const publicBody = await result.response.text();
					const usage = await within(result.usagePromise);
					assert.match(usage.stream_error ?? '', /upstream stream interrupted/i);
					if (testCase.kind === 'chat') {
						assert.match(publicBody, /"object":"chat\.completion\.chunk"/);
						assert.match(publicBody, /"finish_reason":"error"/);
						assert.match(publicBody, /"error_type":"provider_unavailable"/);
						assert.doesNotMatch(publicBody, /upstream stream interrupted/i);
					}
					if (testCase.kind === 'responses') {
						assert.match(publicBody, /event: response\.failed/);
						assert.match(publicBody, /"status":"failed"/);
						assert.match(publicBody, /"error_type":"provider_unavailable"/);
					}
					if (testCase.kind === 'anthropic') {
						assert.match(publicBody, /event: error/);
						assert.match(publicBody, /"type":"api_error"/);
						assert.match(publicBody, /"error_type":"provider_unavailable"/);
					}
				},
			);
		}
	});

	it('marks malformed 2xx protocol events unknown even after a usage snapshot', async () => {
		const cases: Array<{
			body: string;
			dispatch: () => Promise<StreamDispatchResult>;
		}> = [
			{
				body: `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 1 } })}\n\ndata: {broken\n\n`,
				dispatch: () => dispatchOpenAiRoute(route('openai'), { stream: true }),
			},
			{
				body: `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } })}\n\ndata: {broken\n\n`,
				dispatch: () => dispatchAnthropicRoute(route('anthropic'), { stream: true }),
			},
			{
				body: `data: ${JSON.stringify({
					type: 'response.completed',
					response: { usage: { output_tokens: 1, total_tokens: 1 } },
				})}\n\ndata: {broken\n\n`,
				dispatch: () => dispatchOpenAiResponsesRoute(route('openai'), { stream: true }),
			},
			{
				body: `data: ${JSON.stringify({
					usageMetadata: { candidatesTokenCount: 1, totalTokenCount: 1 },
				})}\n\ndata: {broken\n\n`,
				dispatch: () => dispatchGeminiRoute(route('gemini'), {}, 'streamGenerateContent', ''),
			},
		];

		for (const testCase of cases) {
			await withMockFetch(
				() => new Response(testCase.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
				async () => {
					const result = await testCase.dispatch();
					await result.response.text();
					const usage = await within(result.usagePromise);
					assert.equal(usage.total_tokens, 1);
					assert.match(usage.stream_error ?? '', /malformed/i);
				},
			);
		}
	});
});
