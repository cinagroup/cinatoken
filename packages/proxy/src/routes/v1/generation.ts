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

/**
 * Deliberately nullable subset of OpenRouter's Generation data contract.
 * Request logs do not snapshot request headers, data region, billing currency,
 * finish reason, streaming mode, BYOK ownership, or provider invoice cost, so
 * those values must remain null instead of being reconstructed after the fact.
 */
export type GenerationMetadataData = {
	api_type: GenerationApiType | null;
	app_id: null;
	cache_discount: null;
	cancelled: boolean | null;
	created_at: string | null;
	data_region: null;
	external_user: null;
	finish_reason: null;
	generation_time: null;
	http_referer: null;
	id: string | null;
	is_byok: null;
	latency: number | null;
	model: string | null;
	moderation_latency: null;
	native_finish_reason: null;
	native_tokens_cached: null;
	native_tokens_completion: null;
	native_tokens_completion_images: null;
	native_tokens_prompt: null;
	native_tokens_reasoning: null;
	num_fetches: null;
	num_input_audio_prompt: null;
	num_media_completion: null;
	num_media_prompt: null;
	num_search_results: null;
	origin: null;
	preset_id: null;
	provider_name: string | null;
	provider_responses: null;
	request_id: null;
	router: null;
	service_tier: null;
	session_id: null;
	streamed: null;
	tokens_completion: number | null;
	tokens_prompt: number | null;
	/** Null because `charged_cost` does not snapshot its USD/CNY currency. */
	total_cost: null;
	/** Stored application-level upstream generation identifier, when valid. */
	upstream_id: string | null;
	upstream_inference_cost: null;
	/** Null for the same currency-proof reason as `total_cost`. */
	usage: null;
	user_agent: null;
	web_search_engine: null;
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

function generationApiType(operation: string | null | undefined): GenerationApiType | null {
	switch (operation) {
		case 'chat':
		case 'responses':
		case 'messages':
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

/** Map only non-sensitive RequestLog columns with equivalent public semantics. */
export function toGenerationMetadataData(row: GenerationRequestLogRow): GenerationMetadataData {
	return {
		api_type: generationApiType(row.request_operation),
		app_id: null,
		cache_discount: null,
		cancelled: cancelledFromStatus(row.status),
		created_at: publicCreatedAt(row.created_at),
		data_region: null,
		external_user: null,
		finish_reason: null,
		generation_time: null,
		http_referer: null,
		id: GENERATION_ID_PATTERN.test(row.id) ? row.id : null,
		is_byok: null,
		latency: nonNegativeFiniteNumber(row.latency_ms),
		model: publicLogString(row.model_id, 200),
		moderation_latency: null,
		native_finish_reason: null,
		native_tokens_cached: null,
		native_tokens_completion: null,
		native_tokens_completion_images: null,
		native_tokens_prompt: null,
		native_tokens_reasoning: null,
		num_fetches: null,
		num_input_audio_prompt: null,
		num_media_completion: null,
		num_media_prompt: null,
		num_search_results: null,
		origin: null,
		preset_id: null,
		provider_name: publicLogString(row.provider_name, 200),
		provider_responses: null,
		request_id: null,
		router: null,
		service_tier: null,
		session_id: null,
		streamed: null,
		tokens_completion: nonNegativeSafeInteger(row.output_tokens),
		tokens_prompt: nonNegativeSafeInteger(row.input_tokens),
		total_cost: null,
		upstream_id: publicUpstreamId(row.upstream_message_id),
		upstream_inference_cost: null,
		usage: null,
		user_agent: null,
		web_search_engine: null,
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
		return c.json({ data: toGenerationMetadataData(row) });
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
