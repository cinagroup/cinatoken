/**
 * Public catalog discovery (no API key): runtime model capabilities from active routes.
 */
import { Hono } from 'hono';
import type { GatewayRepositories } from '@octafuse/core';
import { BILLING_CURRENCY_KEY, DEFAULT_BILLING_CURRENCY } from '@octafuse/core/lib/billing-currency';
import { parseCatalogRouteGroupsQuery } from '../lib/model-list-parse';
import { aggregateCatalogProviders, listCatalogDiscoveryModels } from '../services/catalog-discovery';
import { aggregatePublicModelStats, PUBLIC_STATS_MINIMUM_SAMPLE_SIZE, type PublicModelStats } from '../services/public-catalog-stats';
import {
	createPublicStatsSingleflight,
	type PublicStatsCache,
	type PublicStatsRateLimiter,
	type PublicStatsRuntimeGuard,
} from '../services/public-stats-runtime-guard';

export type CatalogEnv = {
	Bindings: { PUBLIC_STATS_RATE_LIMITER?: PublicStatsRateLimiter };
	Variables: { repositories: GatewayRepositories };
};

const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';
const PUBLIC_STATS_CACHE_CONTROL = 'public, max-age=60';

function setPublicCatalogCache(c: { header(name: string, value: string): void }): void {
	c.header('Cache-Control', PUBLIC_CACHE_CONTROL);
}

async function readPublicBillingCurrency(repos: GatewayRepositories): Promise<string> {
	const raw: unknown = await repos.systemConfig.getConfig(BILLING_CURRENCY_KEY);
	// An absent row retains the explicit historical default. Storage failures and
	// malformed stored values cannot change the unit of a published price to USD.
	if (raw === null) return DEFAULT_BILLING_CURRENCY;
	if (typeof raw !== 'string' || !/^[A-Za-z]{3}$/.test(raw.trim())) {
		throw new TypeError('Invalid public catalog billing currency');
	}
	return raw.trim().toUpperCase();
}

async function listPublicCatalogModels(repos: GatewayRepositories, options?: { routeGroups?: string[] | null }) {
	try {
		return await listCatalogDiscoveryModels(repos, options);
	} catch (error) {
		console.warn('[Gateway] public catalog read failed; retrying once', {
			error_type: error instanceof Error ? error.name : 'UnknownError',
		});
		return listCatalogDiscoveryModels(repos, options);
	}
}

function utcDateOnly(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function publicStatsWindow(days: number, end: Date): { start: Date; startDate: string; endDate: string } {
	const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
	start.setUTCDate(start.getUTCDate() - (days - 1));
	return { start, startDate: utcDateOnly(start), endDate: utcDateOnly(end) };
}

function workersPublicStatsCache(): PublicStatsCache | undefined {
	return (globalThis as unknown as { caches?: { default?: PublicStatsCache } }).caches?.default;
}

type PublicStatsPayload = {
	object: 'list';
	data: PublicModelStats[];
	range: string;
	window_start: string;
	window_end: string;
	minimum_sample_size: number;
	generated_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function boundedText(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function safeCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function utcInstant(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** The cache contains this exact public DTO, never an upstream error or private row. */
function validPublicStatsPayload(value: unknown, range: string, days: number): value is PublicStatsPayload {
	if (
		!isRecord(value) ||
		!hasExactFields(value, ['object', 'data', 'range', 'window_start', 'window_end', 'minimum_sample_size', 'generated_at']) ||
		value.object !== 'list' ||
		value.range !== range ||
		value.minimum_sample_size !== PUBLIC_STATS_MINIMUM_SAMPLE_SIZE ||
		!utcInstant(value.window_start) ||
		!utcInstant(value.window_end) ||
		!utcInstant(value.generated_at) ||
		value.window_end !== value.generated_at ||
		!Array.isArray(value.data) ||
		value.data.length > 5_000
	)
		return false;
	if (publicStatsWindow(days, new Date(value.window_end)).start.toISOString() !== value.window_start) return false;
	const ids = new Set<string>();
	for (const row of value.data) {
		if (
			!isRecord(row) ||
			!hasExactFields(row, [
				'id',
				'slug',
				'display_name',
				'vendor',
				'request_count',
				'success_rate',
				'avg_latency_ms',
				'output_tokens',
				'total_tokens',
			]) ||
			!boundedText(row.id, 2_000) ||
			!boundedText(row.slug, 256) ||
			!/^[A-Za-z0-9._:~-]+$/.test(row.slug) ||
			!boundedText(row.display_name, 2_000) ||
			!boundedText(row.vendor, 80) ||
			ids.has(row.id) ||
			!safeCount(row.request_count) ||
			row.request_count < PUBLIC_STATS_MINIMUM_SAMPLE_SIZE ||
			typeof row.success_rate !== 'number' ||
			!Number.isFinite(row.success_rate) ||
			row.success_rate < 0 ||
			row.success_rate > 100 ||
			(row.avg_latency_ms !== null &&
				(typeof row.avg_latency_ms !== 'number' || !Number.isFinite(row.avg_latency_ms) || row.avg_latency_ms < 0)) ||
			!safeCount(row.output_tokens) ||
			!safeCount(row.total_tokens) ||
			row.output_tokens > row.total_tokens
		)
			return false;
		ids.add(row.id);
	}
	return true;
}

const PUBLIC_STATS_MAX_CACHE_BYTES = 16 * 1_024 * 1_024;

async function readPublicStatsCache(response: Response, range: string, days: number): Promise<PublicStatsPayload | null> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		if (
			response.status !== 200 ||
			response.headers.has('Set-Cookie') ||
			response.headers.get('Cache-Control')?.trim().toLowerCase() !== PUBLIC_STATS_CACHE_CONTROL ||
			response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
			!response.body
		)
			return null;
		const declared = response.headers.get('Content-Length');
		if (declared && (!/^\d+$/.test(declared) || Number(declared) > PUBLIC_STATS_MAX_CACHE_BYTES)) return null;
		reader = response.body.getReader();
		const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
		let bytes = 0;
		let json = '';
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > PUBLIC_STATS_MAX_CACHE_BYTES) return null;
			json += decoder.decode(part.value, { stream: true });
		}
		json += decoder.decode();
		const value: unknown = JSON.parse(json);
		return validPublicStatsPayload(value, range, days) ? value : null;
	} catch {
		return null;
	} finally {
		if (reader) {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		} else {
			await response.body?.cancel().catch(() => undefined);
		}
	}
}

export function createCatalogRoutes(runtime?: PublicStatsRuntimeGuard): Hono<CatalogEnv> {
	const catalogRoutes = new Hono<CatalogEnv>();
	const singleflight = runtime?.singleflight ?? createPublicStatsSingleflight();
	catalogRoutes.use('*', async (c, next) => {
		c.header('Cache-Control', 'no-store');
		await next();
	});
	catalogRoutes.onError((error, c) => {
		console.error('[Gateway] public catalog request failed', { error_type: error.name });
		return c.json(
			{ error: { code: 'public_catalog_temporarily_unavailable', message: 'Public catalog is temporarily unavailable' } },
			503,
			{ 'Cache-Control': 'no-store', 'Retry-After': '60' },
		);
	});

	/**
	 * `GET /catalog/models`
	 *
	 * Optional query:
	 * - `route_groups` — CSV filter (case-insensitive). Omitted → all active route groups.
	 */
	catalogRoutes.get('/models', async (c) => {
		const repos = c.get('repositories');
		const routeGroups = parseCatalogRouteGroupsQuery(c.req.query('route_groups'));
		const [data, billingCurrency] = await Promise.all([listPublicCatalogModels(repos, { routeGroups }), readPublicBillingCurrency(repos)]);
		setPublicCatalogCache(c);

		return c.json({
			object: 'list',
			data,
			billing_currency: billingCurrency,
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
		const [models, billingCurrency] = await Promise.all([listPublicCatalogModels(repos), readPublicBillingCurrency(repos)]);
		const model = models.find(
			(candidate) => candidate.slug === slug && candidate.vendor.localeCompare(vendor, undefined, { sensitivity: 'base' }) === 0,
		);
		if (!model) {
			return c.json({ error: { code: 'catalog_model_not_found', message: 'Catalog model not found' } }, 404);
		}
		setPublicCatalogCache(c);
		return c.json({
			object: 'model',
			data: model,
			billing_currency: billingCurrency,
			generated_at: new Date().toISOString(),
		});
	});

	/** `GET /catalog/providers` — provider capability aggregates, never credentials or endpoints. */
	catalogRoutes.get('/providers', async (c) => {
		const repos = c.get('repositories');
		const [models, billingCurrency] = await Promise.all([listPublicCatalogModels(repos), readPublicBillingCurrency(repos)]);
		setPublicCatalogCache(c);
		return c.json({
			object: 'list',
			data: aggregateCatalogProviders(models),
			billing_currency: billingCurrency,
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
					const value = await readPublicStatsCache(cached, range, days);
					if (value)
						return c.json(value, 200, {
							'Cache-Control': PUBLIC_STATS_CACHE_CONTROL,
							'X-CinaToken-Cache': 'HIT',
						});
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
				listPublicCatalogModels(repos),
				repos.analytics.queryPublicModelAnalytics({ startDate, endDate }),
			]);
			const payload = {
				object: 'list',
				data: aggregatePublicModelStats(models, rows),
				range,
				window_start: start.toISOString(),
				window_end: end.toISOString(),
				minimum_sample_size: PUBLIC_STATS_MINIMUM_SAMPLE_SIZE,
				generated_at: end.toISOString(),
			};
			if (!validPublicStatsPayload(payload, range, days)) throw new TypeError('Invalid public statistics result');
			const response = c.json(payload);
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
