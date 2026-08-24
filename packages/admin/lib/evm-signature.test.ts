import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeEvmAddress, verifyEvmMessage } from './evm-signature';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('normalizes valid EVM addresses and rejects a bad mixed-case checksum', () => {
	assert.equal(
		normalizeEvmAddress('0x52908400098527886e0f7030069857d2e4169ee7'),
		'0x52908400098527886E0F7030069857D2E4169EE7',
	);
	assert.throws(() => normalizeEvmAddress('0x52908400098527886E0F7030069857D2E4169Ee7'));
});

test('verifies personal_sign and rejects tampering', async () => {
	const account = privateKeyToAccount(PRIVATE_KEY);
	const message = 'CinaToken ownership proof';
	const signature = await account.signMessage({ message });
	assert.equal(verifyEvmMessage({ address: account.address, message, signature }), true);
	assert.equal(verifyEvmMessage({ address: account.address, message: `${message}!`, signature }), false);
	assert.equal(verifyEvmMessage({ address: account.address, message, signature: '0x01' }), false);
});
