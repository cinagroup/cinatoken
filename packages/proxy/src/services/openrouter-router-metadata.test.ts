import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelRow } from '@octafuse/core';
import type { ModelFallbackCandidatePlan } from './model-fallback-plan';
import type { RouteResult } from './model-router';
import {
	attachOpenRouterMetadata,
	buildOpenRouterMetadata,
	MAX_ROUTER_METADATA_SSE_QUEUED_BYTES,
	MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS,
	openRouterMetadataRequested,
	routerMetadataGuardrailStage,
	type AttachOpenRouterMetadataOptions,
} from './openrouter-router-metadata';
import { RequestTimingCollector } from './request-timing';

function model(id: string): ModelRow {
	return {
		id,
		display_name: id,
		vendor: 'test',
		context_window: 8_192,
		max_tokens: 1_024,
		pricing_profile: null,
		tags: '[]',
		description: null,
		metadata: null,
		input_modalities: '["text"]',
		output_modalities: '["text"]',
		released_at: null,
		route_policy: null,
		created_at: '2026-01-01T00:00:00.000Z',
	};
}

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'route-secret-id',
		modelSurfaceId: 'surface-secret-id',
		routePoolId: 'pool-secret-id',
		providerId: 'provider-secret-id',
		providerName: 'Provider A',
		providerModelName: 'private-upstream-model',
		gatewayModelId: 'public/model-a',
		gatewayCandidateIndex: 0,
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://private-provider.example/v1' } },
		providerApiKey: 'sk-secret-value',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routingMetadata: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		providerKeyId: 'provider-key-secret-id',
		providerKeyLabel: 'internal-key-label',
		providerKeyFingerprint: 'fingerprint-secret',
		...overrides,
	};
}

function candidate(value: RouteResult, requestedModelId = 'public/model-a'): ModelFallbackCandidatePlan {
	return {
		requestedModelId,
		model: model('public/model-a'),
		baseModelId: 'public/model-a',
		effectiveRouteGroup: 'default',
		routes: [value],
		surface: null,
		strategy: { base: 'weight_priority', tierOverrides: new Map() },
		upstreamBody: { model: requestedModelId },
		hasProviderPreferences: false,
	};
}

function options(
	protocol: AttachOpenRouterMetadataOptions['protocol'],
	value: RouteResult,
	timing: RequestTimingCollector,
): AttachOpenRouterMetadataOptions {
	return {
		enabled: true,
		protocol,
		requestHeaders: new Headers({ 'CF-Ray': 'abc123-SIN' }),
		requestedModelIds: ['public/model-a'],
		candidates: [candidate(value)],
		timing,
		chosenRoute: value,
	};
}

function successfulTiming(value: RouteResult): RequestTimingCollector {
	const timing = new RequestTimingCollector();
	const attempt = timing.startAttempt(value);
	timing.markAttemptHeaders(attempt, 200);
	timing.markFinalAttempt(attempt);
	return timing;
}

function streamResponse(text: string, chunks: number[], onCancel?: () => void): Response {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	let chunkIndex = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			const size = chunks[chunkIndex] ?? bytes.byteLength;
			chunkIndex += 1;
			const end = Math.min(bytes.byteLength, offset + size);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
		cancel() {
			onCancel?.();
		},
	}), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Router Metadata opt-in', () => {
	it('accepts only enabled case-insensitively and gives the current header precedence', () => {
		assert.equal(openRouterMetadataRequested(new Headers({ 'X-OpenRouter-Metadata': ' ENABLED ' })), true);
		assert.equal(openRouterMetadataRequested(new Headers({ 'X-OpenRouter-Metadata': 'verbose' })), false);
		assert.equal(openRouterMetadataRequested(new Headers({ 'X-OpenRouter-Experimental-Metadata': 'enabled' })), true);
		assert.equal(openRouterMetadataRequested(new Headers({
			'X-OpenRouter-Metadata': 'disabled',
			'X-OpenRouter-Experimental-Metadata': 'enabled',
		})), false);
	});
});

describe('Router Metadata safe projection', () => {
	it('reports BYOK only for a successful chosen private credential attempt', () => {
		const value = route({ providerKeyId: 'byok:private-key-id' });
		const timing = successfulTiming(value);
		const success = buildOpenRouterMetadata(new Response('{}', { status: 200 }), {
			requestHeaders: new Headers(),
			requestedModelIds: ['public/model-a'],
			candidates: [candidate(value)],
			timing,
			chosenRoute: value,
		});
		assert.equal(success.is_byok, true);
		assert.equal(JSON.stringify(success).includes('private-key-id'), false);

		const failure = buildOpenRouterMetadata(new Response('{}', { status: 502 }), {
			requestHeaders: new Headers(),
			requestedModelIds: ['public/model-a'],
			candidates: [candidate(value)],
			timing,
			chosenRoute: value,
		});
		assert.equal(failure.is_byok, false);
	});

	it('includes public routing facts without leaking internal identities or private model/key data', () => {
		const value = route({
			providerRoutingTrace: {
				configured_target_ids: ['configured-target-secret'],
				eligible_target_ids: ['eligible-target-secret'],
				sort: 'price',
				partition: 'none',
				global_endpoint_rank: 1,
				require_parameters: true,
				data_collection: 'deny',
				zdr: true,
				quantizations: ['fp8'],
				max_price: { prompt: 1, completion: 2 },
				preferred_min_throughput: { p50: 50, p90: 25 },
				preferred_max_latency: 0.75,
				service_tier: 'priority',
				speed: 'fast',
				model_variant: 'nitro',
			},
		});
		const timing = successfulTiming(value);
		const metadata = buildOpenRouterMetadata(new Response('{}', { status: 200 }), {
			requestHeaders: new Headers({ 'CF-Ray': 'deadbeef-SIN' }),
			requestedModelIds: ['public/model-a'],
			candidates: [candidate(value)],
			timing,
			chosenRoute: value,
			pipeline: [
				routerMetadataGuardrailStage('request', 'flagged', 2),
				routerMetadataGuardrailStage('request', 'redacted', 3),
			],
		});

		assert.equal(metadata.requested, 'public/model-a');
		assert.equal(metadata.region, 'sin');
		assert.equal(metadata.attempt, 1);
		assert.equal(metadata.is_byok, false);
		assert.equal(metadata.endpoints.available[0]?.provider, 'Provider A');
		assert.equal(metadata.endpoints.available[0]?.model, 'public/model-a');
		assert.equal(metadata.endpoints.available[0]?.selected, true);
		assert.deepEqual(metadata.attempts, [{ provider: 'Provider A', model: 'public/model-a', status: 200 }]);
		assert.equal(metadata.pipeline?.[0]?.data.action, 'flagged');
		assert.equal(metadata.pipeline?.[1]?.data.action, 'redacted');
		assert.equal(metadata.pipeline?.[0]?.data.flagged, true);
		assert.equal(metadata.pipeline?.[0]?.data.detected, true);
		assert.equal(metadata.pipeline?.[0]?.data.match_count, 2);
		assert.equal(metadata.pipeline?.[0]?.summary, 'Request content flagged (2 matches)');
		assert.deepEqual(metadata.params, {
			throughput_floor: 50,
			preferred_min_throughput: { p50: 50, p90: 25 },
			preferred_max_latency: 0.75,
			sort: { by: 'price', partition: 'none' },
			require_parameters: true,
			data_collection: 'deny',
			zdr: true,
			quantizations: ['fp8'],
			max_price: { prompt: 1, completion: 2 },
			service_tier: 'priority',
			speed: 'fast',
			model_variant: 'nitro',
		});

		const serialized = JSON.stringify(metadata);
		for (const forbidden of [
			'route-secret-id',
			'surface-secret-id',
			'pool-secret-id',
			'provider-secret-id',
			'private-upstream-model',
			'sk-secret-value',
			'provider-key-secret-id',
			'internal-key-label',
			'fingerprint-secret',
			'private-provider.example',
			'configured-target-secret',
			'eligible-target-secret',
		]) {
			assert.equal(serialized.includes(forbidden), false, forbidden);
		}
	});

	it('projects a scalar throughput preference to the official throughput_floor field', () => {
		const value = route({
			providerRoutingTrace: {
				configured_target_ids: [],
				eligible_target_ids: [],
				sort: null,
				partition: 'model',
				global_endpoint_rank: null,
				require_parameters: false,
				data_collection: 'allow',
				zdr: false,
				quantizations: null,
				max_price: null,
				preferred_min_throughput: 42,
				preferred_max_latency: { p90: 0.4 },
			},
		});
		const metadata = buildOpenRouterMetadata(new Response('{}', { status: 200 }), {
			requestHeaders: new Headers(),
			requestedModelIds: ['public/model-a'],
			candidates: [candidate(value)],
			timing: successfulTiming(value),
			chosenRoute: value,
		});

		assert.deepEqual(metadata.params, {
			throughput_floor: 42,
			preferred_max_latency: { p90: 0.4 },
		});
		assert.equal(metadata.is_byok, false);
	});

	it('bounds public Guardrail counts and omits invalid values', () => {
		assert.equal(
			routerMetadataGuardrailStage('response', 'blocked', Number.MAX_SAFE_INTEGER).data.match_count,
			1_000_000,
		);
		assert.equal(
			Object.prototype.hasOwnProperty.call(
				routerMetadataGuardrailStage('request', 'flagged', Number.NaN).data,
				'match_count',
			),
			false,
		);
	});

	it('omits params when no non-default public routing control affected selection', () => {
		const value = route({
			providerRoutingTrace: {
				configured_target_ids: ['configured-target-secret'],
				eligible_target_ids: ['eligible-target-secret'],
				sort: null,
				partition: 'model',
				global_endpoint_rank: null,
				require_parameters: false,
				data_collection: 'allow',
				zdr: false,
				quantizations: null,
				max_price: null,
			},
		});
		const metadata = buildOpenRouterMetadata(new Response('{}', { status: 200 }), {
			requestHeaders: new Headers(),
			requestedModelIds: ['public/model-a'],
			candidates: [candidate(value)],
			timing: successfulTiming(value),
			chosenRoute: value,
		});

		assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'params'), false);
		assert.equal(JSON.stringify(metadata).includes('configured-target-secret'), false);
		assert.equal(JSON.stringify(metadata).includes('eligible-target-secret'), false);
	});

	it('never marks an endpoint selected on a failed response', () => {
		const value = route();
		const timing = new RequestTimingCollector();
		const attempt = timing.startAttempt(value);
		timing.markAttemptHeaders(attempt, 429);
		timing.markFinalAttempt(attempt);
		const metadata = buildOpenRouterMetadata(new Response('{}', { status: 429 }), {
			requestHeaders: new Headers(),
			requestedModelIds: ['public/model-a'],
			candidates: [candidate(value)],
			timing,
			chosenRoute: value,
		});
		assert.equal(metadata.attempt, 1);
		assert.equal(metadata.endpoints.available[0]?.selected, false);
	});
});

describe('Router Metadata response injection', () => {
	it('adds a top-level field to bounded JSON success and error responses but omits status 500', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const success = await attachOpenRouterMetadata(
			Response.json({ id: 'gen-1', choices: [] }),
			options('chat', value, timing),
		);
		const successBody = await success.json() as Record<string, unknown>;
		assert.equal(typeof successBody.openrouter_metadata, 'object');
		assert.equal(success.headers.has('Content-Length'), false);

		const error = await attachOpenRouterMetadata(
			Response.json({ error: { message: 'upstream failed' } }, { status: 502 }),
			options('chat', value, timing),
		);
		const errorBody = await error.json() as Record<string, unknown>;
		assert.equal(typeof errorBody.openrouter_metadata, 'object');

		const internal = Response.json({ error: { message: 'internal' } }, { status: 500 });
		const masked = await attachOpenRouterMetadata(internal, options('chat', value, timing));
		assert.equal((await masked.text()).includes('openrouter_metadata'), false);
	});

	it('places metadata on final Chat, legacy Completions, and Responses chunks before DONE', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const first = { id: 'gen-1', model: 'public/model-a', choices: [{ delta: { content: 'O' } }] };
		const final = { id: 'gen-1', model: 'public/model-a', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 2 } };
		const chatWire = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(final)}\n\n: terminal-observation\n\ndata: [DONE]\n\n`;
		const chat = await attachOpenRouterMetadata(
			streamResponse(chatWire, [1, 2, 5, 3, 1, 8]),
			options('chat', value, timing),
		);
		const chatText = await chat.text();
		assert.equal((chatText.match(/openrouter_metadata/gu) ?? []).length, 1);
		assert.ok(chatText.indexOf('openrouter_metadata') < chatText.indexOf('data: [DONE]'));
		assert.ok(chatText.indexOf('openrouter_metadata') < chatText.indexOf(': terminal-observation'));
		assert.ok(chatText.indexOf(': terminal-observation') < chatText.indexOf('data: [DONE]'));
		assert.equal(chatText.slice(0, chatText.indexOf('openrouter_metadata')).includes('"content":"O"'), true);

		const completionWire = `data: ${JSON.stringify({ ...first, object: 'text_completion', choices: [{ index: 0, text: 'O', finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...final, object: 'text_completion', choices: [{ index: 0, text: '', finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
		const completion = await attachOpenRouterMetadata(
			streamResponse(completionWire, [3, 1, 7, 2]),
			options('completions', value, timing),
		);
		const completionText = await completion.text();
		assert.equal((completionText.match(/openrouter_metadata/gu) ?? []).length, 1);
		assert.ok(completionText.indexOf('openrouter_metadata') < completionText.indexOf('data: [DONE]'));

		const completed = { type: 'response.completed', response: { id: 'resp-1', model: 'public/model-a' } };
		const responsesWire = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata:${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`;
		const responses = await attachOpenRouterMetadata(
			streamResponse(responsesWire, [4, 1, 7, 2, 9]),
			options('responses', value, timing),
		);
		const responsesText = await responses.text();
		assert.equal((responsesText.match(/openrouter_metadata/gu) ?? []).length, 1);
		assert.ok(responsesText.indexOf('event: response.completed') < responsesText.indexOf('openrouter_metadata'));
		assert.ok(responsesText.indexOf('openrouter_metadata') < responsesText.indexOf('data: [DONE]'));
	});

	it('places metadata on Anthropic message_stop and propagates downstream cancellation', async () => {
		const value = route({ upstreamProtocol: 'anthropic', upstreamOperation: 'messages' });
		const timing = successfulTiming(value);
		const wire = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
		const messages = await attachOpenRouterMetadata(
			streamResponse(wire, [2, 3, 1, 5]),
			options('messages', value, timing),
		);
		const text = await messages.text();
		assert.equal((text.match(/openrouter_metadata/gu) ?? []).length, 1);
		assert.ok(text.indexOf('event: message_stop') < text.indexOf('openrouter_metadata'));

		let cancelled = false;
		const endless = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
			},
			cancel() {
				cancelled = true;
			},
		}), { headers: { 'Content-Type': 'text/event-stream' } });
		const wrapped = await attachOpenRouterMetadata(endless, options('chat', value, timing));
		const reader = wrapped.body!.getReader();
		await reader.read();
		await reader.cancel('client_cancelled');
		assert.equal(cancelled, true);
	});

	it('caps trailing event count and emits protocol-shaped terminal failures', async () => {
		const value = route();
		const timing = successfulTiming(value);
		for (const protocol of ['chat', 'completions', 'responses'] as const) {
			const associationId = protocol === 'responses' ? 'resp-current' : `${protocol}-current`;
			const firstEvent = protocol !== 'responses'
				? { id: associationId, choices: [{ delta: { content: 'start' } }] }
				: { type: 'response.created', response: { id: associationId } };
			let pulls = 0;
			let eventIndex = 0;
			let cancelled = false;
			const totalTrailingEvents = 5_000;
			const source = new Response(new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls += 1;
					if (eventIndex === 0) {
						controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(firstEvent)}\n\n`));
						eventIndex += 1;
						return;
					}
					if (eventIndex <= totalTrailingEvents) {
						controller.enqueue(new TextEncoder().encode(`: keep-alive-${eventIndex}\n\n`));
						eventIndex += 1;
						return;
					}
					controller.close();
				},
				cancel() {
					cancelled = true;
				},
			}), { headers: { 'Content-Type': 'text/event-stream' } });

			const wrapped = await attachOpenRouterMetadata(source, options(protocol, value, timing));
			const text = await wrapped.text();
			assert.equal(cancelled, true, protocol);
			assert.ok(
				pulls <= MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS + 2,
				`${protocol}: pulls=${pulls}`,
			);
			assert.match(text, /safe buffering limit/iu);
			assert.equal(text.includes('openrouter_metadata'), false);
			assert.equal(text.includes(associationId), true);
			if (protocol === 'responses') assert.match(text, /event: response\.failed/u);
			else {
				assert.match(text, /"finish_reason":"error"/u);
				assert.match(text, protocol === 'completions' ? /"object":"text_completion"/u : /"object":"chat\.completion\.chunk"/u);
			}
		}
	});

	it('streams a full legal one-chunk event burst without treating drainable output as retained suffix', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const eventCount = MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS;
		const cases = [
			{
				protocol: 'chat' as const,
				wire: `${Array.from({ length: eventCount }, (_, index) =>
					`data: ${JSON.stringify({ id: 'chat-burst', choices: [{ delta: { content: `c${index}` } }] })}\n\n`
				).join('')}data: [DONE]\n\n`,
				first: '"content":"c0"',
				last: `"content":"c${eventCount - 1}"`,
			},
			{
				protocol: 'responses' as const,
				wire: `${Array.from({ length: eventCount }, (_, index) =>
					`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: `r${index}`, response: { id: 'resp-burst' } })}\n\n`
				).join('')}data: [DONE]\n\n`,
				first: '"delta":"r0"',
				last: `"delta":"r${eventCount - 1}"`,
			},
			{
				protocol: 'messages' as const,
				wire: `${Array.from({ length: eventCount }, (_, index) =>
					`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: `m${index}` } })}\n\n`
				).join('')}event: message_stop\ndata: {"type":"message_stop"}\n\n`,
				first: '"text":"m0"',
				last: `"text":"m${eventCount - 1}"`,
			},
		];

		for (const testCase of cases) {
			const wrapped = await attachOpenRouterMetadata(
				streamResponse(testCase.wire, [Number.MAX_SAFE_INTEGER]),
				options(testCase.protocol, value, timing),
			);
			const text = await wrapped.text();
			assert.equal(text.includes(testCase.first), true, testCase.protocol);
			assert.equal(text.includes(testCase.last), true, testCase.protocol);
			assert.equal((text.match(/openrouter_metadata/gu) ?? []).length, 1, testCase.protocol);
			assert.equal(text.includes('safe buffering limit'), false, testCase.protocol);
		}
	});

	it('allows a retained suffix at the event ceiling followed by a terminal marker', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const associationId = 'chat-retained-limit';
		const trailing = Array.from(
			{ length: MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS - 1 },
			(_, index) => `: keep-alive-${index}\n\n`,
		).join('');
		const wire = `data: ${JSON.stringify({
			id: associationId,
			choices: [{ delta: { content: 'complete' } }],
		})}\n\n${trailing}data: [DONE]\n\n`;

		const wrapped = await attachOpenRouterMetadata(
			streamResponse(wire, [Number.MAX_SAFE_INTEGER]),
			options('chat', value, timing),
		);
		const text = await wrapped.text();
		assert.equal(text.includes('safe buffering limit'), false);
		assert.equal(text.includes(associationId), true);
		assert.equal(text.includes(`: keep-alive-${MAX_ROUTER_METADATA_SSE_QUEUED_EVENTS - 2}`), true);
		assert.equal((text.match(/openrouter_metadata/gu) ?? []).length, 1);
		assert.match(text, /data: \[DONE\]/u);
	});

	it('drains complete events from a legal one-chunk burst larger than the retention byte ceiling', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const payload = 'x'.repeat(220 * 1024);
		const wire = `${Array.from({ length: 12 }, (_, index) =>
			`data: ${JSON.stringify({
				id: 'chat-large-burst',
				choices: [{ delta: { content: `${index}:${payload}` } }],
			})}\n\n`
		).join('')}data: [DONE]\n\n`;
		assert.ok(new TextEncoder().encode(wire).byteLength > MAX_ROUTER_METADATA_SSE_QUEUED_BYTES);

		const wrapped = await attachOpenRouterMetadata(
			streamResponse(wire, [Number.MAX_SAFE_INTEGER]),
			options('chat', value, timing),
		);
		const text = await wrapped.text();
		assert.equal(text.includes('safe buffering limit'), false);
		assert.equal(text.includes('0:'), true);
		assert.equal(text.includes('11:'), true);
		assert.equal((text.match(/openrouter_metadata/gu) ?? []).length, 1);
		assert.match(text, /data: \[DONE\]/u);
	});

	it('enforces the aggregate byte ceiling for many complete events in one source chunk', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const commentPayload = 'x'.repeat(64 * 1024);
		const trailing = Array.from(
			{ length: Math.ceil(MAX_ROUTER_METADATA_SSE_QUEUED_BYTES / commentPayload.length) + 2 },
			(_, index) => `: ${commentPayload}-${index}\n\n`,
		).join('');
		let cancelled = false;
		let sent = false;
		const source = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) return;
				sent = true;
				controller.enqueue(new TextEncoder().encode(`data: {"id":"terminal"}\n\n${trailing}`));
			},
			cancel() {
				cancelled = true;
			},
		}), { headers: { 'Content-Type': 'text/event-stream' } });

		const wrapped = await attachOpenRouterMetadata(source, options('chat', value, timing));
		const text = await wrapped.text();
		assert.equal(cancelled, true);
		assert.match(text, /safe buffering limit/iu);
		assert.equal(text.includes(commentPayload), false);
	});

	it('keeps downstream cancellation idempotent after source EOF and reader release', async () => {
		const value = route();
		const timing = successfulTiming(value);
		const source = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(
					'data: {"id":"terminal"}\n\n: retained-after-terminal\n\n',
				));
				controller.close();
			},
		}), { headers: { 'Content-Type': 'text/event-stream' } });

		const wrapped = await attachOpenRouterMetadata(source, options('chat', value, timing));
		const reader = wrapped.body!.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		await assert.doesNotReject(reader.cancel('after_source_eof'));
	});

});
