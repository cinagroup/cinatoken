import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { generateSessionToken, hashSessionToken } from '@/lib/auth';
import {
	fetchCinaAuth,
	getCinaAuthConfig,
	getCinaAuthSecrets,
	hasRequiredCinaAuthRole,
} from '@/lib/cinaauth/config';
import {
	discoverCinaAuthAuthorizationServer,
	exchangeCinaAuthAuthorizationCode,
	getCinaAuthOidcFailureDetails,
} from '@/lib/cinaauth/oidc-client';
import { cinaAuthSessionUsername } from '@/lib/cinaauth/principal';
import {
	CINATOKEN_OIDC_TRANSACTION_COOKIE,
	openCinaAuthTransaction,
} from '@/lib/cinaauth/transaction';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { logAdminAuthEvent } from '@/lib/security-log';
import { PORTAL_SESSION_TTL_MS, USER_SESSION_COOKIE, upsertPortalUser } from '@/lib/user-auth';
import { CINATOKEN_SESSION_COOKIE } from '@/lib/unified-session';

export const dynamic = 'force-dynamic';

type BridgeResponse = {
	ok?: boolean;
	user?: { id?: string; email?: string | null; role?: string | null };
};

type UserInfoResponse = {
	sub?: string;
	email?: string | null;
};

const clearTransactionCookie = (response: NextResponse): void => {
	response.cookies.set(CINATOKEN_OIDC_TRANSACTION_COOKIE, '', {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: 0,
	});
};

const fail = (request: NextRequest, error: string, fallbackPath = '/'): NextResponse => {
	const url = new URL(fallbackPath, request.url);
	url.searchParams.set('auth_error', error);
	const response = NextResponse.redirect(url, 302);
	clearTransactionCookie(response);
	response.headers.set('Cache-Control', 'no-store');
	return response;
};

/**
 * 门户（普通用户）会话：不校验管理员角色，走标准 OIDC userinfo 取 sub/email，
 * upsert `users` 行后签发独立 `user_session`（24h）。
 */
async function completePortalLogin(
	request: NextRequest,
	accessToken: string,
	subject: string,
	callbackPath: string,
): Promise<NextResponse> {
	const config = getCinaAuthConfig(request);
	const userinfoRequest = new Request(`${config.issuer}/api/auth/oauth2/userinfo`, {
		method: 'GET',
		headers: { authorization: `Bearer ${accessToken}`, origin: config.appOrigin },
		cache: 'no-store',
	});
	const userinfoResponse = await fetchCinaAuth(userinfoRequest, request);
	const userinfo = (await userinfoResponse.json().catch(() => null)) as UserInfoResponse | null;
	if (!userinfoResponse.ok || userinfo?.sub !== subject) {
		return fail(request, 'portal_userinfo_failed', '/account');
	}
	const email = userinfo.email?.trim() || `${subject}@cinaauth.invalid`;

	const { storage } = await resolveAdminRequestRuntime(request);
	const { repositories } = storage;
	const userId = await upsertPortalUser(repositories.users, subject, email);
	await repositories.portalLedger.ensureUserEarnings(userId);

	const sessionToken = generateSessionToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + PORTAL_SESSION_TTL_MS);
	await repositories.portalAccess.deleteExpiredSessions(now.toISOString());
	await repositories.portalAccess.insertSession({
		tokenHash: await hashSessionToken(sessionToken),
		subject,
		email,
		createdAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
	});

	const destination = new URL(callbackPath, config.appOrigin);
	const response = NextResponse.redirect(destination, 302);
	clearTransactionCookie(response);
	response.cookies.set(CINATOKEN_SESSION_COOKIE, sessionToken, {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		expires: expiresAt,
	});
	response.cookies.delete(USER_SESSION_COOKIE);
	response.cookies.delete('admin_session');
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

/** Completes OIDC, checks the live CinaAuth role, and creates a local console session. */
export async function GET(request: NextRequest): Promise<NextResponse> {
	const transactionCookie = request.cookies.get(CINATOKEN_OIDC_TRANSACTION_COOKIE)?.value;
	if (!transactionCookie) return fail(request, 'invalid_transaction');

	try {
		const config = getCinaAuthConfig(request);
		const secrets = getCinaAuthSecrets(request);
		const transaction = await openCinaAuthTransaction(
			transactionCookie,
			secrets.transactionSecret,
		);
		if (!transaction) return fail(request, 'invalid_transaction');

		const authorizationServer = await discoverCinaAuthAuthorizationServer(config, request);
		const tokens = await exchangeCinaAuthAuthorizationCode({
			server: authorizationServer,
			config,
			callbackUrl: new URL(request.url),
			transaction,
			clientSecret: secrets.clientSecret,
			sourceRequest: request,
		});

		if (transaction.intent === 'portal') {
			return await completePortalLogin(
				request,
				tokens.accessToken,
				tokens.subject,
				transaction.callbackPath,
			);
		}

		const bridgeRequest = new Request(
			`${config.issuer}/api/auth/cinatoken-oidc/session`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${tokens.accessToken}`,
					origin: config.appOrigin,
					'x-cinatoken-bridge-secret': secrets.bridgeSecret,
				},
				cache: 'no-store',
			},
		);
		const bridge = await fetchCinaAuth(bridgeRequest, request);
		const body = (await bridge.json().catch(() => null)) as BridgeResponse | null;
		if (
			!bridge.ok ||
			body?.ok !== true ||
			body.user?.id !== tokens.subject ||
			!hasRequiredCinaAuthRole(body.user.role, config.requiredRoles)
		) {
			logAdminAuthEvent('admin.auth.login_failed', request, {
				username: cinaAuthSessionUsername(tokens.subject),
			});
			return fail(request, 'admin_forbidden', transaction.callbackPath);
		}

		const sessionToken = generateSessionToken();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
		const username = cinaAuthSessionUsername(tokens.subject);
		const { storage } = await resolveAdminRequestRuntime(request);
		const email = body.user.email?.trim() || `${tokens.subject}@cinaauth.invalid`;
		const userId = await upsertPortalUser(
			storage.repositories.users,
			tokens.subject,
			email,
		);
		await storage.repositories.portalLedger.ensureUserEarnings(userId);
		await Promise.all([
			storage.repositories.adminAccess.deleteExpiredSessions(now.toISOString()),
			storage.repositories.portalAccess.deleteExpiredSessions(now.toISOString()),
		]);
		const tokenHash = await hashSessionToken(sessionToken);
		await storage.repositories.adminAccess.insertSession({
			tokenHash,
			username,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
		});
		await storage.repositories.portalAccess.insertSession({
			tokenHash,
			subject: tokens.subject,
			email,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
		});

		const destination = new URL(transaction.callbackPath, config.appOrigin);
		const response = NextResponse.redirect(destination, 302);
		clearTransactionCookie(response);
		response.cookies.set(CINATOKEN_SESSION_COOKIE, sessionToken, {
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/',
			expires: expiresAt,
		});
		response.cookies.delete(USER_SESSION_COOKIE);
		response.cookies.delete('admin_session');
		response.headers.set('Cache-Control', 'no-store');
		logAdminAuthEvent('admin.auth.login', request, { username });
		return response;
	} catch (error) {
		console.error(
			JSON.stringify({
				level: 'error',
				message: 'cinatoken.oidc_callback_failed',
				...getCinaAuthOidcFailureDetails(error),
			}),
		);
		return fail(request, 'oidc_failed');
	}
}
