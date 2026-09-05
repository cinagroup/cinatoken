import type { ModelEndpointRow } from "./db/model-endpoints-types";
import {
	ROUTE_QUANTIZATIONS,
	parseRouteRoutingMetadata,
	type RouteEndpointClass,
	type RouteQuantization,
	type RouteRoutingMetadata,
} from "./db/route-routing-metadata";
import {
	AUDIO_ENDPOINT_PRICING_OPERATIONS,
	audioEndpointReferenceEvidenceMatchesVoiceCloning,
	audioEndpointSupportsOperation,
	isAudioEndpointReady,
	isImageEndpointReady,
	isPublicEndpointCapabilityReady,
	normalizeAudioEndpointCapabilities,
	normalizeEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	type AudioEndpointCapabilities,
	type EndpointCapabilities,
	type ImageEndpointCapabilities,
	type TextEndpointPricing,
} from "./model-endpoint-catalog";
import type { RequestOperation } from "./route-topology";

const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENDPOINT_TAG =
	/^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*$/u;
const REGION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PARAMETER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SUBJECT_FINGERPRINT = /^[0-9a-f]{64}$/u;
const QUANTIZATIONS = new Set<string>(ROUTE_QUANTIZATIONS);
export const MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT = 128;

type EndpointFactKind = "text" | "image" | "audio";

/**
 * Exhaustive classification of the current public/upstream operation union.
 * Adding a new operation to RequestOperation is a compile-time error here
 * until its required evidence class is chosen deliberately.
 */
const ENDPOINT_FACT_KIND_BY_OPERATION = {
	chat: "text",
	responses: "text",
	embeddings: "text",
	rerank: "text",
	"images.generations": "image",
	"images.edits": "image",
	"audio.transcriptions": "audio",
	"audio.speech": "audio",
	messages: "text",
	"models.generate": "text",
	"audio.transcriptions.multimodal": "audio",
	"audio.transcriptions.async": "audio",
	"audio.transcriptions.realtime.inference": "audio",
	"audio.transcriptions.realtime.session": "audio",
	"audio.speech.stream": "audio",
	"audio.speech.multimodal": "audio",
	"audio.speech.realtime.inference": "audio",
	"audio.speech.realtime.session": "audio",
} as const satisfies Record<Exclude<RequestOperation, "*">, EndpointFactKind>;

export type VerifiedModelEndpointSnapshot = {
	id: string;
	modelId: string;
	providerId: string;
	providerSlug: string;
	/** Exact public endpoint selector used by provider.order/only/ignore. */
	selectorSlug: string;
	endpointClass: RouteEndpointClass | null;
	region: string | null;
	contextLength: number | null;
	maxPromptTokens: number | null;
	maxCompletionTokens: number | null;
	quantization: RouteQuantization | null;
	supportedParameters: string[];
	pricing: TextEndpointPricing | null;
	capabilities: EndpointCapabilities;
	imageCapabilities: ImageEndpointCapabilities | null;
	/** Omitted by pre-migration/test adapters; omission is treated as unknown. */
	audioCapabilities?: AudioEndpointCapabilities | null;
	evidenceUrl: string;
	verifiedBy: string;
	verifiedAt: string;
	expiresAt: string;
};

export type ModelEndpointOperationFacts = Pick<
	VerifiedModelEndpointSnapshot,
	| "contextLength"
	| "pricing"
	| "capabilities"
	| "imageCapabilities"
	| "audioCapabilities"
>;

/**
 * Endpoint-owned facts that may still be duplicated in a legacy route row.
 * The legacy row is only a consistency check; it must never supply a missing
 * endpoint fact.
 */
export type ModelEndpointLegacyRoutingFacts = Pick<
	VerifiedModelEndpointSnapshot,
	| "selectorSlug"
	| "endpointClass"
	| "region"
	| "contextLength"
	| "maxPromptTokens"
	| "maxCompletionTokens"
	| "quantization"
	| "supportedParameters"
>;

function endpointFactReadiness(endpoint: ModelEndpointOperationFacts): {
	text: boolean;
	image: boolean;
	audio: boolean;
} {
	return {
		text:
			endpoint.contextLength !== null &&
			endpoint.pricing !== null &&
			isPublicEndpointCapabilityReady(endpoint.capabilities),
		image:
			endpoint.imageCapabilities !== null &&
			isImageEndpointReady(endpoint.imageCapabilities),
		audio:
			endpoint.audioCapabilities != null &&
			isAudioEndpointReady(endpoint.audioCapabilities),
	};
}

/**
 * Require evidence for the actual upstream operation. Legacy `*` can serve
 * every operation family, so it is publishable only with complete text/image
 * facts and pricing for every supported audio operation. Unknown and currently
 * unpriceable operations fail closed.
 */
export function modelEndpointSupportsOperation(
	endpoint: ModelEndpointOperationFacts,
	operation: string | null | undefined
): boolean {
	const normalized = operation?.trim() || "*";
	const readiness = endpointFactReadiness(endpoint);
	if (normalized === "*") {
		return (
			readiness.text &&
			readiness.image &&
			readiness.audio &&
			AUDIO_ENDPOINT_PRICING_OPERATIONS.every((operation) =>
				audioEndpointSupportsOperation(endpoint.audioCapabilities!, operation)
			)
		);
	}
	const factKind = ENDPOINT_FACT_KIND_BY_OPERATION[
		normalized as Exclude<RequestOperation, "*">
	] as EndpointFactKind | undefined;
	return factKind === "text"
		? readiness.text
		: factKind === "image"
			? readiness.image
			: factKind === "audio" && endpoint.audioCapabilities != null
				? audioEndpointSupportsOperation(
						endpoint.audioCapabilities,
						normalized
					)
				: false;
}

export function modelEndpointTagIsValidForProvider(
	tag: string,
	providerSlug: string
): boolean {
	return (
		ENDPOINT_TAG.test(tag) &&
		(!tag.includes("/") || tag.startsWith(`${providerSlug}/`))
	);
}

function json(value: string): unknown {
	return JSON.parse(value) as unknown;
}

function isEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& Object.keys(value as Record<string, unknown>).length === 0;
}

function positiveCapacity(value: number | null): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError("endpoint capacity must be a positive safe integer or null");
	}
	return value;
}

function evidenceUrl(value: string | null): string {
	if (!value) throw new TypeError("verified endpoint requires evidence_url");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new TypeError("verified endpoint evidence_url must be credential-free HTTPS");
	}
	return url.toString();
}

function timestamp(value: string | null, label: string): { raw: string; epoch: number } {
	if (!value) throw new TypeError(`verified endpoint requires ${label}`);
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch)) throw new TypeError(`verified endpoint ${label} is invalid`);
	return { raw: value, epoch };
}

function supportedParameters(raw: string): string[] {
	const value = json(raw);
	if (
		!Array.isArray(value) ||
		value.length > MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT
	) {
		throw new TypeError(
			`supported_parameters must contain at most ${MODEL_ENDPOINT_SUPPORTED_PARAMETERS_LIMIT} names`
		);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || !PARAMETER.test(item.trim())) {
			throw new TypeError("supported_parameters contains an invalid name");
		}
		const normalized = item.trim();
		const identity = normalized.toLowerCase();
		if (seen.has(identity)) throw new TypeError("supported_parameters contains a duplicate");
		seen.add(identity);
		result.push(normalized);
	}
	return result;
}

function optionalTextPricing(raw: string): TextEndpointPricing | null {
	const value = json(raw);
	return isEmptyObject(value) ? null : normalizeTextEndpointPricing(value);
}

function optionalImageCapabilities(raw: string): ImageEndpointCapabilities | null {
	const value = json(raw);
	return isEmptyObject(value) ? null : normalizeImageEndpointCapabilities(value);
}

function optionalAudioCapabilities(raw: string): AudioEndpointCapabilities | null {
	const value = json(raw);
	return isEmptyObject(value) ? null : normalizeAudioEndpointCapabilities(value);
}

/**
 * Parse one endpoint row into the only capability/pricing snapshot accepted by
 * inference. Invalid, incomplete, draft, future-dated, or expired evidence is
 * rejected so callers can fail closed by omitting the route.
 */
export function parseVerifiedModelEndpointSnapshot(
	row: ModelEndpointRow,
	now = new Date(),
): VerifiedModelEndpointSnapshot | null {
	try {
		if (row.status !== "verified") return null;
		if (!row.id || !row.model_id || !row.provider_id) return null;
		const providerSlug = row.provider_slug.trim().toLowerCase();
		const tag = row.tag.trim().toLowerCase();
		if (
			!PROVIDER_SLUG.test(providerSlug) ||
			!modelEndpointTagIsValidForProvider(tag, providerSlug)
		) {
			return null;
		}
		const selectorSlug = tag === providerSlug || tag.includes("/")
			? tag
			: `${providerSlug}/${tag}`;

		const endpointClass = row.endpoint_class as RouteEndpointClass | null;
		if (endpointClass !== null && endpointClass !== "standard" && endpointClass !== "service_tier") {
			return null;
		}
		if (endpointClass === "service_tier" && !tag.includes("/")) return null;
		if (tag.includes("/") && endpointClass === null) return null;
		const region = row.region?.trim().toLowerCase() || null;
		if (region && !REGION.test(region)) return null;
		const quantization = row.quantization?.trim().toLowerCase() || null;
		if (quantization && !QUANTIZATIONS.has(quantization)) return null;

		const verifiedBy = row.verified_by?.trim() ?? "";
		if (!verifiedBy) return null;
		const verifiedAt = timestamp(row.verified_at, "verified_at");
		const expiresAt = timestamp(row.expires_at, "expires_at");
		if (verifiedAt.epoch > now.getTime() || expiresAt.epoch <= now.getTime()) return null;

		const capabilities = normalizeEndpointCapabilities({
			implicit_caching: row.supports_implicit_caching == null
				? null
				: Boolean(row.supports_implicit_caching),
			voice_cloning: row.supports_voice_cloning == null
				? null
				: Boolean(row.supports_voice_cloning),
			tool_choice: json(row.supports_tool_choice),
		});
		const pricing = optionalTextPricing(row.pricing);
		const imageCapabilities = optionalImageCapabilities(row.image_capabilities);
		const audioCapabilities = optionalAudioCapabilities(
			row.audio_capabilities ?? "{}"
		);
		if (imageCapabilities && imageCapabilities.provider_slug !== providerSlug) return null;
		if (
			audioCapabilities &&
			!audioEndpointReferenceEvidenceMatchesVoiceCloning(
				audioCapabilities,
				capabilities.voice_cloning
			)
		) return null;

		const contextLength = positiveCapacity(row.context_length);
		const maxPromptTokens = positiveCapacity(row.max_prompt_tokens);
		const maxCompletionTokens = positiveCapacity(row.max_completion_tokens);
		const readiness = endpointFactReadiness({
			contextLength,
			pricing,
			capabilities,
			imageCapabilities,
			audioCapabilities,
		});
		if (!readiness.text && !readiness.image && !readiness.audio) return null;

		return {
			id: row.id,
			modelId: row.model_id,
			providerId: row.provider_id,
			providerSlug,
			selectorSlug,
			endpointClass,
			region,
			contextLength,
			maxPromptTokens,
			maxCompletionTokens,
			quantization: quantization as RouteQuantization | null,
			supportedParameters: supportedParameters(row.supported_parameters),
			pricing,
			capabilities,
			imageCapabilities,
			audioCapabilities,
			evidenceUrl: evidenceUrl(row.evidence_url),
			verifiedBy,
			verifiedAt: verifiedAt.raw,
			expiresAt: expiresAt.raw,
		};
	} catch {
		return null;
	}
}

function rootObject(value: unknown): Record<string, unknown> | null {
	if (value == null || value === "") return null;
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function sameParameterSet(left: readonly string[], right: readonly string[]): boolean {
	const canonical = (items: readonly string[]) => [...items]
		.map((item) => item.toLowerCase())
		.sort();
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * During cutover, legacy routing_metadata is drift evidence only. Omitted keys
 * do not invent facts; every declared key must agree with the verified endpoint.
 */
export function verifiedEndpointMatchesLegacyRoutingMetadata(
	endpoint: ModelEndpointLegacyRoutingFacts,
	raw: unknown,
): boolean {
	if (raw == null || raw === "") return true;
	const root = rootObject(raw);
	const metadata = parseRouteRoutingMetadata(raw);
	if (!root || !metadata) return false;
	const expected: RouteRoutingMetadata = {
		supported_parameters: endpoint.supportedParameters,
		quantization: endpoint.quantization,
		endpoint_slug: endpoint.selectorSlug,
		endpoint_class: endpoint.endpointClass,
		region: endpoint.region,
		context_length: endpoint.contextLength,
		max_prompt_tokens: endpoint.maxPromptTokens,
		max_completion_tokens: endpoint.maxCompletionTokens,
	};
	for (const key of Object.keys(root) as Array<keyof RouteRoutingMetadata>) {
		if (key === "supported_parameters") {
			if (!sameParameterSet(metadata[key], expected[key])) return false;
		} else if (metadata[key] !== expected[key]) {
			return false;
		}
	}
	return true;
}

export function modelEndpointSubjectFingerprintIsValid(value: string | null | undefined): boolean {
	return SUBJECT_FINGERPRINT.test(value ?? "");
}
