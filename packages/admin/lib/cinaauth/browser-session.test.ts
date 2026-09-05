import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCinaAuthBrowserSession } from './browser-session';

const respond = (body: unknown, status = 200): typeof fetch => async () => Response.json(body, { status });

describe('popup session verification', () => {
	it('requires a real successful portal session response', async () => {
		assert.equal(await checkCinaAuthBrowserSession('portal', respond({ success: true, data: { userId: 'u1' } })), 'authenticated');
		assert.equal(await checkCinaAuthBrowserSession('portal', respond({ success: false, data: { userId: 'u1' } })), 'unavailable');
		assert.equal(await checkCinaAuthBrowserSession('portal', respond({ success: true })), 'unavailable');
	});
	it('distinguishes an expired session from a service failure', async () => {
		for (const intent of ['portal', 'admin'] as const) {
			assert.equal(await checkCinaAuthBrowserSession(intent, respond({}, 401)), 'unauthenticated');
			assert.equal(await checkCinaAuthBrowserSession(intent, respond({}, 503)), 'unavailable');
			assert.equal(await checkCinaAuthBrowserSession(intent, async () => { throw new Error('offline'); }), 'unavailable');
			assert.equal(await checkCinaAuthBrowserSession(intent, async () => new Response('<html>')), 'unavailable');
		}
	});
	it('uses admin server authentication rather than a completion message to grant navigation', async () => {
		assert.equal(await checkCinaAuthBrowserSession('admin', respond({ authenticated: true, verification: 'degraded' })), 'authenticated');
		assert.equal(await checkCinaAuthBrowserSession('admin', respond({ authenticated: false })), 'unauthenticated');
		assert.equal(await checkCinaAuthBrowserSession('admin', respond({ ok: true })), 'unavailable');
	});
});
