import assert from 'node:assert/strict';
import { it } from 'node:test';
import { NextResponse } from 'next/server';
import { clearCinaAuthTransactionCookies } from './logout-cookies';
import { CINATOKEN_OIDC_TRANSACTION_COOKIE, cinaAuthTransactionCookieName } from './transaction';

it('expires all legacy and scoped transaction cookies with valid __Host- attributes', () => {
	const response = new NextResponse();
	const names = [CINATOKEN_OIDC_TRANSACTION_COOKIE,
		cinaAuthTransactionCookieName('a'.repeat(43))!, cinaAuthTransactionCookieName('b'.repeat(43))!];
	for (const name of names) response.cookies.set(name, 'test-transaction', {
		httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600,
	});
	response.cookies.set('theme', 'dark');
	response.cookies.set(`${CINATOKEN_OIDC_TRANSACTION_COOKIE}_unrelated`, 'keep');

	clearCinaAuthTransactionCookies(response.cookies);

	for (const name of names) {
		const cookie = response.cookies.get(name)!;
		assert.equal(cookie.value, '');
		assert.equal(cookie.maxAge, 0);
		assert.equal(cookie.httpOnly, true);
		assert.equal(cookie.secure, true);
		assert.equal(cookie.path, '/');
		assert.equal(cookie.sameSite, 'lax');
		assert.equal(cookie.domain, undefined);
		const header = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))!;
		assert.match(header, /; Secure(?:;|$)/u);
		assert.match(header, /; Max-Age=0(?:;|$)/u);
	}
	assert.equal(response.cookies.get('theme')?.value, 'dark');
	assert.equal(response.cookies.get(`${CINATOKEN_OIDC_TRANSACTION_COOKIE}_unrelated`)?.value, 'keep');
});
