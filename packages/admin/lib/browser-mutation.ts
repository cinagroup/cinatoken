const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type BrowserMutationOriginDecision =
	| { allowed: true }
	| {
			allowed: false;
			reason: 'missing_origin' | 'origin_mismatch' | 'cross_site';
	  };

/**
 * Cookie-authenticated mutations must originate from the exact application origin.
 * Bearer-authenticated callers are checked by their route before this helper is used.
 */
export function checkBrowserMutationOrigin(
	request: Request,
	expectedOrigin = new URL(request.url).origin,
): BrowserMutationOriginDecision {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return { allowed: true };

	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return { allowed: false, reason: 'cross_site' };
	}

	const origin = request.headers.get('origin');
	if (!origin) return { allowed: false, reason: 'missing_origin' };
	if (origin !== expectedOrigin) return { allowed: false, reason: 'origin_mismatch' };
	return { allowed: true };
}

export function rejectInvalidBrowserMutationOrigin(request: Request): Response | null {
	const decision = checkBrowserMutationOrigin(request);
	if (decision.allowed) return null;
	return Response.json(
		{ success: false, message: 'Forbidden: invalid request origin' },
		{ status: 403, headers: { 'Cache-Control': 'no-store' } },
	);
}

export function rejectInvalidAdminMutationOrigin(
	request: Request,
	principalType: 'console' | 'api_key',
): Response | null {
	return principalType === 'api_key' ? null : rejectInvalidBrowserMutationOrigin(request);
}
