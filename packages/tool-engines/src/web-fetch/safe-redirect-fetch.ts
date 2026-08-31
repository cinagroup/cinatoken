import { assertFetchUrlSafe } from './url-guard';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class UnsafeFetchDestinationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsafeFetchDestinationError';
	}
}

export type SafeRedirectFetchResult = {
	response: Response;
	finalUrl: string;
	redirects: number;
};

/**
 * Fetch a provider-returned public URL while revalidating every redirect hop.
 * This blocks literal private destinations; callers that accept attacker-owned
 * DNS still need a deployment-specific hostname allowlist or DNS pinning.
 */
export async function fetchWithSafeRedirects(
	rawUrl: string,
	options: {
		fetchImpl?: typeof fetch;
		init?: RequestInit;
		maxRedirects?: number;
		requireHttps?: boolean;
		allowIpLiterals?: boolean;
	} = {},
): Promise<SafeRedirectFetchResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxRedirects = Math.min(10, Math.max(0, Math.floor(options.maxRedirects ?? 5)));
	let current = rawUrl;
	let previousOrigin: string | null = null;
	const headers = new Headers(options.init?.headers);

	for (let redirects = 0; ; redirects += 1) {
		const guarded = assertFetchUrlSafe(current);
		if (!guarded.ok) throw new UnsafeFetchDestinationError(guarded.error);
		if (options.allowIpLiterals === false && (guarded.hostname.includes(':') || /^\d+(?:\.\d+){3}$/u.test(guarded.hostname))) {
			throw new UnsafeFetchDestinationError('IP-literal destinations are not allowed');
		}
		const parsed = new URL(guarded.url);
		if (options.requireHttps && parsed.protocol !== 'https:') {
			throw new UnsafeFetchDestinationError('url must use https');
		}
		if (previousOrigin != null && previousOrigin !== parsed.origin) {
			headers.delete('authorization');
			headers.delete('cookie');
			headers.delete('proxy-authorization');
		}
		const response = await fetchImpl(parsed.toString(), {
			...options.init,
			headers,
			redirect: 'manual',
		});
		if (!REDIRECT_STATUSES.has(response.status)) {
			return { response, finalUrl: parsed.toString(), redirects };
		}
		const location = response.headers.get('location');
		await response.body?.cancel('safe_redirect_follow').catch(() => undefined);
		if (!location) throw new UnsafeFetchDestinationError('redirect response has no location');
		if (redirects >= maxRedirects) throw new UnsafeFetchDestinationError('redirect limit exceeded');
		previousOrigin = parsed.origin;
		current = new URL(location, parsed).toString();
	}
}
