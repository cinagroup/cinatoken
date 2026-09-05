import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	ResolvedGatewayKeyRow,
	StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';
import { GatewayErrorCode } from '../../services/gateway-error-codes';

function exhaustedGatewayKey(): ResolvedGatewayKeyRow {
	return {
		id: 'key-completions',
		key: 'sk-completions-test',
		user_id: 'user-1',
		workspace_id: 'workspace-1',
		name: 'Legacy completions test',
		status: 'active',
		metadata: null,
		last_used_at: null,
		created_at: '2026-09-01T00:00:00.000Z',
		updated_at: '2026-09-01T00:00:00.000Z',
		user_email: 'owner@example.com',
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_max: 1,
		budget_base: 1,
		budget_spent: 1,
		budget_period: 'none',
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
	};
}

describe('legacy Completions route control boundary', () => {
	it('uses route-level atomic budget admission and validates before touching model storage', async () => {
		let modelStorageTouched = false;
		const repositories = {
			apiKeys: {
				getApiKeyWithUserByKey: async (key: string) =>
					key === 'sk-completions-test' ? exhaustedGatewayKey() : null,
			},
			models: new Proxy({}, {
				get() {
					modelStorageTouched = true;
					throw new Error('model storage must not be reached for an invalid legacy request');
				},
			}),
		} as unknown as GatewayRepositories;
		const app = createProxyApp(async () => ({ repositories } as StorageContext));

		for (const path of ['/v1/completions', '/api/v1/completions']) {
			const response = await app.request(path, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer sk-completions-test',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ model: 'public/model', prompt: ['batch', 'unsupported'] }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 400, path);
			assert.match(response.headers.get('x-generation-id') ?? '', /^gen-/u);
			const body = await response.json() as Record<string, unknown>;
			assert.equal(body.code, GatewayErrorCode.invalidRequest);
			assert.match(JSON.stringify(body), /batched and token-array prompts are not supported/u);
		}
		assert.equal(modelStorageTouched, false);
	});
});
