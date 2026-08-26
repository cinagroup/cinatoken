import assert from 'node:assert/strict';
import test from 'node:test';
import { createEncryptedProvidersRepository } from './provider-key-encryption';
import { isEncryptedSharedKeySecret } from './shared-key-encryption';
import type { ProvidersRepository } from '../storage/gateway-repository-interfaces';
import type { ProviderRow } from '../types';
import type { ProviderAdminRow } from '../storage/repository-dtos';

const SECRET = 'test-only-shared-key-encryption-secret-32-bytes';

type StoredProvider = { id: string; name: string; api_key: string };

function makeRepository(initial: StoredProvider[]) {
	const store = new Map(initial.map((row) => [row.id, { ...row }]));
	const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
	const repository = {
		patches,
		async listProviders(): Promise<ProviderAdminRow[]> {
			return [...store.values()].map((row) => ({ ...row }) as ProviderAdminRow);
		},
		async providerIdExists(id: string) {
			return store.has(id);
		},
		async insertProvider(params: { id: string; name: string; endpoints: string | null; description: unknown; apiKey?: string; status?: string; sharedChannelType?: string | null }) {
			store.set(params.id, { id: params.id, name: params.name, api_key: params.apiKey ?? '' });
		},
		async updateProviderByPatch(id: string, body: Record<string, unknown>) {
			patches.push({ id, body: { ...body } });
			const row = store.get(id);
			if (!row) return 0;
			if (typeof body.api_key === 'string') row.api_key = body.api_key;
			return 1;
		},
		async deleteProviderById(id: string) {
			return store.delete(id) ? 1 : 0;
		},
		async getProviderById(id: string): Promise<ProviderRow | null> {
			const row = store.get(id);
			return row ? ({ ...row } as unknown as ProviderRow) : null;
		},
		async getProviderRowById(id: string): Promise<ProviderAdminRow | null> {
			const row = store.get(id);
			return row ? ({ ...row } as ProviderAdminRow) : null;
		},
		async getProviderProtocolBases() {
			return null;
		},
		async getProviderApiKeyPlaintext(id: string) {
			const row = store.get(id);
			return row ? { api_key: row.api_key } : null;
		},
	} as unknown as ProvidersRepository & { patches: typeof patches };
	return { repository, store };
}

test('audit M2: provider api keys encrypt on insert and decrypt at the boundary', async () => {
	const { repository, store } = makeRepository([]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);

	await wrapped.insertProvider({ id: 'p1', name: 'OpenAI', endpoints: null, description: null, apiKey: 'sk-upstream-secret' });
	const stored = store.get('p1');
	assert.equal(isEncryptedSharedKeySecret(stored?.api_key ?? ''), true);
	assert.equal((stored?.api_key ?? '').includes('sk-upstream-secret'), false);

	const revealed = await wrapped.getProviderById('p1');
	assert.equal(revealed?.api_key, 'sk-upstream-secret');
	// 存库内容保持密文（读取不回写明文）
	assert.equal(isEncryptedSharedKeySecret(store.get('p1')?.api_key ?? ''), true);
});

test('audit M2: legacy plaintext provider keys migrate in place on first read', async () => {
	const { repository, store } = makeRepository([{ id: 'p2', name: 'Anthropic', api_key: 'sk-legacy-plain' }]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);

	const revealed = await wrapped.getProviderApiKeyPlaintext('p2');
	assert.equal(revealed?.api_key, 'sk-legacy-plain');
	assert.equal(isEncryptedSharedKeySecret(store.get('p2')?.api_key ?? ''), true);
});

test('audit M2: patch updates encrypt api_key in place', async () => {
	const { repository, store } = makeRepository([{ id: 'p3', name: 'Gemini', api_key: '' }]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);

	await wrapped.updateProviderByPatch('p3', { api_key: 'sk-new-key' });
	const stored = store.get('p3')?.api_key ?? '';
	assert.equal(isEncryptedSharedKeySecret(stored), true);
	assert.equal(stored.includes('sk-new-key'), false);
	const revealed = await wrapped.getProviderRowById('p3');
	assert.equal(revealed?.api_key, 'sk-new-key');
});

test('audit M2: list reveals decrypt every row; empty keys pass through', async () => {
	const { repository } = makeRepository([
		{ id: 'a', name: 'A', api_key: '' },
		{ id: 'b', name: 'B', api_key: 'sk-b' },
	]);
	const wrapped = createEncryptedProvidersRepository(repository, SECRET);
	const rows = await wrapped.listProviders();
	assert.deepEqual(
		rows.map((row) => row.api_key),
		['', 'sk-b'],
	);
});
