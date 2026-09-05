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
import { parsePublicCatalogTopProviderSelection } from '@octafuse/core/public-model-catalog';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireModelEndpointsManagementApiKey } from '../../middleware/management-auth';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import {
	listVerifiedPublicEndpointBindings,
	loadPublicEndpointPerformance,
	openRouterModelOutputModalities,
	parseModelEndpointPath,
	resolvePublishedPublicProviders,
	serializePublishedPublicModelEndpoint,
	serializePublishedPublicModelEndpointsDocument,
	type PublicModelEndpoint,
	type PublicModelEndpointsDocument,
	type PublicEndpointPerformanceMap,
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
import { privacyQualifiedWeeklyTokenTotals } from '../../services/public-catalog-stats';

const CATALOG_SNAPSHOT_VERSION = 'cinatoken.openrouter-public-catalog.v6' as const;
const CATALOG_SNAPSHOT_CACHE_PATH = '/__cinatoken/cache/openrouter-public-catalog-v6';
const CATALOG_SNAPSHOT_SINGLEFLIGHT_KEY = 'openrouter-public-catalog-snapshot';
const MAX_PUBLIC_CACHE_TTL_SECONDS = 60;
const MAX_LIMIT = 1_000;
const DEFAULT_LIMIT = 500;
const MAX_OFFSET = 1_000_000;
const MAX_QUERY_LENGTH = 200;
const MAX_PROVIDER_FILTERS = 32;
const MAX_MODEL_AUTHOR_FILTERS = 32;
const MAX_SUPPORTED_PARAMETER_FILTERS = 64;
const MAX_CONTEXT_FILTER = 1_000_000_000;
const MAX_AGE_FILTER_DAYS = 1_000_000;
const MAX_PRICE_FILTER_PER_MILLION = Number.MAX_SAFE_INTEGER;
const MAX_ARCH_FILTER_LENGTH = 80;
const MAX_MODEL_METADATA_JSON_LENGTH = 65_536;
const MAX_MODEL_TAGS_JSON_LENGTH = 8_192;
const MAX_MODEL_FACT_VALUES = 64;
const POLICY_BATCH_SIZE = 90;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/u;
const DECIMAL_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/u;
const INPUT_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'file']);
const OUTPUT_MODALITIES = new Set([
	'text',
	'image',
	'embeddings',
	'audio',
	'video',
	'rerank',
	'speech',
	'transcription',
]);
const MODEL_CATEGORIES = new Set([
	'programming',
	'roleplay',
	'marketing',
	'marketing/seo',
	'technology',
	'science',
	'translation',
	'legal',
	'finance',
	'health',
	'trivia',
	'academia',
]);
const ALLOWED_MODEL_QUERY_KEYS = new Set([
	'limit',
	'offset',
	'q',
	'input_modalities',
	'output_modalities',
	'supported_parameters',
	'context',
	'model_authors',
	'providers',
	'zdr',
	'region',
	'sort',
	'category',
	'arch',
	'distillable',
	'min_age_days',
	'max_age_days',
	'min_price',
	'max_price',
	'min_output_price',
	'max_output_price',
]);
const ALLOWED_MODEL_COUNT_QUERY_KEYS = new Set(['output_modalities']);

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
		tokenizer: string | null;
		instruct_type: string | null;
	};
	pricing: Record<string, string | number>;
	top_provider: {
		context_length: number;
		max_completion_tokens: number | null;
		is_moderated: boolean;
	} | null;
	per_request_limits: null;
	supported_parameters: string[];
	default_parameters: Record<string, never>;
	supported_voices: null;
	knowledge_cutoff: null;
	expiration_date: null;
	links: { details: string };
	reasoning: null;
};

type ModelSort =
	| 'newest'
	| 'context-high-to-low'
	| 'pricing-low-to-high'
	| 'pricing-high-to-low'
	| 'throughput-high-to-low'
	| 'latency-low-to-high'
	| 'most-popular'
	| 'top-weekly'
	| null;
type ModelQuery = {
	limit: number;
	offset: number;
	q: string | null;
	inputModalities: string[];
	outputModalities: string[];
	allOutputModalities: boolean;
	supportedParameters: string[];
	minimumContext: number | null;
	modelAuthors: string[];
	providers: string[];
	zdr: boolean;
	region: 'eu' | 'us' | null;
	category: string | null;
	arch: string | null;
	distillable: boolean | null;
	minimumAgeDays: number | null;
	maximumAgeDays: number | null;
	minimumPromptPrice: number | null;
	maximumPromptPrice: number | null;
	minimumOutputPrice: number | null;
	maximumOutputPrice: number | null;
	sort: ModelSort;
};
type QueryFailure = { ok: false; param: string; message: string };
type QuerySuccess = { ok: true; value: ModelQuery };
type QueryResult = QueryFailure | QuerySuccess;
type ModelCountQueryResult =
	| QueryFailure
	| { ok: true; value: OutputModalitiesQuery };

type PublishedModelRecord = {
	dto: OpenRouterModel;
	details: PublicModelEndpointsDocument;
	searchText: string;
	inputModalities: string[];
	outputModalities: string[];
	providers: string[];
	regions: string[];
	categories: string[];
	architectures: string[];
	zdr: boolean;
	distillable: boolean;
	ageDays: number | null;
	latencyP50: number | null;
	throughputP50: number | null;
	weeklyTokens: number | null;
	promptPricePerMillion: number | null;
	outputPricePerMillion: number | null;
	pricingSortScore: number | null;
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
		!Array.isArray(record.outputModalities) ||
		!Array.isArray(record.providers) ||
		!Array.isArray(record.regions) ||
		!Array.isArray(record.categories) ||
		!Array.isArray(record.architectures) ||
		typeof record.zdr !== 'boolean' ||
		typeof record.distillable !== 'boolean' ||
		!(record.ageDays === null || (
			Number.isSafeInteger(record.ageDays)
			&& (record.ageDays as number) >= 0
		)) ||
		!(record.latencyP50 === null || (
			typeof record.latencyP50 === 'number'
			&& Number.isFinite(record.latencyP50)
			&& record.latencyP50 >= 0
		)) ||
		!(record.throughputP50 === null || (
			typeof record.throughputP50 === 'number'
			&& Number.isFinite(record.throughputP50)
			&& record.throughputP50 >= 0
		)) ||
		!(record.weeklyTokens === null || (
			Number.isSafeInteger(record.weeklyTokens)
			&& (record.weeklyTokens as number) >= 0
		)) ||
		!(record.promptPricePerMillion === null || (
			typeof record.promptPricePerMillion === 'number'
			&& Number.isFinite(record.promptPricePerMillion)
			&& record.promptPricePerMillion >= 0
		)) ||
		!(record.outputPricePerMillion === null || (
			typeof record.outputPricePerMillion === 'number'
			&& Number.isFinite(record.outputPricePerMillion)
			&& record.outputPricePerMillion >= 0
		)) ||
		!(record.pricingSortScore === null || (
			typeof record.pricingSortScore === 'number'
			&& Number.isFinite(record.pricingSortScore)
			&& record.pricingSortScore >= 0
		)) ||
		[
			record.inputModalities,
			record.outputModalities,
			record.providers,
			record.regions,
			record.categories,
			record.architectures,
		].some((items) =>
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

function optionalBoundedInteger(
	search: URLSearchParams,
	key: 'context' | 'min_age_days' | 'max_age_days',
	minimum: number,
	maximum: number
): number | null | QueryFailure {
	const raw = oneQueryValue(search, key);
	if (raw === null) return null;
	if (typeof raw !== 'string') return raw;
	if (!DECIMAL_INTEGER.test(raw)) {
		return queryFailure(key, `Query parameter "${key}" must be a decimal integer`);
	}
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum
		? value
		: queryFailure(key, `Query parameter "${key}" is outside the supported range`);
}

function optionalBoundedPrice(
	search: URLSearchParams,
	key: 'min_price' | 'max_price' | 'min_output_price' | 'max_output_price'
): number | null | QueryFailure {
	const raw = oneQueryValue(search, key);
	if (raw === null) return null;
	if (typeof raw !== 'string') return raw;
	if (raw.length === 0 || raw.length > 64 || !DECIMAL_NUMBER.test(raw)) {
		return queryFailure(key, `Query parameter "${key}" must be a non-negative number`);
	}
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_FILTER_PER_MILLION
		? value
		: queryFailure(key, `Query parameter "${key}" is outside the supported range`);
}

function optionalNormalizedText(
	search: URLSearchParams,
	key: 'arch',
	maximumLength: number
): string | null | QueryFailure {
	const raw = oneQueryValue(search, key);
	if (raw === null) return null;
	if (typeof raw !== 'string') return raw;
	const value = safeText(raw, maximumLength);
	return value
		? normalizedIdentity(value)
		: queryFailure(key, `Query parameter "${key}" contains an invalid value`);
}

function commaSeparated(
	search: URLSearchParams,
	key:
		| 'input_modalities'
		| 'output_modalities'
		| 'supported_parameters'
		| 'model_authors'
		| 'providers',
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
	const normalized = items.map(normalizedIdentity);
	return new Set(normalized).size === normalized.length
		? normalized.sort(stableStringCompare)
		: queryFailure(key, `Query parameter "${key}" contains duplicate values`);
}

type OutputModalitiesQuery = {
	values: string[];
	all: boolean;
};

function outputModalitiesQuery(
	search: URLSearchParams
): OutputModalitiesQuery | QueryFailure {
	const raw = oneQueryValue(search, 'output_modalities');
	if (raw === null) return { values: ['text'], all: false };
	if (typeof raw !== 'string') return raw;
	const items = raw.split(',').map((item) => normalizedIdentity(item.trim()));
	if (
		items.length === 0
		|| items.length > OUTPUT_MODALITIES.size
		|| items.some((item) => item.length === 0 || item.length > 16 || CONTROL.test(item))
		|| new Set(items).size !== items.length
	) {
		return queryFailure(
			'output_modalities',
			'Query parameter "output_modalities" contains an invalid list'
		);
	}
	if (items.includes('all')) {
		return items.length === 1
			? { values: [], all: true }
			: queryFailure(
				'output_modalities',
				'Output modality "all" must not be combined with another value'
			);
	}
	const unsupported = items.find((value) => !OUTPUT_MODALITIES.has(value));
	return unsupported
		? queryFailure(
			'output_modalities',
			`Unsupported output modality "${unsupported}"`
		)
		: { values: [...items].sort(stableStringCompare), all: false };
}

function parseModelCountQuery(url: URL): ModelCountQueryResult {
	for (const key of url.searchParams.keys()) {
		if (!ALLOWED_MODEL_COUNT_QUERY_KEYS.has(key)) {
			return queryFailure(key, `Unsupported query parameter "${key}"`);
		}
	}
	const outputQuery = outputModalitiesQuery(url.searchParams);
	return 'ok' in outputQuery ? outputQuery : { ok: true, value: outputQuery };
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

	const outputQuery = outputModalitiesQuery(url.searchParams);
	if ('ok' in outputQuery) return outputQuery;
	const supportedParameters = commaSeparated(
		url.searchParams,
		'supported_parameters',
		MAX_SUPPORTED_PARAMETER_FILTERS,
		64
	);
	if (!Array.isArray(supportedParameters)) return supportedParameters;
	const minimumContext = optionalBoundedInteger(
		url.searchParams,
		'context',
		1,
		MAX_CONTEXT_FILTER
	);
	if (typeof minimumContext !== 'number' && minimumContext !== null) return minimumContext;
	const modelAuthors = commaSeparated(
		url.searchParams,
		'model_authors',
		MAX_MODEL_AUTHOR_FILTERS,
		120
	);
	if (!Array.isArray(modelAuthors)) return modelAuthors;

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

	const rawCategory = oneQueryValue(url.searchParams, 'category');
	if (typeof rawCategory !== 'string' && rawCategory !== null) return rawCategory;
	const categoryText = rawCategory === null ? null : safeText(rawCategory, 32);
	const category = categoryText === null ? null : normalizedIdentity(categoryText);
	if (rawCategory !== null && (category === null || !MODEL_CATEGORIES.has(category))) {
		return queryFailure('category', 'Query parameter "category" is not a supported category');
	}

	const arch = optionalNormalizedText(url.searchParams, 'arch', MAX_ARCH_FILTER_LENGTH);
	if (typeof arch !== 'string' && arch !== null) return arch;

	const rawDistillable = oneQueryValue(url.searchParams, 'distillable');
	if (typeof rawDistillable !== 'string' && rawDistillable !== null) return rawDistillable;
	if (
		rawDistillable !== null
		&& rawDistillable !== 'true'
		&& rawDistillable !== 'false'
	) {
		return queryFailure('distillable', 'Query parameter "distillable" must be "true" or "false"');
	}

	const minimumAgeDays = optionalBoundedInteger(
		url.searchParams,
		'min_age_days',
		0,
		MAX_AGE_FILTER_DAYS
	);
	if (typeof minimumAgeDays !== 'number' && minimumAgeDays !== null) return minimumAgeDays;
	const maximumAgeDays = optionalBoundedInteger(
		url.searchParams,
		'max_age_days',
		0,
		MAX_AGE_FILTER_DAYS
	);
	if (typeof maximumAgeDays !== 'number' && maximumAgeDays !== null) return maximumAgeDays;
	if (
		minimumAgeDays !== null
		&& maximumAgeDays !== null
		&& minimumAgeDays > maximumAgeDays
	) {
		return queryFailure(
			'max_age_days',
			'Query parameter "max_age_days" must be greater than or equal to "min_age_days"'
		);
	}

	const minimumPromptPrice = optionalBoundedPrice(url.searchParams, 'min_price');
	if (typeof minimumPromptPrice !== 'number' && minimumPromptPrice !== null) {
		return minimumPromptPrice;
	}
	const maximumPromptPrice = optionalBoundedPrice(url.searchParams, 'max_price');
	if (typeof maximumPromptPrice !== 'number' && maximumPromptPrice !== null) {
		return maximumPromptPrice;
	}
	if (
		minimumPromptPrice !== null
		&& maximumPromptPrice !== null
		&& minimumPromptPrice > maximumPromptPrice
	) {
		return queryFailure(
			'max_price',
			'Query parameter "max_price" must be greater than or equal to "min_price"'
		);
	}
	const minimumOutputPrice = optionalBoundedPrice(url.searchParams, 'min_output_price');
	if (typeof minimumOutputPrice !== 'number' && minimumOutputPrice !== null) {
		return minimumOutputPrice;
	}
	const maximumOutputPrice = optionalBoundedPrice(url.searchParams, 'max_output_price');
	if (typeof maximumOutputPrice !== 'number' && maximumOutputPrice !== null) {
		return maximumOutputPrice;
	}
	if (
		minimumOutputPrice !== null
		&& maximumOutputPrice !== null
		&& minimumOutputPrice > maximumOutputPrice
	) {
		return queryFailure(
			'max_output_price',
			'Query parameter "max_output_price" must be greater than or equal to "min_output_price"'
		);
	}

	const rawSort = oneQueryValue(url.searchParams, 'sort');
	if (typeof rawSort !== 'string' && rawSort !== null) return rawSort;
	if (
		rawSort !== null
		&& rawSort !== 'newest'
		&& rawSort !== 'context-high-to-low'
		&& rawSort !== 'pricing-low-to-high'
		&& rawSort !== 'pricing-high-to-low'
		&& rawSort !== 'throughput-high-to-low'
		&& rawSort !== 'latency-low-to-high'
		&& rawSort !== 'most-popular'
		&& rawSort !== 'top-weekly'
	) {
		return queryFailure(
			'sort',
			'Only "newest", "context-high-to-low", "pricing-low-to-high", "pricing-high-to-low", "throughput-high-to-low", "latency-low-to-high", "most-popular", and "top-weekly" are supported'
		);
	}

	return {
		ok: true,
		value: {
			limit,
			offset,
			q,
			inputModalities,
			outputModalities: outputQuery.values,
			allOutputModalities: outputQuery.all,
			supportedParameters,
			minimumContext,
			modelAuthors,
			providers,
			zdr: rawZdr === 'true',
			region: rawRegion,
			category,
			arch,
			distillable: rawDistillable === null ? null : rawDistillable === 'true',
			minimumAgeDays,
			maximumAgeDays,
			minimumPromptPrice,
			maximumPromptPrice,
			minimumOutputPrice,
			maximumOutputPrice,
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

function parseBoundedJsonObject(raw: string | null): Record<string, unknown> | null {
	if (!raw || raw.length > MAX_MODEL_METADATA_JSON_LENGTH) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function boundedNormalizedStrings(
	value: unknown,
	maximumItems = MAX_MODEL_FACT_VALUES,
	maximumItemLength = 80
): string[] {
	if (!Array.isArray(value) || value.length > maximumItems) return [];
	const parsed: string[] = [];
	for (const item of value) {
		const safe = safeText(item, maximumItemLength);
		if (!safe) return [];
		parsed.push(normalizedIdentity(safe));
	}
	return [...new Set(parsed)].sort(stableStringCompare);
}

function boundedModelTags(raw: string | null): string[] {
	if (!raw || raw.length > MAX_MODEL_TAGS_JSON_LENGTH) return [];
	try {
		return boundedNormalizedStrings(JSON.parse(raw));
	} catch {
		return [];
	}
}

function explicitModelCategories(
	model: ModelRow,
	metadata: Record<string, unknown> | null
): string[] {
	const values = new Set(boundedModelTags(model.tags));
	for (const value of boundedNormalizedStrings(metadata?.categories, 32, 32)) {
		values.add(value);
	}
	const category = safeText(metadata?.category, 32);
	if (category) values.add(normalizedIdentity(category));
	return [...values].filter((value) => MODEL_CATEGORIES.has(value)).sort(stableStringCompare);
}

function explicitModelArchitectures(metadata: Record<string, unknown> | null): string[] {
	const values = [metadata?.architecture, metadata?.model_family]
		.map((value) => safeText(value, MAX_ARCH_FILTER_LENGTH))
		.filter((value): value is string => value !== null)
		.map(normalizedIdentity);
	return [...new Set(values)].sort(stableStringCompare);
}

function snapshotAgeDays(createdEpoch: number | null, generatedAtMs: number): number | null {
	if (createdEpoch === null) return null;
	const ageSeconds = Math.floor(generatedAtMs / 1_000) - createdEpoch;
	if (!Number.isSafeInteger(ageSeconds) || ageSeconds < 0) return null;
	return Math.floor(ageSeconds / 86_400);
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

type DecimalParts = { coefficient: bigint; scale: number };

function decimalParts(value: string): DecimalParts | null {
	const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
	if (!match) return null;
	const fraction = match[2] ?? '';
	const exponent = Number(match[3] ?? '0');
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
	let coefficient = BigInt(`${match[1]}${fraction}`);
	let scale = fraction.length - exponent;
	if (scale < 0) {
		coefficient *= 10n ** BigInt(-scale);
		scale = 0;
	}
	return { coefficient, scale };
}

function formatDecimal(parts: DecimalParts, maximumScale = 18): string {
	let { coefficient, scale } = parts;
	if (scale > maximumScale) {
		const divisor = 10n ** BigInt(scale - maximumScale);
		const quotient = coefficient / divisor;
		const remainder = coefficient % divisor;
		coefficient = quotient + (remainder * 2n >= divisor ? 1n : 0n);
		scale = maximumScale;
	}
	while (scale > 0 && coefficient % 10n === 0n) {
		coefficient /= 10n;
		scale -= 1;
	}
	const digits = coefficient.toString().padStart(scale + 1, '0');
	return scale === 0
		? digits
		: `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function applyPricingDiscount(value: string, discount: number | undefined): string | null {
	if (discount === undefined || discount === 0) return value;
	const price = decimalParts(value);
	const parsedDiscount = decimalParts(String(discount));
	if (!price || !parsedDiscount) return null;
	const one = 10n ** BigInt(parsedDiscount.scale);
	if (parsedDiscount.coefficient > one) return null;
	return formatDecimal({
		coefficient: price.coefficient * (one - parsedDiscount.coefficient),
		scale: price.scale + parsedDiscount.scale,
	});
}

function effectiveEndpointPricing(
	endpoint: PublicModelEndpoint
): Record<string, string> | null {
	const output: Record<string, string> = {};
	for (const [key, raw] of Object.entries(endpoint.pricing)
		.sort(([a], [b]) => stableStringCompare(a, b))) {
		if (key === 'discount') continue;
		if (typeof raw !== 'string') return null;
		const value = applyPricingDiscount(raw, endpoint.pricing.discount);
		if (value === null) return null;
		output[key] = value;
	}
	return output;
}

function endpointUsesTokenPrices(endpoint: PublicModelEndpoint): boolean {
	if (endpoint.audio_capabilities === null) return true;
	const operations = Object.values(endpoint.audio_capabilities.pricing_by_operation)
		.filter((value) => value !== undefined);
	return operations.length > 0
		&& operations.every((value) => value.meter.kind === 'tokens');
}

type PublishedModelPricing = {
	pricing: Record<string, string>;
	topProvider: OpenRouterModel['top_provider'];
	promptPricePerMillion: number | null;
	outputPricePerMillion: number | null;
	pricingSortScore: number | null;
};

function comparablePricingFacts(
	endpoint: PublicModelEndpoint,
	pricing: Readonly<Record<string, string>>
): Pick<PublishedModelPricing,
	'promptPricePerMillion' | 'outputPricePerMillion' | 'pricingSortScore'> {
	if (!endpointUsesTokenPrices(endpoint)) {
		return {
			promptPricePerMillion: null,
			outputPricePerMillion: null,
			pricingSortScore: null,
		};
	}
	const prompt = Number(pricing.prompt) * 1_000_000;
	const output = Number(pricing.completion) * 1_000_000;
	if (
		!Number.isFinite(prompt)
		|| prompt < 0
		|| !Number.isFinite(output)
		|| output < 0
	) {
		return {
			promptPricePerMillion: null,
			outputPricePerMillion: null,
			pricingSortScore: null,
		};
	}
	const pricingSortScore = (prompt + output) / 2;
	return {
		promptPricePerMillion: prompt,
		outputPricePerMillion: output,
		pricingSortScore: Number.isFinite(pricingSortScore) ? pricingSortScore : null,
	};
}

function publishedModelPricing(
	endpoints: readonly PublicModelEndpoint[],
	metadata: Record<string, unknown> | null
): PublishedModelPricing {
	const unavailable = (): PublishedModelPricing => ({
		pricing: {},
		topProvider: null,
		promptPricePerMillion: null,
		outputPricePerMillion: null,
		pricingSortScore: null,
	});
	if (endpoints.length === 0) return unavailable();

	const selection = parsePublicCatalogTopProviderSelection(metadata);
	if (selection.status === 'invalid') return unavailable();
	if (selection.status === 'valid') {
		const matches = endpoints.filter(
			(endpoint) => endpoint.tag === selection.selector.endpointTag
		);
		if (matches.length !== 1) return unavailable();
		const endpoint = matches[0]!;
		const pricing = effectiveEndpointPricing(endpoint);
		if (!pricing) return unavailable();
		return {
			pricing,
			topProvider: {
				context_length: endpoint.context_length,
				max_completion_tokens: endpoint.max_completion_tokens,
				is_moderated: selection.selector.isModerated,
			},
			...comparablePricingFacts(endpoint, pricing),
		};
	}

	const normalized = endpoints.map(effectiveEndpointPricing);
	if (normalized.some((pricing) => pricing === null)) return unavailable();
	const first = normalized[0]!;
	const serialized = JSON.stringify(first);
	if (!normalized.every((pricing) => JSON.stringify(pricing) === serialized)) {
		return unavailable();
	}
	const facts = endpoints.every(endpointUsesTokenPrices)
		? comparablePricingFacts(endpoints[0]!, first)
		: {
			promptPricePerMillion: null,
			outputPricePerMillion: null,
			pricingSortScore: null,
		};
	return { pricing: first, topProvider: null, ...facts };
}

function toOpenRouterModel(
	model: ModelRow,
	endpoints: readonly PublicModelEndpoint[],
	metadata: Record<string, unknown> | null,
	publishedPricing: PublishedModelPricing
): OpenRouterModel | null {
	const path = modelEndpointPath(model);
	const id = safeText(model.id, 240);
	if (!path || !id) return null;
	const inputModalities = normalizedModalities(model.input_modalities, INPUT_MODALITIES);
	const outputModalities = [...new Set(
		openRouterModelOutputModalities(model).filter((value) => OUTPUT_MODALITIES.has(value))
	)].sort(stableStringCompare);
	const dedicatedAudioOutput = outputModalities.includes('speech')
		|| outputModalities.includes('transcription');
	return {
		id,
		canonical_slug: path.canonicalSlug,
		hugging_face_id: null,
		name: safeText(model.display_name, 160) ?? id,
		created: releasedEpoch(model.released_at),
		description: safeText(model.description, 4_000) ?? '',
		context_length: positiveCapacity(model.context_window) ?? (dedicatedAudioOutput ? 0 : null),
		architecture: {
			modality: inputModalities.length > 0 && outputModalities.length > 0
				? `${inputModalities.join('+')}->${outputModalities.join('+')}`
				: null,
			input_modalities: inputModalities,
			output_modalities: outputModalities,
			tokenizer: safeText(metadata?.tokenizer, 160),
			instruct_type: safeText(metadata?.instruct_type, 160),
		},
		pricing: publishedPricing.pricing,
		top_provider: publishedPricing.topProvider,
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

function modelPerformanceScores(
	bindings: readonly VerifiedPublicEndpointBinding[],
	performance: PublicEndpointPerformanceMap
): { latencyP50: number | null; throughputP50: number | null } {
	const latency: number[] = [];
	const throughput: number[] = [];
	for (const binding of bindings) {
		const endpointPerformance = performance.get(binding.endpoint.id);
		const latencyP50 = endpointPerformance?.latencyLast30m?.p50;
		if (typeof latencyP50 === 'number' && Number.isFinite(latencyP50) && latencyP50 >= 0) {
			latency.push(latencyP50);
		}
		const throughputP50 = endpointPerformance?.throughputLast30m?.p50;
		if (
			typeof throughputP50 === 'number'
			&& Number.isFinite(throughputP50)
			&& throughputP50 >= 0
		) {
			throughput.push(throughputP50);
		}
	}
	return {
		// A model can be routed to any published endpoint, so its score is the
		// best privacy-qualified endpoint median for the requested dimension.
		latencyP50: latency.length > 0 ? Math.min(...latency) : null,
		throughputP50: throughput.length > 0 ? Math.max(...throughput) : null,
	};
}

async function loadWeeklyPopularity(
	c: Context<Env>,
	now: Date
): Promise<Map<string, number>> {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	start.setUTCDate(start.getUTCDate() - 6);
	try {
		const rows = await c.get('repositories').analytics.queryPublicModelAnalytics({
			startDate: start.toISOString().slice(0, 10),
			endDate: now.toISOString().slice(0, 10),
		});
		return privacyQualifiedWeeklyTokenTotals(rows);
	} catch (error) {
		console.warn(JSON.stringify({
			message: 'public catalog weekly popularity read failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return new Map();
	}
}

async function buildPublishedCatalogSnapshot(
	c: Context<Env>
): Promise<PublishedCatalogSnapshot> {
	const now = new Date();
	const { models, bindings, providers } = await verifiedBindings(c, now);
	const repositories = c.get('repositories');
	const [performance, weeklyTokenTotals] = await Promise.all([
		loadPublicEndpointPerformance(repositories, bindings, now),
		loadWeeklyPopularity(c, now),
	]);
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
			providers.bySlug,
			performance
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
			providers.bySlug,
			performance
		);
		if (!details) continue;
		const metadata = parseBoundedJsonObject(model.metadata);
		const modelPricing = publishedModelPricing(details.endpoints, metadata);
		const dto = toOpenRouterModel(model, details.endpoints, metadata, modelPricing);
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
		const performanceScores = modelPerformanceScores(
			entries.map((entry) => entry.binding),
			performance
		);
		const categories = explicitModelCategories(model, metadata);
		const architectures = explicitModelArchitectures(metadata);
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
			outputModalities: [...new Set(dto.architecture.output_modalities)].sort(stableStringCompare),
			providers: [...providerFacets].sort(stableStringCompare),
			regions: [...regions].sort(stableStringCompare),
			categories,
			architectures,
			zdr,
			distillable: metadata?.distillable_text === true,
			ageDays: snapshotAgeDays(dto.created, now.getTime()),
			...performanceScores,
			weeklyTokens: weeklyTokenTotals.get(model.id) ?? null,
			promptPricePerMillion: modelPricing.promptPricePerMillion,
			outputPricePerMillion: modelPricing.outputPricePerMillion,
			pricingSortScore: modelPricing.pricingSortScore,
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
	hot: HotSnapshotCache,
	limitColdMiss = true
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
		const limiter = limitColdMiss
			? c.env?.PUBLIC_STATS_RATE_LIMITER ?? runtime?.rateLimiter
			: undefined;
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
	const outputQuery: OutputModalitiesQuery = {
		values: query.outputModalities,
		all: query.allOutputModalities,
	};
	const filtered = records.filter((record) => {
		if (search) {
			if (!record.searchText.includes(search)) return false;
		}
		if (
			query.inputModalities.length > 0
			&& !query.inputModalities.every((value) => record.inputModalities.includes(value))
		) return false;
		if (!modelMatchesOutputQuery(record, outputQuery)) return false;
		if (query.supportedParameters.length > 0) {
			const supported = new Set(record.dto.supported_parameters.map(normalizedIdentity));
			if (!query.supportedParameters.every((value) => supported.has(value))) return false;
		}
		if (
			query.minimumContext !== null
			&& (
				record.dto.context_length === null
				|| record.dto.context_length < query.minimumContext
			)
		) return false;
		if (query.modelAuthors.length > 0) {
			const separator = record.dto.canonical_slug.indexOf('/');
			const author = separator > 0
				? normalizedIdentity(record.dto.canonical_slug.slice(0, separator))
				: '';
			if (!query.modelAuthors.includes(author)) return false;
		}
		if (
			query.providers.length > 0
			&& !query.providers.some((value) => record.providers.includes(value))
		) return false;
		if (query.zdr && !record.zdr) return false;
		if (query.region && !record.regions.includes(query.region)) return false;
		if (query.category && !record.categories.includes(query.category)) return false;
		if (query.arch && !record.architectures.includes(query.arch)) return false;
		if (query.distillable !== null && record.distillable !== query.distillable) return false;
		if (
			query.minimumAgeDays !== null
			&& (record.ageDays === null || record.ageDays < query.minimumAgeDays)
		) return false;
		if (
			query.maximumAgeDays !== null
			&& (record.ageDays === null || record.ageDays > query.maximumAgeDays)
		) return false;
		if (
			query.minimumPromptPrice !== null
			&& (
				record.promptPricePerMillion === null
				|| record.promptPricePerMillion < query.minimumPromptPrice
			)
		) return false;
		if (
			query.maximumPromptPrice !== null
			&& (
				record.promptPricePerMillion === null
				|| record.promptPricePerMillion > query.maximumPromptPrice
			)
		) return false;
		if (
			query.minimumOutputPrice !== null
			&& (
				record.outputPricePerMillion === null
				|| record.outputPricePerMillion < query.minimumOutputPrice
			)
		) return false;
		if (
			query.maximumOutputPrice !== null
			&& (
				record.outputPricePerMillion === null
				|| record.outputPricePerMillion > query.maximumOutputPrice
			)
		) return false;
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
		if (
			query.sort === 'pricing-low-to-high'
			|| query.sort === 'pricing-high-to-low'
		) {
			if (a.pricingSortScore === null && b.pricingSortScore !== null) return 1;
			if (a.pricingSortScore !== null && b.pricingSortScore === null) return -1;
			if (
				a.pricingSortScore !== null
				&& b.pricingSortScore !== null
				&& a.pricingSortScore !== b.pricingSortScore
			) {
				return query.sort === 'pricing-low-to-high'
					? a.pricingSortScore - b.pricingSortScore
					: b.pricingSortScore - a.pricingSortScore;
			}
		}
		if (query.sort === 'throughput-high-to-low') {
			if (a.throughputP50 === null && b.throughputP50 !== null) return 1;
			if (a.throughputP50 !== null && b.throughputP50 === null) return -1;
			if (
				a.throughputP50 !== null
				&& b.throughputP50 !== null
				&& a.throughputP50 !== b.throughputP50
			) return b.throughputP50 - a.throughputP50;
		}
		if (query.sort === 'latency-low-to-high') {
			if (a.latencyP50 === null && b.latencyP50 !== null) return 1;
			if (a.latencyP50 !== null && b.latencyP50 === null) return -1;
			if (
				a.latencyP50 !== null
				&& b.latencyP50 !== null
				&& a.latencyP50 !== b.latencyP50
			) return a.latencyP50 - b.latencyP50;
		}
		if (query.sort === 'most-popular' || query.sort === 'top-weekly') {
			if (a.weeklyTokens === null && b.weeklyTokens !== null) return 1;
			if (a.weeklyTokens !== null && b.weeklyTokens === null) return -1;
			if (
				a.weeklyTokens !== null
				&& b.weeklyTokens !== null
				&& a.weeklyTokens !== b.weeklyTokens
			) return b.weeklyTokens - a.weeklyTokens;
		}
		return stableStringCompare(a.dto.id, b.dto.id);
	});
}

function modelMatchesOutputQuery(
	record: PublishedModelRecord,
	query: OutputModalitiesQuery
): boolean {
	return query.all
		|| query.values.every((value) => record.outputModalities.includes(value));
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
	if (query.allOutputModalities) {
		params.set('output_modalities', 'all');
	} else if (
		query.outputModalities.length !== 1
		|| query.outputModalities[0] !== 'text'
	) {
		params.set('output_modalities', query.outputModalities.join(','));
	}
	if (query.supportedParameters.length > 0) {
		params.set('supported_parameters', query.supportedParameters.join(','));
	}
	if (query.minimumContext !== null) {
		params.set('context', String(query.minimumContext));
	}
	if (query.modelAuthors.length > 0) {
		params.set('model_authors', query.modelAuthors.join(','));
	}
	if (query.providers.length > 0) {
		params.set('providers', query.providers.join(','));
	}
	if (query.zdr) params.set('zdr', 'true');
	if (query.region) params.set('region', query.region);
	if (query.category) params.set('category', query.category);
	if (query.arch) params.set('arch', query.arch);
	if (query.distillable !== null) params.set('distillable', String(query.distillable));
	if (query.minimumAgeDays !== null) params.set('min_age_days', String(query.minimumAgeDays));
	if (query.maximumAgeDays !== null) params.set('max_age_days', String(query.maximumAgeDays));
	if (query.minimumPromptPrice !== null) params.set('min_price', String(query.minimumPromptPrice));
	if (query.maximumPromptPrice !== null) params.set('max_price', String(query.maximumPromptPrice));
	if (query.minimumOutputPrice !== null) {
		params.set('min_output_price', String(query.minimumOutputPrice));
	}
	if (query.maximumOutputPrice !== null) {
		params.set('max_output_price', String(query.maximumOutputPrice));
	}
	if (query.sort) params.set('sort', query.sort);
	return `/api/v1/models?${params.toString()}`;
}

function modelQueryIsSharedCacheable(query: ModelQuery): boolean {
	return (
		query.limit === DEFAULT_LIMIT &&
		query.offset === 0 &&
		query.q === null &&
		query.inputModalities.length === 0 &&
		!query.allOutputModalities &&
		query.outputModalities.length === 1 &&
		query.outputModalities[0] === 'text' &&
		query.supportedParameters.length === 0 &&
		query.minimumContext === null &&
		query.modelAuthors.length === 0 &&
		query.providers.length === 0 &&
		!query.zdr &&
		query.region === null &&
		query.category === null &&
		query.arch === null &&
		query.distillable === null &&
		query.minimumAgeDays === null &&
		query.maximumAgeDays === null &&
		query.minimumPromptPrice === null &&
		query.maximumPromptPrice === null &&
		query.minimumOutputPrice === null &&
		query.maximumOutputPrice === null &&
		query.sort === null
	);
}

function modelCountQueryIsSharedCacheable(query: OutputModalitiesQuery): boolean {
	return !query.all && query.values.length === 1 && query.values[0] === 'text';
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
	managementCatalogRoutes: Hono<Env>;
	providersAliasRoutes: Hono<Env>;
} {
	const singleflight = runtime?.singleflight ?? createPublicStatsSingleflight();
	const hotSnapshot: HotSnapshotCache = { current: null };
	const publicCatalogRoutes = new Hono<Env>();
	const managementCatalogRoutes = new Hono<Env>();
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

	publicCatalogRoutes.get('/models/count', async (c) => {
		const parsed = parseModelCountQuery(new URL(c.req.url));
		if (!parsed.ok) return invalidQueryResponse(c, parsed);
		const query = parsed.value;
		try {
			const loaded = await loadPublishedCatalogSnapshot(c, runtime, singleflight, hotSnapshot);
			if (!loaded.ok) return loaded.response;
			if (!modelCountQueryIsSharedCacheable(query)) {
				const limited = await enforcePublicCatalogRequestLimit(c, runtime, 'query');
				if (limited) return limited;
			}
			const count = loaded.snapshot.records.reduce((total, record) => (
				total + (modelMatchesOutputQuery(record, query) ? 1 : 0)
			), 0);
			return applyPublicCachePolicy(
				c.json({ data: { count } }),
				loaded.snapshot,
				modelCountQueryIsSharedCacheable(query)
			);
		} catch (error) {
			console.error(JSON.stringify({
				message: 'public model count failed',
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: 'Model count failed',
			});
		}
	});

	publicCatalogRoutes.get('/model/:author/:slug', async (c) => {
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
				c.json({ data: record.dto }),
				loaded.snapshot,
				true
			);
		} catch (error) {
			console.error(JSON.stringify({
				message: 'public model detail failed',
				model_id: path.canonicalModelId,
				error_type: error instanceof Error ? error.name : 'UnknownError',
			}));
			return gatewayErrorJson(c, {
				status: 500,
				code: GatewayErrorCode.internalError,
				message: 'Model discovery failed',
			});
		}
	});

	managementCatalogRoutes.get(
		'/models/:author/:slug/endpoints',
		requireModelEndpointsManagementApiKey,
		async (c) => {
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
				const loaded = await loadPublishedCatalogSnapshot(
					c,
					runtime,
					singleflight,
					hotSnapshot,
					false
				);
				if (!loaded.ok) return loaded.response;
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
				c.header('Cache-Control', 'private, no-store');
				return c.json({ data: record.details });
			} catch (error) {
				console.error(JSON.stringify({
					message: 'management endpoint discovery failed',
					model_id: path.canonicalModelId,
					error_type: error instanceof Error ? error.name : 'UnknownError',
				}));
				return gatewayErrorJson(c, {
					status: 500,
					code: GatewayErrorCode.internalError,
					message: 'Endpoint discovery failed',
				});
			}
		}
	);

	return {
		publicCatalogRoutes,
		managementCatalogRoutes,
		providersAliasRoutes,
	};
}
