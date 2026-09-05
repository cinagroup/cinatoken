import assert from 'node:assert/strict';
import test from 'node:test';
import {
	byokCredentialLabel,
	normalizeByokKeyCreate,
	normalizeByokKeyPatch,
	normalizeByokKeyReorder,
	publicByokKey,
} from './byok-keys-types';

test('BYOK create normalization follows the bounded OpenRouter contract', () => {
	const input = normalizeByokKeyCreate({
		provider: 'deepseek',
		key: 'secret-provider-key',
		name: ' Production ',
		allowed_models: ['deepseek/deepseek-chat', 'deepseek/deepseek-chat'],
		allowed_user_ids: [],
		allowed_api_key_hashes: ['a'.repeat(64)],
		is_fallback: true,
	}, 'personal:user-1');
	assert.deepEqual(input, {
		workspaceId: 'personal:user-1',
		provider: 'deepseek',
		name: 'Production',
		apiKey: 'secret-provider-key',
		label: '...-key',
		disabled: false,
		isFallback: true,
		alwaysUseForProvider: false,
		alwaysUseForMatchingModels: false,
		allowedModels: ['deepseek/deepseek-chat'],
		allowedUserIds: [],
		allowedApiKeyHashes: ['a'.repeat(64)],
	});
	assert.equal(byokCredentialLabel('abc'), '***');
});

test('BYOK normalization rejects unknown fields and malformed filters', () => {
	assert.throws(
		() => normalizeByokKeyCreate({ provider: 'DeepSeek', key: 'secret' }, 'workspace-1'),
		/lowercase/u,
	);
	assert.throws(
		() => normalizeByokKeyCreate({ provider: 'deepseek', key: 'secret', extra: true }, 'workspace-1'),
		/Unsupported BYOK field/u,
	);
	assert.throws(
		() => normalizeByokKeyPatch({ allowed_api_key_hashes: [] }),
		/between 1 and 100/u,
	);
	assert.throws(
		() => normalizeByokKeyPatch({ allowed_api_key_hashes: ['A'.repeat(64)] }),
		/invalid item/u,
	);
	assert.throws(() => normalizeByokKeyPatch({}), /At least one/u);
	assert.throws(
		() => normalizeByokKeyCreate({
			provider: 'deepseek',
			key: 'secret',
			is_fallback: true,
			always_use_for_provider: true,
		}, 'workspace-1'),
		/prioritized BYOK keys/u,
	);
	assert.throws(
		() => normalizeByokKeyPatch({
			is_fallback: true,
			always_use_for_matching_models: true,
		}),
		/prioritized BYOK keys/u,
	);
	assert.throws(
		() => normalizeByokKeyPatch({
			always_use_for_provider: true,
			always_use_for_matching_models: true,
		}),
		/mutually exclusive/u,
	);
	assert.deepEqual(normalizeByokKeyPatch({ always_use_for_provider: true }), {
		alwaysUseForProvider: true,
	});
	assert.deepEqual(normalizeByokKeyPatch({ always_use_for_matching_models: true }), {
		alwaysUseForMatchingModels: true,
	});
});

test('BYOK public projection never returns credential material', () => {
	const projected = publicByokKey({
		id: 'key-1',
		workspace_id: 'workspace-1',
		provider: 'deepseek',
		name: null,
		label: '...1234',
		disabled: false,
		is_fallback: false,
		always_use_for_provider: true,
		always_use_for_matching_models: false,
		sort_order: 0,
		allowed_models: null,
		allowed_user_ids: null,
		allowed_api_key_hashes: null,
		created_by_management_key_id: 'management-1',
		created_at: '2026-09-03T00:00:00.000Z',
		updated_at: '2026-09-03T00:00:00.000Z',
	});
	assert.equal('api_key' in projected, false);
	assert.equal('created_by_management_key_id' in projected, false);
	assert.equal(projected.always_use_for_provider, true);
	assert.equal(projected.always_use_for_matching_models, false);
});

test('BYOK reorder normalization requires one complete partitioned sequence', () => {
	assert.deepEqual(normalizeByokKeyReorder({
		provider: 'deepseek',
		keys: [
			{ id: '11111111-1111-4111-8111-111111111111', is_fallback: false },
			{ id: '22222222-2222-4222-8222-222222222222', is_fallback: true },
		],
	}, 'personal:user-1'), {
		workspaceId: 'personal:user-1',
		provider: 'deepseek',
		keys: [
			{ id: '11111111-1111-4111-8111-111111111111', isFallback: false },
			{ id: '22222222-2222-4222-8222-222222222222', isFallback: true },
		],
	});
	assert.throws(() => normalizeByokKeyReorder({
		provider: 'deepseek',
		keys: [
			{ id: '11111111-1111-4111-8111-111111111111', is_fallback: true },
			{ id: '22222222-2222-4222-8222-222222222222', is_fallback: false },
		],
	}, 'personal:user-1'), /Prioritized BYOK keys must precede fallback/u);
	assert.throws(() => normalizeByokKeyReorder({
		provider: 'deepseek',
		keys: [
			{ id: '11111111-1111-4111-8111-111111111111', is_fallback: false },
			{ id: '11111111-1111-4111-8111-111111111111', is_fallback: false },
		],
	}, 'personal:user-1'), /duplicate ids/u);
});
