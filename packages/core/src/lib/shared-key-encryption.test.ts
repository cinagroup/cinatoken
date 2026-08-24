import assert from 'node:assert/strict';
import test from 'node:test';
import {
	decryptSharedKeySecret,
	encryptSharedKeySecret,
	isEncryptedSharedKeySecret,
} from './shared-key-encryption';

const SECRET = 'test-only-shared-key-encryption-secret-32-bytes';
const CONTEXT = 'cinatoken:shared-key:key-1:fingerprint-1';

test('shared key encryption round-trips without persisting plaintext', async () => {
	const encrypted = await encryptSharedKeySecret('sk-secret-value', SECRET, CONTEXT);
	assert.equal(isEncryptedSharedKeySecret(encrypted), true);
	assert.equal(encrypted.includes('sk-secret-value'), false);
	assert.equal(await decryptSharedKeySecret(encrypted, SECRET, CONTEXT), 'sk-secret-value');
});

test('shared key envelopes are bound to their row context', async () => {
	const encrypted = await encryptSharedKeySecret('sk-secret-value', SECRET, CONTEXT);
	await assert.rejects(
		decryptSharedKeySecret(encrypted, SECRET, `${CONTEXT}:attacker-row`),
		/Shared key decryption failed/,
	);
});

test('legacy plaintext remains readable for repository-driven online migration', async () => {
	assert.equal(await decryptSharedKeySecret('legacy-secret', SECRET, CONTEXT), 'legacy-secret');
});
