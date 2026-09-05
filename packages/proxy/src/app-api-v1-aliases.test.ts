import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, StorageContext } from '@octafuse/core';
import { createProxyApp } from './app';

describe('OpenRouter /api/v1 path aliases', () => {
	it('mounts every supported authenticated inference surface instead of returning 404', async () => {
		const repositories = {
			apiKeys: { getApiKeyWithUserByKey: async () => null },
			modelRouting: { listModelsWithActiveRoutes: async () => [] },
		} as unknown as GatewayRepositories;
		const app = createProxyApp(async () => ({ repositories } as StorageContext));
		const requests: Array<[string, string]> = [
			['POST', '/api/v1/chat/completions'],
			['POST', '/api/v1/completions'],
			['POST', '/v1/completions'],
			['POST', '/api/v1/responses'],
			['POST', '/api/v1/messages'],
			['POST', '/api/v1/embeddings'],
			['POST', '/api/v1/rerank'],
			['POST', '/v1/rerank'],
			['POST', '/api/v1/images'],
			['POST', '/api/v1/images/generations'],
			['POST', '/api/v1/audio/speech'],
			['POST', '/api/v1/audio/transcriptions'],
			['POST', '/v1/audio/transcriptions'],
		];

		for (const [method, path] of requests) {
			const response = await app.request(path, { method }, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 401, `${method} ${path} should reach API-key auth`);
		}
		const publicModels = await app.request(
			'/api/v1/models',
			{},
			{ REQUEST_BODY_LOGGING: 'off' },
		);
		assert.equal(publicModels.status, 200);
		assert.deepEqual(await publicModels.json(), {
			data: [],
			total_count: 0,
			links: { next: null },
		});
		const mounted = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
		assert.equal(mounted.has('POST /api/v1/images'), true);
		assert.equal(mounted.has('POST /v1/images'), true);
		assert.equal(mounted.has('POST /api/v1/audio/transcriptions'), true);
		assert.equal(mounted.has('POST /v1/audio/transcriptions'), true);
	});
});
