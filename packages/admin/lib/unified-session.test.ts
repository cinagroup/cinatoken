import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ACCOUNT_CAPABILITIES,
	ADMIN_CONSOLE_CAPABILITY,
	getAccountCapabilities,
	getSessionCookieToken,
} from './unified-session';

test('prefers the unified cookie while accepting a legacy cookie during rollout', () => {
	const request = new Request('https://cinatoken.com/api/user/me', {
		headers: { cookie: 'user_session=legacy; cinatoken_session=unified' },
	});
	assert.equal(getSessionCookieToken(request, 'user_session'), 'unified');
	assert.equal(
		getSessionCookieToken(
			new Request('https://cinatoken.com/api/user/me', {
				headers: { cookie: 'user_session=legacy' },
			}),
			'user_session',
		),
		'legacy',
	);
});

test('ordinary accounts do not receive the admin console capability', () => {
	assert.deepEqual(getAccountCapabilities(false), [...ACCOUNT_CAPABILITIES]);
	assert.equal(getAccountCapabilities(false).includes(ADMIN_CONSOLE_CAPABILITY), false);
});

test('verified administrators receive account and admin capabilities', () => {
	assert.deepEqual(getAccountCapabilities(true), [
		...ACCOUNT_CAPABILITIES,
		ADMIN_CONSOLE_CAPABILITY,
	]);
});
