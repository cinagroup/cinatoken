import { normalizeBillingCurrencyCode } from '@octafuse/core/lib/billing-currency';
import { toPublicModelSlug } from '@octafuse/core/lib/public-model-slug';

const DEFAULT_PUBLIC_API_ORIGIN = 'https://api.cinatoken.com';
const PUBLIC_CATALOG_TIMEOUT_MS = 8_000;
const PROTOCOLS = new Set(['openai', 'anthropic', 'gemini']);

export type PublicCatalogPricingTier = {
	upto: number | null;
	input_price: number;
	output_price: number;
	image_input_price?: number;
	image_output_price?: number;
};

export type PublicCatalogPricingProfile = {
	tiers: PublicCatalogPricingTier[];
	image_billing_mode?: 'token' | 'per_image';
	image?: { default?: number } | null;
	audio_billing_mode?: 'tokens' | 'per_second' | 'per_character';
	audio?: { price_per_second?: number; price_per_character?: number } | null;
};

export type PublicCatalogModel = {
	id: string;
	slug: string;
	displayName: string;
	vendor: string;
	contextWindow: number | null;
	maxTokens: number | null;
	pricingProfile: PublicCatalogPricingProfile | null;
	tags: string[];
	routeGroups: string[];
	protocols: string[];
	recommendedProtocol: string;
	description: string | null;
	inputModalities: string[];
	outputModalities: string[];
	releasedAt: string | null;
};

export type PublicCatalogProvider = {
	id: string;
	displayName: string;
	modelCount: number;
	protocols: string[];
	routeGroups: string[];
	inputModalities: string[];
	outputModalities: string[];
	latestReleasedAt: string | null;
};

export type PublicCatalogResult = {
	status: 'ready' | 'unavailable';
	models: PublicCatalogModel[];
	billingCurrency: string;
	generatedAt: string | null;
};

export type PublicCatalogModelResult = {
	status: 'ready' | 'not-found' | 'unavailable';
	model: PublicCatalogModel | null;
	billingCurrency: string;
	generatedAt: string | null;
};

export type PublicCatalogProvidersResult = {
	status: 'ready' | 'unavailable';
	providers: PublicCatalogProvider[];
	billingCurrency: string;
	generatedAt: string | null;
};

export type PublicModelStats = {
	id: string;
	slug: string;
	displayName: string;
	vendor: string;
	requestCount: number;
	successRate: number;
	avgLatencyMs: number | null;
	outputTokens: number;
};

export type PublicModelStatsResult = {
	status: 'ready' | 'unavailable';
	models: PublicModelStats[];
	range: '7d' | '30d' | '90d';
	windowStart: string | null;
	windowEnd: string | null;
	minimumSampleSize: number;
	generatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 512): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLength);
}

function safeNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeStringArray(value: unknown, maxItems = 24): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value) {
		const parsed = safeString(item, 64);
		if (parsed && !result.includes(parsed)) result.push(parsed);
		if (result.length >= maxItems) break;
	}
	return result;
}

function parsePricingProfile(value: unknown): PublicCatalogPricingProfile | null {
	if (!isRecord(value)) return null;
	const tiers: PublicCatalogPricingTier[] = [];
	if (Array.isArray(value.tiers)) {
		for (const item of value.tiers.slice(0, 32)) {
			if (!isRecord(item)) continue;
			const inputPrice = safeNumber(item.input_price);
			const outputPrice = safeNumber(item.output_price);
			if (inputPrice === null || outputPrice === null) continue;
			const upto = item.upto === null ? null : safeNumber(item.upto);
			const tier: PublicCatalogPricingTier = {
				upto,
				input_price: inputPrice,
				output_price: outputPrice,
			};
			const imageInputPrice = safeNumber(item.image_input_price);
			const imageOutputPrice = safeNumber(item.image_output_price);
			if (imageInputPrice !== null) tier.image_input_price = imageInputPrice;
			if (imageOutputPrice !== null) tier.image_output_price = imageOutputPrice;
			tiers.push(tier);
		}
	}

	const parsed: PublicCatalogPricingProfile = { tiers };
	if (value.image_billing_mode === 'token' || value.image_billing_mode === 'per_image') {
		parsed.image_billing_mode = value.image_billing_mode;
	}
	if (isRecord(value.image)) {
		const defaultPrice = safeNumber(value.image.default);
		parsed.image = defaultPrice === null ? null : { default: defaultPrice };
	}
	if (
		value.audio_billing_mode === 'tokens' ||
		value.audio_billing_mode === 'per_second' ||
		value.audio_billing_mode === 'per_character'
	) {
		parsed.audio_billing_mode = value.audio_billing_mode;
	}
	if (isRecord(value.audio)) {
		const perSecond = safeNumber(value.audio.price_per_second);
		const perCharacter = safeNumber(value.audio.price_per_character);
		parsed.audio = perSecond === null && perCharacter === null
			? null
			: {
				...(perSecond === null ? {} : { price_per_second: perSecond }),
				...(perCharacter === null ? {} : { price_per_character: perCharacter }),
			};
	}

	return tiers.length > 0 || parsed.image || parsed.audio ? parsed : null;
}

function parseModel(value: unknown): PublicCatalogModel | null {
	if (!isRecord(value)) return null;
	const id = safeString(value.id, 180);
	if (!id) return null;
	const vendor = safeString(value.vendor, 80) ?? 'other';
	const protocols = safeStringArray(value.protocols, 8).filter((protocol) => PROTOCOLS.has(protocol));
	if (protocols.length === 0) return null;
	const recommended = safeString(value.recommended_protocol, 32);

	return {
		id,
		slug: (() => {
			const slug = safeString(value.slug, 256);
			return slug && /^[A-Za-z0-9._:~-]+$/.test(slug) ? slug : toPublicModelSlug(id);
		})(),
		displayName: safeString(value.display_name, 180) ?? id,
		vendor,
		contextWindow: safeNumber(value.context_window),
		maxTokens: safeNumber(value.max_tokens),
		pricingProfile: parsePricingProfile(value.pricing_profile),
		tags: safeStringArray(value.tags),
		routeGroups: safeStringArray(value.route_groups),
		protocols,
		recommendedProtocol: recommended && protocols.includes(recommended) ? recommended : protocols[0]!,
		description: safeString(value.description, 1_200),
		inputModalities: safeStringArray(value.input_modalities, 12),
		outputModalities: safeStringArray(value.output_modalities, 12),
		releasedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(value.released_at ?? ''))
			? String(value.released_at)
			: null,
	};
}

function parseProvider(value: unknown): PublicCatalogProvider | null {
	if (!isRecord(value)) return null;
	const id = safeString(value.id, 80);
	const modelCount = safeNumber(value.model_count);
	if (!id || modelCount === null) return null;
	return {
		id,
		displayName: safeString(value.display_name, 80) ?? id,
		modelCount,
		protocols: safeStringArray(value.protocols, 8).filter((protocol) => PROTOCOLS.has(protocol)),
		routeGroups: safeStringArray(value.route_groups),
		inputModalities: safeStringArray(value.input_modalities, 12),
		outputModalities: safeStringArray(value.output_modalities, 12),
		latestReleasedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(value.latest_released_at ?? ''))
			? String(value.latest_released_at)
			: null,
	};
}

function parseModelStats(value: unknown): PublicModelStats | null {
	if (!isRecord(value)) return null;
	const id = safeString(value.id, 180);
	const slug = safeString(value.slug, 256);
	const vendor = safeString(value.vendor, 80);
	const requestCount = safeNumber(value.request_count);
	const successRate = safeNumber(value.success_rate);
	const outputTokens = safeNumber(value.output_tokens);
	if (!id || !slug || !vendor || requestCount === null || successRate === null || successRate > 100 || outputTokens === null) return null;
	return {
		id,
		slug: /^[A-Za-z0-9._:~-]+$/.test(slug) ? slug : toPublicModelSlug(id),
		displayName: safeString(value.display_name, 180) ?? id,
		vendor,
		requestCount,
		successRate,
		avgLatencyMs: value.avg_latency_ms === null ? null : safeNumber(value.avg_latency_ms),
		outputTokens,
	};
}

export function parsePublicCatalogResponse(value: unknown): PublicCatalogResult {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		return { status: 'unavailable', models: [], billingCurrency: 'USD', generatedAt: null };
	}
	const models = value.data
		.slice(0, 5_000)
		.map(parseModel)
		.filter((model): model is PublicCatalogModel => model !== null);
	return {
		status: 'ready',
		models,
		billingCurrency: normalizeBillingCurrencyCode(safeString(value.billing_currency, 3)),
		generatedAt: safeString(value.generated_at, 64),
	};
}

export function parsePublicCatalogModelResponse(value: unknown): PublicCatalogModelResult {
	if (!isRecord(value)) {
		return { status: 'unavailable', model: null, billingCurrency: 'USD', generatedAt: null };
	}
	const model = parseModel(value.data);
	if (!model) {
		return { status: 'unavailable', model: null, billingCurrency: 'USD', generatedAt: null };
	}
	return {
		status: 'ready',
		model,
		billingCurrency: normalizeBillingCurrencyCode(safeString(value.billing_currency, 3)),
		generatedAt: safeString(value.generated_at, 64),
	};
}

export function parsePublicCatalogProvidersResponse(value: unknown): PublicCatalogProvidersResult {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		return { status: 'unavailable', providers: [], billingCurrency: 'USD', generatedAt: null };
	}
	return {
		status: 'ready',
		providers: value.data.slice(0, 1_000).map(parseProvider).filter((provider): provider is PublicCatalogProvider => provider !== null),
		billingCurrency: normalizeBillingCurrencyCode(safeString(value.billing_currency, 3)),
		generatedAt: safeString(value.generated_at, 64),
	};
}

export function parsePublicModelStatsResponse(value: unknown, fallbackRange: '7d' | '30d' | '90d'): PublicModelStatsResult {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		return { status: 'unavailable', models: [], range: fallbackRange, windowStart: null, windowEnd: null, minimumSampleSize: 20, generatedAt: null };
	}
	const range = value.range === '7d' || value.range === '30d' || value.range === '90d' ? value.range : fallbackRange;
	return {
		status: 'ready',
		models: value.data.slice(0, 5_000).map(parseModelStats).filter((model): model is PublicModelStats => model !== null),
		range,
		windowStart: safeString(value.window_start, 64),
		windowEnd: safeString(value.window_end, 64),
		minimumSampleSize: safeNumber(value.minimum_sample_size) ?? 20,
		generatedAt: safeString(value.generated_at, 64),
	};
}

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

export async function fetchPublicCatalogModels(): Promise<PublicCatalogResult> {
	try {
		const response = await fetch(`${resolvePublicApiOrigin()}/catalog/models`, {
			headers: { accept: 'application/json' },
			next: { revalidate: 60 },
			signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`catalog returned ${response.status}`);
		return parsePublicCatalogResponse(await response.json());
	} catch (error) {
		console.error('Public catalog fetch failed:', error);
		return { status: 'unavailable', models: [], billingCurrency: 'USD', generatedAt: null };
	}
}

export async function fetchPublicCatalogModel(vendor: string, slug: string): Promise<PublicCatalogModelResult> {
	if (!vendor || vendor.length > 80 || !slug || slug.length > 256 || !/^[A-Za-z0-9._:~-]+$/.test(slug)) {
		return { status: 'not-found', model: null, billingCurrency: 'USD', generatedAt: null };
	}
	try {
		const response = await fetch(
			`${resolvePublicApiOrigin()}/catalog/models/${encodeURIComponent(vendor)}/${encodeURIComponent(slug)}`,
			{
				headers: { accept: 'application/json' },
				next: { revalidate: 60 },
				signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
			}
		);
		if (response.status === 404) {
			return { status: 'not-found', model: null, billingCurrency: 'USD', generatedAt: null };
		}
		if (!response.ok) throw new Error(`catalog model returned ${response.status}`);
		return parsePublicCatalogModelResponse(await response.json());
	} catch (error) {
		console.error('Public catalog model fetch failed:', error);
		return { status: 'unavailable', model: null, billingCurrency: 'USD', generatedAt: null };
	}
}

export async function fetchPublicCatalogProviders(): Promise<PublicCatalogProvidersResult> {
	try {
		const response = await fetch(`${resolvePublicApiOrigin()}/catalog/providers`, {
			headers: { accept: 'application/json' },
			next: { revalidate: 60 },
			signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`catalog providers returned ${response.status}`);
		return parsePublicCatalogProvidersResponse(await response.json());
	} catch (error) {
		console.error('Public catalog providers fetch failed:', error);
		return { status: 'unavailable', providers: [], billingCurrency: 'USD', generatedAt: null };
	}
}

export async function fetchPublicModelStats(range: '7d' | '30d' | '90d' = '7d'): Promise<PublicModelStatsResult> {
	try {
		const response = await fetch(`${resolvePublicApiOrigin()}/catalog/stats/models?range=${range}`, {
			headers: { accept: 'application/json' },
			next: { revalidate: 60 },
			signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`catalog stats returned ${response.status}`);
		return parsePublicModelStatsResponse(await response.json(), range);
	} catch (error) {
		console.error('Public model stats fetch failed:', error);
		return { status: 'unavailable', models: [], range, windowStart: null, windowEnd: null, minimumSampleSize: 20, generatedAt: null };
	}
}
