/**
 * OpenRouter-compatible cross-model fallback request controls.
 *
 * These fields are gateway controls and must never be forwarded upstream:
 * - OpenAI-compatible ingress: `models`
 * - Anthropic Messages ingress: `models` or `fallbacks`
 */

export const MAX_OPENAI_MODEL_CANDIDATES = 8;
export const MAX_ANTHROPIC_FALLBACKS = 3;
const MAX_MODEL_ID_LENGTH = 240;

export type ParsedModelFallbacks = {
	modelIds: string[];
	upstreamBody: Record<string, unknown>;
	hasFallbacks: boolean;
};

export type ModelFallbackParseResult =
	| { ok: true; value: ParsedModelFallbacks }
	| { ok: false; message: string; missingModel?: boolean };

export type ModelFallbackTraceAttempt = {
	model: string;
	base_model: string;
	route_group: string;
	status: number;
	outcome: 'success' | 'error' | 'circuit_open';
	provider_id?: string;
	route_target_id?: string;
	error_code?: string;
};

export type ModelFallbackTrace = {
	original_model: string;
	requested_models: string[];
	final_model: string;
	fallback_count: number;
	attempts: ModelFallbackTraceAttempt[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readModelId(value: unknown, field: string): { ok: true; value: string } | { ok: false; message: string } {
	if (typeof value !== 'string') {
		return { ok: false, message: `${field} must be a non-empty model ID` };
	}
	const modelId = value.trim();
	if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) {
		return { ok: false, message: `${field} must be a non-empty model ID of at most ${MAX_MODEL_ID_LENGTH} characters` };
	}
	return { ok: true, value: modelId };
}

function dedupeModelIds(modelIds: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const modelId of modelIds) {
		if (seen.has(modelId)) continue;
		seen.add(modelId);
		result.push(modelId);
	}
	return result;
}

function readModelsArray(
	value: unknown,
	maxCandidates: number,
): { ok: true; value: string[] } | { ok: false; message: string } {
	if (!Array.isArray(value) || value.length === 0 || value.length > maxCandidates) {
		return {
			ok: false,
			message: `models must be a non-empty array of at most ${maxCandidates} model IDs`,
		};
	}
	const result: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const parsed = readModelId(value[index], `models[${index}]`);
		if (!parsed.ok) return parsed;
		result.push(parsed.value);
	}
	return { ok: true, value: result };
}

/** Parse `model` plus the OpenRouter `models` fallback array. */
export function parseOpenAiModelFallbacks(body: Record<string, unknown>): ModelFallbackParseResult {
	const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
	const hasModels = Object.prototype.hasOwnProperty.call(body, 'models');
	let primary: string | null = null;
	if (hasModel) {
		const parsed = readModelId(body.model, 'model');
		if (!parsed.ok) return parsed;
		primary = parsed.value;
	}

	let fallbackModels: string[] = [];
	if (hasModels) {
		const parsed = readModelsArray(body.models, MAX_OPENAI_MODEL_CANDIDATES);
		if (!parsed.ok) return parsed;
		fallbackModels = parsed.value;
	}

	const modelIds = dedupeModelIds(primary ? [primary, ...fallbackModels] : fallbackModels);
	if (modelIds.length === 0) {
		return { ok: false, message: 'Missing model or models', missingModel: true };
	}
	if (modelIds.length > MAX_OPENAI_MODEL_CANDIDATES) {
		return {
			ok: false,
			message: `model and models may contain at most ${MAX_OPENAI_MODEL_CANDIDATES} distinct model IDs in total`,
		};
	}

	const upstreamBody: Record<string, unknown> = { ...body, model: modelIds[0] };
	delete upstreamBody.models;
	return {
		ok: true,
		value: { modelIds, upstreamBody, hasFallbacks: modelIds.length > 1 },
	};
}

function readAnthropicFallbacks(value: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
	if (!Array.isArray(value) || value.length > MAX_ANTHROPIC_FALLBACKS) {
		return {
			ok: false,
			message: `fallbacks must be an array of at most ${MAX_ANTHROPIC_FALLBACKS} entries`,
		};
	}
	const result: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (!isRecord(item) || Object.keys(item).some((key) => key !== 'model')) {
			return { ok: false, message: `fallbacks[${index}] may contain only the model field` };
		}
		const parsed = readModelId(item.model, `fallbacks[${index}].model`);
		if (!parsed.ok) return parsed;
		result.push(parsed.value);
	}
	return { ok: true, value: result };
}

/** Parse Anthropic Messages `fallbacks`, while accepting the shared `models` form too. */
export function parseAnthropicModelFallbacks(body: Record<string, unknown>): ModelFallbackParseResult {
	const primary = readModelId(body.model, 'model');
	if (!primary.ok) {
		return { ...primary, missingModel: body.model == null };
	}
	const hasModels = Object.prototype.hasOwnProperty.call(body, 'models');
	const hasFallbacks = Object.prototype.hasOwnProperty.call(body, 'fallbacks');
	if (hasModels && hasFallbacks) {
		return { ok: false, message: 'fallbacks cannot be combined with models' };
	}

	let fallbackModels: string[] = [];
	if (hasFallbacks) {
		const parsed = readAnthropicFallbacks(body.fallbacks);
		if (!parsed.ok) return parsed;
		fallbackModels = parsed.value;
	} else if (hasModels) {
		const parsed = readModelsArray(body.models, MAX_OPENAI_MODEL_CANDIDATES - 1);
		if (!parsed.ok) return parsed;
		fallbackModels = parsed.value;
	}

	const modelIds = dedupeModelIds([primary.value, ...fallbackModels]);
	const upstreamBody: Record<string, unknown> = { ...body, model: primary.value };
	delete upstreamBody.models;
	delete upstreamBody.fallbacks;
	return {
		ok: true,
		value: { modelIds, upstreamBody, hasFallbacks: modelIds.length > 1 },
	};
}

/** Only persist this extension when the client actually requested model fallback. */
export function buildModelFallbackTrace(
	requestedModels: string[],
	attempts: ModelFallbackTraceAttempt[],
): ModelFallbackTrace | null {
	if (requestedModels.length <= 1 || attempts.length === 0) return null;
	const finalAttempt = attempts[attempts.length - 1]!;
	return {
		original_model: requestedModels[0]!,
		requested_models: requestedModels,
		final_model: finalAttempt.base_model,
		fallback_count: Math.max(0, attempts.length - 1),
		attempts,
	};
}
