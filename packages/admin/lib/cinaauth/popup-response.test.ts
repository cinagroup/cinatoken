import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCinaAuthPopupCompletionResponse } from './popup-response';

const requestId = '01890d4a-2f67-4a91-8b90-bbdcd0f584b6';

describe('CinaAuth popup completion response', () => {
	it('returns a non-cacheable, isolated completion document', async () => {
		const response = createCinaAuthPopupCompletionResponse({
			requestId,
			appOrigin: 'https://cinatoken.com',
			callbackPath: '/account',
			ok: true,
		});
		const body = await response.text();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
		assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
		assert.match(body, new RegExp(`cinatoken:cinaauth-popup:${requestId}`, 'u'));
		assert.match(body, /localStorage\.setItem/u);
		assert.match(body, /window\.close\(\)/u);
		assert.match(body, /https:\/\/cinatoken\.com/u);
	});

	it('escapes inline-script delimiters in serialized values', async () => {
		const response = createCinaAuthPopupCompletionResponse({
			requestId,
			appOrigin: 'https://cinatoken.com',
			callbackPath: '/account?</script><script>alert(1)</script>',
			ok: false,
			error: 'oidc_failed',
		});
		const body = await response.text();
		assert.doesNotMatch(body, /<\/script><script>/u);
		assert.match(body, /\\u003c\/script\\u003e/u);
	});
});
