import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	CreateRequestPresetParams,
	GatewayRepositories,
	RequestPresetVersionRow,
	RequestPresetWithVersionRow,
	ResolvedGatewayKeyRow,
	StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';

const OWNER_SECRET = 'sk-preset-owner';
const FOREIGN_SECRET = 'sk-preset-foreign';

function authRow(secret: string): ResolvedGatewayKeyRow {
	const foreign = secret === FOREIGN_SECRET;
	return {
		id: foreign ? 'key-foreign' : 'key-owner',
		key: 'sk-redacted',
		user_id: foreign ? 'user-foreign' : 'user-owner',
		workspace_id: foreign ? 'personal:user-foreign' : 'personal:user-owner',
		name: 'Preset test',
		status: 'active',
		metadata: null,
		expires_at: null,
		limit_micros: null,
		limit_reset: null,
		include_byok_in_limit: false,
		limit_epoch: 0,
		last_used_at: null,
		created_at: '2026-09-01T00:00:00.000Z',
		updated_at: '2026-09-01T00:00:00.000Z',
		user_email: null,
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_max: 0,
		budget_base: 0,
		budget_spent: 1,
		budget_period: 'none',
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
	};
}

function fixture() {
	const presets = new Map<string, RequestPresetWithVersionRow>();
	const versions = new Map<string, RequestPresetVersionRow[]>();

	function selected(params: CreateRequestPresetParams, version = 1): RequestPresetWithVersionRow {
		return {
			id: params.id,
			workspace_id: params.workspaceId,
			owner_user_id: params.ownerUserId,
			slug: params.slug,
			name: params.name,
			description: params.description,
			visibility: params.visibility,
			status: 'active',
			designated_version: version,
			latest_version: version,
			created_at: params.nowIso,
			updated_at: params.nowIso,
			version_id: params.versionId,
			version_system_prompt: params.systemPrompt,
			version_config_json: params.configJson,
			version_created_by_user_id: params.createdByUserId,
			version_created_at: params.nowIso,
		};
	}

	const requestPresets = {
		async listVisibleByWorkspacePage(workspaceId: string, userId: string, page: { offset: number; limit: number }) {
			const data = [...presets.values()]
				.filter((row) => row.workspace_id === workspaceId && (
					row.owner_user_id === userId || (row.visibility === 'public' && row.status === 'active')
				))
				.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
			return { data: data.slice(page.offset, page.offset + page.limit), totalCount: data.length };
		},
		async getVisibleBySlug(slug: string, workspaceId: string, userId: string) {
			return [...presets.values()].find((row) => row.slug === slug && row.workspace_id === workspaceId && (
				row.owner_user_id === userId || (row.visibility === 'public' && row.status === 'active')
			)) ?? null;
		},
		async listVersionsPage(presetId: string, page: { offset: number; limit: number }) {
			const data = [...(versions.get(presetId) ?? [])].sort((a, b) => a.version - b.version);
			return { data: data.slice(page.offset, page.offset + page.limit), totalCount: data.length };
		},
		async getVersion(presetId: string, version: number) {
			return versions.get(presetId)?.find((row) => row.version === version) ?? null;
		},
		async getBySlug(slug: string, workspaceId: string) {
			return [...presets.values()].find((row) => row.slug === slug && row.workspace_id === workspaceId) ?? null;
		},
		async getById(id: string) {
			return presets.get(id) ?? null;
		},
		async createWithVersion(params: CreateRequestPresetParams) {
			if ([...presets.values()].some((row) => row.workspace_id === params.workspaceId && row.slug === params.slug)) {
				throw new Error('duplicate preset slug');
			}
			const row = selected(params);
			presets.set(row.id, row);
			versions.set(row.id, [{
				id: params.versionId,
				preset_id: row.id,
				version: 1,
				system_prompt: params.systemPrompt,
				config_json: params.configJson,
				created_by_user_id: params.createdByUserId,
				created_at: params.nowIso,
			}]);
			return row;
		},
		async addVersion(params: {
			presetId: string; versionId: string; systemPrompt: string | null;
			configJson: string; createdByUserId: string | null; nowIso: string;
		}) {
			const current = presets.get(params.presetId);
			if (!current || current.status !== 'active') throw new Error('preset is unavailable');
			const version = current.latest_version + 1;
			const versionRow: RequestPresetVersionRow = {
				id: params.versionId,
				preset_id: current.id,
				version,
				system_prompt: params.systemPrompt,
				config_json: params.configJson,
				created_by_user_id: params.createdByUserId,
				created_at: params.nowIso,
			};
			versions.set(current.id, [...(versions.get(current.id) ?? []), versionRow]);
			const next: RequestPresetWithVersionRow = {
				...current,
				designated_version: version,
				latest_version: version,
				updated_at: params.nowIso,
				version_id: versionRow.id,
				version_system_prompt: versionRow.system_prompt,
				version_config_json: versionRow.config_json,
				version_created_by_user_id: versionRow.created_by_user_id,
				version_created_at: versionRow.created_at,
			};
			presets.set(current.id, next);
			return next;
		},
		async updateMetadata(id: string) {
			return presets.has(id);
		},
	} as unknown as GatewayRepositories['requestPresets'];

	const repositories = {
		apiKeys: {
			getApiKeyWithUserByKey: async (secret: string) =>
				secret === OWNER_SECRET || secret === FOREIGN_SECRET ? authRow(secret) : null,
		},
		requestPresets,
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ repositories } as StorageContext));
	return {
		presets,
		versions,
		request: (path: string, init?: RequestInit) => app.request(path, init, { REQUEST_BODY_LOGGING: 'off' }),
	};
}

function requestInit(secret: string, method = 'GET', body?: unknown): RequestInit {
	return {
		method,
		headers: {
			Authorization: `Bearer ${secret}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

test('Preset API captures configuration without dispatching inference and returns OpenRouter DTOs', async () => {
	const { request } = fixture();
	assert.equal((await request('/api/v1/presets')).status, 401);

	const created = await request('/api/v1/presets/support/chat/completions', requestInit(OWNER_SECRET, 'POST', {
		model: 'deepseek/deepseek-chat',
		temperature: 0.2,
		provider: { sort: 'price' },
		messages: [
			{ role: 'system', content: 'Answer concisely.' },
			{ role: 'user', content: 'This must not be stored.' },
		],
		stream: true,
		metadata: { customer: 'must-not-persist' },
		session_id: 'must-not-persist',
		unknown_future_field: 'ignored',
	}));
	assert.equal(created.status, 200);
	assert.equal(created.headers.get('Cache-Control'), 'private, no-store');
	const createdBody = await created.json() as { data: { designated_version: { config: Record<string, unknown>; system_prompt: string } } };
	assert.deepEqual(createdBody.data.designated_version.config, {
		model: 'deepseek/deepseek-chat',
		provider: { sort: 'price' },
		temperature: 0.2,
	});
	assert.equal(createdBody.data.designated_version.system_prompt, 'Answer concisely.');

	const list = await request('/api/v1/presets?offset=0&limit=1', requestInit(OWNER_SECRET));
	assert.equal(list.status, 200);
	assert.equal((await list.json() as { total_count: number }).total_count, 1);
	assert.equal((await request('/api/v1/presets?limit=101', requestInit(OWNER_SECRET))).status, 400);

	const updated = await request('/api/v1/presets/support/messages', requestInit(OWNER_SECRET, 'POST', {
		model: 'anthropic/claude-sonnet',
		max_tokens: 512,
		system: 'Review carefully.',
		messages: [{ role: 'user', content: 'Ignored request content' }],
	}));
	assert.equal(updated.status, 200);
	assert.equal((await updated.json() as { data: { designated_version: { version: number } } }).data.designated_version.version, 2);

	const responsePreset = await request('/api/v1/presets/support/responses', requestInit(OWNER_SECRET, 'POST', {
		model: 'openai/gpt-5',
		max_output_tokens: 1024,
		instructions: 'Use validated evidence.',
		input: 'Ignored request content',
	}));
	assert.equal(responsePreset.status, 200);
	const responsePresetBody = await responsePreset.json() as {
		data: { designated_version: { version: number; config: Record<string, unknown>; system_prompt: string } };
	};
	assert.equal(responsePresetBody.data.designated_version.version, 3);
	assert.deepEqual(responsePresetBody.data.designated_version.config, {
		model: 'openai/gpt-5',
		max_output_tokens: 1024,
	});
	assert.equal(responsePresetBody.data.designated_version.system_prompt, 'Use validated evidence.');

	const versions = await request('/api/v1/presets/support/versions?offset=0&limit=100', requestInit(OWNER_SECRET));
	assert.equal(versions.status, 200);
	const versionsBody = await versions.json() as { data: Array<{ version: number }>; total_count: number };
	assert.deepEqual(versionsBody.data.map((row) => row.version), [1, 2, 3]);
	assert.equal(versionsBody.total_count, 3);
	assert.equal((await request('/api/v1/presets/support/versions/1', requestInit(OWNER_SECRET))).status, 200);
	assert.equal((await request('/v1/presets/support', requestInit(OWNER_SECRET))).status, 200);
	assert.equal((await request('/api/v1/presets/support', requestInit(FOREIGN_SECRET))).status, 404);
});

test('Preset capture enforces protocol and body bounds without consuming inference budget', async () => {
	const { request } = fixture();
	assert.equal((await request('/api/v1/presets/invalid/chat/completions', requestInit(OWNER_SECRET, 'POST', {
		model: 'deepseek/deepseek-chat',
	}))).status, 400);
	assert.equal((await request('/api/v1/presets/invalid/messages', requestInit(OWNER_SECRET, 'POST', {
		messages: [],
	}))).status, 400);
	assert.equal((await request('/api/v1/presets/oversized/responses', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${OWNER_SECRET}`,
			'Content-Type': 'application/json',
			'Content-Length': String(2 * 1024 * 1024 + 1),
		},
		body: '{}',
	})).status, 413);
});
