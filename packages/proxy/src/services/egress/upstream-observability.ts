/**
 * Return an endpoint label that is safe for logs.
 *
 * Provider endpoint query strings, fragments, and URL credentials may contain
 * API keys. Keep only the transport, host, port, and path; callers must never
 * fall back to logging the raw value when parsing fails.
 */
export function sanitizeUpstreamUrlForLog(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return '[unsupported-upstream-url]';
		}
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return '[invalid-upstream-url]';
	}
}

/** Error class is useful operationally without risking URLs or credentials in messages. */
export function upstreamErrorNameForLog(error: unknown): string {
	if (error instanceof Error && error.name.trim()) return error.name;
	return typeof error;
}
