/** Header classification only: never decode or rewrite authorization/routing. */
export function protectUserMarketplaceResponse(
	request: Request,
	response: Response
): Response {
	let candidate = new URL(request.url).pathname;
	for (let pass = 0; pass < 4; pass++) {
		if (
			/^\/api\/user\/(?:shared-keys|earnings)(?:\/|$)/u.test(candidate) ||
			(/^\/api\/user\//u.test(candidate) && candidate.includes("%"))
		) {
			response.headers.set("Cache-Control", "private, no-store");
			return response;
		}
		try {
			const decoded = decodeURIComponent(candidate);
			if (candidate === decoded) break;
			candidate = decoded;
		} catch {
			break;
		}
	}
	return response;
}
