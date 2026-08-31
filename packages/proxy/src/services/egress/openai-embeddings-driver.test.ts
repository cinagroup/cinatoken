import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../model-router';
import {
	dispatchOpenAiEmbeddingsRoute,
	OPENAI_EMBEDDINGS_RESPONSE_MAX_BYTES,
	usageFromEmbeddings,
} from './openai-embeddings-driver';

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
		});
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
				object: 'list', model: 'upstream-name',
				data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2] }],
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
			const response = await result.response.json() as { model: string };
			assert.equal(response.model, 'openai/text-embedding-3-small');
			assert.equal((await result.usagePromise).input_tokens, 3);
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
			assert.equal(result.meta?.failoverForbidden, true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('does not fail over after a client-aborted upstream attempt', async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		controller.abort();
		globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError'); };
		try {
			const result = await dispatchOpenAiEmbeddingsRoute(
				route(), { model: 'x', input: 'hello' }, controller.signal,
			);
			assert.equal(result.response.status, 499);
			assert.equal(result.meta?.upstreamOutcomeUnknown, true);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.equal((await result.usagePromise).cancelled, true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
