export type BrowserSessionStatus = 'authenticated' | 'unauthenticated' | 'unavailable';

/** An outage or malformed response is not evidence that the session expired. */
export async function checkCinaAuthBrowserSession(
	intent: 'admin' | 'portal',
	request: typeof fetch = fetch,
): Promise<BrowserSessionStatus> {
	try {
		const response = await request(intent === 'admin' ? '/api/auth/check' : '/api/user/me', {
			cache: 'no-store', signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 401 || response.status === 403) return 'unauthenticated';
		if (!response.ok) return 'unavailable';
		const data: unknown = await response.json();
		if (!data || typeof data !== 'object') return 'unavailable';
		if (intent === 'admin') {
			if (!('authenticated' in data) || typeof data.authenticated !== 'boolean') return 'unavailable';
			return data.authenticated ? 'authenticated' : 'unauthenticated';
		}
		if (!('success' in data) || data.success !== true || !('data' in data) ||
			!data.data || typeof data.data !== 'object' || !('userId' in data.data) ||
			typeof data.data.userId !== 'string' || !data.data.userId) return 'unavailable';
		return 'authenticated';
	} catch {
		return 'unavailable';
	}
}
