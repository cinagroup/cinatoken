import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GATEWAY_ERROR_CODE_HEADER } from '../gateway-error-codes';
import type { ProxyDispatchMeta } from '../failover-dispatch';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchOpenAiRoute } from './openai-driver';
import { dispatchOpenAiResponsesRoute } from './openai-responses-driver';
import { dispatchGeminiRoute } from './gemini-driver';
import {
	TEXT_JSON_RESPONSE_MAX_BYTES,
	TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS,
} from './text-json-response';

type Protocol = 'chat' | 'responses' | 'anthropic';
type DispatchResult = {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	meta?: ProxyDispatchMeta;
};

function route(protocol: Protocol): RouteResult {
	const upstreamProtocol = protocol === 'anthropic' ? 'anthropic' : 'openai';
	return {
		targetId: `target-${protocol}`,
		modelSurfaceId: 'surface-text-json',
		routePoolId: 'pool-text-json',
		providerId: `provider-${protocol}`,
		providerName: `Provider ${protocol}`,
		providerModelName: 'private/provider-model',
		gatewayModelId: 'public/model',
		upstreamProtocol,
		upstreamOperation: protocol === 'anthropic' ? 'messages' : protocol,
		adapter: 'passthrough',
		providerEndpoints: { [upstreamProtocol]: { base: 'https://provider.test/v1' } },
		providerApiKey: 'provider-secret',
		providerSharedChannelType: null,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routingMetadata: null,
		routeGroup: 'default',
		routePriority: 1,
		routeWeight: 1,
		providerKeyId: null,
		providerKeyLabel: null,
		providerKeyFingerprint: null,
	};
}

function dispatch(protocol: Protocol, stream = false): Promise<DispatchResult> {
	if (protocol === 'chat') {
		return dispatchOpenAiRoute(
			route(protocol), { messages: [], stream }, undefined, undefined, undefined, undefined,
			'gen-json-contract',
		);
	}
	if (protocol === 'responses') {
		return dispatchOpenAiResponsesRoute(
			route(protocol), { input: 'hi', stream }, undefined, undefined, undefined, undefined,
			'gen-json-contract',
		);
	}
	return dispatchAnthropicRoute(
		route(protocol), { messages: [], stream }, undefined, undefined, undefined, undefined,
		'gen-json-contract',
	);
}

function dispatchGemini(): Promise<DispatchResult> {
	return dispatchGeminiRoute({
		...route('chat'),
		targetId: 'target-gemini',
		providerId: 'provider-gemini',
		providerModelName: 'gemini-2.5-flash',
		upstreamProtocol: 'gemini',
		upstreamOperation: 'models.generate',
		providerEndpoints: { gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/models' } },
	}, {}, 'generateContent', '');
}

async function withFetchResponse(
	response: () => Response,
	run: () => Promise<void>,
): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => response()) as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

const validBody: Record<Protocol, Record<string, unknown>> = {
	chat: {
		id: 'chatcmpl-upstream',
		object: 'chat.completion',
		created: 1_700_000_000,
		model: 'private/provider-model',
		choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
	},
	responses: {
		id: 'resp-upstream',
		object: 'response',
		created_at: 1_700_000_000,
		completed_at: 1_700_000_001,
		error: null,
		model: 'private/provider-model',
		status: 'completed',
		output: [],
		usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
	},
	anthropic: {
		id: 'msg-upstream',
		type: 'message',
		role: 'assistant',
		model: 'private/provider-model',
		content: [],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: 2, output_tokens: 3 },
	},
};

describe('bounded non-streaming text JSON responses', () => {
	it('applies the same bounded accepted-JSON contract to Gemini', async () => {
		await withFetchResponse(
			() => new Response(JSON.stringify({
				responseId: 'gemini-response',
				candidates: [{ content: { parts: [{ text: 'ok' }] } }],
				usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
			}), {
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '999',
					'Content-Encoding': 'gzip',
					'Transfer-Encoding': 'chunked',
				},
			}),
			async () => {
				const result = await dispatchGemini();
				assert.equal(result.response.status, 200);
				assert.equal(result.response.headers.get('content-length'), null);
				assert.equal(result.response.headers.get('content-encoding'), null);
				assert.equal(result.response.headers.get('transfer-encoding'), null);
				const usage = await result.usagePromise;
				assert.equal(usage.total_tokens, 5);
				assert.equal(usage.native_tokens_prompt, 2);
				assert.equal(usage.native_tokens_completion, 3);
				assert.equal((await result.response.json() as { responseId?: string }).responseId, 'gemini-response');
			}
		);

		await withFetchResponse(
			() => new Response('{"private_secret":', { status: 200, headers: { 'Content-Type': 'application/json' } }),
			async () => {
				const result = await dispatchGemini();
				assert.equal(result.response.status, 502);
				assert.equal(result.meta?.upstreamOutcomeUnknown, true);
				assert.equal(result.meta?.failoverForbidden, true);
				assert.doesNotMatch(await result.response.text(), /private_secret/);
			}
		);

		await withFetchResponse(
			() => new Response('{}', {
				status: 200,
				headers: { 'Content-Type': 'application/json', 'Content-Length': String(TEXT_JSON_RESPONSE_MAX_BYTES + 1) },
			}),
			async () => {
				const result = await dispatchGemini();
				assert.equal(result.response.status, 502);
				assert.equal(result.meta?.responseBodyTooLarge, true);
				assert.equal(result.meta?.failoverForbidden, true);
			}
		);
	});

	it('rebuilds every valid consumed body for the client', async () => {
		for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
			await withFetchResponse(
				() => Response.json(validBody[protocol]),
				async () => {
					const result = await dispatch(protocol);
					assert.equal(result.response.status, 200);
					assert.equal(result.response.bodyUsed, false);
					const body = JSON.parse(await result.response.text()) as Record<string, unknown>;
					assert.equal(body.model, 'public/model');
					const usage = await result.usagePromise;
					assert.equal(usage.total_tokens, 5);
					assert.equal(usage.native_tokens_prompt, 2);
					assert.equal(usage.native_tokens_completion, 3);
					assert.equal(
						usage.native_tokens_cached,
						protocol === 'anthropic' ? 0 : null,
					);
					if (protocol === 'chat') {
						assert.equal(usage.finish_reason, 'stop');
						assert.equal(usage.native_finish_reason, 'stop');
					} else if (protocol === 'anthropic') {
						assert.equal(usage.finish_reason, 'stop');
						assert.equal(usage.native_finish_reason, 'end_turn');
					} else {
						assert.equal(usage.finish_reason, undefined);
						assert.equal(usage.native_finish_reason, undefined);
					}
					assert.equal(result.meta, undefined);
				},
			);
		}
	});

	it('uses Chat choice zero and preserves conservative Anthropic finish semantics', async () => {
		await withFetchResponse(
			() => Response.json({
				...validBody.chat,
				choices: [
					{ index: 1, message: { role: 'assistant', content: 'later' }, finish_reason: 'length' },
					{
						index: 0,
						message: { role: 'assistant', content: 'primary' },
						finish_reason: 'tool_calls',
						native_finish_reason: 'tool_use',
					},
				],
			}),
			async () => {
				const usage = await (await dispatch('chat')).usagePromise;
				assert.equal(usage.finish_reason, 'tool_calls');
				assert.equal(usage.native_finish_reason, 'tool_use');
			},
		);

		for (const [native, canonical] of [
			['refusal', 'content_filter'],
			['model_context_window_exceeded', 'length'],
			['pause_turn', null],
			['compaction', null],
		] as const) {
			await withFetchResponse(
				() => Response.json({ ...validBody.anthropic, stop_reason: native }),
				async () => {
					const usage = await (await dispatch('anthropic')).usagePromise;
					assert.equal(usage.finish_reason, canonical);
					assert.equal(usage.native_finish_reason, native);
				},
			);
		}
	});

	it('keeps optional Chat and Responses usage non-authoritative when omitted', async () => {
		for (const protocol of ['chat', 'responses'] as const) {
			const body = { ...validBody[protocol] };
			delete body.usage;
			await withFetchResponse(
				() => Response.json(body),
				async () => {
					const result = await dispatch(protocol);
					assert.equal(result.response.status, 200);
					assert.equal((await result.usagePromise).raw_usage, null);
					assert.equal((await result.usagePromise).total_tokens, 0);
					assert.equal((await result.usagePromise).native_tokens_prompt, undefined);
				}
			);
		}
	});

	it('rejects protocol-invalid accepted objects without exposing provider fields', async () => {
		const invalidBodies: Record<Protocol, Array<Record<string, unknown>>> = {
			chat: [
				{ ...validBody.chat, object: 'chat.completion.chunk' },
				{ ...validBody.chat, id: 'chatcmpl-bad\nid' },
				{ ...validBody.chat, choices: [] },
				{
					...validBody.chat,
					choices: [{ index: 0, message: { role: 'user', content: 'bad' }, finish_reason: 'stop' }],
				},
				{
					...validBody.chat,
					usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 99 },
				},
				{
					...validBody.chat,
					choices: Array.from(
						{ length: TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS + 1 },
						(_, index) => ({
							index,
							message: { role: 'assistant', content: '' },
							finish_reason: 'stop',
						}),
					),
				},
			],
			responses: [
				{ ...validBody.responses, object: 'response.completed' },
				{ ...validBody.responses, id: 'resp bad' },
				{ ...validBody.responses, status: 'unknown' },
				{ ...validBody.responses, output: ['private-leak'] },
				{
					...validBody.responses,
					usage: { input_tokens: 2, output_tokens: 3, total_tokens: 4 },
				},
				{ ...validBody.responses, status: 'failed', error: null },
				{
					...validBody.responses,
					output: Array.from(
						{ length: TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS + 1 },
						() => ({ type: 'message' }),
					),
				},
			],
			anthropic: [
				{ ...validBody.anthropic, type: 'message_start' },
				{ ...validBody.anthropic, id: 'msg bad' },
				{ ...validBody.anthropic, role: 'user' },
				{ ...validBody.anthropic, content: ['private-leak'] },
				{ ...validBody.anthropic, usage: { input_tokens: 2.5, output_tokens: 3 } },
				{ ...validBody.anthropic, usage: undefined },
				{
					...validBody.anthropic,
					content: Array.from(
						{ length: TEXT_SUCCESS_RESPONSE_MAX_COLLECTION_ITEMS + 1 },
						() => ({ type: 'text', text: '' }),
					),
				},
			],
		};

		for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
			for (const body of invalidBodies[protocol]) {
				await withFetchResponse(
					() => Response.json({ ...body, private_secret: 'must-not-leak' }),
					async () => {
						const result = await dispatch(protocol);
						assert.equal(result.response.status, 502, protocol);
						assert.equal(result.meta?.upstreamOutcomeUnknown, true, protocol);
						assert.equal(result.meta?.failoverForbidden, true, protocol);
						assert.equal(result.meta?.gatewayGeneratedError, true, protocol);
						assert.doesNotMatch(await result.response.text(), /must-not-leak|private_secret/);
					}
				);
			}
		}
	});

	it('requires the requested JSON or EventSource transport and cancels mismatches', async () => {
		for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
			for (const streamRequested of [false, true]) {
				let cancelled = 0;
				const bytes = new TextEncoder().encode(
					streamRequested ? JSON.stringify(validBody[protocol]) : 'must-not-leak',
				);
				const body = new ReadableStream<Uint8Array>({
					start(controller) { controller.enqueue(bytes); },
					cancel() { cancelled += 1; },
				});
				await withFetchResponse(
					() => new Response(body, {
						status: 200,
						headers: {
							'Content-Type': streamRequested ? 'application/json' : 'text/plain',
						},
					}),
					async () => {
						const result = await dispatch(protocol, streamRequested);
						assert.equal(result.response.status, 502, `${protocol}/${streamRequested}`);
						assert.equal(result.meta?.upstreamOutcomeUnknown, true);
						assert.equal(result.meta?.failoverForbidden, true);
						assert.doesNotMatch(await result.response.text(), /must-not-leak/);
					}
				);
				assert.equal(cancelled, 1, `${protocol}/${streamRequested}`);
			}

			await withFetchResponse(
				() => new Response(null, {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				}),
				async () => {
					const result = await dispatch(protocol, true);
					assert.equal(result.response.status, 502, `${protocol}/empty-stream`);
					assert.equal(result.meta?.upstreamOutcomeUnknown, true);
				}
			);
		}
	});

	it('turns malformed accepted JSON into a masked typed 502 without replay', async () => {
		for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
			await withFetchResponse(
				() => new Response('{"private_secret":', {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
				async () => {
					const result = await dispatch(protocol);
					assert.equal(result.response.status, 502);
					assert.equal(result.meta?.upstreamOutcomeUnknown, true);
					assert.equal(result.meta?.failoverForbidden, true);
					assert.equal(result.meta?.gatewayGeneratedError, true);
					assert.equal(result.meta?.responseBodyTooLarge, undefined);
					assert.equal(
						result.response.headers.get(GATEWAY_ERROR_CODE_HEADER),
						'gateway.upstream_request_failed',
					);
					const publicBody = await result.response.text();
					assert.doesNotMatch(publicBody, /private_secret/);
					assert.match(publicBody, /provider|upstream|failed|unavailable/i);
				},
			);
		}
	});

	it('rejects declared oversized accepted JSON before buffering it', async () => {
		for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
			await withFetchResponse(
				() => new Response('{}', {
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': String(TEXT_JSON_RESPONSE_MAX_BYTES + 1),
					},
				}),
				async () => {
					const result = await dispatch(protocol);
					assert.equal(result.response.status, 502);
					assert.equal(result.meta?.upstreamOutcomeUnknown, true);
					assert.equal(result.meta?.failoverForbidden, true);
					assert.equal(result.meta?.gatewayGeneratedError, true);
					assert.equal(result.meta?.responseBodyTooLarge, true);
					assert.equal(
						result.response.headers.get(GATEWAY_ERROR_CODE_HEADER),
						'gateway.upstream_response_too_large',
					);
					assert.doesNotMatch(await result.response.text(), /provider-secret/);
				},
			);
		}
	});

	it('cancels an observed oversized body even without Content-Length', async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(65);
		let emitted = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				emitted += chunk.byteLength;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		await withFetchResponse(
			() => new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
			async () => {
				const result = await dispatch('chat');
				assert.equal(result.response.status, 502);
				assert.equal(result.meta?.responseBodyTooLarge, true);
				assert.equal(result.meta?.upstreamOutcomeUnknown, true);
				assert.equal(result.meta?.failoverForbidden, true);
			},
		);
		assert.equal(cancelled, true);
	});

	it('leaves explicit non-2xx upstream bodies untouched for existing normalization', async () => {
		for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
			await withFetchResponse(
				() => new Response('{"error":{"message":"known rejection"}}', {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				}),
				async () => {
					const result = await dispatch(protocol);
					assert.equal(result.response.status, 400);
					assert.equal(result.meta, undefined);
					assert.match(await result.response.text(), /known rejection/);
				},
			);
		}
	});
});
