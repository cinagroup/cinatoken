/** Authenticated, tenant-scoped OpenRouter generation metadata lookup. */
import type { GenerationRequestLogRow } from '@octafuse/core';
import { Hono } from 'hono';
import type { Env } from '../../app';
import type { ApiKeyContext } from '../../middleware/auth';
import { requireApiKey } from '../../middleware/auth';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';

type GenerationEnv = Env & { Variables: { apiKey: ApiKeyContext } };

type GenerationApiType = 'completions' | 'embeddings' | 'rerank' | 'tts' | 'stt' | 'video' | 'image';

/** OpenRouter SDK-compatible Generation data contract. */
export type GenerationMetadataData = {
	api_type: GenerationApiType | null;
	app_id: null;
	cache_discount: null;
	cancelled: boolean | null;
	created_at: string;
	data_region: 'global' | 'europe' | 'us';
	external_user: null;
	finish_reason: null;
	generation_time: null;
	http_referer: null;
	id: string;
	is_byok: boolean;
	latency: number | null;
	model: string;
	moderation_latency: null;
	native_finish_reason: null;
	native_tokens_cached: number | null;
	native_tokens_completion: number | null;
	native_tokens_completion_images: null;
	native_tokens_prompt: number | null;
	native_tokens_reasoning: number | null;
	num_fetches: null;
	num_input_audio_prompt: null;
	num_media_completion: number | null;
	num_media_prompt: number | null;
	num_search_results: null;
	origin: string;
	preset_id: null;
	provider_name: string | null;
	provider_responses: null;
	request_id: null;
	router: null;
	service_tier: null;
	session_id: null;
	streamed: boolean | null;
	tokens_completion: number | null;
	tokens_prompt: number | null;
	total_cost: number;
	/** Stored application-level upstream generation identifier, when valid. */
	upstream_id: string | null;
	upstream_inference_cost: number | null;
	usage: number;
	user_agent: null;
	web_search_engine: null;
	workspace_id: string | null;
};

const GENERATION_ID_PATTERN = /^gen-[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_UPSTREAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function nonNegativeSafeInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function nonNegativeDecimal(value: unknown): number | null {
	if (typeof value === 'number') return nonNegativeFiniteNumber(value);
	if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
	return nonNegativeFiniteNumber(Number(value));
}

function storedBoolean(value: unknown): boolean | null {
	if (value === true || value === 1) return true;
	if (value === false || value === 0) return false;
	return null;
}

function generationApiType(operation: string | null | undefined): GenerationApiType | null {
	switch (operation) {
		case 'chat':
		case 'responses':
		case 'messages':
		case 'models.generate':
		case 'generateContent':
		case 'streamGenerateContent':
			return 'completions';
		case 'embeddings':
			return 'embeddings';
		case 'rerank':
			return 'rerank';
		case 'audio.speech':
			return 'tts';
		case 'audio.transcriptions':
		case 'audio.transcriptions.multimodal':
			return 'stt';
		case 'video':
			return 'video';
		case 'images.generations':
		case 'images.edits':
			return 'image';
		default:
			return null;
	}
}

function cancelledFromStatus(status: string): boolean | null {
	if (status === 'cancelled') return true;
	if (status === 'success' || status === 'error' || status === 'incomplete') return false;
	return null;
}

function publicUpstreamId(value: string | null): string | null {
	if (!value || !PUBLIC_UPSTREAM_ID_PATTERN.test(value)) return null;
	return value;
}

function publicLogString(value: string | null, maxLength: number): string | null {
	if (!value || value.length > maxLength || CONTROL_CHAR_PATTERN.test(value)) return null;
	return value;
}

function publicCreatedAt(value: string): string | null {
	const safe = publicLogString(value, 64);
	return safe && Number.isFinite(Date.parse(safe)) ? safe : null;
}

function publicOrigin(value: string | null): string | null {
	const safe = publicLogString(value, 512);
	if (!safe) return null;
	try {
		const url = new URL(safe);
		if (
			(url.protocol !== 'https:' && url.protocol !== 'http:')
			|| url.username !== ''
			|| url.password !== ''
			|| url.origin !== safe
			|| url.pathname !== '/'
			|| url.search !== ''
			|| url.hash !== ''
		) return null;
		return safe;
	} catch {
		return null;
	}
}

function publicDataRegion(value: string | null): GenerationMetadataData['data_region'] | null {
	return value === 'global' || value === 'europe' || value === 'us' ? value : null;
}

/** Map only non-sensitive immutable columns; incomplete legacy snapshots stay unavailable. */
export function toGenerationMetadataData(row: GenerationRequestLogRow): GenerationMetadataData | null {
	const id = GENERATION_ID_PATTERN.test(row.id) ? row.id : null;
	const createdAt = publicCreatedAt(row.created_at);
	const model = publicLogString(row.model_id, 200);
	const origin = publicOrigin(row.request_origin);
	const dataRegion = publicDataRegion(row.data_region);
	const isByok = storedBoolean(row.is_byok);
	const totalCost = nonNegativeDecimal(row.charged_cost_usd);
	if (
		id == null
		|| createdAt == null
		|| model == null
		|| origin == null
		|| dataRegion == null
		|| isByok == null
		|| totalCost == null
	) return null;

	const apiType = generationApiType(row.request_operation);
	return {
		api_type: apiType,
		app_id: null,
		cache_discount: null,
		cancelled: cancelledFromStatus(row.status),
		created_at: createdAt,
		data_region: dataRegion,
		external_user: null,
		finish_reason: null,
		generation_time: null,
		http_referer: null,
		id,
		is_byok: isByok,
		latency: nonNegativeFiniteNumber(row.latency_ms),
		model,
		moderation_latency: null,
		native_finish_reason: null,
		native_tokens_cached: nonNegativeSafeInteger(row.cache_read_tokens),
		native_tokens_completion: nonNegativeSafeInteger(row.output_tokens),
		native_tokens_completion_images: null,
		native_tokens_prompt: nonNegativeSafeInteger(row.input_tokens),
		native_tokens_reasoning: nonNegativeSafeInteger(row.reasoning_tokens),
		num_fetches: null,
		num_input_audio_prompt: null,
		num_media_completion: apiType === 'image'
			? nonNegativeSafeInteger(row.output_image_count)
			: null,
		num_media_prompt: apiType === 'image'
			? nonNegativeSafeInteger(row.input_image_count)
			: null,
		num_search_results: null,
		origin,
		preset_id: null,
		provider_name: publicLogString(row.provider_name, 200),
		provider_responses: null,
		request_id: null,
		router: null,
		service_tier: null,
		session_id: null,
		streamed: storedBoolean(row.response_streamed),
		tokens_completion: nonNegativeSafeInteger(row.output_tokens),
		tokens_prompt: nonNegativeSafeInteger(row.input_tokens),
		total_cost: totalCost,
		upstream_id: publicUpstreamId(row.upstream_message_id),
		upstream_inference_cost: nonNegativeDecimal(row.upstream_inference_cost_usd),
		usage: totalCost,
		user_agent: null,
		web_search_engine: null,
		workspace_id: publicLogString(row.workspace_id, 600),
	};
}

function requestedGenerationId(requestUrl: string): { ok: true; id: string } | { ok: false; missing: boolean } {
	const ids = new URL(requestUrl).searchParams.getAll('id');
	if (ids.length !== 1 || ids[0] === '') return { ok: false, missing: true };
	const id = ids[0]!;
	return GENERATION_ID_PATTERN.test(id)
		? { ok: true, id }
		: { ok: false, missing: false };
}

function notFound(c: Parameters<typeof gatewayErrorJson>[0]): Response {
	return gatewayErrorJson(c, {
		status: 404,
		code: GatewayErrorCode.modelNotFound,
		message: 'Resource not found',
	});
}

export const generationRoutes = new Hono<GenerationEnv>();

generationRoutes.get('/', requireApiKey, async (c) => {
	const parsedId = requestedGenerationId(c.req.url);
	if (!parsedId.ok) {
		if (!parsedId.missing) return notFound(c);
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: 'id query parameter is required exactly once',
			metadata: { param: 'id' },
		});
	}

	const apiKey = c.get('apiKey');
	try {
		const row = await c.get('repositories').requestLogs.getRequestLogByIdForOwner({
			id: parsedId.id,
			userId: apiKey.userId,
			workspaceId: apiKey.workspaceId,
		});
		if (!row) return notFound(c);

		c.header('Cache-Control', 'private, no-store');
		const data = toGenerationMetadataData(row);
		if (!data) return notFound(c);
		return c.json({ data });
	} catch (error) {
		console.error(JSON.stringify({
			message: 'generation metadata lookup failed',
			error_type: error instanceof Error ? error.name : 'UnknownError',
		}));
		return gatewayErrorJson(c, {
			status: 500,
			code: GatewayErrorCode.internalError,
			message: 'Generation metadata lookup failed',
		});
	}
});
