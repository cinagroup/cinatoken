import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	type GatewayRepositories,
	type ModelRow,
} from '@octafuse/core';
import {
	MAX_CALLABLE_EMBEDDING_MODELS,
	MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS,
} from '@octafuse/core/db/model-modalities';
import { Hono } from 'hono';
import type { Env } from '../../app';
import {
	embeddingsRoutes,
	MAX_EMBEDDING_INPUT_ITEMS,
	routeExposesEmbeddings,
	validateEmbeddingInput,
	validateEmbeddingsBody,
} from './embeddings';

function embeddingModel(id: string, outputModalities = '["embeddings"]'): ModelRow {
	return {
		id,
		display_name: id,
		vendor: 'Vendor',
		context_window: 8_192,
		max_tokens: null,
		pricing_profile: JSON.stringify({ tiers: [{ upto: null, input_price: 0.1, output_price: 0 }] }),
		tags: '["embedding"]',
		description: null,
		metadata: null,
		input_modalities: '["text"]',
		output_modalities: outputModalities,
		released_at: '2026-08-30',
		created_at: '2026-08-30T00:00:00.000Z',
	};
}

function embeddingModelsApp(candidates: ModelRow[]) {
	let discoveryReads = 0;
	const repositories = {
		apiKeys: { getApiKeyWithUserByKey: async (key: string) => key === 'sk-test' ? {
			id: 'key-1', key: 'sk-test', user_id: 'user-1', workspace_id: 'personal:user-1', name: 'Test', status: 'active',
			metadata: null, last_used_at: null, created_at: '2026-08-30T00:00:00.000Z', updated_at: '2026-08-30T00:00:00.000Z',
			user_email: 'user@example.com', user_metadata: null, user_charged_cost_factors: null,
			budget_max: null, budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
			budget_epoch: 0, budget_reserved_micros: 0,
		} : null },
		modelRouting: {
			listCallableEmbeddingModelCandidates: async () => {
				discoveryReads += 1;
				return candidates;
			},
			listModelsWithActiveRoutes: async () => { throw new Error('must not enumerate the full model catalog'); },
		},
		routes: {
			listModelRoutesWithJoins: async () => { throw new Error('must not scan the full route catalog'); },
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<Env>();
	app.use('*', async (c, next) => { c.set('repositories', repositories); await next(); });
	app.route('/v1/embeddings', embeddingsRoutes);
	return { app, discoveryReads: () => discoveryReads };
}

describe('embedding request validation', () => {
	it('accepts documented text, token, and object batch containers', () => {
		assert.deepEqual(validateEmbeddingInput('hello'), { ok: true, value: { count: 1, kind: 'text' } });
		assert.deepEqual(validateEmbeddingInput(['a', 'b']), { ok: true, value: { count: 2, kind: 'text_batch' } });
		assert.deepEqual(validateEmbeddingInput([1, 2, 3]), { ok: true, value: { count: 1, kind: 'tokens' } });
		assert.deepEqual(validateEmbeddingInput([[1, 2], [3]]), { ok: true, value: { count: 2, kind: 'token_batch' } });
		assert.deepEqual(validateEmbeddingInput([{ text: 'a' }, { image_url: 'https://example.test/a.png' }]), {
			ok: true, value: { count: 2, kind: 'object_batch' },
		});
	});

	it('rejects empty, mixed, oversized, and streaming requests', () => {
		assert.equal(validateEmbeddingInput([]).ok, false);
		assert.equal(validateEmbeddingInput(['a', 1]).ok, false);
		assert.equal(validateEmbeddingInput(new Array(MAX_EMBEDDING_INPUT_ITEMS + 1).fill('x')).ok, false);
		assert.equal(validateEmbeddingsBody({ model: 'm', input: 'x', stream: true }).ok, false);
		assert.equal(validateEmbeddingsBody({ model: 'm', input: 'x', dimensions: 0 }).ok, false);
		const bodySession = validateEmbeddingsBody({ model: 'm', input: 'x', session_id: 'body-session' });
		assert.equal(bodySession.ok, false);
		if (!bodySession.ok) assert.match(bodySession.message, /use x-session-id/u);
		for (const unsupported of [{ models: ['m', 'm2'] }, { fallbacks: [{ model: 'm2' }] }]) {
			const result = validateEmbeddingsBody({ model: 'm', input: 'x', ...unsupported });
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.message, /not supported for embeddings/);
		}
	});
});

describe('embedding route discovery', () => {
	it('requires an active OpenAI embeddings request surface', () => {
		const base = {
			status: 'active', pool_status: 'active', upstream_protocol: 'openai',
			upstream_operation: 'embeddings', surfaces: JSON.stringify([{
				status: 'active', request_protocol: 'openai', request_operation: 'embeddings',
			}]),
		};
		assert.equal(routeExposesEmbeddings(base), true);
		assert.equal(routeExposesEmbeddings({ ...base, status: 'inactive' }), false);
		assert.equal(routeExposesEmbeddings({
			...base,
			surfaces: JSON.stringify([{ status: 'active', request_protocol: 'openai', request_operation: 'chat' }]),
		}), false);
	});

	it('keeps legacy wildcard routes compatible and fails closed on malformed surfaces', () => {
		assert.equal(routeExposesEmbeddings({
			status: 'active', pool_status: null, upstream_protocol: 'openai', upstream_operation: '*', surfaces: null,
		}), true);
		assert.equal(routeExposesEmbeddings({
			status: 'active', pool_status: null, upstream_protocol: 'openai', upstream_operation: '*', surfaces: '{',
		}), false);
	});

	it('uses only the bounded repository projection and fails closed on malformed model modalities', async () => {
		const { app, discoveryReads } = embeddingModelsApp([
			embeddingModel('valid'),
			embeddingModel('malformed', '{"kind":"embeddings"}'),
		]);
		const response = await app.request('/v1/embeddings/models', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(response.status, 200);
		const body = await response.json() as { data: Array<{ id: string }> };
		assert.deepEqual(body.data.map((item) => item.id), ['valid']);
		assert.equal(discoveryReads(), 1);
	});

	it('rejects an unauthenticated read before model discovery', async () => {
		const { app, discoveryReads } = embeddingModelsApp([embeddingModel('valid')]);
		const response = await app.request(
			'/v1/embeddings/models',
			undefined,
			{} as Env['Bindings']
		);
		assert.equal(response.status, 401);
		assert.equal(discoveryReads(), 0);
	});

	it('returns an explicit retryable error instead of silently truncating an oversized catalog', async () => {
		assert.equal(MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS, MAX_CALLABLE_EMBEDDING_MODELS + 1);
		const candidates = Array.from(
			{ length: MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS },
			(_, index) => embeddingModel(`embedding-${String(index).padStart(4, '0')}`)
		);
		const { app } = embeddingModelsApp(candidates);
		const response = await app.request('/v1/embeddings/models', {
			headers: { Authorization: 'Bearer sk-test' },
		});
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('cache-control'), 'private, no-store');
		assert.equal(response.headers.get('retry-after'), '60');
		assert.deepEqual(await response.json(), {
			error: {
				code: 'embedding_model_catalog_too_large',
				message: 'Embedding model catalog is temporarily unavailable',
			},
		});
	});
});
