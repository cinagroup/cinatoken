import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	collectRoutePerformanceSeries,
	isAudioSpeechModel,
	isAudioTranscriptionModel,
	modelEndpointSupportsOperation,
	modelEndpointSubjectFingerprintIsValid,
	MIN_ROUTE_AVAILABILITY_OBSERVATIONS,
	normalizeUpstreamProtocol,
	parseVerifiedModelEndpointSnapshot,
	parseModelModalitiesJson,
	parseProviderEndpoints,
	protocolHasEndpointsConfig,
	routeDataPolicyAllowsZdr,
	routePerformancePercentile,
	ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY,
	ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
	verifiedEndpointMatchesLegacyRoutingMetadata,
	type GatewayRepositories,
	type ModelEndpointDiscoveryRouteBindingRow,
	type ModelEndpointRow,
	type ModelRow,
	type ProviderRow,
	type RouteDataPolicyRow,
	type VerifiedModelEndpointSnapshot,
} from "@octafuse/core";
import {
	AUDIO_ENDPOINT_PRICING_OPERATIONS,
	audioEndpointSpeechRequestCapabilities,
	isPublicEndpointCapabilityReady,
	normalizeEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	serializeImagePricingLine,
	type AudioEndpointCapabilities,
	type AudioEndpointPricingOperation,
	type AudioOperationPricing,
	type ImageCapabilityDescriptor,
	type ImageEndpointCapabilities,
} from "@octafuse/core/model-endpoint-catalog";

const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,179}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ENDPOINT_TAG = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/u;
const PARAMETER = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const PUBLIC_PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const POLICY_BATCH = 90;
const ENDPOINT_PAGE_SIZE = 100;
export const MAX_PUBLIC_ENDPOINT_CATALOG_SIZE = 1_000;
export const MAX_PUBLIC_ENDPOINT_ROUTE_BINDINGS = 1_000;

export type PublicEndpointDiscoveryRepositories = {
	modelRouting: Pick<
		GatewayRepositories["modelRouting"],
		"getModelById" | "listModelsWithActiveRoutes"
	>;
	providers: Pick<GatewayRepositories["providers"], "getProvidersByIds">;
	modelEndpoints: Pick<
		GatewayRepositories["modelEndpoints"],
		"list" | "listByModelId" | "listDiscoveryRouteBindings"
	>;
	routeDataPolicies: Pick<
		GatewayRepositories["routeDataPolicies"],
		"getByRouteTargetIds"
	>;
	requestLogs: Pick<
		GatewayRepositories["requestLogs"],
		"getRecentRoutePerformanceSamples" | "getRouteAvailabilityAggregates"
	>;
};
type ToolChoice = {
	auto: boolean;
	function: boolean;
	none: boolean;
	required: boolean;
};
type PublicEndpointPricing = Omit<
	ReturnType<typeof normalizeTextEndpointPricing>,
	"currency"
>;
export type PublicModelEndpoint = {
	name: string;
	model_id: string;
	model_name: string;
	provider_name: string;
	tag: string;
	context_length: number;
	max_prompt_tokens: number | null;
	max_completion_tokens: number | null;
	quantization: string | null;
	supported_parameters: string[];
	pricing: PublicEndpointPricing;
	supports_implicit_caching: boolean;
	supports_tool_choice: ToolChoice;
	supports_voice_cloning: boolean;
	/** CinaToken extension: null means the endpoint has no verified default-voice fact. */
	supports_default_voice: boolean | null;
	/** CinaToken extension: exact clone-reference media types accepted by this endpoint. */
	reference_audio_media_types: string[];
	/** CinaToken extension: media type assigned to raw Base64 clone references. */
	reference_audio_default_media_type: string | null;
	/** CinaToken extension: verified operation facts scoped to callable bound routes. */
	audio_capabilities: AudioEndpointCapabilities | null;
	/** OpenRouter uses `0` for an endpoint that is currently available. */
	status: 0;
	latency_last_30m: PublicEndpointPercentiles | null;
	throughput_last_30m: PublicEndpointPercentiles | null;
	uptime_last_5m: number | null;
	uptime_last_30m: number | null;
	uptime_last_1d: number | null;
};
export type PublicEndpointPercentiles = {
	p50: number;
	p75: number;
	p90: number;
	p99: number;
};
export type PublicEndpointPerformance = {
	latencyLast30m: PublicEndpointPercentiles | null;
	throughputLast30m: PublicEndpointPercentiles | null;
	uptimeLast5m: number | null;
	uptimeLast30m: number | null;
	uptimeLast1d: number | null;
};
export type PublicEndpointPerformanceMap = ReadonlyMap<string, PublicEndpointPerformance>;

const PUBLIC_ENDPOINT_PERFORMANCE_WINDOW_MS = 30 * 60 * 1_000;
export const PUBLIC_ENDPOINT_PERFORMANCE_MINIMUM_SAMPLE_SIZE = 20;
/** OpenRouter begins endpoint uptime classification only after 100 observations. */
export const PUBLIC_ENDPOINT_UPTIME_MINIMUM_SAMPLE_SIZE = MIN_ROUTE_AVAILABILITY_OBSERVATIONS;
export type PublicModelEndpointsDocument = {
	id: string;
	name: string;
	description: string;
	created: number;
	architecture: {
		input_modalities: string[];
		output_modalities: string[];
		modality: string | null;
		instruct_type: string | null;
		tokenizer: string | null;
	};
	endpoints: PublicModelEndpoint[];
};
export type PublicImageEndpoint = {
	provider_name: string;
	provider_slug: string;
	provider_tag: string | null;
	supported_parameters: Record<string, ImageCapabilityDescriptor>;
	allowed_passthrough_parameters: string[];
	pricing: ReturnType<typeof serializeImagePricingLine>[];
	supports_streaming: boolean;
};
export type PublicImageModel = {
	id: string;
	name: string;
	description: string;
	created: number;
	endpoints: string;
	architecture: { input_modalities: string[]; output_modalities: string[] };
	supported_parameters: Record<string, ImageCapabilityDescriptor>;
	supports_streaming: boolean;
};
export type PublicImageModelEndpointsDocument = {
	id: string;
	endpoints: PublicImageEndpoint[];
};
export type ParsedModelEndpointPath = {
	author: string;
	slug: string;
	canonicalModelId: string;
};

/**
 * Normalize legacy dedicated Audio model rows to the current OpenRouter output
 * vocabulary without mutating stored catalog data. Explicit speech/transcription
 * modalities remain authoritative; only legacy pricing-classified rows are remapped.
 */
export function openRouterModelOutputModalities(model: ModelRow): string[] {
	const stored = parseModelModalitiesJson(model.output_modalities) ?? [];
	if (stored.includes("speech") || stored.includes("transcription")) {
		return [...new Set(stored)].sort(stableStringCompare);
	}
	const speech = isAudioSpeechModel(model);
	const transcription = isAudioTranscriptionModel(model);
	if (speech !== transcription) return [speech ? "speech" : "transcription"];
	return [...new Set(stored)].sort(stableStringCompare);
}

export function parseModelEndpointPath(
	author: string,
	slug: string
): ParsedModelEndpointPath | null {
	if (!AUTHOR.test(author) || !SLUG.test(slug)) return null;
	const canonicalModelId = `${author}/${slug}`;
	return canonicalModelId.length <= 240
		? { author, slug, canonicalModelId }
		: null;
}
function safe(value: unknown, max = 160): string | null {
	if (typeof value !== "string") return null;
	const s = value.trim();
	return s && s.length <= max && !CONTROL.test(s) ? s : null;
}
function epoch(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(
		/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value
	);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
function created(model: ModelRow): number {
	return epoch(model.released_at) ?? epoch(model.created_at) ?? 0;
}
function json(value: string): unknown {
	return JSON.parse(value) as unknown;
}
async function exactModel(
	r: PublicEndpointDiscoveryRepositories,
	p: ParsedModelEndpointPath
): Promise<ModelRow | null> {
	const canonical = await r.modelRouting.getModelById(p.canonicalModelId);
	if (canonical?.id === p.canonicalModelId) return canonical;
	const simple = await r.modelRouting.getModelById(p.slug);
	return simple?.id === p.slug &&
		safe(simple.vendor, 64)?.toLowerCase() === p.author.toLowerCase()
		? simple
		: null;
}
function providerCallable(
	p: ProviderRow,
	r: ModelEndpointDiscoveryRouteBindingRow
): boolean {
	// Evidence is bound to one operator-owned Provider credential. A shared key
	// can represent another account/contract and needs its own evidence model.
	if (p.status !== "active" || !p.api_key || p.shared_channel_type)
		return false;
	try {
		return protocolHasEndpointsConfig(
			parseProviderEndpoints(p),
			normalizeUpstreamProtocol(r.upstream_protocol)
		);
	} catch {
		return false;
	}
}
export type VerifiedPublicEndpointBinding = {
	endpoint: ModelEndpointRow;
	snapshot: VerifiedModelEndpointSnapshot;
	routes: ModelEndpointDiscoveryRouteBindingRow[];
	provider: ProviderRow;
};

export type PublishedPublicProviderIdentity = {
	name: string;
	slug: string;
};

export type PublishedPublicProviderCatalog = {
	providers: PublishedPublicProviderIdentity[];
	bySlug: ReadonlyMap<string, PublishedPublicProviderIdentity>;
};

function stableStringCompare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function normalizedProviderSlug(value: string): string | null {
	const slug = value.trim().toLowerCase();
	return PUBLIC_PROVIDER_SLUG.test(slug) ? slug : null;
}

function normalizedProviderName(value: string): string | null {
	return safe(value, 160);
}

/**
 * Resolve the one public provider identity owned by each endpoint slug.
 *
 * Multiple credentials/accounts with the same public slug and case-insensitively
 * identical name collapse to one provider. A slug mapped to genuinely different
 * names is omitted entirely; callers must use `bySlug` to apply the same
 * fail-closed decision to provider lists, model filters, and endpoint details.
 */
export function resolvePublishedPublicProviders(
	bindings: readonly VerifiedPublicEndpointBinding[]
): PublishedPublicProviderCatalog {
	const namesBySlug = new Map<string, Set<string>>();
	for (const binding of bindings) {
		const slug = normalizedProviderSlug(binding.endpoint.provider_slug);
		const name = normalizedProviderName(binding.provider.name);
		if (!slug || !name) continue;
		const names = namesBySlug.get(slug) ?? new Set<string>();
		names.add(name);
		namesBySlug.set(slug, names);
	}

	const providers: PublishedPublicProviderIdentity[] = [];
	for (const [slug, names] of namesBySlug) {
		const stableNames = [...names].sort(stableStringCompare);
		const normalizedNames = new Set(
			stableNames.map((name) => name.normalize("NFKC").toLocaleLowerCase("en-US"))
		);
		if (normalizedNames.size !== 1) continue;
		providers.push({ slug, name: stableNames[0]! });
	}
	providers.sort((a, b) => stableStringCompare(a.slug, b.slug));
	return {
		providers,
		bySlug: new Map(providers.map((provider) => [provider.slug, provider])),
	};
}
type BindingLoadState = {
	providersById: Map<string, ProviderRow | null>;
	routeBindingCount: number;
};
function createBindingLoadState(): BindingLoadState {
	return { providersById: new Map(), routeBindingCount: 0 };
}
function routeCallable(route: ModelEndpointDiscoveryRouteBindingRow): boolean {
	return (
		route.status === "active" &&
		(route.route_pool_id == null || route.pool_status === "active")
	);
}
async function routeSubjectMatches(
	route: ModelEndpointDiscoveryRouteBindingRow,
	provider: ProviderRow
): Promise<boolean> {
	if (!modelEndpointSubjectFingerprintIsValid(route.subject_fingerprint)) return false;
	try {
		return (
			(await computeRouteDataPolicySubjectFingerprintFromRows(route, provider)) ===
			route.subject_fingerprint
		);
	} catch {
		return false;
	}
}
async function bindRows(
	r: PublicEndpointDiscoveryRepositories,
	endpoints: ModelEndpointRow[],
	state: BindingLoadState,
	now: Date
): Promise<VerifiedPublicEndpointBinding[]> {
	if (!endpoints.length) return [];
	const routeRows = await r.modelEndpoints.listDiscoveryRouteBindings(
		endpoints.map((e) => e.id)
	);
	state.routeBindingCount += routeRows.length;
	if (state.routeBindingCount > MAX_PUBLIC_ENDPOINT_ROUTE_BINDINGS) {
		throw new RangeError(
			`public endpoint route bindings exceed safety limit ${MAX_PUBLIC_ENDPOINT_ROUTE_BINDINGS}`
		);
	}

	const endpointById = new Map<string, {
		endpoint: ModelEndpointRow;
		snapshot: VerifiedModelEndpointSnapshot;
	}>();
	for (const endpoint of endpoints) {
		const snapshot = parseVerifiedModelEndpointSnapshot(endpoint, now);
		if (snapshot) endpointById.set(endpoint.id, { endpoint, snapshot });
	}
	const routesByEndpoint = new Map<
		string,
		ModelEndpointDiscoveryRouteBindingRow[]
	>();
	for (const route of routeRows) {
		const bound = endpointById.get(route.endpoint_id);
		if (
			!bound ||
			route.model_id !== bound.snapshot.modelId ||
			route.provider_id !== bound.snapshot.providerId ||
			!verifiedEndpointMatchesLegacyRoutingMetadata(
				bound.snapshot,
				route.routing_metadata
			) ||
			!modelEndpointSupportsOperation(
				bound.snapshot,
				route.upstream_operation
			) ||
			!routeCallable(route)
		)
			continue;
		const linked = routesByEndpoint.get(bound.endpoint.id) ?? [];
		linked.push(route);
		routesByEndpoint.set(bound.endpoint.id, linked);
	}

	const missingProviderIds = [
		...new Set(
			endpoints
				.filter((endpoint) => routesByEndpoint.has(endpoint.id))
				.map((endpoint) => endpoint.provider_id)
				.filter((id) => !state.providersById.has(id))
		),
	];
	if (missingProviderIds.length > 0) {
		for (const id of missingProviderIds) state.providersById.set(id, null);
		const requested = new Set(missingProviderIds);
		for (const provider of await r.providers.getProvidersByIds(
			missingProviderIds
		)) {
			if (requested.has(provider.id))
				state.providersById.set(provider.id, provider);
		}
	}

	const bindings: VerifiedPublicEndpointBinding[] = [];
	for (const endpoint of endpoints) {
		const bound = endpointById.get(endpoint.id);
		if (!bound) continue;
		const provider = state.providersById.get(endpoint.provider_id);
		if (!provider) continue;
		const linked: ModelEndpointDiscoveryRouteBindingRow[] = [];
		for (const route of routesByEndpoint.get(endpoint.id) ?? []) {
			if (
				providerCallable(provider, route) &&
				(await routeSubjectMatches(route, provider))
			) linked.push(route);
		}
		if (linked.length) bindings.push({
			endpoint,
			snapshot: bound.snapshot,
			routes: linked,
			provider,
		});
	}
	return bindings;
}
async function bindings(
	r: PublicEndpointDiscoveryRepositories,
	m: ModelRow,
	now: Date
): Promise<VerifiedPublicEndpointBinding[]> {
	const pages: ModelEndpointRow[][] = [];
	for (
		let offset = 0;
		offset < MAX_PUBLIC_ENDPOINT_CATALOG_SIZE;
		offset += ENDPOINT_PAGE_SIZE
	) {
		const page = await r.modelEndpoints.listByModelId(m.id, {
			status: "verified",
			limit: ENDPOINT_PAGE_SIZE,
			offset,
		});
		pages.push(page);
		if (page.length < ENDPOINT_PAGE_SIZE) break;
		if (offset + ENDPOINT_PAGE_SIZE === MAX_PUBLIC_ENDPOINT_CATALOG_SIZE) {
			const overflow = await r.modelEndpoints.listByModelId(m.id, {
				status: "verified",
				limit: 1,
				offset: MAX_PUBLIC_ENDPOINT_CATALOG_SIZE,
			});
			if (overflow.length)
				throw new RangeError(
					`public endpoint catalog exceeds safety limit ${MAX_PUBLIC_ENDPOINT_CATALOG_SIZE}`
				);
		}
	}
	const state = createBindingLoadState();
	const result: VerifiedPublicEndpointBinding[] = [];
	for (const page of pages)
		result.push(
			...(await bindRows(
				r,
				page.filter((e) => e.model_id === m.id),
				state,
				now
			))
		);
	return result;
}
export async function listVerifiedPublicEndpointBindings(
	r: PublicEndpointDiscoveryRepositories,
	models: ModelRow[],
	now = new Date()
): Promise<VerifiedPublicEndpointBinding[]> {
	if (models.length === 0) return [];
	const modelIds = new Set(models.map((m) => m.id));
	const pages: ModelEndpointRow[][] = [];
	for (
		let offset = 0;
		offset < MAX_PUBLIC_ENDPOINT_CATALOG_SIZE;
		offset += ENDPOINT_PAGE_SIZE
	) {
		const page = await r.modelEndpoints.list({
			status: "verified",
			limit: ENDPOINT_PAGE_SIZE,
			offset,
		});
		pages.push(page.filter((e) => modelIds.has(e.model_id)));
		if (page.length < ENDPOINT_PAGE_SIZE) break;
		if (offset + ENDPOINT_PAGE_SIZE === MAX_PUBLIC_ENDPOINT_CATALOG_SIZE) {
			const overflow = await r.modelEndpoints.list({
				status: "verified",
				limit: 1,
				offset: MAX_PUBLIC_ENDPOINT_CATALOG_SIZE,
			});
			if (overflow.length > 0) {
				throw new RangeError(
					`public endpoint catalog exceeds safety limit ${MAX_PUBLIC_ENDPOINT_CATALOG_SIZE}`
				);
			}
		}
	}
	const state = createBindingLoadState();
	const result: VerifiedPublicEndpointBinding[] = [];
	for (const page of pages) result.push(...(await bindRows(r, page, state, now)));
	return result;
}
function validCapacity(value: number | null): boolean {
	return value === null || (Number.isSafeInteger(value) && value > 0);
}

function textEndpoint(
	m: ModelRow,
	e: ModelEndpointRow,
	p: ProviderRow,
	providerNameOverride?: string,
	performance?: PublicEndpointPerformance
): PublicModelEndpoint | null {
	if (
		e.context_length == null ||
		!validCapacity(e.context_length) ||
		!validCapacity(e.max_prompt_tokens) ||
		!validCapacity(e.max_completion_tokens) ||
		!ENDPOINT_TAG.test(e.tag) ||
		(e.quantization !== null && safe(e.quantization, 64) === null)
	)
		return null;
	try {
		const c = normalizeEndpointCapabilities({
			implicit_caching:
				e.supports_implicit_caching == null
					? null
					: Boolean(e.supports_implicit_caching),
			voice_cloning:
				e.supports_voice_cloning == null
					? null
					: Boolean(e.supports_voice_cloning),
			tool_choice: json(e.supports_tool_choice),
		});
		if (!isPublicEndpointCapabilityReady(c)) return null;
		const { currency: _, ...pricing } = normalizeTextEndpointPricing(
			json(e.pricing)
		);
		const params = json(e.supported_parameters);
		const pn = safe(providerNameOverride ?? p.name);
		if (
			!pn ||
			!Array.isArray(params) ||
			params.length > 128 ||
			params.some((x) => typeof x !== "string" || !PARAMETER.test(x))
		)
			return null;
		const lowered = (params as string[]).map((x) => x.toLowerCase());
		if (new Set(lowered).size !== lowered.length) return null;
		return {
			name: `${pn}: ${safe(m.display_name) ?? m.id}`,
			model_id: m.id,
			model_name: safe(m.display_name) ?? m.id,
			provider_name: pn,
			tag: e.tag,
			context_length: e.context_length,
			max_prompt_tokens: e.max_prompt_tokens,
			max_completion_tokens: e.max_completion_tokens,
			quantization: e.quantization,
			supported_parameters: [...(params as string[])].sort(),
			pricing,
			supports_implicit_caching: c.implicit_caching!,
			supports_tool_choice: c.tool_choice as ToolChoice,
			supports_voice_cloning: c.voice_cloning!,
			supports_default_voice: null,
			reference_audio_media_types: [],
			reference_audio_default_media_type: null,
			audio_capabilities: null,
			status: 0,
			latency_last_30m: performance?.latencyLast30m ?? null,
			throughput_last_30m: performance?.throughputLast30m ?? null,
			uptime_last_5m: performance?.uptimeLast5m ?? null,
			uptime_last_30m: performance?.uptimeLast30m ?? null,
			uptime_last_1d: performance?.uptimeLast1d ?? null,
		};
	} catch {
		return null;
	}
}

type AudioModelKind = "speech" | "transcription";

function audioModelKind(model: ModelRow): AudioModelKind | null {
	const speech = isAudioSpeechModel(model);
	const transcription = isAudioTranscriptionModel(model);
	if (speech === transcription) return null;
	return speech ? "speech" : "transcription";
}

function audioOperationMatchesKind(
	operation: AudioEndpointPricingOperation,
	kind: AudioModelKind
): boolean {
	return kind === "speech"
		? operation.startsWith("audio.speech")
		: operation.startsWith("audio.transcriptions");
}

function boundAudioCapabilities(
	binding: VerifiedPublicEndpointBinding,
	kind: AudioModelKind
): AudioEndpointCapabilities | null {
	const source = binding.snapshot.audioCapabilities;
	if (!source) return null;
	const wildcard = binding.routes.some((route) => route.upstream_operation === "*");
	const boundOperations = new Set(
		binding.routes.map((route) => route.upstream_operation)
	);
	const pricingByOperation: AudioEndpointCapabilities["pricing_by_operation"] = {};
	for (const operation of AUDIO_ENDPOINT_PRICING_OPERATIONS) {
		if (
			audioOperationMatchesKind(operation, kind)
			&& (wildcard || boundOperations.has(operation))
			&& source.pricing_by_operation[operation] !== undefined
		) {
			pricingByOperation[operation] = source.pricing_by_operation[operation];
		}
	}
	if (Object.keys(pricingByOperation).length === 0) return null;
	const speech = pricingByOperation["audio.speech"] !== undefined
		? source.speech_by_operation?.["audio.speech"]
		: undefined;
	return {
		v: 1,
		pricing_by_operation: pricingByOperation,
		...(speech === undefined
			? {}
			: { speech_by_operation: { "audio.speech": speech } }),
	};
}

function openRouterAudioPricing(
	value: AudioOperationPricing
): PublicEndpointPricing {
	const meter = value.meter;
	const pricing: PublicEndpointPricing = meter.kind === "tokens"
		? {
			prompt: meter.rates.input_text,
			completion: meter.rates.output_text,
			audio: meter.rates.input_audio,
			audio_output: meter.rates.output_audio,
			input_audio_cache: meter.rates.input_audio_cache,
		}
		: {
			prompt: meter.price,
			completion: "0",
		};
	if (value.request !== undefined) pricing.request = value.request;
	if (value.discount !== undefined) pricing.discount = value.discount;
	return pricing;
}

function audioEndpoint(
	m: ModelRow,
	binding: VerifiedPublicEndpointBinding,
	providerNameOverride?: string,
	performance?: PublicEndpointPerformance
): PublicModelEndpoint | null {
	const e = binding.endpoint;
	const kind = audioModelKind(m);
	if (
		!kind ||
		!validCapacity(e.context_length) ||
		!validCapacity(e.max_prompt_tokens) ||
		!validCapacity(e.max_completion_tokens) ||
		!ENDPOINT_TAG.test(e.tag) ||
		(e.quantization !== null && safe(e.quantization, 64) === null)
	) return null;
	const audioCapabilities = boundAudioCapabilities(binding, kind);
	if (!audioCapabilities) return null;
	const operationPricing = Object.values(audioCapabilities.pricing_by_operation)
		.filter((value): value is AudioOperationPricing => value !== undefined)
		.map(openRouterAudioPricing);
	const firstPricing = operationPricing[0];
	if (
		!firstPricing ||
		!operationPricing.every((pricing) => (
			JSON.stringify(pricing) === JSON.stringify(firstPricing)
		))
	) return null;
	const providerName = safe(providerNameOverride ?? binding.provider.name);
	const speech = audioEndpointSpeechRequestCapabilities(audioCapabilities);
	const params = binding.snapshot.supportedParameters;
	if (!providerName || params.length > 128) return null;
	const toolChoice = binding.snapshot.capabilities.tool_choice;
	return {
		name: `${providerName}: ${safe(m.display_name) ?? m.id}`,
		model_id: m.id,
		model_name: safe(m.display_name) ?? m.id,
		provider_name: providerName,
		tag: e.tag,
		context_length: binding.snapshot.contextLength ?? 0,
		max_prompt_tokens: binding.snapshot.maxPromptTokens,
		max_completion_tokens: binding.snapshot.maxCompletionTokens,
		quantization: e.quantization,
		supported_parameters: [...params].sort(),
		pricing: firstPricing,
		supports_implicit_caching:
			binding.snapshot.capabilities.implicit_caching === true,
		supports_tool_choice: {
			auto: toolChoice.auto === true,
			function: toolChoice.function === true,
			none: toolChoice.none === true,
			required: toolChoice.required === true,
		},
		supports_voice_cloning:
			binding.snapshot.capabilities.voice_cloning === true,
		supports_default_voice: speech?.supports_default_voice ?? null,
		reference_audio_media_types: [
			...(speech?.reference_audio_media_types ?? []),
		],
		reference_audio_default_media_type:
			speech?.reference_audio_default_media_type ?? null,
		audio_capabilities: audioCapabilities,
		status: 0,
		latency_last_30m: performance?.latencyLast30m ?? null,
		throughput_last_30m: performance?.throughputLast30m ?? null,
		uptime_last_5m: performance?.uptimeLast5m ?? null,
		uptime_last_30m: performance?.uptimeLast30m ?? null,
		uptime_last_1d: performance?.uptimeLast1d ?? null,
	};
}

function endpointForBinding(
	model: ModelRow,
	binding: VerifiedPublicEndpointBinding,
	providerNameOverride?: string,
	performance?: PublicEndpointPerformance
): PublicModelEndpoint | null {
	return audioModelKind(model)
		? audioEndpoint(model, binding, providerNameOverride, performance)
		: textEndpoint(
			model,
			binding.endpoint,
			binding.provider,
			providerNameOverride,
			performance
		);
}

/**
 * Serialize one verified binding using the same fail-closed rules as the public
 * endpoint detail document. Catalog routes use this to avoid publishing a model
 * or filter facet that has no endpoint which the detail API can truthfully show.
 */
export function serializePublishedPublicModelEndpoint(
	model: ModelRow,
	binding: VerifiedPublicEndpointBinding,
	publishedProvidersBySlug: ReadonlyMap<string, PublishedPublicProviderIdentity>,
	performance?: PublicEndpointPerformanceMap
): PublicModelEndpoint | null {
	if (binding.endpoint.model_id !== model.id) return null;
	const providerSlug = normalizedProviderSlug(binding.endpoint.provider_slug);
	const publishedProvider = providerSlug
		? publishedProvidersBySlug.get(providerSlug)
		: undefined;
	return publishedProvider
		? endpointForBinding(
			model,
			binding,
			publishedProvider.name,
			performance?.get(binding.endpoint.id)
		)
		: null;
}

/**
 * Build one sanitized detail document from already verified bindings. Public
 * catalog snapshots use this to avoid repeating exact-model and endpoint
 * repository reads for every model-detail request.
 */
export function serializePublishedPublicModelEndpointsDocument(
	model: ModelRow,
	bindings: readonly VerifiedPublicEndpointBinding[],
	publishedProvidersBySlug: ReadonlyMap<string, PublishedPublicProviderIdentity>,
	performance?: PublicEndpointPerformanceMap
): PublicModelEndpointsDocument | null {
	const endpoints = bindings
		.filter((binding) => binding.endpoint.model_id === model.id)
		.flatMap((binding) => {
			const endpoint = serializePublishedPublicModelEndpoint(
				model,
				binding,
				publishedProvidersBySlug,
				performance
			);
			return endpoint ? [endpoint] : [];
		})
		.sort((left, right) => left.tag.localeCompare(right.tag));
	return endpoints.length > 0 ? document(model, endpoints) : null;
}

function roundedMetric(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function publicPercentiles(
	values: readonly number[],
	higherIsBetter = false
): PublicEndpointPercentiles | null {
	if (values.length < PUBLIC_ENDPOINT_PERFORMANCE_MINIMUM_SAMPLE_SIZE) return null;
	const percentile = (requested: 'p50' | 'p75' | 'p90' | 'p99') => {
		const value = routePerformancePercentile(values, requested, higherIsBetter);
		return value == null ? null : roundedMetric(value);
	};
	const p50 = percentile('p50');
	const p75 = percentile('p75');
	const p90 = percentile('p90');
	const p99 = percentile('p99');
	return p50 == null || p75 == null || p90 == null || p99 == null
		? null
		: { p50, p75, p90, p99 };
}

/**
 * Load privacy-thresholded, successful-request performance for complete endpoint
 * route sets. The route and row caps are shared with runtime routing so a public
 * catalog request cannot turn into an unbounded telemetry scan.
 */
export async function loadPublicEndpointPerformance(
	r: Pick<PublicEndpointDiscoveryRepositories, 'requestLogs'>,
	bindings: readonly VerifiedPublicEndpointBinding[],
	now = new Date()
): Promise<PublicEndpointPerformanceMap> {
	const selected: VerifiedPublicEndpointBinding[] = [];
	const selectedRouteIds = new Set<string>();
	for (const binding of [...bindings].sort((left, right) => (
		stableStringCompare(left.endpoint.id, right.endpoint.id)
	))) {
		const newRouteIds = [...new Set(binding.routes.map((route) => route.id))]
			.filter((id) => !selectedRouteIds.has(id));
		if (
			selectedRouteIds.size + newRouteIds.length
			> ROUTE_PERFORMANCE_MAX_ROUTES_PER_QUERY
		) continue;
		selected.push(binding);
		for (const id of newRouteIds) selectedRouteIds.add(id);
	}
	if (selectedRouteIds.size === 0) return new Map();

	const since5mIso = new Date(now.getTime() - 5 * 60 * 1_000).toISOString();
	const since30mIso = new Date(now.getTime() - PUBLIC_ENDPOINT_PERFORMANCE_WINDOW_MS).toISOString();
	const since1dIso = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
	const [sampleResult, availabilityResult] = await Promise.allSettled([
		r.requestLogs.getRecentRoutePerformanceSamples({
			routeTargetIds: [...selectedRouteIds],
			sinceIso: since30mIso,
			maxSamplesPerRoute: ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
		}),
		r.requestLogs.getRouteAvailabilityAggregates({
			routeTargetIds: [...selectedRouteIds],
			since5mIso,
			since30mIso,
			since1dIso,
		}),
	]);
	if (sampleResult.status === 'rejected') {
		console.warn(JSON.stringify({
			message: 'endpoint performance samples unavailable',
			error_type: sampleResult.reason instanceof Error
				? sampleResult.reason.name
				: typeof sampleResult.reason,
		}));
	}
	if (availabilityResult.status === 'rejected') {
		console.warn(JSON.stringify({
			message: 'endpoint availability aggregates unavailable',
			error_type: availabilityResult.reason instanceof Error
				? availabilityResult.reason.name
				: typeof availabilityResult.reason,
		}));
	}
	const samples = sampleResult.status === 'fulfilled' ? sampleResult.value : [];
	const availabilityByRoute = new Map(
		(availabilityResult.status === 'fulfilled' ? availabilityResult.value : [])
			.map((aggregate) => [aggregate.route_target_id, aggregate]),
	);
	const byRoute = collectRoutePerformanceSeries({
		samples,
		allowedRouteTargetIds: selectedRouteIds,
		maxSamplesPerRoute: ROUTE_PERFORMANCE_MAX_SAMPLES_PER_ROUTE,
	});
	const result = new Map<string, PublicEndpointPerformance>();
	for (const binding of selected) {
		const metrics = binding.routes.flatMap((route) => {
			const metric = byRoute.get(route.id);
			return metric ? [metric] : [];
		});
		const latency = metrics.flatMap((metric) => metric.latencySeconds);
		const throughput = metrics.flatMap((metric) => metric.throughputTokensPerSecond);
		const availability = binding.routes.flatMap((route) => {
			const aggregate = availabilityByRoute.get(route.id);
			return aggregate ? [aggregate] : [];
		});
		const uptime = (
			availableKey: 'available_5m' | 'available_30m' | 'available_1d',
			totalKey: 'total_5m' | 'total_30m' | 'total_1d',
		): number | null => {
			const available = availability.reduce((sum, row) => sum + row[availableKey], 0);
			const total = availability.reduce((sum, row) => sum + row[totalKey], 0);
			return total < PUBLIC_ENDPOINT_UPTIME_MINIMUM_SAMPLE_SIZE
				? null
				: roundedMetric(available * 100 / total);
		};
		result.set(binding.endpoint.id, {
			latencyLast30m: publicPercentiles(latency),
			throughputLast30m: publicPercentiles(throughput, true),
			uptimeLast5m: uptime('available_5m', 'total_5m'),
			uptimeLast30m: uptime('available_30m', 'total_30m'),
			uptimeLast1d: uptime('available_1d', 'total_1d'),
		});
	}
	return result;
}
function archMeta(m: ModelRow, key: string): string | null {
	try {
		return safe(
			m.metadata
				? (JSON.parse(m.metadata) as Record<string, unknown>)[key]
				: null,
			120
		);
	} catch {
		return null;
	}
}
function document(
	m: ModelRow,
	endpoints: PublicModelEndpoint[]
): PublicModelEndpointsDocument {
	const i = parseModelModalitiesJson(m.input_modalities) ?? [],
		o = openRouterModelOutputModalities(m);
	return {
		id: m.id,
		name: safe(m.display_name) ?? m.id,
		description: safe(m.description, 4000) ?? "",
		created: created(m),
		architecture: {
			input_modalities: i,
			output_modalities: o,
			modality: i.length && o.length ? `${i.join("+")}->${o.join("+")}` : null,
			instruct_type: archMeta(m, "instruct_type"),
			tokenizer: archMeta(m, "tokenizer"),
		},
		endpoints,
	};
}
export async function getPublicModelEndpoints(
	r: PublicEndpointDiscoveryRepositories,
	p: ParsedModelEndpointPath,
	now = new Date(),
	options?: {
		bindings?: readonly VerifiedPublicEndpointBinding[];
		publishedProvidersBySlug?: ReadonlyMap<string, PublishedPublicProviderIdentity>;
	}
): Promise<PublicModelEndpointsDocument | null> {
	const m = await exactModel(r, p);
	if (!m) return null;
	const sourceBindings = options?.bindings
		? options.bindings.filter((binding) => binding.endpoint.model_id === m.id)
		: await bindings(r, m, now);
	const performance = await loadPublicEndpointPerformance(r, sourceBindings, now);
	if (options?.publishedProvidersBySlug) {
		return serializePublishedPublicModelEndpointsDocument(
			m,
			sourceBindings,
			options.publishedProvidersBySlug,
			performance
		);
	}
	const es = sourceBindings
		.flatMap((b) => {
			const e = endpointForBinding(
				m,
				b,
				undefined,
				performance.get(b.endpoint.id)
			);
			return e ? [e] : [];
		})
		.sort((a, b) => a.tag.localeCompare(b.tag));
	return es.length ? document(m, es) : null;
}

export async function listVerifiedZdrPublicEndpoints(
	r: PublicEndpointDiscoveryRepositories,
	now = new Date()
): Promise<PublicModelEndpoint[]> {
	const out: PublicModelEndpoint[] = [];
	const models = await r.modelRouting.listModelsWithActiveRoutes(),
		modelMap = new Map(models.map((m) => [m.id, m]));
	const bs = (await listVerifiedPublicEndpointBindings(r, models, now)).filter(
		(b) => !b.provider.shared_channel_type
	);
	const ids = [...new Set(bs.flatMap((b) => b.routes.map((x) => x.id)))];
	const ps: RouteDataPolicyRow[] = [];
	for (let i = 0; i < ids.length; i += POLICY_BATCH)
		ps.push(
			...(await r.routeDataPolicies.getByRouteTargetIds(
				ids.slice(i, i + POLICY_BATCH)
			))
		);
	const pm = new Map(ps.map((p) => [p.route_target_id, p]));
	const approved: Array<{
		binding: VerifiedPublicEndpointBinding;
		model: ModelRow;
	}> = [];
	for (const b of bs) {
		const m = modelMap.get(b.endpoint.model_id);
		if (!m) continue;
		// One published endpoint can aggregate several callable route targets. It
		// is safe to advertise the aggregate as ZDR only when every target that
		// could serve it has a current, subject-bound ZDR assertion.
		let ok = b.routes.length > 0;
		for (const route of b.routes) {
			const policy = pm.get(route.id);
			if (!policy) {
				ok = false;
				break;
			}
			try {
				const fp = await computeRouteDataPolicySubjectFingerprintFromRows(
					route,
					b.provider
				);
				if (!routeDataPolicyAllowsZdr(policy, fp, now)) {
					ok = false;
					break;
				}
			} catch {
				ok = false;
				break;
			}
		}
		if (ok) approved.push({ binding: b, model: m });
	}
	const performance = await loadPublicEndpointPerformance(
		r,
		approved.map(({ binding }) => binding),
		now
	);
	for (const { binding, model } of approved) {
		const e = endpointForBinding(
			model,
			binding,
			undefined,
			performance.get(binding.endpoint.id)
		);
		if (e) out.push(e);
	}
	return out.sort(
		(a, b) => a.model_id.localeCompare(b.model_id) || a.tag.localeCompare(b.tag)
	);
}

function imageCaps(e: ModelEndpointRow): ImageEndpointCapabilities | null {
	try {
		const raw = json(e.image_capabilities);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const o = raw as Record<string, unknown>;
		if (o.provider_slug !== e.provider_slug) return null;
		return normalizeImageEndpointCapabilities(o);
	} catch {
		return null;
	}
}
function imageEndpoint(
	e: ModelEndpointRow,
	p: ProviderRow
): PublicImageEndpoint | null {
	const c = imageCaps(e),
		pn = safe(p.name);
	if (!c || c.supports_streaming == null || !pn) return null;
	try {
		return {
			provider_name: pn,
			provider_slug: c.provider_slug,
			provider_tag: c.provider_tag,
			supported_parameters: c.supported_parameters,
			allowed_passthrough_parameters: c.allowed_passthrough_parameters,
			pricing: c.pricing.map(serializeImagePricingLine),
			supports_streaming: c.supports_streaming,
		};
	} catch {
		return null;
	}
}
function isImage(m: ModelRow): boolean {
	return (parseModelModalitiesJson(m.output_modalities) ?? []).includes(
		"image"
	);
}
function canonicalPublicModelId(m: ModelRow): string | null {
	const slash = m.id.indexOf("/");
	if (slash > 0 && m.id.indexOf("/", slash + 1) < 0)
		return (
			parseModelEndpointPath(m.id.slice(0, slash), m.id.slice(slash + 1))
				?.canonicalModelId ?? null
		);
	const vendor = safe(m.vendor, 64)?.toLowerCase();
	return vendor
		? parseModelEndpointPath(vendor, m.id)?.canonicalModelId ?? null
		: null;
}
export async function getPublicImageModelEndpoints(
	r: PublicEndpointDiscoveryRepositories,
	p: ParsedModelEndpointPath,
	now = new Date()
): Promise<PublicImageModelEndpointsDocument | null> {
	const m = await exactModel(r, p);
	if (!m || !isImage(m)) return null;
	const es = (await bindings(r, m, now)).flatMap((b) => {
		const e = imageEndpoint(b.endpoint, b.provider);
		return e ? [e] : [];
	});
	const id = canonicalPublicModelId(m);
	return es.length && id ? { id, endpoints: es } : null;
}
function same(
	a: ImageCapabilityDescriptor,
	b: ImageCapabilityDescriptor
): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
export async function listPublicImageModels(
	r: PublicEndpointDiscoveryRepositories,
	now = new Date()
): Promise<PublicImageModel[]> {
	const out: PublicImageModel[] = [];
	const models = (await r.modelRouting.listModelsWithActiveRoutes()).filter(
			isImage
		),
		modelMap = new Map(models.map((m) => [m.id, m])),
		grouped = new Map<string, PublicImageEndpoint[]>();
	for (const b of await listVerifiedPublicEndpointBindings(r, models, now)) {
		const e = imageEndpoint(b.endpoint, b.provider);
		if (e) {
			const list = grouped.get(b.endpoint.model_id) ?? [];
			list.push(e);
			grouped.set(b.endpoint.model_id, list);
		}
	}
	for (const [id, es] of grouped) {
		const m = modelMap.get(id),
			canonical = m ? canonicalPublicModelId(m) : null;
		if (!m || !canonical) continue;
		const union = new Map<string, ImageCapabilityDescriptor | null>();
		for (const e of es)
			for (const [k, d] of Object.entries(e.supported_parameters)) {
				const old = union.get(k);
				if (old === undefined) union.set(k, d);
				else if (old && !same(old, d)) union.set(k, null);
			}
		out.push({
			id: canonical,
			name: safe(m.display_name) ?? m.id,
			description: safe(m.description, 4000) ?? "",
			created: created(m),
			endpoints: `/api/v1/images/models/${canonical}/endpoints`,
			architecture: {
				input_modalities: parseModelModalitiesJson(m.input_modalities) ?? [],
				output_modalities: parseModelModalitiesJson(m.output_modalities) ?? [],
			},
			supported_parameters: Object.fromEntries(
				[...union].filter(
					(x): x is [string, ImageCapabilityDescriptor] => x[1] != null
				)
			),
			supports_streaming: es.some((e) => e.supports_streaming),
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}
