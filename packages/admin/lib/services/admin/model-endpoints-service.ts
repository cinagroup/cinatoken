/**
 * Admin lifecycle for endpoint-first public catalog records.
 *
 * Drafts may be incomplete. A record can enter `verified` only when every
 * public claim is backed by strict, endpoint-level evidence. Route links are
 * validated against both the endpoint model and provider before persistence.
 */
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	isPendingProviderImportApiKey,
	MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT,
	modelEndpointSupportsOperation,
	modelEndpointTagIsValidForProvider,
	normalizeUpstreamProtocol,
	providerSupportsUpstreamOperation,
	ROUTE_QUANTIZATIONS,
	verifiedEndpointMatchesLegacyRoutingMetadata,
	type GatewayRepositories,
	type ModelEndpointLegacyRoutingFacts,
	type ModelEndpointOperationFacts,
	type ModelEndpointRow,
	type ModelEndpointRouteLinkRow,
	type ModelEndpointStatus,
	type RouteEndpointClass,
	type RouteQuantization,
} from "@octafuse/core";
import {
	audioEndpointReferenceEvidenceMatchesVoiceCloning,
	isAudioEndpointReady,
	normalizeAudioEndpointCapabilities,
	normalizeEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	type AudioEndpointCapabilities,
	type EndpointToolChoiceSupport,
	type ImageEndpointCapabilities,
	type TextEndpointPricing,
} from "@octafuse/core/model-endpoint-catalog";
import { badRequest, conflict, notFound } from "./errors";

const ENDPOINT_ID_MAX_LENGTH = 191;
const FOREIGN_ID_MAX_LENGTH = 512;
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REGION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PARAMETER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const MAX_VERIFIED_ROUTE_LINKS = 100;
const MAX_SQL_INTEGER = 2_147_483_647;
const TOOL_CHOICE_UNKNOWN: EndpointToolChoiceSupport = {
	auto: null,
	function: null,
	none: null,
	required: null,
};
const ENDPOINT_STATUSES = new Set<ModelEndpointStatus>([
	"draft",
	"verified",
	"disabled",
]);
const ENDPOINT_CLASSES = new Set(["standard", "service_tier"]);
const QUANTIZATIONS = new Set<string>(ROUTE_QUANTIZATIONS);

export type AdminModelEndpointMutationInput = {
	model_id?: unknown;
	provider_id?: unknown;
	provider_slug?: unknown;
	tag?: unknown;
	endpoint_class?: unknown;
	region?: unknown;
	context_length?: unknown;
	max_prompt_tokens?: unknown;
	max_completion_tokens?: unknown;
	quantization?: unknown;
	supported_parameters?: unknown;
	pricing?: unknown;
	supports_implicit_caching?: unknown;
	supports_voice_cloning?: unknown;
	supports_tool_choice?: unknown;
	image_capabilities?: unknown;
	audio_capabilities?: unknown;
	evidence_url?: unknown;
	expires_at?: unknown;
	status?: unknown;
};

export type AdminModelEndpointRow = Omit<
	ModelEndpointRow,
	| "supported_parameters"
	| "pricing"
	| "supports_implicit_caching"
	| "supports_voice_cloning"
	| "supports_tool_choice"
	| "image_capabilities"
	| "audio_capabilities"
> & {
	supported_parameters: string[];
	pricing: TextEndpointPricing | null;
	supports_implicit_caching: boolean | null;
	supports_voice_cloning: boolean | null;
	supports_tool_choice: EndpointToolChoiceSupport;
	image_capabilities: ImageEndpointCapabilities | null;
	audio_capabilities: AudioEndpointCapabilities | null;
	route_target_ids: string[];
};

export type AdminModelEndpointWriteResult = {
	id: string;
	status: ModelEndpointStatus;
	audio_capabilities: AudioEndpointCapabilities | null;
};

type CanonicalEndpoint = {
	modelId: string;
	providerId: string;
	providerSlug: string;
	tag: string;
	endpointClass: RouteEndpointClass | null;
	region: string | null;
	contextLength: number | null;
	maxPromptTokens: number | null;
	maxCompletionTokens: number | null;
	quantization: RouteQuantization | null;
	supportedParameters: string[];
	pricing: TextEndpointPricing | null;
	supportsImplicitCaching: boolean | null;
	supportsVoiceCloning: boolean | null;
	supportsToolChoice: EndpointToolChoiceSupport;
	imageCapabilities: ImageEndpointCapabilities | null;
	audioCapabilities: AudioEndpointCapabilities | null;
	evidenceUrl: string | null;
	expiresAt: string | null;
	status: ModelEndpointStatus;
};

const MATERIAL_MUTATION_KEYS = new Set<keyof AdminModelEndpointMutationInput>([
	"provider_slug",
	"tag",
	"endpoint_class",
	"region",
	"context_length",
	"max_prompt_tokens",
	"max_completion_tokens",
	"quantization",
	"supported_parameters",
	"pricing",
	"supports_implicit_caching",
	"supports_voice_cloning",
	"supports_tool_choice",
	"image_capabilities",
	"audio_capabilities",
	"evidence_url",
	"expires_at",
]);
const MUTATION_KEYS = new Set<keyof AdminModelEndpointMutationInput>([
	"model_id",
	"provider_id",
	...MATERIAL_MUTATION_KEYS,
	"status",
]);

function assertMutationKeys(input: AdminModelEndpointMutationInput): void {
	for (const key of Object.keys(input)) {
		if (!MUTATION_KEYS.has(key as keyof AdminModelEndpointMutationInput)) {
			throw badRequest(`Unsupported endpoint field: ${key}`);
		}
	}
}

function requiredId(
	value: unknown,
	label: string,
	maxLength = FOREIGN_ID_MAX_LENGTH
): string {
	if (typeof value !== "string") throw badRequest(`${label} is required`);
	const id = value.trim();
	if (!id || id.length > maxLength || /[\u0000-\u001f\u007f]/u.test(id)) {
		throw badRequest(`${label} is invalid`);
	}
	return id;
}

function nullableString(
	value: unknown,
	label: string,
	maxLength: number
): string | null {
	if (value == null || value === "") return null;
	if (typeof value !== "string")
		throw badRequest(`${label} must be a string or null`);
	const normalized = value.trim();
	if (!normalized) return null;
	if (
		normalized.length > maxLength ||
		/[\u0000-\u001f\u007f]/u.test(normalized)
	) {
		throw badRequest(`${label} is invalid`);
	}
	return normalized;
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
	if (value == null || value === "") return null;
	const number = typeof value === "number" ? value : Number(value);
	if (
		!Number.isSafeInteger(number) ||
		number <= 0 ||
		number > MAX_SQL_INTEGER
	) {
		throw badRequest(
			`${label} must be a positive integer no greater than ${MAX_SQL_INTEGER}`
		);
	}
	return number;
}

function parseJsonValue(value: unknown, label: string): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw badRequest(`${label} must be valid JSON`);
	}
}

function normalizeSupportedParameters(value: unknown): string[] {
	const parsed = parseJsonValue(value, "supported_parameters");
	if (
		!Array.isArray(parsed) ||
		parsed.length > MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT
	) {
		throw badRequest(
			`supported_parameters must be an array of at most ${MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT} names`
		);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of parsed) {
		if (typeof item !== "string" || !PARAMETER.test(item.trim())) {
			throw badRequest("supported_parameters contains an invalid name");
		}
		const parameter = item.trim();
		const identity = parameter.toLowerCase();
		if (seen.has(identity))
			throw badRequest(
				`supported_parameters contains a duplicate: ${parameter}`
			);
		seen.add(identity);
		result.push(parameter);
	}
	return result;
}

function normalizeStatus(value: unknown): ModelEndpointStatus {
	const status = String(value ?? "draft")
		.trim()
		.toLowerCase() as ModelEndpointStatus;
	if (!ENDPOINT_STATUSES.has(status))
		throw badRequest("status must be draft, verified, or disabled");
	return status;
}

function normalizeEndpointClass(
	value: unknown,
	tag: string
): RouteEndpointClass | null {
	const endpointClass =
		nullableString(value, "endpoint_class", 32)?.toLowerCase() ?? null;
	if (endpointClass && !ENDPOINT_CLASSES.has(endpointClass)) {
		throw badRequest("endpoint_class must be standard, service_tier, or null");
	}
	if (endpointClass === "service_tier" && !tag.includes("/")) {
		throw badRequest("service_tier endpoints require a slash-qualified tag");
	}
	if (tag.includes("/") && !endpointClass) {
		throw badRequest("slash-qualified tags require endpoint_class");
	}
	return endpointClass as RouteEndpointClass | null;
}

function normalizeEvidenceUrl(value: unknown): string | null {
	const raw = nullableString(value, "evidence_url", 2048);
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw badRequest("evidence_url must be an absolute HTTPS URL");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw badRequest(
			"evidence_url must be an HTTPS URL without embedded credentials"
		);
	}
	return url.toString();
}

function normalizeExpiresAt(value: unknown): string | null {
	const raw = nullableString(value, "expires_at", 64);
	if (!raw) return null;
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp))
		throw badRequest("expires_at must be a valid ISO timestamp");
	return new Date(timestamp).toISOString();
}

function normalizeBooleanEvidence(
	value: unknown,
	label: string
): boolean | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "boolean")
		throw badRequest(`${label} must be true, false, or null`);
	return value;
}

function normalizePricing(value: unknown): TextEndpointPricing | null {
	if (value == null || value === "") return null;
	const parsed = parseJsonValue(value, "pricing");
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.keys(parsed).length === 0
	) {
		return null;
	}
	try {
		return normalizeTextEndpointPricing(parsed);
	} catch (error) {
		throw badRequest(
			error instanceof Error ? error.message : "Invalid pricing"
		);
	}
}

function normalizeToolChoice(value: unknown): EndpointToolChoiceSupport {
	if (value == null || value === "") return { ...TOOL_CHOICE_UNKNOWN };
	const parsed = parseJsonValue(value, "supports_tool_choice");
	try {
		return normalizeEndpointCapabilities({
			implicit_caching: null,
			voice_cloning: null,
			tool_choice: parsed,
		}).tool_choice;
	} catch (error) {
		throw badRequest(
			error instanceof Error ? error.message : "Invalid supports_tool_choice"
		);
	}
}

function normalizeImageCapabilities(
	value: unknown
): ImageEndpointCapabilities | null {
	if (value == null || value === "") return null;
	const parsed = parseJsonValue(value, "image_capabilities");
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.keys(parsed).length === 0
	) {
		return null;
	}
	try {
		return normalizeImageEndpointCapabilities(parsed);
	} catch (error) {
		throw badRequest(
			error instanceof Error ? error.message : "Invalid image_capabilities"
		);
	}
}

function normalizeAudioCapabilities(
	value: unknown
): AudioEndpointCapabilities | null {
	if (value == null || value === "") return null;
	const parsed = parseJsonValue(value, "audio_capabilities");
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.keys(parsed).length === 0
	) {
		return null;
	}
	try {
		return normalizeAudioEndpointCapabilities(parsed);
	} catch (error) {
		throw badRequest(
			error instanceof Error ? error.message : "Invalid audio_capabilities"
		);
	}
}

function canonicalize(
	input: AdminModelEndpointMutationInput
): CanonicalEndpoint {
	assertMutationKeys(input);
	const modelId = requiredId(input.model_id, "model_id");
	const providerId = requiredId(input.provider_id, "provider_id");
	const providerSlug = requiredId(
		input.provider_slug,
		"provider_slug",
		128
	).toLowerCase();
	if (!PROVIDER_SLUG.test(providerSlug))
		throw badRequest("provider_slug is invalid");
	const tag = requiredId(input.tag, "tag", 120).toLowerCase();
	if (!modelEndpointTagIsValidForProvider(tag, providerSlug)) {
		throw badRequest("tag is invalid or does not belong to provider_slug");
	}
	const endpointClass = normalizeEndpointClass(input.endpoint_class, tag);
	const region =
		nullableString(input.region, "region", 64)?.toLowerCase() ?? null;
	if (region && !REGION.test(region)) throw badRequest("region is invalid");
	const quantization = (nullableString(
		input.quantization,
		"quantization",
		32
	)?.toLowerCase() ?? null) as RouteQuantization | null;
	if (quantization && !QUANTIZATIONS.has(quantization))
		throw badRequest("quantization is invalid");
	const supportsImplicitCaching = normalizeBooleanEvidence(
		input.supports_implicit_caching,
		"supports_implicit_caching"
	);
	const supportsVoiceCloning = normalizeBooleanEvidence(
		input.supports_voice_cloning,
		"supports_voice_cloning"
	);
	const supportsToolChoice = normalizeToolChoice(input.supports_tool_choice);
	const capabilities = normalizeEndpointCapabilities({
		implicit_caching: supportsImplicitCaching,
		voice_cloning: supportsVoiceCloning,
		tool_choice: supportsToolChoice,
	});
	const imageCapabilities = normalizeImageCapabilities(
		input.image_capabilities
	);
	const audioCapabilities = normalizeAudioCapabilities(
		input.audio_capabilities
	);
	if (
		audioCapabilities &&
		!audioEndpointReferenceEvidenceMatchesVoiceCloning(
			audioCapabilities,
			supportsVoiceCloning
		)
	) {
		throw badRequest(
			"audio.speech reference-audio evidence requires supports_voice_cloning=true"
		);
	}
	if (imageCapabilities && imageCapabilities.provider_slug !== providerSlug) {
		throw badRequest(
			"image_capabilities.provider_slug must match provider_slug"
		);
	}

	return {
		modelId,
		providerId,
		providerSlug,
		tag,
		endpointClass,
		region,
		contextLength: nullablePositiveInteger(
			input.context_length,
			"context_length"
		),
		maxPromptTokens: nullablePositiveInteger(
			input.max_prompt_tokens,
			"max_prompt_tokens"
		),
		maxCompletionTokens: nullablePositiveInteger(
			input.max_completion_tokens,
			"max_completion_tokens"
		),
		quantization,
		supportedParameters: normalizeSupportedParameters(
			input.supported_parameters ?? []
		),
		pricing: normalizePricing(input.pricing),
		supportsImplicitCaching: capabilities.implicit_caching,
		supportsVoiceCloning: capabilities.voice_cloning,
		supportsToolChoice: capabilities.tool_choice,
		imageCapabilities,
		audioCapabilities,
		evidenceUrl: normalizeEvidenceUrl(input.evidence_url),
		expiresAt: normalizeExpiresAt(input.expires_at),
		status: normalizeStatus(input.status),
	};
}

function operationFacts(
	endpoint: CanonicalEndpoint
): ModelEndpointOperationFacts {
	return {
		contextLength: endpoint.contextLength,
		pricing: endpoint.pricing,
		capabilities: {
			implicit_caching: endpoint.supportsImplicitCaching,
			voice_cloning: endpoint.supportsVoiceCloning,
			tool_choice: endpoint.supportsToolChoice,
		},
		imageCapabilities: endpoint.imageCapabilities,
		audioCapabilities: endpoint.audioCapabilities,
	};
}

function legacyRoutingFacts(
	endpoint: CanonicalEndpoint
): ModelEndpointLegacyRoutingFacts {
	return {
		selectorSlug:
			endpoint.tag === endpoint.providerSlug || endpoint.tag.includes("/")
				? endpoint.tag
				: `${endpoint.providerSlug}/${endpoint.tag}`,
		endpointClass: endpoint.endpointClass,
		region: endpoint.region,
		contextLength: endpoint.contextLength,
		maxPromptTokens: endpoint.maxPromptTokens,
		maxCompletionTokens: endpoint.maxCompletionTokens,
		quantization: endpoint.quantization,
		supportedParameters: endpoint.supportedParameters,
	};
}

function assertPublishable(endpoint: CanonicalEndpoint, now: Date): void {
	if (!endpoint.evidenceUrl)
		throw badRequest("verified endpoints require evidence_url");
	if (!endpoint.expiresAt || Date.parse(endpoint.expiresAt) <= now.getTime()) {
		throw badRequest("verified endpoints require a future expires_at");
	}
	const facts = operationFacts(endpoint);
	const textReady = modelEndpointSupportsOperation(facts, "chat");
	const imageReady = modelEndpointSupportsOperation(
		facts,
		"images.generations"
	);
	const audioReady =
		endpoint.audioCapabilities !== null &&
		isAudioEndpointReady(endpoint.audioCapabilities);
	if (!textReady && !imageReady && !audioReady) {
		throw badRequest(
			"verified endpoints require complete text pricing/capabilities, definitive image capabilities, or exact audio operation pricing"
		);
	}
}

function rawEndpointInput(
	row: ModelEndpointRow
): AdminModelEndpointMutationInput {
	return {
		model_id: row.model_id,
		provider_id: row.provider_id,
		provider_slug: row.provider_slug,
		tag: row.tag,
		endpoint_class: row.endpoint_class,
		region: row.region,
		context_length: row.context_length,
		max_prompt_tokens: row.max_prompt_tokens,
		max_completion_tokens: row.max_completion_tokens,
		quantization: row.quantization,
		supported_parameters: row.supported_parameters,
		pricing: row.pricing,
		supports_implicit_caching:
			row.supports_implicit_caching == null
				? null
				: Boolean(row.supports_implicit_caching),
		supports_voice_cloning:
			row.supports_voice_cloning == null
				? null
				: Boolean(row.supports_voice_cloning),
		supports_tool_choice: row.supports_tool_choice,
		image_capabilities: row.image_capabilities,
		audio_capabilities: row.audio_capabilities ?? "{}",
		evidence_url: row.evidence_url,
		expires_at: row.expires_at,
		status: row.status,
	};
}

function serializeEndpoint(endpoint: CanonicalEndpoint) {
	return {
		model_id: endpoint.modelId,
		provider_id: endpoint.providerId,
		provider_slug: endpoint.providerSlug,
		tag: endpoint.tag,
		endpoint_class: endpoint.endpointClass,
		region: endpoint.region,
		context_length: endpoint.contextLength,
		max_prompt_tokens: endpoint.maxPromptTokens,
		max_completion_tokens: endpoint.maxCompletionTokens,
		quantization: endpoint.quantization,
		supported_parameters: JSON.stringify(endpoint.supportedParameters),
		pricing: JSON.stringify(endpoint.pricing ?? {}),
		supports_implicit_caching: endpoint.supportsImplicitCaching,
		supports_voice_cloning: endpoint.supportsVoiceCloning,
		supports_tool_choice: JSON.stringify(endpoint.supportsToolChoice),
		image_capabilities: JSON.stringify(endpoint.imageCapabilities ?? {}),
		audio_capabilities: JSON.stringify(endpoint.audioCapabilities ?? {}),
		evidence_url: endpoint.evidenceUrl,
		expires_at: endpoint.expiresAt,
		status: endpoint.status,
	};
}

async function assertModelAndProviderExist(
	repos: GatewayRepositories,
	modelId: string,
	providerId: string
): Promise<void> {
	const [model, provider] = await Promise.all([
		repos.modelRouting.getModelById(modelId),
		repos.providers.getProviderById(providerId),
	]);
	if (!model || model.id !== modelId) throw badRequest("Model not found");
	if (!provider || provider.id !== providerId)
		throw badRequest("Provider not found");
}

type VerifiedRouteSubject = {
	link: ModelEndpointRouteLinkRow;
	subjectFingerprint: string;
};

/**
 * Resolve and validate the complete verification subject before publishing.
 * No endpoint or link write may occur until this function has succeeded for
 * every linked route.
 */
async function prepareVerifiedRouteSubjects(
	repos: GatewayRepositories,
	endpoint: {
		id: string;
		modelId: string;
		providerId: string;
		operationFacts: ModelEndpointOperationFacts;
		legacyRoutingFacts: ModelEndpointLegacyRoutingFacts;
	}
): Promise<VerifiedRouteSubject[]> {
	const [links, provider] = await Promise.all([
		repos.modelEndpoints.listRouteLinks([endpoint.id]),
		repos.providers.getProviderById(endpoint.providerId),
	]);
	if (links.length < 1 || links.length > MAX_VERIFIED_ROUTE_LINKS) {
		throw badRequest(
			`verified endpoints require between 1 and ${MAX_VERIFIED_ROUTE_LINKS} route links`
		);
	}
	if (!provider || provider.id !== endpoint.providerId) {
		throw badRequest("Provider not found");
	}
	if (provider.status !== "active") {
		throw badRequest("verified endpoints require an active provider");
	}
	if (provider.shared_channel_type?.trim()) {
		throw badRequest("verified endpoints cannot use shared-channel providers");
	}
	if (!provider.api_key?.trim() || isPendingProviderImportApiKey(provider.api_key)) {
		throw badRequest("verified endpoints require a provider credential");
	}

	const orderedLinks = [...links].sort((left, right) =>
		left.route_target_id.localeCompare(right.route_target_id)
	);
	const routes = await Promise.all(
		orderedLinks.map((link) =>
			repos.routes.getModelRouteRowById(link.route_target_id)
		)
	);
	for (let index = 0; index < orderedLinks.length; index += 1) {
		const link = orderedLinks[index];
		const route = routes[index];
		if (!link || !route) {
			throw badRequest(
				`Linked route not found: ${link?.route_target_id ?? "unknown"}`
			);
		}
		if (route.status !== "active") {
			throw badRequest(`Linked route must be active: ${route.id}`);
		}
		if (
			route.model_id !== endpoint.modelId ||
			route.provider_id !== endpoint.providerId
		) {
			throw badRequest(
				`Linked route model/provider must match the endpoint: ${route.id}`
			);
		}
		if (
			!verifiedEndpointMatchesLegacyRoutingMetadata(
				endpoint.legacyRoutingFacts,
				route.routing_metadata
			)
		) {
			throw badRequest(
				`Linked route routing_metadata drifts from candidate endpoint facts: ${route.id}`
			);
		}
		let protocol;
		try {
			protocol = normalizeUpstreamProtocol(route.upstream_protocol);
		} catch {
			throw badRequest(
				`Linked route has an invalid upstream protocol: ${route.id}`
			);
		}
		const upstreamOperation = route.upstream_operation ?? "*";
		if (
			!providerSupportsUpstreamOperation(protocol, upstreamOperation, provider)
		) {
			throw badRequest(
				`Provider has no callable endpoint for linked route operation "${upstreamOperation}" on protocol "${protocol}": ${route.id}`
			);
		}
		if (
			!modelEndpointSupportsOperation(
				endpoint.operationFacts,
				route.upstream_operation
			)
		) {
			throw badRequest(
				`Endpoint facts do not support linked route operation "${
					route.upstream_operation ?? "*"
				}": ${route.id}`
			);
		}
	}

	const subjectFingerprints = await Promise.all(
		routes.map((route) =>
			computeRouteDataPolicySubjectFingerprintFromRows(route!, provider)
		)
	);
	return orderedLinks.map((link, index) => ({
		link,
		subjectFingerprint: subjectFingerprints[index]!,
	}));
}

function safeAdminRow(
	row: ModelEndpointRow,
	routeTargetIds: string[]
): AdminModelEndpointRow {
	let canonical: CanonicalEndpoint | null = null;
	try {
		canonical = canonicalize(rawEndpointInput(row));
	} catch {
		// Historical drafts remain editable but invalid public claims are never
		// converted into seemingly-valid values in the admin response.
	}
	return {
		...row,
		supported_parameters: canonical?.supportedParameters ?? [],
		pricing: canonical?.pricing ?? null,
		supports_implicit_caching: canonical?.supportsImplicitCaching ?? null,
		supports_voice_cloning: canonical?.supportsVoiceCloning ?? null,
		supports_tool_choice: canonical?.supportsToolChoice ?? {
			...TOOL_CHOICE_UNKNOWN,
		},
		image_capabilities: canonical?.imageCapabilities ?? null,
		audio_capabilities: canonical?.audioCapabilities ?? null,
		route_target_ids: [...routeTargetIds].sort(),
	};
}

export async function listModelEndpointsService(
	repos: GatewayRepositories,
	filters: { model_id?: string; provider_id?: string; status?: string }
): Promise<AdminModelEndpointRow[]> {
	const status =
		filters.status == null || filters.status === ""
			? undefined
			: normalizeStatus(filters.status);
	const modelId = filters.model_id?.trim()
		? requiredId(filters.model_id, "model_id")
		: undefined;
	const providerId = filters.provider_id?.trim()
		? requiredId(filters.provider_id, "provider_id")
		: undefined;
	const rows: ModelEndpointRow[] = [];
	const links: ModelEndpointRouteLinkRow[] = [];
	const pageSize = 100;
	const safetyLimit = 1_000;
	for (let offset = 0; offset < safetyLimit; offset += pageSize) {
		const page = await repos.modelEndpoints.list({
			modelId,
			providerId,
			status,
			limit: pageSize,
			offset,
		});
		rows.push(...page);
		links.push(
			...(await repos.modelEndpoints.listRouteLinks(page.map((row) => row.id)))
		);
		if (page.length < pageSize) break;
		if (offset + pageSize === safetyLimit) {
			const overflow = await repos.modelEndpoints.list({
				modelId,
				providerId,
				status,
				limit: 1,
				offset: safetyLimit,
			});
			if (overflow.length > 0)
				throw new RangeError(
					`Endpoint list exceeds safety limit ${safetyLimit}`
				);
		}
	}
	const routeIdsByEndpoint = new Map<string, string[]>();
	for (const link of links) {
		const current = routeIdsByEndpoint.get(link.endpoint_id);
		if (current) current.push(link.route_target_id);
		else routeIdsByEndpoint.set(link.endpoint_id, [link.route_target_id]);
	}
	return rows.map((row) =>
		safeAdminRow(row, routeIdsByEndpoint.get(row.id) ?? [])
	);
}

export async function getModelEndpointService(
	repos: GatewayRepositories,
	id: string
): Promise<AdminModelEndpointRow> {
	const endpointId = requiredId(id, "endpoint id", ENDPOINT_ID_MAX_LENGTH);
	const row = await repos.modelEndpoints.getById(endpointId);
	if (!row) throw notFound("Endpoint not found");
	const links = await repos.modelEndpoints.listRouteLinks([endpointId]);
	return safeAdminRow(
		row,
		links.map((link) => link.route_target_id)
	);
}

export async function createModelEndpointService(
	repos: GatewayRepositories,
	input: AdminModelEndpointMutationInput,
	_actorId: string,
	now = new Date()
): Promise<AdminModelEndpointWriteResult> {
	const endpoint = canonicalize(input);
	if (endpoint.status === "verified") {
		throw badRequest(
			"Endpoint creation cannot publish directly; create a draft, link routes, then explicitly verify it"
		);
	}
	await assertModelAndProviderExist(
		repos,
		endpoint.modelId,
		endpoint.providerId
	);
	const id = crypto.randomUUID();
	const timestamps = now.toISOString();
	const serialized = serializeEndpoint(endpoint);
	try {
		await repos.modelEndpoints.insert({
			id,
			modelId: serialized.model_id,
			providerId: serialized.provider_id,
			providerSlug: serialized.provider_slug,
			tag: serialized.tag,
			endpointClass: serialized.endpoint_class,
			region: serialized.region,
			contextLength: serialized.context_length,
			maxPromptTokens: serialized.max_prompt_tokens,
			maxCompletionTokens: serialized.max_completion_tokens,
			quantization: serialized.quantization,
			supportedParameters: serialized.supported_parameters,
			pricing: serialized.pricing,
			supportsImplicitCaching: serialized.supports_implicit_caching,
			supportsVoiceCloning: serialized.supports_voice_cloning,
			supportsToolChoice: serialized.supports_tool_choice,
			imageCapabilities: serialized.image_capabilities,
			audioCapabilities: serialized.audio_capabilities,
			evidenceUrl: serialized.evidence_url,
			verifiedBy: null,
			verifiedAt: null,
			expiresAt: serialized.expires_at,
			status: endpoint.status,
			createdAt: timestamps,
			updatedAt: timestamps,
		});
	} catch (error) {
		if (
			/unique|duplicate/i.test(
				error instanceof Error ? error.message : String(error)
			)
		) {
			throw conflict(
				"An endpoint already exists for this model, provider, and tag"
			);
		}
		throw error;
	}
	return {
		id,
		status: endpoint.status,
		audio_capabilities: endpoint.audioCapabilities,
	};
}

export async function updateModelEndpointService(
	repos: GatewayRepositories,
	id: string,
	input: AdminModelEndpointMutationInput,
	actorId: string,
	now = new Date()
): Promise<AdminModelEndpointWriteResult> {
	const endpointId = requiredId(id, "endpoint id", ENDPOINT_ID_MAX_LENGTH);
	assertMutationKeys(input);
	const existing = await repos.modelEndpoints.getById(endpointId);
	if (!existing) throw notFound("Endpoint not found");
	if (Object.keys(input).length === 0) {
		const current = safeAdminRow(existing, []);
		return {
			id: endpointId,
			status: existing.status,
			audio_capabilities: current.audio_capabilities,
		};
	}
	if (
		input.model_id !== undefined &&
		String(input.model_id).trim() !== existing.model_id
	) {
		throw badRequest("model_id is immutable; create a new endpoint instead");
	}
	if (
		input.provider_id !== undefined &&
		String(input.provider_id).trim() !== existing.provider_id
	) {
		throw badRequest("provider_id is immutable; create a new endpoint instead");
	}

	const merged: AdminModelEndpointMutationInput = {
		...rawEndpointInput(existing),
		...input,
	};
	const hasMaterialMutation = Object.keys(input).some((key) =>
		MATERIAL_MUTATION_KEYS.has(key as keyof AdminModelEndpointMutationInput)
	);
	if (
		existing.status === "verified" &&
		hasMaterialMutation &&
		input.status === undefined
	) {
		merged.status = "draft";
	}
	const endpoint = canonicalize(merged);
	if (endpoint.status === "verified") assertPublishable(endpoint, now);
	const explicitVerificationRequested =
		input.status !== undefined && endpoint.status === "verified";
	const verifiedRouteSubjects = explicitVerificationRequested
		? await prepareVerifiedRouteSubjects(repos, {
				id: endpointId,
				modelId: endpoint.modelId,
				providerId: endpoint.providerId,
				operationFacts: operationFacts(endpoint),
				legacyRoutingFacts: legacyRoutingFacts(endpoint),
		  })
		: [];
	const serialized = serializeEndpoint(endpoint);
	const verified = endpoint.status === "verified";
	const endpointPatch = {
		...serialized,
		verified_by: explicitVerificationRequested
			? actorId
			: verified
			? existing.verified_by
			: null,
		verified_at: explicitVerificationRequested
			? now.toISOString()
			: verified
			? existing.verified_at
			: null,
		updated_at: now.toISOString(),
	};
	const result: AdminModelEndpointWriteResult = {
		id: endpointId,
		status: endpoint.status,
		audio_capabilities: endpoint.audioCapabilities,
	};
	if (explicitVerificationRequested) {
		const published = await repos.modelEndpoints.publishVerified({
			endpointId,
			expectedStatus: existing.status,
			expectedUpdatedAt: existing.updated_at,
			endpointPatch,
			verifiedBy: actorId,
			verifiedAt: now.toISOString(),
			updatedAt: now.toISOString(),
			routeSubjects: verifiedRouteSubjects.map((subject) => ({
				routeTargetId: subject.link.route_target_id,
				expectedSubjectFingerprint: subject.link.subject_fingerprint,
				subjectFingerprint: subject.subjectFingerprint,
			})),
		});
		if (!published) {
			throw conflict(
				"Endpoint or route links changed during verification; reload and retry"
			);
		}
		return result;
	}

	if (endpoint.status === "verified") {
		throw new Error("Verified endpoint updates require atomic publication");
	}
	const changes = await repos.modelEndpoints.updateUnpublished(endpointId, {
		status: endpoint.status,
		updatedAt: now.toISOString(),
		endpointPatch,
	});
	if (!changes) throw notFound("Endpoint not found");
	return result;
}

export async function deleteModelEndpointService(
	repos: GatewayRepositories,
	id: string
): Promise<void> {
	const endpointId = requiredId(id, "endpoint id", ENDPOINT_ID_MAX_LENGTH);
	const changes = await repos.modelEndpoints.delete(endpointId);
	if (!changes) throw notFound("Endpoint not found");
}

export async function linkModelEndpointRouteService(
	repos: GatewayRepositories,
	id: string,
	routeTargetIdInput: string,
	now = new Date()
): Promise<void> {
	const endpointId = requiredId(id, "endpoint id", ENDPOINT_ID_MAX_LENGTH);
	const routeTargetId = requiredId(routeTargetIdInput, "route_target_id");
	const [endpoint, route] = await Promise.all([
		repos.modelEndpoints.getById(endpointId),
		repos.routes.getModelRouteRowById(routeTargetId),
	]);
	if (!endpoint) throw notFound("Endpoint not found");
	if (!route) throw notFound("Route not found");
	if (
		route.model_id !== endpoint.model_id ||
		route.provider_id !== endpoint.provider_id
	) {
		throw badRequest(
			"Route model/provider must match the endpoint model/provider"
		);
	}
	try {
		const linked = await repos.modelEndpoints.linkRoute({
			endpointId,
			routeTargetId,
			createdAt: now.toISOString(),
			subjectFingerprint: null,
			expectedEndpointStatus: endpoint.status,
			expectedEndpointUpdatedAt: endpoint.updated_at,
			updatedAt: now.toISOString(),
		});
		if (!linked) {
			throw conflict(
				"Endpoint changed while the route was being linked; reload and retry"
			);
		}
	} catch (error) {
		if (
			/unique|duplicate|constraint/i.test(
				error instanceof Error ? error.message : String(error)
			)
		) {
			throw conflict("Route is already linked to an endpoint");
		}
		throw error;
	}
}

export async function unlinkModelEndpointRouteService(
	repos: GatewayRepositories,
	id: string,
	routeTargetIdInput: string
): Promise<void> {
	const endpointId = requiredId(id, "endpoint id", ENDPOINT_ID_MAX_LENGTH);
	const routeTargetId = requiredId(routeTargetIdInput, "route_target_id");
	const changes = await repos.modelEndpoints.unlinkRoute({
		endpointId,
		routeTargetId,
	});
	if (!changes) throw notFound("Endpoint route link not found");
}
