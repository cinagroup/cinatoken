import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../model-router';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from '../gateway-error-codes';
import {
	dispatchOpenAiRerankRoute,
	OPENAI_RERANK_RESPONSE_MAX_BYTES,
	usageFromRerank,
} from './openai-rerank-driver';

function route(): RouteResult {
	return {
		targetId: 'target-1', modelSurfaceId: 'surface-1', routePoolId: 'pool-1',
		providerId: 'provider-1', providerName: 'Cohere', providerModelName: 'rerank-v3.5',
		gatewayModelId: 'cohere/rerank-v3.5', upstreamProtocol: 'openai',
		upstreamOperation: 'rerank', adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://api.cohere.com/v2' } },
		providerApiKey: 'provider-secret', providerSharedChannelType: null,
		priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null,
		customParams: { top_n: 2 }, routeGroup: 'default', routePriority: 0,
		routeWeight: 1, providerKeyId: null, providerKeyLabel: null, providerKeyFingerprint: null,
	};
}

describe('usageFromRerank', () => {
	it('maps total tokens and preserves only documented usage counters', () => {
		assert.deepEqual(usageFromRerank({ search_units: 1, total_tokens: 8, cost: 0.001 }), {
			input_tokens: 8, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
			reasoning_tokens: 0, total_tokens: 8,
			raw_usage: JSON.stringify({ search_units: 1, total_tokens: 8, cost: 0.001 }),
			native_tokens_prompt: 8,
			native_tokens_completion: 0,
			native_tokens_cached: null,
			native_tokens_reasoning: null,
			native_tokens_completion_images: null,
		});
	});

	it('rejects invalid, unsafe, and undocumented usage fields', () => {
		for (const usage of [
			{ search_units: 1.5 },
			{ total_tokens: -1 },
			{ cost: Number.POSITIVE_INFINITY },
			{ prompt_tokens: 1 },
		]) assert.equal(usageFromRerank(usage), null);
	});

	it('keeps search-unit-only usage public but non-authoritative for settlement', async () => {
		assert.deepEqual(usageFromRerank({ search_units: 2 }), {
			input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
			reasoning_tokens: 0, total_tokens: 0, raw_usage: null,
			native_tokens_prompt: null,
			native_tokens_completion: 0,
			native_tokens_cached: null,
			native_tokens_reasoning: null,
			native_tokens_completion_images: null,
		});
	});
});

describe('dispatchOpenAiRerankRoute', () => {
	it('rewrites the model, reconstructs redacted documents, sorts results, and captures usage', async () => {
		const originalFetch = globalThis.fetch;
		let requestUrl = '';
		let requestInit: RequestInit | undefined;
		globalThis.fetch = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return new Response(JSON.stringify({
				id: 'rerank-private-1',
				model: 'private-model-name',
				results: [
					{ index: 1, relevance_score: 0.2, document: { text: 'must-not-leak' }, extra: 'drop' },
					{ index: 0, relevance_score: 0.9, document: 'must-not-leak' },
				],
				usage: { search_units: 1, total_tokens: 11, cost: 0.001 },
				extra: 'drop',
			}), {
				status: 200,
				headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-upstream' },
			});
		};
		try {
			let admitted = false;
			const result = await dispatchOpenAiRerankRoute(
				route(),
				{
					model: 'cohere/rerank-v3.5', query: '[EMAIL]',
					documents: ['public document', { text: '[EMAIL]', ignored: 'drop' }],
					top_n: 1,
				},
				undefined,
				undefined,
				undefined,
				async () => { admitted = true; },
				'gen-public-1',
			);
			assert.equal(admitted, true);
			assert.equal(requestUrl, 'https://api.cohere.com/v2/rerank');
			assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer provider-secret');
			assert.deepEqual(JSON.parse(String(requestInit?.body)), {
				top_n: 1,
				model: 'rerank-v3.5',
				query: '[EMAIL]',
				documents: ['public document', { text: '[EMAIL]' }],
			});
			assert.equal(result.upstreamRequestId, 'req-upstream');
			assert.deepEqual(await result.response.json(), {
				id: 'gen-public-1',
				model: 'cohere/rerank-v3.5',
				provider: 'Cohere',
				results: [
					{ index: 0, relevance_score: 0.9, document: { text: 'public document' } },
					{ index: 1, relevance_score: 0.2, document: { text: '[EMAIL]' } },
				],
				usage: { search_units: 1, total_tokens: 11, cost: 0.001 },
			});
			const usage = await result.usagePromise;
			assert.equal(usage.input_tokens, 11);
			assert.equal(usage.upstreamMessageId, 'rerank-private-1');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('accepts a response without optional id or usage and keeps cost uncertain', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({
			model: 'private',
			results: [{ index: 0, relevance_score: -0.1 }],
		}), { headers: { 'Content-Type': 'application/json' } });
		try {
			const result = await dispatchOpenAiRerankRoute(
				route(),
				{ model: 'x', query: 'q', documents: [{ image: 'https://example.test/image.png' }] },
				undefined, undefined, undefined, undefined, 'gen-public-2',
			);
			assert.equal(result.response.status, 200);
			assert.deepEqual(await result.response.json(), {
				id: 'gen-public-2',
				model: 'cohere/rerank-v3.5',
				provider: 'Cohere',
				results: [{
					index: 0, relevance_score: -0.1,
					document: { image: 'https://example.test/image.png' },
				}],
			});
			assert.deepEqual(await result.usagePromise, {
				input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
				reasoning_tokens: 0, total_tokens: 0, raw_usage: null,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('fails closed without replaying malformed accepted responses', async () => {
		const invalidBodies: Array<{ label: string; value: unknown }> = [
			{ label: 'missing results', value: { model: 'private' } },
			{ label: 'duplicate index', value: { model: 'private', results: [
				{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 },
			] } },
			{ label: 'out of bounds', value: { model: 'private', results: [{ index: 2, relevance_score: 1 }] } },
			{ label: 'non-finite score', value: { model: 'private', results: [{ index: 0, relevance_score: '1' }] } },
			{ label: 'unsafe id', value: { id: 'bad\nid', model: 'private', results: [] } },
			{ label: 'bad usage', value: { model: 'private', results: [], usage: { total_tokens: 1.5 } } },
		];
		const originalFetch = globalThis.fetch;
		try {
			for (const testCase of invalidBodies) {
				globalThis.fetch = async () => new Response(JSON.stringify(testCase.value), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
				const result = await dispatchOpenAiRerankRoute(
					route(), { model: 'x', query: 'q', documents: ['a', 'b'] },
				);
				assert.equal(result.response.status, 502, testCase.label);
				assert.equal(result.response.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.upstreamRequestFailed);
				assert.equal(result.meta?.upstreamOutcomeUnknown, true, testCase.label);
				assert.equal(result.meta?.failoverForbidden, true, testCase.label);
				assert.doesNotMatch(await result.response.text(), /private|must-not-leak/i, testCase.label);
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('fails closed when an accepted response is oversized or non-JSON', async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => new Response('{}', {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': String(OPENAI_RERANK_RESPONSE_MAX_BYTES + 1),
				},
			});
			let result = await dispatchOpenAiRerankRoute(
				route(), { model: 'x', query: 'q', documents: ['a'] },
			);
			assert.equal(result.response.status, 502);
			assert.equal(result.meta?.responseBodyTooLarge, true);

			globalThis.fetch = async () => new Response('must-not-leak', {
				status: 200, headers: { 'Content-Type': 'text/plain' },
			});
			result = await dispatchOpenAiRerankRoute(
				route(), { model: 'x', query: 'q', documents: ['a'] },
			);
			assert.equal(result.response.status, 502);
			assert.equal(result.meta?.failoverForbidden, true);
			assert.doesNotMatch(await result.response.text(), /must-not-leak/);
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
			const result = await dispatchOpenAiRerankRoute(
				route(),
				{ model: 'x', query: 'q', documents: ['a'] },
				controller.signal,
				undefined,
				undefined,
				async () => { admissionCalls += 1; },
				'gen-cancelled',
			);
			assert.equal(result.response.status, 499);
			assert.equal(fetchCalls, 0);
			assert.equal(admissionCalls, 0);
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
				() => dispatchOpenAiRerankRoute(
					route(), { model: 'x', query: 'q', documents: ['a'] },
				),
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
});
