import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayRepositories, ProviderAdminRow } from '@octafuse/core';
import { createEnvironmentProviderKeysRepository } from '@octafuse/core';
import { resolvePlaygroundRoute } from './playground-service';

const endpoints = JSON.stringify({
	openai: { endpoints: { chat: 'https://api.deepseek.com/chat/completions' } },
});

function providerRepository(row: ProviderAdminRow): GatewayRepositories['providers'] {
	return createEnvironmentProviderKeysRepository({
		async listProviders() { return [row]; },
		async getProvidersByIds(ids) { return ids.includes(row.id) ? [row] : []; },
		async providerIdExists(id) { return id === row.id; },
		async insertProvider() {},
		async updateProviderByPatch() { return 0; },
		async deleteProviderById() { return 0; },
		async getProviderById(id) { return id === row.id ? row : null; },
		async getProviderRowById(id) { return id === row.id ? row : null; },
		async getProviderProtocolBases() { return null; },
		async getProviderApiKeyPlaintext(id) {
			return id === row.id ? { api_key: row.api_key ?? '' } : null;
		},
	}, {
		policies: [{
			providerId: 'deepseek-official',
			envName: 'DEEPSEEK_API_KEY',
			allowedEndpointHosts: ['api.deepseek.com'],
		}],
		secrets: { DEEPSEEK_API_KEY: 'sk-runtime-deepseek' },
	});
}

test('playground uses the resolved environment secret, never the stored env reference', async () => {
	const row: ProviderAdminRow = {
		id: 'deepseek-official',
		name: 'DeepSeek Official',
		endpoints,
		api_key: 'env:DEEPSEEK_API_KEY',
		status: 'active',
		description: null,
		shared_channel_type: null,
		created_at: '2026-09-01T00:00:00.000Z',
	};
	const providers = providerRepository(row);
	const resolved = await resolvePlaygroundRoute({
		providers,
		routes: {
			async getModelRouteRowById(id) {
				return id === 'route-1' ? {
					id,
					model_id: 'deepseek-v4-flash',
					provider_id: row.id,
					provider_model_name: 'deepseek-v4-flash',
					priority: 0,
					status: 'active',
					route_group: 'default',
					weight: 1,
					price_override: null,
					custom_params: null,
					upstream_protocol: 'openai',
					upstream_operation: 'chat',
					adapter: 'passthrough',
				} : null;
			},
		},
		models: {
			async getModelDetailWithRouteCounts() { return null; },
		},
	}, 'route-1');

	assert.equal(resolved.providerApiKey, 'sk-runtime-deepseek');
	assert.notEqual(resolved.providerApiKey, 'env:DEEPSEEK_API_KEY');
	assert.equal(
		(await providers.getProviderApiKeyPlaintext('deepseek-official'))?.api_key,
		'env:DEEPSEEK_API_KEY',
		'Admin reveal must continue to expose only the non-secret reference',
	);
});
