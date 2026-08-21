const TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;
const MINIMUM_SECRET_LENGTH = 32;
export const CINATOKEN_OIDC_TRANSACTION_COOKIE = '__Host-cinatoken_oidc_tx';

export type CinatokenOidcTransaction = {
	state: string;
	nonce: string;
	codeVerifier: string;
	callbackPath: string;
	createdAt: number;
	/** 会话去向：`admin`（默认，管理台会话）或 `portal`（普通用户门户会话）。 */
	intent?: 'admin' | 'portal';
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const base64UrlToBytes = (value: string): Uint8Array => {
	const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const importSigningKey = (secret: string) => {
	if (secret.length < MINIMUM_SECRET_LENGTH) {
		throw new Error('OIDC transaction secret must contain at least 32 characters');
	}
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
};

const isTransaction = (value: unknown): value is CinatokenOidcTransaction => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.state === 'string' &&
		typeof candidate.nonce === 'string' &&
		typeof candidate.codeVerifier === 'string' &&
		typeof candidate.callbackPath === 'string' &&
		typeof candidate.createdAt === 'number' &&
		(candidate.intent === undefined ||
			candidate.intent === 'admin' ||
			candidate.intent === 'portal')
	);
};

export const sanitizeCinaAuthCallbackPath = (
	value: string | null | undefined,
	fallback = '/dashboard',
): string => {
	if (!value?.startsWith('/') || value.startsWith('//')) return fallback;
	try {
		const url = new URL(value, 'https://cinatoken.com');
		if (url.origin !== 'https://cinatoken.com') return fallback;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return fallback;
	}
};

export const sealCinaAuthTransaction = async (
	transaction: CinatokenOidcTransaction,
	secret: string,
): Promise<string> => {
	const encodedPayload = bytesToBase64Url(
		new TextEncoder().encode(JSON.stringify(transaction)),
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		await importSigningKey(secret),
		new TextEncoder().encode(encodedPayload),
	);
	return `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
};

export const openCinaAuthTransaction = async (
	value: string,
	secret: string,
	now = Date.now(),
): Promise<CinatokenOidcTransaction | null> => {
	try {
		const [encodedPayload, encodedSignature, extra] = value.split('.');
		if (!encodedPayload || !encodedSignature || extra) return null;
		const valid = await crypto.subtle.verify(
			'HMAC',
			await importSigningKey(secret),
			base64UrlToBytes(encodedSignature).buffer as ArrayBuffer,
			new TextEncoder().encode(encodedPayload),
		);
		if (!valid) return null;
		const parsed: unknown = JSON.parse(
			new TextDecoder().decode(base64UrlToBytes(encodedPayload)),
		);
		if (!isTransaction(parsed)) return null;
		const age = now - parsed.createdAt;
		if (age < 0 || age > TRANSACTION_MAX_AGE_MS) return null;
		return {
			...parsed,
			callbackPath: sanitizeCinaAuthCallbackPath(
				parsed.callbackPath,
				parsed.intent === 'portal' ? '/account' : '/dashboard',
			),
		};
	} catch {
		return null;
	}
};
