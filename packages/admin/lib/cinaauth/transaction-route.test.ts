import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { GET as startLogin } from '@/app/api/auth/cinaauth/login/route';
import { GET as finishLogin } from '@/app/api/auth/cinaauth/callback/route';
import { cinaAuthTransactionCookieName, openCinaAuthTransaction } from './transaction';

const secret = 'test-transaction-secret-that-is-long-enough-1234';
const issuer = 'https://auth.cinaseek.ai';
function request(url: string, cookie?: string) {
	return Object.assign(new NextRequest(url, { headers: cookie ? { cookie } : undefined }), {
		env: {
			CINATOKEN_OIDC_CLIENT_SECRET: secret,
			CINATOKEN_OIDC_BRIDGE_SECRET: secret,
			CINATOKEN_OIDC_TRANSACTION_SECRET: secret,
			CINAAUTH_AUTH_SERVICE: { fetch: async (input: Request) => {
				assert.equal(new URL(input.url).pathname, '/.well-known/openid-configuration');
				return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
			} },
		},
	});
}

describe('CinaAuth concurrent authorization HTTP routes', () => {
	it('issues distinct protected cookies and clears only the matching tab when login is denied', async () => {
		const [first, second] = await Promise.all(['portal', 'admin'].map(intent => startLogin(request(
			`https://cinatoken.com/api/auth/cinaauth/login?intent=${intent}&presentation=popup&request=${crypto.randomUUID()}`,
		))));
		const responses = [first, second];
		const states = responses.map(response => new URL(response.headers.get('location')!).searchParams.get('state')!);
		const issued = responses.map(response => response.cookies.getAll()[0]);
		assert.notEqual(issued[0].name, issued[1].name);
		for (let index = 0; index < responses.length; index += 1) {
			assert.equal(responses[index].status, 302);
			assert.equal(issued[index].name, cinaAuthTransactionCookieName(states[index]));
			assert.equal(issued[index].httpOnly, true);
			assert.equal(issued[index].secure, true);
			assert.equal(issued[index].sameSite, 'lax');
			assert.equal(issued[index].path, '/');
			assert.equal(issued[index].maxAge, 600);
			assert.equal((await openCinaAuthTransaction(issued[index].value, secret))?.state, states[index]);
		}
		const jar = issued.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
		for (let index = 0; index < states.length; index += 1) {
			const response = await finishLogin(request(`https://cinatoken.com/api/auth/cinaauth/callback?error=access_denied&state=${states[index]}`, jar));
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('cache-control'), 'no-store');
			assert.deepEqual(response.cookies.getAll().map(cookie => [cookie.name, cookie.maxAge]), [[issued[index].name, 0]]);
			assert.match(await response.text(), /"ok":false/u);
		}
	});
	it('does not clear another tab when the callback state is unknown', async () => {
		const started = await startLogin(request('https://cinatoken.com/api/auth/cinaauth/login?intent=portal'));
		const cookie = started.cookies.getAll()[0];
		const response = await finishLogin(request(
			`https://cinatoken.com/api/auth/cinaauth/callback?state=${'z'.repeat(43)}&error=access_denied`,
			`${cookie.name}=${cookie.value}`,
		));
		assert.equal(response.status, 302);
		assert.match(response.headers.get('location')!, /auth_error=invalid_transaction/u);
		assert.deepEqual(response.cookies.getAll(), []);
	});
});
