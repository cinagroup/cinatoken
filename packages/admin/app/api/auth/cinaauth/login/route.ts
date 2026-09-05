import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as oauth from 'oauth4webapi';
import { getCinaAuthConfig, getCinaAuthSecrets } from '@/lib/cinaauth/config';
import {
	createCinaAuthAuthorizationUrl,
	discoverCinaAuthAuthorizationServer,
} from '@/lib/cinaauth/oidc-client';
import {
	cinaAuthTransactionCookieName,
	sanitizeCinaAuthCallbackPath,
	sealCinaAuthTransaction,
} from '@/lib/cinaauth/transaction';
import { isCinaAuthPopupRequestId } from '@/lib/cinaauth/popup';
import { createCinaAuthPopupCompletionResponse } from '@/lib/cinaauth/popup-response';
import { canResumeCinaAuthSession } from '@/lib/cinaauth/resume-session';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { getSessionCookieToken } from '@/lib/unified-session';

export const dynamic = 'force-dynamic';

const unavailable = (request: NextRequest): NextResponse => {
	const intent = request.nextUrl.searchParams.get('intent') === 'portal' ? 'portal' : 'admin';
	const popupRequestId = request.nextUrl.searchParams.get('request');
	if (
		request.nextUrl.searchParams.get('presentation') === 'popup' &&
		isCinaAuthPopupRequestId(popupRequestId)
	) {
		return createCinaAuthPopupCompletionResponse({
			requestId: popupRequestId,
			appOrigin: request.nextUrl.origin,
			callbackPath: sanitizeCinaAuthCallbackPath(
				request.nextUrl.searchParams.get('callbackURL'),
				intent === 'portal' ? '/account' : '/dashboard',
			),
			ok: false,
			error: 'oidc_unavailable',
		});
	}
	const url = new URL('/', request.url);
	url.searchParams.set('auth_error', 'oidc_unavailable');
	return NextResponse.redirect(url, 302);
};

/** Starts the confidential CinaAuth Authorization Code + PKCE flow. */
export async function GET(request: NextRequest): Promise<NextResponse> {
	try {
		const config = getCinaAuthConfig(request);
		const intent: 'admin' | 'portal' =
			request.nextUrl.searchParams.get('intent') === 'portal' ? 'portal' : 'admin';
		const isPopup = request.nextUrl.searchParams.get('presentation') === 'popup';
		const popupRequestId = isPopup
			? request.nextUrl.searchParams.get('request')
			: null;
		if (isPopup && !isCinaAuthPopupRequestId(popupRequestId)) {
			throw new TypeError('CinaAuth popup request id is invalid');
		}
		const callbackPath = sanitizeCinaAuthCallbackPath(
			request.nextUrl.searchParams.get('callbackURL'),
			intent === 'portal' ? '/account' : '/dashboard',
		);
		if (request.nextUrl.searchParams.get('mode') !== 'register' &&
			getSessionCookieToken(request, intent === 'portal' ? 'user_session' : 'admin_session')) {
			const { storage, bindings } = await resolveAdminRequestRuntime(request);
			if (await canResumeCinaAuthSession(request, intent, storage.repositories, bindings)) {
				const response = popupRequestId
					? createCinaAuthPopupCompletionResponse({ requestId: popupRequestId, appOrigin: config.appOrigin, callbackPath, ok: true })
					: NextResponse.redirect(new URL(callbackPath, config.appOrigin), 302);
				response.headers.set('Cache-Control', 'no-store');
				return response;
			}
		}
		const { transactionSecret } = getCinaAuthSecrets(request);
		const transaction = {
			state: oauth.generateRandomState(),
			nonce: oauth.generateRandomNonce(),
			codeVerifier: oauth.generateRandomCodeVerifier(),
			callbackPath,
			intent,
			...(popupRequestId === null ? {} : { popupRequestId }),
			createdAt: Date.now(),
		};
		const [authorizationServer, transactionCookie] = await Promise.all([
			discoverCinaAuthAuthorizationServer(config, request),
			sealCinaAuthTransaction(transaction, transactionSecret),
		]);
		const authorizationUrl = await createCinaAuthAuthorizationUrl(
			authorizationServer,
			config,
			transaction,
		);
		if (request.nextUrl.searchParams.get('mode') === 'register') {
			authorizationUrl.searchParams.set('prompt', 'create');
		}
		const response = NextResponse.redirect(authorizationUrl, 302);
		const cookieName = cinaAuthTransactionCookieName(transaction.state);
		if (!cookieName) throw new Error('Invalid generated authorization state');
		response.cookies.set(cookieName, transactionCookie, {
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/',
			maxAge: 10 * 60,
		});
		response.headers.set('Cache-Control', 'no-store');
		response.headers.set('Referrer-Policy', 'no-referrer');
		return response;
	} catch (error) {
		console.error(
			JSON.stringify({
				level: 'error',
				message: 'cinatoken.oidc_start_failed',
				code: error instanceof Error ? error.name : 'unknown',
			}),
		);
		return unavailable(request);
	}
}
