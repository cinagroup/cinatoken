import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { failoverDispatch } from '../failover-dispatch';
import {
	countValidImageResults,
	dispatchOpenAiImageEdits,
	dispatchOpenAiImageGenerations,
	normalizeOpenRouterImageResponse,
	normalizeImageCommonParams,
	redactImageRequestForLog,
	validateImageUpload,
	IMAGE_GENERATION_TIMEOUT_MS,
	IMAGE_MAX_PROMPT_CHARS,
	IMAGE_MAX_SSE_EVENT_BYTES,
} from './openai-images-driver';

const CANARY_SECRET = 'CANARY_SECRET';

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'target-image', modelSurfaceId: 'surface-image', routePoolId: 'pool-image',
		providerId: 'openai', providerName: 'OpenAI', providerModelName: 'gpt-image-1',
		upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
		providerApiKey: 'sk-test', priceOverrideRaw: null, routeMeteredProfileJson: null,
		routeChargedProfileJson: null, customParams: null, routeGroup: 'default',
		routePriority: 1, routeWeight: 1,
		...overrides,
	};
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ value: T; output: string }> {
	const originalLog = console.log;
	const originalError = console.error;
	const entries: string[] = [];
	console.log = (...data: unknown[]) => { entries.push(data.map(String).join(' ')); };
	console.error = (...data: unknown[]) => { entries.push(data.map(String).join(' ')); };
	try {
		return { value: await run(), output: entries.join('\n') };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

describe('IMAGE_GENERATION_TIMEOUT_MS', () => {
	it('allows ~5 minutes for high-quality / large upstream generations', () => {
		assert.equal(IMAGE_GENERATION_TIMEOUT_MS, 300_000);
	});
});

describe('normalizeImageCommonParams', () => {
	it('requires prompt and accepts the OpenRouter n range 1..10', () => {
		assert.equal(normalizeImageCommonParams({ prompt: '' }).ok, false);
		assert.equal(normalizeImageCommonParams({ prompt: 'hi', n: 0 }).ok, false);
		assert.equal(normalizeImageCommonParams({ prompt: 'hi', n: 11 }).ok, false);
		assert.equal(normalizeImageCommonParams({ prompt: 'hi', n: 1.5 }).ok, false);
		const ok = normalizeImageCommonParams({
			prompt: ' a cat ',
			n: 10,
			size: 'auto',
			quality: 'medium',
		});
		assert.equal(ok.ok, true);
		if (ok.ok) {
			assert.equal(ok.prompt, 'a cat');
			assert.equal(ok.n, 10);
			assert.equal(ok.size, 'auto');
			assert.equal(ok.quality, 'medium');
		}
	});

	it('accepts numeric string n from multipart', () => {
		const ok = normalizeImageCommonParams({ prompt: 'hi', n: '4' });
		assert.equal(ok.ok, true);
		if (ok.ok) assert.equal(ok.n, 4);
		assert.equal(normalizeImageCommonParams({ prompt: 'hi', n: '11' }).ok, false);
	});

	it('rejects oversized prompt', () => {
		const r = normalizeImageCommonParams({ prompt: 'x'.repeat(IMAGE_MAX_PROMPT_CHARS + 1) });
		assert.equal(r.ok, false);
	});
});

describe('OpenRouter image response normalization', () => {
	it('adds identifiable media_type and exposes only evidenced usage/cost values', () => {
		const body = normalizeOpenRouterImageResponse({
			created: 1,
			data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }],
			usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10, cost: 0.04 },
		}) as Record<string, unknown>;
		const data = body.data as Array<Record<string, unknown>>;
		const usage = body.usage as Record<string, unknown>;
		assert.equal(data[0]?.media_type, 'image/png');
		assert.equal(usage.prompt_tokens, 3);
		assert.equal(usage.completion_tokens, 7);
		assert.equal(usage.total_tokens, 10);
		assert.equal(usage.cost, 0.04);
	});

	it('does not manufacture an unknown media type or invalid cost', () => {
		const body = normalizeOpenRouterImageResponse({
			data: [{ b64_json: 'not-an-identifiable-image' }],
			usage: { prompt_tokens: 1, completion_tokens: 2, cost: 'unknown' },
		}) as Record<string, unknown>;
		const data = body.data as Array<Record<string, unknown>>;
		const usage = body.usage as Record<string, unknown>;
		assert.equal('media_type' in data[0]!, false);
		assert.equal('cost' in usage, false);
		assert.equal(usage.total_tokens, 3);
	});
});

describe('OpenRouter native image SSE', () => {
	it('fails closed when a successful stream request is not an event stream', async () => {
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
			{ fetchImpl: async () => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }) },
		);
		assert.equal(result.response.status, 502);
		assert.equal(result.meta.failoverForbidden, true);
		assert.match(await result.response.text(), /did not return an image generation event stream/);
	});

	it('forwards partial images incrementally and settles only after completed + [DONE]', async () => {
		const encoder = new TextEncoder();
		let sourceController!: ReadableStreamDefaultController<Uint8Array>;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				sourceController = controller;
				controller.enqueue(encoder.encode(
					'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}\n\n',
				));
			},
		});
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
			{ fetchImpl: async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }) },
		);
		assert.match(result.response.headers.get('content-type') ?? '', /text\/event-stream/);
		const reader = result.response.body!.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		assert.match(new TextDecoder().decode(first.value), /image_generation\.partial_image/);

		sourceController.enqueue(encoder.encode(
			'data: {"type":"image_generation.completed","b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB","created":1,"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":10,"cost":0.04}}\n\n'
			+ 'data: [DONE]\n\n',
		));
		sourceController.close();
		let rest = '';
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			rest += new TextDecoder().decode(next.value);
		}
		assert.match(rest, /image_generation\.completed/);
		assert.match(rest, /"media_type":"image\/png"/);
		assert.match(rest, /data: \[DONE\]/);
		const settlement = await result.meta.imageStreamSettlement!;
		assert.equal(settlement.completed, true);
		assert.equal(settlement.validImages, 1);
		assert.equal(settlement.imageUsage?.total_tokens, 10);
		const usage = await result.usagePromise;
		assert.equal(usage.input_tokens, 3);
		assert.equal(usage.output_tokens, 7);
	});

	it('accepts provider shortfall and settles by the observed image count', async () => {
		const body =
			'data: {"type":"image_generation.completed","b64_json":"iVBORw0KGgo="}\n\n'
			+ 'data: [DONE]\n\n';
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 3, stream: true }, undefined, null, undefined,
			{ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) },
		);
		await result.response.text();
		const settlement = await result.meta.imageStreamSettlement!;
		assert.equal(settlement.completed, true);
		assert.equal(settlement.validImages, 1);
	});

	it('aborts and cancels upstream immediately when the downstream reader cancels', async () => {
		let upstreamSignal: AbortSignal | null = null;
		let upstreamCancelled = false;
		const source = new ReadableStream<Uint8Array>({
			cancel() { upstreamCancelled = true; },
		});
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
			{
				fetchImpl: async (_input, init) => {
					upstreamSignal = init?.signal as AbortSignal;
					return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
				},
			},
		);
		await result.response.body!.cancel('client_cancelled');
		const settlement = await result.meta.imageStreamSettlement!;
		assert.equal(upstreamSignal?.aborted, true);
		assert.equal(upstreamCancelled, true);
		assert.equal(settlement.cancelled, true);
		assert.equal(settlement.completed, false);
	});

	it('does not settle as billable when the client cancels queued terminal output', async () => {
		const body =
			'data: {"type":"image_generation.completed","b64_json":"iVBORw0KGgo="}\n\n'
			+ 'data: [DONE]\n\n';
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
			{ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) },
		);
		await result.response.body!.cancel('client_cancelled_before_delivery');
		const settlement = await result.meta.imageStreamSettlement!;
		assert.equal(settlement.cancelled, true);
		assert.equal(settlement.completed, false);
		assert.equal(settlement.validImages, 0);
	});

	it('turns early EOF and missing authoritative token usage into terminal error events', async () => {
		for (const body of [
			'data: {"type":"image_generation.completed","b64_json":"iVBORw0KGgo="}\n\n',
			'data: {"type":"image_generation.completed","b64_json":"iVBORw0KGgo="}\n\ndata: [DONE]\n\n',
		]) {
			const result = await dispatchOpenAiImageGenerations(
				route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
				{
					requireAuthoritativeUsage: true,
					fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
				},
			);
			const text = await result.response.text();
			assert.match(text, /"type":"error"/);
			assert.match(text, /data: \[DONE\]/);
			const settlement = await result.meta.imageStreamSettlement!;
			assert.equal(settlement.completed, false);
			assert.equal(settlement.validImages, 0);
		}
	});

	it('rejects an oversized SSE event before parsing or forwarding its payload', async () => {
		const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
		let chunks = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks++ <= Math.ceil(IMAGE_MAX_SSE_EVENT_BYTES / chunk.byteLength)) {
					controller.enqueue(chunk);
				} else {
					controller.close();
				}
			},
		});
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
			{ fetchImpl: async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }) },
		);
		const text = await result.response.text();
		assert.match(text, /event exceeded the gateway size limit/);
		assert.match(text, /data: \[DONE\]/);
		assert.equal(text.includes('x'.repeat(128)), false);
		const settlement = await result.meta.imageStreamSettlement!;
		assert.equal(settlement.completed, false);
		assert.equal(settlement.validImages, 0);
	});

	it('redacts credential-shaped fragments in upstream SSE errors', async () => {
		const secret = 'sk-1234567890abcdef';
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1, stream: true }, undefined, null, undefined,
			{ fetchImpl: async () => new Response(
				`data: {"type":"error","error":{"message":"provider key ${secret}","code":"server_error"}}\n\n`,
				{ headers: { 'content-type': 'text/event-stream' } },
			) },
		);
		const text = await result.response.text();
		assert.equal(text.includes(secret), false);
		assert.match(text, /\[redacted\]/);
	});
});

describe('authoritative image usage', () => {
	it('fails closed instead of guessing token usage for a non-stream response', async () => {
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1 }, undefined, null, undefined,
			{
				requireAuthoritativeUsage: true,
				fetchImpl: async () => Response.json({
					created: 1,
					data: [{ b64_json: 'iVBORw0KGgo=' }],
				}),
			},
		);
		assert.equal(result.response.status, 502);
		assert.equal(result.meta.failoverForbidden, true);
		assert.match(await result.response.text(), /without authoritative usage/);
	});
});

describe('validateImageUpload / countValidImageResults', () => {
	it('validates mime and size', () => {
		assert.equal(
			validateImageUpload({ filename: 'a.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }),
			null
		);
		assert.match(
			validateImageUpload({
				filename: 'a.gif',
				mimeType: 'image/gif',
				bytes: new Uint8Array([1]),
			}) ?? '',
			/mime/
		);
		assert.match(
			validateImageUpload({ filename: 'a.png', mimeType: 'image/png', bytes: new Uint8Array() }) ?? '',
			/empty/
		);
	});

	it('counts b64_json and url entries', () => {
		assert.equal(countValidImageResults({ data: [{ b64_json: 'abc' }, { url: 'https://x' }] }), 2);
		assert.equal(countValidImageResults({ data: [{ b64_json: '' }, {}] }), 0);
		assert.equal(countValidImageResults(null), 0);
	});
});

describe('redactImageRequestForLog', () => {
	it('never includes prompt text or b64', () => {
		const out = redactImageRequestForLog({
			operation: 'generations',
			model: 'gpt-image-2',
			prompt: 'secret prompt about a novel cover',
			n: 1,
			quality: 'auto',
		});
		const s = JSON.stringify(out);
		assert.equal(s.includes('secret prompt'), false);
		assert.equal(out.prompt_chars, 'secret prompt about a novel cover'.length);
		assert.deepEqual(out._redacted, ['prompt', 'image', 'images', 'b64_json']);
	});
});

describe('OpenAI image outcome certainty', () => {
	it('stops a pre-cancelled generation before the budget boundary and fetch', async () => {
		const controller = new AbortController();
		controller.abort();
		let boundaryCalls = 0;
		let fetchCalls = 0;
		const result = await dispatchOpenAiImageGenerations(
			route(),
			{ prompt: 'cat', n: 1 },
			controller.signal,
			null,
			undefined,
			{
				fetchImpl: async () => {
					fetchCalls += 1;
					return Response.json({ data: [{ b64_json: 'must-not-run' }] });
				},
			},
			async () => { boundaryCalls += 1; },
		);
		assert.equal(boundaryCalls, 0);
		assert.equal(fetchCalls, 0);
		assert.equal(result.response.status, 499);
		assert.equal(result.meta.imageAbortReason, 'client_abort');
		assert.equal(result.meta.failoverForbidden, true);
		assert.equal(result.meta.upstreamOutcomeUnknown, undefined);
		assert.match(await result.response.text(), /"abort_reason":"client_abort"/);
	});

	it('stops a pre-cancelled edit before the budget boundary and fetch', async () => {
		const controller = new AbortController();
		controller.abort();
		let boundaryCalls = 0;
		let fetchCalls = 0;
		const result = await dispatchOpenAiImageEdits(
			route({ upstreamOperation: 'images.edits' }),
			{
				prompt: 'cat',
				n: 1,
				images: [{
					filename: 'cat.png',
					mimeType: 'image/png',
					bytes: new Uint8Array([1, 2, 3]),
				}],
			},
			controller.signal,
			null,
			undefined,
			{
				fetchImpl: async () => {
					fetchCalls += 1;
					return Response.json({ data: [{ b64_json: 'must-not-run' }] });
				},
			},
			async () => { boundaryCalls += 1; },
		);
		assert.equal(boundaryCalls, 0);
		assert.equal(fetchCalls, 0);
		assert.equal(result.response.status, 499);
		assert.equal(result.meta.imageAbortReason, 'client_abort');
		assert.equal(result.meta.failoverForbidden, true);
		assert.equal(result.meta.upstreamOutcomeUnknown, undefined);
		assert.match(await result.response.text(), /"abort_reason":"client_abort"/);
	});

	it('marks a post-dispatch network failure as outcome-unknown', async () => {
		const result = await dispatchOpenAiImageGenerations(
			route(),
			{ prompt: 'cat', n: 1 },
			undefined,
			null,
			undefined,
			{ fetchImpl: async () => { throw new TypeError('connection reset'); } },
		);
		assert.equal(result.response.status, 502);
		assert.equal(result.meta.upstreamOutcomeUnknown, true);
		assert.equal(result.meta.failoverForbidden, true);
	});

	it('marks invalid or unusable 2xx JSON as outcome-unknown', async () => {
		for (const body of ['not-json', JSON.stringify({ data: [] })]) {
			const result = await dispatchOpenAiImageGenerations(
				route(),
				{ prompt: 'cat', n: 1 },
				undefined,
				null,
				undefined,
				{ fetchImpl: async () => new Response(body, { status: 200 }) },
			);
			assert.equal(result.response.status, 200);
			assert.equal(result.meta.upstreamOutcomeUnknown, true);
			assert.equal(result.meta.failoverForbidden, true);
		}
	});

	it('bounds 2xx response buffering but keeps an explicit non-2xx known-zero', async () => {
		const tooLarge2xx = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1 }, undefined, null, undefined,
			{
				maxResponseBytes: 8,
				fetchImpl: async () => new Response('0123456789', {
					status: 200, headers: { 'content-length': '10' },
				}),
			},
		);
		assert.equal(tooLarge2xx.response.status, 502);
		assert.equal(tooLarge2xx.meta.upstreamOutcomeUnknown, true);
		assert.equal(tooLarge2xx.meta.responseBodyTooLarge, true);
		assert.equal(tooLarge2xx.meta.failoverForbidden, true);

		const explicit4xx = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1 }, undefined, null, undefined,
			{
				maxResponseBytes: 8,
				fetchImpl: async () => new Response('0123456789', {
					status: 400, headers: { 'content-length': '10' },
				}),
			},
		);
		assert.equal(explicit4xx.response.status, 400);
		assert.equal(explicit4xx.meta.upstreamOutcomeUnknown, undefined);
		assert.equal(explicit4xx.meta.responseBodyTooLarge, undefined);
		assert.equal(explicit4xx.meta.failoverForbidden, undefined);
	});

	it('keeps a validated 2xx image result certain', async () => {
		const result = await dispatchOpenAiImageGenerations(
			route(), { prompt: 'cat', n: 1 }, undefined, null, undefined,
			{ fetchImpl: async () => Response.json({ data: [{ b64_json: 'AQI=' }] }) },
		);
		assert.equal(result.meta.upstreamOutcomeUnknown, undefined);
		assert.equal(result.meta.failoverForbidden, undefined);
	});

	it('forbids replay and redacts endpoint query credentials for generations and edits', async () => {
		for (const operation of ['generations', 'edits'] as const) {
			let fetchCalls = 0;
			const capability = `images.${operation}` as const;
			const first = route({
				targetId: `target-image-${operation}-first`,
				providerId: `image-${operation}-first`,
				upstreamOperation: capability,
				routePriority: 2,
				providerEndpoints: {
					openai: {
						endpoints: {
							[capability]: `https://openai.example/v1/images/${operation}?api_key=${CANARY_SECRET}`,
						},
					},
				},
			});
			const second = route({
				targetId: `target-image-${operation}-must-not-run`,
				providerId: `image-${operation}-must-not-run`,
				upstreamOperation: capability,
				routePriority: 1,
			});
			const edit = {
				prompt: 'cat',
				n: 1,
				images: [{
					filename: 'cat.png',
					mimeType: 'image/png',
					bytes: new Uint8Array([1, 2, 3]),
				}],
			};

			const captured = await captureConsole(async () => failoverDispatch(
				{} as GatewayRepositories,
				[first, second],
				'openai',
				async (candidate, signal, timing, attempt) => {
					const options = {
						maxResponseBytes: 8,
						fetchImpl: async () => {
							fetchCalls += 1;
							return new Response('0123456789', {
								status: 200,
								headers: { 'content-length': '10' },
							});
						},
					};
					return operation === 'generations'
						? dispatchOpenAiImageGenerations(
							candidate, { prompt: 'cat', n: 1 }, signal, timing, attempt, options,
						)
						: dispatchOpenAiImageEdits(candidate, edit, signal, timing, attempt, options);
				},
				undefined,
				{
					affinityKey: `image-${operation}`,
					tierKeyPrefix: `image-${operation}`,
					strategy: 'weight_priority',
				},
			));

			const clientPayload = await captured.value.response.text();
			assert.equal(fetchCalls, 1, `${operation} must not replay an accepted upstream attempt`);
			assert.equal(captured.value.meta?.failoverForbidden, true);
			assert.equal(captured.value.meta?.responseBodyTooLarge, true);
			assert.equal(captured.output.includes(CANARY_SECRET), false);
			assert.equal(clientPayload.includes(CANARY_SECRET), false);
			assert.equal(clientPayload.includes('upstream_url'), false);
			assert.match(captured.output, new RegExp(`https://openai\\.example/v1/images/${operation}`));
		}
	});
});
