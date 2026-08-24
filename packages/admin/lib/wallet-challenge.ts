import { normalizeEvmAddress, type EvmAddress } from './evm-signature';

const CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export type WalletChallenge = {
	userId: string;
	address: EvmAddress;
	message: string;
	createdAt: number;
	expiresAt: number;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
	const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
};

const importSigningKey = (secret: string) => {
	if (secret.length < MIN_SECRET_LENGTH) throw new Error('Wallet challenge secret is too weak');
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
};

function isWalletChallenge(value: unknown): value is WalletChallenge {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.userId === 'string' &&
		typeof candidate.address === 'string' &&
		typeof candidate.message === 'string' &&
		typeof candidate.createdAt === 'number' &&
		typeof candidate.expiresAt === 'number'
	);
}

function randomNonce(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

export function createWalletChallenge(input: {
	userId: string;
	address: string;
	origin: string;
	chainId: number;
	now?: number;
}): WalletChallenge {
	const now = input.now ?? Date.now();
	const origin = new URL(input.origin);
	const address = normalizeEvmAddress(input.address);
	const nonce = randomNonce();
	const issuedAt = new Date(now).toISOString();
	const expirationTime = new Date(now + CHALLENGE_MAX_AGE_MS).toISOString();
	const message = `${origin.host} wants you to sign in with your Ethereum account:\n${address}\n\nVerify ownership of this wallet for CinaToken withdrawals.\n\nURI: ${origin.origin}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}\nRequest ID: ${input.userId}`;
	return {
		userId: input.userId,
		address,
		message,
		createdAt: now,
		expiresAt: now + CHALLENGE_MAX_AGE_MS,
	};
}

export async function sealWalletChallenge(
	challenge: WalletChallenge,
	secret: string,
): Promise<string> {
	const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(challenge)));
	const signature = await crypto.subtle.sign(
		'HMAC',
		await importSigningKey(secret),
		new TextEncoder().encode(payload),
	);
	return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function openWalletChallenge(
	token: string,
	secret: string,
	now = Date.now(),
): Promise<WalletChallenge | null> {
	try {
		const [payload, signature, extra] = token.split('.');
		if (!payload || !signature || extra) return null;
		const valid = await crypto.subtle.verify(
			'HMAC',
			await importSigningKey(secret),
			base64UrlToBytes(signature),
			new TextEncoder().encode(payload),
		);
		if (!valid) return null;
		const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
		if (!isWalletChallenge(decoded)) return null;
		if (decoded.createdAt > now || decoded.expiresAt < now) return null;
		if (decoded.expiresAt - decoded.createdAt !== CHALLENGE_MAX_AGE_MS) return null;
		if (normalizeEvmAddress(decoded.address) !== decoded.address) return null;
		return decoded;
	} catch {
		return null;
	}
}
