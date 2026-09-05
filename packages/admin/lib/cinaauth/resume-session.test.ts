import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashSessionToken } from '@/lib/auth';
import { canResumeCinaAuthSession } from './resume-session';
import { CinaAuthConsoleVerificationUnavailableError } from './principal';

const token = 'test-session-token';
const request = Object.assign(new Request('https://cinatoken.com/api/auth/cinaauth/login', {
	headers: { cookie: `cinatoken_session=${token}` },
}), { env: { CINATOKEN_OIDC_BRIDGE_SECRET: 'test-bridge-secret-that-is-long-enough-12345' } });

function fixtures(options: { portal?: boolean; admin?: boolean; disabled?: boolean } = {}) {
	const writes = () => { throw new Error('Session resumption must not mutate session or user records'); };
	const repositories = {
		adminAccess: {
			getActiveApiKeyBySecret: async () => null,
			touchApiKey: writes,
			getValidSession: async (hash: string) => {
				assert.equal(hash, await hashSessionToken(token));
				return options.admin ? { username: 'cinaauth:subject-1' } : null;
			},
		},
		portalAccess: { getValidSession: async (hash: string) => {
			assert.equal(hash, await hashSessionToken(token));
			return options.portal ? { subject: 'subject-1' } : null;
		} },
		users: {
			getByExternalPair: async () => ({ id: 'u1', email: 'test@example.com', status: options.disabled ? 'disabled' : 'active' }),
			createUser: writes,
		},
	} as unknown as Parameters<typeof canResumeCinaAuthSession>[2];
	return repositories;
}

describe('existing CinaAuth session resumption', () => {
	it('reuses the portal side of a unified admin session without writes or an IdP request', async () => {
		const bindings = { CINAAUTH_AUTH_SERVICE: { fetch: async () => { throw new Error('No IdP needed'); } } as unknown as Fetcher };
		assert.equal(await canResumeCinaAuthSession(request, 'portal', fixtures({ portal: true, admin: true }), bindings), true);
	});
	it('rejects an expired portal session and a disabled local user', async () => {
		assert.equal(await canResumeCinaAuthSession(request, 'portal', fixtures()), false);
		assert.equal(await canResumeCinaAuthSession(request, 'portal', fixtures({ portal: true, disabled: true })), false);
	});
	it('never elevates a portal-only session into administrator access', async () => {
		assert.equal(await canResumeCinaAuthSession(request, 'admin', fixtures({ portal: true })), false);
	});
	it('still requires a live eligible role before resuming an admin session', async () => {
		for (const role of ['super_admin', 'user']) {
			const bindings = { CINAAUTH_AUTH_SERVICE: { fetch: async () => Response.json({ ok: true, user: { id: 'subject-1', role } }) } as unknown as Fetcher };
			assert.equal(await canResumeCinaAuthSession(request, 'admin', fixtures({ admin: true }), bindings), role === 'super_admin');
		}
		const unavailable = { CINAAUTH_AUTH_SERVICE: { fetch: async () => new Response('', { status: 503 }) } as unknown as Fetcher };
		await assert.rejects(canResumeCinaAuthSession(request, 'admin', fixtures({ admin: true }), unavailable), CinaAuthConsoleVerificationUnavailableError);
	});
});
