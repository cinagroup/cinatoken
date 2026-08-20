import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Starts the signed CinaAuth prompt=create authorization flow. */
export function GET(request: NextRequest): NextResponse {
	const url = new URL('/api/auth/cinaauth/login', request.url);
	url.searchParams.set('mode', 'register');
	const callbackURL = request.nextUrl.searchParams.get('callbackURL');
	if (callbackURL) url.searchParams.set('callbackURL', callbackURL);
	const response = NextResponse.redirect(url, 302);
	response.headers.set('Cache-Control', 'no-store');
	return response;
}
