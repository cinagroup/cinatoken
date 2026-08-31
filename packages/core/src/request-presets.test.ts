import test from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayRepositories, RequestPresetWithVersionRow } from './index';
import {
	captureRequestPresetConfig,
	mergeRequestPresetTools,
	normalizeRequestPresetSlug,
	resolveRequestPreset,
	saveRequestPresetVersion,
	validateRequestPresetConfig,
} from './request-presets';

const preset: RequestPresetWithVersionRow = {
	id: 'preset-1', workspace_id: 'ws-1', owner_user_id: 'user-1', slug: 'coding', name: 'Coding', description: null,
	visibility: 'private', status: 'active', designated_version: 2, latest_version: 2,
	created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
	version_id: 'version-2', version_system_prompt: 'Be precise.',
	version_config_json: JSON.stringify({ model: 'openai/gpt-5', temperature: 0.2, tools: [
		{ type: 'function', function: { name: 'search', description: 'old' } },
		{ type: 'web_search' },
	] }),
	version_created_by_user_id: 'user-1', version_created_at: '2026-01-02T00:00:00Z',
};

function repositories(accessible: RequestPresetWithVersionRow | null = preset): GatewayRepositories {
	return {
		requestPresets: {
			getAccessibleBySlug: async (slug: string, workspaceId: string, userId: string) => slug === 'coding' && workspaceId === 'ws-1' && userId === 'user-1' ? accessible : null,
		},
	} as unknown as GatewayRepositories;
}

test('normalizes valid preset slugs and rejects ambiguous values', () => {
	assert.equal(normalizeRequestPresetSlug('@preset/My_Preset'), 'my_preset');
	assert.equal(normalizeRequestPresetSlug('bad/slug'), null);
	assert.equal(normalizeRequestPresetSlug('-bad'), null);
});

test('preset config rejects transient, unknown, recursive, and secret-bearing fields', () => {
	assert.equal(validateRequestPresetConfig({ model: 'x', messages: [] }).ok, false);
	assert.equal(validateRequestPresetConfig({ model: 'x', unsupported: true }).ok, false);
	assert.equal(validateRequestPresetConfig({ model: '@preset/nested' }).ok, false);
	assert.equal(validateRequestPresetConfig({ provider: { headers: { authorization: 'secret' } } }).ok, false);
	assert.equal(validateRequestPresetConfig({ model: 'x', temperature: 0.2 }).ok, true);
});

test('capture strips transient bodies and extracts protocol system prompts', () => {
	const result = captureRequestPresetConfig({
		model: 'openai/gpt-5', stream: true,
		messages: [{ role: 'system', content: 'Answer briefly' }, { role: 'user', content: 'hi' }],
	}, 'chat');
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.value, { model: 'openai/gpt-5' });
	assert.equal(result.systemPrompt, 'Answer briefly');
});

test('tools preserve preset order while request definitions override by identity', () => {
	assert.deepEqual(mergeRequestPresetTools(
		[
			{ type: 'function', function: { name: 'search', description: 'old' } },
			{ type: 'web_search' },
		],
		[
			{ type: 'function', function: { name: 'search', description: 'new' } },
			{ type: 'function', function: { name: 'calculate' } },
		],
	), [
		{ type: 'function', function: { name: 'search', description: 'new' } },
		{ type: 'web_search' },
		{ type: 'function', function: { name: 'calculate' } },
	]);
});

test('resolves all preset reference forms with shallow request override', async () => {
	const byModel = await resolveRequestPreset(repositories(), 'ws-1', 'user-1', {
		model: '@preset/coding', messages: [{ role: 'user', content: 'hi' }], temperature: 0.8,
	}, 'chat');
	assert.equal(byModel.ok, true);
	if (!byModel.ok) return;
	assert.equal(byModel.body.model, 'openai/gpt-5');
	assert.equal(byModel.body.temperature, 0.8);
	assert.deepEqual((byModel.body.messages as Array<Record<string, unknown>>)[0], { role: 'system', content: 'Be precise.' });

	const byField = await resolveRequestPreset(repositories(), 'ws-1', 'user-1', {
		preset: 'coding', model: 'anthropic/claude', messages: [{ role: 'user', content: 'hi' }],
	}, 'chat');
	assert.equal(byField.ok && byField.body.model, 'anthropic/claude');

	const combined = await resolveRequestPreset(repositories(), 'ws-1', 'user-1', {
		model: 'google/gemini@preset/coding', input: 'hi',
	}, 'responses');
	assert.equal(combined.ok && combined.body.model, 'google/gemini');
	assert.equal(combined.ok && combined.body.instructions, 'Be precise.');
});

test('preset resolution fails closed for conflicts and inaccessible slugs', async () => {
	const conflict = await resolveRequestPreset(repositories(), 'ws-1', 'user-1', {
		preset: 'coding', model: '@preset/other', messages: [],
	}, 'chat');
	assert.deepEqual(conflict.ok ? null : [conflict.status, conflict.code], [400, 'invalid_preset_reference']);
	const missing = await resolveRequestPreset(repositories(null), 'ws-1', 'user-1', { preset: 'coding' }, 'messages');
	assert.deepEqual(missing.ok ? null : [missing.status, missing.code], [404, 'preset_not_found']);
});

test('saving a preset creates immutable versions and enforces slug ownership', async () => {
	let current: RequestPresetWithVersionRow | null = null;
	const history: Array<{ version: number; config: string }> = [];
	const requestPresets = {
		getBySlug: async (slug: string, workspaceId: string) => current?.workspace_id === workspaceId && current.slug === slug ? current : null,
		getById: async (id: string) => current?.id === id ? current : null,
		createWithVersion: async (params: { id: string; workspaceId: string; ownerUserId: string; slug: string; name: string; description: string | null; visibility: 'private' | 'public'; configJson: string; systemPrompt: string | null; nowIso: string }) => {
			history.push({ version: 1, config: params.configJson });
			current = { ...preset, id: params.id, workspace_id: params.workspaceId, owner_user_id: params.ownerUserId, slug: params.slug, name: params.name, description: params.description, visibility: params.visibility, designated_version: 1, latest_version: 1, status: 'active', version_config_json: params.configJson, version_system_prompt: params.systemPrompt, updated_at: params.nowIso };
			return current;
		},
		addVersion: async (params: { presetId: string; configJson: string; systemPrompt: string | null; nowIso: string }) => {
			assert.equal(params.presetId, current?.id);
			const version = (current?.latest_version ?? 0) + 1;
			history.push({ version, config: params.configJson });
			current = { ...current!, designated_version: version, latest_version: version, version_config_json: params.configJson, version_system_prompt: params.systemPrompt, updated_at: params.nowIso };
			return current;
		},
		updateMetadata: async () => true,
	};
	const repos = { requestPresets } as unknown as GatewayRepositories;
	const created = await saveRequestPresetVersion(repos, {
		workspaceId: 'ws-1', ownerUserId: 'user-1', slug: 'analysis', name: 'Analysis', visibility: 'private',
		systemPrompt: null, config: { model: 'openai/gpt-5', temperature: 0.2 },
	});
	assert.equal(created.ok && created.preset.latest_version, 1);
	const updated = await saveRequestPresetVersion(repos, {
		workspaceId: 'ws-1', ownerUserId: 'user-1', slug: 'analysis', systemPrompt: 'Be exact.',
		config: { model: 'openai/gpt-5', temperature: 0.1 },
	});
	assert.equal(updated.ok && updated.preset.latest_version, 2);
	assert.deepEqual(history.map((item) => item.version), [1, 2]);
	const forbidden = await saveRequestPresetVersion(repos, {
		workspaceId: 'ws-1', ownerUserId: 'user-2', slug: 'analysis', systemPrompt: null, config: { model: 'x' },
	});
	assert.deepEqual(forbidden.ok ? null : [forbidden.status, forbidden.message], [403, 'Preset slug is owned by another user']);
});
