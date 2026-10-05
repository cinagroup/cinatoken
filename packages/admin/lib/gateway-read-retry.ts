/**
 * Retry only audited, replay-safe browser reads, never arbitrary GETs or writes.
 * Each attempt must resolve its own request runtime (and fresh Hyperdrive client).
 * Portal reads provision defaults with unique-key ON CONFLICT DO NOTHING only;
 * they do not charge, credit, mint, submit jobs or update existing balances.
 * Bearer authentication can lazily migrate/touch API keys, so it is excluded.
 */
const REPLAY_SAFE_PATHS = new Set([
	"/api/auth/check",
	"/api/admin/stats",
	"/api/admin/config",
	"/api/admin/business-timezone",
	"/api/user/me",
	"/api/user/earnings/summary",
	"/api/user/shared-keys",
	"/api/user/nft/tiers",
]);

export const DATABASE_UNAVAILABLE_CODE = "DATABASE_TEMPORARILY_UNAVAILABLE";

export async function withGatewayReadRetry(
	request: Request,
	handleAttempt: (request: Request) => Promise<Response>
): Promise<Response> {
	const response = await handleAttempt(request);
	if (
		request.method !== "GET" ||
		request.headers.has("authorization") ||
		request.signal.aborted ||
		!REPLAY_SAFE_PATHS.has(new URL(request.url).pathname) ||
		response.status !== 503
	)
		return response;
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as { code?: unknown } | null;
	if (body?.code !== DATABASE_UNAVAILABLE_CODE) return response;
	await new Promise<void>((resolve) => setTimeout(resolve, 75));
	if (request.signal.aborted) return response;
	// Do not retain the failed runtime or recycle its database session.
	await response.body?.cancel();
	return handleAttempt(request);
}
