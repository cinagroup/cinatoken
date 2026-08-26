import type { SharedKeyRow, InsertSharedKeyParams } from '../db/shared-keys-types';
import type { SharedKeysRepository } from '../storage/gateway-repository-interfaces';

const ENVELOPE_PREFIX_V1 = 'enc:v1:';
const ENVELOPE_PREFIX_V2 = 'enc:v2:';
const MIN_SECRET_LENGTH = 32;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function assertSharedKeyEncryptionSecret(secret: string | undefined): string {
	if (!secret || secret.length < MIN_SECRET_LENGTH) {
		throw new Error('SHARED_KEY_ENCRYPTION_SECRET must contain at least 32 characters');
	}
	return secret;
}

export function isEncryptedSharedKeySecret(value: string): boolean {
	return value.startsWith(ENVELOPE_PREFIX_V1) || value.startsWith(ENVELOPE_PREFIX_V2);
}

/**
 * v1（审计 L-1）：KEK = 单次无盐 SHA-256(passphrase) —— 弱口令 + 库泄露时可离线爆破。
 * 仅保留解密兼容，任何新写入一律 v2。
 */
async function deriveKeyV1(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(assertSharedKeyEncryptionSecret(secret)),
	);
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
}

/** v2：HKDF-SHA-256（salt/info 绑定用途）， extracts/expand 的标准 KDF 步进。 */
async function deriveKeyV2(secret: string): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(assertSharedKeyEncryptionSecret(secret)),
		'HKDF',
		false,
		['deriveBits'],
	);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new TextEncoder().encode('cinatoken:envelope:v2'),
			info: new TextEncoder().encode('shared/provider key encryption v2'),
		},
		keyMaterial,
		256,
	);
	return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
}

async function aesGcm(
	operation: 'encrypt' | 'decrypt',
	plaintextOrCiphertext: Uint8Array<ArrayBuffer>,
	iv: Uint8Array<ArrayBuffer>,
	key: CryptoKey,
	authenticatedContext: string,
): Promise<ArrayBuffer> {
	return crypto.subtle[operation](
		{
			name: 'AES-GCM',
			iv,
			additionalData: new TextEncoder().encode(authenticatedContext),
		},
		key,
		plaintextOrCiphertext,
	);
}

export async function encryptSharedKeySecret(
	plaintext: string,
	secret: string,
	authenticatedContext: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await aesGcm(
		'encrypt',
		new TextEncoder().encode(plaintext) as unknown as Uint8Array<ArrayBuffer>,
		iv as unknown as Uint8Array<ArrayBuffer>,
		await deriveKeyV2(secret),
		authenticatedContext,
	);
	return `${ENVELOPE_PREFIX_V2}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** v1 信封判定：读路径据此触发“解密后以 v2 重封”的惰性升级。 */
export function isLegacyV1Envelope(value: string): boolean {
	return value.startsWith(ENVELOPE_PREFIX_V1);
}

export async function decryptSharedKeySecret(
	envelope: string,
	secret: string,
	authenticatedContext: string,
): Promise<string> {
	if (!isEncryptedSharedKeySecret(envelope)) return envelope;
	const v1 = isLegacyV1Envelope(envelope);
	const prefix = v1 ? ENVELOPE_PREFIX_V1 : ENVELOPE_PREFIX_V2;
	const parts = envelope.slice(prefix.length).split(':');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error('Shared key encryption envelope is malformed');
	}
	try {
		const plaintext = await aesGcm(
			'decrypt',
			base64ToBytes(parts[1]),
			base64ToBytes(parts[0]),
			await (v1 ? deriveKeyV1(secret) : deriveKeyV2(secret)),
			authenticatedContext,
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new Error('Shared key decryption failed');
	}
}

function sharedKeyContext(row: Pick<SharedKeyRow, 'id' | 'keyFingerprint'>): string {
	return `cinatoken:shared-key:${row.id}:${row.keyFingerprint}`;
}

/**
 * Encrypts all new shared-key writes and decrypts reads only at the repository boundary.
 * Legacy plaintext rows are encrypted in place on first read during the rollout window.
 */
export function createEncryptedSharedKeysRepository(
	repository: SharedKeysRepository,
	secret: string,
): SharedKeysRepository {
	assertSharedKeyEncryptionSecret(secret);

	const reveal = async (row: SharedKeyRow | null): Promise<SharedKeyRow | null> => {
		if (!row) return null;
		const context = sharedKeyContext(row);
		if (!repository.replaceSharedKeySecret) {
			throw new Error('Shared key repository cannot migrate legacy plaintext');
		}
		if (!isEncryptedSharedKeySecret(row.apiKey)) {
			// 明文行：首次读取即地加密（rollout 窗口内的在线迁移）
			const encrypted = await encryptSharedKeySecret(row.apiKey, secret, context);
			const migrated = await repository.replaceSharedKeySecret(row.id, encrypted);
			if (!migrated) throw new Error('Shared key plaintext migration lost its target row');
			return row;
		}
		const plaintext = await decryptSharedKeySecret(row.apiKey, secret, context);
		if (isLegacyV1Envelope(row.apiKey)) {
			// v1 密文：解密成功后以 v2（HKDF）重封（审计 L-1 的在线升级路径）
			const upgraded = await encryptSharedKeySecret(plaintext, secret, context);
			const migrated = await repository.replaceSharedKeySecret(row.id, upgraded);
			if (!migrated) throw new Error('Shared key v1→v2 upgrade lost its target row');
		}
		return { ...row, apiKey: plaintext };
	};

	const revealMany = async (rows: SharedKeyRow[]): Promise<SharedKeyRow[]> =>
		Promise.all(rows.map((row) => reveal(row) as Promise<SharedKeyRow>));

	return {
		...repository,
		async insertSharedKey(params: InsertSharedKeyParams) {
			await repository.insertSharedKey({
				...params,
				apiKey: await encryptSharedKeySecret(
					params.apiKey,
					secret,
					sharedKeyContext({ id: params.id, keyFingerprint: params.keyFingerprint }),
				),
			});
		},
		async getSharedKeyById(id) {
			return reveal(await repository.getSharedKeyById(id));
		},
		async listSharedKeysBySeller(sellerUserId) {
			return revealMany(await repository.listSharedKeysBySeller(sellerUserId));
		},
		async listAllSharedKeys(options) {
			return revealMany(await repository.listAllSharedKeys(options));
		},
		async listActiveSharedKeysByChannel(channelType) {
			return revealMany(await repository.listActiveSharedKeysByChannel(channelType));
		},
	};
}
