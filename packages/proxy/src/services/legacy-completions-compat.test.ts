import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	adaptChatResponseToLegacyCompletion,
	adaptLegacyCompletionRequest,
	MAX_LEGACY_ECHO_TOTAL_BYTES,
	refreshLegacyCompletionEchoOptions,
} from './legacy-completions-compat';
import { parseSseEventData } from './egress/sse-data-line';

function sseResponse(chunks: string[], onCancel?: (reason: unknown) => void): Response {
	const encoder = new TextEncoder();
	let index = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[index++]!));
		},
		cancel(reason) {
			onCancel?.(reason);
		},
	}), { headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonEvents(wire: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const event of wire.split(/\r\n\r\n|\n\n|\r\r/u)) {
		const data = parseSseEventData(event)?.trim();
		if (!data || data === '[DONE]') continue;
		events.push(JSON.parse(data) as Record<string, unknown>);
	}
	return events;
}

describe('legacy Completions request compatibility', () => {
	it('maps a string prompt and supported sampling fields to one Chat request', () => {
		const result = adaptLegacyCompletionRequest({
			model: 'deepseek/deepseek-chat',
			prompt: 'Once upon a time',
			stream: true,
			n: 2,
			logprobs: 3,
			temperature: 0.2,
			echo: false,
			best_of: 1,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.chatBody.messages, [{ role: 'user', content: 'Once upon a time' }]);
		assert.equal(result.chatBody.logprobs, true);
		assert.equal(result.chatBody.top_logprobs, 3);
		assert.equal(result.chatBody.temperature, 0.2);
		assert.equal(Object.hasOwn(result.chatBody, 'prompt'), false);
		assert.equal(Object.hasOwn(result.chatBody, 'echo'), false);
		assert.equal(Object.hasOwn(result.chatBody, 'best_of'), false);
		assert.deepEqual(result.responseOptions, { logprobsRequested: true, echoPrompt: null });
	});

	it('uses an empty prompt for the legacy optional prompt default', () => {
		const result = adaptLegacyCompletionRequest({ model: 'model-a' });
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.chatBody.messages, [{ role: 'user', content: '' }]);
	});

	it('accepts bounded echo when prompt token logprobs are not requested', () => {
		const result = adaptLegacyCompletionRequest({
			model: 'model-a',
			prompt: 'Prompt: ',
			echo: true,
			n: 2,
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.responseOptions, {
			logprobsRequested: false,
			echoPrompt: 'Prompt: ',
		});
		assert.equal(Object.hasOwn(result.chatBody, 'echo'), false);
	});

	it('refreshes echo from post-Guardrail content and rechecks expansion bounds', () => {
		const options = { logprobsRequested: false, echoPrompt: 'raw secret' };
		const refreshed = refreshLegacyCompletionEchoOptions(options, {
			messages: [
				{ role: 'system', content: 'preset' },
				{ role: 'user', content: '[REDACTED:secret]' },
			],
			n: 2,
		});
		assert.deepEqual(refreshed, {
			ok: true,
			options: { logprobsRequested: false, echoPrompt: '[REDACTED:secret]' },
		});

		const expanded = refreshLegacyCompletionEchoOptions(options, {
			messages: [{ role: 'user', content: 'x'.repeat((MAX_LEGACY_ECHO_TOTAL_BYTES / 2) + 1) }],
			n: 2,
		});
		assert.equal(expanded.ok, false);
		assert.equal(
			refreshLegacyCompletionEchoOptions(options, { messages: [] }).ok,
			false,
		);
	});

	it('fails closed for semantics that cannot be represented losslessly', () => {
		for (const body of [
			{ model: 'm', prompt: ['a', 'b'] },
			{ model: 'm', prompt: [1, 2] },
			{ model: 'm', prompt: 'x', echo: 'true' },
			{ model: 'm', prompt: 'x', echo: true, logprobs: 1 },
			{ model: 'm', prompt: 'x'.repeat(MAX_LEGACY_ECHO_TOTAL_BYTES + 1), echo: true },
			{ model: 'm', prompt: 'x', suffix: 'tail' },
			{ model: 'm', prompt: 'x', best_of: 2 },
			{ model: 'm', prompt: 'x', tools: [] },
			{ model: 'm', prompt: 'x', messages: [] },
			{ model: 'm', prompt: 'x', logprobs: 6 },
			{ model: 'm', prompt: 'x', top_logprobs: 1 },
		]) {
			const result = adaptLegacyCompletionRequest(body);
			assert.equal(result.ok, false, JSON.stringify(body));
		}
	});
});

describe('legacy Completions response compatibility', () => {
	it('converts a bounded Chat JSON response including legacy logprobs', async () => {
		const source = new Response(JSON.stringify({
			id: 'gen-1',
			object: 'chat.completion',
			created: 123,
			model: 'public/model',
			provider: 'Provider',
			choices: [{
				index: 0,
				message: { role: 'assistant', content: '😀Hello' },
				finish_reason: 'stop',
				native_finish_reason: 'stop',
				logprobs: {
					content: [
						{ token: '😀Hel', logprob: -0.1, top_logprobs: [{ token: '😀Hel', logprob: -0.1 }] },
						{ token: 'lo', logprob: -0.2, top_logprobs: [{ token: 'lo', logprob: -0.2 }] },
					],
				},
			}],
			usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
		}), { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } });
		const response = await adaptChatResponseToLegacyCompletion(source, {
			logprobsRequested: true,
			echoPrompt: null,
			requestId: 'gen-1',
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.has('content-length'), false);
		const body = await response.json() as Record<string, unknown>;
		assert.equal(body.object, 'text_completion');
		assert.equal(body.id, 'gen-1');
		const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
		assert.equal(choice.text, '😀Hello');
		assert.equal(Object.hasOwn(choice, 'message'), false);
		assert.deepEqual(choice.logprobs, {
			tokens: ['😀Hel', 'lo'],
			token_logprobs: [-0.1, -0.2],
			top_logprobs: [{ '😀Hel': -0.1 }, { lo: -0.2 }],
			text_offset: [0, 4],
		});
	});

	it('echoes the exact prompt once for every non-streaming choice', async () => {
		const source = Response.json({
			id: 'gen-echo',
			object: 'chat.completion',
			created: 123,
			model: 'public/model',
			choices: [
				{ index: 0, message: { role: 'assistant', content: 'A' }, finish_reason: 'stop' },
				{ index: 1, message: { role: 'assistant', content: 'B' }, finish_reason: 'stop' },
			],
		});
		const response = await adaptChatResponseToLegacyCompletion(source, {
			logprobsRequested: false,
			echoPrompt: 'Prompt: ',
			requestId: 'gen-echo',
		});
		const body = await response.json() as { choices: Array<{ text: string; logprobs: unknown }> };
		assert.deepEqual(body.choices.map((choice) => choice.text), ['Prompt: A', 'Prompt: B']);
		assert.deepEqual(body.choices.map((choice) => choice.logprobs), [null, null]);
	});

	it('converts arbitrarily split Chat SSE events and keeps per-choice offsets', async () => {
		let settleAdaptation!: (failure: string | null) => void;
		const adaptationSettled = new Promise<string | null>((resolve) => {
			settleAdaptation = resolve;
		});
		const first = JSON.stringify({
			id: 'gen-stream', object: 'chat.completion.chunk', created: 1, model: 'public/model',
			choices: [{
				index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null,
				logprobs: { content: [{ token: 'Hel', logprob: -0.1, top_logprobs: [] }] },
			}],
		});
		const second = JSON.stringify({
			id: 'gen-stream', object: 'chat.completion.chunk', created: 1, model: 'public/model',
			choices: [{
				index: 0, delta: { content: 'lo' }, finish_reason: 'stop', native_finish_reason: 'stop',
				logprobs: { content: [{ token: 'lo', logprob: -0.2, top_logprobs: [] }] },
			}],
		});
		const wire = `data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`;
		const response = await adaptChatResponseToLegacyCompletion(
			sseResponse([wire.slice(0, 13), wire.slice(13, 71), wire.slice(71)]),
			{ logprobsRequested: true, echoPrompt: null, requestId: 'gen-stream', onSettled: settleAdaptation },
		);
		const output = await response.text();
		assert.match(output, /data: \[DONE\]/u);
		const events = jsonEvents(output);
		assert.equal(events.length, 2);
		assert.equal(events[0]!.object, 'text_completion');
		const firstChoice = (events[0]!.choices as Array<Record<string, unknown>>)[0]!;
		const secondChoice = (events[1]!.choices as Array<Record<string, unknown>>)[0]!;
		assert.equal(firstChoice.text, 'Hel');
		assert.equal(secondChoice.text, 'lo');
		assert.deepEqual((firstChoice.logprobs as Record<string, unknown>).text_offset, [0]);
		assert.deepEqual((secondChoice.logprobs as Record<string, unknown>).text_offset, [3]);
		assert.equal(await adaptationSettled, null);
	});

	it('echoes the prompt only on the first streamed chunk for each choice', async () => {
		const first = JSON.stringify({
			id: 'gen-echo-stream', object: 'chat.completion.chunk', created: 1, model: 'public/model',
			choices: [
				{ index: 0, delta: { role: 'assistant', content: 'A' }, finish_reason: null },
				{ index: 1, delta: { role: 'assistant', content: 'B' }, finish_reason: null },
			],
		});
		const second = JSON.stringify({
			id: 'gen-echo-stream', object: 'chat.completion.chunk', created: 1, model: 'public/model',
			choices: [
				{ index: 0, delta: { content: '1' }, finish_reason: 'stop' },
				{ index: 1, delta: { content: '2' }, finish_reason: 'stop' },
			],
		});
		const response = await adaptChatResponseToLegacyCompletion(
			sseResponse([`data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`]),
			{ logprobsRequested: false, echoPrompt: 'P:', requestId: 'gen-echo-stream' },
		);
		const events = jsonEvents(await response.text());
		const texts = events.map((event) =>
			(event.choices as Array<Record<string, unknown>>).map((choice) => choice.text),
		);
		assert.deepEqual(texts, [['P:A', 'P:B'], ['1', '2']]);
	});

	it('propagates downstream cancellation to the Chat stream', async () => {
		let cancelled = false;
		const first = `data: ${JSON.stringify({
			id: 'gen-cancel', object: 'chat.completion.chunk', created: 1, model: 'm',
			choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
		})}\n\n`;
		const response = await adaptChatResponseToLegacyCompletion(
			sseResponse([first, first], () => { cancelled = true; }),
			{ logprobsRequested: false, echoPrompt: null, requestId: 'gen-cancel' },
		);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel('client disconnected');
		assert.equal(cancelled, true);
	});

	it('caps a dense source burst and emits a legacy-shaped terminal failure', async () => {
		let settleAdaptation!: (failure: string | null) => void;
		const adaptationSettled = new Promise<string | null>((resolve) => {
			settleAdaptation = resolve;
		});
		const dense = `${Array.from({ length: 257 }, (_, index) => `: comment-${index}\n\n`).join('')}data: [DONE]\n\n`;
		const response = await adaptChatResponseToLegacyCompletion(
			sseResponse([dense]),
			{ logprobsRequested: false, echoPrompt: null, requestId: 'gen-limit', onSettled: settleAdaptation },
		);
		const output = await response.text();
		assert.doesNotMatch(output, /comment-0/u);
		const [failure] = jsonEvents(output);
		assert.equal(failure?.id, 'gen-limit');
		assert.equal(failure?.object, 'text_completion');
		assert.match(JSON.stringify(failure), /buffering limit/u);
		assert.equal(
			await adaptationSettled,
			'Legacy Completions stream exceeded the gateway buffering limit',
		);
	});
});
