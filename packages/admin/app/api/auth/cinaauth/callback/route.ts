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

export const dynamic = 'force-dynamic';

type BridgeResponse = {
	ok?: boolean;
	user?: { id?: string; email?: string | null; role?: string | null };
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

const fail = (request: NextRequest, error: string): NextResponse => {
	const url = new URL('/', request.url);
	url.searchParams.set('auth_error', error);
	const response = NextResponse.redirect(url, 302);
	clearTransactionCookie(response);
	response.headers.set('Cache-Control', 'no-store');
	return response;
};

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
			return fail(request, 'admin_forbidden');
		}

		const sessionToken = generateSessionToken();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
		const username = cinaAuthSessionUsername(tokens.subject);
		const { storage } = await resolveAdminRequestRuntime(request);
		await storage.repositories.adminAccess.deleteExpiredSessions(now.toISOString());
		await storage.repositories.adminAccess.insertSession({
			tokenHash: await hashSessionToken(sessionToken),
			username,
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
		});

		const destination = new URL(transaction.callbackPath, config.appOrigin);
		const response = NextResponse.redirect(destination, 302);
		clearTransactionCookie(response);
		response.cookies.set('admin_session', sessionToken, {
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			path: '/',
			expires: expiresAt,
		});
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
