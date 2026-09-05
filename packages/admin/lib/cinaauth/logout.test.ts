import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requestCinaAuthLogout } from './logout';

describe('CinaAuth logout confirmation', () => {
	it('uses the unified idempotent session endpoint and requires explicit server success', async () => {
		assert.equal(await requestCinaAuthLogout(async (url, options) => {
			assert.equal(url, '/api/auth/logout');
			assert.equal(options?.method, 'POST');
			assert.equal(options?.cache, 'no-store');
			assert.ok(options?.signal);
			return Response.json({ success: true });
		}), true);
	});
	it('does not report success for a 500, rejection, malformed response, or network error', async () => {
		for (const response of [
			Response.json({ success: true }, { status: 500 }),
			Response.json({ success: false }),
			Response.json({}),
			new Response('<html>service unavailable</html>'),
		]) {
			assert.equal(await requestCinaAuthLogout(async () => response), false);
		}
		assert.equal(await requestCinaAuthLogout(async () => { throw new Error('network failure'); }), false);
	});
});
