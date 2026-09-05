import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../model-router';
import {
	dispatchAnthropicRoute,
	MAX_ANTHROPIC_SSE_LINE_CHARS,
} from './anthropic-driver';
import {
	dispatchOpenAiRoute,
	MAX_OPENAI_SSE_LINE_CHARS,
} from './openai-driver';
import {
	dispatchOpenAiResponsesRoute,
	MAX_RESPONSES_SSE_LINE_CHARS,
} from './openai-responses-driver';
import {
	BoundedSseEventFramer,
	parseSseEventData,
	rewriteSseEventData,
} from './sse-data-line';

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

async function withMockResponse<T>(body: BodyInit, run: () => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(body, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	})) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function dataEvents(text: string): Array<Record<string, unknown>> {
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

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

describe('bounded EventSource framing', () => {
	it('folds multi-line data across CRLF read boundaries and preserves routing fields when rewritten', async () => {
		const events: string[] = [];
		const framer = new BoundedSseEventFramer(1024, 'test framing limit');
		await framer.push('event: response.created\r\nid: wire-1\r\ndata: {\r', (event) => {
			events.push(event);
			return false;
		});
		await framer.push('\ndata:"ok":true}\r\n\r', (event) => {
			events.push(event);
			return false;
		});
		await framer.push('\n', (event) => {
			events.push(event);
			return false;
		});
		assert.equal(framer.finish(), '');
		assert.equal(events.length, 1);
		assert.equal(parseSseEventData(events[0]!), '{\n"ok":true}');

		const rewritten = rewriteSseEventData(events[0]!, JSON.stringify({ ok: false }));
		assert.match(rewritten, /^event: response\.created\r\nid: wire-1\r\ndata: /);
		assert.equal((rewritten.match(/data:/g) ?? []).length, 1);
		assert.match(rewritten, /\r\n\r\n$/);
	});
});

describe('OpenRouter text stream terminal contracts', () => {
	it('normalizes the Chat usage frame to one content-free terminal choice before [DONE]', async () => {
		const first = {
			id: 'chatcmpl-private',
			object: 'chat.completion.chunk',
			model: 'private/provider-model',
			choices: [{
				index: 0,
				delta: {},
				finish_reason: 'stop',
				native_finish_reason: 'end_turn',
			}],
		};
		const usageFrame = {
			object: 'chat.completion.chunk',
			model: 'private/provider-model',
			choices: [],
			usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
		};
		await withMockResponse(
			`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(usageFrame)}\n\ndata: [DONE]\n\n`,
			async () => {
				const result = await dispatchOpenAiRoute(
					route('openai'),
					{ stream: true },
					undefined,
					undefined,
					undefined,
					undefined,
					'gen-request-1',
				);
				const text = await result.response.text();
				const events = dataEvents(text);
				const final = events.find((event) => event.usage != null)!;
				assert.equal(final.id, 'gen-request-1');
				assert.equal(final.model, 'public/model-a');
				assert.deepEqual(final.choices, [{
					index: 0,
					delta: { content: '', role: 'assistant' },
					finish_reason: 'stop',
					native_finish_reason: 'end_turn',
				}]);
				assert.ok(text.indexOf(JSON.stringify(final)) < text.indexOf('data: [DONE]'));
				const usage = await result.usagePromise;
				assert.equal(usage.total_tokens, 5);
				assert.equal(usage.finish_reason, 'stop');
				assert.equal(usage.native_finish_reason, 'end_turn');
				assert.equal(usage.stream_error, undefined);
			},
		);
	});

	it('folds multi-line Chat data fields across chunks without losing SSE routing fields or usage', async () => {
		const body = [
			': upstream-comment',
			'id: wire-chat',
			'data: {',
			'data: "id":"chatcmpl-multi",',
			'data: "model":"private/provider-model",',
			'data: "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],',
			'data: "usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}',
			'data: }',
			'',
			'data: [DONE]',
			'',
		].join('\r\n');
		await withMockResponse(chunkedStream([
			body.slice(0, 37),
			body.slice(37, 121),
			body.slice(121),
		]), async () => {
			const result = await dispatchOpenAiRoute(
				route('openai'),
				{ stream: true },
				undefined,
				undefined,
				undefined,
				undefined,
				'gen-multiline-chat',
			);
			const text = await result.response.text();
			const event = dataEvents(text)[0]!;
			assert.equal(event.id, 'gen-multiline-chat');
			assert.equal(event.model, 'public/model-a');
			assert.match(text, /: upstream-comment\r\nid: wire-chat\r\n/);
			assert.match(text, /data: \[DONE\]/);
			const usage = await result.usagePromise;
			assert.equal(usage.total_tokens, 5);
			assert.equal(usage.upstreamMessageId, 'chatcmpl-multi');
			assert.equal(usage.stream_error, undefined);
		});
	});

	it('turns Chat native errors and abnormal EOF into one associated terminal error', async () => {
		for (const body of [
			`data: ${JSON.stringify({ id: 'chatcmpl-private', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
			`data: ${JSON.stringify({ id: 'chatcmpl-private', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ error: { message: 'Authorization: Bearer must-not-leak' } })}\n\n`,
		]) {
			await withMockResponse(body, async () => {
				const result = await dispatchOpenAiRoute(
					route('openai'),
					{ stream: true },
					undefined,
					undefined,
					undefined,
					undefined,
					'gen-request-error',
				);
				const text = await result.response.text();
				const terminal = dataEvents(text).at(-1)!;
				assert.equal(terminal.id, 'gen-request-error');
				assert.equal((terminal.error as { metadata: { error_type: string } }).metadata.error_type, 'provider_unavailable');
				assert.equal(((terminal.choices as Array<{ finish_reason: string }>)[0]!).finish_reason, 'error');
				assert.doesNotMatch(text, /must-not-leak/);
				const streamError = (await result.usagePromise).stream_error ?? '';
				assert.match(streamError, /stream|authorization/i);
				assert.doesNotMatch(streamError, /must-not-leak/);
			});
		}
	});

	it('does not treat bare Responses [DONE] as success and reuses the response id', async () => {
		const created = { type: 'response.created', response: { id: 'resp-current', status: 'in_progress' } };
		await withMockResponse(
			`event: response.created\ndata: ${JSON.stringify(created)}\n\ndata: [DONE]\n\n`,
			async () => {
				const result = await dispatchOpenAiResponsesRoute(
					route('openai'),
					{ stream: true },
					undefined,
					undefined,
					undefined,
					undefined,
					'gen-request-responses',
				);
				const text = await result.response.text();
				const failed = dataEvents(text).find((event) => event.type === 'response.failed')!;
				assert.equal((failed.response as { id: string }).id, 'resp-current');
				assert.ok(text.indexOf('event: response.failed') < text.indexOf('data: [DONE]'));
				assert.match((await result.usagePromise).stream_error ?? '', /terminal event/i);
			},
		);
	});

	it('recognizes response.error as a failed terminal event without minting another response id', async () => {
		const body = [
			`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-current' } })}`,
			'',
			`event: response.error\ndata: ${JSON.stringify({
				type: 'response.error',
				error: { code: 'rate_limit_exceeded', message: 'rate limited' },
			})}`,
			'',
		].join('\n');
		await withMockResponse(body, async () => {
			const result = await dispatchOpenAiResponsesRoute(route('openai'), { stream: true });
			const text = await result.response.text();
			assert.match(text, /"type":"response\.error"/);
			assert.doesNotMatch(text, /"type":"response\.failed"/);
			assert.match((await result.usagePromise).stream_error ?? '', /rate limited/i);
		});
	});

	it('folds multi-line Responses events and preserves event/id fields through model normalization', async () => {
		const body = [
			'event: response.created',
			'id: wire-response',
			'data: {',
			'data: "type":"response.created",',
			'data: "response":{"id":"resp-multi","model":"private/provider-model","status":"in_progress"}',
			'data: }',
			'',
			'event: response.completed',
			'data: {',
			'data: "type":"response.completed",',
			'data: "response":{"id":"resp-multi","model":"private/provider-model","usage":{"input_tokens":4,"output_tokens":6,"total_tokens":10}}',
			'data: }',
			'',
			'data: [DONE]',
			'',
		].join('\r\n');
		await withMockResponse(chunkedStream([
			body.slice(0, 29),
			body.slice(29, 187),
			body.slice(187),
		]), async () => {
			const result = await dispatchOpenAiResponsesRoute(route('openai'), { stream: true });
			const text = await result.response.text();
			const events = dataEvents(text);
			assert.equal(events.length, 2);
			assert.equal((events[0]!.response as { id: string }).id, 'resp-multi');
			assert.equal((events[0]!.response as { model: string }).model, 'public/model-a');
			assert.equal((events[1]!.response as { model: string }).model, 'public/model-a');
			assert.match(text, /^event: response\.created\r\nid: wire-response\r\n/);
			assert.doesNotMatch(text, /response\.failed/);
			const usage = await result.usagePromise;
			assert.equal(usage.total_tokens, 10);
			assert.equal(usage.upstreamMessageId, 'resp-multi');
			assert.equal(usage.stream_error, undefined);
		});
	});

	it('requires Anthropic message_stop and associates a synthesized error with message_start', async () => {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: 'message_start',
				message: { id: 'msg-current', model: 'private/provider-model', usage: { input_tokens: 2 } },
			})}`,
			'',
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'hi' },
			})}`,
			'',
		].join('\n');
		await withMockResponse(body, async () => {
			const result = await dispatchAnthropicRoute(
				route('anthropic'),
				{ stream: true },
				undefined,
				undefined,
				undefined,
				undefined,
				'gen-request-messages',
			);
			const text = await result.response.text();
			const error = dataEvents(text).at(-1)!;
			assert.equal(error.type, 'error');
			assert.equal(error.request_id, 'msg-current');
			assert.equal((error.error as { error_type: string }).error_type, 'provider_unavailable');
			assert.match((await result.usagePromise).stream_error ?? '', /message_stop/i);
		});
	});

	it('captures Anthropic message_delta termination metadata before message_stop', async () => {
		const body = [
			`data: ${JSON.stringify({
				type: 'message_start',
				message: { id: 'msg-finish', usage: { input_tokens: 2, output_tokens: 0 } },
			})}`,
			'',
			`data: ${JSON.stringify({
				type: 'message_delta',
				delta: { stop_reason: 'tool_use', stop_sequence: null },
				usage: { input_tokens: 2, output_tokens: 3 },
			})}`,
			'',
			`data: ${JSON.stringify({ type: 'message_stop' })}`,
			'',
		].join('\n');
		await withMockResponse(body, async () => {
			const result = await dispatchAnthropicRoute(route('anthropic'), { stream: true });
			await result.response.text();
			const usage = await result.usagePromise;
			assert.equal(usage.finish_reason, 'tool_calls');
			assert.equal(usage.native_finish_reason, 'tool_use');
			assert.equal(usage.stream_error, undefined);
		});
	});

	it('marks native Anthropic type:error failed and adds canonical error_type', async () => {
		const body = [
			`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-current' } })}`,
			'',
			'event: error',
			`data: ${JSON.stringify({
				type: 'error',
				error: { type: 'overloaded_error', message: 'capacity exhausted' },
			})}`,
			'',
		].join('\n');
		await withMockResponse(body, async () => {
			const result = await dispatchAnthropicRoute(route('anthropic'), { stream: true });
			const text = await result.response.text();
			const error = dataEvents(text).at(-1)!;
			assert.equal(error.request_id, 'msg-current');
			assert.equal((error.error as { error_type: string }).error_type, 'provider_overloaded');
			assert.match((await result.usagePromise).stream_error ?? '', /capacity exhausted/i);
		});
	});

	it('folds multi-line Anthropic events and reaches message_stop without a synthetic error', async () => {
		const body = [
			'event: message_start',
			'id: wire-message',
			'data: {',
			'data: "type":"message_start",',
			'data: "message":{"id":"msg-multi","model":"private/provider-model","usage":{"input_tokens":2}}',
			'data: }',
			'',
			'event: message_stop',
			'data: {',
			'data: "type":"message_stop"',
			'data: }',
			'',
		].join('\r\n');
		await withMockResponse(chunkedStream([
			body.slice(0, 35),
			body.slice(35, 153),
			body.slice(153),
		]), async () => {
			const result = await dispatchAnthropicRoute(route('anthropic'), { stream: true });
			const text = await result.response.text();
			const events = dataEvents(text);
			assert.equal(events.length, 2);
			assert.equal((events[0]!.message as { id: string }).id, 'msg-multi');
			assert.equal((events[0]!.message as { model: string }).model, 'public/model-a');
			assert.equal(events[1]!.type, 'message_stop');
			assert.match(text, /^event: message_start\r\nid: wire-message\r\n/);
			assert.doesNotMatch(text, /provider_unavailable/);
			const usage = await result.usagePromise;
			assert.equal(usage.input_tokens, 2);
			assert.equal(usage.upstreamMessageId, 'msg-multi');
			assert.equal(usage.stream_error, undefined);
		});
	});

	it('fails boundedly instead of retaining an unbounded unterminated SSE line', async () => {
		const cases = [
			{
				max: MAX_OPENAI_SSE_LINE_CHARS,
				dispatch: () => dispatchOpenAiRoute(route('openai'), { stream: true }),
			},
			{
				max: MAX_RESPONSES_SSE_LINE_CHARS,
				dispatch: () => dispatchOpenAiResponsesRoute(route('openai'), { stream: true }),
			},
			{
				max: MAX_ANTHROPIC_SSE_LINE_CHARS,
				dispatch: () => dispatchAnthropicRoute(route('anthropic'), { stream: true }),
			},
		];
		for (const testCase of cases) {
			let cancelled = 0;
			let sent = false;
			const oversized = new TextEncoder().encode(`data: "${'x'.repeat(testCase.max + 1)}`);
			const upstream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent) return;
					sent = true;
					controller.enqueue(oversized);
				},
				cancel() {
					cancelled += 1;
				},
			});
			await withMockResponse(upstream, async () => {
				const result = await testCase.dispatch();
				const text = await result.response.text();
				assert.match(text, /provider_unavailable/);
				assert.match((await result.usagePromise).stream_error ?? '', /framing limit/i);
				assert.equal(cancelled, 1);
			});
		}
	});
});
