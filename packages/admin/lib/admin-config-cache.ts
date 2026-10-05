/** Keep sensitive admin responses private even when auth or setup returns before Hono. */
export function protectAdminConfigResponse(
	request: Request,
	response: Response
): Response {
	const protect = () =>
		response.headers.set(
			"Cache-Control",
			(response.headers.get("Content-Type") ?? "").includes("text/event-stream")
				? "private, no-store, no-transform"
				: "private, no-store"
		);
	const pathname = new URL(request.url).pathname;
	// Next and Hono can decode encoded paths at different boundaries. This only
	// classifies cache headers; it must not rewrite routing or authorization.
	let candidate = pathname;
	for (let pass = 0; pass < 4; pass++) {
		if (
			/^\/api\/admin\/(?:providers|models|endpoints|routes|presets|guardrails|data-policies|keys|shared-keys|earnings|request-logs|withdrawals|nft-mints)(?:\/|$)/u.test(
				candidate
			) ||
			(/^\/api\/admin\//u.test(candidate) && candidate.includes("%"))
		) {
			protect();
			return response;
		}
		try {
			const decoded = decodeURIComponent(candidate);
			if (decoded === candidate) break;
			candidate = decoded;
		} catch {
			break;
		}
	}
	if (
		/^\/api\/admin\/playground(?:\/|$)/u.test(pathname) ||
		/^\/api\/admin\/simulator\/context\/?$/u.test(pathname) ||
		/^\/api\/admin\/(?:config(?:\/|$)|business-timezone\/?$)/u.test(pathname) ||
		/^\/api\/admin\/(?:presets|guardrails)(?:\/|$)/u.test(pathname) ||
		/^\/api\/admin\/analytics\/(?:reliability|models|providers|users)\/?$/u.test(
			pathname
		) ||
		/^\/api\/admin\/request-logs(?:\/|$)/u.test(pathname) ||
		/^\/api\/admin\/budget-audit-logs(?:\/(?:filters|export\.csv))?\/?$/u.test(
			pathname
		) ||
		/^\/api\/admin\/access-keys(?:\/|$)/u.test(pathname) ||
		/^\/api\/admin\/keys(?:\/|$)/u.test(pathname) ||
		/^\/api\/admin\/(?:shared-keys|earnings)(?:\/|$)/u.test(pathname) ||
		/^\/api\/admin\/users\/?$/u.test(pathname) ||
		/^\/api\/admin\/users\/[^/]+(?:\/(?:keys(?:\/[^/]+)?|logs|audit-logs|budget\/transition(?:\/preview)?))?\/?$/u.test(
			pathname
		)
	) {
		protect();
	}
	return response;
}
