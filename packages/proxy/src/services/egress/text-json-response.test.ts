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
import { TEXT_JSON_RESPONSE_MAX_BYTES } from './text-json-response';

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

function dispatch(protocol: Protocol): Promise<DispatchResult> {
	if (protocol === 'chat') {
		return dispatchOpenAiRoute(
			route(protocol), { messages: [] }, undefined, undefined, undefined, undefined,
			'gen-json-contract',
		);
	}
	if (protocol === 'responses') {
		return dispatchOpenAiResponsesRoute(
			route(protocol), { input: 'hi' }, undefined, undefined, undefined, undefined,
			'gen-json-contract',
		);
	}
	return dispatchAnthropicRoute(
		route(protocol), { messages: [] }, undefined, undefined, undefined, undefined,
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
		model: 'private/provider-model',
		choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
	},
	responses: {
		id: 'resp-upstream',
		model: 'private/provider-model',
		status: 'completed',
		output: [],
		usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
	},
	anthropic: {
		id: 'msg-upstream',
		type: 'message',
		model: 'private/provider-model',
		content: [],
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
				assert.equal((await result.usagePromise).total_tokens, 5);
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
					assert.equal((await result.usagePromise).total_tokens, 5);
					assert.equal(result.meta, undefined);
				},
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
