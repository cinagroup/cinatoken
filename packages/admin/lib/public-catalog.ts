import { normalizeBillingCurrencyCode } from "@octafuse/core/lib/billing-currency";
import { toPublicModelSlug } from "@octafuse/core/lib/public-model-slug";
import {
	parsePricingProfile as parseCorePricingProfile,
	type ParsedPricingProfile,
	type PricingTierPrices,
} from "@octafuse/core/db/pricing-profile";

import { fetchPublicGateway } from "@/lib/public-gateway";

export { resolvePublicApiOrigin } from "@/lib/public-gateway";
const PUBLIC_CATALOG_TIMEOUT_MS = 8_000;
const PROTOCOLS = new Set(["openai", "anthropic", "gemini"]);

// Type-only DTOs: client components never import the parser or a Core runtime.
export type PublicCatalogPricingTier = PricingTierPrices;
export type PublicCatalogPricingProfile = ParsedPricingProfile;

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
	endpointSlugs: string[];
	regions: string[];
	dataPolicySummary: {
		verifiedRouteCount: number;
		zdrAvailable: boolean;
		latestVerifiedAt: string | null;
	};
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
	status: "ready" | "unavailable";
	models: PublicCatalogModel[];
	billingCurrency: string;
	generatedAt: string | null;
};

export type PublicCatalogModelResult = {
	status: "ready" | "not-found" | "unavailable";
	model: PublicCatalogModel | null;
	billingCurrency: string;
	generatedAt: string | null;
};

export type PublicCatalogProvidersResult = {
	status: "ready" | "unavailable";
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
	status: "ready" | "unavailable";
	models: PublicModelStats[];
	range: "7d" | "30d" | "90d";
	windowStart: string | null;
	windowEnd: string | null;
	minimumSampleSize: number;
	generatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 512): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLength);
}

function safeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
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

function parsePricingProfile(
	value: unknown
): PublicCatalogPricingProfile | null {
	if (!isRecord(value)) return null;
	if (Array.isArray(value.tiers) && value.tiers.length > 1_024) return null;
	let parsed: ParsedPricingProfile | null;
	try {
		parsed = parseCorePricingProfile(JSON.stringify(value));
	} catch {
		return null;
	}
	if (!parsed) return null;
	// Project every public field explicitly. Costs, credentials and future Core
	// metadata must never be passed through merely because the parser accepts it.
	const result: PublicCatalogPricingProfile = {
		tiers: parsed.tiers.map((tier) => ({
			upto: tier.upto,
			label: tier.label,
			input_price: tier.input_price,
			output_price: tier.output_price,
			cache_read_price: tier.cache_read_price,
			cache_write_price: tier.cache_write_price,
			image_input_price: tier.image_input_price,
			image_input_cache_price: tier.image_input_cache_price,
			image_output_price: tier.image_output_price,
		})),
	};
	if (parsed.image_billing_mode)
		result.image_billing_mode = parsed.image_billing_mode;
	if (parsed.image) {
		const side = (source: NonNullable<ParsedPricingProfile["image"]>) => ({
			default: source.default,
			...(source.by_quality ? { by_quality: { ...source.by_quality } } : {}),
			...(source.by_size ? { by_size: { ...source.by_size } } : {}),
			...(source.by_quality_size
				? { by_quality_size: { ...source.by_quality_size } }
				: {}),
		});
		result.image = {
			...side(parsed.image),
			...(parsed.image.input ? { input: side(parsed.image.input) } : {}),
			...(parsed.image.uncertain_result_policy
				? { uncertain_result_policy: parsed.image.uncertain_result_policy }
				: {}),
		};
	}
	if (parsed.audio_billing_mode)
		result.audio_billing_mode = parsed.audio_billing_mode;
	if (parsed.audio && typeof parsed.audio.price_per_second === "number") {
		result.audio = {
			price_per_second: parsed.audio.price_per_second,
			...(parsed.audio.minimum_seconds === undefined
				? {}
				: { minimum_seconds: parsed.audio.minimum_seconds }),
		};
	} else if (
		parsed.audio &&
		typeof parsed.audio.price_per_character === "number"
	) {
		result.audio = {
			price_per_character: parsed.audio.price_per_character,
			...(parsed.audio.minimum_characters === undefined
				? {}
				: { minimum_characters: parsed.audio.minimum_characters }),
		};
	}
	return result;
}

function parseModel(value: unknown): PublicCatalogModel | null {
	if (!isRecord(value)) return null;
	const id = safeString(value.id, 180);
	if (!id) return null;
	const vendor = safeString(value.vendor, 80) ?? "other";
	const protocols = safeStringArray(value.protocols, 8).filter((protocol) =>
		PROTOCOLS.has(protocol)
	);
	if (protocols.length === 0) return null;
	const recommended = safeString(value.recommended_protocol, 32);

	return {
		id,
		slug: (() => {
			const slug = safeString(value.slug, 256);
			return slug && /^[A-Za-z0-9._:~-]+$/.test(slug)
				? slug
				: toPublicModelSlug(id);
		})(),
		displayName: safeString(value.display_name, 180) ?? id,
		vendor,
		contextWindow: safeNumber(value.context_window),
		maxTokens: safeNumber(value.max_tokens),
		pricingProfile: parsePricingProfile(value.pricing_profile),
		tags: safeStringArray(value.tags),
		routeGroups: safeStringArray(value.route_groups),
		protocols,
		recommendedProtocol:
			recommended && protocols.includes(recommended)
				? recommended
				: protocols[0]!,
		description: safeString(value.description, 1_200),
		inputModalities: safeStringArray(value.input_modalities, 12),
		outputModalities: safeStringArray(value.output_modalities, 12),
		releasedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(value.released_at ?? ""))
			? String(value.released_at)
			: null,
		endpointSlugs: safeStringArray(value.endpoint_slugs, 64).filter(
			(slug) =>
				slug.length <= 120 &&
				/^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*$/.test(slug)
		),
		regions: safeStringArray(value.regions, 64).filter((region) =>
			/^[a-z0-9][a-z0-9._-]{0,63}$/.test(region)
		),
		dataPolicySummary: isRecord(value.data_policy_summary)
			? {
					verifiedRouteCount:
						safeNumber(value.data_policy_summary.verified_route_count) ?? 0,
					zdrAvailable: value.data_policy_summary.zdr_available === true,
					latestVerifiedAt: safeString(
						value.data_policy_summary.latest_verified_at,
						64
					),
			  }
			: { verifiedRouteCount: 0, zdrAvailable: false, latestVerifiedAt: null },
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
		protocols: safeStringArray(value.protocols, 8).filter((protocol) =>
			PROTOCOLS.has(protocol)
		),
		routeGroups: safeStringArray(value.route_groups),
		inputModalities: safeStringArray(value.input_modalities, 12),
		outputModalities: safeStringArray(value.output_modalities, 12),
		latestReleasedAt: /^\d{4}-\d{2}-\d{2}$/.test(
			String(value.latest_released_at ?? "")
		)
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
	if (
		!id ||
		!slug ||
		!vendor ||
		requestCount === null ||
		successRate === null ||
		successRate > 100 ||
		outputTokens === null
	)
		return null;
	return {
		id,
		slug: /^[A-Za-z0-9._:~-]+$/.test(slug) ? slug : toPublicModelSlug(id),
		displayName: safeString(value.display_name, 180) ?? id,
		vendor,
		requestCount,
		successRate,
		avgLatencyMs:
			value.avg_latency_ms === null ? null : safeNumber(value.avg_latency_ms),
		outputTokens,
	};
}

export function parsePublicCatalogResponse(
	value: unknown
): PublicCatalogResult {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		return {
			status: "unavailable",
			models: [],
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
	const models = value.data
		.slice(0, 5_000)
		.map(parseModel)
		.filter((model): model is PublicCatalogModel => model !== null);
	return {
		status: "ready",
		models,
		billingCurrency: normalizeBillingCurrencyCode(
			safeString(value.billing_currency, 3)
		),
		generatedAt: safeString(value.generated_at, 64),
	};
}

export function parsePublicCatalogModelResponse(
	value: unknown
): PublicCatalogModelResult {
	if (!isRecord(value)) {
		return {
			status: "unavailable",
			model: null,
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
	const model = parseModel(value.data);
	if (!model) {
		return {
			status: "unavailable",
			model: null,
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
	return {
		status: "ready",
		model,
		billingCurrency: normalizeBillingCurrencyCode(
			safeString(value.billing_currency, 3)
		),
		generatedAt: safeString(value.generated_at, 64),
	};
}

export function parsePublicCatalogProvidersResponse(
	value: unknown
): PublicCatalogProvidersResult {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		return {
			status: "unavailable",
			providers: [],
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
	return {
		status: "ready",
		providers: value.data
			.slice(0, 1_000)
			.map(parseProvider)
			.filter(
				(provider): provider is PublicCatalogProvider => provider !== null
			),
		billingCurrency: normalizeBillingCurrencyCode(
			safeString(value.billing_currency, 3)
		),
		generatedAt: safeString(value.generated_at, 64),
	};
}

export function parsePublicModelStatsResponse(
	value: unknown,
	fallbackRange: "7d" | "30d" | "90d"
): PublicModelStatsResult {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		return {
			status: "unavailable",
			models: [],
			range: fallbackRange,
			windowStart: null,
			windowEnd: null,
			minimumSampleSize: 20,
			generatedAt: null,
		};
	}
	const range =
		value.range === "7d" || value.range === "30d" || value.range === "90d"
			? value.range
			: fallbackRange;
	return {
		status: "ready",
		models: value.data
			.slice(0, 5_000)
			.map(parseModelStats)
			.filter((model): model is PublicModelStats => model !== null),
		range,
		windowStart: safeString(value.window_start, 64),
		windowEnd: safeString(value.window_end, 64),
		minimumSampleSize: safeNumber(value.minimum_sample_size) ?? 20,
		generatedAt: safeString(value.generated_at, 64),
	};
}

export async function fetchPublicCatalogModels(): Promise<PublicCatalogResult> {
	try {
		const response = await fetchPublicGateway("/catalog/models", {
			headers: { accept: "application/json" },
			next: { revalidate: 60 },
			signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`catalog returned ${response.status}`);
		return parsePublicCatalogResponse(await response.json());
	} catch (error) {
		console.error("Public catalog fetch failed:", error);
		return {
			status: "unavailable",
			models: [],
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
}

export async function fetchPublicCatalogModel(
	vendor: string,
	slug: string
): Promise<PublicCatalogModelResult> {
	if (
		!vendor ||
		vendor.length > 80 ||
		!slug ||
		slug.length > 256 ||
		!/^[A-Za-z0-9._:~-]+$/.test(slug)
	) {
		return {
			status: "not-found",
			model: null,
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
	try {
		const response = await fetchPublicGateway(
			`/catalog/models/${encodeURIComponent(vendor)}/${encodeURIComponent(
				slug
			)}`,
			{
				headers: { accept: "application/json" },
				next: { revalidate: 60 },
				signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
			}
		);
		if (response.status === 404) {
			return {
				status: "not-found",
				model: null,
				billingCurrency: "USD",
				generatedAt: null,
			};
		}
		if (!response.ok)
			throw new Error(`catalog model returned ${response.status}`);
		return parsePublicCatalogModelResponse(await response.json());
	} catch (error) {
		console.error("Public catalog model fetch failed:", error);
		return {
			status: "unavailable",
			model: null,
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
}

export async function fetchPublicCatalogProviders(): Promise<PublicCatalogProvidersResult> {
	try {
		const response = await fetchPublicGateway("/catalog/providers", {
			headers: { accept: "application/json" },
			next: { revalidate: 60 },
			signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
		});
		if (!response.ok)
			throw new Error(`catalog providers returned ${response.status}`);
		return parsePublicCatalogProvidersResponse(await response.json());
	} catch (error) {
		console.error("Public catalog providers fetch failed:", error);
		return {
			status: "unavailable",
			providers: [],
			billingCurrency: "USD",
			generatedAt: null,
		};
	}
}

export async function fetchPublicModelStats(
	range: "7d" | "30d" | "90d" = "7d"
): Promise<PublicModelStatsResult> {
	try {
		const response = await fetchPublicGateway(
			`/catalog/stats/models?range=${range}`,
			{
				headers: { accept: "application/json" },
				next: { revalidate: 60 },
				signal: AbortSignal.timeout(PUBLIC_CATALOG_TIMEOUT_MS),
			}
		);
		if (!response.ok)
			throw new Error(`catalog stats returned ${response.status}`);
		return parsePublicModelStatsResponse(await response.json(), range);
	} catch (error) {
		console.error("Public model stats fetch failed:", error);
		return {
			status: "unavailable",
			models: [],
			range,
			windowStart: null,
			windowEnd: null,
			minimumSampleSize: 20,
			generatedAt: null,
		};
	}
}
