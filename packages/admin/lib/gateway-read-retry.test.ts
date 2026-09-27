import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DATABASE_UNAVAILABLE_CODE, withGatewayReadRetry } from './gateway-read-retry';
import { handleGatewayApiError } from './api-error';

const unavailable = () => Response.json({ code: DATABASE_UNAVAILABLE_CODE }, { status: 503 });
const request = (path = '/api/admin/stats', init?: RequestInit) => new Request(`https://cinatoken.com${path}`, init);

test('a replay-safe read starts a second attempt after transient database loss', async () => {
	let attempts = 0;
	const result = await withGatewayReadRetry(request(), async () => {
		attempts += 1;
		return attempts === 1 ? unavailable() : Response.json({ success: true, data: { count: 3 } });
	});
	assert.equal(attempts, 2);
	assert.equal(result.status, 200);
	assert.deepEqual(await result.json(), { success: true, data: { count: 3 } });
});

test('database retries stop after one replay; persistent failure stays 503', async () => {
	let attempts = 0;
	const result = await withGatewayReadRetry(request('/api/auth/check'), async () => { attempts++; return unavailable(); });
	assert.equal(attempts, 2);
	assert.equal(result.status, 503);
	assert.equal((await result.json() as { authenticated?: unknown }).authenticated, undefined);
});

for (const [name, req] of [
	['POST', request('/api/admin/stats', { method: 'POST' })],
	['PUT', request('/api/admin/config', { method: 'PUT' })],
	['DELETE', request('/api/admin/config', { method: 'DELETE' })],
	['PATCH', request('/api/admin/config', { method: 'PATCH' })],
	['Bearer auth', request('/api/admin/stats', { headers: { authorization: 'Bearer test-only' } })],
	['unreviewed GET', request('/api/admin/playground')],
	['path suffix', request('/api/admin/stats/delete')],
	['cancelled request', request('/api/admin/stats', { signal: AbortSignal.abort() })],
] as const) {
	test(`does not replay ${name}`, async () => {
		let attempts = 0;
		await withGatewayReadRetry(req, async () => { attempts++; return unavailable(); });
		assert.equal(attempts, 1);
	});
}

for (const status of [200, 400, 401, 403, 429, 500, 503]) {
	test(`does not retry an unclassified ${status} response or lose its body`, async () => {
		let attempts = 0;
		const result = await withGatewayReadRetry(request(), async () => { attempts++; return Response.json({ message: 'original' }, { status }); });
		assert.equal(attempts, 1);
		assert.deepEqual(await result.json(), { message: 'original' });
	});
}

test('after reconnect, authorization is checked again and denial remains denial', async () => {
	let attempts = 0;
	const response = await withGatewayReadRetry(request('/api/user/me'), async () => ++attempts === 1
		? unavailable() : Response.json({ success: false }, { status: 401 }));
	assert.equal(attempts, 2);
	assert.equal(response.status, 401);
});

test('nested connection errors become no-store 503 without credentials or false logout', async (t) => {
	const log = t.mock.method(console, 'error', () => undefined);
	const cause = Object.assign(new Error('write CONNECTION_CLOSED internal:5432'), { code: 'CONNECTION_CLOSED' });
	const response = handleGatewayApiError({ route: 'auth.check', error: new Error('Failed query\nparams: super-secret', { cause }) });
	assert.equal(response.status, 503);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.equal(response.headers.get('Retry-After'), '2');
	assert.equal(response.headers.get('Set-Cookie'), null);
	const body = await response.json() as { code?: string; authenticated?: boolean };
	assert.equal(body.code, DATABASE_UNAVAILABLE_CODE);
	assert.equal(body.authenticated, undefined);
	assert.ok(!JSON.stringify(body).includes('internal:5432'));
	assert.ok(!JSON.stringify(log.mock.calls).includes('super-secret'));
});

test('SQL/permission failures are not disguised as transient connection loss', (t) => {
	t.mock.method(console, 'error', () => undefined);
	for (const code of ['42501', '23505', '42601']) {
		const response = handleGatewayApiError({ route: 'test', error: Object.assign(new Error('SQL error'), { code }) });
		assert.equal(response.status, 500);
		assert.equal(response.headers.get('Retry-After'), null);
	}
});
