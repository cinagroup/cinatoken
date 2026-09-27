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
 * This is only for bodyless resource downloads. A redirected POST could replay
 * already accepted work because the same RequestInit is used at every hop.
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
		/** Optional caller-owned, abortable disposal; invoked once for every redirect body. */
		cancelResponseBody?: (response: Response, reason: string) => Promise<void>;
	} = {},
): Promise<SafeRedirectFetchResult> {
	const method = options.init?.method?.toUpperCase() ?? 'GET';
	if ((method !== 'GET' && method !== 'HEAD') || options.init?.body != null) {
		throw new UnsafeFetchDestinationError('safe redirect fetch requires a bodyless GET or HEAD');
	}
	const requestedRedirects = options.maxRedirects ?? 5;
	if (!Number.isSafeInteger(requestedRedirects) || requestedRedirects < 0) {
		throw new UnsafeFetchDestinationError('invalid redirect limit');
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxRedirects = Math.min(10, requestedRedirects);
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
		if (options.cancelResponseBody) await options.cancelResponseBody(response, 'safe_redirect_follow');
		else await response.body?.cancel('safe_redirect_follow').catch(() => undefined);
		if (!location) throw new UnsafeFetchDestinationError('redirect response has no location');
		if (redirects >= maxRedirects) throw new UnsafeFetchDestinationError('redirect limit exceeded');
		previousOrigin = parsed.origin;
		current = new URL(location, parsed).toString();
	}
}
