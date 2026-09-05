/** The UI may announce logout only after the server confirms session revocation. */
export async function requestCinaAuthLogout(request: typeof fetch = fetch): Promise<boolean> {
	try {
		const response = await request('/api/auth/logout', {
			method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return false;
		const result: unknown = await response.json();
		return !!result && typeof result === 'object' && 'success' in result && result.success === true;
	} catch {
		return false;
	}
}
