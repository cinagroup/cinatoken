import {
	parseGenerationProviderResponses,
	type GenerationProviderResponseSnapshot,
	type GenerationRequestLogRow,
} from "./db/request-logs-types";

type GenerationApiType = "completions" | "embeddings" | "rerank" | "tts" | "stt" | "video" | "image";

/** OpenRouter SDK-compatible, credential-free Generation metadata. */
export type GenerationMetadataData = {
	api_type: GenerationApiType | null;
	app_id: null;
	cache_discount: null;
	cancelled: boolean | null;
	created_at: string;
	data_region: "global" | "europe" | "us";
	external_user: null;
	finish_reason: "tool_calls" | "stop" | "length" | "content_filter" | "error" | null;
	generation_time: number | null;
	http_referer: string | null;
	id: string;
	is_byok: boolean;
	latency: number | null;
	model: string;
	moderation_latency: null;
	native_finish_reason: string | null;
	native_tokens_cached: number | null;
	native_tokens_completion: number | null;
	native_tokens_completion_images: number | null;
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
	provider_responses: GenerationProviderResponseSnapshot[] | null;
	request_id: null;
	router: null;
	service_tier: "default" | "flex" | "priority" | null;
	session_id: string | null;
	streamed: boolean | null;
	tokens_completion: number | null;
	tokens_prompt: number | null;
	total_cost: number;
	/** Stored application-level upstream generation identifier, when valid. */
	upstream_id: string | null;
	upstream_inference_cost: number | null;
	usage: number;
	user_agent: string | null;
	web_search_engine: null;
	workspace_id: string | null;
};

/** Portal variant: non-USD deployments cannot truthfully populate OpenRouter's USD cost fields. */
export type PortalGenerationMetadataData = Omit<GenerationMetadataData, "total_cost" | "usage"> & {
	total_cost: number | null;
	usage: number | null;
};

export const GENERATION_ID_PATTERN = /^gen-[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_UPSTREAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function nonNegativeSafeInteger(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? value : null;
	}
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function nonNegativeDecimal(value: unknown): number | null {
	if (typeof value === "number") return nonNegativeFiniteNumber(value);
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
	return nonNegativeFiniteNumber(Number(value));
}

function storedBoolean(value: unknown): boolean | null {
	if (value === true || value === 1) return true;
	if (value === false || value === 0) return false;
	return null;
}

function generationApiType(operation: string | null | undefined): GenerationApiType | null {
	switch (operation) {
		case "chat":
		case "completions":
		case "responses":
		case "messages":
		case "models.generate":
		case "generateContent":
		case "streamGenerateContent":
			return "completions";
		case "embeddings":
			return "embeddings";
		case "rerank":
			return "rerank";
		case "audio.speech":
			return "tts";
		case "audio.transcriptions":
		case "audio.transcriptions.multimodal":
			return "stt";
		case "video":
			return "video";
		case "images.generations":
		case "images.edits":
			return "image";
		default:
			return null;
	}
}

function cancelledFromStatus(status: string): boolean | null {
	if (status === "cancelled") return true;
	if (status === "success" || status === "error" || status === "incomplete") return false;
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
			(url.protocol !== "https:" && url.protocol !== "http:")
			|| url.username !== ""
			|| url.password !== ""
			|| url.origin !== safe
			|| url.pathname !== "/"
			|| url.search !== ""
			|| url.hash !== ""
		) return null;
		return safe;
	} catch {
		return null;
	}
}

function publicDataRegion(value: string | null): GenerationMetadataData["data_region"] | null {
	return value === "global" || value === "europe" || value === "us" ? value : null;
}

function publicServiceTier(value: string | null): GenerationMetadataData["service_tier"] {
	return value === "default" || value === "flex" || value === "priority" ? value : null;
}

function publicFinishReason(value: string | null): GenerationMetadataData["finish_reason"] {
	return value === "tool_calls"
		|| value === "stop"
		|| value === "length"
		|| value === "content_filter"
		|| value === "error"
		? value
		: null;
}

function publicNativeFinishReason(value: string | null): string | null {
	return publicLogString(value, 128);
}

function publicSessionId(value: string | null): string | null {
	return value != null && value !== "" && Array.from(value).length <= 256 ? value : null;
}

function publicGenerationTime(row: GenerationRequestLogRow): number | null {
	const headers = nonNegativeSafeInteger(row.final_upstream_headers_ms);
	const stream = nonNegativeSafeInteger(row.stream_duration_ms);
	if (headers == null || stream == null) return null;
	const total = headers + stream;
	return Number.isSafeInteger(total) ? total : null;
}

/**
 * Map the shared credential-free snapshot for portal display. Mandatory identity,
 * origin, region, and BYOK facts still fail closed; USD-only costs may be absent.
 */
export function toPortalGenerationMetadataData(row: GenerationRequestLogRow): PortalGenerationMetadataData | null {
	const id = GENERATION_ID_PATTERN.test(row.id) ? row.id : null;
	const createdAt = publicCreatedAt(row.created_at);
	const model = publicLogString(row.model_id, 200);
	const origin = publicOrigin(row.request_origin);
	const dataRegion = publicDataRegion(row.data_region);
	const isByok = storedBoolean(row.is_byok);
	const totalCost = nonNegativeDecimal(row.charged_cost_usd);
	const nativePromptTokens = nonNegativeSafeInteger(row.native_tokens_prompt);
	const nativeCompletionTokens = nonNegativeSafeInteger(row.native_tokens_completion);
	if (
		id == null
		|| createdAt == null
		|| model == null
		|| origin == null
		|| dataRegion == null
		|| isByok == null
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
		finish_reason: publicFinishReason(row.finish_reason),
		generation_time: publicGenerationTime(row),
		http_referer: publicOrigin(row.http_referer),
		id,
		is_byok: isByok,
		latency: nonNegativeFiniteNumber(row.latency_ms),
		model,
		moderation_latency: null,
		native_finish_reason: publicNativeFinishReason(row.native_finish_reason),
		native_tokens_cached: nonNegativeSafeInteger(row.native_tokens_cached),
		native_tokens_completion: nativeCompletionTokens,
		native_tokens_completion_images: nonNegativeSafeInteger(row.native_tokens_completion_images),
		native_tokens_prompt: nativePromptTokens,
		native_tokens_reasoning: nonNegativeSafeInteger(row.native_tokens_reasoning),
		num_fetches: null,
		num_input_audio_prompt: null,
		num_media_completion: apiType === "image"
			? nonNegativeSafeInteger(row.output_image_count)
			: null,
		num_media_prompt: apiType === "image"
			? nonNegativeSafeInteger(row.input_image_count)
			: null,
		num_search_results: null,
		origin,
		preset_id: null,
		provider_name: publicLogString(row.provider_name, 200),
		provider_responses: parseGenerationProviderResponses(row.provider_responses),
		request_id: null,
		router: null,
		service_tier: publicServiceTier(row.service_tier),
		session_id: publicSessionId(row.session_id),
		streamed: storedBoolean(row.response_streamed),
		tokens_completion: nativeCompletionTokens == null
			? null
			: nonNegativeSafeInteger(row.output_tokens),
		tokens_prompt: nativePromptTokens == null
			? null
			: nonNegativeSafeInteger(row.input_tokens),
		total_cost: totalCost,
		upstream_id: publicUpstreamId(row.upstream_message_id),
		upstream_inference_cost: nonNegativeDecimal(row.upstream_inference_cost_usd),
		usage: totalCost,
		user_agent: publicLogString(row.user_agent, 512),
		web_search_engine: null,
		workspace_id: publicLogString(row.workspace_id, 600),
	};
}

/** Map the strict OpenRouter SDK contract; incomplete legacy or non-USD snapshots stay unavailable. */
export function toGenerationMetadataData(row: GenerationRequestLogRow): GenerationMetadataData | null {
	const data = toPortalGenerationMetadataData(row);
	if (!data || data.total_cost == null) return null;
	return { ...data, total_cost: data.total_cost, usage: data.total_cost };
}
