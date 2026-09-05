import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../model-router';
import {
	dispatchOpenAiEmbeddingsRoute,
	OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES,
	usageFromEmbeddings,
} from './openai-embeddings-driver';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from '../gateway-error-codes';

function route(): RouteResult {
	return {
		targetId: 'target-1', modelSurfaceId: 'surface-1', routePoolId: 'pool-1',
		providerId: 'provider-1', providerName: 'Provider', providerModelName: 'text-embedding-3-small',
		gatewayModelId: 'openai/text-embedding-3-small', upstreamProtocol: 'openai',
		upstreamOperation: 'embeddings', adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://provider.example/v1' } },
		providerApiKey: 'provider-secret', providerSharedChannelType: null,
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: { encoding_format: 'float' }, routeGroup: 'default', routePriority: 0,
		routeWeight: 1, providerKeyId: null, providerKeyLabel: null, providerKeyFingerprint: null,
	};
}

describe('usageFromEmbeddings', () => {
	it('maps prompt usage into input-only gateway usage', () => {
		assert.deepEqual(usageFromEmbeddings({ prompt_tokens: 8, total_tokens: 8 }), {
			input_tokens: 8, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
			reasoning_tokens: 0, total_tokens: 8,
			raw_usage: JSON.stringify({ prompt_tokens: 8, total_tokens: 8 }),
			native_tokens_prompt: 8,
			native_tokens_completion: 0,
			native_tokens_cached: null,
			native_tokens_reasoning: null,
			native_tokens_completion_images: null,
		});
	});

	it('rejects fractional, inconsistent, missing, and unsafe counters as non-authoritative', () => {
		for (const usage of [
			{ prompt_tokens: 1.5, total_tokens: 2 },
			{ prompt_tokens: 3, input_tokens: 4, total_tokens: 4 },
			{ prompt_tokens: 3 },
			{ prompt_tokens: 3, total_tokens: 2 },
			{ prompt_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			assert.deepEqual(usageFromEmbeddings(usage), {
				input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
				reasoning_tokens: 0, total_tokens: 0, raw_usage: null,
			});
		}
	});
});

describe('dispatchOpenAiEmbeddingsRoute', () => {
	it('routes to /embeddings, keeps request overrides, rewrites the public model, and captures usage', async () => {
		const originalFetch = globalThis.fetch;
		let requestUrl = '';
		let requestInit: RequestInit | undefined;
		globalThis.fetch = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return new Response(JSON.stringify({
				id: 'embd-private-1', object: 'list', model: 'upstream-name',
				data: [{ object: 'embedding', index: 0, embedding: 'AQIDBA==' }],
				usage: { prompt_tokens: 3, total_tokens: 3 },
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-upstream' },
			});
		};
		try {
			let admitted = false;
			const result = await dispatchOpenAiEmbeddingsRoute(
				route(),
				{ model: 'openai/text-embedding-3-small', input: ['hello'], encoding_format: 'base64' },
				undefined,
				undefined,
				undefined,
				async () => { admitted = true; },
			);
			assert.equal(admitted, true);
			assert.equal(requestUrl, 'https://provider.example/v1/embeddings');
			assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer provider-secret');
			assert.deepEqual(JSON.parse(String(requestInit?.body)), {
				encoding_format: 'base64', model: 'text-embedding-3-small', input: ['hello'],
			});
			assert.equal(result.upstreamRequestId, 'req-upstream');
			const response = await result.response.json() as { id: string; model: string };
			assert.equal(response.id, 'embd-private-1');
			assert.equal(response.model, 'openai/text-embedding-3-small');
			const usage = await result.usagePromise;
			assert.equal(usage.input_tokens, 3);
			assert.equal(usage.upstreamMessageId, 'embd-private-1');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('fails without replaying when a successful upstream body exceeds the bound', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response('{}', {
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': String(OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES + 1),
			},
		});
		try {
			const result = await dispatchOpenAiEmbeddingsRoute(route(), { model: 'x', input: 'hello' });
			assert.equal(result.response.status, 502);
			assert.equal(result.meta?.responseBodyTooLarge, true);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(result.meta?.gatewayGeneratedError, true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('does not cross admission or fetch when already cancelled', async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		controller.abort();
		let fetchCalls = 0;
		let admissionCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error('fetch must not run');
		};
		try {
			const result = await dispatchOpenAiEmbeddingsRoute(
				route(),
				{ model: 'x', input: 'hello' },
				controller.signal,
				undefined,
				undefined,
				async () => { admissionCalls += 1; },
				'gen-pre-cancelled',
			);
			assert.equal(result.response.status, 499);
			assert.equal(fetchCalls, 0);
			assert.equal(admissionCalls, 0);
			assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal(result.meta?.gatewayGeneratedError, true);
			assert.equal((await result.usagePromise).cancelled, true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('stops before fetch when cancellation arrives during admission', async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error('fetch must not run');
		};
		try {
			const result = await dispatchOpenAiEmbeddingsRoute(
				route(),
				{ model: 'x', input: 'hello' },
				controller.signal,
				undefined,
				undefined,
				async () => { controller.abort(); },
				'gen-cancelled-in-admission',
			);
			assert.equal(result.response.status, 499);
			assert.equal(fetchCalls, 0);
			assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
			assert.equal((await result.usagePromise).cancelled, true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('marks fetch rejection after admission as an unknown non-replayable outcome', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError'); };
		try {
			await assert.rejects(
				() => dispatchOpenAiEmbeddingsRoute(route(), { model: 'x', input: 'hello' }),
				(error: unknown) => Boolean(
					error
					&& typeof error === 'object'
					&& (error as { upstreamOutcomeUnknown?: unknown }).upstreamOutcomeUnknown === true
				),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('allows a valid response without optional usage but keeps usage non-authoritative', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({
			id: 'embd-no-usage',
			object: 'list',
			model: 'private-model',
			data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2] }],
		}), { headers: { 'Content-Type': 'application/json' } });
		try {
			const result = await dispatchOpenAiEmbeddingsRoute(route(), { model: 'x', input: 'hello' });
			assert.equal(result.response.status, 200);
			assert.equal((await result.response.json() as { id?: string }).id, 'embd-no-usage');
			assert.deepEqual(await result.usagePromise, {
				input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
				reasoning_tokens: 0, total_tokens: 0, raw_usage: null,
				upstreamMessageId: 'embd-no-usage',
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('rejects malformed successful JSON and usage without leaking or replaying it', async () => {
		const invalidBodies: Array<{ label: string; body: string }> = [
			{ label: 'invalid json', body: '{"must-not-leak":' },
			{ label: 'non-object', body: '[]' },
			{ label: 'missing data', body: JSON.stringify({ object: 'list', model: 'private' }) },
			{ label: 'wrong object', body: JSON.stringify({ object: 'embedding', model: 'private', data: [] }) },
			{ label: 'wrong cardinality', body: JSON.stringify({ object: 'list', model: 'private', data: [] }) },
			{
				label: 'duplicate index',
				body: JSON.stringify({
					object: 'list', model: 'private',
					data: [
						{ object: 'embedding', index: 0, embedding: [0.1] },
						{ object: 'embedding', index: 0, embedding: [0.2] },
					],
				}),
			},
			{
				label: 'wrong encoding',
				body: JSON.stringify({
					object: 'list', model: 'private',
					data: [{ object: 'embedding', index: 0, embedding: 'not base64' }],
				}),
			},
			{
				label: 'unsafe id',
				body: JSON.stringify({
					id: 'embd-bad\nid', object: 'list', model: 'private',
					data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
				}),
			},
			{
				label: 'fractional usage',
				body: JSON.stringify({
					object: 'list', model: 'private',
					data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
					usage: { prompt_tokens: 1.5, total_tokens: 2 },
				}),
			},
		];
		const originalFetch = globalThis.fetch;
		try {
			for (const testCase of invalidBodies) {
				globalThis.fetch = async () => new Response(testCase.body, {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
				const input = testCase.label === 'duplicate index' ? ['a', 'b'] : 'hello';
				const result = await dispatchOpenAiEmbeddingsRoute(route(), { model: 'x', input });
				assert.equal(result.response.status, 502, testCase.label);
				assert.equal(
					result.response.headers.get(GATEWAY_ERROR_CODE_HEADER),
					GatewayErrorCode.upstreamRequestFailed,
				);
				assert.equal(result.meta?.upstreamOutcomeUnknown, true, testCase.label);
				assert.equal(result.meta?.failoverForbidden, true, testCase.label);
				assert.equal(result.meta?.gatewayGeneratedError, true, testCase.label);
				assert.doesNotMatch(await result.response.text(), /must-not-leak|private/i, testCase.label);
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('cancels an accepted non-JSON body and replaces it with a typed failure', async () => {
		const originalFetch = globalThis.fetch;
		let cancelled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode('must-not-leak'));
			},
			cancel() { cancelled += 1; },
		});
		globalThis.fetch = async () => new Response(body, {
			status: 200,
			headers: { 'Content-Type': 'text/plain' },
		});
		try {
			const result = await dispatchOpenAiEmbeddingsRoute(route(), { model: 'x', input: 'hello' });
			assert.equal(result.response.status, 502);
			assert.equal(cancelled, 1);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.doesNotMatch(await result.response.text(), /must-not-leak/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
