import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProxyApp } from './app';

describe('OpenRouter browser-client CORS contract', () => {
	it('allows compatibility request headers and exposes generation/retry headers', async () => {
		let storageResolved = false;
		const app = createProxyApp(async () => {
			storageResolved = true;
			throw new Error('CORS preflight must not resolve storage');
		});
		const response = await app.request('/api/v1/chat/completions', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://client.example',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'Authorization,X-OpenRouter-Metadata,X-OpenRouter-Title',
			},
		});

		assert.equal(response.status, 204);
		assert.equal(storageResolved, false);
		const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
		assert.match(allowed, /authorization/);
		assert.match(allowed, /x-openrouter-metadata/);
		assert.match(allowed, /x-openrouter-title/);
		const exposed = (response.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase();
		assert.match(exposed, /x-generation-id/);
		assert.match(exposed, /retry-after/);
	});
});
