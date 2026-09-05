import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import {
	MAX_RERANK_DOCUMENTS,
	rerankRoutes,
	validateRerankBody,
} from './rerank';

describe('rerank request validation', () => {
	it('accepts text, image, and multimodal document forms', () => {
		const result = validateRerankBody({
			model: 'cohere/rerank-v3.5',
			query: '',
			documents: [
				'a',
				{ text: '' },
				{ image: 'https://example.test/image.png' },
				{ text: 'caption', image: 'data:image/png;base64,AQIDBA==' },
			],
			top_n: 2,
			provider: { only: ['Cohere'] },
		});
		assert.deepEqual(result, {
			ok: true,
			modelId: 'cohere/rerank-v3.5',
			documentCount: 4,
			documentKinds: ['text', 'text', 'image', 'multimodal'],
		});
		assert.equal(validateRerankBody({
			model: 'cohere/rerank-v3.5', query: 'q', documents: ['a'], provider: null,
		}).ok, true);
	});

	it('rejects undocumented fields, invalid documents, streaming, and unsafe batch sizes', () => {
		const invalid = [
			{ model: 'm', query: 'q', documents: [] },
			{ model: 'm', query: 'q', documents: new Array(MAX_RERANK_DOCUMENTS + 1).fill('x') },
			{ model: 'm', query: 1, documents: ['x'] },
			{ model: 'm', query: 'q', documents: [{ other: 'x' }] },
			{ model: 'm', query: 'q', documents: [{ image: 'file:///secret' }] },
			{ model: 'm', query: 'q', documents: ['x'], top_n: 0 },
			{ model: 'm', query: 'q', documents: ['x'], stream: false },
			{ model: 'm', query: 'q', documents: ['x'], session_id: 'body-session' },
			{ model: 'm', query: 'q', documents: ['x'], unknown: true },
		];
		for (const body of invalid) assert.equal(validateRerankBody(body).ok, false);
	});
});

describe('rerank route ingress', () => {
	function app() {
		const repositories = {
			apiKeys: { getApiKeyWithUserByKey: async () => null },
		} as unknown as GatewayRepositories;
		const value = new Hono<Env>();
		value.use('*', async (c, next) => { c.set('repositories', repositories); await next(); });
		value.route('/v1/rerank', rerankRoutes);
		return value;
	}

	it('requires a Gateway key before reading the body', async () => {
		const response = await app().request('/v1/rerank', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{',
		}, {} as Env['Bindings']);
		assert.equal(response.status, 401);
	});

	it('requires application/json for authenticated-shaped requests', async () => {
		const repositories = {
			apiKeys: { getApiKeyWithUserByKey: async () => ({
				id: 'key-1', key: 'sk-test', user_id: 'user-1', workspace_id: 'personal:user-1',
				name: 'Test', status: 'active', metadata: null, last_used_at: null,
				created_at: '2026-09-04T00:00:00.000Z', updated_at: '2026-09-04T00:00:00.000Z',
				user_email: 'user@example.com', user_metadata: null, user_charged_cost_factors: null,
				budget_max: null, budget_base: 0, budget_spent: 0, budget_period: 'none',
				budget_reset_at: null, budget_epoch: 0, budget_reserved_micros: 0,
			}) },
		} as unknown as GatewayRepositories;
		const value = new Hono<Env>();
		value.use('*', async (c, next) => { c.set('repositories', repositories); await next(); });
		value.route('/v1/rerank', rerankRoutes);
		const response = await value.request('/v1/rerank', {
			method: 'POST',
			headers: { Authorization: 'Bearer sk-test', 'Content-Type': 'text/plain' },
			body: '{}',
		});
		assert.equal(response.status, 400);
		assert.equal(response.headers.get('x-octafuse-error-code'), 'gateway.invalid_request');
	});
});
