export type PublicStatsCache = {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
};

export type PublicStatsRateLimiter = {
	limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type PublicStatsSingleflight = {
	run(key: string, loader: () => Promise<Response>): Promise<Response>;
};

export type PublicStatsRuntimeGuard = {
	cache?: PublicStatsCache;
	rateLimiter?: PublicStatsRateLimiter;
	singleflight: PublicStatsSingleflight;
};

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RATE_LIMIT = 12;
const DEFAULT_RATE_PERIOD_MS = 60_000;

function canonicalCacheKey(request: Request): string {
	const url = new URL(request.url);
	url.hash = '';
	url.searchParams.sort();
	return `${url.pathname}?${url.searchParams.toString()}`;
}

export function createPublicStatsSingleflight(): PublicStatsSingleflight {
	const inFlight = new Map<string, Promise<Response>>();
	return {
		async run(key, loader) {
			const current = inFlight.get(key);
			if (current) return (await current).clone();
			const pending = loader();
			inFlight.set(key, pending);
			try {
				return await pending;
			} finally {
				if (inFlight.get(key) === pending) inFlight.delete(key);
			}
		},
	};
}

/** Process-local fallback for Node/Docker, where Workers Cache API and rate-limit bindings do not exist. */
export function createInMemoryPublicStatsRuntimeGuard(options?: {
	now?: () => number;
	ttlMs?: number;
	limit?: number;
	periodMs?: number;
}): PublicStatsRuntimeGuard {
	const now = options?.now ?? Date.now;
	const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
	const limit = options?.limit ?? DEFAULT_RATE_LIMIT;
	const periodMs = options?.periodMs ?? DEFAULT_RATE_PERIOD_MS;
	const cached = new Map<string, { expiresAt: number; response: Response }>();
	const counters = new Map<string, { windowStart: number; count: number }>();

	return {
		cache: {
			async match(request) {
				const key = canonicalCacheKey(request);
				const entry = cached.get(key);
				if (!entry) return undefined;
				if (entry.expiresAt <= now()) {
					cached.delete(key);
					return undefined;
				}
				return entry.response.clone();
			},
			async put(request, response) {
				cached.set(canonicalCacheKey(request), {
					expiresAt: now() + ttlMs,
					response: response.clone(),
				});
			},
		},
		rateLimiter: {
			async limit({ key }) {
				const currentWindow = Math.floor(now() / periodMs) * periodMs;
				const counter = counters.get(key);
				if (!counter || counter.windowStart !== currentWindow) {
					counters.set(key, { windowStart: currentWindow, count: 1 });
					return { success: true };
				}
				if (counter.count >= limit) return { success: false };
				counter.count += 1;
				return { success: true };
			},
		},
		singleflight: createPublicStatsSingleflight(),
	};
}
