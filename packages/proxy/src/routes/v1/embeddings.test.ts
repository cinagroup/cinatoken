import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	MAX_EMBEDDING_INPUT_ITEMS,
	routeExposesEmbeddings,
	validateEmbeddingInput,
	validateEmbeddingsBody,
} from './embeddings';

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
});
