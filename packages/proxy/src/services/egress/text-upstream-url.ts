/** Validate local route configuration before crossing the budget dispatch boundary. */
export function assertTextUpstreamHttpUrl(rawUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error('Text upstream endpoint is not a valid URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Text upstream endpoint must use http(s)');
	}
}
