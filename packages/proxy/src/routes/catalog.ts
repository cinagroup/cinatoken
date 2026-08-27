/**
 * Public catalog discovery (no API key): runtime model capabilities from active routes.
 */
import { Hono } from 'hono';
import { BILLING_CURRENCY_KEY, normalizeBillingCurrencyCode } from '@octafuse/core/lib/billing-currency';
import type { Env } from '../app';
import { parseCatalogRouteGroupsQuery } from '../lib/model-list-parse';
import {
	aggregateCatalogProviders,
	listCatalogDiscoveryModels,
} from '../services/catalog-discovery';
import { aggregatePublicModelStats, PUBLIC_STATS_MINIMUM_SAMPLE_SIZE } from '../services/public-catalog-stats';
import {
	createPublicStatsSingleflight,
	type PublicStatsRuntimeGuard,
} from '../services/public-stats-runtime-guard';

const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
const PUBLIC_STATS_CACHE_CONTROL = 'public, max-age=60';

function setPublicCatalogCache(c: { header(name: string, value: string): void }): void {
	c.header('Cache-Control', PUBLIC_CACHE_CONTROL);
}

function utcDateOnly(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function publicStatsWindow(days: number, end: Date): { start: Date; startDate: string; endDate: string } {
	const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
	start.setUTCDate(start.getUTCDate() - (days - 1));
	return { start, startDate: utcDateOnly(start), endDate: utcDateOnly(end) };
}

function workersPublicStatsCache(): Cache | undefined {
	return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
}

export function createCatalogRoutes(runtime?: PublicStatsRuntimeGuard): Hono<Env> {
	const catalogRoutes = new Hono<Env>();
	const singleflight = runtime?.singleflight ?? createPublicStatsSingleflight();

/**
 * `GET /catalog/models`
 *
 * Optional query:
 * - `route_groups` — CSV filter (case-insensitive). Omitted → all active route groups.
 */
catalogRoutes.get('/models', async (c) => {
	const repos = c.get('repositories');
	const routeGroups = parseCatalogRouteGroupsQuery(c.req.query('route_groups'));
	const [data, billingCurrencyRaw] = await Promise.all([
		listCatalogDiscoveryModels(repos, { routeGroups }),
		repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
	]);
	setPublicCatalogCache(c);

	return c.json({
		object: 'list',
		data,
		billing_currency: normalizeBillingCurrencyCode(billingCurrencyRaw),
		generated_at: new Date().toISOString(),
	});
});

/** `GET /catalog/models/:vendor/:slug` — one sanitized active model. */
catalogRoutes.get('/models/:vendor/:slug', async (c) => {
	const vendor = c.req.param('vendor').trim();
	const slug = c.req.param('slug').trim();
	if (!vendor || vendor.length > 80 || !slug || slug.length > 256 || !/^[A-Za-z0-9._:~-]+$/.test(slug)) {
		return c.json({ error: { code: 'invalid_catalog_path', message: 'Invalid catalog model path' } }, 400);
	}
	const repos = c.get('repositories');
	const [models, billingCurrencyRaw] = await Promise.all([
		listCatalogDiscoveryModels(repos),
		repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
	]);
	const model = models.find((candidate) =>
		candidate.slug === slug && candidate.vendor.localeCompare(vendor, undefined, { sensitivity: 'base' }) === 0
	);
	setPublicCatalogCache(c);
	if (!model) {
		return c.json({ error: { code: 'catalog_model_not_found', message: 'Catalog model not found' } }, 404);
	}
	return c.json({
		object: 'model',
		data: model,
		billing_currency: normalizeBillingCurrencyCode(billingCurrencyRaw),
		generated_at: new Date().toISOString(),
	});
});

/** `GET /catalog/providers` — provider capability aggregates, never credentials or endpoints. */
catalogRoutes.get('/providers', async (c) => {
	const repos = c.get('repositories');
	const [models, billingCurrencyRaw] = await Promise.all([
		listCatalogDiscoveryModels(repos),
		repos.systemConfig.getConfig(BILLING_CURRENCY_KEY),
	]);
	setPublicCatalogCache(c);
	return c.json({
		object: 'list',
		data: aggregateCatalogProviders(models),
		billing_currency: normalizeBillingCurrencyCode(billingCurrencyRaw),
		generated_at: new Date().toISOString(),
	});
});

/** `GET /catalog/stats/models?range=7d|30d|90d` — privacy-thresholded public aggregates. */
catalogRoutes.get('/stats/models', async (c) => {
	const range = c.req.query('range') ?? '7d';
	const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null;
	if (days === null) return c.json({ error: { code: 'invalid_range', message: 'range must be 7d, 30d, or 90d' } }, 400);

	const cache = workersPublicStatsCache() ?? runtime?.cache;
	const cacheUrl = new URL('/catalog/stats/models', c.req.url);
	cacheUrl.searchParams.set('range', range);
	const cacheKey = new Request(cacheUrl, { method: 'GET' });
	if (cache) {
		try {
			const cached = await cache.match(cacheKey);
			if (cached) {
				const response = new Response(cached.body, cached);
				response.headers.set('X-CinaToken-Cache', 'HIT');
				return response;
			}
		} catch (error) {
			console.warn('[Gateway] public stats cache read failed', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	return singleflight.run(range, async () => {
		const limiter = c.env?.PUBLIC_STATS_RATE_LIMITER ?? runtime?.rateLimiter;
		if (limiter) {
			try {
				const result = await limiter.limit({ key: `catalog-stats:${range}` });
				if (!result.success) {
					return c.json(
						{ error: { code: 'public_stats_rate_limited', message: 'Public statistics are temporarily rate limited' } },
						429,
						{ 'Cache-Control': 'no-store', 'Retry-After': '60' },
					);
				}
			} catch (error) {
				console.error('[Gateway] public stats rate limiter failed', { error: error instanceof Error ? error.message : String(error) });
				return c.json(
					{ error: { code: 'public_stats_temporarily_unavailable', message: 'Public statistics are temporarily unavailable' } },
					503,
					{ 'Cache-Control': 'no-store', 'Retry-After': '60' },
				);
			}
		}

		const end = new Date();
		const { start, startDate, endDate } = publicStatsWindow(days, end);
		const repos = c.get('repositories');
		const [models, rows] = await Promise.all([
			listCatalogDiscoveryModels(repos),
			repos.analytics.queryPublicModelAnalytics({ startDate, endDate }),
		]);
		const response = c.json({
			object: 'list',
			data: aggregatePublicModelStats(models, rows),
			range,
			window_start: start.toISOString(),
			window_end: end.toISOString(),
			minimum_sample_size: PUBLIC_STATS_MINIMUM_SAMPLE_SIZE,
			generated_at: end.toISOString(),
		});
		response.headers.set('Cache-Control', PUBLIC_STATS_CACHE_CONTROL);
		response.headers.set('X-CinaToken-Cache', 'MISS');
		if (!cache) return response;
		try {
			await cache.put(cacheKey, response.clone());
		} catch (error) {
			console.warn('[Gateway] public stats cache write failed', { error: error instanceof Error ? error.message : String(error) });
		}
		return response;
	});
});

	return catalogRoutes;
}

export const catalogRoutes = createCatalogRoutes();
