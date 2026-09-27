import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { observeCompleteTextResponseV392, canonicalResponseObservationV392, responseObservationNonceV392,
	type CompleteTextResponseObservationInputV392 } from './complete-text-response-observation-v392';

const identity = { grantId: randomUUID(), holderRunId: randomUUID(), sendStartId: randomUUID(), expectedEpoch: 1 as const };
const usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12,
	prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } };
const json = JSON.stringify({ id: 'chatcmpl-local', model: 'model-local', object: 'chat.completion',
	choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage });
const chunk = (choices: unknown[], u: unknown = null) => JSON.stringify({ id: 'chatcmpl-local', model: 'model-local', object: 'chat.completion.chunk', choices, usage: u });
const sse = `data: ${chunk([{ index: 0, delta: { content: '你好' }, finish_reason: null }])}\r\n\r\n`
	+ `data: ${chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])}\r\n\r\n`
	+ `data: ${chunk([], usage)}\r\n\r\ndata: [DONE]\r\n\r\n`;
function source(text: string, type = 'application/json', chunkSize = 13) {
	const bytes = new TextEncoder().encode(text); let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
		if (offset === bytes.length) { controller.close(); return; }
		controller.enqueue(bytes.slice(offset, offset += Math.min(chunkSize, bytes.length - offset)));
	} }), { headers: { 'content-type': type, 'x-request-id': 'req-local' } });
}
function recorder(list: CompleteTextResponseObservationInputV392[]) {
	return async (input: CompleteTextResponseObservationInputV392) => {
		list.push(input);
		return { status: 'observation_recorded' as const, requestId: 'request-local', ...identity,
			evidenceNonce: input.evidenceNonce, factId: randomUUID(), observationId: randomUUID(),
			observationSha256: canonicalResponseObservationV392(input.observation).digest,
			commitAcknowledged: true as const, closeAcknowledged: true as const };
	};
}
test('JSON bytes pass unchanged with exact full raw hash, optional details and stable nonce', async () => {
	const list: CompleteTextResponseObservationInputV392[] = [];
	const observed = observeCompleteTextResponseV392(source(json), identity, recorder(list));
	assert.equal(list.length, 0); assert.equal(await observed.response.text(), json);
	await observed.completion;
	assert.equal(list.length, 1);
	assert.deepEqual(list[0]!.observation, { format: 'json', endMarker: 'json_eof',
		rawResponseSha256: createHash('sha256').update(json).digest('hex'), rawResponseBytes: Buffer.byteLength(json),
		providerRequestRef: 'chatcmpl-local', reportedModel: 'model-local', httpRequestId: 'req-local',
		inputTokens: 9, outputTokens: 3, totalTokens: 12, cacheReadTokens: 2, cacheWriteTokens: null, reasoningTokens: 1, audioInputTokens:null, imageInputTokens:null, textInputTokens:null, audioOutputTokens:null, textOutputTokens:null, acceptedPredictionTokens:null, rejectedPredictionTokens:null, serviceTier:null });
	assert.equal(list[0]!.evidenceNonce, responseObservationNonceV392(identity.grantId, identity.holderRunId, identity.sendStartId));
});
test('SSE split UTF8 and CRLF passes unchanged only after final usage DONE and EOF', async () => {
	const list: CompleteTextResponseObservationInputV392[] = [];
	const observed = observeCompleteTextResponseV392(source(sse, 'text/event-stream', 1), identity, recorder(list));
	assert.equal(await observed.response.text(), sse); await observed.completion;
	assert.equal(list[0]!.observation.endMarker, 'sse_done_eof');
	assert.equal(list[0]!.observation.rawResponseBytes, Buffer.byteLength(sse));
});
test('truncated missing duplicate conflicting usage and noncanonical token semantics never append', async () => {
	const invalid = [json.replace('"prompt_tokens":9', '"prompt_tokens":9,"prompt_tokens":10'),
		json.replace('"prompt_tokens":9', '"prompt_tokens":9,"prompt_\\u0074okens":9'),
		json.replace('"total_tokens":12', '"total_tokens":11'), json.slice(0, -1),
		json.replace('"cached_tokens":2', '"cached_tokens":20'), json.replace('"cached_tokens":2', '"cached_tokens":2,"unknown_tokens":1')];
	for (const text of invalid) {
		const list: CompleteTextResponseObservationInputV392[] = [];
		const result = observeCompleteTextResponseV392(source(text), identity, recorder(list));
		await assert.rejects(result.response.text()); await assert.rejects(result.completion); assert.equal(list.length, 0);
	}
	for (const text of [sse.replace('data: [DONE]\r\n\r\n', ''), sse.replace('data: [DONE]', `data: ${chunk([], usage)}\r\n\r\ndata: [DONE]`),
		sse + 'data: [DONE]\n\n', sse.replace('chatcmpl-local', 'chatcmpl-other')]) {
		const list: CompleteTextResponseObservationInputV392[] = [];
		const result = observeCompleteTextResponseV392(source(text, 'text/event-stream'), identity, recorder(list));
		await assert.rejects(result.response.text()); assert.equal(list.length, 0);
	}
});
test('EOF waits for append receipt; unknown ACK errors stream with no replay', async () => {
	let unblock!: () => void; const pending = new Promise<void>(resolve => { unblock = resolve; });
	let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
	let count = 0;
	const result = observeCompleteTextResponseV392(source(json), identity, async () => {
		count++; entered(); await pending; throw new Error('COMMIT acknowledgement unknown');
	});
	let ended = false; const consume = result.response.text().finally(() => { ended = true; });
	await started; assert.equal(ended, false); unblock(); await assert.rejects(consume, /unknown/u);
	await assert.rejects(result.completion, /unknown/u); assert.equal(count, 1);
});
test('cancel forwards once, releases source and never appends', async () => {
	let cancels = 0;
	const original = new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode(': keepalive\n\n')); },
		cancel() { cancels++; } }), { headers: { 'content-type': 'text/event-stream' } });
	const list: CompleteTextResponseObservationInputV392[] = [];
	const result = observeCompleteTextResponseV392(original, identity, recorder(list));
	const reader = result.response.body!.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock();
	assert.equal(cancels, 1); assert.equal(original.body!.locked, false); assert.equal(list.length, 0);
	await assert.rejects(result.completion, /cancelled/u);
});
test('bounds and fatal invalid UTF8 cancel source without observation', async () => {
	for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('x'.repeat(1_048_577))]) {
		let cancelled = 0; const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } });
		const list: CompleteTextResponseObservationInputV392[] = [];
		const result = observeCompleteTextResponseV392(response, identity, recorder(list));
		await assert.rejects(result.response.text()); assert.equal(cancelled, 1); assert.equal(list.length, 0);
	}
});
test('DONE is withheld until persisted and a DONE-driven cancellation sees an existing observation', async () => {
	const list: CompleteTextResponseObservationInputV392[] = [];
	const result = observeCompleteTextResponseV392(source(sse, 'text/event-stream', 1), identity, recorder(list));
	const reader = result.response.body!.getReader(); let text = '';
	while (!text.includes('[DONE]')) { const part = await reader.read(); assert.equal(part.done, false); text += new TextDecoder().decode(part.value); }
	assert.equal(list.length, 1); await result.completion; await reader.cancel(); reader.releaseLock();
	assert.equal(text, sse);
	let delivered = '';
	const lost = observeCompleteTextResponseV392(source(sse, 'text/event-stream'), identity, async () => { throw new Error('lost ACK'); });
	const failed = lost.response.body!.getReader();
	await assert.rejects(async () => { for (;;) { const part = await failed.read(); if (part.done) break; delivered += new TextDecoder().decode(part.value); } }, /lost ACK/u);
	assert.equal(delivered.includes('[DONE]'), false); failed.releaseLock();
});
test('standard detail counters and service tier persist, conflicting aliases and SSE tier drift reject', async () => {
	const standard = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12,
		prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 0, audio_tokens: 0, image_tokens: 0, text_tokens: 9 },
		completion_tokens_details: { reasoning_tokens: 1, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0, audio_tokens: 0, text_tokens: 3 } };
	const data = JSON.parse(json); data.usage = standard; data.service_tier = 'default';
	const list: CompleteTextResponseObservationInputV392[] = [];
	const observed = observeCompleteTextResponseV392(source(JSON.stringify(data)), identity, recorder(list));
	await observed.response.text(); assert.equal(list[0]!.observation.audioInputTokens, 0); assert.equal(list[0]!.observation.serviceTier, 'default');
	const stream = sse.replaceAll('"usage":null', '"service_tier":"default","usage":null').replace(JSON.stringify(usage), JSON.stringify(standard));
	const tierList: CompleteTextResponseObservationInputV392[] = [];
	const absent = observeCompleteTextResponseV392(source(stream, 'text/event-stream'), identity, recorder(tierList));
	await absent.response.text(); assert.equal(tierList[0]!.observation.serviceTier, 'default');
	const drift = observeCompleteTextResponseV392(source(stream.replace('"choices":[],"usage":', '"choices":[],"service_tier":"priority","usage":'), 'text/event-stream'), identity, recorder([]));
	await assert.rejects(drift.response.text());
	data.usage.prompt_tokens_details.cache_creation_tokens = 1;
	const conflict = observeCompleteTextResponseV392(source(JSON.stringify(data)), identity, recorder([])); await assert.rejects(conflict.response.text());
});
test('JSON uses one bounded byte buffer and delivers no byte before receipt', async () => {
	const large = JSON.parse(json); large.choices[0].message.content = 'x'.repeat(32_768);
	const bytes = JSON.stringify(large); let resume!: () => void, enter!: () => void;
	const pending = new Promise<void>(yes => { resume = yes; }), started = new Promise<void>(yes => { enter = yes; });
	const list: CompleteTextResponseObservationInputV392[] = [];
	const wrapped = observeCompleteTextResponseV392(source(bytes, 'application/json', 1), identity, async input => {
		enter(); await pending; return recorder(list)(input);
	});
	let delivered = false; const reader = wrapped.response.body!.getReader();
	const first = reader.read().then(part => { delivered = true; return part; });
	await started; assert.equal(delivered, false); resume(); const part = await first;
	assert.equal(new TextDecoder().decode(part.value), bytes); assert.equal((await reader.read()).done, true); reader.releaseLock();
});
test('counter number lexemes cannot underflow or round into integer facts; decimal metadata remains valid', async () => {
	for (const token of ['1e-9999', '-1e-9999', '0.99999999999999999']) {
		for (const format of ['json', 'sse']) {
			const total = token === '0.99999999999999999' ? 1 : 0;
			const raw = `{"prompt_tokens":${token},"completion_tokens":0,"total_tokens":${total}}`;
			const text = (format === 'json' ? json : sse).replace(JSON.stringify(usage), raw);
			const list: CompleteTextResponseObservationInputV392[] = [];
			const result = observeCompleteTextResponseV392(source(text, format === 'json' ? 'application/json' : 'text/event-stream'), identity, recorder(list));
			await assert.rejects(result.response.text()); assert.equal(list.length, 0);
		}
	}
	const metadata = json.replace('"index":0', '"logprobs":{"content":[{"logprob":-0.3333333}]},"index":0');
	const list: CompleteTextResponseObservationInputV392[] = [];
	const valid = observeCompleteTextResponseV392(source(metadata), identity, recorder(list));
	assert.equal(await valid.response.text(), metadata); assert.equal(list.length, 1);
	const scalarDelta = sse.replace('"delta":{"content":"你好"}', '"delta":0.5');
	const invalidDelta = observeCompleteTextResponseV392(source(scalarDelta, 'text/event-stream'), identity, recorder([]));
	await assert.rejects(invalidDelta.response.text());
});
