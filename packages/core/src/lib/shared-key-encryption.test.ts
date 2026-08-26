import assert from 'node:assert/strict';
import test from 'node:test';
import {
	decryptSharedKeySecret,
	encryptSharedKeySecret,
	isEncryptedSharedKeySecret,
	isLegacyV1Envelope,
} from './shared-key-encryption';

const SECRET = 'test-only-shared-key-encryption-secret-32-bytes';
const CONTEXT = 'cinatoken:shared-key:key-1:fingerprint-1';

test('shared key encryption round-trips without persisting plaintext', async () => {
	const encrypted = await encryptSharedKeySecret('sk-secret-value', SECRET, CONTEXT);
	assert.equal(isEncryptedSharedKeySecret(encrypted), true);
	assert.equal(encrypted.startsWith('enc:v2:'), true);
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

/** 手工构造 v1 信封（单次 SHA-256 派生的历史格式）以验证兼容解密与版本判定。 */
async function buildLegacyV1Envelope(plaintext: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(SECRET),
	);
	const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(CONTEXT) },
		key,
		new TextEncoder().encode(plaintext),
	);
	const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
	return `enc:v1:${b64(iv)}:${b64(new Uint8Array(ciphertext))}`;
}

test('audit L-1: v1 envelopes still decrypt and are detectable for lazy upgrade', async () => {
	const legacy = await buildLegacyV1Envelope('sk-legacy-v1');
	assert.equal(isLegacyV1Envelope(legacy), true);
	assert.equal(isLegacyV1Envelope(await encryptSharedKeySecret('x', SECRET, CONTEXT)), false);
	assert.equal(await decryptSharedKeySecret(legacy, SECRET, CONTEXT), 'sk-legacy-v1');
	// 上下文绑定在 v1 下同样成立（换行即拒绝）
	await assert.rejects(
		decryptSharedKeySecret(legacy, SECRET, `${CONTEXT}:attacker-row`),
		/Shared key decryption failed/,
	);
});
