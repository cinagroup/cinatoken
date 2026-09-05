import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ACCOUNT_CAPABILITIES,
	ADMIN_CONSOLE_CAPABILITY,
	getAccountCapabilities,
	getSessionCookieToken,
	getAllBrowserSessionTokens,
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

test('unrelated malformed cookies do not log out a valid browser session', () => {
	const request = new Request('https://cinatoken.com/api/user/me', {
		headers: { cookie: 'theme=broken%; cinatoken_session=valid; user_session=legacy' },
	});
	assert.equal(getSessionCookieToken(request, 'user_session'), 'valid');
	const invalidPreferred = new Request(request.url, { headers: { cookie: 'cinatoken_session=broken%; user_session=legacy' } });
	assert.equal(getSessionCookieToken(invalidPreferred, 'user_session'), '');
});

test('logout gathers distinct unified and legacy credentials, ignoring unrelated cookies', () => {
	const request = new Request('https://cinatoken.com/api/auth/logout', {
		headers: { cookie: 'theme=broken%; cinatoken_session=one; admin_session=two; user_session=three' },
	});
	assert.deepEqual(getAllBrowserSessionTokens(request), ['one', 'two', 'three']);
	assert.deepEqual(getAllBrowserSessionTokens(new Request(request.url, {
		headers: { cookie: 'cinatoken_session=one; admin_session=one; user_session=broken%' },
	})), ['one']);
});

test('verified administrators receive account and admin capabilities', () => {
	assert.deepEqual(getAccountCapabilities(true), [
		...ACCOUNT_CAPABILITIES,
		ADMIN_CONSOLE_CAPABILITY,
	]);
});
