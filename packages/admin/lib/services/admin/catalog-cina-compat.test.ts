import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { getProviderCatalog } from '@/lib/provider-catalog';
import { localProviderRows } from '@/lib/catalog/local-provider-catalog';
import { listStaticModelPresetCatalogForAdminService, importModelsFromStaticPresetsService } from './models-service';
import { importProvidersFromStaticPresetsService } from './providers-service';

const injected = { provider_id: 'injected-provider', env_name: 'UNRELATED_SECRET' };

test('remote catalogs cannot choose managed credentials or replace managed endpoints', async (t) => {
	const trusted = localProviderRows.find((row) => row.name === 'DeepSeek')!;
	const remote = [
		{ ...trusted, name: " DeepSeek ", endpoints: { openai: { base: 'https://untrusted.example/v1' } }, managed_environment_key: injected },
		{ name: 'Untrusted', vendor_key: 'other', endpoints: { openai: { base: 'https://untrusted.example/v1' } }, managed_environment_key: injected },
	];
	const catalog = getProviderCatalog(remote);
	assert.deepEqual(catalog.getStaticProviderPresetByKind('DeepSeek')?.endpoints, trusted.endpoints);
	assert.deepEqual(catalog.getStaticProviderPresetByKind('DeepSeek')?.managed_environment_key, trusted.managed_environment_key);
	assert.equal(catalog.getStaticProviderPresetByKind('Untrusted')?.managed_environment_key, undefined);
	t.mock.method(globalThis, 'fetch', async () => Response.json(remote));
	const inserts: Array<{ id: string; apiKey: string; endpoints: string }> = [];
	const repos = { providers: {
		listProviders: async () => [],
		providerIdExists: async () => false,
		insertProvider: async (row: typeof inserts[number]) => { inserts.push(row); },
	} } as unknown as GatewayRepositories;
	const result = await importProvidersFromStaticPresetsService(repos, { ids: ['DeepSeek', 'Untrusted'] }, { CATALOG_BASE_URL: 'https://cina-managed-compat.example' });
	assert.equal(result.created, 2);
	assert.equal(inserts[0].id, 'deepseek-official');
	assert.equal(inserts[0].apiKey, 'env:DEEPSEEK_API_KEY');
	assert.deepEqual(JSON.parse(inserts[0].endpoints), trusted.endpoints);
	assert.notEqual(inserts[1].apiKey, 'env:UNRELATED_SECRET');
	assert.notEqual(inserts[1].id, 'injected-provider');
});

test('unsupported billing currencies block catalog preview and import before any fetch or write', async (t) => {
	const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
	const repos = { systemConfig: { getConfig: async () => 'EUR' } } as unknown as GatewayRepositories;
	await assert.rejects(listStaticModelPresetCatalogForAdminService(repos), /does not support billing currency EUR/);
	await assert.rejects(importModelsFromStaticPresetsService(repos, { ids: ['model'] }), /does not support billing currency EUR/);
	assert.equal(network.mock.callCount(), 0);
});
