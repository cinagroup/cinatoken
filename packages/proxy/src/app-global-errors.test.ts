import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, StorageContext } from '@octafuse/core';
import { createProxyApp } from './app';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from './services/gateway-error-codes';

function appWithEmptyStorage() {
	return createProxyApp(async () => ({ repositories: {} as GatewayRepositories } as StorageContext), {
		requestBodyLogging: 'off',
	});
}

describe('global OpenRouter error contract', () => {
	it('returns the typed nested envelope for an unknown route', async () => {
		const response = await appWithEmptyStorage().request('/api/v1/does-not-exist');
		assert.equal(response.status, 404);
		assert.equal(response.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.routeNotFound);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await response.json(), {
			error: {
				code: 404,
				message: 'Resource not found',
				metadata: { error_type: 'not_found' },
			},
			code: GatewayErrorCode.routeNotFound,
		});
	});

	it('returns payload_too_large instead of Hono plain text', async () => {
		const response = await appWithEmptyStorage().request('/api/v1/does-not-exist', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': String(50 * 1024 * 1024 + 1),
			},
			body: '{}',
		});
		assert.equal(response.status, 413);
		assert.equal(response.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.payloadTooLarge);
		const body = await response.json() as { error?: { metadata?: { error_type?: string } } };
		assert.equal(body.error?.metadata?.error_type, 'payload_too_large');
	});

	it('masks unexpected failures behind the typed 500 envelope', async () => {
		const app = appWithEmptyStorage();
		app.get('/boom', () => {
			throw new Error('postgres://private-host with sk-secret');
		});
		const response = await app.request('/boom');
		assert.equal(response.status, 500);
		assert.equal(response.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.internalError);
		const serialized = JSON.stringify(await response.json());
		assert.match(serialized, /Internal server error/u);
		assert.doesNotMatch(serialized, /private-host|sk-secret|postgres/iu);
	});
});
