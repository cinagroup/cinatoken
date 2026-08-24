/**
 * 用户门户会话（`user_session` Cookie）与门户用户解析。
 *
 * 与管理台（`lib/auth.ts` + `admin_sessions`）完全隔离：
 * - 会话存 `portal_sessions`，Cookie 名 `user_session`；
 * - 不校验 CinaAuth 管理员角色，任何完成 OIDC 登录的用户都可进入；
 * - 门户身份映射到 `users` 行（`external_system='cinaauth'`、`external_user_id=<sub>`）。
 */
import type { GatewayRepositories } from '@octafuse/core';
import { hashSessionToken } from '@/lib/auth';
import {
	getAccountCapabilities,
	getSessionCookieToken,
	type AccountCapability,
} from '@/lib/unified-session';

export const USER_SESSION_COOKIE = 'user_session';
export const PORTAL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const PORTAL_EXTERNAL_SYSTEM = 'cinaauth';

export type UserPrincipal = {
	/** `users.id` */
	userId: string;
	/** CinaAuth OIDC `sub` */
	subject: string;
	email: string;
	isAdmin: boolean;
	capabilities: AccountCapability[];
};

type PortalAuthenticationRepositories = {
	users: Pick<GatewayRepositories['users'], 'getByExternalPair' | 'createUser'>;
	portalAccess: Pick<GatewayRepositories['portalAccess'], 'getValidSession'>;
};

export function getUserSessionToken(request: Request): string | null {
	return getSessionCookieToken(request, USER_SESSION_COOKIE);
}

/**
 * 首次门户登录时建立/取回 `users` 行（幂等）。
 * 已存在的 internal 同名邮箱用户不受影响（命名空间隔离）。
 */
export async function upsertPortalUser(
	users: Pick<GatewayRepositories['users'], 'getByExternalPair' | 'createUser' | 'setUserEmailById'>,
	subject: string,
	email: string,
): Promise<string> {
	const existing = await users.getByExternalPair(PORTAL_EXTERNAL_SYSTEM, subject);
	if (existing) {
		if (existing.email !== email) {
			// 邮箱在 IdP 侧变更时跟随，保持计费/审计对账准确
			await users.setUserEmailById(existing.id, email).catch(() => undefined);
		}
		return existing.id;
	}
	const id = crypto.randomUUID();
	await users.createUser({
		id,
		email,
		status: 'active',
		externalSystem: PORTAL_EXTERNAL_SYSTEM,
		externalUserId: subject,
	});
	return id;
}

export async function authenticateUserRequest(
	request: Request,
	repositories: PortalAuthenticationRepositories,
): Promise<UserPrincipal | null> {
	const token = getUserSessionToken(request);
	if (!token) return null;
	const tokenHash = await hashSessionToken(token);
	const session = await repositories.portalAccess.getValidSession(tokenHash, new Date().toISOString());
	if (!session) return null;
	const user = await repositories.users.getByExternalPair(PORTAL_EXTERNAL_SYSTEM, session.subject);
	if (!user || user.status === 'disabled') return null;
	return {
		userId: user.id,
		subject: session.subject,
		email: user.email,
		isAdmin: false,
		capabilities: getAccountCapabilities(false),
	};
}
