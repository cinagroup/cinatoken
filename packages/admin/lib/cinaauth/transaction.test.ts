import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	openCinaAuthTransaction,
	sanitizeCinaAuthCallbackPath,
	sealCinaAuthTransaction,
} from './transaction';

const secret = 'test-transaction-secret-that-is-long-enough-1234';

describe('CinaAuth OIDC transaction', () => {
	it('round-trips an unexpired signed transaction', async () => {
		const createdAt = Date.UTC(2026, 7, 20, 0, 0, 0);
		const transaction = {
			state: 'state-value',
			nonce: 'nonce-value',
			codeVerifier: 'code-verifier-value',
			callbackPath: '/gateway/routes?tab=active',
			createdAt,
		};
		const sealed = await sealCinaAuthTransaction(transaction, secret);
		assert.deepEqual(
			await openCinaAuthTransaction(sealed, secret, createdAt + 30_000),
			transaction,
		);
	});

	it('rejects tampering, expiry, and open redirects', async () => {
		const createdAt = Date.UTC(2026, 7, 20, 0, 0, 0);
		const sealed = await sealCinaAuthTransaction(
			{
				state: 'state-value',
				nonce: 'nonce-value',
				codeVerifier: 'code-verifier-value',
				callbackPath: '/dashboard',
				createdAt,
			},
			secret,
		);
		assert.equal(await openCinaAuthTransaction(`${sealed}x`, secret, createdAt), null);
		assert.equal(await openCinaAuthTransaction(sealed, secret, createdAt + 11 * 60_000), null);
		assert.equal(sanitizeCinaAuthCallbackPath('//attacker.example/path'), '/dashboard');
		assert.equal(sanitizeCinaAuthCallbackPath('https://attacker.example/path'), '/dashboard');
	});
});
