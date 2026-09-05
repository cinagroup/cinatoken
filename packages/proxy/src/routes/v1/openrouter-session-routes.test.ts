import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
	GatewayRepositories,
	ResolvedGatewayKeyRow,
	StorageContext,
} from '@octafuse/core';
import { createProxyApp } from '../../app';

function gatewayKey(): ResolvedGatewayKeyRow {
	return {
		id: 'key-1', key: 'sk-test', user_id: 'user-1', workspace_id: 'workspace-1',
		name: 'Test', status: 'active', metadata: null, last_used_at: null,
		created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
		user_email: 'owner@example.com', user_metadata: null,
		user_charged_cost_factors: null, budget_max: 100, budget_base: 100,
		budget_spent: 0, budget_period: 'none', budget_reset_at: null,
		budget_epoch: 0, budget_reserved_micros: 0,
	};
}

function app() {
	const repositories = {
		apiKeys: {
			getApiKeyWithUserByKey: async (key: string) => key === 'sk-test' ? gatewayKey() : null,
		},
	} as GatewayRepositories;
	return createProxyApp(async () => ({ repositories } as StorageContext));
}

describe('OpenRouter session route boundary', () => {
	for (const path of [
		'/v1/chat/completions',
		'/v1/responses',
		'/v1/messages',
	]) {
		it(`rejects non-string body session_id before any routing lookup on ${path}`, async () => {
			const response = await app().request(path, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer sk-test',
					'Content-Type': 'application/json',
					'x-session-id': 'valid-header-must-not-win',
				},
				body: JSON.stringify({ model: 'vendor/model', session_id: 7 }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 400);
			assert.match(await response.text(), /session_id must be a string/u);
		});

		it(`rejects an oversized x-session-id before any routing lookup on ${path}`, async () => {
			const response = await app().request(path, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer sk-test',
					'Content-Type': 'application/json',
					'x-session-id': 'x'.repeat(257),
				},
				body: JSON.stringify({ model: 'vendor/model' }),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 400);
			assert.match(await response.text(), /x-session-id must not exceed 256 characters/u);
		});
	}

	it('accepts session grouping only through x-session-id on Embeddings', async () => {
		const bodySession = await app().request('/v1/embeddings', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer sk-test',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ model: 'vendor/model', input: 'hello', session_id: 'not-allowed' }),
		}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(bodySession.status, 400);
		assert.match(await bodySession.text(), /use x-session-id/u);

		const oversizedHeader = await app().request('/v1/embeddings', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer sk-test',
				'Content-Type': 'application/json',
				'x-session-id': 'x'.repeat(257),
			},
			body: JSON.stringify({ model: 'vendor/model', input: 'hello' }),
		}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(oversizedHeader.status, 400);
		assert.match(await oversizedHeader.text(), /x-session-id must not exceed 256 characters/u);
	});

	for (const [path, body] of [
		['/v1/images', { model: 'vendor/image', prompt: 'hello', session_id: 'not-allowed' }],
		['/v1/images/generations', { model: 'vendor/image', prompt: 'hello', session_id: 'not-allowed' }],
		['/v1/audio/speech', {
			model: 'vendor/tts', input: 'hello', voice: 'alloy', session_id: 'not-allowed',
		}],
		['/v1/audio/transcriptions', {
			model: 'vendor/stt', input_audio: { data: 'AQID', format: 'wav' },
			session_id: 'not-allowed',
		}],
	] as const) {
		it(`accepts session grouping only through x-session-id on ${path}`, async () => {
			const bodySession = await app().request(path, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer sk-test',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(bodySession.status, 400);
			assert.match(await bodySession.text(), /use x-session-id/u);

			const oversizedHeader = await app().request(path, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer sk-test',
					'Content-Type': 'application/json',
					'x-session-id': 'x'.repeat(257),
				},
				body: JSON.stringify(body),
			}, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(oversizedHeader.status, 400);
			assert.match(await oversizedHeader.text(), /x-session-id must not exceed 256 characters/u);
		});
	}

	it('rejects body session_id on multipart image edits', async () => {
		const form = new FormData();
		form.append('model', 'vendor/image');
		form.append('prompt', 'hello');
		form.append('session_id', 'not-allowed');
		const response = await app().request('/v1/images/edits', {
			method: 'POST',
			headers: { Authorization: 'Bearer sk-test' },
			body: form,
		}, { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(response.status, 400);
		assert.match(await response.text(), /use x-session-id/u);
	});
});
