/**
 * Gateway Admin 后台会话与外部 Admin API Key 的安全工具。
 */
import type { GatewayRepositories } from '@octafuse/core';
import type { AdminPrincipal } from '@/lib/admin-principal';
import { parseAdminPermissions } from '@/lib/admin-principal';
import { getSessionCookieToken } from '@/lib/unified-session';

type AdminAuthenticationRepositories = {
	adminAccess: Pick<
		GatewayRepositories['adminAccess'],
		'getActiveApiKeyBySecret' | 'touchApiKey' | 'getValidSession'
	>;
};

const TRANSIENT_ADMIN_SESSION_ERROR_PATTERNS = [
	/d1_error/i,
	/database is locked/i,
	/network connection (?:was )?lost/i,
	/connection reset/i,
	/temporarily unavailable/i,
	/too many requests/i,
	/timed? ?out/i,
] as const;

function errorCauseMessages(error: unknown): string[] {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
		seen.add(current);
		if (current instanceof Error) {
			messages.push(`${current.name}: ${current.message}`);
			current = current.cause;
			continue;
		}
		messages.push(String(current));
		break;
	}
	return messages;
}

function isTransientAdminSessionReadError(error: unknown): boolean {
	const details = errorCauseMessages(error).join('\n');
	return TRANSIENT_ADMIN_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(details));
}

function redactDatabaseErrorParams(message: string): string {
	return message.replace(/(\bparams:\s*)[^\r\n]*/giu, '$1[redacted]');
}

async function getValidAdminSessionWithRetry(
	repositories: AdminAuthenticationRepositories,
	tokenHash: string,
	nowIso: string,
) {
	try {
		return await repositories.adminAccess.getValidSession(tokenHash, nowIso);
	} catch (error) {
		if (!isTransientAdminSessionReadError(error)) throw error;
		console.warn('Transient admin session read failed; retrying once', {
			error: errorCauseMessages(error).map(redactDatabaseErrorParams),
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		return repositories.adminAccess.getValidSession(tokenHash, nowIso);
	}
}

/** 生成 32 字节十六进制会话标识。 */
export function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateAdminApiKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `sk-admin-${bytesToHex(bytes)}`;
}

export async function hashSessionToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return bytesToHex(new Uint8Array(digest));
}

/** Hash both values to a fixed length, then compare every byte without early exit. */
export async function timingSafeEqualSecret(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	]);
	const leftBytes = new Uint8Array(leftHash);
	const rightBytes = new Uint8Array(rightHash);
	let difference = 0;
	for (let index = 0; index < leftBytes.length; index += 1) {
		difference |= leftBytes[index] ^ rightBytes[index];
	}
	return difference === 0;
}

export function getSessionToken(request: Request): string | null {
	return getSessionCookieToken(request, 'admin_session');
}

export async function authenticateAdminRequest(
	request: Request,
	repositories: AdminAuthenticationRepositories
): Promise<AdminPrincipal | null> {
	const authorization = request.headers.get('authorization');
	if (authorization) {
		if (!authorization.startsWith('Bearer ')) return null;
		const secret = authorization.slice(7).trim();
		if (!secret) return null;
		const row = await repositories.adminAccess.getActiveApiKeyBySecret(secret);
		if (!row) return null;
		await repositories.adminAccess.touchApiKey(row.id);
		return {
			type: 'api_key',
			id: `admin_key:${row.id}`,
			keyId: row.id,
			permissions: parseAdminPermissions(row.permissionsJson),
		};
	}

	const token = getSessionToken(request);
	if (!token) return null;
	const tokenHash = await hashSessionToken(token);
	const session = await getValidAdminSessionWithRetry(
		repositories,
		tokenHash,
		new Date().toISOString(),
	);
	if (!session) return null;
	return { type: 'console', id: `console:${session.username}`, username: session.username };
}

/**
 * 是否为 `admin_session` 设置 `Secure`（可选加固，由 `ADMIN_COOKIE_SECURE` 控制）。
 * - 未设置或 `0`/`false`/`no`/`off` → false（默认；明文 HTTP 可登录）
 * - `1`/`true`/`yes`/`on` → true（已部署 HTTPS 时可选用，限制 Cookie 仅经 HTTPS 回传）
 */
export function resolveCookieSecure(request?: Request): boolean {
	const requestEnv = request as (Request & { env?: CloudflareEnv }) | undefined;
	const raw = (requestEnv?.env?.ADMIN_COOKIE_SECURE ?? process.env.ADMIN_COOKIE_SECURE)
		?.trim()
		.toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  return false;
}
