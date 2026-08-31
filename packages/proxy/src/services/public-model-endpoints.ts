import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	modelEndpointSubjectFingerprintIsValid,
	normalizeUpstreamProtocol,
	parseVerifiedModelEndpointSnapshot,
	parseModelModalitiesJson,
	parseProviderEndpoints,
	protocolHasEndpointsConfig,
	routeDataPolicyAllowsZdr,
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
	isPublicEndpointCapabilityReady,
	normalizeEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	serializeImagePricingLine,
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
};
type ToolChoice = {
	auto: boolean;
	function: boolean;
	none: boolean;
	required: boolean;
};
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
	pricing: Omit<ReturnType<typeof normalizeTextEndpointPricing>, "currency">;
	supports_implicit_caching: boolean;
	supports_tool_choice: ToolChoice;
	supports_voice_cloning: boolean;
	/** OpenRouter uses `0` for an endpoint that is currently available. */
	status: 0;
	latency_last_30m: null;
	throughput_last_30m: null;
	uptime_last_5m: null;
	uptime_last_30m: null;
	uptime_last_1d: null;
};
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
	providerNameOverride?: string
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
			status: 0,
			latency_last_30m: null,
			throughput_last_30m: null,
			uptime_last_5m: null,
			uptime_last_30m: null,
			uptime_last_1d: null,
		};
	} catch {
		return null;
	}
}

/**
 * Serialize one verified binding using the same fail-closed rules as the public
 * endpoint detail document. Catalog routes use this to avoid publishing a model
 * or filter facet that has no endpoint which the detail API can truthfully show.
 */
export function serializePublishedPublicModelEndpoint(
	model: ModelRow,
	binding: VerifiedPublicEndpointBinding,
	publishedProvidersBySlug: ReadonlyMap<string, PublishedPublicProviderIdentity>
): PublicModelEndpoint | null {
	if (binding.endpoint.model_id !== model.id) return null;
	const providerSlug = normalizedProviderSlug(binding.endpoint.provider_slug);
	const publishedProvider = providerSlug
		? publishedProvidersBySlug.get(providerSlug)
		: undefined;
	return publishedProvider
		? textEndpoint(
			model,
			binding.endpoint,
			binding.provider,
			publishedProvider.name
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
	publishedProvidersBySlug: ReadonlyMap<string, PublishedPublicProviderIdentity>
): PublicModelEndpointsDocument | null {
	const endpoints = bindings
		.filter((binding) => binding.endpoint.model_id === model.id)
		.flatMap((binding) => {
			const endpoint = serializePublishedPublicModelEndpoint(
				model,
				binding,
				publishedProvidersBySlug
			);
			return endpoint ? [endpoint] : [];
		})
		.sort((left, right) => left.tag.localeCompare(right.tag));
	return endpoints.length > 0 ? document(model, endpoints) : null;
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
		o = parseModelModalitiesJson(m.output_modalities) ?? [];
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
	if (options?.publishedProvidersBySlug) {
		return serializePublishedPublicModelEndpointsDocument(
			m,
			sourceBindings,
			options.publishedProvidersBySlug
		);
	}
	const es = sourceBindings
		.flatMap((b) => {
			const e = textEndpoint(m, b.endpoint, b.provider);
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
		if (ok) {
			const e = textEndpoint(m, b.endpoint, b.provider);
			if (e) out.push(e);
		}
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
