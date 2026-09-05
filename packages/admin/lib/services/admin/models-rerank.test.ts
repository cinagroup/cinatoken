import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { createModelService } from './models-service';

test('creating a rerank model keeps context_window and does not default max_tokens', async () => {
	const insertedRows: Record<string, unknown>[] = [];
	const repos = {
		models: {
			async insertModel(value: Record<string, unknown>) {
				insertedRows.push(value);
			},
			async replaceModelTags() {},
		},
	} as unknown as GatewayRepositories;

	await createModelService(repos, {
		id: 'deepseek-reranker',
		vendor: 'deepseek',
		context_window: 32_768,
		input_modalities: ['text'],
		output_modalities: ['rerank'],
		pricing_profile: {
			tiers: [{ upto: null, input_price: 0.1, output_price: 0 }],
		},
	});

	const inserted = insertedRows[0];
	assert.ok(inserted);
	assert.equal(inserted.contextWindow, 32_768);
	assert.equal(inserted.maxTokens, null);
	assert.equal(inserted.outputModalities, JSON.stringify(['rerank']));
});
