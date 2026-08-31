/**
 * Route capability metadata used only by gateway routing. Unlike
 * `model_routes.custom_params`, these values are never merged into an upstream
 * request body.
 */

export const ROUTE_QUANTIZATIONS = [
	'int4',
	'int8',
	'fp4',
	'mxfp4',
	'nvfp4',
	'fp6',
	'fp8',
	'mxfp8',
	'fp16',
	'bf16',
	'fp32',
	'unknown',
] as const;

export type RouteQuantization = (typeof ROUTE_QUANTIZATIONS)[number];
export type RouteEndpointClass = 'standard' | 'service_tier';

export type RouteRoutingMetadata = {
	supported_parameters: string[];
	quantization: RouteQuantization | null;
	/** Public, stable provider-endpoint selector (for example `openai/turbo`). */
	endpoint_slug: string | null;
	/** Explicit slash-variant classification; never inferred from a slug suffix. */
	endpoint_class: RouteEndpointClass | null;
	/** Operator-supplied provider location label; this is not a residency guarantee. */
	region: string | null;
	/** Authoritative total context capacity for this concrete endpoint. */
	context_length: number | null;
	/** Authoritative prompt-token capacity for this concrete endpoint. */
	max_prompt_tokens: number | null;
	/** Authoritative completion/output-token capacity for this concrete endpoint. */
	max_completion_tokens: number | null;
};

const ALLOWED_KEYS = new Set([
	'supported_parameters',
	'quantization',
	'endpoint_slug',
	'endpoint_class',
	'region',
	'context_length',
	'max_prompt_tokens',
	'max_completion_tokens',
]);
const QUANTIZATIONS = new Set<string>(ROUTE_QUANTIZATIONS);
const MAX_PARAMETERS = 128;
const PARAMETER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const REGION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_ENDPOINT_SLUG_LENGTH = 120;
const ENDPOINT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoot(value: unknown): Record<string, unknown> | null {
	if (value == null || value === '') return null;
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(value) ? value : null;
}

function normalizePositiveTokenCapacity(
	root: Record<string, unknown>,
	key: 'context_length' | 'max_prompt_tokens' | 'max_completion_tokens',
	strict: boolean,
): number | null | undefined {
	const value = root[key];
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		if (strict) throw new Error(`routing_metadata.${key} must be a positive safe integer or null`);
		return undefined;
	}
	return value;
}

function normalize(value: unknown, strict: boolean): RouteRoutingMetadata | null {
	const root = parseRoot(value);
	if (!root) {
		if (value == null || value === '') return null;
		if (strict) throw new Error('routing_metadata must be a JSON object, JSON string, or null');
		return null;
	}

	const unsupported = Object.keys(root).filter((key) => !ALLOWED_KEYS.has(key));
	if (unsupported.length > 0) {
		if (strict) throw new Error(`routing_metadata contains unsupported key: ${unsupported.join(', ')}`);
		return null;
	}

	let supportedParameters: string[] = [];
	if (root.supported_parameters !== undefined) {
		if (!Array.isArray(root.supported_parameters) || root.supported_parameters.length > MAX_PARAMETERS) {
			if (strict) throw new Error(`routing_metadata.supported_parameters must be an array of at most ${MAX_PARAMETERS} names`);
			return null;
		}
		const seen = new Set<string>();
		for (const item of root.supported_parameters) {
			if (typeof item !== 'string' || !PARAMETER_PATTERN.test(item.trim())) {
				if (strict) throw new Error('routing_metadata.supported_parameters contains an invalid parameter name');
				return null;
			}
			const parameter = item.trim();
			const canonical = parameter.toLocaleLowerCase();
			if (!seen.has(canonical)) {
				seen.add(canonical);
				supportedParameters.push(parameter);
			}
		}
	}

	let quantization: RouteQuantization | null = null;
	if (root.quantization !== undefined && root.quantization !== null && root.quantization !== '') {
		if (typeof root.quantization !== 'string' || !QUANTIZATIONS.has(root.quantization.toLocaleLowerCase())) {
			if (strict) throw new Error(`routing_metadata.quantization must be one of: ${ROUTE_QUANTIZATIONS.join(', ')}`);
			return null;
		}
		quantization = root.quantization.toLocaleLowerCase() as RouteQuantization;
	}

	let endpointSlug: string | null = null;
	if (root.endpoint_slug !== undefined && root.endpoint_slug !== null && root.endpoint_slug !== '') {
		const candidate = typeof root.endpoint_slug === 'string' ? root.endpoint_slug.trim() : '';
		if (
			typeof root.endpoint_slug !== 'string' ||
			candidate.length > MAX_ENDPOINT_SLUG_LENGTH ||
			!ENDPOINT_SLUG_PATTERN.test(candidate)
		) {
			if (strict) {
				throw new Error(
					'routing_metadata.endpoint_slug must be a public endpoint slug using letters, numbers, dots, underscores, hyphens, and slash-separated variants',
				);
			}
			return null;
		}
		endpointSlug = candidate.toLowerCase();
	}

	let endpointClass: RouteEndpointClass | null = null;
	if (root.endpoint_class !== undefined && root.endpoint_class !== null && root.endpoint_class !== '') {
		if (root.endpoint_class !== 'standard' && root.endpoint_class !== 'service_tier') {
			if (strict) throw new Error('routing_metadata.endpoint_class must be standard or service_tier');
			return null;
		}
		endpointClass = root.endpoint_class;
	}
	if (endpointClass && !endpointSlug) {
		if (strict) throw new Error('routing_metadata.endpoint_class requires endpoint_slug');
		return null;
	}
	if (endpointClass === 'service_tier' && !endpointSlug?.includes('/')) {
		if (strict) throw new Error('routing_metadata.endpoint_class service_tier requires a slash-variant endpoint_slug');
		return null;
	}
	if (strict && endpointSlug?.includes('/') && !endpointClass) {
		throw new Error('routing_metadata.endpoint_class is required for slash-variant endpoint_slug values');
	}

	let region: string | null = null;
	if (root.region !== undefined && root.region !== null && root.region !== '') {
		if (typeof root.region !== 'string' || !REGION_PATTERN.test(root.region.trim())) {
			if (strict) throw new Error('routing_metadata.region must be a valid region identifier');
			return null;
		}
		region = root.region.trim().toLocaleLowerCase();
	}

	const contextLength = normalizePositiveTokenCapacity(root, 'context_length', strict);
	const maxPromptTokens = normalizePositiveTokenCapacity(root, 'max_prompt_tokens', strict);
	const maxCompletionTokens = normalizePositiveTokenCapacity(root, 'max_completion_tokens', strict);
	if (contextLength === undefined || maxPromptTokens === undefined || maxCompletionTokens === undefined) {
		return null;
	}

	return {
		supported_parameters: supportedParameters,
		quantization,
		endpoint_slug: endpointSlug,
		endpoint_class: endpointClass,
		region,
		context_length: contextLength,
		max_prompt_tokens: maxPromptTokens,
		max_completion_tokens: maxCompletionTokens,
	};
}

/** Parse stored metadata fail-closed. Invalid historical rows expose no capabilities. */
export function parseRouteRoutingMetadata(value: unknown): RouteRoutingMetadata | null {
	return normalize(value, false);
}

/** Strictly validate an Admin mutation and return canonical JSON for storage. */
export function normalizeRouteRoutingMetadataInput(value: unknown): string | null {
	if (value == null || value === '') return null;
	const normalized = normalize(value, true);
	if (!normalized) return null;
	return JSON.stringify(normalized);
}
