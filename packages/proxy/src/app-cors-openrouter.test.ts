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

describe('native asynchronous transcription browser CORS contract', () => {
	it('allows task receipts in a GET header without requiring URL credentials or storage access', async () => {
		let storageCalls = 0;
		const app = createProxyApp(async () => {
			storageCalls++;
			throw new Error('Preflight must not resolve storage');
		});
		for (const prefix of ['/v1', '/api/v1']) {
			const response = await app.request(`${prefix}/dashscope/tasks/task-qa`, {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://console.example',
					'Access-Control-Request-Method': 'GET',
					'Access-Control-Request-Headers': 'Authorization,X-CinaToken-Task-Receipt',
				},
			});
			assert.equal(response.status, 204);
			const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '')
				.toLowerCase()
				.split(',');
			assert.ok(allowed.includes('authorization'));
			assert.ok(allowed.includes('x-cinatoken-task-receipt'));
			assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /GET/);
			const exposed = (response.headers.get('Access-Control-Expose-Headers') ?? '')
				.toLowerCase()
				.split(',');
			assert.ok(exposed.includes('x-cinatoken-settlement-basis'));
			assert.ok(exposed.includes('x-cinatoken-request-id'));
			assert.equal(exposed.includes('x-cinatoken-task-receipt'), false);
			assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false);
		}
		assert.equal(storageCalls, 0);
	});
});

describe('MCP browser client CORS contract', () => {
	it('allows aggregate and scoped JSON-RPC preflight without storage or cookie credentials', async () => {
		let storageCalls = 0;
		const app = createProxyApp(async () => {
			storageCalls++;
			throw new Error('MCP preflight must not resolve storage');
		});
		for (const path of ['/mcp', '/mcp/docs']) {
			const response = await app.request(path, {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://console.example',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'Authorization,Content-Type,MCP-Protocol-Version',
				},
			});
			assert.equal(response.status, 204);
			const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '')
				.toLowerCase()
				.split(',');
			assert.ok(allowed.includes('authorization'));
			assert.ok(allowed.includes('content-type'));
			assert.ok(allowed.includes('mcp-protocol-version'));
			assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /POST/);
			assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false);
		}
		assert.equal(storageCalls, 0);
	});
});
