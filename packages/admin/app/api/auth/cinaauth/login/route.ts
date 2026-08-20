import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as oauth from 'oauth4webapi';
import { getCinaAuthConfig, getCinaAuthSecrets } from '@/lib/cinaauth/config';
import {
	createCinaAuthAuthorizationUrl,
	discoverCinaAuthAuthorizationServer,
} from '@/lib/cinaauth/oidc-client';
import {
	CINATOKEN_OIDC_TRANSACTION_COOKIE,
	sanitizeCinaAuthCallbackPath,
	sealCinaAuthTransaction,
} from '@/lib/cinaauth/transaction';

export const dynamic = 'force-dynamic';

const unavailable = (request: NextRequest): NextResponse => {
	const url = new URL('/', request.url);
	url.searchParams.set('auth_error', 'oidc_unavailable');
	return NextResponse.redirect(url, 302);
};

/** Starts the confidential CinaAuth Authorization Code + PKCE flow. */
export async function GET(request: NextRequest): Promise<NextResponse> {
	try {
		const config = getCinaAuthConfig(request);
		const { transactionSecret } = getCinaAuthSecrets(request);
		const transaction = {
			state: oauth.generateRandomState(),
			nonce: oauth.generateRandomNonce(),
			codeVerifier: oauth.generateRandomCodeVerifier(),
			callbackPath: sanitizeCinaAuthCallbackPath(
				request.nextUrl.searchParams.get('callbackURL'),
			),
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
		response.cookies.set(CINATOKEN_OIDC_TRANSACTION_COOKIE, transactionCookie, {
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
