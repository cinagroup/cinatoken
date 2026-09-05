import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	openCinaAuthTransaction,
	sanitizeCinaAuthCallbackPath,
	sealCinaAuthTransaction,
	CINATOKEN_OIDC_TRANSACTION_COOKIE,
	cinaAuthTransactionCookieName,
	readCinaAuthCallbackTransaction,
	selectCinaAuthTransactionCookieName,
} from './transaction';

const secret = 'test-transaction-secret-that-is-long-enough-1234';

describe('CinaAuth OIDC transaction', () => {
	it('isolates two browser tabs and selects only the matching signed state', async () => {
		const now = Date.now();
		const first = { state: 'a'.repeat(43), nonce: 'nonce-a', codeVerifier: 'verifier-a', callbackPath: '/account', intent: 'portal' as const, createdAt: now };
		const second = { state: 'b'.repeat(43), nonce: 'nonce-b', codeVerifier: 'verifier-b', callbackPath: '/gateway/models', createdAt: now };
		const jar = new Map<string, { value: string }>([
			[cinaAuthTransactionCookieName(first.state)!, { value: await sealCinaAuthTransaction(first, secret) }],
			[cinaAuthTransactionCookieName(second.state)!, { value: await sealCinaAuthTransaction(second, secret) }],
		]);
		assert.deepEqual(await readCinaAuthCallbackTransaction(jar, first.state, secret, now), first);
		assert.deepEqual(await readCinaAuthCallbackTransaction(jar, second.state, secret, now), second);
		jar.delete(selectCinaAuthTransactionCookieName(jar, first.state)!);
		assert.equal(await readCinaAuthCallbackTransaction(jar, first.state, secret, now), null);
		assert.deepEqual(await readCinaAuthCallbackTransaction(jar, second.state, secret, now), second);
		assert.equal(await readCinaAuthCallbackTransaction(jar, 'c'.repeat(43), secret, now), null);
	});

	it('accepts only a matching legacy transaction and never falls back from a corrupt scoped cookie', async () => {
		const now = Date.now();
		const transaction = { state: 'a'.repeat(43), nonce: 'nonce', codeVerifier: 'verifier', callbackPath: '/account', createdAt: now };
		const jar = new Map([[CINATOKEN_OIDC_TRANSACTION_COOKIE, { value: await sealCinaAuthTransaction(transaction, secret) }]]);
		assert.deepEqual(await readCinaAuthCallbackTransaction(jar, transaction.state, secret, now), transaction);
		assert.equal(await readCinaAuthCallbackTransaction(jar, 'b'.repeat(43), secret, now), null);
		jar.set(cinaAuthTransactionCookieName(transaction.state)!, { value: 'corrupt' });
		assert.equal(await readCinaAuthCallbackTransaction(jar, transaction.state, secret, now), null);
		assert.equal(cinaAuthTransactionCookieName('a'.repeat(129)), null);
		assert.equal(cinaAuthTransactionCookieName('x; domain=evil.example'), null);
		assert.equal(cinaAuthTransactionCookieName(null), null);
	});

	it('round-trips an unexpired signed transaction', async () => {
		const createdAt = Date.UTC(2026, 7, 20, 0, 0, 0);
		const transaction = {
			state: 'state-value',
			nonce: 'nonce-value',
			codeVerifier: 'code-verifier-value',
			callbackPath: '/admin/routes?tab=active',
			createdAt,
		};
		const sealed = await sealCinaAuthTransaction(transaction, secret);
		assert.deepEqual(
			await openCinaAuthTransaction(sealed, secret, createdAt + 30_000),
			transaction,
		);
	});

	it('round-trips a signed popup correlation id', async () => {
		const createdAt = Date.UTC(2026, 7, 20, 0, 0, 0);
		const transaction = {
			state: 'state-value',
			nonce: 'nonce-value',
			codeVerifier: 'code-verifier-value',
			callbackPath: '/account',
			createdAt,
			intent: 'portal' as const,
			popupRequestId: '01890d4a-2f67-4a91-8b90-bbdcd0f584b6',
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
		assert.equal(sanitizeCinaAuthCallbackPath('/admin/models'), '/admin/models');
	});

	it('rejects an invalid popup correlation id even when the payload is signed', async () => {
		const createdAt = Date.UTC(2026, 7, 20, 0, 0, 0);
		const sealed = await sealCinaAuthTransaction(
			{
				state: 'state-value',
				nonce: 'nonce-value',
				codeVerifier: 'code-verifier-value',
				callbackPath: '/dashboard',
				createdAt,
				popupRequestId: 'not-a-uuid',
			},
			secret,
		);
		assert.equal(await openCinaAuthTransaction(sealed, secret, createdAt), null);
	});
});
