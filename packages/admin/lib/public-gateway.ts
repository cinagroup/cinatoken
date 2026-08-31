import { getCloudflareEnv } from '@/lib/cloudflare';

const DEFAULT_PUBLIC_API_ORIGIN = 'https://api.cinatoken.com';

type NextFetchInit = RequestInit & {
	next?: { revalidate?: number };
};

type GatewayFetcher = Pick<Fetcher, 'fetch'>;

type GatewayRuntime = {
	request?: Request;
	env?: { CINATOKEN_PROXY_SERVICE?: GatewayFetcher };
};

export function resolvePublicApiOrigin(raw = process.env.CINATOKEN_PUBLIC_API_ORIGIN): string {
	try {
		const url = new URL(raw?.trim() || DEFAULT_PUBLIC_API_ORIGIN);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
			return DEFAULT_PUBLIC_API_ORIGIN;
		}
		return url.origin;
	} catch {
		return DEFAULT_PUBLIC_API_ORIGIN;
	}
}

function resolveGatewayUrl(path: string, origin: string): URL {
	if (!path.startsWith('/') || path.startsWith('//')) {
		throw new TypeError('Gateway path must be an absolute-path reference');
	}
	return new URL(path, `${origin}/`);
}

/**
 * Fetch the data-plane Worker directly when deployed on Cloudflare. The public
 * origin remains the local/self-hosted fallback and keeps Next.js fetch caching.
 */
export async function fetchPublicGateway(
	path: string,
	init: NextFetchInit = {},
	runtime: GatewayRuntime = {},
): Promise<Response> {
	const origin = resolvePublicApiOrigin();
	const url = resolveGatewayUrl(path, origin);
	const service = runtime.env?.CINATOKEN_PROXY_SERVICE
		?? getCloudflareEnv(runtime.request)?.CINATOKEN_PROXY_SERVICE;

	if (!service) return fetch(url, init);

	const { next: _nextCache, ...requestInit } = init;
	void _nextCache;
	return service.fetch(new Request(url, requestInit));
}
