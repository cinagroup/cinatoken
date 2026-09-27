/**
 * GCP 服务账号 JSON → OAuth access token（JWT bearer grant）。
 * 使用 Web Crypto，兼容 Cloudflare Workers 与 Node。token 只缓存在进程内存。
 */

import {
	createGcpOAuthLifecycle, discardGcpOAuthResponse, readGcpOAuthResponse,
	GcpTokenExchangeError, type GcpOAuthLifecycle,
} from './gcp-oauth-lifecycle';
import { RequestAuxiliaryAuthLimitError, type RequestAuxiliaryAuthBudget } from './request-auxiliary-auth-budget';
export { GcpTokenExchangeError, GCP_OAUTH_TIMEOUT_MS, GCP_OAUTH_MAX_RESPONSE_BYTES } from './gcp-oauth-lifecycle';

export const GCP_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GCP_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const JWT_LIFETIME_SECONDS = 3600;
export const GCP_TOKEN_CACHE_MAX_ENTRIES = 256;

export type GcpServiceAccount = {
	type: 'service_account';
	client_email: string;
	private_key: string;
	token_uri?: string;
};

export type ResolveProviderUpstreamSecretOptions = {
	fetchImpl?: typeof fetch;
	nowMs?: () => number;
	signal?: AbortSignal;
	/** May tighten, never raise, the fixed local OAuth ceiling. */
	timeoutMs?: number;
	/** Request-local owner; never recreate inside a model/key fallback. */
	auxiliaryAuth?: RequestAuxiliaryAuthBudget;
};

export type ResolvedProviderUpstreamSecret = {
	secret: string;
	isServiceAccount: boolean;
	clientEmail?: string;
};

type CachedToken = {
	accessToken: string;
	expiresAtMs: number;
};

const tokenCache = new Map<string, CachedToken>();
// Cache only completed data, never another request's fetch/stream/Promise.
// Replacement also prevents a pre-clear exchange from repopulating this cache.
let cacheGeneration = {};

export function parseGcpServiceAccountJson(raw: string): GcpServiceAccount | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('{')) return null;
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		if (parsed.type !== 'service_account') return null;
		const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
		const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key : '';
		if (!clientEmail || !privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
			return null;
		}
		const tokenUri = typeof parsed.token_uri === 'string' ? parsed.token_uri.trim() : '';
		return {
			type: 'service_account',
			client_email: clientEmail,
			private_key: privateKey.replace(/\\n/g, '\n'),
			...(tokenUri ? { token_uri: tokenUri } : {}),
		};
	} catch {
		return null;
	}
}

export function isGcpServiceAccountJson(raw: string | null | undefined): boolean {
	return typeof raw === 'string' && parseGcpServiceAccountJson(raw) != null;
}

export function gcpServiceAccountCacheKey(account: GcpServiceAccount): string {
	return JSON.stringify([account.client_email, account.private_key, account.token_uri?.trim() || GCP_OAUTH_TOKEN_URL, GCP_CLOUD_PLATFORM_SCOPE]);
}

export function clearGcpServiceAccountTokenCache(): void {
	tokenCache.clear();
	cacheGeneration = {};
}

export async function resolveProviderUpstreamSecret(
	raw: string,
	options: ResolveProviderUpstreamSecretOptions = {}
): Promise<ResolvedProviderUpstreamSecret> {
	if (options.signal?.aborted) throw new GcpTokenExchangeError('cancelled');
	const account = parseGcpServiceAccountJson(raw);
	if (!account) {
		return { secret: raw, isServiceAccount: false };
	}
	const accessToken = await getGcpAccessToken(account, options);
	return {
		secret: accessToken,
		isServiceAccount: true,
		clientEmail: account.client_email,
	};
}

export async function getGcpAccessToken(
	account: GcpServiceAccount,
	options: ResolveProviderUpstreamSecretOptions = {}
): Promise<string> {
	const nowMs = options.nowMs ?? Date.now;
	const owner = createGcpOAuthLifecycle(options.signal, options.timeoutMs);
	const generation = cacheGeneration;
	try {
		// Do not retain PEM private keys as module-level cache keys.
		const digest = await owner.wait(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(gcpServiceAccountCacheKey(account))));
		const cacheKey = base64UrlEncode(new Uint8Array(digest));
		for (const [key, token] of tokenCache) {
			if (token.expiresAtMs - TOKEN_REFRESH_SKEW_MS <= nowMs()) tokenCache.delete(key);
		}
		const cached = tokenCache.get(cacheKey);
		if (cached) {
			tokenCache.delete(cacheKey);
			tokenCache.set(cacheKey, cached);
			return cached.accessToken;
		}
		const token = await exchangeGcpAccessToken(account, options, owner);
		owner.check();
		if (generation === cacheGeneration && token.expiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs()) {
			tokenCache.delete(cacheKey);
			while (tokenCache.size >= GCP_TOKEN_CACHE_MAX_ENTRIES) {
				const oldest = tokenCache.keys().next();
				if (!oldest.done) tokenCache.delete(oldest.value);
			}
			tokenCache.set(cacheKey, token);
		}
		return token.accessToken;
	} catch (error) {
		owner.check();
		// Raw OAuth bodies, JWTs, client abort reasons and transport errors may
		// contain credentials. Only fixed messages leave this boundary.
		if (error instanceof RequestAuxiliaryAuthLimitError) throw error;
		throw error instanceof GcpTokenExchangeError ? error : new GcpTokenExchangeError('failed');
	} finally {
		owner.dispose();
	}
}

async function exchangeGcpAccessToken(
	account: GcpServiceAccount,
	options: ResolveProviderUpstreamSecretOptions,
	owner: GcpOAuthLifecycle,
): Promise<CachedToken> {
	const nowMs = options.nowMs ?? Date.now;
	const fetchImpl = options.fetchImpl ?? fetch;
	const tokenUrl = account.token_uri?.trim() || GCP_OAUTH_TOKEN_URL;
	// Only cold exchanges need a permit. Reject before signing when exhausted,
	// then claim atomically at fetch after any asynchronous preparation.
	options.auxiliaryAuth?.assertAvailable();
	const assertion = await signGcpServiceAccountJwt(account, tokenUrl, nowMs, owner);
	const body = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		assertion,
	});
	const requestedAtMs = nowMs();
	const response = await owner.wait(() => {
		options.auxiliaryAuth?.consume();
		return fetchImpl(tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			signal: owner.signal,
			redirect: 'manual',
		});
	}, discardGcpOAuthResponse);
	if (!response.ok) {
		discardGcpOAuthResponse(response);
		throw new GcpTokenExchangeError('http_error', response.status);
	}
	const text = await readGcpOAuthResponse(response, owner);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new GcpTokenExchangeError('invalid_response');
	}
	if (payload == null || typeof payload !== 'object' || Array.isArray(payload)
		|| !('access_token' in payload) || typeof payload.access_token !== 'string'
		|| !/^[\x21-\x7e]+$/.test(payload.access_token)
		|| !('expires_in' in payload) || typeof payload.expires_in !== 'number'
		|| !Number.isFinite(payload.expires_in) || payload.expires_in <= 0
		|| ('token_type' in payload && (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer'))) {
		throw new GcpTokenExchangeError('invalid_response');
	}
	// Never extend a short/unknown lifetime. Count from request initiation so
	// slow delivery cannot make us reuse a token beyond the server's expiry.
	const expiresAtMs = requestedAtMs + Math.min(JWT_LIFETIME_SECONDS, payload.expires_in) * 1000;
	if (expiresAtMs <= nowMs()) throw new GcpTokenExchangeError('invalid_response');
	return {
		accessToken: payload.access_token,
		expiresAtMs,
	};
}

export async function signGcpServiceAccountJwt(
	account: GcpServiceAccount,
	audience: string,
	nowMs: () => number = Date.now,
	owner?: GcpOAuthLifecycle,
): Promise<string> {
	owner?.check();
	const nowSeconds = Math.floor(nowMs() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claims = {
		iss: account.client_email,
		sub: account.client_email,
		aud: audience,
		iat: nowSeconds,
		exp: nowSeconds + JWT_LIFETIME_SECONDS,
		scope: GCP_CLOUD_PLATFORM_SCOPE,
	};
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
	const key = await (owner ? owner.wait(() => importRsaPrivateKey(account.private_key)) : importRsaPrivateKey(account.private_key));
	const sign = () => crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		bytesToArrayBuffer(new TextEncoder().encode(signingInput))
	);
	const signature = await (owner ? owner.wait(sign) : sign());
	return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		bytesToArrayBuffer(decodePemToDer(pem)),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);
}

/** Next / TS 6 把 `Uint8Array.buffer` 标成 `ArrayBufferLike`，Web Crypto 只要真正的 `ArrayBuffer`。 */
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

function decodePemToDer(pem: string): Uint8Array {
	const normalized = pem.replace(/\\n/g, '\n').trim();
	const pkcs8 = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
	if (pkcs8?.[1]) return uint8FromBase64(pkcs8[1]);
	const pkcs1 = normalized.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/);
	if (pkcs1?.[1]) {
		return wrapPkcs1ToPkcs8(uint8FromBase64(pkcs1[1]));
	}
	throw new Error('GCP service account private_key must be a PEM PRIVATE KEY');
}

function wrapPkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	const version = new Uint8Array([0x02, 0x01, 0x00]);
	const rsaOid = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	]);
	const octet = encodeDer(0x04, pkcs1);
	return encodeDer(0x30, concatBytes(version, rsaOid, octet));
}

function encodeDer(tag: number, content: Uint8Array): Uint8Array {
	const length = encodeDerLength(content.length);
	const out = new Uint8Array(1 + length.length + content.length);
	out[0] = tag;
	out.set(length, 1);
	out.set(content, 1 + length.length);
	return out;
}

function encodeDerLength(length: number): Uint8Array {
	if (length < 0x80) return new Uint8Array([length]);
	const bytes: number[] = [];
	let value = length;
	while (value > 0) {
		bytes.unshift(value & 0xff);
		value >>= 8;
	}
	return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function base64UrlJson(value: unknown): string {
	return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
	return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64Encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function uint8FromBase64(base64: string): Uint8Array {
	const cleaned = base64.replace(/\s+/g, '');
	const binary = atob(cleaned);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
