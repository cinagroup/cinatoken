import type {
	GatewayRepositories,
	GuardrailPreflightResult,
} from '@octafuse/core';
import { runRequestGuardrails } from './request-guardrails';

type CommonParams = {
	workspaceId: string;
	userId: string;
	apiKeyId: string;
	modelId: string;
	correlationId: string;
	now: Date;
};

const BASE64_DATA_URL_RE = /^data:[^,]+;base64,/i;
const MULTIMODAL_MEDIA_VALUE_KEYS = new Set([
	'audio', 'audio_url', 'base64', 'bytes', 'data', 'file', 'file_url',
	'image', 'image_url', 'input_audio', 'input_image', 'input_video', 'payload',
	'source', 'url', 'video', 'video_url',
]);
const MULTIMODAL_MEDIA_CONTAINERS = new Set([
	'audio', 'audio_url', 'input_audio', 'input_image', 'input_video', 'file',
	'image', 'image_url', 'source', 'video', 'video_url',
]);
const MULTIMODAL_STRUCTURAL_KEYS = new Set(['id', 'model', 'name', 'role', 'type']);
const PROVIDER_SELECTOR_KEYS = ['order', 'only', 'ignore'] as const;
const PROVIDER_BOOLEAN_KEYS = ['allow_fallbacks', 'zdr'] as const;
const PROVIDER_SUPPORTED_KEYS = new Set<string>([
	...PROVIDER_SELECTOR_KEYS,
	...PROVIDER_BOOLEAN_KEYS,
]);
const MAX_PROVIDER_SELECTORS_FOR_VALIDATION = 33;
const MAX_PROVIDER_SELECTOR_LENGTH_FOR_VALIDATION = 121;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isMultimodalTextPosition(key: string | null, parentKey: string | null): boolean {
	if (key != null && (MULTIMODAL_MEDIA_VALUE_KEYS.has(key) || MULTIMODAL_STRUCTURAL_KEYS.has(key))) return false;
	if (parentKey != null && MULTIMODAL_MEDIA_CONTAINERS.has(parentKey)) return false;
	return true;
}

class MultimodalGuardrailDepthError extends Error {
	constructor() {
		super('DashScope multimodal content exceeds the guardrail nesting limit');
		this.name = 'MultimodalGuardrailDepthError';
	}
}

/**
 * Keep only a bounded validation witness for provider preferences. The normal
 * provider parser still rejects unsupported keys, oversized lists, long names,
 * and invalid scalar types, but Guardrail preflight never deep-clones an
 * attacker-controlled provider object or an unbounded selector string.
 */
function projectProviderPreferences(value: unknown): unknown {
	if (!isRecord(value)) return null;
	const projected: Record<string, unknown> = {};
	for (const key in value) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
		if (!PROVIDER_SUPPORTED_KEYS.has(key)) {
			projected[key.slice(0, MAX_PROVIDER_SELECTOR_LENGTH_FOR_VALIDATION)] = null;
			return projected;
		}
	}
	for (const key of PROVIDER_SELECTOR_KEYS) {
		const selectors = value[key];
		if (selectors === undefined) continue;
		projected[key] = Array.isArray(selectors)
			? selectors.slice(0, MAX_PROVIDER_SELECTORS_FOR_VALIDATION).map((selector) =>
					typeof selector === 'string'
						? selector.slice(0, MAX_PROVIDER_SELECTOR_LENGTH_FOR_VALIDATION)
						: null)
			: null;
	}
	for (const key of PROVIDER_BOOLEAN_KEYS) {
		const flag = value[key];
		if (flag !== undefined) projected[key] = typeof flag === 'boolean' ? flag : null;
	}
	return projected;
}

/**
 * Preserve the native DashScope shape while replacing every non-text scalar
 * with null. In particular, audio/data/url fields never enter the generic
 * Guardrail scanner even when they contain a very large base64 data URL.
 */
function projectMultimodalText(
	value: unknown,
	key: string | null = null,
	parentKey: string | null = null,
	depth = 0,
): unknown {
	if (depth > 24) throw new MultimodalGuardrailDepthError();
	if (typeof value === 'string') {
		return isMultimodalTextPosition(key, parentKey) && !BASE64_DATA_URL_RE.test(value)
			? value
			: null;
	}
	if (Array.isArray(value)) {
		return value.map((item) => projectMultimodalText(item, null, key, depth + 1));
	}
	if (!isRecord(value)) return null;
	const result: Record<string, unknown> = {};
	for (const [childKey, child] of Object.entries(value)) {
		result[childKey] = projectMultimodalText(child, childKey, key, depth + 1);
	}
	return result;
}

function applyGuardedMultimodalText(
	original: unknown,
	guarded: unknown,
	key: string | null = null,
	parentKey: string | null = null,
	depth = 0,
): unknown {
	if (depth > 24) throw new MultimodalGuardrailDepthError();
	if (typeof original === 'string') {
		return isMultimodalTextPosition(key, parentKey) && typeof guarded === 'string'
			? guarded
			: original;
	}
	if (Array.isArray(original)) {
		const guardedItems = Array.isArray(guarded) ? guarded : [];
		return original.map((item, index) =>
			applyGuardedMultimodalText(item, guardedItems[index], null, key, depth + 1));
	}
	if (!isRecord(original)) return original;
	const guardedRecord = isRecord(guarded) ? guarded : {};
	const result: Record<string, unknown> = {};
	for (const [childKey, child] of Object.entries(original)) {
		result[childKey] = applyGuardedMultimodalText(
			child,
			guardedRecord[childKey],
			childKey,
			key,
			depth + 1,
		);
	}
	return result;
}

/** Native DashScope Guardrail projection: semantic text plus gateway provider controls only. */
export function dashScopeMultimodalGuardrailBody(
	modelId: string,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const projected: Record<string, unknown> = { model: modelId };
	for (const rootKey of ['messages', 'input', 'prompt', 'system', 'instructions'] as const) {
		if (body[rootKey] !== undefined) {
			projected[rootKey] = projectMultimodalText(body[rootKey], rootKey, null);
		}
	}
	if (body.provider !== undefined) projected.provider = projectProviderPreferences(body.provider);
	return projected;
}

function redactMultimodalMediaForLog(
	value: unknown,
	key: string | null = null,
	parentKey: string | null = null,
	depth = 0,
): unknown {
	if (depth > 24) return '[redacted nested value]';
	if (typeof value === 'string') {
		const mediaField = key != null && MULTIMODAL_MEDIA_VALUE_KEYS.has(key)
			|| (key == null && parentKey != null && MULTIMODAL_MEDIA_CONTAINERS.has(parentKey));
		return mediaField || BASE64_DATA_URL_RE.test(value)
			? `[redacted media source ${value.length} chars]`
			: value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactMultimodalMediaForLog(item, null, key, depth + 1));
	}
	if (!isRecord(value)) return value;
	const redacted: Record<string, unknown> = {};
	for (const [childKey, child] of Object.entries(value)) {
		redacted[childKey] = redactMultimodalMediaForLog(child, childKey, key, depth + 1);
	}
	return redacted;
}

/** Shared request-log redaction for every native multimodal media spelling. */
export function redactDashScopeMultimodalBodyForLog(
	body: Record<string, unknown>,
): Record<string, unknown> {
	return redactMultimodalMediaForLog(body) as Record<string, unknown>;
}

function restoreDashScopeMultimodalBody(
	original: Record<string, unknown>,
	guardedProjection: Record<string, unknown>,
): Record<string, unknown> {
	// Copy containers but retain immutable media string references. A deep
	// structuredClone here would duplicate a potentially 50 MiB data URL.
	const restored = { ...original };
	for (const rootKey of ['messages', 'input', 'prompt', 'system', 'instructions'] as const) {
		if (original[rootKey] !== undefined) {
			restored[rootKey] = applyGuardedMultimodalText(
				original[rootKey],
				guardedProjection[rootKey],
				rootKey,
				null,
			);
		}
	}
	if (guardedProjection.provider !== undefined) restored.provider = guardedProjection.provider;
	else delete restored.provider;
	return restored;
}

/**
 * Multipart files never enter the JSON guardrail engine. Only the textual
 * prompt and model policy metadata are projected, then the guarded prompt is
 * copied back into the normalized multipart request by the route.
 */
export function audioTranscriptionGuardrailBody(
	modelId: string,
	prompt: string | undefined,
	providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Record<string, unknown> {
	return {
		model: modelId,
		...(prompt === undefined ? {} : { prompt }),
		...(providerOptions == null ? {} : { provider_options: providerOptions }),
	};
}

export async function runAudioTranscriptionRequestGuardrails(
	repositories: GatewayRepositories,
	params: CommonParams & {
		prompt: string | undefined;
		providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	},
): Promise<GuardrailPreflightResult> {
	return runRequestGuardrails(repositories, {
		workspaceId: params.workspaceId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		modelIds: [params.modelId],
		body: audioTranscriptionGuardrailBody(
			params.modelId,
			params.prompt,
			params.providerOptions,
		),
		correlationId: params.correlationId,
		now: params.now,
	});
}

export async function runAudioSpeechRequestGuardrails(
	repositories: GatewayRepositories,
	params: CommonParams & { body: Record<string, unknown> },
): Promise<GuardrailPreflightResult> {
	return runRequestGuardrails(repositories, {
		workspaceId: params.workspaceId,
		userId: params.userId,
		apiKeyId: params.apiKeyId,
		modelIds: [params.modelId],
		body: params.body,
		correlationId: params.correlationId,
		now: params.now,
	});
}

export async function runDashScopeMultimodalRequestGuardrails(
	repositories: GatewayRepositories,
	params: CommonParams & { body: Record<string, unknown> },
): Promise<GuardrailPreflightResult> {
	try {
		const result = await runRequestGuardrails(repositories, {
			workspaceId: params.workspaceId,
			userId: params.userId,
			apiKeyId: params.apiKeyId,
			modelIds: [params.modelId],
			body: dashScopeMultimodalGuardrailBody(params.modelId, params.body),
			correlationId: params.correlationId,
			now: params.now,
		});
		if (!result.ok) return result;
		return {
			...result,
			body: restoreDashScopeMultimodalBody(params.body, result.body),
		};
	} catch (error) {
		if (!(error instanceof MultimodalGuardrailDepthError)) throw error;
		return {
			ok: false,
			status: 403,
			code: 'guardrail_blocked',
			message: error.message,
			trace: [],
		};
	}
}

/** Audio may return binary, SSE, plain text, or JSON; no uniform safe output transform exists. */
export function audioOutputGuardrailsRequirePreflightBlock(
	result: Extract<GuardrailPreflightResult, { ok: true }>,
): boolean {
	return result.outputFilters.length > 0;
}
