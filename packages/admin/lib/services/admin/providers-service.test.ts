import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { listStaticProviderImportPresets } from '@/lib/provider-import-preset';
import { importProvidersFromStaticPresetsService } from './providers-service';

type InsertedProvider = {
	id: string;
	name: string;
	apiKey: string;
	status: string;
	sharedChannelType: string | null;
	endpoints: string | null;
};

function repositories(options: { existingIds?: readonly string[] } = {}): {
	repositories: GatewayRepositories;
	inserted: InsertedProvider[];
} {
	const existingIds = new Set(options.existingIds ?? []);
	const inserted: InsertedProvider[] = [];
	return {
		repositories: {
			providers: {
				listProviders: async () => [],
				providerIdExists: async (id: string) => existingIds.has(id),
				insertProvider: async (params: InsertedProvider) => {
					inserted.push(params);
					existingIds.add(params.id);
				},
			},
		} as unknown as GatewayRepositories,
		inserted,
	};
}

function deepSeekCatalogKey(): string {
	const preset = listStaticProviderImportPresets().find((row) => row.name === 'DeepSeek');
	assert.ok(preset);
	return preset.catalog_key;
}

describe('managed Provider preset import', () => {
	it('installs the official DeepSeek provider with an environment reference, never the secret', async () => {
		const store = repositories();
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({ object: 'list', data: [] });
		};
		const result = await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			environmentApiKeys: { DEEPSEEK_API_KEY: ' sk-runtime-secret ' },
			fetchImpl,
		});

		assert.deepEqual(result, {
			created: 1,
			updated: 0,
			skipped_existing: [],
			failed: [],
		});
		assert.equal(store.inserted.length, 1);
		assert.equal(store.inserted[0]?.id, 'deepseek-official');
		assert.equal(store.inserted[0]?.apiKey, 'env:DEEPSEEK_API_KEY');
		assert.equal(store.inserted[0]?.status, 'active');
		assert.equal(store.inserted[0]?.sharedChannelType, null);
		assert.match(store.inserted[0]?.endpoints ?? '', /api\.deepseek\.com/u);
		assert.doesNotMatch(JSON.stringify(store.inserted), /sk-runtime-secret/u);
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.url, 'https://api.deepseek.com/models');
		assert.equal(requests[0]?.init?.method, 'GET');
		assert.equal(requests[0]?.init?.redirect, 'error');
		assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
		assert.equal(
			new Headers(requests[0]?.init?.headers).get('Authorization'),
			'Bearer sk-runtime-secret',
		);
	});

	it('fails closed as disabled when the Admin runtime secret is absent', async () => {
		const store = repositories();
		let requests = 0;
		await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			fetchImpl: async () => {
				requests += 1;
				return Response.json({ object: 'list', data: [] });
			},
		});

		assert.equal(store.inserted[0]?.apiKey, 'env:DEEPSEEK_API_KEY');
		assert.equal(store.inserted[0]?.status, 'disabled');
		assert.equal(requests, 0);
	});

	it('fails closed as disabled when DeepSeek rejects the Secret', async () => {
		const store = repositories();
		await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			environmentApiKeys: { DEEPSEEK_API_KEY: 'sk-invalid' },
			fetchImpl: async () => Response.json(
				{ error: { message: 'Authentication failed' } },
				{ status: 401 },
			),
		});

		assert.equal(store.inserted[0]?.status, 'disabled');
		assert.doesNotMatch(JSON.stringify(store.inserted), /sk-invalid/u);
	});

	it('fails closed as disabled when the validation request fails', async () => {
		const store = repositories();
		await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [deepSeekCatalogKey()],
			environmentApiKeys: { DEEPSEEK_API_KEY: 'sk-runtime-secret' },
			fetchImpl: async () => {
				throw new TypeError('network unavailable');
			},
		});

		assert.equal(store.inserted[0]?.status, 'disabled');
	});

	it('is idempotent for the deterministic official Provider id', async () => {
		const store = repositories({ existingIds: ['deepseek-official'] });
		const catalogKey = deepSeekCatalogKey();
		let requests = 0;
		const result = await importProvidersFromStaticPresetsService(store.repositories, {
			ids: [catalogKey],
			environmentApiKeys: { DEEPSEEK_API_KEY: 'sk-runtime-secret' },
			fetchImpl: async () => {
				requests += 1;
				return Response.json({ object: 'list', data: [] });
			},
		});

		assert.equal(result.created, 0);
		assert.deepEqual(result.skipped_existing, [catalogKey]);
		assert.deepEqual(result.failed, []);
		assert.deepEqual(store.inserted, []);
		assert.equal(requests, 0);
	});
});
