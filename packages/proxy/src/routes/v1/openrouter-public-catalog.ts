/**
 * Anonymous OpenRouter-compatible catalog surfaces.
 *
 * Every published field is derived from the current active model rows and the
 * subject-bound, verified endpoint snapshot. Provider URLs, credentials,
 * internal ids, evidence records, and arbitrary model metadata are never
 * serialized.
 */
import {
	parseModelModalitiesJson,
	routeDataPolicyAllowsZdr,
	type ModelRow,
	type RouteDataPolicyRow,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import {
	listVerifiedPublicEndpointBindings,
	parseModelEndpointPath,
	resolvePublishedPublicProviders,
	serializePublishedPublicModelEndpoint,
	serializePublishedPublicModelEndpointsDocument,
	type PublicModelEndpoint,
	type PublicModelEndpointsDocument,
	type PublishedPublicProviderCatalog,
	type PublishedPublicProviderIdentity,
	type VerifiedPublicEndpointBinding,
} from '../../services/public-model-endpoints';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import {
	createPublicStatsSingleflight,
	type PublicStatsRuntimeGuard,
} from '../../services/public-stats-runtime-guard';

const CATALOG_SNAPSHOT_VERSION = 'cinatoken.openrouter-public-catalog.v1' as const;
const CATALOG_SNAPSHOT_CACHE_PATH = '/__cinatoken/cache/openrouter-public-catalog-v1';
const CATALOG_SNAPSHOT_SINGLEFLIGHT_KEY = 'openrouter-public-catalog-snapshot';
const MAX_PUBLIC_CACHE_TTL_SECONDS = 60;
const MAX_LIMIT = 1_000;
const DEFAULT_LIMIT = 500;
const MAX_OFFSET = 1_000_000;
const MAX_QUERY_LENGTH = 200;
const MAX_PROVIDER_FILTERS = 32;
const POLICY_BATCH_SIZE = 90;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/u;
const INPUT_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'file']);
const OUTPUT_MODALITIES = new Set(['text', 'image', 'audio', 'embeddings']);
const ALLOWED_MODEL_QUERY_KEYS = new Set([
	'limit',
	'offset',
	'q',
	'input_modalities',
	'providers',
	'zdr',
	'region',
	'sort',
]);

type EdgeCache = {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
};

type OpenRouterProvider = {
	name: string;
	slug: string;
	privacy_policy_url: null;
	terms_of_service_url: null;
	status_page_url: null;
	headquarters: null;
	datacenters: null;
};

type OpenRouterModel = {
	id: string;
	canonical_slug: string;
	hugging_face_id: null;
	name: string;
	created: number | null;
	description: string;
	context_length: number | null;
	architecture: {
		modality: string | null;
		input_modalities: string[];
		output_modalities: string[];
		tokenizer: null;
		instruct_type: null;
	};
	pricing: Record<string, string | number>;
	top_provider: null;
	per_request_limits: null;
	supported_parameters: string[];
	default_parameters: Record<string, never>;
	supported_voices: null;
	knowledge_cutoff: null;
	expiration_date: null;
	links: { details: string };
	reasoning: null;
};

type ModelSort = 'newest' | 'context-high-to-low' | null;
type ModelQuery = {
	limit: number;
	offset: number;
	q: string | null;
	inputModalities: string[];
	providers: string[];
	zdr: boolean;
	region: 'eu' | 'us' | null;
	sort: ModelSort;
};
type QueryFailure = { ok: false; param: string; message: string };
type QuerySuccess = { ok: true; value: ModelQuery };
type QueryResult = QueryFailure | QuerySuccess;

type PublishedModelRecord = {
	dto: OpenRouterModel;
	details: PublicModelEndpointsDocument;
	searchText: string;
	inputModalities: string[];
	providers: string[];
	regions: string[];
	zdr: boolean;
};

type PublishedCatalogSnapshot = {
	version: typeof CATALOG_SNAPSHOT_VERSION;
	generatedAtMs: number;
	validUntilMs: number;
	providers: PublishedPublicProviderIdentity[];
	records: PublishedModelRecord[];
	recordIndex: Record<string, number>;
};

function stableStringCompare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function safeText(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized.length > 0
		&& normalized.length <= maxLength
		&& !CONTROL.test(normalized)
		? normalized
		: null;
}

function normalizedIdentity(value: string): string {
	return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function defaultEdgeCache(runtime?: PublicStatsRuntimeGuard): EdgeCache | null {
	try {
		const storage = (globalThis as typeof globalThis & {
			caches?: { default?: EdgeCache };
		}).caches;
		const cache = storage?.default;
		return cache
			&& typeof cache.match === 'function'
			&& typeof cache.put === 'function'
			? cache
			: runtime?.cache ?? null;
	} catch {
		return runtime?.cache ?? null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotCacheKey(c: Context<Env>): Request {
	const url = new URL(c.req.url);
	url.pathname = CATALOG_SNAPSHOT_CACHE_PATH;
	url.hash = '';
	url.search = '';
	return new Request(url, { method: 'GET' });
}

function parsePublishedCatalogSnapshot(
	value: unknown,
	nowMs: number
): PublishedCatalogSnapshot | null {
	if (
		!isRecord(value) ||
		value.version !== CATALOG_SNAPSHOT_VERSION ||
		typeof value.generatedAtMs !== 'number' ||
		!Number.isFinite(value.generatedAtMs) ||
		typeof value.validUntilMs !== 'number' ||
		!Number.isFinite(value.validUntilMs) ||
		value.validUntilMs <= nowMs ||
		!Array.isArray(value.providers) ||
		!Array.isArray(value.records) ||
		!isRecord(value.recordIndex) ||
		value.records.length > MAX_LIMIT
	) return null;
	if (value.providers.some((provider) =>
		!isRecord(provider) ||
		typeof provider.name !== 'string' ||
		typeof provider.slug !== 'string'
	)) return null;
	if (value.records.some((record) =>
		!isRecord(record) ||
		!isRecord(record.dto) ||
		!isRecord(record.details) ||
		!Array.isArray(record.details.endpoints) ||
		typeof record.searchText !== 'string' ||
		!Array.isArray(record.inputModalities) ||
		!Array.isArray(record.providers) ||
		!Array.isArray(record.regions) ||
		typeof record.zdr !== 'boolean' ||
		[record.inputModalities, record.providers, record.regions].some((items) =>
			(items as unknown[]).some((item) => typeof item !== 'string')
		)
	)) return null;
	const records = value.records as unknown[];
	const indexed = Object.entries(value.recordIndex);
	if (
		indexed.length !== records.length ||
		indexed.some(([canonicalSlug, index]) => {
			if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= records.length) {
				return true;
			}
			const record = records[index as number];
			return !isRecord(record) || !isRecord(record.dto) || record.dto.canonical_slug !== canonicalSlug;
		})
	) return null;
	return value as PublishedCatalogSnapshot;
}

async function snapshotFromResponse(
	response: Response,
	nowMs: number
): Promise<PublishedCatalogSnapshot | null> {
	if (!response.ok) return null;
	try {
		return parsePublishedCatalogSnapshot(await response.json(), nowMs);
	} catch {
		return null;
	}
}

function publicCacheSeconds(snapshot: PublishedCatalogSnapshot, nowMs = Date.now()): number {
	return Math.max(0, Math.min(
		MAX_PUBLIC_CACHE_TTL_SECONDS,
		Math.floor((snapshot.validUntilMs - nowMs) / 1_000)
	));
}

function applyPublicCachePolicy(
	response: Response,
	snapshot: PublishedCatalogSnapshot,
	cacheable: boolean
): Response {
	const seconds = cacheable ? publicCacheSeconds(snapshot) : 0;
	response.headers.set(
		'Cache-Control',
		seconds > 0
			? `public, max-age=${seconds}, must-revalidate`
			: 'no-store'
	);
	return response;
}

function queryFailure(param: string, message: string): QueryFailure {
	return { ok: false, param, message };
}

function oneQueryValue(search: URLSearchParams, key: string): string | null | QueryFailure {
	const values = search.getAll(key);
	return values.length > 1
		? queryFailure(key, `Query parameter "${key}" must not be repeated`)
		: values[0] ?? null;
}

function boundedInteger(
	search: URLSearchParams,
	key: 'limit' | 'offset',
	minimum: number,
	maximum: number,
	fallback: number
): number | QueryFailure {
	const raw = oneQueryValue(search, key);
	if (typeof raw !== 'string') return raw ?? fallback;
	if (!DECIMAL_INTEGER.test(raw)) {
		return queryFailure(key, `Query parameter "${key}" must be a decimal integer`);
	}
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum
		? value
		: queryFailure(
			key,
			`Query parameter "${key}" must be between ${minimum} and ${maximum}`
		);
}

function commaSeparated(
	search: URLSearchParams,
	key: 'input_modalities' | 'providers',
	maximumItems: number,
	maximumItemLength: number
): string[] | QueryFailure {
	const raw = oneQueryValue(search, key);
	if (raw === null) return [];
	if (typeof raw !== 'string') return raw;
	const items = raw.split(',').map((item) => item.trim());
	if (
		items.length === 0
		|| items.length > maximumItems
		|| items.some((item) => (
			item.length === 0
			|| item.length > maximumItemLength
			|| CONTROL.test(item)
		))
	) {
		return queryFailure(key, `Query parameter "${key}" contains an invalid list`);
	}
	return [...new Set(items.map(normalizedIdentity))].sort(stableStringCompare);
}

function parseModelQuery(url: URL): QueryResult {
	for (const key of url.searchParams.keys()) {
		if (!ALLOWED_MODEL_QUERY_KEYS.has(key)) {
			return queryFailure(key, `Unsupported query parameter "${key}"`);
		}
	}

	const limit = boundedInteger(url.searchParams, 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT);
	if (typeof limit !== 'number') return limit;
	const offset = boundedInteger(url.searchParams, 'offset', 0, MAX_OFFSET, 0);
	if (typeof offset !== 'number') return offset;

	const rawQuery = oneQueryValue(url.searchParams, 'q');
	if (typeof rawQuery !== 'string' && rawQuery !== null) return rawQuery;
	const q = rawQuery?.trim() ?? null;
	if (q !== null && (
		q.length === 0
		|| q.length > MAX_QUERY_LENGTH
		|| CONTROL.test(q)
	)) {
		return queryFailure('q', `Query parameter "q" must contain 1-${MAX_QUERY_LENGTH} safe characters`);
	}

	const inputModalities = commaSeparated(
		url.searchParams,
		'input_modalities',
		INPUT_MODALITIES.size,
		16
	);
	if (!Array.isArray(inputModalities)) return inputModalities;
	const unsupportedModality = inputModalities.find((value) => !INPUT_MODALITIES.has(value));
	if (unsupportedModality) {
		return queryFailure(
			'input_modalities',
			`Unsupported input modality "${unsupportedModality}"`
		);
	}

	const providers = commaSeparated(
		url.searchParams,
		'providers',
		MAX_PROVIDER_FILTERS,
		160
	);
	if (!Array.isArray(providers)) return providers;

	const rawZdr = oneQueryValue(url.searchParams, 'zdr');
	if (typeof rawZdr !== 'string' && rawZdr !== null) return rawZdr;
	if (rawZdr !== null && rawZdr !== 'true') {
		return queryFailure('zdr', 'Only "zdr=true" is supported');
	}

	const rawRegion = oneQueryValue(url.searchParams, 'region');
	if (typeof rawRegion !== 'string' && rawRegion !== null) return rawRegion;
	if (rawRegion !== null && rawRegion !== 'eu' && rawRegion !== 'us') {
		return queryFailure('region', 'Query parameter "region" must be "eu" or "us"');
	}

	const rawSort = oneQueryValue(url.searchParams, 'sort');
	if (typeof rawSort !== 'string' && rawSort !== null) return rawSort;
	if (
		rawSort !== null
		&& rawSort !== 'newest'
		&& rawSort !== 'context-high-to-low'
	) {
		return queryFailure(
			'sort',
			'Only "newest" and "context-high-to-low" are supported'
		);
	}

	return {
		ok: true,
		value: {
			limit,
			offset,
			q,
			inputModalities,
			providers,
			zdr: rawZdr === 'true',
			region: rawRegion,
			sort: rawSort,
		},
	};
}

function rejectUnexpectedQuery(c: Context<Env>): Response | null {
	const keys = [...new URL(c.req.url).searchParams.keys()];
	return keys.length === 0
		? null
		: gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: `Unsupported query parameter "${keys[0]}"`,
			metadata: { param: keys[0] },
		});
}

function invalidQueryResponse(c: Context<Env>, failure: QueryFailure): Response {
	return gatewayErrorJson(c, {
		status: 400,
		code: GatewayErrorCode.invalidRequest,
		message: failure.message,
		metadata: { param: failure.param },
	});
}

function toOpenRouterProvider(provider: PublishedPublicProviderIdentity): OpenRouterProvider {
	return {
		name: provider.name,
		slug: provider.slug,
		privacy_policy_url: null,
		terms_of_service_url: null,
		status_page_url: null,
		headquarters: null,
		datacenters: null,
	};
}

function normalizedModalities(
	raw: string | null,
	allowed: ReadonlySet<string>
): string[] {
	return [...new Set(
		(parseModelModalitiesJson(raw) ?? []).filter((value) => allowed.has(value))
	)].sort(stableStringCompare);
}

function releasedEpoch(value: string | null): number | null {
	if (!value) return null;
	const milliseconds = Date.parse(
		/^\d{4}-\d{2}-\d{2}$/u.test(value)
			? `${value}T00:00:00.000Z`
			: value
	);
	return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

function positiveCapacity(value: number | null): number | null {
	return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value : null;
}

function modelEndpointPath(model: ModelRow): { canonicalSlug: string; details: string } | null {
	const slash = model.id.indexOf('/');
	const parsed = slash > 0 && model.id.indexOf('/', slash + 1) < 0
		? parseModelEndpointPath(model.id.slice(0, slash), model.id.slice(slash + 1))
		: (() => {
			const vendor = safeText(model.vendor, 64)?.toLocaleLowerCase('en-US');
			return vendor ? parseModelEndpointPath(vendor, model.id) : null;
		})();
	return parsed
		? {
			canonicalSlug: parsed.canonicalModelId,
			details: `/api/v1/models/${parsed.canonicalModelId}/endpoints`,
		}
		: null;
}

function canonicalPricing(
	endpoints: readonly PublicModelEndpoint[]
): Record<string, string | number> {
	if (endpoints.length === 0) return {};
	const normalized = endpoints.map((endpoint) => Object.fromEntries(
		Object.entries(endpoint.pricing).sort(([a], [b]) => stableStringCompare(a, b))
	) as Record<string, string | number>);
	const first = JSON.stringify(normalized[0]);
	return normalized.every((pricing) => JSON.stringify(pricing) === first)
		? normalized[0]!
		: {};
}

function toOpenRouterModel(
	model: ModelRow,
	endpoints: readonly PublicModelEndpoint[]
): OpenRouterModel | null {
	const path = modelEndpointPath(model);
	const id = safeText(model.id, 240);
	if (!path || !id) return null;
	const inputModalities = normalizedModalities(model.input_modalities, INPUT_MODALITIES);
	const outputModalities = normalizedModalities(model.output_modalities, OUTPUT_MODALITIES);
	return {
		id,
		canonical_slug: path.canonicalSlug,
		hugging_face_id: null,
		name: safeText(model.display_name, 160) ?? id,
		created: releasedEpoch(model.released_at),
		description: safeText(model.description, 4_000) ?? '',
		context_length: positiveCapacity(model.context_window),
		architecture: {
			modality: inputModalities.length > 0 && outputModalities.length > 0
				? `${inputModalities.join('+')}->${outputModalities.join('+')}`
				: null,
			input_modalities: inputModalities,
			output_modalities: outputModalities,
			tokenizer: null,
			instruct_type: null,
		},
		pricing: canonicalPricing(endpoints),
		top_provider: null,
		per_request_limits: null,
		supported_parameters: [...new Set(
			endpoints.flatMap((endpoint) => endpoint.supported_parameters)
		)].sort(stableStringCompare),
		default_parameters: {},
		supported_voices: null,
		knowledge_cutoff: null,
		expiration_date: null,
		links: { details: path.details },
		reasoning: null,
	};
}

async function verifiedBindings(c: Context<Env>, now: Date): Promise<{
	models: ModelRow[];
	bindings: VerifiedPublicEndpointBinding[];
	providers: PublishedPublicProviderCatalog;
}> {
	const repositories = c.get('repositories');
	const models = await repositories.modelRouting.listModelsWithActiveRoutes();
	const bindings = await listVerifiedPublicEndpointBindings(repositories, models, now);
	return {
		models,
		bindings,
		providers: resolvePublishedPublicProviders(bindings),
	};
}

async function routePolicies(
	c: Context<Env>,
	bindings: readonly VerifiedPublicEndpointBinding[]
) {
	const ids = [...new Set(bindings.flatMap((binding) => (
		binding.routes.map((route) => route.id)
	)))];
	const policies: RouteDataPolicyRow[] = [];
	for (let index = 0; index < ids.length; index += POLICY_BATCH_SIZE) {
		policies.push(
			...(await c.get('repositories').routeDataPolicies.getByRouteTargetIds(
				ids.slice(index, index + POLICY_BATCH_SIZE)
			))
		);
	}
	return new Map(policies.map((policy) => [policy.route_target_id, policy]));
}

async function buildPublishedCatalogSnapshot(
	c: Context<Env>
): Promise<PublishedCatalogSnapshot> {
	const now = new Date();
	const { models, bindings, providers } = await verifiedBindings(c, now);
	const modelById = new Map(models.map((model) => [model.id, model]));
	const publishedByModel = new Map<string, Array<{
		binding: VerifiedPublicEndpointBinding;
		endpoint: PublicModelEndpoint;
	}>>();
	for (const binding of bindings) {
		const model = modelById.get(binding.endpoint.model_id);
		if (!model) continue;
		const endpoint = serializePublishedPublicModelEndpoint(
			model,
			binding,
			providers.bySlug
		);
		if (!endpoint) continue;
		const list = publishedByModel.get(model.id) ?? [];
		list.push({ binding, endpoint });
		publishedByModel.set(model.id, list);
	}
	const policies = await routePolicies(
		c,
		[...publishedByModel.values()].flatMap((entries) => (
			entries.map((entry) => entry.binding)
		))
	);

	const records: PublishedModelRecord[] = [];
	let validUntilMs = now.getTime() + MAX_PUBLIC_CACHE_TTL_SECONDS * 1_000;
	for (const binding of bindings) {
		const expiresAtMs = Date.parse(binding.snapshot.expiresAt);
		if (Number.isFinite(expiresAtMs)) validUntilMs = Math.min(validUntilMs, expiresAtMs);
	}
	for (const model of models) {
		const entries = publishedByModel.get(model.id) ?? [];
		if (entries.length === 0) continue;
		const details = serializePublishedPublicModelEndpointsDocument(
			model,
			entries.map((entry) => entry.binding),
			providers.bySlug
		);
		if (!details) continue;
		const dto = toOpenRouterModel(model, details.endpoints);
		if (!dto) continue;
		const providerFacets = new Set<string>();
		const regions = new Set<string>();
		let zdr = false;
		for (const { binding } of entries) {
			const providerSlug = binding.endpoint.provider_slug.trim().toLocaleLowerCase('en-US');
			const provider = providers.bySlug.get(providerSlug);
			if (provider) {
				providerFacets.add(normalizedIdentity(provider.slug));
				providerFacets.add(normalizedIdentity(provider.name));
			}
			const region = safeText(binding.endpoint.region, 64)?.toLocaleLowerCase('en-US');
			if (region) regions.add(region);
			for (const route of binding.routes) {
				const policy = policies.get(route.id);
				if (!routeDataPolicyAllowsZdr(policy, route.subject_fingerprint, now)) continue;
				zdr = true;
				const policyExpiresAtMs = Date.parse(policy?.expires_at ?? '');
				if (Number.isFinite(policyExpiresAtMs)) {
					validUntilMs = Math.min(validUntilMs, policyExpiresAtMs);
				}
			}
		}
		records.push({
			dto,
			details,
			searchText: normalizedIdentity([
				dto.id,
				dto.canonical_slug,
				dto.name,
				dto.description,
			].join('\n')),
			inputModalities: [...new Set(dto.architecture.input_modalities)].sort(stableStringCompare),
			providers: [...providerFacets].sort(stableStringCompare),
			regions: [...regions].sort(stableStringCompare),
			zdr,
		});
	}
	const recordIndex: Record<string, number> = Object.create(null) as Record<string, number>;
	for (const [index, record] of records.entries()) {
		if (Object.prototype.hasOwnProperty.call(recordIndex, record.dto.canonical_slug)) {
			throw new RangeError(`duplicate public canonical model slug ${record.dto.canonical_slug}`);
		}
		recordIndex[record.dto.canonical_slug] = index;
	}
	return {
		version: CATALOG_SNAPSHOT_VERSION,
		generatedAtMs: now.getTime(),
		validUntilMs,
		providers: providers.providers,
		records,
		recordIndex,
	};
}

type SnapshotLoadResult =
	| { ok: true; snapshot: PublishedCatalogSnapshot }
	| { ok: false; response: Response };

type HotSnapshotCache = { current: PublishedCatalogSnapshot | null };

async function loadPublishedCatalogSnapshot(
	c: Context<Env>,
	runtime: PublicStatsRuntimeGuard | undefined,
	singleflight: ReturnType<typeof createPublicStatsSingleflight>,
	hot: HotSnapshotCache
): Promise<SnapshotLoadResult> {
	const nowMs = Date.now();
	if (hot.current?.validUntilMs && hot.current.validUntilMs > nowMs) {
		return { ok: true, snapshot: hot.current };
	}
	hot.current = null;
	const cache = defaultEdgeCache(runtime);
	const cacheKey = snapshotCacheKey(c);
	if (cache) {
		try {
			const hit = await cache.match(cacheKey);
			if (hit) {
				const snapshot = await snapshotFromResponse(hit, nowMs);
				if (snapshot) {
					hot.current = snapshot;
					return { ok: true, snapshot };
				}
			}
		} catch (error) {
			console.warn(JSON.stringify({
				message: 'public catalog snapshot cache read failed',
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
		}
	}

	const response = await singleflight.run(CATALOG_SNAPSHOT_SINGLEFLIGHT_KEY, async () => {
		const limiter = c.env?.PUBLIC_STATS_RATE_LIMITER ?? runtime?.rateLimiter;
		if (limiter) {
			try {
				const result = await limiter.limit({ key: CATALOG_SNAPSHOT_SINGLEFLIGHT_KEY });
				if (!result.success) {
					return gatewayErrorJson(c, {
						status: 429,
						code: GatewayErrorCode.publicCatalogRateLimited,
						message: 'Public catalog is temporarily rate limited',
					});
				}
			} catch (error) {
				console.error(JSON.stringify({
					message: 'public catalog snapshot rate limiter failed',
					error_type: error instanceof Error ? error.name : 'UnknownError',
				}));
				return gatewayErrorJson(c, {
					status: 503,
					code: GatewayErrorCode.publicCatalogUnavailable,
					message: 'Public catalog is temporarily unavailable',
				});
			}
		}

		const snapshot = await buildPublishedCatalogSnapshot(c);
		hot.current = snapshot;
		const cacheSeconds = publicCacheSeconds(snapshot);
		const loaded = new Response(JSON.stringify(snapshot), {
			status: 200,
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'Cache-Control': cacheSeconds > 0
					? `public, max-age=${cacheSeconds}, must-revalidate`
					: 'no-store',
			},
		});
		if (cache && cacheSeconds > 0) {
			try {
				const write = cache.put(cacheKey, loaded.clone()).catch((error: unknown) => {
					console.warn(JSON.stringify({
						message: 'public catalog snapshot cache write failed',
						error_type: error instanceof Error ? error.name : 'UnknownError',
					}));
				});
				scheduleBackgroundWork(c, write);
			} catch (error) {
				console.warn(JSON.stringify({
					message: 'public catalog snapshot cache write failed',
					error_type: error instanceof Error ? error.name : 'UnknownError',
				}));
			}
		}
		return loaded;
	});
	if (!response.ok) return { ok: false, response };
	const snapshot = await snapshotFromResponse(response, Date.now());
	if (!snapshot) {
		return {
			ok: false,
			response: gatewayErrorJson(c, {
				status: 503,
				code: GatewayErrorCode.publicCatalogUnavailable,
				message: 'Public catalog snapshot is unavailable',
			}),
		};
	}
	return { ok: true, snapshot };
}

function filterAndSortModels(
	records: PublishedModelRecord[],
	query: ModelQuery
): PublishedModelRecord[] {
	const search = query.q ? normalizedIdentity(query.q) : null;
	const filtered = records.filter((record) => {
		if (search) {
			if (!record.searchText.includes(search)) return false;
		}
		if (
			query.inputModalities.length > 0
			&& !query.inputModalities.every((value) => record.inputModalities.includes(value))
		) return false;
		if (
			query.providers.length > 0
			&& !query.providers.some((value) => record.providers.includes(value))
		) return false;
		if (query.zdr && !record.zdr) return false;
		if (query.region && !record.regions.includes(query.region)) return false;
		return true;
	});

	return filtered.sort((a, b) => {
		if (query.sort === 'newest') {
			const aCreated = a.dto.created ?? Number.NEGATIVE_INFINITY;
			const bCreated = b.dto.created ?? Number.NEGATIVE_INFINITY;
			if (aCreated !== bCreated) return bCreated - aCreated;
		}
		if (query.sort === 'context-high-to-low') {
			const aContext = a.dto.context_length ?? Number.NEGATIVE_INFINITY;
			const bContext = b.dto.context_length ?? Number.NEGATIVE_INFINITY;
			if (aContext !== bContext) return bContext - aContext;
		}
		return stableStringCompare(a.dto.id, b.dto.id);
	});
}

function nextModelsLink(query: ModelQuery, totalCount: number): string | null {
	const nextOffset = query.offset + query.limit;
	if (nextOffset >= totalCount) return null;
	const params = new URLSearchParams();
	params.set('offset', String(nextOffset));
	params.set('limit', String(query.limit));
	if (query.q) params.set('q', query.q);
	if (query.inputModalities.length > 0) {
		params.set('input_modalities', query.inputModalities.join(','));
	}
	if (query.providers.length > 0) {
		params.set('providers', query.providers.join(','));
	}
	if (query.zdr) params.set('zdr', 'true');
	if (query.region) params.set('region', query.region);
	if (query.sort) params.set('sort', query.sort);
	return `/api/v1/models?${params.toString()}`;
}

function modelQueryIsSharedCacheable(query: ModelQuery): boolean {
	return (
		query.limit === DEFAULT_LIMIT &&
		query.offset === 0 &&
		query.q === null &&
		query.inputModalities.length === 0 &&
		query.providers.length === 0 &&
		!query.zdr &&
		query.region === null &&
		query.sort === null
	);
}

function publicCatalogClientKey(c: Context<Env>, surface: string): string {
	const address = c.req.header('CF-Connecting-IP')?.trim() ?? '';
	const identity = address.length > 0 && address.length <= 45 && /^[0-9A-Fa-f:.]+$/u.test(address)
		? address.toLocaleLowerCase('en-US')
		: 'unknown';
	return `openrouter-public-catalog:${surface}:${identity}`;
}

async function enforcePublicCatalogRequestLimit(
	c: Context<Env>,
	runtime: PublicStatsRuntimeGuard | undefined,
	surface: 'query' | 'detail'
): Promise<Response | null> {
	const limiter = c.env?.PUBLIC_STATS_RATE_LIMITER ?? runtime?.rateLimiter;
	if (!limiter) return null;
	try {
		const result = await limiter.limit({ key: publicCatalogClientKey(c, surface) });
		return result.success
			? null
			: gatewayErrorJson(c, {
				status: 429,
				code: GatewayErrorCode.publicCatalogRateLimited,
				message: 'Public catalog request rate exceeded',
			});
	} catch (error) {
		console.error(JSON.stringify({
			message: 'public catalog request rate limiter failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return gatewayErrorJson(c, {
			status: 503,
			code: GatewayErrorCode.publicCatalogUnavailable,
			message: 'Public catalog is temporarily unavailable',
		});
	}
}

export function createOpenRouterPublicCatalogRoutes(
	runtime?: PublicStatsRuntimeGuard
): {
	publicCatalogRoutes: Hono<Env>;
	providersAliasRoutes: Hono<Env>;
} {
	const singleflight = runtime?.singleflight ?? createPublicStatsSingleflight();
	const hotSnapshot: HotSnapshotCache = { current: null };
	const publicCatalogRoutes = new Hono<Env>();
	const providersAliasRoutes = new Hono<Env>();

	const listProviders = async (c: Context<Env>): Promise<Response> => {
		const invalidQuery = rejectUnexpectedQuery(c);
		if (invalidQuery) return invalidQuery;
		try {
			const loaded = await loadPublishedCatalogSnapshot(c, runtime, singleflight, hotSnapshot);
			if (!loaded.ok) return loaded.response;
			return applyPublicCachePolicy(
				c.json({ data: loaded.snapshot.providers.map(toOpenRouterProvider) }),
				loaded.snapshot,
				true
			);
		} catch (error) {
			console.error(JSON.stringify({
				message: 'public provider discovery failed',
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: 'Provider discovery failed',
			});
		}
	};

	publicCatalogRoutes.get('/providers', listProviders);
	providersAliasRoutes.get('/', listProviders);

	publicCatalogRoutes.get('/models', async (c) => {
		const parsed = parseModelQuery(new URL(c.req.url));
		if (!parsed.ok) return invalidQueryResponse(c, parsed);
		const query = parsed.value;
		try {
			const loaded = await loadPublishedCatalogSnapshot(c, runtime, singleflight, hotSnapshot);
			if (!loaded.ok) return loaded.response;
			if (!modelQueryIsSharedCacheable(query)) {
				const limited = await enforcePublicCatalogRequestLimit(c, runtime, 'query');
				if (limited) return limited;
			}
			const filtered = filterAndSortModels(loaded.snapshot.records, query);
			const data = filtered
				.slice(query.offset, query.offset + query.limit)
				.map((record) => record.dto);
			return applyPublicCachePolicy(
				c.json({
					data,
					total_count: filtered.length,
					links: { next: nextModelsLink(query, filtered.length) },
				}),
				loaded.snapshot,
				modelQueryIsSharedCacheable(query)
			);
		} catch (error) {
			console.error(JSON.stringify({
				message: 'public model discovery failed',
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: 'Model discovery failed',
			});
		}
	});

	publicCatalogRoutes.get('/models/:author/:slug/endpoints', async (c) => {
		const invalidQuery = rejectUnexpectedQuery(c);
		if (invalidQuery) return invalidQuery;
		const path = parseModelEndpointPath(c.req.param('author'), c.req.param('slug'));
		if (!path) {
			return gatewayErrorJson(c, {
				status: 404,
				code: GatewayErrorCode.modelNotFound,
				message: 'Resource not found',
			});
		}
		try {
			const loaded = await loadPublishedCatalogSnapshot(c, runtime, singleflight, hotSnapshot);
			if (!loaded.ok) return loaded.response;
			const limited = await enforcePublicCatalogRequestLimit(c, runtime, 'detail');
			if (limited) return limited;
			const index = loaded.snapshot.recordIndex[path.canonicalModelId];
			const record = Number.isSafeInteger(index)
				? loaded.snapshot.records[index!]
				: undefined;
			if (!record) {
				return gatewayErrorJson(c, {
					status: 404,
					code: GatewayErrorCode.modelNotFound,
					message: 'Resource not found',
				});
			}
			return applyPublicCachePolicy(
				c.json({ data: record.details }),
				loaded.snapshot,
				true
			);
		} catch (error) {
			console.error(JSON.stringify({
				message: 'public endpoint discovery failed',
				model_id: path.canonicalModelId,
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: 'Endpoint discovery failed',
			});
		}
	});

	return { publicCatalogRoutes, providersAliasRoutes };
}
