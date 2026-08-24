import type { SharedKeyRow, InsertSharedKeyParams } from '../db/shared-keys-types';
import type { SharedKeysRepository } from '../storage/gateway-repository-interfaces';

const ENVELOPE_PREFIX = 'enc:v1:';
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
	return value.startsWith(ENVELOPE_PREFIX);
}

async function deriveKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(assertSharedKeyEncryptionSecret(secret)),
	);
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
}

export async function encryptSharedKeySecret(
	plaintext: string,
	secret: string,
	authenticatedContext: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
			additionalData: new TextEncoder().encode(authenticatedContext),
		},
		await deriveKey(secret),
		new TextEncoder().encode(plaintext),
	);
	return `${ENVELOPE_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSharedKeySecret(
	envelope: string,
	secret: string,
	authenticatedContext: string,
): Promise<string> {
	if (!isEncryptedSharedKeySecret(envelope)) return envelope;
	const parts = envelope.slice(ENVELOPE_PREFIX.length).split(':');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error('Shared key encryption envelope is malformed');
	}
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: base64ToBytes(parts[0]),
				additionalData: new TextEncoder().encode(authenticatedContext),
			},
			await deriveKey(secret),
			base64ToBytes(parts[1]),
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
		if (!isEncryptedSharedKeySecret(row.apiKey)) {
			const encrypted = await encryptSharedKeySecret(row.apiKey, secret, context);
			if (!repository.replaceSharedKeySecret) {
				throw new Error('Shared key repository cannot migrate legacy plaintext');
			}
			const migrated = await repository.replaceSharedKeySecret(row.id, encrypted);
			if (!migrated) throw new Error('Shared key plaintext migration lost its target row');
			return row;
		}
		return {
			...row,
			apiKey: await decryptSharedKeySecret(row.apiKey, secret, context),
		};
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
