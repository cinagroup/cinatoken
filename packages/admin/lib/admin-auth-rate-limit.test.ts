import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectRateLimitedAdminAuth } from './admin-auth-rate-limit';

test('uses AUTH_RATE_LIMITER and keys failed admin auth by Cloudflare client IP', async () => {
	let observedKey = '';
	const response = await rejectRateLimitedAdminAuth(
		new Request('https://cinatoken.com/api/admin/models', {
			headers: { 'CF-Connecting-IP': '203.0.113.9' },
		}),
		{
			AUTH_RATE_LIMITER: {
				limit: async ({ key }) => {
					observedKey = key;
					return { success: false };
				},
			},
		},
	);

	assert.equal(observedKey, '203.0.113.9');
	assert.equal(response?.status, 429);
	assert.equal(response?.headers.get('Retry-After'), '60');
	assert.equal(response?.headers.get('Cache-Control'), 'no-store');
});

test('keeps normal authentication semantics when limiter allows or fails', async () => {
	assert.equal(await rejectRateLimitedAdminAuth(new Request('https://cinatoken.com'), {
		AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
	}), null);
	assert.equal(await rejectRateLimitedAdminAuth(new Request('https://cinatoken.com'), {
		AUTH_RATE_LIMITER: { limit: async () => { throw new Error('binding unavailable'); } },
	}), null);
});
