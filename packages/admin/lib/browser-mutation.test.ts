import assert from 'node:assert/strict';
import test from 'node:test';
import {
	checkBrowserMutationOrigin,
	rejectInvalidAdminMutationOrigin,
} from './browser-mutation';

const APP_ORIGIN = 'https://cinatoken.com';

test('allows safe methods without an Origin header', () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(new Request(`${APP_ORIGIN}/api/user/me`)),
		{ allowed: true },
	);
});

test('allows an exact same-origin mutation', () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, {
				method: 'POST',
				headers: { origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin' },
			}),
		),
		{ allowed: true },
	);
});

test('rejects a mutation with no Origin header', () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, { method: 'POST' }),
		),
		{ allowed: false, reason: 'missing_origin' },
	);
});

test('rejects a cross-origin mutation', () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, {
				method: 'POST',
				headers: { origin: 'https://attacker.example' },
			}),
		),
		{ allowed: false, reason: 'origin_mismatch' },
	);
});

test('rejects an explicitly cross-site request even when Origin is forged in a test client', () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, {
				method: 'POST',
				headers: { origin: APP_ORIGIN, 'sec-fetch-site': 'cross-site' },
			}),
		),
		{ allowed: false, reason: 'cross_site' },
	);
});

test('preserves cross-origin mutations authenticated by a named admin API key', () => {
	const request = new Request(`${APP_ORIGIN}/api/admin/providers`, {
		method: 'POST',
		headers: { origin: 'https://automation.example', authorization: 'Bearer sk-admin-test' },
	});
	assert.equal(rejectInvalidAdminMutationOrigin(request, 'api_key'), null);
});

test('blocks the same attacker request when authentication came from a console cookie', async () => {
	const request = new Request(`${APP_ORIGIN}/api/admin/providers`, {
		method: 'POST',
		headers: { origin: 'https://attacker.example', cookie: 'admin_session=stolen' },
	});
	const response = rejectInvalidAdminMutationOrigin(request, 'console');
	assert.equal(response?.status, 403);
	assert.deepEqual(await response?.json(), {
		success: false,
		message: 'Forbidden: invalid request origin',
	});
});
