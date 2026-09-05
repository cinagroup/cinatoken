import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { invokePlaygroundUpstream } from './playground-service';

function rerankRepositories(protocol = 'openai'): GatewayRepositories {
	return {
		routes: {
			async getModelRouteRowById(id: string) {
				return {
					id,
					model_id: 'deepseek-reranker',
					provider_id: 'deepseek-official',
					provider_model_name: 'deepseek-reranker',
					priority: 0,
					status: 'active',
					route_group: 'default',
					weight: 1,
					price_override: null,
					custom_params: null,
					upstream_protocol: protocol,
					upstream_operation: 'rerank',
					adapter: 'passthrough',
				};
			},
		},
		providers: {
			async getProviderById() {
				return {
					id: 'deepseek-official',
					name: 'DeepSeek Official',
					api_key: 'sk-test-rerank',
					status: 'active',
					endpoints: JSON.stringify({
						openai: { base: 'https://api.example.com/v1' },
					}),
				};
			},
		},
		models: {
			async getModelDetailWithRouteCounts() {
				return {
					id: 'deepseek-reranker',
					output_modalities: JSON.stringify(['rerank']),
				};
			},
		},
	} as unknown as GatewayRepositories;
}

test('playground sends rerank JSON to the configured OpenAI rerank endpoint', async () => {
	const originalFetch = globalThis.fetch;
	let calledUrl = '';
	let calledBody = '';
	globalThis.fetch = async (input, init) => {
		calledUrl = String(input);
		calledBody = String(init?.body ?? '');
		return new Response(JSON.stringify({ results: [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	try {
		const result = await invokePlaygroundUpstream(rerankRepositories(), {
			routeId: 'route-rerank',
			body: {
				query: 'capital of France',
				documents: ['Paris', 'Berlin'],
				top_n: 1,
			},
		});
		assert.equal(calledUrl, 'https://api.example.com/v1/rerank');
		assert.deepEqual(JSON.parse(calledBody), {
			query: 'capital of France',
			documents: ['Paris', 'Berlin'],
			top_n: 1,
			model: 'deepseek-reranker',
		});
		assert.equal(result.upstreamWireBodyJson, calledBody);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('playground rejects rerank routes on non-OpenAI protocols', async () => {
	await assert.rejects(
		invokePlaygroundUpstream(rerankRepositories('anthropic'), {
			routeId: 'route-rerank',
			body: { query: 'q', documents: ['a'] },
		}),
		/Rerank models require upstream_protocol=openai/,
	);
});
