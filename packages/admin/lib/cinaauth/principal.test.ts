import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdminPrincipal } from '@/lib/admin-principal';
import {
	CinaAuthConsoleVerificationUnavailableError,
	cinaAuthSessionUsername,
	cinaAuthSubjectFromPrincipal,
	verifyCinaAuthConsolePrincipal,
} from './principal';

const request = new Request('https://cinatoken.com/api/admin/config');
const consolePrincipal: AdminPrincipal = {
	type: 'console',
	id: 'console:cinaauth:user-123',
	username: cinaAuthSessionUsername('user-123'),
};

const withRequiredSecrets = async (run: () => Promise<void>): Promise<void> => {
	const previous = {
		client: process.env.CINATOKEN_OIDC_CLIENT_SECRET,
		bridge: process.env.CINATOKEN_OIDC_BRIDGE_SECRET,
		transaction: process.env.CINATOKEN_OIDC_TRANSACTION_SECRET,
	};
	process.env.CINATOKEN_OIDC_CLIENT_SECRET = 'test-client-secret-that-is-long-enough-12345';
	process.env.CINATOKEN_OIDC_BRIDGE_SECRET = 'test-bridge-secret-that-is-long-enough-12345';
	process.env.CINATOKEN_OIDC_TRANSACTION_SECRET =
		'test-transaction-secret-that-is-long-enough-12345';
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			const name =
				key === 'client'
					? 'CINATOKEN_OIDC_CLIENT_SECRET'
					: key === 'bridge'
						? 'CINATOKEN_OIDC_BRIDGE_SECRET'
						: 'CINATOKEN_OIDC_TRANSACTION_SECRET';
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
};

describe('CinaAuth console principal', () => {
	it('does not accept legacy local console usernames', () => {
		assert.equal(
			cinaAuthSubjectFromPrincipal({
				type: 'console',
				id: 'console:admin',
				username: 'admin',
			}),
			null,
		);
	});

	it('accepts an eligible live CinaAuth role', async () => {
		await withRequiredSecrets(async () => {
			const service = {
				fetch: async () =>
					Response.json({
						ok: true,
						user: { id: 'user-123', role: 'security_admin' },
					}),
			} as unknown as Fetcher;
			assert.deepEqual(
				await verifyCinaAuthConsolePrincipal(request, consolePrincipal, {
					CINAAUTH_AUTH_SERVICE: service,
				}),
				consolePrincipal,
			);
		});
	});

	it('fails closed when the live role is not eligible', async () => {
		await withRequiredSecrets(async () => {
			const service = {
				fetch: async () =>
					Response.json({ ok: true, user: { id: 'user-123', role: 'user' } }),
			} as unknown as Fetcher;
			assert.equal(
				await verifyCinaAuthConsolePrincipal(request, consolePrincipal, {
					CINAAUTH_AUTH_SERVICE: service,
				}),
				null,
			);
		});
	});

	it('reports a retryable verification failure when CinaAuth returns 503', async () => {
		await withRequiredSecrets(async () => {
			const service = {
				fetch: async () => new Response('unavailable', { status: 503 }),
			} as unknown as Fetcher;
			await assert.rejects(
				verifyCinaAuthConsolePrincipal(request, consolePrincipal, {
					CINAAUTH_AUTH_SERVICE: service,
				}),
				CinaAuthConsoleVerificationUnavailableError,
			);
		});
	});

	it('reports a retryable verification failure when the service binding throws', async () => {
		await withRequiredSecrets(async () => {
			const service = {
				fetch: async () => {
					throw new Error('service unavailable');
				},
			} as unknown as Fetcher;
			await assert.rejects(
				verifyCinaAuthConsolePrincipal(request, consolePrincipal, {
					CINAAUTH_AUTH_SERVICE: service,
				}),
				CinaAuthConsoleVerificationUnavailableError,
			);
		});
	});
});
