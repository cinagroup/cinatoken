import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyEvmMessage } from './evm-signature';
import {
	createWalletChallenge,
	openWalletChallenge,
	sealWalletChallenge,
} from './wallet-challenge';

const SECRET = 'test-only-wallet-challenge-secret-at-least-32';
const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('creates a verifiable SIWE challenge bound to the user and exact origin', async () => {
	const account = privateKeyToAccount(PRIVATE_KEY);
	const challenge = createWalletChallenge({
		userId: 'user-1',
		address: account.address,
		origin: 'https://cinatoken.com',
		chainId: 84532,
		now: 1_000,
	});
	const token = await sealWalletChallenge(challenge, SECRET);
	const opened = await openWalletChallenge(token, SECRET, 2_000);
	assert.equal(opened?.userId, 'user-1');
	assert.match(opened?.message ?? '', /^cinatoken\.com wants you to sign in/u);
	const signature = await account.signMessage({ message: challenge.message });
	assert.equal(verifyEvmMessage({ address: account.address, message: challenge.message, signature }), true);
});

test('rejects tampered and expired wallet challenges', async () => {
	const account = privateKeyToAccount(PRIVATE_KEY);
	const challenge = createWalletChallenge({
		userId: 'user-1',
		address: account.address,
		origin: 'https://cinatoken.com',
		chainId: 84532,
		now: 1_000,
	});
	const token = await sealWalletChallenge(challenge, SECRET);
	assert.equal(await openWalletChallenge(`${token}x`, SECRET, 2_000), null);
	assert.equal(await openWalletChallenge(token, SECRET, 5 * 60 * 1000 + 1_001), null);
});
